import { Collection, ObjectId, type Document, type InsertOneOptions } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the seam the webhook inbox defers its projection
 * through (§10.1 step 5/6). The mock is hoisted above the module graph so the
 * inbox route binds to it on import; the default is inert, which is what lets a
 * case run the deferred work itself — the pattern `provider-webhook-inbox.test.ts`
 * and `provider-webhook-projection-failure.test.ts` established.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as billingReconcileRoute } from "@/app/api/v1/internal/cron/billing-reconcile/route";
import { POST as dunningRoute } from "@/app/api/v1/internal/cron/dunning/route";
import { POST as dunningRemindersRoute } from "@/app/api/v1/internal/cron/dunning-reminders/route";
import { POST as renewalRemindersRoute } from "@/app/api/v1/internal/cron/renewal-reminders/route";
import { POST as scheduledPlanChangesRoute } from "@/app/api/v1/internal/cron/scheduled-plan-changes/route";
import { POST as webhookProjectionSweepRoute } from "@/app/api/v1/internal/cron/webhook-projection-sweep/route";
import { POST as receiveWebhook } from "@/app/api/v1/webhooks/[provider]/route";
import {
  billingReconcileJob,
  dunningJob,
  dunningRemindersJob,
  renewalRemindersJob,
  scheduledPlanChangesJob,
  webhookProjectionSweepJob,
} from "@/server/billing/billing-cron-jobs";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { cronResultSchema, type CronJob, type CronResult } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import type { ProviderRef, SubscriptionStatus } from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";
import { fixedClock, systemClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import {
  makeCashfreeSubscriptionStatusResponse,
  makeCashfreeWebhookBody,
  makeCashfreeWebhookHeaders,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { server } from "./setup";

/**
 * Integration / contract — the billing cron jobs (OP-111 RED, contract §10.2,
 * §10.2.1; schema §14.3; ADR-0500).
 *
 * The user story: *as the platform I want billing crons that downgrade after
 * grace, remind on schedule and heal missed webhooks so that billing is correct
 * and content is never touched.*
 *
 * Six jobs are in scope (§10.2): `dunning`, `dunning-reminders`,
 * `renewal-reminders`, `scheduled-plan-changes`, `billing-reconcile` and
 * `webhook-projection-sweep`. Every one of them is bounded, idempotent and
 * conditional-update only, and the dunning worker carries invariant C6: it may
 * write **only** `subscriptions`, and therefore may never touch user content.
 *
 *   - **I1** (C6, §10.2.1) — a dunning run over a tenant that owns events,
 *     images and assets changes **only** `subscriptions` (besides the
 *     `domain_events` outbox every job writes), proven by a whole-database diff;
 *   - **I2** (§10.2 rule 1) — two concurrent dunning runs transition once;
 *     the loser matches zero documents and is a no-op, never corruption;
 *   - **I3** (§10.2 `dunning-reminders`) — running the reminders twice on grace
 *     day 5 emits exactly one `billing.grace.reminder`;
 *   - **I4** (§10.2 `billing-reconcile`) — a subscription stuck `incomplete`
 *     for over an hour is fetched from the provider and corrected to `active`;
 *   - **I5** (§10.2 `webhook-projection-sweep`) — an unprocessed inbox row older
 *     than 60 s is re-projected, healing the missed webhook;
 *   - **I6** (§10.2 rule 2) — `?limit=1` with three due subscriptions reports
 *     `hasMore: true` so the scheduler re-invokes.
 *
 * ## Contract expected of the implementation
 *
 * - Job modules under `@/server/billing/jobs/**` and one composition module
 *   `@/server/billing/billing-cron-jobs` exporting the six `CronJob`s named
 *   `dunningJob`, `dunningRemindersJob`, `renewalRemindersJob`,
 *   `scheduledPlanChangesJob`, `billingReconcileJob` and
 *   `webhookProjectionSweepJob` (the `@/server/services/notification-cron-jobs`
 *   shape: `defineCronJob` declarations whose `run` closes over `getDb()`).
 * - One route module per job under `app/api/v1/internal/cron/<job-name>/route.ts`
 *   exporting `POST`, guarded by the internal HMAC stage and answering the §10.2
 *   `CronResult` (the `run-cron-route` wiring).
 * - Every transition is a conditional `findOneAndUpdate` whose filter carries
 *   the prior state, so a lost race writes nothing and the loser reports the
 *   row as `skipped`.
 * - `subscriptions.statusHistory` gains one entry per transition, and each
 *   transition emits its §10.2 domain event (`billing.subscription.downgraded`,
 *   `billing.grace.reminder`) with the subscription as its subject.
 * - `billing.grace.reminder` carries a `mobile` boolean in its payload, `true`
 *   only on the final schedule day (§10.2: "mobile only on day 13").
 * - `dunning.remindersSent` is the reminder idempotency token — the `d{day}` key
 *   (`resolveDueReminderDay`'s return, pinned by `dunning-reminders.test.ts`).
 *
 * ## Assumptions recorded in the handoff (ADR-0500)
 *
 * - The `webhook-projection-sweep` case reuses the OP-108 failure seam: the
 *   ledger collection is created with a validator no document can satisfy, so a
 *   real signed webhook's deferred projection fails **after** the provider was
 *   acknowledged and the inbox row is left `processedAt: null` — exactly the
 *   state the sweep exists for. The case then repairs the ledger and runs the
 *   sweep. No stub reaches into the projection.
 * - The sweep's 60 s grace is pinned by its complement: a freshly received
 *   unprocessed row is left alone.
 * - The dunning job's C6 diff admits `domain_events` because §10.2 rule 3
 *   requires the job to write its notification intent to the outbox; the pin
 *   asserts the **exact** set of changed collections, so any other write (a
 *   counter, a ledger row, a content row) fails the assertion by name.
 * - The provider-call shape for reconciliation is the shipped Cashfree adapter's
 *   `GET {base}/pg/subscriptions/{id}` (§11.1) behind MSW; the 1 h window is
 *   driven with both `createdAt` and `updatedAt` set, so the pin is about the
 *   window rather than which stamp the implementation reads.
 * - `I7` is a derived case, not one of the card's six: §10.2's
 *   `scheduled-plan-changes` row applies and clears a due `scheduledChange`, and
 *   the card's own user story names scheduled changes.
 */

/** The `?limit=`-free default of every job in this suite. */
const NO_LIMIT: string | null = null;

/** The payments selection this suite drives the reconcile/sweep seams with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The instant every clock-injected case is evaluated at. */
const NOW = new Date("2026-10-25T12:00:00.000Z");

/** An instant a day earlier — the seed stamp of rows no case expects to move. */
const SEEDED_AT = new Date("2026-09-01T00:00:00.000Z");

/** The vendor subscription id the reconcile fixture and the seeded ref share. */
const VENDOR_SUBSCRIPTION_ID = "sub_op111_001";

/** The Cashfree status endpoint the reconcile job fetches (§11.1). */
const CASHFREE_STATUS_URL = "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId";

/** The subscription ref a seeded row must carry for a fetch/webhook to match it. */
const SUBSCRIPTION_REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: VENDOR_SUBSCRIPTION_ID,
};

/** How long a `past_due` row's grace has been over when dunning should catch it. */
const GRACE_ENDED_MS_AGO = 60_000;

/**
 * A collection validator no document can satisfy.
 *
 * The driver stamps `_id` on every insert, so `{_id: {$exists: false}}` refuses
 * every write: the ledger "cannot accept money" and a webhook projection has to
 * cope — which is how this suite produces a genuinely unprocessed inbox row.
 */
const ALWAYS_REJECT: Readonly<Record<string, unknown>> = { _id: { $exists: false } };

/** The `subscriptions` row this suite reads back (schema §14.3, as stored). */
interface StoredSubscription {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly activePlanKey: string;
  readonly mandateStatus: string;
  readonly gracePeriodEndsAt: Date | null;
  readonly pendingDueMinor: number;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAt: Date | null;
  readonly scheduledChange: Record<string, unknown> | null;
  readonly statusHistory: readonly Record<string, unknown>[];
  readonly dunning: {
    readonly attemptCount: number;
    readonly remindersSent: readonly string[];
    readonly nextReminderAt: Date | null;
  };
}

/** A stored `domain_events` outbox row, narrowed to what the pins inspect. */
interface StoredDomainEvent {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
}

/** A stored `providerWebhookEvents` row, narrowed to what the pins inspect. */
interface StoredInboxRow {
  readonly _id: ObjectId;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processResult: string | null;
  readonly processError: string | null;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op111-billing-crons", env: PAYMENTS_ENV });
  // The ledger starts rejecting every write, so a webhook projection fails
  // deterministically and leaves the inbox row unprocessed (I5's precondition).
  await app.db.createCollection(COLLECTIONS.billingTransactions, {
    validator: { ...ALWAYS_REJECT },
    validationLevel: "strict",
    validationAction: "error",
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  afterMock.mockClear();
  // Re-poison the ledger: the sweep case lifts it, and no case may depend on
  // which ran first. (Deletes ignore validation, so the cleared ledger is fine.)
  await app.db.command({
    collMod: COLLECTIONS.billingTransactions,
    validator: { ...ALWAYS_REJECT },
  });
  // One booted app serves the whole file, and the `domain_events` outbox's
  // unique `dedupeKey` plus the seeded refs would otherwise leak between cases.
  await Promise.all([
    app.db.collection(COLLECTIONS.subscriptions).deleteMany({}),
    app.db.collection(COLLECTIONS.domainEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.auditLogs).deleteMany({}),
    app.db.collection(COLLECTIONS.providerWebhookEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.billingTransactions).deleteMany({}),
    app.db.collection(COLLECTIONS.tenants).deleteMany({}),
    app.db.collection(COLLECTIONS.tenantMembers).deleteMany({}),
    app.db.collection(COLLECTIONS.events).deleteMany({}),
    app.db.collection(COLLECTIONS.eventImages).deleteMany({}),
    app.db.collection(COLLECTIONS.mediaAssets).deleteMany({}),
    app.db.collection(COLLECTIONS.faceMatches).deleteMany({}),
    app.db.collection(COLLECTIONS.attendeeEventProfiles).deleteMany({}),
  ]);
  // The settings singleton is cached process-wide; a fresh read is what makes
  // the documented defaults (14-day grace, `[1, 5, 7, 11, 13]`) apply here.
  invalidatePlatformSettings();
});

/** Run one billing cron job with an explicit clock, exactly as its route does. */
async function runJob(
  job: CronJob,
  options: { readonly limit?: string | null; readonly now?: Date } = {}
): Promise<CronResult> {
  return job.run({
    requestedLimit: options.limit ?? NO_LIMIT,
    clock: options.now === undefined ? systemClock : fixedClock(options.now),
    logger: getLogger(),
  });
}

/** Insert an active tenant (schema §13.3) and return its hex id. */
async function seedTenant(slug: string): Promise<string> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP111 Studio",
    status: "active",
    ownerUserId: new ObjectId(),
    billingContactUserId: new ObjectId(),
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
    createdAt: SEEDED_AT,
    schemaVersion: 1,
  });
  return _id.toHexString();
}

