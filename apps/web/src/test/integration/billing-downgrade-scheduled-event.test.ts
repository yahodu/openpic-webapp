import { Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as downgradePlan } from "@/app/api/v1/tenants/[tenantId]/billing/downgrade/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import type { OutboundMessage } from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import {
  seedNotificationTemplates,
  seedNotificationTypes,
} from "@/server/notifications/seed-notification-types";
import { seedPlans } from "@/server/plans/seed-plans";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";
import { periodKey } from "@/server/services/entitlements";
import { getPlatformSettings } from "@/server/settings/platform-settings";

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
 * Integration / contract — the downgrade request's outbox record and its
 * delivery to the billing contact (OP-101, contract §3.3; ADR-0978 §D1–§D5).
 *
 * The user story: *as a tenant owner I ask for a period-end downgrade and the
 * payer receives a confirmation of it, addressed to whoever asked.*
 *
 * The decision of record ([ADR-0978](../../../../../docs/adr/ADR-0978-op101-billing-downgrade-scheduled-event.md))
 * turns `POST /api/v1/tenants/{tenantId}/billing/downgrade` from a state-only
 * write into a producer, and the pin pack below is recorded in
 * [ADR-0979](../../../../../docs/adr/ADR-0979-op101-downgrade-scheduled-event-pins.md):
 *
 *   A1–A5  one `domain_events` row per accepted request, with the §D2 identity
 *          — `eventKey`, the workspace hex string, the caller as `actorRef`, the
 *          live subscription as `subjectRef`, exactly
 *          `{ fromPlanKey, toPlanKey, effectiveAt }` as `payload`, the §D2
 *          `dedupeKey`, `expireAt − occurredAt` derived from
 *          `platformSettings.retention.domainEventDays`, and
 *          `dispatch.notifications: "pending"`;
 *   B1–B5  dedupe: a repeated request for the same target and instant is `200`
 *          and leaves one row (and one event's worth of delivery), while a
 *          different target plan or a later effective date is a new intent and
 *          leaves a second row. `B5` submits the same intent **concurrently**
 *          rather than sequentially — two requests in flight at once — and
 *          answers `[200, 200]` with one event and one delivery, because the
 *          loser aborts on its write to the same subscription row and the
 *          retried callback then sees the winner's committed event (ADR-0983);
 *   C1–C2  atomicity (§D1): with the `domain_events` insert refused by the
 *          member-lane refusal-stub recipe (driver `code: 91`, **no**
 *          `TransientTransactionError` label, every other collection forwarded
 *          to the driver) the route answers `500 internal_error` and
 *          `subscriptions.scheduledChange` is unset; with the stub restored the
 *          same call answers `200` and writes exactly one row;
 *   D1–D3  delivery (§D3): the emitted row driven through the real
 *          `runNotificationFanOut` over the real seeded catalogue and the real
 *          `mongoRecipientRepository` — the requester who *is* the billing
 *          contact gets one in-app row and one rendered email, a different
 *          billing contact gets it and the requester does not, and a
 *          `system`-actor control on the same type still delivers;
 *   E1     no `audit_logs` row for the request (§D4) — the outbox is the home
 *          and the request must never grow an audit write.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/tenants/[tenantId]/billing/downgrade/route`
 *   - the existing `subscriptions.updateOne` (`scheduledChange`) and one
 *     `emitDomainEvent` call share **one** `withTransaction` callback, each
 *     write carrying `{ session }` — the shipped `upgrade/route.ts:314`/`:387`
 *     shape;
 *   - the emission is exactly ADR-0978 §D2:
 *     `{ eventKey: "billing.plan.downgrade_scheduled", tenantId: <hex string>,
 *        actorRef: { kind: "user", id: <caller hex> },
 *        subjectRef: { kind: "subscription", id: <live row hex> },
 *        payload: { fromPlanKey, toPlanKey, effectiveAt: <ISO 8601> },
 *        dedupeKey: `billing.plan.downgrade_scheduled:<subscriptionId>:<toPlanKey>:<effectiveAt ISO>` }`
 *     — `expireAt` and `dispatch.notifications` are `emitDomainEvent`'s own
 *     (they are pinned here so a hand-rolled insert cannot pass);
 *   - nothing else changes: `DELETE …/billing/scheduled-change` stays log-only
 *     (§D5) and the request writes no audit row (§D4).
 *
 * `@/server/notifications/fan-out`
 *   - the actor exclusion is **audience-scoped** (§D3): an id resolved from the
 *     `billing_contact` audience is not removed as the actor, because the
 *     billing contact is the payer and `provisioning.ts:162` makes the owner the
 *     contact by default. Measured on the shipped tree, a user-actor emission
 *     to that audience reaches nobody (ADR-0978 §Context P1).
 *
 * ## Red / green on arrival
 *
 * A1–A5, B1–B4, C1, C2, D1, D2 are RED: the route emits nothing today, so every
 * row and every delivery case measures `0`.
 *
 * D3 and E1 are green on arrival and are deliberate controls: D3 proves the
 * seeded type and its copy are live, so D1's red can only be the actor exclusion
 * (ADR-0978 §Context P2), and E1 characterizes §D4 — it must stay green, because
 * the answer to a red delivery case is never "add an audit row". C2 is the
 * anti-vacuity half of the atomicity pin: a route that never wrote a row could
 * otherwise satisfy C1's "nothing stored" for the wrong reason.
 *
 * ## Probe evidence (measured before handoff, then reverted)
 *
 * - near-fix (emit inside one `withTransaction` with D2's key + an
 *   audience-scoped billing-contact exemption in `resolveRecipients`):
 *   `Tests 15 passed (15)` — the pin set is satisfiable as written;
 * - emit moved **outside** the transaction, everything else unchanged:
 *   `Tests 1 failed | 14 passed (15)` with C1 the only red
 *   (`expected { toPlanKey: 'free', …(2) } to be null`) — the atomicity pin is
 *   load-bearing and specific;
 * - both production files restored byte-identically (`sha256` before == after).
 *
 * ## Assumptions recorded in the handoff
 *
 * - "The requester is the billing contact" is seeded the way
 *   `provisioning.ts:162` provisions a workspace (`billingContactUserId ===
 *   ownerUserId`), not by re-running tenant provisioning.
 * - The outbox row is drained by the real consumer (`runNotificationFanOut`)
 *   after the request; the request itself never sends, which is why
 *   `dispatch.notifications` is asserted `"pending"` in A5.
 * - `effectiveAt` is `currentPeriodEnd` (a fixed fixture instant), so the
 *   `dedupeKey` is exact rather than run-dependent.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The catalogue key §3.3 requires on an accepted request (ADR-0978 §D2). */
const EVENT_KEY = "billing.plan.downgrade_scheduled";

/** The plan the downgrade fixtures start from (tierRank 2). */
const SOURCE_PLAN_KEY = "professional";

/** The target plan of the §3.3 fixture body (tierRank 0). */
const TARGET_PLAN_KEY = "free";

/** The second target plan a re-schedule case moves to (tierRank 1). */
const OTHER_TARGET_PLAN_KEY = "starter";

/** The live row's period end — the instant a downgrade lands on. */
const PERIOD_END = new Date("2026-12-01T00:00:00.000Z");

/** The later period end a re-schedule case advances the live row to. */
const LATER_PERIOD_END = new Date("2026-12-31T00:00:00.000Z");

/** The `events.active` usage the downgrade consequences are computed against. */
const EVENTS_ACTIVE_USAGE = 5;

/**
 * The `usageCounters` period key the route resolves for a monthly entitlement,
 * derived at run time so the seeded counter matches the period of the request.
 */
const MONTHLY_PERIOD_KEY = periodKey("monthly", new Date());

/** Milliseconds in one day, for the retention-span assertion. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Better Auth user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** An error envelope as served. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** One stored outbox row, as this spec reads it (schema §18.3). */
interface StoredEvent {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: { readonly kind: string; readonly id: string };
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly expireAt: Date;
  readonly dispatch: {
    readonly notifications: string;
    readonly analytics: string;
    readonly queue: string;
  };
  readonly dedupeKey?: string;
  readonly [key: string]: unknown;
}

/** The live `subscriptions` fields this spec re-reads (schema §14.3). */
interface StoredSubscription {
  readonly scheduledChange?: {
    readonly toPlanKey?: unknown;
    readonly effectiveAt?: unknown;
    readonly reason?: unknown;
  } | null;
  readonly activePlanKey?: unknown;
  readonly [key: string]: unknown;
}

/** One stored in-app feed row (schema §19.4). */
interface StoredNotification {
  readonly tenantId?: unknown;
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly readAt?: unknown;
  readonly [key: string]: unknown;
}

/** One stored dispatch attempt (schema §19.5). */
interface StoredDispatch {
  readonly tenantId?: unknown;
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly channel?: unknown;
  readonly status?: unknown;
  readonly skipReason?: unknown;
  readonly subject?: unknown;
  readonly body?: unknown;
  readonly [key: string]: unknown;
}

/** One stored `audit_logs` row, as far as this spec reads it (§20.2). */
interface StoredAuditRow {
  readonly tenantId?: unknown;
  readonly action?: unknown;
  readonly [key: string]: unknown;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op101-downgrade-event" });
  // Both plans' entitlements and the target plan's tier are read from the
  // catalogue, so the four seeded tiers must be present (§14.1).
  await seedPlans({ db: app.db });
  // `domain_events_dedupe_unique` is what makes "a repeated request collapses"
  // observable at all, and §3.3's live-subscription slot is a partial index.
  await ensureIndexes(app.db);
  // The real routing catalogue and the real copy — the delivery cases must not
  // pass over a missing type or template.
  await seedNotificationTypes({ db: app.db });
  await seedNotificationTemplates({ db: app.db });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/**
 * Insert a tenant (schema §13.3) and return its id.
 *
 * `billingContactUserId` defaults to the owner, which is what
 * `provisioning.ts:162` stores when a workspace is created — the default the
 * delivery cases measure against.
 */
async function insertTenant(fields: {
  readonly slug: string;
  readonly ownerUserId: ObjectId;
  readonly billingContactUserId?: ObjectId;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP101 Downgrade Studio",
    status: "active",
    ownerUserId: fields.ownerUserId,
    billingContactUserId: fields.billingContactUserId ?? fields.ownerUserId,
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

/** Seed a workspace owned by `user`, with `user` as an active owner member. */
async function seedWorkspace(options: {
  readonly userId: ObjectId;
  readonly slug: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({ slug: options.slug, ownerUserId: options.userId });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: options.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  await updateProfile(options.userId, { primaryTenantId: tenantId });
  return tenantId;
}

/** Seed the workspace's live `subscriptions` row (schema §14.3) and return it. */
async function seedSubscription(options: {
  readonly tenantId: string;
  readonly planKey: string;
  readonly priceKey: string;
  readonly currentPeriodEnd: Date;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: options.planKey,
    subscribedPlanVersion: 1,
    activePlanKey: options.planKey,
    status: "active",
    priceKey: options.priceKey,
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
    currentPeriodEnd: options.currentPeriodEnd,
    nextChargeAt: options.currentPeriodEnd,
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
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  return _id;
}

/** Seed one `usageCounters` row (schema §14.2) for the current period. */
async function seedUsageCounter(options: {
  readonly tenantId: string;
  readonly entitlementKey: string;
  readonly value: number;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    tenantId: options.tenantId,
    entitlementKey: options.entitlementKey,
    periodKey: MONTHLY_PERIOD_KEY,
    value: options.value,
    updatedAt: new Date(),
  });
}

/**
 * Make a caller deliverable: a verified email and all-on, quiet-hours-free
 * preferences (so a delivery pin can fail only on the audience, never on the
 * recipient's own settings).
 */
async function seedDeliverableRecipient(userId: ObjectId): Promise<void> {
  await app.db
    .collection(USER_COLLECTION)
    .updateOne({ _id: userId }, { $set: { emailVerified: true } });
  await app.db.collection(COLLECTIONS.notificationPreferences).updateOne(
    { userId },
    {
      $set: {
        userId,
        global: { in_app: "on", email: "on", mobile: "on" },
        byType: {},
        byEvent: {},
        quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" },
        locale: "en-IN",
      },
    },
    { upsert: true }
  );
}

/** The §3.3 downgrade body (consequences acknowledged, as §3.3 requires). */
function downgradeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { targetPlanKey: TARGET_PLAN_KEY, acknowledgeConsequences: true, ...overrides };
}

/** A `POST …/billing/downgrade` request as the caller's session sends it. */
function downgradeRequest(
  tenantPath: string,
  cookie: string,
  payload: Record<string, unknown> = downgradeBody()
): Request {
  return new Request(new URL(`${TENANTS_PATH}/${tenantPath}/billing/downgrade`, APP_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/** The workspace's stored outbox rows, oldest first. */
async function outboxRows(tenantId: string): Promise<StoredEvent[]> {
  return app.db
    .collection<StoredEvent>(COLLECTIONS.domainEvents)
    .find({ tenantId })
    .sort({ occurredAt: 1 })
    .toArray();
}

/** The workspace's stored in-app feed rows (schema §19.4). */
async function notificationsOf(tenantId: string): Promise<StoredNotification[]> {
  return app.db
    .collection<StoredNotification>(COLLECTIONS.notifications)
    .find({ tenantId })
    .toArray();
}

/** The workspace's stored dispatch attempts (schema §19.5). */
async function dispatchesOf(tenantId: string): Promise<StoredDispatch[]> {
  return app.db.collection<StoredDispatch>(COLLECTIONS.dispatches).find({ tenantId }).toArray();
}

/** The workspace's stored `audit_logs` rows (§20.2). */
async function auditRows(tenantId: string): Promise<StoredAuditRow[]> {
  return app.db.collection<StoredAuditRow>(COLLECTIONS.auditLogs).find({ tenantId }).toArray();
}

/** The live `subscriptions` row, re-read after a request. */
async function storedSubscription(subscriptionId: ObjectId): Promise<StoredSubscription | null> {
  return app.db
    .collection<StoredSubscription>(COLLECTIONS.subscriptions)
    .findOne({ _id: subscriptionId });
}

/** What one drain of the outbox produced for the workspace (design §2, §5). */
interface DrainResult {
  readonly notifications: readonly StoredNotification[];
  readonly dispatches: readonly StoredDispatch[];
  readonly outbound: readonly OutboundMessage[];
}

/**
 * Drain the outbox with the **real** notification consumer.
 *
 * The catalogue, the templates and the recipient port are the shipped ones
 * (`SEED_NOTIFICATION_TYPES` / `SEED_NOTIFICATION_TEMPLATES`,
 * `mongoRecipientRepository`); only the outbound transport is in memory, so the
 * send is observable without a provider. The returned rows are the workspace's
 * own, filtered by `tenantId`, so a case's delivery cannot be satisfied by a
 * sibling case's rows.
 *
 * @param tenantId - The workspace the assertions belong to.
 * @returns The feed rows, dispatch rows and rendered email bodies.
 */
async function drainOutbox(tenantId: string): Promise<DrainResult> {
  const transport = memoryMessageTransport();
  await runNotificationFanOut({
    db: app.db,
    transport,
    recipients: mongoRecipientRepository(app.db),
    claimerId: "spec.op101-downgrade-event",
  });

  const notifications = await notificationsOf(tenantId);
  const dispatches = await dispatchesOf(tenantId);

  return { notifications, dispatches, outbound: transport.outbox };
}

/** A stored field as text, or `""` when the field is not a string. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The rendered email bodies one drain sent to one recipient. */
function emailsTo(messages: readonly OutboundMessage[], userId: ObjectId): string[] {
  return messages
    .filter((message) => message.channel === "email" && message.to.userId === userId.toHexString())
    .map((message) => message.text ?? message.html ?? message.subject ?? "");
}

/** The feed rows of the catalogue key under test, for one recipient. */
function feedRowsFor(rows: readonly StoredNotification[], userId: ObjectId): StoredNotification[] {
  return rows.filter(
    (row) => row.typeKey === EVENT_KEY && String(row.userId) === userId.toHexString()
  );
}

/** The dispatch rows of the catalogue key under test, for one recipient. */
function dispatchRowsFor(rows: readonly StoredDispatch[], userId: ObjectId): StoredDispatch[] {
  return rows.filter(
    (row) => row.typeKey === EVENT_KEY && String(row.userId) === userId.toHexString()
  );
}

/* -------------------------------------------------------------------------- */
/* A — one event per accepted request (ADR-0978 §D1, §D2)                     */
/* -------------------------------------------------------------------------- */

/**
 * Seed the §3.3 fixture every `A` case starts from: an owner-headed workspace
 * with a live `professional` subscription ending at `PERIOD_END`, and one
 * usage counter so the consequences are non-empty.
 */
async function seedDowngradeFixture(prefix: string): Promise<{
  readonly owner: SignedInUser;
  readonly tenantId: string;
  readonly subscriptionId: ObjectId;
}> {
  const owner = await app.signIn(makeIdentity(`${prefix}-owner`));
  const tenantObjectId = await seedWorkspace({ userId: owner.userId, slug: prefix });
  const tenantId = tenantObjectId.toHexString();
  const subscriptionId = await seedSubscription({
    tenantId,
    planKey: SOURCE_PLAN_KEY,
    priceKey: "professional-monthly-inr",
    currentPeriodEnd: PERIOD_END,
  });
  await seedUsageCounter({
    tenantId,
    entitlementKey: "events.active",
    value: EVENTS_ACTIVE_USAGE,
  });
  return { owner, tenantId, subscriptionId };
}

describe("POST /api/v1/tenants/{tenantId}/billing/downgrade — the outbox record (§D1, §D2)", () => {
  it("A1: answers 200 and leaves exactly one billing.plan.downgrade_scheduled row for the workspace", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-a1");

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventKey).toBe(EVENT_KEY);
    // The workspace is addressed by its hex **string** (§18.3's tenant index).
    expect(rows[0]?.tenantId).toBe(tenantId);
  });

  it("A2: records the caller as actorRef and the live subscription as subjectRef", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-a2");

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows[0]?.actorRef).toEqual({ kind: "user", id: owner.userId.toHexString() });
    expect(rows[0]?.subjectRef).toEqual({
      kind: "subscription",
      id: subscriptionId.toHexString(),
    });
  });

  it("A3: carries exactly the three documented payload fields", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-a3");

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    const rows = await outboxRows(tenantId);
    const payload = rows[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(["effectiveAt", "fromPlanKey", "toPlanKey"]);

    // `effectiveAt` is the stored schedule's own instant, as ISO 8601.
    const stored = await storedSubscription(subscriptionId);
    expect(stored?.scheduledChange?.effectiveAt).toEqual(PERIOD_END);
    expect(payload).toEqual({
      fromPlanKey: SOURCE_PLAN_KEY,
      toPlanKey: TARGET_PLAN_KEY,
      effectiveAt: PERIOD_END.toISOString(),
    });
  });

  it("A4: derives expireAt from platformSettings.retention.domainEventDays, not a literal", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-a4");
    const settings = await getPlatformSettings({ db: app.db, ttlMs: 0 });

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows).toHaveLength(1);
    const row = rows.at(0);
    // A literal `180` would pin today's default and hide a settings change;
    // the span is measured against the setting the emitter itself reads.
    expect(row?.expireAt).toBeInstanceOf(Date);
    expect(row?.occurredAt).toBeInstanceOf(Date);
    const span =
      ((row?.expireAt.getTime() ?? Number.NaN) - (row?.occurredAt.getTime() ?? Number.NaN)) /
      DAY_MS;
    expect(span).toBe(settings.retention.domainEventDays);
  });

  it("A5: addresses the row with the §D2 dedupeKey and leaves the notifications dispatch pending", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-a5");

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows[0]?.dedupeKey).toBe(
      `billing.plan.downgrade_scheduled:${subscriptionId.toHexString()}:${TARGET_PLAN_KEY}:${PERIOD_END.toISOString()}`
    );
    // The request never sends: the consumer owns delivery (design §5).
    expect(rows[0]?.dispatch.notifications).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* B — dedupe: one row per intent (ADR-0978 §D2)                              */
/* -------------------------------------------------------------------------- */

describe("POST …/billing/downgrade — the dedupe key separates intents (§D2)", () => {
  it("B1: answers 200 on a repeated identical request and leaves one row", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-b1");

    const first = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    const second = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await outboxRows(tenantId)).toHaveLength(1);
  });

  it("B2: a repeated identical request leaves one event's worth of notifications", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-b2");
    await seedDeliverableRecipient(owner.userId);

    await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    const drained = await drainOutbox(tenantId);

    // One intent, one confirmation: the second request must not re-announce it.
    expect(feedRowsFor(drained.notifications, owner.userId)).toHaveLength(1);
    const emails = dispatchRowsFor(drained.dispatches, owner.userId).filter(
      (dispatch) => dispatch.channel === "email"
    );
    expect(emails).toHaveLength(1);
  });

  it("B3: a request for a different target plan leaves a second row", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-b3");

    const toFree = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    const toStarter = await downgradePlan(
      downgradeRequest(
        tenantId,
        owner.cookie,
        downgradeBody({ targetPlanKey: OTHER_TARGET_PLAN_KEY })
      )
    );

    expect(toFree.status).toBe(200);
    expect(toStarter.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload.toPlanKey).sort()).toEqual([
      TARGET_PLAN_KEY,
      OTHER_TARGET_PLAN_KEY,
    ]);
  });

  it("B4: a later effective date leaves a second row instead of collapsing into the first", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-b4");

    const now = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    await app.db
      .collection(COLLECTIONS.subscriptions)
      .updateOne({ _id: subscriptionId }, { $set: { currentPeriodEnd: LATER_PERIOD_END } });
    const later = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(now.status).toBe(200);
    expect(later.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload.effectiveAt)).toEqual([
      PERIOD_END.toISOString(),
      LATER_PERIOD_END.toISOString(),
    ]);
  });

  it("B5: answers 200 to two concurrent identical requests and leaves one event and one delivery", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-b5");
    await seedDeliverableRecipient(owner.userId);

    // The same intent arriving twice at once, not a retry of a settled request:
    // both are in flight before either has answered. The loser's write to the
    // same `subscriptions` row conflicts before the emit, the driver retries the
    // callback, and the in-transaction re-read then sees the winner's committed
    // row — so the answer is two `200`s and one event, never a `500` and never a
    // second row (ADR-0983).
    const [first, second] = await Promise.all([
      downgradePlan(downgradeRequest(tenantId, owner.cookie)),
      downgradePlan(downgradeRequest(tenantId, owner.cookie)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await outboxRows(tenantId);
    expect(rows).toHaveLength(1);
    // The fixture's live row carries `PERIOD_END`, so `effectiveAt` — and with
    // it the §D2 key — is fixed by the seed rather than by a request clock.
    expect(rows[0]?.dedupeKey).toBe(
      `billing.plan.downgrade_scheduled:${subscriptionId.toHexString()}:${TARGET_PLAN_KEY}:${PERIOD_END.toISOString()}`
    );

    // One intent, one confirmation, however the two requests interleaved.
    const drained = await drainOutbox(tenantId);
    expect(feedRowsFor(drained.notifications, owner.userId)).toHaveLength(1);
    const sentEmails = dispatchRowsFor(drained.dispatches, owner.userId).filter(
      (dispatch) => dispatch.channel === "email" && dispatch.status === "sent"
    );
    expect(sentEmails).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* C — atomicity: the emit joins the schedule's transaction (ADR-0978 §D1)     */
/* -------------------------------------------------------------------------- */

describe("POST …/billing/downgrade — the emit and the schedule commit together (§D1)", () => {
  /** The driver's own `insertOne` argument tuple. */
  const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
    const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("expected Collection.prototype.insertOne to be a function");
    }
    return descriptor.value as typeof Collection.prototype.insertOne;
  })();

  type DriverInsertOneArgs = Parameters<typeof driverInsertOne>;

  /**
   * The error every refused `domain_events` insert carries.
   *
   * `code: 91` is a replica-set election and carries **no**
   * `TransientTransactionError` label, so `classifyMongoError` answers
   * `no-retry` and `withTransaction` rethrows it (the member lane's recipe): the route
   * sees one settled driver failure, not a retry loop.
   */
  const eventInsertError = Object.assign(new Error("injected failure: insertOne"), { code: 91 });

  /**
   * Refuse the `domain_events` insert: every `insertOne` against that
   * collection rejects, every other collection is forwarded to the driver, so
   * the state write in the same transaction still has its chance to commit —
   * which is exactly what an out-of-transaction emit would leave behind.
   *
   * @returns The undo; call it in a `finally` so the stub cannot leak.
   */
  function refuseDomainEventInserts(): () => void {
    const spy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(async function (
      this: Collection,
      ...args: DriverInsertOneArgs
    ) {
      if (this.collectionName === COLLECTIONS.domainEvents) {
        throw eventInsertError;
      }
      return driverInsertOne.call(this, ...args);
    } as never);
    return () => {
      spy.mockRestore();
    };
  }

  it("C1: answers 500 internal_error and leaves scheduledChange unset when the event insert is refused", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-c1");

    const restore = refuseDomainEventInserts();
    let refused: Response;
    try {
      refused = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    } finally {
      restore();
    }

    expect(refused.status).toBe(500);
    expect((await errorEnvelope(refused)).code).toBe("internal_error");

    // The whole write aborted: no schedule claims a change nobody was told
    // about, and no event describes a change that never stored.
    const stored = await storedSubscription(subscriptionId);
    expect(stored?.scheduledChange ?? null).toBeNull();
    expect(await outboxRows(tenantId)).toEqual([]);
  });

  it("C2: the same request answers 200 and writes one row once the driver recovers", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-c2");

    const accepted = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(accepted.status).toBe(200);
    const stored = await storedSubscription(subscriptionId);
    expect(stored?.scheduledChange).toMatchObject({
      toPlanKey: TARGET_PLAN_KEY,
      reason: "self_downgrade",
    });
    expect(await outboxRows(tenantId)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* D — delivery to the billing contact (ADR-0978 §D3)                         */
/* -------------------------------------------------------------------------- */

describe("billing.plan.downgrade_scheduled — the payer receives it (§D3)", () => {
  it("D1: delivers one in-app row and one rendered email when the requester is the billing contact", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-d1");
    await seedDeliverableRecipient(owner.userId);

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    expect(response.status).toBe(200);
    const drained = await drainOutbox(tenantId);

    // `provisioning.ts:162` makes the owner the billing contact, so the payer
    // and the actor are the same person — and the payer still hears about it.
    const feedRows = feedRowsFor(drained.notifications, owner.userId);
    expect(feedRows).toHaveLength(1);
    expect(textOf(feedRows[0]?.title).length).toBeGreaterThan(0);
    expect(textOf(feedRows[0]?.body).length).toBeGreaterThan(0);

    const emailRows = dispatchRowsFor(drained.dispatches, owner.userId).filter(
      (dispatch) => dispatch.channel === "email"
    );
    expect(emailRows).toHaveLength(1);
    expect(emailRows[0]?.status).toBe("sent");
    expect(emailRows[0]?.skipReason ?? null).toBeNull();
    const rendered = textOf(emailRows[0]?.body);
    // Rendered, not skipped: the stored body carries the copy, and exactly one
    // message left the transport carrying it.
    expect(rendered.length).toBeGreaterThan(0);
    expect(
      emailsTo(drained.outbound, owner.userId).filter((text) => text.includes(rendered))
    ).toHaveLength(1);
  });

  it("D2: delivers to a different billing contact and not to the requester", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-d2");
    const contact = await app.signIn(makeIdentity("op101-d2-billing-contact"));
    await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
      tenantId: new ObjectId(tenantId),
      userId: contact.userId,
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await app.db
      .collection(COLLECTIONS.tenants)
      .updateOne(
        { _id: new ObjectId(tenantId) },
        { $set: { billingContactUserId: contact.userId } }
      );
    // Both callers are deliverable, so the only reason the owner is left out is
    // the audience — not an unverified contact or a switched-off channel.
    await seedDeliverableRecipient(owner.userId);
    await seedDeliverableRecipient(contact.userId);

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));
    expect(response.status).toBe(200);
    const drained = await drainOutbox(tenantId);

    expect(feedRowsFor(drained.notifications, contact.userId)).toHaveLength(1);
    expect(feedRowsFor(drained.notifications, owner.userId)).toHaveLength(0);
    expect(
      dispatchRowsFor(drained.dispatches, contact.userId).filter(
        (dispatch) => dispatch.channel === "email" && dispatch.status === "sent"
      )
    ).toHaveLength(1);
    expect(dispatchRowsFor(drained.dispatches, owner.userId)).toHaveLength(0);
  });

  it("D3: a system-actor emission on the same type still delivers (control)", async () => {
    const { owner, tenantId, subscriptionId } = await seedDowngradeFixture("op101-d3");

    // The control's recipient is the workspace's billing contact, which the
    // fixture — like `provisioning.ts:162` — makes the owner.
    await seedDeliverableRecipient(owner.userId);

    await emitDomainEvent(
      {
        eventKey: EVENT_KEY,
        tenantId,
        actorRef: { kind: "system", id: "billing" },
        subjectRef: { kind: "subscription", id: subscriptionId.toHexString() },
        payload: {
          fromPlanKey: SOURCE_PLAN_KEY,
          toPlanKey: TARGET_PLAN_KEY,
          effectiveAt: PERIOD_END.toISOString(),
        },
      },
      { db: app.db }
    );

    const drained = await drainOutbox(tenantId);

    // The type, its copy and the transport are live: a system actor reaches the
    // billing contact, which is the behaviour D1 must extend to the payer who
    // acted.
    expect(feedRowsFor(drained.notifications, owner.userId)).toHaveLength(1);
    expect(
      dispatchRowsFor(drained.dispatches, owner.userId).filter(
        (dispatch) => dispatch.channel === "email" && dispatch.status === "sent"
      )
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* E — no audit row for the request (ADR-0978 §D4)                            */
/* -------------------------------------------------------------------------- */

describe("POST …/billing/downgrade — no audit_logs row for the request (§D4)", () => {
  it("E1: writes no subscription.downgrade_scheduled audit row", async () => {
    const { owner, tenantId } = await seedDowngradeFixture("op101-e1");

    const response = await downgradePlan(downgradeRequest(tenantId, owner.cookie));

    expect(response.status).toBe(200);
    // §D4: a cancellable intent is not a completed §20.2 fact, and the outbox
    // already carries the actor. A route that grows this write reds here — that
    // is the pin, not a gap to be "fixed".
    const rows = await auditRows(tenantId);
    expect(rows.map((row) => row.action)).not.toContain("subscription.downgrade_scheduled");
    expect(rows).toEqual([]);
  });
});
