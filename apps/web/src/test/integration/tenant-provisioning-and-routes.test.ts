import { randomUUID } from "node:crypto";

import type { Db, Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as tenantGet, PATCH as tenantPatch } from "@/app/api/v1/tenants/[tenantId]/route";
import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient, getDb } from "@/server/db/mongo";
import { ensureTenantForUser, type TenantProvisioningResult } from "@/server/tenancy/provisioning";

import { authPost, body, cookiePair, sessionCookie } from "../helpers/auth-requests";
import { MONGO_READY_HOOK_TIMEOUT_MS, requireMongoTestUri, waitForMongoReady } from "../helpers/db";
import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration / contract — tenant provisioning, `tenantId` resolution and
 * tenant read/update (OP-100, contract §0.4 + §2.1, schema §10.2 + §13.3/§13.4).
 *
 * The user story: *a workspace is created on the organizer's first organizer
 * action and is reachable by id or the alias `current`, so cost attributes to
 * the tenant automatically.*
 *
 *   I1  two concurrent `ensureTenantForUser` calls for one user → exactly one
 *       tenant, one `owner` membership, and one `primaryTenantId`;
 *   I2  `GET /tenants/current` resolves the alias and echoes the resolved id in
 *       `X-Tenant-Id` (equal to `primaryTenantId`);
 *   I3  a caller who is not a member of the path tenant → `404 not_found`
 *       (also for an unknown and a malformed id — never `403`, so the endpoint
 *       is not a cross-tenant existence oracle);
 *   I4  a pure attendee (no membership) reading the `current` alias → `404`;
 *   I5  a `member` who is a member of the tenant → `403 forbidden` on `PATCH`;
 *   I6  `billingContactUserId` naming a non-member → `422 invalid_billing_contact`;
 *   I7  the first tenant-scoped **write** by a user with no workspace provisions
 *       one (with the caller as owner) — the seam the E1 e2e pins end to end.
 *
 * ## Contract expected of the implementation
 *
 * - `@/server/tenancy/provisioning` exports
 *   `ensureTenantForUser(userId: ObjectId, options?: { db?: Db; clock?: Clock }):
 *   Promise<TenantProvisioningResult>` where
 *   `TenantProvisioningResult = { tenantId: ObjectId; slug: string }`. It is
 *   idempotent (a second call returns the existing tenant) and race-safe (a
 *   concurrent pair collapses to one).
 * - `@/app/api/v1/tenants/[tenantId]/route` exports `GET` and `PATCH`, declared
 *   with `defineRoute({ route: "/api/v1/tenants/:tenantId", … })` and a `tenant`
 *   stage that (a) resolves the literal `current` to
 *   `userProfiles.primaryTenantId` **before** any tenant query, (b) echoes the
 *   resolved id in `X-Tenant-Id`, and (c) verifies an active `tenantMembers`
 *   row, denying with `404 not_found` (never `403`). Because the shared pipeline
 *   exposes only `(request)`, the handler and the stage read the `{tenantId}`
 *   path segment off `ctx.request.url`, exactly like
 *   `me/sessions/[sessionId]/route.ts`.
 * - `PATCH` applies exactly the §2.1 fields, gated by
 *   `@/server/tenancy/permissions` (owner|admin, `billingContactUserId` owner
 *   only), and re-serializes the same §2.1 tenant DTO that `GET` returns.
 *
 * ## Assumptions (see the handoff / ADR-0260)
 *
 * - **A1 — the triggers that provision.** `GET` never provisions (I4). The
 *   *first tenant-scoped write* by a caller with no workspace provisions one and
 *   makes the caller its `owner` (I7 / E1). The card names no organizer-action
 *   endpoint and contract §2.1 forbids `POST /api/v1/tenants` in v1, so the
 *   lane's own tenant-scoped write is the only in-scope trigger. This is the
 *   single decision the reviewer should confirm.
 * - **A2 — error codes.** `invalid_billing_contact` is named only in prose by
 *   contract §2.1 and does not exist in `@openpic/contracts` today; the
 *   implementation appends it (`422`, non-retryable) to the request-shape
 *   transport. `forbidden`/`not_found` already exist.
 * - **A3 — the DTO.** §2.1 mandates `counters.approximate: true`; branding URLs
 *   are `null` until the OP-117 signer exists (GREEN scope §3), so they are
 *   asserted `null` rather than mocked.
 * - **A4 — suspension** (`tenant_suspended` → `423` on writes) is named only in
 *   the GREEN card's scope, has no code in the contract catalogue and is not
 *   pinned here; it is out of scope for this RED (see the handoff).
 */