/** The fields a case may vary on the seeded `subscriptions` row. */
interface SubscriptionSeed {
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly activePlanKey?: string;
  readonly gracePeriodEndsAt?: Date | null;
  readonly nextChargeAt?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly remindersSent?: readonly string[];
  readonly scheduledChange?: Record<string, unknown> | null;
  readonly refs?: readonly ProviderRef[];
  readonly pendingDueMinor?: number;
  readonly createdAt?: Date;
}

/** Seed one `subscriptions` row (schema §14.3) and return its id. */
async function seedSubscription(seed: SubscriptionSeed): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: seed.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: seed.activePlanKey ?? "starter",
    status: seed.status,
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    currentPeriodStart: SEEDED_AT,
    currentPeriodEnd: seed.currentPeriodEnd ?? null,
    nextChargeAt: seed.nextChargeAt ?? null,
    gracePeriodEndsAt: seed.gracePeriodEndsAt ?? null,
    pendingDueMinor: seed.pendingDueMinor ?? 0,
    currency: "INR",
    dunning: {
      attemptCount: 0,
      lastAttemptAt: null,
      remindersSent: [...(seed.remindersSent ?? [])],
      nextReminderAt: null,
    },
    cancelAt: seed.cancelAt ?? null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: seed.scheduledChange ?? null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [...(seed.refs ?? [])],
    createdAt: seed.createdAt ?? SEEDED_AT,
    updatedAt: SEEDED_AT,
  });
  return _id;
}

