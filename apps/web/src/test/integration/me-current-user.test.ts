import { randomUUID } from "node:crypto";

import type { Db, Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as meGet, PATCH as mePatch } from "@/app/api/v1/me/route";
import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient, getDb } from "@/server/db/mongo";
import { buildMe } from "@/server/me/projection";
import { meSchema } from "@/server/me/schema";

import { authPost, body, cookiePair, sessionCookie } from "../helpers/auth-requests";
import { MONGO_READY_HOOK_TIMEOUT_MS, requireMongoTestUri, waitForMongoReady } from "../helpers/db";
import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration / contract — `GET` and `PATCH /api/v1/me` (OP-90, contract §1.2).
 *
 * OP-89 (ADR-0041) landed only the profile-default read slice. This spec
 * completes the §1.2 projection and pins `PATCH /me` on top of it:
 *
 *   I1  the full body, with `tenants[]` derived from active memberships only;
 *   I2  `unreadNotificationCount` counts only the caller's unread rows;
 *   I3  `PATCH { timeZone: "Mars/Olympus" }` → `422 unknown_timezone`;
 *   I4  `PATCH { email }` → `422 forbidden_field` (email/phone live in Better Auth);
 *   I5  an `avatarAssetId` owned by another tenant → `422`;
 *   I6  `PATCH { platformRole }` → `422 forbidden_field`.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/me/route` exports both `GET` and `PATCH`, guarded with the
 * `user` label; both return the full §1.2 body, PATCH (200) after applying the
 * change. Stored collections (schema §13, camelCase like `userProfiles`):
 * `user` (Better Auth, §13.1), `userProfiles` (§13.2), `tenants` (§13.3),
 * `tenantMembers` (§13.4), `notifications` (§19.4), `invitations` (§13.6),
 * `mediaAssets` (§16.1).
 *
 * The `user` document is the source for `id`, `email`, `emailVerified`,
 * `phoneNumber`, `phoneNumberVerified`, `twoFactorEnabled`; `userProfiles`
 * (which names this card completes) is the source for `displayName`,
 * `avatarUrl` (via `avatarAssetId`), `locale`, `timeZone`, `platformRole`,
 * `status`, `marketingOptIn`, `contactCapabilities`, `accountCompletedAt`,
 * `deletionScheduledAt`. `primaryTenant`/`tenants` come from `tenantMembers`
 * (`status == "active"`) joined to `tenants`; `capabilities` is the advisory
 * projection; `unreadNotificationCount`/`pendingInvitationCount` are counts
 * scoped to the caller.
 *
 * ## Deliberate non-assertions (see the handoff / ADR-0044)
 *
 * - `phoneNumber` is asserted against the *stored* value (null for an
 *   email-OTP account). Whether a present number is returned raw (E.164) or
 *   masked (`+91•••••3210`) is an open contract question (§0.13 vs the §1.2
 *   example) and is deliberately not pinned here.
 * - `avatarUrl` is asserted `null` when no avatar is set. Signed-URL
 *   generation for an attached asset needs media-signing infrastructure that
 *   does not exist yet and is out of scope.
 * - I5 pins the `422` and that `avatarAssetId` is the offending field. The
 *   precise code for "referenced asset is not yours" is not named in the card;
 *   `validation_failed` is assumed (it is an invalid *value*, not a forbidden
 *   field), and is flagged as an assumption.
 */

const APP_ORIGIN = "http://localhost:3000";
const ME_PATH = "/api/v1/me";

/** A completed-at instant deliberately never the "now" of a spec. */
const COMPLETED_AT = new Date("2026-01-01T00:00:00.000Z");

/** Collection names the §1.2 projection reads (schema §13, §19.4). */
const USER_COLLECTION = "user";
const USER_PROFILES_COLLECTION = "userProfiles";
const TENANTS_COLLECTION = "tenants";
const TENANT_MEMBERS_COLLECTION = "tenantMembers";
const NOTIFICATIONS_COLLECTION = "notifications";
const INVITATIONS_COLLECTION = "invitations";
const MEDIA_ASSETS_COLLECTION = "mediaAssets";

/**
 * A private database shared by this spec's auth instance and the route's
 * process singletons, uniquely named per run so stale state cannot leak in.
 */
const DB_NAME = `openpic_me_current_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

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
    email: `op90-me-${serial}@example.com`,
    phone: `+919****0000${serial}`,
    ip: `203.0.113.${String(identitySeq)}`,
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

  // The singletons must be bound to this spec's private database, or the route
  // would read a database no session was written to.
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

