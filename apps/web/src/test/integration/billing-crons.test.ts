import { ObjectId, type Document } from "mongodb";
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

    // Assert — the whole-database diff is the pin: any write outside the two
    // permitted collections would be named by this assertion.
    const after = await snapshotDatabase();
    expect(changedCollections(before, after)).toEqual(["domain_events", "subscriptions"]);

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
