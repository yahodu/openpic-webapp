import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getEntitlements } from "@/app/api/v1/tenants/[tenantId]/entitlements/route";
import { GET as getUsage } from "@/app/api/v1/tenants/[tenantId]/usage/route";
import { COLLECTIONS } from "@/server/db/collections";
import type { Entitlement } from "@/server/plans/plans";

import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the entitlements and usage endpoints (OP-104,
 * contract §3.5, schema §14.2/§14.3).
 *
 * The user story: *as an organizer I see my quotas and remaining limits so the
 * UI can grey out actions and show quota bars.*
 *
 *   I1  a workspace with **no subscription document** is the free tier:
 *       `activePlanKey: "free"`, `subscribedPlanKey: "free"`,
 *       `subscriptionStatus: "none"`, `blockReason: null` — an explicit free
 *       state, never a `404`;
 *   I2  an `entitlementGrants` row is reflected in both `effectiveLimit`
 *       (`plan.limit + Σ active grants.delta`) and the served `grants[]`;
 *   I3  a `member` (role `member`) is refused the **raw usage rows** with
 *       `403 forbidden` (the endpoint is `owner`|`admin`), while the same
 *       member may still read the advisory `entitlements` view.
 *
 * Around those three the suite pins the ordinary behaviour the story implies:
 * the §3.5 section shape, the `resetsAt` boundary on a monthly quota, the
 * `403`/`404`/`401` ladder, the `periodKey` filter on `/usage`, and that the
 * advisory read writes nothing.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/entitlements/route` exports `GET`,
 *   declared `defineRoute({ route: "/api/v1/tenants/:tenantId/entitlements", … })`
 *   with the `user` auth stage and the reusable tenant stage; it answers the
 *   §3.5 body **bare** (a single resource, §0.5). The plan is resolved from the
 *   live subscription's `activePlanKey`, defaulting to `"free"` when the tenant
 *   has no live subscription row (`status: "none"`).
 * - `@/app/api/v1/tenants/[tenantId]/usage/route` exports `GET`, the same auth
 *   and tenant stages, and a **role gate** (`owner`|`admin` → `403 forbidden`
 *   for a `member`). It answers the raw `usageCounters` rows as the §0.5
 *   collection envelope `{ data: […] }`, filtered by the `?periodKey=` query.
 * - Subscription-, grant- and counter-derived reads are tenant-scoped (string
 *   `tenantId`, as OP-103 established); the plan read is platform-scoped.
 *
 * ## Assumptions recorded in the handoff (ADR-0360)
 *
 * - `resetsAt` is the start of the next UTC period; `lifetime`/`none` are
 *   `null` (pinned as a pure function in `src/test/unit/entitlements-read-model.test.ts`).
 * - `blockReason` is `null` on a healthy active subscription; only an
 *   exhausted `hard` limit (`plan_limit`) or a `downgraded` subscription
 *   (`payment_downgrade`) raises it.
 * - Event/attendee-scoped entitlements carry their plan limits but **no**
 *   `used`/`remaining` (contract §3.5).
 * - `/usage` answers `{ data: […] }` (§0.5 collection envelope) and never leaks
 *   the driver's `_id` (§0.5: "never expose `_id`").
 */

const TENANTS_PATH = "/api/v1/tenants";

/** An RFC 3339 UTC timestamp string. */
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not an ISO date-time" });

/**
 * One entitlement row of the §3.5 body.
 *
 * `resetPeriod`/`resetsAt`/`used`/`remaining`/`periodKey` are optional here
 * because §3.5's own feature-row example omits them while §3.5's TS interface
 * marks them required; the specs assert them only where the contract is
 * unambiguous (a `tenant`-scoped metered row).
 */
const entitlementStateSchema = z.object({
  key: z.string(),
  limit: z.number().int().nullable(),
  effectiveLimit: z.number().int().nullable(),
  used: z.number().int().optional(),
  remaining: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  periodKey: z.string().optional(),
  resetPeriod: z.enum(["monthly", "yearly", "lifetime", "none"]).optional(),
  resetsAt: isoDateTime.nullable().optional(),
  scope: z.enum(["tenant", "event", "attendee"]),
  enforcement: z.enum(["hard", "soft", "policy", "feature"]),
  unlimited: z.boolean(),
  grants: z
    .array(
      z.object({
        delta: z.number().int(),
        source: z.string(),
        validUntil: isoDateTime.nullable(),
      })
    )
    .optional(),
  thresholdCrossed: z.union([z.literal(80), z.literal(95), z.literal(100), z.null()]),
  display: z.string(),
});

/** The §3.5 body. */
const entitlementsBodySchema = z.object({
  activePlanKey: z.string(),
  subscribedPlanKey: z.string(),
  subscriptionStatus: z.enum([
    "none",
    "incomplete",
    "active",
    "past_due",
    "downgraded",
    "cancelled",
    "expired",
  ]),
  blockReason: z.enum(["plan_limit", "payment_downgrade"]).nullable(),
  entitlements: z.array(entitlementStateSchema),
  computedAt: isoDateTime,
});

/** One raw `usageCounters` row as `/usage` serves it. */
const usageRowSchema = z.object({
  entitlementKey: z.string(),
  periodKey: z.string(),
  value: z.number(),
  updatedAt: isoDateTime.optional(),
});

/** The `/usage` collection envelope (§0.5). */
const usageBodySchema = z.object({ data: z.array(usageRowSchema) });

let app: TestApp;

beforeAll(async () => {
  // Boots a private database, the real auth surface and the readiness probe;
  // the cold connect belongs in this hook, never inside a timed spec.
  app = await startTestApp({ prefix: "op104-endpoints" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; name: string; ownerUserId: ObjectId }) {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: fields.name,
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.ownerUserId,
    dataRegion: "in",
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

/** Seed a workspace owned by `userId`, making it that user's primary tenant. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug,
    name: "OP104 Studio",
    ownerUserId: options.role === "owner" ? options.userId : new ObjectId(),
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: options.userId,
    role: options.role,
    status: "active",
    joinedAt: new Date(),
  });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** Add `user` to `tenantId` with a role and a working `current` alias. */
async function addMember(
  tenantId: ObjectId,
  user: SignedInUser,
  role: "owner" | "admin" | "member"
): Promise<void> {
  await app.db
    .collection(COLLECTIONS.tenantMembers)
    .insertOne({ tenantId, userId: user.userId, role, status: "active", joinedAt: new Date() });
  await updateProfile(user.userId, { primaryTenantId: tenantId });
}

/** Seed one plan with the supplied entitlements (schema §14.1). */
async function seedPlan(fields: {
  key: string;
  entitlements: Record<string, Entitlement>;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne({
    key: fields.key,
    name: fields.key,
    description: "",
    marketingFeatures: [],
    tierRank: fields.key === "free" ? 0 : 1,
    selfServe: true,
    salesAssisted: false,
    active: true,
    version: 1,
    prices: [],
    entitlements: fields.entitlements,
  });
}

/** Seed a live subscription row (schema §14.3) for a tenant (string id). */
async function seedSubscription(fields: {
  tenantId: string;
  activePlanKey: string;
  status: "active" | "downgraded" | "past_due";
  subscribedPlanKey?: string;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    tenantId: fields.tenantId,
    subscribedPlanKey: fields.subscribedPlanKey ?? fields.activePlanKey,
    subscribedPlanVersion: 1,
    activePlanKey: fields.activePlanKey,
    status: fields.status,
    priceKey: `${fields.activePlanKey}-monthly-inr`,
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    billingCycle: "monthly",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    nextChargeAt: new Date("2026-10-01T00:00:00.000Z"),
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
}

/** Seed an additive top-up (schema §14.2) for a tenant (string id). */
async function seedGrant(fields: {
  tenantId: string;
  entitlementKey: string;
  delta: number;
  validFrom?: Date;
  validUntil?: Date | null;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.entitlementGrants).insertOne({
    tenantId: fields.tenantId,
    entitlementKey: fields.entitlementKey,
    delta: fields.delta,
    overrideLimit: null,
    source: { kind: "purchase", billingTransactionId: new ObjectId(), note: null },
    validFrom: fields.validFrom ?? new Date("2026-01-01T00:00:00.000Z"),
    validUntil: fields.validUntil ?? null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdByUserId: null,
  });
}

/** Seed one usage counter row (schema §14.2) for a tenant (string id). */
async function seedCounter(fields: {
  tenantId: string;
  entitlementKey: string;
  periodKey: string;
  value: number;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    tenantId: fields.tenantId,
    entitlementKey: fields.entitlementKey,
    periodKey: fields.periodKey,
    value: fields.value,
    updatedAt: new Date("2026-09-15T10:00:00.000Z"),
  });
}

/** The current UTC period key for a monthly cadence. */
function currentMonthKey(now = new Date()): string {
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The start of the next UTC month. */
function nextMonthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** A `GET /tenants/{t}/entitlements` request carrying the session cookie. */
function entitlementsRequest(cookie: string, tenantId: string): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantId}/entitlements`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** A `GET /tenants/{t}/usage` request (optionally period-scoped). */
function usageRequest(cookie: string, tenantId: string, periodKey?: string): Request {
  const url = new URL(`${TENANTS_PATH}/${tenantId}/usage`, APP_ORIGIN);
  if (periodKey !== undefined) {
    url.searchParams.set("periodKey", periodKey);
  }
  return new Request(url, { method: "GET", headers: { cookie } });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

/** Find one entitlement row by key in a §3.5 body. */
async function entitlementRow(response: Response, key: string): Promise<Record<string, unknown>> {
  const payload = await body(response);
  const rows = payload.entitlements as Record<string, unknown>[];
  const row = rows.find((entry) => entry.key === key);
  if (row === undefined) {
    throw new Error(`expected an entitlement row for ${key}, got ${JSON.stringify(rows)}`);
  }
  return row;
}

/** The raw `usageCounters` rows for one tenant. */
async function countersFor(tenantId: ObjectId): Promise<WithId<Document>[]> {
  return app.db
    .collection(COLLECTIONS.usageCounters)
    .find({ tenantId: tenantId.toHexString() })
    .toArray();
}

describe("GET /api/v1/tenants/{tenantId}/entitlements", () => {
  it("I1: a workspace with no subscription document reads as the free tier, not a 404", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
        "originals.download": {
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: true,
        },
      },
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const payload = await body(response);
    expect(() => entitlementsBodySchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      activePlanKey: "free",
      subscribedPlanKey: "free",
      subscriptionStatus: "none",
      blockReason: null,
    });
  });

  it("I1: a free tenant's monthly quota carries the §3.5 fields, `used` from its counter and the next reset boundary", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: currentMonthKey(),
      value: 1,
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const row = await entitlementRow(response, "events.active");
    expect(row).toMatchObject({
      key: "events.active",
      limit: 3,
      effectiveLimit: 3,
      used: 1,
      remaining: 2,
      resetPeriod: "monthly",
      periodKey: currentMonthKey(),
      resetsAt: nextMonthStartIso(),
      scope: "tenant",
      enforcement: "hard",
      unlimited: false,
      thresholdCrossed: null,
    });
    expect(typeof row.display).toBe("string");
  });

  it("I2: an active grant raises `effectiveLimit` and appears in `grants[]`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-paid",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "storage.bytes": {
          limit: 100,
          resetPeriod: "lifetime",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      activePlanKey: "starter",
      status: "active",
    });
    await seedGrant({
      tenantId: tenantId.toHexString(),
      entitlementKey: "storage.bytes",
      delta: 50,
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(() => entitlementsBodySchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({ activePlanKey: "starter", subscriptionStatus: "active" });

    const row = await entitlementRow(response, "storage.bytes");
    expect(row).toMatchObject({
      limit: 100,
      effectiveLimit: 150,
      used: 0,
      remaining: 150,
      periodKey: "lifetime",
      resetPeriod: "lifetime",
      resetsAt: null,
      unlimited: false,
      grants: [{ delta: 50, source: "purchase", validUntil: null }],
    });
  });

  it("I2: an expired grant is not counted in `effectiveLimit`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-paid",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "storage.bytes": {
          limit: 100,
          resetPeriod: "lifetime",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      activePlanKey: "starter",
      status: "active",
    });
    await seedGrant({
      tenantId: tenantId.toHexString(),
      entitlementKey: "storage.bytes",
      delta: 999,
      validFrom: new Date("2025-01-01T00:00:00.000Z"),
      validUntil: new Date("2025-06-01T00:00:00.000Z"),
    });

    const row = await entitlementRow(
      await getEntitlements(entitlementsRequest(owner.cookie, tenantId.toHexString())),
      "storage.bytes"
    );

    expect(row.effectiveLimit).toBe(100);
  });

  it("lists an event-scoped entitlement with its plan limits but without `used`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "originals.download": {
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: false,
        },
      },
    });

    const row = await entitlementRow(
      await getEntitlements(entitlementsRequest(owner.cookie, tenantId.toHexString())),
      "originals.download"
    );

    expect(row).toMatchObject({
      scope: "event",
      enforcement: "feature",
      enabled: false,
      unlimited: true,
      limit: null,
      effectiveLimit: null,
    });
    expect(row).not.toHaveProperty("used");
    expect(row).not.toHaveProperty("remaining");
  });

  it("is advisory: reading the quota view writes no usage counter row", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: currentMonthKey(),
      value: 2,
    });
    const before = await countersFor(tenantId);

    await getEntitlements(entitlementsRequest(owner.cookie, tenantId.toHexString()));
    await getEntitlements(entitlementsRequest(owner.cookie, tenantId.toHexString()));

    const after = await countersFor(tenantId);
    expect(after).toHaveLength(before.length);
    const row = after.find((entry) => entry.entitlementKey === "events.active");
    expect(row?.value).toBe(2);
  });

  it("is readable by a plain member (member auth, §3.5)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const member = await app.signIn(makeIdentity("op104-member"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });
    await addMember(tenantId, member, "member");
    await seedPlan({ key: "free", entitlements: {} });

    const response = await getEntitlements(
      entitlementsRequest(member.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
  });

  it("answers 404 (never 403) to a caller who is not a member of the workspace", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const stranger = await app.signIn(makeIdentity("op104-stranger"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-free",
    });

    const response = await getEntitlements(
      entitlementsRequest(stranger.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 401 without a session", async () => {
    const response = await getEntitlements(
      new Request(new URL(`${TENANTS_PATH}/current/entitlements`, APP_ORIGIN), { method: "GET" })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });
});

describe("GET /api/v1/tenants/{tenantId}/usage", () => {
  it("I3: a member is refused the raw usage rows with 403", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const member = await app.signIn(makeIdentity("op104-member"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage",
    });
    await addMember(tenantId, member, "member");
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });

    const response = await getUsage(usageRequest(member.cookie, tenantId.toHexString(), "2026-09"));

    expect(response.status).toBe(403);
    expect((await errorEnvelope(response)).code).toBe("forbidden");
  });

  it("serves the owner the raw counter rows as the §0.5 collection envelope", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage",
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });

    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString(), "2026-09"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(tenantId.toHexString());

    const payload = await body(response);
    expect(() => usageBodySchema.parse(payload)).not.toThrow();
    const rows = payload.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });
    // §0.5: the driver's `_id` is never exposed.
    expect(rows[0]).not.toHaveProperty("_id");
  });

  it("filters the rows to the requested `periodKey`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage",
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-10",
      value: 1,
    });

    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString(), "2026-10"));

    expect(response.status).toBe(200);
    const rows = (await body(response)).data as Record<string, unknown>[];
    expect(rows.map((row) => row.periodKey)).toEqual(["2026-10"]);
  });

  it("is readable by an admin (contract §3.5 `owner`|`admin`)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const admin = await app.signIn(makeIdentity("op104-admin"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage",
    });
    await addMember(tenantId, admin, "admin");
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });

    const response = await getUsage(usageRequest(admin.cookie, tenantId.toHexString(), "2026-09"));

    expect(response.status).toBe(200);
  });

  it("answers 404 (never 403) to a caller who is not a member of the workspace", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const stranger = await app.signIn(makeIdentity("op104-stranger"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage",
    });

    const response = await getUsage(
      usageRequest(stranger.cookie, tenantId.toHexString(), "2026-09")
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 401 without a session", async () => {
    const response = await getUsage(
      new Request(new URL(`${TENANTS_PATH}/current/usage`, APP_ORIGIN), { method: "GET" })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });
});