/** Sign in with a valid email OTP; returns the session cookie pair. */
async function signInWithEmailOtp(identity: Identity): Promise<string> {
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

/** Merge fields into the caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await database
    .collection(USER_PROFILES_COLLECTION)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant and return its id. */
async function insertTenant(fields: {
  slug: string;
  name: string;
  status: "active" | "suspended" | "closed";
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await database.collection(TENANTS_COLLECTION).insertOne({ _id, ...fields, schemaVersion: 1 });
  return _id;
}

/** Insert a membership row (schema §13.4). */
async function insertTenantMember(fields: {
  tenantId: ObjectId;
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  status: "active" | "removed";
}): Promise<void> {
  await database
    .collection(TENANT_MEMBERS_COLLECTION)
    .insertOne({ ...fields, joinedAt: new Date() });
}

/** Insert a notification row; `readAt` null means unread (schema §19.4). */
async function insertNotification(fields: {
  userId: ObjectId;
  readAt: Date | null;
}): Promise<void> {
  await database.collection(NOTIFICATIONS_COLLECTION).insertOne({
    ...fields,
    typeKey: "test.notification",
    title: "Test",
    body: "Test",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Insert an invitation addressed to a user (schema §13.6). */
async function insertInvitation(fields: { userId: ObjectId; status: string }): Promise<void> {
  await database
    .collection(INVITATIONS_COLLECTION)
    .insertOne({ invitee: { kind: "user", userId: fields.userId }, status: fields.status });
}

/** Insert a stored media asset owned by a tenant (schema §16.1). */
async function insertMediaAsset(fields: { tenantId: ObjectId; kind: string }): Promise<ObjectId> {
  const _id = new ObjectId();
  await database.collection(MEDIA_ASSETS_COLLECTION).insertOne({
    _id,
    ...fields,
    status: "derivatives_ready",
    contentHash: "a".repeat(64),
  });
  return _id;
}

/** A GET /me request carrying the session cookie. */
function getMeRequest(cookie: string): Request {
  return new Request(new URL(ME_PATH, APP_ORIGIN), { method: "GET", headers: { cookie } });
}

/** A PATCH /me request carrying the session cookie and a JSON body. */
function patchMeRequest(cookie: string, payload: unknown): Request {
  return new Request(new URL(ME_PATH, APP_ORIGIN), {
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

describe("GET /api/v1/me (§1.2 current user)", () => {
  it("I1: returns the full body with only the caller's active tenant memberships", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    const activeTenant = await insertTenant({
      slug: "rahul-studio",
      name: "Rahul Studio",
      status: "active",
    });
    const removedTenant = await insertTenant({
      slug: "old-studio",
      name: "Old Studio",
      status: "active",
    });
    await insertTenantMember({
      tenantId: activeTenant,
      userId: user._id,
      role: "owner",
      status: "active",
    });
    await insertTenantMember({
      tenantId: removedTenant,
      userId: user._id,
      role: "member",
      status: "removed",
    });
    await updateProfile(user._id, {
      displayName: "Rahul Menon",
      locale: "en-IN",
      timeZone: "Asia/Kolkata",
      platformRole: "client",
      status: "active",
      marketingOptIn: true,
      accountCompletedAt: COMPLETED_AT,
      deletionScheduledAt: null,
      primaryTenantId: activeTenant,
      contactCapabilities: {
        whatsappCapable: null,
        whatsappCheckedAt: null,
        pushTokens: [
          { tokenHash: "x", platform: "android", deviceId: "d", lastSeenAt: new Date() },
        ],
      },
    });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);

    // Identity fields come from the Better Auth `user` document, asserted
    // against what is actually stored (never hard-coded defaults).
    expect(me.id).toBe(user._id.toHexString());
    expect(me.email).toBe(identity.email);
    expect(me.emailVerified).toBe(user.emailVerified === true);
    expect(me.phoneNumber).toBe(user.phoneNumber ?? null);
    expect(me.phoneNumberVerified).toBe(user.phoneNumberVerified === true);
    expect(me.twoFactorEnabled).toBe(user.twoFactorEnabled === true);

    // Profile fields come from `userProfiles`.
    expect(me.accountCompletedAt).toBe(COMPLETED_AT.toISOString());
    expect(me.displayName).toBe("Rahul Menon");
    expect(me.avatarUrl).toBeNull();
    expect(me.locale).toBe("en-IN");
    expect(me.timeZone).toBe("Asia/Kolkata");
    expect(me.platformRole).toBe("client");
    expect(me.status).toBe("active");
    expect(me.marketingOptIn).toBe(true);
    // `pushTokens` are hashed secrets and never returned (§0.15).
    expect(me.contactCapabilities).toEqual({ whatsappCapable: null, whatsappCheckedAt: null });

    // Active memberships only — the removed row must not appear anywhere.
    const tenant = {
      id: activeTenant.toHexString(),
      slug: "rahul-studio",
      name: "Rahul Studio",
      role: "owner",
      status: "active",
    };
    expect(me.primaryTenant).toEqual(tenant);
    expect(me.tenants).toEqual([tenant]);

    expect(me.capabilities).toEqual({ canCreateEvent: true, canPurchase: true, isAdmin: false });
    expect(me.unreadNotificationCount).toBe(0);
    expect(me.pendingInvitationCount).toBe(0);
    expect(me.deletionScheduledAt).toBeNull();
  });

  it("I2: unreadNotificationCount counts only the caller's unread rows", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);
    const strangerId = new ObjectId();

    await insertNotification({ userId: user._id, readAt: null });
    await insertNotification({ userId: user._id, readAt: null });
    await insertNotification({ userId: user._id, readAt: null });
    await insertNotification({ userId: user._id, readAt: new Date() });
    await insertNotification({ userId: user._id, readAt: new Date() });
    await insertNotification({ userId: strangerId, readAt: null });
    await insertNotification({ userId: strangerId, readAt: null });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);
    expect(me.unreadNotificationCount).toBe(3);
  });

  it("I1: pendingInvitationCount counts only the caller's pending invitations", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);
    const strangerId = new ObjectId();

    await insertInvitation({ userId: user._id, status: "pending" });
    await insertInvitation({ userId: user._id, status: "accepted" });
    await insertInvitation({ userId: user._id, status: "pending" });
    await insertInvitation({ userId: strangerId, status: "pending" });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);
    expect(me.pendingInvitationCount).toBe(2);
  });

  it("I8: projects a pure attendee as primaryTenant null, tenants [] and no capabilities", async () => {
    // Contract §1.2 note: `primaryTenant` is null for a pure attendee — normal,
    // not an error — and the shell must not offer event creation. This caller
    // has no `tenantMembers` row at all.
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);
    await updateProfile(user._id, {
      platformRole: "client",
      status: "active",
      primaryTenantId: null,
    });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);

    expect(me.primaryTenant).toBeNull();
    expect(me.tenants).toEqual([]);
    expect(me.capabilities).toEqual({ canCreateEvent: false, canPurchase: false, isAdmin: false });
  });

  it("I9: never surfaces a primaryTenantId whose membership is removed", async () => {
    // The projection reads active memberships only: a stale `primaryTenantId`
    // pointing at a workspace the caller has left must not resurrect it as
    // `primaryTenant`, nor leak it into `tenants[]`.
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    const removedTenant = await insertTenant({
      slug: "left-studio",
      name: "Left Studio",
      status: "active",
    });
    await insertTenantMember({
      tenantId: removedTenant,
      userId: user._id,
      role: "member",
      status: "removed",
    });
    await updateProfile(user._id, {
      platformRole: "client",
      status: "active",
      primaryTenantId: removedTenant,
    });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);

    expect(me.primaryTenant).toBeNull();
    expect(me.tenants).toEqual([]);
  });

  it("I9: never surfaces a primaryTenantId that references a missing tenant", async () => {
    // A dangling `primaryTenantId` (the tenant document is gone) is likewise
    // not a membership and must not be surfaced as `primaryTenant`.
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    await updateProfile(user._id, {
      platformRole: "client",
      status: "active",
      primaryTenantId: new ObjectId(),
    });

    const response = await meGet(getMeRequest(cookie));
    expect(response.status).toBe(200);
    const me = await body(response);

    expect(me.primaryTenant).toBeNull();
    expect(me.tenants).toEqual([]);
  });

  it('I10: projects email "" and emailVerified false for a user document lacking email', async () => {
    // A phone-only account — a `user` document with no `email` — is unreachable
    // through the auth flows (ADR-0057: `emailOTP` is the only sign-up path and
    // Better Auth requires `email`), so the projection's defensive branch is
    // pinned by seeding the document directly. Contract §1.2 keeps `email` a
    // non-nullable `string`: `asString(user?.email, "")` must yield `""` (never
    // `null`/`undefined`) and `emailVerified` must be `false`.
    const userId = new ObjectId();
    await database.collection(USER_COLLECTION).insertOne({
      _id: userId,
      // Deliberately no `email`, and `emailVerified` absent (so `!== true`):
      // this is the exact shape that drives the fallback branch.
    });

    const me = await buildMe(database, userId.toHexString());

    expect(me.email).toBe("");
    expect(typeof me.email).toBe("string");
    expect(me.emailVerified).toBe(false);

    // The body must still satisfy the route's strict response schema: swapping
    // the fallback to `null`/`undefined` fails `z.string()` here, which at the
    // route boundary is a 500 rather than a body the shell can render.
    const parsed = meSchema.safeParse(me);
    expect(parsed.success).toBe(true);
  });
});