/**
 * Seed a subscription whose grace period ended {@link GRACE_ENDED_MS_AGO} ago —
 * the state `dunning` exists to catch.
 */
async function seedPastGrace(tenantId: string): Promise<ObjectId> {
  return seedSubscription({
    tenantId,
    status: "past_due",
    gracePeriodEndsAt: new Date(NOW.getTime() - GRACE_ENDED_MS_AGO),
    pendingDueMinor: 49_900,
  });
}

/**
 * The `gracePeriodEndsAt` that puts {@link NOW} on grace day `day` for the
 * documented 14-day grace (day 1 is the day the window opened).
 *
 * @param day - The 1-based grace day.
 * @returns The matching `gracePeriodEndsAt` (always in the future at `NOW`).
 */
function graceEndingOnDay(day: number): Date {
  const startedAt = new Date(NOW.getTime() - (day - 1) * 86_400_000 - 12 * 3_600_000);
  return new Date(startedAt.getTime() + 14 * 86_400_000);
}

/** Seed the content a tenant owns — the rows C6 forbids a dunning job to touch. */
async function seedTenantContent(tenantId: string): Promise<void> {
  const eventId = new ObjectId();
  await Promise.all([
    app.db.collection(COLLECTIONS.events).insertOne({
      _id: eventId,
      tenantId,
      slug: "op111-gala",
      name: "OP111 Gala",
      status: "active",
      createdAt: SEEDED_AT,
    }),
    app.db.collection(COLLECTIONS.eventImages).insertOne({
      _id: new ObjectId(),
      tenantId,
      eventId,
      mediaAssetId: new ObjectId(),
      status: "indexed",
      createdAt: SEEDED_AT,
    }),
    app.db.collection(COLLECTIONS.mediaAssets).insertOne({
      _id: new ObjectId(),
      tenantId,
      eventId,
      kind: "image",
      refCount: 1,
      createdAt: SEEDED_AT,
    }),
    app.db.collection(COLLECTIONS.faceMatches).insertOne({
      _id: new ObjectId(),
      tenantId,
      eventId,
      score: 0.91,
      createdAt: SEEDED_AT,
    }),
    app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
      _id: new ObjectId(),
      tenantId,
      eventId,
      matchCount: 1,
      createdAt: SEEDED_AT,
    }),
  ]);
}

/**
 * Every collection's documents, canonicalised and keyed by collection name.
 *
 * Dates serialize as ISO strings and ObjectIds as hex, so an unchanged document
 * produces an identical string and any write at all shows up as a difference.
 */
async function snapshotDatabase(): Promise<Map<string, string>> {
  const names = (await app.db.listCollections().toArray())
    .map((collection) => collection.name)
    .sort();
  const snapshot = new Map<string, string>();
  for (const name of names) {
    const docs: Document[] = await app.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    snapshot.set(name, JSON.stringify(docs));
  }
  return snapshot;
}

/** The collection names whose contents differ between two snapshots. */
function changedCollections(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.filter((name) => before.get(name) !== after.get(name));
}

/** Read a subscription back, failing loudly when the row vanished. */
async function readSubscription(subscriptionId: ObjectId): Promise<StoredSubscription> {
  const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
  if (row === null) {
    throw new Error(`subscription ${subscriptionId.toHexString()} not found`);
  }
  return row as unknown as StoredSubscription;
}

/** The tenant's outbox rows, oldest first. */
async function domainEventsFor(tenantId: string): Promise<StoredDomainEvent[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ tenantId })
    .sort({ occurredAt: 1 })
    .toArray();
  return rows as unknown as StoredDomainEvent[];
}

/** The most recently received inbox row, failing loudly when there is none. */
async function latestInboxRow(): Promise<StoredInboxRow> {
  const rows = await app.db
    .collection(COLLECTIONS.providerWebhookEvents)
    .find({})
    .sort({ receivedAt: 1 })
    .toArray();
  const last = rows.at(-1);
  if (last === undefined) {
    throw new Error("no providerWebhookEvents row was written");
  }
  return last as unknown as StoredInboxRow;
}

/** A `POST` to the Cashfree inbox carrying a correctly signed raw body. */
function signedWebhook(rawBody: string): Request {
  const headers = makeCashfreeWebhookHeaders(
    TEST_CASHFREE_WEBHOOK_SECRET,
    String(Date.now()),
    rawBody
  );
  return new Request(new URL("/api/v1/webhooks/cashfree", APP_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

/** A `SUBSCRIPTION_PAYMENT_SUCCESS` body addressing `subscriptionId`. */
function paymentSucceededBody(subscriptionId: string, paymentId: string): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
    subscriptionDetails: { subscription_id: subscriptionId, subscription_status: "ACTIVE" },
    eventTime: new Date(Date.now() - 60_000).toISOString(),
    extraData: {
      payment_id: `ab-${paymentId}`,
      cf_payment_id: paymentId,
      payment_type: "CHARGE",
      payment_status: "SUCCESS",
      payment_amount: 499,
      payment_currency: "INR",
    },
  });
}

/** Run every callback the inbox route deferred, in the order it scheduled them. */
async function drainDeferredProjections(): Promise<void> {
  const callbacks = afterMock.mock.calls.map((call) => call[0]);
  afterMock.mockClear();
  for (const callback of callbacks) {
    await callback();
  }
}

