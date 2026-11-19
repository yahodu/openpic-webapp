import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { GET as getEntitlements } from "@/app/api/v1/tenants/[tenantId]/entitlements/route";
import { GET as getUsage } from "@/app/api/v1/tenants/[tenantId]/usage/route";
import { COLLECTIONS } from "@/server/db/collections";
import { encodeCursor } from "@/server/http/cursor";
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
 *
 * ## Follow-up pins — OP-104 L2/L3/L4 (RED at ADR-0362)
 *
 * - **L2 — `/usage` is bounded by the platform cursor contract (§0.8),
 *   additively.** `?cursor=&limit=` go through the existing `parsePageQuery`
 *   (`@/server/http/cursor`): limit default `40`, clamped to `100`, and an
 *   unparseable or foreign cursor is `400 invalid_cursor`. The body stays
 *   `{ data }` and **gains** `page: { nextCursor, hasMore, limit }` (§0.5's
 *   collection example); `nextCursor` is `null` when `hasMore` is `false`. The
 *   sort is fixed: **`periodKey` descending, then `_id` descending**, so a tie
 *   inside one period never skips or duplicates a row. `usageBodySchema` stays
 *   `{ data }` on purpose — it is the "existing clients still work" control —
 *   so the envelope assertions read `payload.page` explicitly instead.
 * - **L3 — both plan keys are required on a present row (§14.3).**
 *   `activePlanKey`/`subscribedPlanKey` lose their silent `"free"` default: a
 *   live `subscriptions` row missing either field is server-side corruption and
 *   answers `500 internal_error` (§0.7 "unhandled — never leak internals"),
 *   never a laundered free tier. No row at all still reads as `free`/`none`
 *   (I1, unchanged).
 * - **L4 — the `$ne: "cancelled"` selection is pinned, not changed.** An
 *   `expired` row is live and resolves its paid plan; with several live rows the
 *   read picks an arbitrary one, so the pin asserts only what holds for any
 *   pick: the served plan is one of the live rows' plans, `subscriptionStatus`
 *   belongs to that same row, and the cancelled row's plan is never served.
 *
 * ## Characterization pins — OP-104 L5/L6 (green on arrival)
 *
 * Two arms the bounded `/usage` read introduced are pinned, not changed. Both
 * cases are **characterization**: they pass against the shipped implementation
 * and exist only to make a regression visible (ADR-0364), so a red L5/L6 means
 * the guard or the keyset regressed — never that the spec is ahead of the code.
 *
 * - **L5 — a decodable cursor whose `_id` half is not 24-hex is `400
 *   invalid_cursor`.** `decodeCursor` (`@/server/http/cursor`) guarantees only
 *   two non-empty strings, so `{ c: "2026-09", i: "zz" }` decodes; the read must
 *   still reject it *before* the keyset filter builds `new ObjectId(i)`.
 * - **L6 — a cursor whose period precedes every row is an empty terminal page.**
 *   The `$or` keyset excludes every seeded row, so the answer is `200` with
 *   `data: []` and `page: { nextCursor: null, hasMore: false, limit: 40 }` —
 *   never a `500`, a silently repeated page, or an unfollowable cursor.
 *
 * ## Characterization pins — OP-104 L7/L8 (green on arrival, ADR-0367)
 *
 * The counter read ADR-0365 bounded to each `tenant`-scoped key's **current**
 * period narrows corruption detection in exactly one arm. Both cases below are
 * **characterization** too: they pass against the shipped trunk and exist only
 * to make a change visible (ADR-0367), so a red means the shipped behaviour
 * moved — never that the spec is ahead of the code.
 *
 * - **L7 — a malformed counter row in a *closed* period is ignored.** The row
 *   is outside the fetched `(entitlementKey, periodKey)` pair set, so it is
 *   never parsed by `storedCounterSchema` and the view still answers `200` from
 *   the current-period row. Under the pre-ADR-0365 `find().toArray()` read the
 *   same seed threw (`500 internal_error`). This pin documents that narrowing:
 *   **a red L7 means the fetch set widened again.**
 * - **L8 — a malformed counter row in the *served* period is still refused.**
 *   The row is inside the pair set, so the parse still throws and the route
 *   answers `500 internal_error`. Green on both heads by design (the unbounded
 *   read fetched it too); the narrowing is only ever *outside* the served
 *   period.
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