describe("PATCH /api/v1/me (§1.2 current user)", () => {
  it("I3: rejects an unknown IANA time zone with 422 unknown_timezone", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const response = await mePatch(patchMeRequest(cookie, { timeZone: "Mars/Olympus" }));
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("unknown_timezone");
    expect(envelope.details?.field).toBe("timeZone");
  });

  it("I4: rejects an email change with 422 forbidden_field", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const response = await mePatch(patchMeRequest(cookie, { email: "someone-else@example.com" }));
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("forbidden_field");
    expect(envelope.details?.fields).toContain("email");
  });

  it("I6: rejects a platformRole change with 422 forbidden_field", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const response = await mePatch(patchMeRequest(cookie, { platformRole: "admin" }));
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("forbidden_field");
    expect(envelope.details?.fields).toContain("platformRole");
  });

  it("I5: rejects an avatarAssetId owned by another tenant with 422", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    // The caller belongs to their own workspace; the asset is owned by a
    // different tenant, so it is not attachable as this caller's avatar.
    const ownTenant = await insertTenant({ slug: "mine", name: "Mine", status: "active" });
    await insertTenantMember({
      tenantId: ownTenant,
      userId: user._id,
      role: "owner",
      status: "active",
    });
    const foreignTenant = await insertTenant({ slug: "theirs", name: "Theirs", status: "active" });
    const foreignAsset = await insertMediaAsset({ tenantId: foreignTenant, kind: "event_logo" });

    const response = await mePatch(
      patchMeRequest(cookie, { avatarAssetId: foreignAsset.toHexString() })
    );
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("validation_failed");
    const fields = envelope.details?.fields as Array<{ path?: string }> | undefined;
    expect((fields ?? []).map((issue) => issue.path)).toContain("avatarAssetId");
  });

  it("I7: rejects an empty PATCH body with 422 validation_failed", async () => {
    // Contract §1.2: the PATCH body is "all optional, at least one required".
    // An empty object therefore fails request-shape validation — Appendix A.2
    // maps that to `422 validation_failed` with `details.fields: [{path, code,
    // message}]` — and must never be a silent no-op 200.
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const response = await mePatch(patchMeRequest(cookie, {}));
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("validation_failed");
    const fields = envelope.details?.fields as Array<{ path?: string }> | undefined;
    expect(Array.isArray(fields)).toBe(true);
    expect((fields ?? []).length).toBeGreaterThan(0);
  });
});