/** Answer every provider status fetch, counting the calls. */
function countProviderStatusCalls(): { readonly calls: () => number } {
  let calls = 0;
  server.use(
    http.get(CASHFREE_STATUS_URL, () => {
      calls += 1;
      return HttpResponse.json(
        makeCashfreeSubscriptionStatusResponse({ subscription_id: VENDOR_SUBSCRIPTION_ID })
      );
    })
  );
  return { calls: () => calls };
}

/** A `POST` to an internal cron route presenting the scheduler's bearer. */
function cronRequest(path: string): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers: { authorization: `Bearer ${getConfig().cron.secret}` },
  });
}

describe("invariant C6 — dunning never touches user content (I1)", () => {
  it("I1: a dunning run over a tenant with content changes only subscriptions (+ domain_events)", async () => {
    // Arrange — a tenant that owns events, images and assets, plus a due row.
    const tenantId = await seedTenant("op111-c6");
    const subscriptionId = await seedPastGrace(tenantId);
    await seedTenantContent(tenantId);
    const before = await snapshotDatabase();

    // Act
    const result = await runJob(dunningJob, { now: NOW });

    // Assert — the whole-database diff is the pin: any write outside the
    // permitted collections would be named by this assertion.
    //
    // ADR-0975 §D6 amends this list **deliberately**: the dunning transition now
    // also writes its `subscription.downgraded` row (§20.2, §9.1), so
    // `audit_logs` is admitted. The invariant C6 states — "dunning never touches
    // user content" — stays proven **structurally**, not textually: the diff
    // names every changed collection, and the six content collections (`events`,
    // `eventImages`, `mediaAssets`, `imageFaces`, `faceMatches`,
    // `attendeeEventProfiles`) must stay absent from it. `audit_logs` holds no
    // reference into any content collection and can delete nothing, so admitting
    // it cannot hide a C6 regression.
    const after = await snapshotDatabase();
    expect(changedCollections(before, after)).toEqual([
      "audit_logs",
      "domain_events",
      "subscriptions",
    ]);

    // …and the run really did the transition it is allowed to do.
    expect(result).toMatchObject({ scanned: 1, affected: 1, hasMore: false });
    const row = await readSubscription(subscriptionId);
    expect(row).toMatchObject({ status: "downgraded", activePlanKey: "free" });
    expect(row.statusHistory).toHaveLength(1);
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.subscription.downgraded"]);
    expect(events[0]?.subjectRef).toEqual({
      kind: "subscription",
      id: subscriptionId.toHexString(),
    });
  });
});

describe("concurrency — conditional single-document updates (I2)", () => {
  it("I2: two concurrent dunning runs transition once and leave one no-op", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-concurrent");
    const subscriptionId = await seedPastGrace(tenantId);

    // Act — both runs see the same due row; the loser's conditional update
    // matches zero documents.
    const [first, second] = await Promise.all([
      runJob(dunningJob, { now: NOW }),
      runJob(dunningJob, { now: NOW }),
    ]);

    // Assert
    expect([first.affected, second.affected].sort((left, right) => left - right)).toEqual([0, 1]);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "downgraded" });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.subscription.downgraded"]);
  });
});

describe("dunning reminders are idempotent under retries (I3)", () => {
  it("I3: running the reminders twice on grace day 5 emits one reminder", async () => {
    // Arrange — day 1's reminder already went out; today is day 5.
    const tenantId = await seedTenant("op111-reminders");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: graceEndingOnDay(5),
      pendingDueMinor: 49_900,
      remindersSent: ["d1"],
    });

    // Act
    const first = await runJob(dunningRemindersJob, { now: NOW });
    const second = await runJob(dunningRemindersJob, { now: NOW });

    // Assert — one reminder, and the second run is a no-op.
    expect(first.affected).toBe(1);
    expect(second.affected).toBe(0);
    expect(await readSubscription(subscriptionId)).toMatchObject({
      dunning: { remindersSent: ["d1", "d5"] },
    });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.grace.reminder"]);
    expect(events[0]?.payload).toMatchObject({ day: 5, mobile: false });
  });

  it("I3: the final schedule day asks for a mobile reminder", async () => {
    // Arrange — day 13 is the last day of the documented `[1, 5, 7, 11, 13]`.
    const tenantId = await seedTenant("op111-reminders-final");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: graceEndingOnDay(13),
      pendingDueMinor: 49_900,
      remindersSent: ["d1", "d5", "d7", "d11"],
    });

    // Act
    const result = await runJob(dunningRemindersJob, { now: NOW });

    // Assert
    expect(result.affected).toBe(1);
    expect(await readSubscription(subscriptionId)).toMatchObject({
      dunning: { remindersSent: ["d1", "d5", "d7", "d11", "d13"] },
    });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.grace.reminder"]);
    expect(events[0]?.payload).toMatchObject({ day: 13, mobile: true });
  });
});

describe("billing reconciliation heals a stuck subscription (I4)", () => {
  it("I4: a subscription stuck incomplete for over an hour is corrected to active", async () => {
    // Arrange — the provider says the mandate is live; we still think it never
    // activated, because the activation webhook was missed.
    const tenantId = await seedTenant("op111-reconcile");
    const stuckSince = new Date(NOW.getTime() - 2 * 3_600_000);
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince,
    });
    await app.db
      .collection(COLLECTIONS.subscriptions)
      .updateOne({ _id: subscriptionId }, { $set: { updatedAt: stuckSince } });
    const provider = countProviderStatusCalls();

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert — one explicit provider fetch, the drift corrected, and no
    // manual-review alert for a drift we could resolve ourselves.
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      mandateStatus: "active",
    });
    expect(await domainEventsFor(tenantId)).toEqual([]);
  });

  it("I4: a subscription stuck incomplete for less than an hour is left for the webhook", async () => {
    // Arrange — inside the §10.2 window, so the job must not reach the provider.
    const tenantId = await seedTenant("op111-reconcile-fresh");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      refs: [SUBSCRIPTION_REF],
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const provider = countProviderStatusCalls();

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(0);
    expect(result).toMatchObject({ scanned: 0, affected: 0 });
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "incomplete" });
  });
});