/**
 * The `page` object `/usage` gains (§0.5 collection example, §0.8).
 *
 * Deliberately **not** merged into {@link usageBodySchema}: that schema is the
 * "an existing client still parses the body" control, so the bound is asserted
 * against the raw payload here.
 */
const usagePageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int(),
});

/** One served `/usage` row, as {@link usageRowSchema} types it. */
type UsageRow = z.infer<typeof usageRowSchema>;

let app: TestApp;

/**
 * The instant every spec in this file reasons about.
 *
 * The view derives `periodKey` and `resetsAt` from the route's injected
 * `systemClock.now()`, and the counters are seeded with the *same* derivation.
 * Freezing the clock keeps the seed and the read on one instant, so a run that
 * would straddle a UTC month boundary (seed at `T-1ms`, read at `T+1ms`) cannot
 * look up the next period key and find no counter. A mid-month instant keeps
 * `nextMonthStartIso()` unambiguous.
 */
const FROZEN_NOW = new Date("2026-09-15T12:00:00.000Z");

beforeAll(async () => {
  // Boots a private database, the real auth surface and the readiness probe;
  // the cold connect belongs in this hook, never inside a timed spec.
  app = await startTestApp({ prefix: "op104-endpoints" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(() => {
  // Fake `Date` only: `setTimeout`/`setInterval` stay real for the driver's
  // sockets and heartbeats, while `new Date()` (and so `systemClock.now()`)
  // returns {@link FROZEN_NOW} for every case.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

beforeEach(async () => {
  // One database is booted for the whole file (`beforeAll`), so a reused plan
  // key (`"free"`/`"starter"`) would otherwise collide across tests: the first
  // inserted document wins `findOne({ key })` and a later seed is ignored
  // (ADR-0361 D2). Wipe the collections each test seeds. The database is
  // private to this file (`startTestApp` prefixes it), so nothing else is hit.
  await Promise.all([
    app.db.collection(COLLECTIONS.plans).deleteMany({}),
    app.db.collection(COLLECTIONS.subscriptions).deleteMany({}),
    app.db.collection(COLLECTIONS.entitlementGrants).deleteMany({}),
    app.db.collection(COLLECTIONS.usageCounters).deleteMany({}),
  ]);
});

afterAll(async () => {
  await app.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
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
  status: "active" | "downgraded" | "past_due" | "cancelled" | "expired";
  subscribedPlanKey?: string;
  /** Set to timestamp a `cancelled` row; omitted leaves `cancelledAt: null`. */
  cancelledAt?: Date;
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
    cancelledAt: fields.cancelledAt ?? null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
}

/**
 * Insert a **live** `subscriptions` row (schema §14.3) that is missing one of
 * the two required plan keys.
 *
 * A state {@link seedSubscription} cannot build (it always writes both keys):
 * §14.3 marks `activePlanKey` and `subscribedPlanKey` required, so a document
 * without one is server-side corruption, not a free tier.
 */
async function seedSubscriptionMissingPlanKey(fields: {
  tenantId: string;
  missing: "activePlanKey" | "subscribedPlanKey";
}): Promise<void> {
  const shared = {
    tenantId: fields.tenantId,
    subscribedPlanVersion: 1,
    status: "active" as const,
    priceKey: "starter-monthly-inr",
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
  };
  await app.db
    .collection(COLLECTIONS.subscriptions)
    .insertOne(
      fields.missing === "activePlanKey"
        ? { ...shared, subscribedPlanKey: "starter" }
        : { ...shared, activePlanKey: "starter" }
    );
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
  /** Pass `null` to seed a row with no `updatedAt` at all. */
  updatedAt?: Date | null;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    tenantId: fields.tenantId,
    entitlementKey: fields.entitlementKey,
    periodKey: fields.periodKey,
    value: fields.value,
    ...(fields.updatedAt === null
      ? {}
      : { updatedAt: fields.updatedAt ?? new Date("2026-09-15T10:00:00.000Z") }),
  });
}

/**
 * Seed `count` counter rows for one tenant in one period, one per distinct
 * `entitlementKey`.
 *
 * `usageCounters` holds one row per `(entitlementKey, periodKey)` (schema
 * §14.2), so a page bound needs more rows than the limit *within a single
 * period* — that is also what makes the `_id` tiebreak load-bearing.
 *
 * @returns The seeded entitlement keys, in seed order.
 */
async function seedCounterPage(
  tenantId: string,
  options: { periodKey: string; count: number; prefix: string }
): Promise<string[]> {
  const keys = Array.from(
    { length: options.count },
    (_, index) => `${options.prefix}.metric-${String(index + 1).padStart(2, "0")}`
  );
  for (const entitlementKey of keys) {
    await seedCounter({ tenantId, entitlementKey, periodKey: options.periodKey, value: 0 });
  }
  return keys;
}

/**
 * The current UTC period key for a monthly cadence.
 *
 * Reads the frozen clock of the running spec (see {@link FROZEN_NOW}), i.e. the
 * same instant the route's `systemClock.now()` sees.
 */
function currentMonthKey(now = new Date()): string {
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The start of the next UTC month, from the frozen clock of the running spec. */
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

/**
 * A `GET /tenants/{t}/usage` request carrying explicit query parameters
 * (`?cursor=`, `?limit=` — contract §0.8).
 */
function usageQueryRequest(
  cookie: string,
  tenantId: string,
  query: Readonly<Record<string, string>>
): Request {
  const url = new URL(`${TENANTS_PATH}/${tenantId}/usage`, APP_ORIGIN);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return new Request(url, { method: "GET", headers: { cookie } });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

/** Find one entitlement row by key in an already-parsed §3.5 body. */
function entitlementRowFrom(
  payload: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const rows = payload.entitlements as Record<string, unknown>[];
  const row = rows.find((entry) => entry.key === key);
  if (row === undefined) {
    throw new Error(`expected an entitlement row for ${key}, got ${JSON.stringify(rows)}`);
  }
  return row;
}

/**
 * Find one entitlement row by key in a §3.5 body.
 *
 * A Fetch `Response` body is single-use, so callers that also assert on the
 * parsed payload must use {@link entitlementRowFrom} with the payload they
 * already read (ADR-0361 D1).
 */
async function entitlementRow(response: Response, key: string): Promise<Record<string, unknown>> {
  return entitlementRowFrom(await body(response), key);
}

/** The raw `usageCounters` rows for one tenant. */
async function countersFor(tenantId: ObjectId): Promise<WithId<Document>[]> {
  return app.db
    .collection(COLLECTIONS.usageCounters)
    .find({ tenantId: tenantId.toHexString() })
    .toArray();
}

/**
 * The wire identities of served `/usage` rows.
 *
 * A counter is unique per `(entitlementKey, periodKey)` (schema §14.2), so that
 * pair is what "the same row" means when two pages are compared.
 */
function usageRowIdentities(rows: readonly UsageRow[]): string[] {
  return rows.map((row) => `${row.entitlementKey}|${row.periodKey}`);
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

    // A Fetch `Response` body is single-use: find the row in the payload we
    // already parsed instead of reading the same response a second time (D1).
    const row = entitlementRowFrom(payload, "storage.bytes");
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

  it("serves an active grant's non-null `validUntil` window beside its delta (contract §3.5 grants[])", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-grant-window",
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
    // The window still covers "now": validFrom in the past, validUntil far ahead.
    const validUntil = new Date("2099-01-01T00:00:00.000Z");
    await seedGrant({
      tenantId: tenantId.toHexString(),
      entitlementKey: "storage.bytes",
      delta: 50,
      validFrom: new Date("2020-01-01T00:00:00.000Z"),
      validUntil,
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const row = entitlementRowFrom(await body(response), "storage.bytes");
    expect(row).toMatchObject({
      limit: 100,
      effectiveLimit: 150,
      unlimited: false,
      grants: [{ delta: 50, source: "purchase", validUntil: validUntil.toISOString() }],
    });
  });

  it("serves `used` and a null `remaining` for a tenant-scoped unlimited quota (contract §3.5)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-unlimited",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "events.active": {
          limit: null,
          resetPeriod: "monthly",
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
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: currentMonthKey(),
      value: 7,
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const row = entitlementRowFrom(await body(response), "events.active");
    expect(row).toMatchObject({
      key: "events.active",
      limit: null,
      effectiveLimit: null,
      used: 7,
      remaining: null,
      periodKey: currentMonthKey(),
      scope: "tenant",
      enforcement: "hard",
      unlimited: true,
    });
  });

  it("serves an empty `entitlements` array (still 200) when the resolved plan has no document (contract §3.5)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-no-plan",
    });
    // No `plans` document and no subscription: the resolved key is "free" but
    // `findOne({ key: "free" })` returns null — a real defence, not dead code.
    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(() => entitlementsBodySchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      activePlanKey: "free",
      subscribedPlanKey: "free",
      subscriptionStatus: "none",
      blockReason: null,
      entitlements: [],
    });
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

  it("L3 (RED): a live subscription row missing `activePlanKey` answers 500 `internal_error`, never the free tier", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-partial-active-key",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    // §14.3 marks both plan keys required, so this row is server-side
    // corruption — not client input and not a free tier.
    await seedSubscriptionMissingPlanKey({
      tenantId: tenantId.toHexString(),
      missing: "activePlanKey",
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(500);
    const payload = await body(response);
    expect((payload.error as { code: string }).code).toBe("internal_error");
    // §0.7: an unhandled failure never leaks internals — and never launders the
    // corrupt row into a genuine-looking `free` tier body.
    expect(payload).not.toHaveProperty("activePlanKey");
    expect(payload).not.toHaveProperty("entitlements");
    expect(JSON.stringify(payload)).not.toMatch(/"free"/);
  });

  it("L3 (RED): a live subscription row missing `subscribedPlanKey` answers 500 `internal_error`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-partial-subscribed-key",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    await seedSubscriptionMissingPlanKey({
      tenantId: tenantId.toHexString(),
      missing: "subscribedPlanKey",
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(500);
    const payload = await body(response);
    expect((payload.error as { code: string }).code).toBe("internal_error");
    expect(payload).not.toHaveProperty("subscribedPlanKey");
  });

  it("L4 characterisation (green today and after the GREEN): an `expired` subscription is a live row and resolves its paid plan", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-expired-live",
    });
    await seedPlan({
      key: "starter",
      entitlements: {
        "events.active": {
          limit: 3,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
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
      subscribedPlanKey: "starter",
      status: "expired",
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(() => entitlementsBodySchema.parse(payload)).not.toThrow();
    // `expired` is not `cancelled`: the `$ne: "cancelled"` read still selects it,
    // so the tenant keeps its paid entitlements (ADR-0400 consistency).
    expect(payload).toMatchObject({
      activePlanKey: "starter",
      subscribedPlanKey: "starter",
      subscriptionStatus: "expired",
    });
    const keys = (payload.entitlements as { key: string }[]).map((row) => row.key).sort();
    expect(keys).toEqual(["events.active", "storage.bytes"]);
  });

  it('L4 characterisation (green today and after the GREEN): the `$ne: "cancelled"` read never serves the cancelled row\'s plan', async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-multi-live",
    });
    await seedPlan({ key: "starter", entitlements: {} });
    await seedPlan({ key: "plus", entitlements: {} });
    await seedPlan({ key: "pro", entitlements: {} });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      activePlanKey: "pro",
      subscribedPlanKey: "pro",
      status: "cancelled",
      cancelledAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      activePlanKey: "starter",
      subscribedPlanKey: "starter",
      status: "active",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      activePlanKey: "plus",
      subscribedPlanKey: "plus",
      status: "expired",
    });
    // The read has no sort, so which live row wins is arbitrary. Pin only what
    // holds for any pick: the served plan is a LIVE row's plan and the served
    // status belongs to that same row — the cancelled `pro` row never wins.
    const livePlanStatus = new Map<string, string>([
      ["starter", "active"],
      ["plus", "expired"],
    ]);

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    const servedPlan = String(payload.activePlanKey);
    const servedStatus = String(payload.subscriptionStatus);

    expect([...livePlanStatus.keys()]).toContain(servedPlan);
    expect(livePlanStatus.get(servedPlan)).toBe(servedStatus);
    expect(servedPlan).not.toBe("pro");
  });

  /**
   * **Characterization** pin of ADR-0365's bounded counter read (ADR-0367).
   *
   * The view fetches only each `tenant`-scoped key's *current* period (the `$or`
   * over `counterPairs` in `view.ts`), so a counter row for the same key in a
   * **closed** period is never parsed. A row whose stored `value` is not a
   * number therefore no longer trips `storedCounterSchema.parse`: the response
   * stays `200` and `used` comes from the current-period row.
   *
   * This records a deliberate narrowing of corruption detection — it does *not*
   * promise the old row is harmless. **A red here means the fetch set widened
   * again** (e.g. back to `find().toArray()`), which would restore the `500
   * internal_error` that the pre-ADR-0365 head answered for this exact seed.
   */
  it("L7 characterization: a malformed counter row in a closed period is ignored, and the view still answers 200", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-corrupt-closed-period",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "events.active": {
          limit: 5,
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
      value: 4,
    });
    // `seedCounter` types `value` as `number`, so the corruption goes in raw.
    // A *different* period for the *same* key keeps the row off the
    // `(tenantId, entitlementKey, periodKey)` unique index (schema §14.2)
    // while still exercising "a corrupt row this tenant owns".
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2019-01",
      value: "corrupt",
      updatedAt: new Date("2019-01-15T10:00:00.000Z"),
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(200);
    const row = await entitlementRow(response, "events.active");
    // `used` is the current-period row's value, never the corrupt row's.
    expect(row).toMatchObject({
      key: "events.active",
      periodKey: currentMonthKey(),
      used: 4,
      remaining: 1,
    });
  });

  /**
   * **Characterization** pin: the narrowing is only ever *outside* the served
   * period (ADR-0367).
   *
   * This corrupt row *is* inside the fetched pair set (same key, the current
   * period), so `storedCounterSchema.parse` still throws and the route answers
   * `500 internal_error`. Green on both heads by design — the pre-ADR-0365
   * `find()` read fetched it as well — so this pin is a contract, not a delta:
   * a red means a malformed *served-period* counter row can now reach a served
   * `used` value.
   */
  it("L8 characterization: a malformed counter row in the served period is still refused with 500 `internal_error`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-corrupt-served-period",
    });
    await seedPlan({
      key: "free",
      entitlements: {
        "events.active": {
          limit: 5,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        },
      },
    });
    // The one row for this `(entitlementKey, periodKey)` pair is the corrupt
    // one: a valid row may not sit beside it (schema §14.2 uniqueness), and
    // the arm under pin is "the served period is still parsed".
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: currentMonthKey(),
      value: "corrupt",
      updatedAt: new Date("2026-09-15T10:00:00.000Z"),
    });

    const response = await getEntitlements(
      entitlementsRequest(owner.cookie, tenantId.toHexString())
    );

    expect(response.status).toBe(500);
    expect((await errorEnvelope(response)).code).toBe("internal_error");
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

  it("serves every period when no `?periodKey=` filter is supplied (contract §3.5, §0.5 envelope)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-all",
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

    // No `periodKey` argument: the query parameter is absent, so the filter is
    // `{}` and both periods come back.
    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString()));
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(() => usageBodySchema.parse(payload)).not.toThrow();
    const rows = payload.data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.periodKey).sort()).toEqual(["2026-09", "2026-10"]);
  });

  it("omits `updatedAt` from a served row whose counter row has none (schema §14.2)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-no-updated",
    });
    // `updatedAt: null` seeds a row with no `updatedAt` field at all.
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 4,
      updatedAt: null,
    });

    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString(), "2026-09"));
    expect(response.status).toBe(200);

    const rows = (await body(response)).data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 4,
    });
    expect(rows[0]).not.toHaveProperty("updatedAt");
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

  it("L2 (RED): `/usage` serves 40 rows plus a `page` envelope when 41 counters share one period", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-bound",
    });
    const seeded = await seedCounterPage(tenantId.toHexString(), {
      periodKey: "2026-09",
      count: 41,
      prefix: "bound",
    });
    const seededIds = seeded.map((key) => `${key}|2026-09`);

    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
    const payload = await body(response);
    // The change is additive: an existing client's `{ data }` parse still holds.
    const rows = usageBodySchema.parse(payload).data;
    expect(rows).toHaveLength(40);
    // The bound is a page of the same rows, never a different query.
    expect(usageRowIdentities(rows).filter((id) => !seededIds.includes(id))).toEqual([]);

    const page = usagePageSchema.parse(payload.page);
    expect(page.limit).toBe(40);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.stringMatching(/\S/));
  });

  it("L2 (RED): following `nextCursor` returns the one remaining row, and the pages neither skip nor duplicate", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-cursor",
    });
    const seeded = await seedCounterPage(tenantId.toHexString(), {
      periodKey: "2026-09",
      count: 41,
      prefix: "cursor",
    });
    const seededIds = seeded.map((key) => `${key}|2026-09`);

    const first = await body(await getUsage(usageRequest(owner.cookie, tenantId.toHexString())));
    const firstRows = usageBodySchema.parse(first).data;
    expect(firstRows).toHaveLength(40);
    const firstPage = usagePageSchema.parse(first.page);
    const cursor = firstPage.nextCursor ?? "";
    expect(cursor).not.toBe("");

    const second = await body(
      await getUsage(usageQueryRequest(owner.cookie, tenantId.toHexString(), { cursor }))
    );
    const secondRows = usageBodySchema.parse(second).data;
    expect(secondRows).toHaveLength(1);
    const secondPage = usagePageSchema.parse(second.page);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.limit).toBe(40);

    // One period, 41 rows: the `_id` tiebreak inside the period is what keeps
    // the two pages disjoint and their union exactly the seeded set.
    const firstIds = usageRowIdentities(firstRows);
    const secondIds = usageRowIdentities(secondRows);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect([...firstIds, ...secondIds].sort()).toEqual([...seededIds].sort());
  });

  it("L2 (RED): rows come back `periodKey` descending, with no client-side sort", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-sort",
    });
    // Seeded oldest period first: insertion order is NOT the served order.
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

    const response = await getUsage(usageRequest(owner.cookie, tenantId.toHexString()));

    expect(response.status).toBe(200);
    const rows = usageBodySchema.parse(await body(response)).data;
    expect(rows.map((row) => row.periodKey)).toEqual(["2026-10", "2026-09"]);
  });

  it("L2 (RED): `?limit=` is honoured (`1`) and echoed clamped (`100`) in `page.limit`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-limit",
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "storage.bytes",
      periodKey: "2026-09",
      value: 100,
    });

    const limited = await body(
      await getUsage(usageQueryRequest(owner.cookie, tenantId.toHexString(), { limit: "1" }))
    );
    expect(usageBodySchema.parse(limited).data).toHaveLength(1);
    const limitedPage = usagePageSchema.parse(limited.page);
    expect(limitedPage.limit).toBe(1);
    expect(limitedPage.hasMore).toBe(true);
    expect(limitedPage.nextCursor).not.toBeNull();

    const clamped = await body(
      await getUsage(usageQueryRequest(owner.cookie, tenantId.toHexString(), { limit: "5000" }))
    );
    expect(usageBodySchema.parse(clamped).data).toHaveLength(2);
    // §0.8's ceiling is 100, so `?limit=5000` is clamped, not rejected.
    expect(usagePageSchema.parse(clamped.page).limit).toBe(100);
  });

  it("L2 (RED): an unparseable `?cursor=` is a 400 `invalid_cursor` (§0.8)", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-bad-cursor",
    });
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });

    const response = await getUsage(
      usageQueryRequest(owner.cookie, tenantId.toHexString(), { cursor: "not-a-cursor" })
    );

    expect(response.status).toBe(400);
    expect((await errorEnvelope(response)).code).toBe("invalid_cursor");
  });

  it("L5 characterization: a decodable cursor whose `_id` half is not 24-hex answers 400 `invalid_cursor`", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-non-hex-cursor",
    });
    // A row in the cursor's own period, so a missing guard is a `500` from
    // `new ObjectId("zz")` rather than a quietly empty page.
    await seedCounter({
      tenantId: tenantId.toHexString(),
      entitlementKey: "events.active",
      periodKey: "2026-09",
      value: 5,
    });
    // `decodeCursor` only guarantees two non-empty strings, so this cursor is
    // decodable; the non-hex `i` half must still be refused at the read.
    const cursor = encodeCursor({ c: "2026-09", i: "zz" });

    const response = await getUsage(
      usageQueryRequest(owner.cookie, tenantId.toHexString(), { cursor })
    );

    expect(response.status).toBe(400);
    expect((await errorEnvelope(response)).code).toBe("invalid_cursor");
  });

  it("L6 characterization: a cursor whose period precedes every row answers an empty terminal page", async () => {
    const owner = await app.signIn(makeIdentity("op104-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op104-usage-stale-cursor",
    });
    // Both rows are newer than the cursor's period, so only the keyset `$or`
    // excludes them: an unfiltered or repeated page would serve them instead.
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
    const cursor = encodeCursor({ c: "2020-01", i: "0123456789abcdef01234567" });

    const response = await getUsage(
      usageQueryRequest(owner.cookie, tenantId.toHexString(), { cursor })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.data).toEqual([]);
    // A terminal page: nothing follows the end of the keyset.
    expect(payload.page).toEqual({ nextCursor: null, hasMore: false, limit: 40 });
  });
});