const APP_ORIGIN = "http://localhost:3000";
const TENANTS_PATH = "/api/v1/tenants";

/** The literal alias the tenant stage must resolve (contract §0.4). */
const CURRENT_ALIAS = "current";

/** Collection names this spec reads/writes (schema §13). */
const USER_COLLECTION = "user";
const USER_PROFILES_COLLECTION = "userProfiles";
const TENANTS_COLLECTION = "tenants";
const TENANT_MEMBERS_COLLECTION = "tenantMembers";

/**
 * A private database shared by this spec's auth instance and the route's
 * process singletons, uniquely named per run so stale state cannot leak in.
 */
const DB_NAME = `openpic_op100_tenancy_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

let database: Db;
let auth: AuthLike;

/** Point a MongoDB URI at `dbName`, preserving options. */
function uriWithDb(uri: string, dbName: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

type OtpChannel = "email" | "sms";
interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

interface Identity {
  readonly email: string;
  readonly phone: string;
  readonly ip: string;
}

let identitySeq = 0;

/** A unique email/phone/IP so no two specs share a rate-limit bucket. */
function makeIdentity(): Identity {
  identitySeq += 1;
  const serial = String(identitySeq).padStart(4, "0");
  return {
    email: `op100-tenancy-${serial}@example.com`,
    phone: `+919****1000${serial}`,
    ip: `198.51.100.${String(identitySeq)}`,
  };
}

beforeAll(async () => {
  const uri = requireMongoTestUri();

  // Rebuild the singleton client from this file's configuration: a previous
  // file in the same worker may have left a client bound to the shared URI.
  await closeMongoClient();
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: uriWithDb(uri, DB_NAME),
        RATE_LIMIT_PROVIDER: "memory",
        MESSAGE_TRANSPORT: "memory",
      })
    )
  );

  // Built inside the hook so they read this file's configuration, not an
  // earlier file's environment.
  database = getDb();
  auth = createAuth({ db: database });

  // Cold connect / replica-set discovery / primary election belong in this
  // hook, never inside a timed spec.
  await waitForMongoReady();

  expect(database.databaseName).toBe(DB_NAME);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await getDb().dropDatabase();
  await closeMongoClient();
});

/** The captured OTP, failing loudly when the transport recorded none. */
function requireOtp(channel: OtpChannel, to: string): CapturedOtp {
  const otp = otpInbox.take(channel, to) as CapturedOtp | undefined;
  if (otp === undefined) {
    throw new Error(`expected an OTP captured for ${channel}:${to}, got none`);
  }
  return otp;
}

function forward(identity: Identity): Record<string, string> {
  return { "x-forwarded-for": identity.ip };
}

/** Sign in with a valid email OTP and return the session cookie pair. */
async function signIn(identity: Identity): Promise<string> {
  const sent = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/email-otp/send-verification-otp",
    { email: identity.email, type: "sign-in" },
    forward(identity)
  );
  expect(sent.status).toBe(200);
  const otp = requireOtp("email", identity.email);

  const response = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/sign-in/email-otp",
    { email: identity.email, otp: otp.code },
    forward(identity)
  );
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  if (cookie === undefined) {
    throw new Error("sign-in did not set a session cookie");
  }
  return cookiePair(cookie);
}

/** Read the raw Better Auth user document for an identity. */
async function findUser(identity: Identity): Promise<WithId<Document>> {
  const user = await database.collection(USER_COLLECTION).findOne({ email: identity.email });
  if (user === null) {
    throw new Error(`no user document for ${identity.email}`);
  }
  return user;
}

/** Sign in and return the session cookie plus the Better Auth user id. */
async function signInAs(identity: Identity): Promise<{ cookie: string; userId: ObjectId }> {
  const cookie = await signIn(identity);
  const user = await findUser(identity);
  return { cookie, userId: user._id };
}

/** Merge fields into the caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await database
    .collection(USER_PROFILES_COLLECTION)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Read the caller's `userProfiles` document. */
async function findProfile(userId: ObjectId): Promise<Document | null> {
  return database.collection(USER_PROFILES_COLLECTION).findOne({ userId });
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: {
  slug: string;
  name: string;
  status?: "active" | "suspended" | "closed";
  ownerUserId?: ObjectId;
  billingContactUserId?: ObjectId;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await database.collection(TENANTS_COLLECTION).insertOne({
    _id,
    slug: fields.slug,
    name: fields.name,
    status: fields.status ?? "active",
    ownerUserId: fields.ownerUserId ?? null,
    billingContactUserId: fields.billingContactUserId ?? fields.ownerUserId ?? null,
    dataRegion: "in",
    // `approximate` is deliberately absent: contract §2.1 makes the DTO — not
    // the stored document — responsible for advertising the counter as cached.
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  return _id;
}

/** Insert a membership row (schema §13.4). */
async function insertTenantMember(fields: {
  tenantId: ObjectId;
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  status?: "active" | "removed";
}): Promise<void> {
  await database.collection(TENANT_MEMBERS_COLLECTION).insertOne({
    ...fields,
    status: fields.status ?? "active",
    joinedAt: new Date(),
  });
}

/** Seed a tenant with a single membership and make it the caller's primary. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug?: string;
  name?: string;
  status?: "active" | "suspended" | "closed";
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug ?? "op100-studio",
    name: options.name ?? "OP100 Studio",
    ...(options.status === undefined ? {} : { status: options.status }),
    ownerUserId: options.role === "owner" ? options.userId : new ObjectId(),
  });
  await insertTenantMember({ tenantId, userId: options.userId, role: options.role });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** A GET /tenants/{tenantId} request carrying the session cookie. */
function getTenantRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** A PATCH /tenants/{tenantId} request carrying the session cookie and a body. */
function patchTenantRequest(cookie: string, tenantId: string, payload: unknown): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}`, APP_ORIGIN), {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** The error envelope of a failed response. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** Parse and return the JSON error envelope. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/** Count the tenants owned by a user. */
async function countOwnedTenants(userId: ObjectId): Promise<number> {
  return database.collection(TENANTS_COLLECTION).countDocuments({ ownerUserId: userId });
}

/** The `owner` membership rows for a tenant. */
async function ownerMemberships(tenantId: ObjectId): Promise<Document[]> {
  return database
    .collection(TENANT_MEMBERS_COLLECTION)
    .find({ tenantId, role: "owner", status: "active" })
    .toArray();
}

/** A created slug must satisfy the same shape the unit spec pins. */
const SLUG_PATTERN = /^[a-z0-9]{8}$/;

describe("ensureTenantForUser (OP-100 provisioning)", () => {
  it("I1: two concurrent calls create one tenant and one owner membership", async () => {
    const identity = makeIdentity();
    const { userId } = await signInAs(identity);

    const [first, second]: [TenantProvisioningResult, TenantProvisioningResult] = await Promise.all(
      [ensureTenantForUser(userId, { db: database }), ensureTenantForUser(userId, { db: database })]
    );

    // Both callers observe the same workspace; neither created a second one.
    expect(first.tenantId.toHexString()).toBe(second.tenantId.toHexString());
    expect(await countOwnedTenants(userId)).toBe(1);

    const tenant = await database.collection(TENANTS_COLLECTION).findOne({ _id: first.tenantId });
    expect(tenant).not.toBeNull();
    expect(tenant?.slug).toMatch(SLUG_PATTERN);
    expect(tenant?.status).toBe("active");
    expect(tenant?.billingContactUserId?.toHexString()).toBe(userId.toHexString());

    const memberships = await database
      .collection(TENANT_MEMBERS_COLLECTION)
      .find({ tenantId: first.tenantId, userId, status: "active" })
      .toArray();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");

    const profile = await findProfile(userId);
    expect(profile?.primaryTenantId?.toHexString()).toBe(first.tenantId.toHexString());
  });

  it("I1: a repeated call reuses the existing workspace instead of creating a second", async () => {
    const identity = makeIdentity();
    const { userId } = await signInAs(identity);

    const first = await ensureTenantForUser(userId, { db: database });
    const second = await ensureTenantForUser(userId, { db: database });

    expect(second.tenantId.toHexString()).toBe(first.tenantId.toHexString());
    expect(await countOwnedTenants(userId)).toBe(1);
    expect(await ownerMemberships(first.tenantId)).toHaveLength(1);
  });
});

describe("GET /api/v1/tenants/{tenantId} (OP-100 read)", () => {
  it("I2: resolves the `current` alias and echoes primaryTenantId in X-Tenant-Id", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({
      userId,
      role: "owner",
      slug: "rahul-studio",
      name: "Rahul Studio",
    });

    const response = await tenantGet(getTenantRequest(cookie, CURRENT_ALIAS));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const tenant = await body(response);
    expect(tenant.id).toBe(tenantId.toHexString());
    expect(tenant.slug).toBe("rahul-studio");
    expect(tenant.name).toBe("Rahul Studio");
    expect(tenant.status).toBe("active");
    expect(tenant.ownerUserId).toBe(userId.toHexString());
    expect(tenant.billingContactUserId).toBe(userId.toHexString());
    expect(tenant.dataRegion).toBe("in");
    expect(tenant.myRole).toBe("owner");
    expect(typeof tenant.createdAt).toBe("string");
    // §2.1: the counter is a cached, nightly-reconciled value and must say so.
    expect((tenant.counters as Record<string, unknown>).approximate).toBe(true);
    // Branding URLs stay null until the OP-117 signer exists (GREEN scope §3).
    const settings = tenant.settings as Record<string, unknown>;
    expect(settings.defaultTimeZone).toBe("Asia/Kolkata");
    expect(settings.brandLogoUrl).toBeNull();
    expect(settings.defaultWatermarkUrl).toBeNull();
  });

  it("I3: answers 404 for a tenant the caller is not a member of", async () => {
    const identity = makeIdentity();
    const { cookie } = await signInAs(identity);

    const strangerTenant = await insertTenant({ slug: "not-mine", name: "Not Mine" });

    const response = await tenantGet(getTenantRequest(cookie, strangerTenant.toHexString()));
    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("I3: answers 404 for an unknown tenant id (never 403)", async () => {
    const identity = makeIdentity();
    const { cookie } = await signInAs(identity);

    const response = await tenantGet(getTenantRequest(cookie, new ObjectId().toHexString()));
    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("I3: answers 404 for a malformed tenant id", async () => {
    const identity = makeIdentity();
    const { cookie } = await signInAs(identity);

    const response = await tenantGet(getTenantRequest(cookie, "not-an-object-id"));
    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("I4: answers 404 for a pure attendee reading the `current` alias", async () => {
    // No `tenantMembers` row and `primaryTenantId: null` — the §1.2 "pure
    // attendee" shape. Reading must not provision a workspace.
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    await updateProfile(userId, { primaryTenantId: null });

    const response = await tenantGet(getTenantRequest(cookie, CURRENT_ALIAS));
    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
    expect(await countOwnedTenants(userId)).toBe(0);
  });
});

describe("PATCH /api/v1/tenants/{tenantId} (OP-100 update)", () => {
  it("I2: lets an owner rename the workspace and returns the updated DTO", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "owner" });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, {
        name: "Renamed Studio",
        settings: { defaultTimeZone: "America/New_York" },
      })
    );

    expect(response.status).toBe(200);
    const tenant = await body(response);
    expect(tenant.id).toBe(tenantId.toHexString());
    expect(tenant.name).toBe("Renamed Studio");
    expect((tenant.settings as Record<string, unknown>).defaultTimeZone).toBe("America/New_York");

    // Persisted, not merely echoed.
    const stored = await database.collection(TENANTS_COLLECTION).findOne({ _id: tenantId });
    expect(stored?.name).toBe("Renamed Studio");
    expect((stored?.settings as Record<string, unknown>).defaultTimeZone).toBe("America/New_York");
  });

  it("I5: forbids a `member` from renaming the workspace", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "member", slug: "team", name: "Team" });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, { name: "Hijacked" })
    );

    expect(response.status).toBe(403);
    expect((await errorEnvelope(response)).code).toBe("forbidden");

    const stored = await database.collection(TENANTS_COLLECTION).findOne({ _id: tenantId });
    expect(stored?.name).toBe("Team");
  });

  it("I5: lets an `admin` rename the workspace", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "admin" });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, { name: "Admin Rename" })
    );

    expect(response.status).toBe(200);
    expect((await body(response)).name).toBe("Admin Rename");
    const stored = await database.collection(TENANTS_COLLECTION).findOne({ _id: tenantId });
    expect(stored?.name).toBe("Admin Rename");
  });

  it("I5: forbids an `admin` from setting the billing contact (owner only)", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "admin" });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, { billingContactUserId: userId.toHexString() })
    );

    expect(response.status).toBe(403);
    expect((await errorEnvelope(response)).code).toBe("forbidden");
    const stored = await database.collection(TENANTS_COLLECTION).findOne({ _id: tenantId });
    expect(stored?.billingContactUserId?.toHexString()).not.toBe(userId.toHexString());
  });

  it("I6: rejects a billing contact who is not an active member with 422 invalid_billing_contact", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    await seedWorkspace({ userId, role: "owner" });

    const strangerId = new ObjectId();
    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, { billingContactUserId: strangerId.toHexString() })
    );

    expect(response.status).toBe(422);
    expect((await errorEnvelope(response)).code).toBe("invalid_billing_contact");
  });

  it("I6: rejects a removed member as the billing contact with 422", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "owner" });

    const removedUserId = new ObjectId();
    await insertTenantMember({
      tenantId,
      userId: removedUserId,
      role: "member",
      status: "removed",
    });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, {
        billingContactUserId: removedUserId.toHexString(),
      })
    );

    expect(response.status).toBe(422);
    expect((await errorEnvelope(response)).code).toBe("invalid_billing_contact");
  });

  it("I6: accepts an active member as the billing contact", async () => {
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    const tenantId = await seedWorkspace({ userId, role: "owner" });

    const memberUserId = new ObjectId();
    await insertTenantMember({ tenantId, userId: memberUserId, role: "member", status: "active" });

    const response = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, {
        billingContactUserId: memberUserId.toHexString(),
      })
    );

    expect(response.status).toBe(200);
    expect((await body(response)).billingContactUserId).toBe(memberUserId.toHexString());
    const stored = await database.collection(TENANTS_COLLECTION).findOne({ _id: tenantId });
    expect(stored?.billingContactUserId?.toHexString()).toBe(memberUserId.toHexString());
  });

  it("I7: the first tenant-scoped write by a user with no workspace provisions one", async () => {
    // The E1 seam at the cheap level: a caller with no `tenantMembers` row and a
    // null `primaryTenantId` writes to the `current` alias; the write must
    // provision the workspace (caller = owner) and then succeed, so the alias
    // resolves afterwards.
    const identity = makeIdentity();
    const { cookie, userId } = await signInAs(identity);
    await updateProfile(userId, { primaryTenantId: null });

    // A read first — it must NOT have provisioned anything (I4).
    const before = await tenantGet(getTenantRequest(cookie, CURRENT_ALIAS));
    expect(before.status).toBe(404);
    expect(await countOwnedTenants(userId)).toBe(0);

    const written = await tenantPatch(
      patchTenantRequest(cookie, CURRENT_ALIAS, { name: "First Studio" })
    );
    expect(written.status).toBe(200);
    expect((await body(written)).name).toBe("First Studio");

    expect(await countOwnedTenants(userId)).toBe(1);
    const profile = await findProfile(userId);
    expect(profile?.primaryTenantId).toBeInstanceOf(ObjectId);
    expect(await ownerMemberships(profile?.primaryTenantId as ObjectId)).toHaveLength(1);

    const after = await tenantGet(getTenantRequest(cookie, CURRENT_ALIAS));
    expect(after.status).toBe(200);
    expect(after.headers.get("x-tenant-id")).toBe(
      (profile?.primaryTenantId as ObjectId).toHexString()
    );
  });
});