describe("the webhook projection sweep heals a missed webhook (I5)", () => {
  it("I5: an unprocessed event older than 60 seconds is re-projected", async () => {
    // Arrange — a signed payment-success webhook whose projection fails because
    // the ledger refuses the write, leaving the inbox row unprocessed.
    const tenantId = await seedTenant("op111-sweep");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: new Date(NOW.getTime() - GRACE_ENDED_MS_AGO),
      pendingDueMinor: 49_900,
      refs: [SUBSCRIPTION_REF],
    });
    const response = await receiveWebhook(
      signedWebhook(paymentSucceededBody(VENDOR_SUBSCRIPTION_ID, "49914528"))
    );
    expect(response.status).toBe(200);
    await drainDeferredProjections();
    const failed = await latestInboxRow();
    expect(failed).toMatchObject({ processedAt: null, processResult: "error" });

    // Act — the operator repairs the ledger and the row ages past the sweep's
    // 60 s grace, so the next sweep retries it.
    await app.db.command({ collMod: COLLECTIONS.billingTransactions, validator: {} });
    await app.db
      .collection(COLLECTIONS.providerWebhookEvents)
      .updateOne({ _id: failed._id }, { $set: { receivedAt: new Date(Date.now() - 5 * 60_000) } });
    const result = await runJob(webhookProjectionSweepJob);

    // Assert — the subscription is healed and the row is settled.
    expect(result).toMatchObject({ affected: 1, errors: 0 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      pendingDueMinor: 0,
      gracePeriodEndsAt: null,
    });
    expect(await latestInboxRow()).toMatchObject({ processResult: "applied" });
    expect((await latestInboxRow()).processedAt).toBeInstanceOf(Date);
    expect((await domainEventsFor(tenantId)).map((event) => event.eventKey)).toContain(
      "billing.payment.succeeded"
    );
  });

  it("I5: an unprocessed event received less than 60 seconds ago waits for the next sweep", async () => {
    // Arrange — same failure, but the row is fresh: the sweep's grace exists so
    // an in-flight projection is never raced.
    const tenantId = await seedTenant("op111-sweep-fresh");
    await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: new Date(NOW.getTime() - GRACE_ENDED_MS_AGO),
      pendingDueMinor: 49_900,
      refs: [SUBSCRIPTION_REF],
    });
    await receiveWebhook(signedWebhook(paymentSucceededBody(VENDOR_SUBSCRIPTION_ID, "49914529")));
    await drainDeferredProjections();
    const failed = await latestInboxRow();
    expect(failed).toMatchObject({ processedAt: null, processResult: "error" });

    // Act
    const result = await runJob(webhookProjectionSweepJob);

    // Assert
    expect(result).toMatchObject({ affected: 0 });
    expect(await latestInboxRow()).toMatchObject({ processedAt: null, processResult: "error" });
  });
});

describe("every job is bounded and reports hasMore (I6)", () => {
  it("I6: limit=1 with three due subscriptions reports hasMore and drains on the next run", async () => {
    // Arrange — three workspaces past grace (the cron is cross-tenant).
    await seedPastGrace(await seedTenant("op111-limit-a"));
    await seedPastGrace(await seedTenant("op111-limit-b"));
    await seedPastGrace(await seedTenant("op111-limit-c"));

    // Act
    const bounded = await runJob(dunningJob, { limit: "1", now: NOW });
    const remainder = await runJob(dunningJob, { now: NOW });

    // Assert
    expect(bounded).toMatchObject({ scanned: 1, affected: 1, hasMore: true });
    expect(remainder).toMatchObject({ affected: 2, hasMore: false });
    expect(
      await app.db.collection(COLLECTIONS.subscriptions).countDocuments({ status: "downgraded" })
    ).toBe(3);
  });
});

describe("renewal reminders fire once per cycle (I8, derived)", () => {
  it("I8: running the renewal reminders twice before a period end emits one reminder", async () => {
    // Arrange — a healthy workspace whose renewal is two days away.
    const tenantId = await seedTenant("op111-renewals");
    const currentPeriodEnd = new Date(NOW.getTime() + 2 * 86_400_000);
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      nextChargeAt: currentPeriodEnd,
      currentPeriodEnd,
    });

    // Act
    const first = await runJob(renewalRemindersJob, { now: NOW });
    const second = await runJob(renewalRemindersJob, { now: NOW });

    // Assert — the per-cycle token is the job's idempotency guard, so the second
    // daily run of the same cycle changes nothing and emits nothing.
    expect(first.affected).toBe(1);
    expect(second.affected).toBe(0);
    expect(await readSubscription(subscriptionId)).toMatchObject({
      dunning: { remindersSent: [`renewal:${currentPeriodEnd.toISOString()}`] },
    });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.renewal.upcoming"]);
  });
});

describe("scheduled plan changes are applied by the cron (I7, derived)", () => {
  it("I7: a due scheduled change is applied and cleared", async () => {
    // Arrange — a self-downgrade whose effective instant has passed.
    const tenantId = await seedTenant("op111-scheduled");
    const scheduledChange = {
      toPlanKey: "free",
      effectiveAt: new Date(NOW.getTime() - 3_600_000),
      reason: "self_downgrade",
    };
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      activePlanKey: "starter",
      scheduledChange,
    });

    // Act
    const result = await runJob(scheduledPlanChangesJob, { now: NOW });

    // Assert
    expect(result).toMatchObject({ affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      activePlanKey: "free",
      scheduledChange: null,
    });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual(["billing.plan.downgrade_applied"]);
    expect(events[0]?.payload).toMatchObject({ toPlanKey: "free" });
  });

  it("I7: a scheduled change that is not due yet is left alone", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-scheduled-later");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      activePlanKey: "starter",
      scheduledChange: {
        toPlanKey: "free",
        effectiveAt: new Date(NOW.getTime() + 3_600_000),
        reason: "self_downgrade",
      },
    });

    // Act
    const result = await runJob(scheduledPlanChangesJob, { now: NOW });

    // Assert
    expect(result).toMatchObject({ affected: 0 });
    expect(await readSubscription(subscriptionId)).toMatchObject({ activePlanKey: "starter" });
    expect(await domainEventsFor(tenantId)).toEqual([]);
  });
});

describe("every billing cron route answers the §10.2 envelope", () => {
  const ROUTES: readonly {
    readonly name: string;
    readonly path: string;
    readonly post: (request: Request) => Promise<Response>;
  }[] = [
    {
      name: "dunning",
      path: "/api/v1/internal/cron/dunning",
      post: dunningRoute,
    },
    {
      name: "dunning-reminders",
      path: "/api/v1/internal/cron/dunning-reminders",
      post: dunningRemindersRoute,
    },
    {
      name: "renewal-reminders",
      path: "/api/v1/internal/cron/renewal-reminders",
      post: renewalRemindersRoute,
    },
    {
      name: "scheduled-plan-changes",
      path: "/api/v1/internal/cron/scheduled-plan-changes",
      post: scheduledPlanChangesRoute,
    },
    {
      name: "billing-reconcile",
      path: "/api/v1/internal/cron/billing-reconcile",
      post: billingReconcileRoute,
    },
    {
      name: "webhook-projection-sweep",
      path: "/api/v1/internal/cron/webhook-projection-sweep",
      post: webhookProjectionSweepRoute,
    },
  ];

  it.each(ROUTES)(
    "$name runs behind the internal guard and returns its CronResult",
    async (route) => {
      // Act
      const response = await route.post(cronRequest(route.path));

      // Assert
      expect(response.status).toBe(200);
      expect(cronResultSchema.parse(await response.json())).toMatchObject({ job: route.name });
    }
  );

  it("a billing cron route refuses a caller with no credential", async () => {
    // Act
    const response = await dunningRoute(
      new Request(new URL("/api/v1/internal/cron/dunning", APP_ORIGIN), { method: "POST" })
    );

    // Assert
    expect(response.status).toBe(401);
  });
});

/**
 * OP-101 / ADR-0975 (§D2–§D6) — the `subscription.downgraded` `auditLogs` row a
 * billing transition writes, and the request that must not write one.
 *
 * The gap this block pins: schema §20.2 declares
 * `action: "subscription.downgraded"`, `actor.kind: "system"`, `target.kind:
 * "subscription"` and a `reason`, and §9.1 says every admin mutation is recorded
 * — but nothing wrote a billing row at this head. `POST …/billing/downgrade`
 * writes one log line and no document (that is correct: a schedule is intent),
 * while the plan is actually reduced by two jobs: `runScheduledPlanChanges`
 * (a scheduled self-downgrade reaching its instant) and `runDunning` (a grace
 * period expiring). ADR-0975 §D2 therefore puts the row at the **transition**.
 *
 * ## Contract expected of the implementation (ADR-0975 §D3–§D5)
 *
 * - `@/server/audit/audit-log` widens once: `AuditLogAction` gains
 *   `"subscription.downgraded"`, `AuditLogEntry.target` becomes
 *   `{ kind: "user" | "subscription", id }`, an optional `reason` is written
 *   only when the transition carries one, `systemAuditActor(id)` returns
 *   `{ kind: "system", id, ipHash: null, uaHash: null }` (both keys **present**
 *   and null), and `writeAuditLog(session, entry, at = systemClock.now())`
 *   takes the caller's instant, so a job's row is stamped with its own injected
 *   clock rather than the wall clock.
 * - Each job writes **exactly one** row per applied transition, inside the
 *   **same `withTransaction`** as its conditional `findOneAndUpdate` (§D4), with
 *   `before` taken from the matched pre-image (`returnDocument: "before"`), so a
 *   concurrent transition cannot make the row claim a state it did not replace.
 * - The row's key set is exactly `{ actor, action, target, tenantId, before,
 *   after, reason, at, expireAt }` plus the driver's `_id`; `tenantId` is the
 *   workspace hex **string** (§18.3's type), `target` is
 *   `{ kind: "subscription", id: <subscription hex> }`, and
 *   `expireAt − at === 400 * 24 * 60 * 60 * 1000` (§22).
 * - The rows are read through `platformRepo(db).collection(
 *   COLLECTIONS.auditLogs)` — the handle the writer uses. `GET /admin/audit-logs`
 *   (§9.9) is contract-only at this head, so no route is pinned.
 *
 * ## Which cases are RED, and which are controls
 *
 * RED by design on the shipped tree (both jobs write no audit row and
 * `writeAuditLog` has no `at` parameter): `A1`/`A2` (the two row shapes) and
 * `A5`/`A6` (the two atomicity halves — the transition applies with no row to
 * refuse, and the recovery call finds nothing left to apply).
 *
 * Controls, green on arrival and every GREEN must keep them green: `A3` (a
 * scheduled change that is not due yet writes no row and moves nothing) and `A4`
 * (a `past_due` row inside its grace period writes no row) are the anti-vacuity
 * arms — a job that writes unconditionally reds them. `A5`/`A6`'s second halves
 * are the anti-vacuity guards for their own first halves: a job that never
 * writes reds the recovery call, an out-of-transaction pre-write reds the
 * refusal half. Each half is measured in ADR-0976 §Evidence.
 *
 * ## Assumptions recorded in the handoff (ADR-0976)
 *
 * - **S1 — `at` is the job's injected clock instant.** Every case runs with
 *   `fixedClock(NOW)`, so `row.at` must equal `NOW`; that is what makes the
 *   optional third `writeAuditLog` parameter load-bearing (the shipped
 *   `systemClock.now()` inside the seam would stamp the wall clock and red).
 * - **S2 — a refused audit insert is not swallowed.** With the driver refusing
 *   the insert by `{ code: 91 }` (no `TransientTransactionError` label, so
 *   `withTransaction` rethrows on the first attempt), the run rejects — the
 *   `internal_error` path §D4 names. A job that caught the error and reported
 *   `errors: 1` would leave a silently unaudited downgrade, so the rejection is
 *   pinned beside the state assertions.
 * - **S3 — the two jobs' pre-images differ by shape, not by rule.** The
 *   scheduled row's `before` is `{ activePlanKey }` (that is the field its
 *   conditional write replaces); the dunning row's is `{ status, activePlanKey }`
 *   (both fields its write replaces). No other field is narrowed in, and no
 *   field is added to `after`.
 */
describe("a billing downgrade transition writes one subscription.downgraded audit row (A1–A6, OP-101 / ADR-0975)", () => {
  /** §22 — the retention every audit row carries, exactly 400 days. */
  const FOUR_HUNDRED_DAYS_MS = 400 * 24 * 60 * 60 * 1000;

  /** The document's key set: the §D5 fields plus the driver's `_id`. */
  const AUDIT_ROW_KEYS = [
    "_id",
    "action",
    "actor",
    "after",
    "at",
    "before",
    "expireAt",
    "reason",
    "target",
    "tenantId",
  ];

  /** The `actor` sub-document's four keys (§D3: a system row keeps both, null). */
  const AUDIT_ACTOR_KEYS = ["id", "ipHash", "kind", "uaHash"];

  /** The `target` sub-document's two keys (§D5). */
  const AUDIT_TARGET_KEYS = ["id", "kind"];

  /**
   * The driver's own `Collection#insertOne`, resolved once when this block is
   * registered.
   *
   * The refusal stub below must forward every other collection to the **real**
   * method, and reading `Collection.prototype.insertOne` at call time would find
   * the stub itself: an unbounded recursion answers a `RangeError`, which the
   * job would also report as a failure, so the atomicity case would pass for the
   * wrong reason (`tenant-members.test.ts` `T4` precedent).
   */
  const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
    const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("expected Collection.prototype.insertOne to be a function");
    }
    return descriptor.value as typeof Collection.prototype.insertOne;
  })();

  /**
   * Every `auditLogs` document that names this workspace.
   *
   * The read matches the hex string **and** the `ObjectId`, so a row written with
   * the wrong `tenantId` type is still found and reds on the field assertion with
   * a message that names the drift — instead of letting a case pass vacuously on
   * an empty list.
   */
  async function auditRows(tenantId: string): Promise<Document[]> {
    return platformRepo(app.db)
      .collection(COLLECTIONS.auditLogs)
      .find({ $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] })
      .toArray();
  }

  /**
   * Assert §D3's system actor: exactly four keys, `kind: "system"`, the job id
   * verbatim, and both fingerprints present and `null`.
   */
  function expectSystemActor(row: Record<string, unknown>, id: string): void {
    const actor = row.actor as Record<string, unknown>;
    expect(Object.keys(actor).sort()).toEqual(AUDIT_ACTOR_KEYS);
    expect(actor).toEqual({ kind: "system", id, ipHash: null, uaHash: null });
  }

  /**
   * Assert the §D5 row frame: the exact key set, the subscription target, the
   * workspace as a **string**, and `at`/`expireAt` from the job's clock.
   */
  function expectRowFrame(
    row: Record<string, unknown>,
    tenantId: string,
    subscriptionId: ObjectId
  ): void {
    expect(Object.keys(row).sort()).toEqual(AUDIT_ROW_KEYS);
    expect(row.action).toBe("subscription.downgraded");

    const target = row.target as Record<string, unknown>;
    expect(Object.keys(target).sort()).toEqual(AUDIT_TARGET_KEYS);
    expect(target).toEqual({ kind: "subscription", id: subscriptionId.toHexString() });

    expect(row.tenantId).toBe(tenantId);
    expect(row.at).toEqual(NOW);
    expect(row.expireAt).toBeInstanceOf(Date);
    expect((row.expireAt as Date).getTime() - (row.at as Date).getTime()).toBe(
      FOUR_HUNDRED_DAYS_MS
    );
  }

  /**
   * A1 — the scheduled self-downgrade's row.
   *
   * A `scheduledChange` whose instant has passed is applied by the cron; the
   * durable record of that one transition is one `subscription.downgraded` row
   * naming the job, the workspace and the subscription, carrying the plan the
   * conditional write replaced and the plan it set, the scheduled reason, and a
   * 400-day retention stamped from the run's injected clock.
   */
  it("A1: a due scheduled self-downgrade writes one subscription.downgraded row with the matched pre-image", async () => {
    const tenantId = await seedTenant("op101-audit-scheduled");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      activePlanKey: "starter",
      scheduledChange: {
        toPlanKey: "free",
        effectiveAt: new Date(NOW.getTime() - 3_600_000),
        reason: "self_downgrade",
      },
    });

    // Act
    const result = await runJob(scheduledPlanChangesJob, { now: NOW });

    // Assert — the transition still happens exactly as I7 pins it…
    expect(result).toMatchObject({ affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      activePlanKey: "free",
      scheduledChange: null,
    });

    // …and it is now durable: exactly one row, in §D5's exact shape.
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expectRowFrame(row, tenantId, subscriptionId);
    expectSystemActor(row, "scheduled-plan-changes");
    expect(row.before).toEqual({ activePlanKey: "starter" });
    expect(row.after).toEqual({ activePlanKey: "free" });
    expect(row.reason).toBe("self_downgrade");
  });

  /**
   * A2 — the dunning transition's row.
   *
   * A `past_due` subscription whose grace has run out is downgraded to the free
   * plan; the row is the same action and the same system actor with the `dunning`
   * id, narrowed to the two fields that write replaces (`status`, `activePlanKey`)
   * and the `grace_expired` reason.
   */
  it("A2: an expired grace period writes one subscription.downgraded row from the matched pre-image", async () => {
    const tenantId = await seedTenant("op101-audit-dunning");
    const subscriptionId = await seedPastGrace(tenantId);

    // Act
    const result = await runJob(dunningJob, { now: NOW });

    // Assert
    expect(result).toMatchObject({ affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "downgraded",
      activePlanKey: "free",
    });

    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expectRowFrame(row, tenantId, subscriptionId);
    expectSystemActor(row, "dunning");
    expect(row.before).toEqual({ status: "past_due", activePlanKey: "starter" });
    expect(row.after).toEqual({ status: "downgraded", activePlanKey: "free" });
    expect(row.reason).toBe("grace_expired");
  });

  /**
   * A3 (anti-vacuity) — a scheduled change that is not due yet.
   *
   * The conditional read excludes it, so there is no transition to record: no
   * row, no plan move, and the stored intent is still there for a later run. A
   * job that writes a row per candidate (rather than per applied transition)
   * reds here.
   */
  it("A3: a scheduled change that is not due yet writes no row and moves nothing", async () => {
    const tenantId = await seedTenant("op101-audit-scheduled-later");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      activePlanKey: "starter",
      scheduledChange: {
        toPlanKey: "free",
        effectiveAt: new Date(NOW.getTime() + 3_600_000),
        reason: "self_downgrade",
      },
    });

    // Act
    const result = await runJob(scheduledPlanChangesJob, { now: NOW });

    // Assert
    expect(result).toMatchObject({ affected: 0 });
    expect(await auditRows(tenantId)).toEqual([]);
    const untouched = await readSubscription(subscriptionId);
    expect(untouched).toMatchObject({ activePlanKey: "starter" });
    expect(untouched.scheduledChange).toMatchObject({ toPlanKey: "free" });
  });

  /**
   * A4 (anti-vacuity) — a grace period that has not expired.
   *
   * The dunning filter requires `gracePeriodEndsAt < now`, so a `past_due` row
   * still inside its window is not a transition: no row, and the status stays
   * `past_due`.
   */
  it("A4: a past_due row whose grace period has not expired writes no row", async () => {
    const tenantId = await seedTenant("op101-audit-grace-open");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: new Date(NOW.getTime() + 3_600_000),
      pendingDueMinor: 49_900,
    });

    // Act
    const result = await runJob(dunningJob, { now: NOW });

    // Assert
    expect(result).toMatchObject({ affected: 0 });
    expect(await auditRows(tenantId)).toEqual([]);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "past_due" });
  });

  /**
   * A5 — the scheduled transition and its row are one transaction (§D4).
   *
   * The audit insert is refused with a driver error carrying no
   * `TransientTransactionError` label (`code: 91`, a primary-election error that
   * `withTransaction` rethrows on the first attempt, so no retry can absorb it).
   * The plan must therefore not move, the intent must still be stored, no
   * `statusHistory` entry may be appended and no row may exist — a downgrade
   * nobody can attribute is the failure mode the row exists to prevent. The run
   * rejects rather than swallowing the failure (assumption S2).
   *
   * The second half is the **anti-vacuity guard**: with the driver restored, the
   * same call applies the change and writes exactly one row, so a job that never
   * writes a row cannot pass the refusal half.
   */
  it("A5: a refused audit insert leaves a due scheduled change unapplied and writes no row, then applies with one row once the driver recovers", async () => {
    const tenantId = await seedTenant("op101-audit-atomic-scheduled");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      activePlanKey: "starter",
      scheduledChange: {
        toPlanKey: "free",
        effectiveAt: new Date(NOW.getTime() - 3_600_000),
        reason: "self_downgrade",
      },
    });

    const driverError = Object.assign(new Error("not primary"), { code: 91 });
    const insertStub = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document: Document,
      options?: InsertOneOptions
    ) {
      if (this.collectionName === COLLECTIONS.auditLogs) {
        return Promise.reject(driverError);
      }
      return driverInsertOne.call(this, document, options);
    });

    const refusal = await runJob(scheduledPlanChangesJob, { now: NOW }).then(
      () => null,
      (error: unknown) => error
    );
    insertStub.mockRestore();

    // The transaction aborted: nothing applied, nothing recorded.
    const untouched = await readSubscription(subscriptionId);
    expect(untouched).toMatchObject({ activePlanKey: "starter" });
    expect(untouched.scheduledChange).toMatchObject({ toPlanKey: "free" });
    expect(untouched.statusHistory).toEqual([]);
    expect(await auditRows(tenantId)).toEqual([]);
    expect(refusal).toBeInstanceOf(Error);

    // The anti-vacuity half: same call, healthy driver → applied, one row.
    const accepted = await runJob(scheduledPlanChangesJob, { now: NOW });
    expect(accepted).toMatchObject({ affected: 1 });
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "subscription.downgraded",
      reason: "self_downgrade",
      before: { activePlanKey: "starter" },
      after: { activePlanKey: "free" },
    });
  });

  /**
   * A6 — the dunning transition and its row are one transaction (§D4).
   *
   * The same refusal as A5, on the other job path: the subscription stays
   * `past_due` with its plan and its grace stamp, its `statusHistory` stays
   * empty, no row is written and the run rejects; restored, the same call
   * downgrades it and writes exactly one `grace_expired` row.
   */
  it("A6: a refused audit insert leaves a past_due row untransitioned and writes no row, then downgrades with one row once the driver recovers", async () => {
    const tenantId = await seedTenant("op101-audit-atomic-dunning");
    const subscriptionId = await seedPastGrace(tenantId);
    const before = await readSubscription(subscriptionId);

    const driverError = Object.assign(new Error("not primary"), { code: 91 });
    const insertStub = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document: Document,
      options?: InsertOneOptions
    ) {
      if (this.collectionName === COLLECTIONS.auditLogs) {
        return Promise.reject(driverError);
      }
      return driverInsertOne.call(this, document, options);
    });

    const refusal = await runJob(dunningJob, { now: NOW }).then(
      () => null,
      (error: unknown) => error
    );
    insertStub.mockRestore();

    const untouched = await readSubscription(subscriptionId);
    expect(untouched).toMatchObject({
      status: "past_due",
      activePlanKey: "starter",
      gracePeriodEndsAt: before.gracePeriodEndsAt,
    });
    expect(untouched.statusHistory).toEqual([]);
    expect(await auditRows(tenantId)).toEqual([]);
    expect(refusal).toBeInstanceOf(Error);

    const accepted = await runJob(dunningJob, { now: NOW });
    expect(accepted).toMatchObject({ affected: 1 });
    const rows = await auditRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "subscription.downgraded",
      reason: "grace_expired",
      before: { status: "past_due", activePlanKey: "starter" },
      after: { status: "downgraded", activePlanKey: "free" },
    });
  });
});
