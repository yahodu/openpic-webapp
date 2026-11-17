import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the seam the webhook inbox defers its projection
 * through (§10.1 step 5/6); the mock is hoisted above the module graph so the
 * inbox route binds to it on import, and the default is inert so a case can run
 * the deferred work itself — the pattern `billing-crons.test.ts` and
 * `provider-webhook-inbox.test.ts` established.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as receiveWebhook } from "@/app/api/v1/webhooks/[provider]/route";
import { billingReconcileJob, webhookProjectionSweepJob } from "@/server/billing/billing-cron-jobs";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { CronJob, CronResult } from "@/server/jobs/cron-job";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";
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
 * Integration / contract — the two §10.2 admin-alert escapes and the reconcile
 * classes (OP-111 follow-up TEST, contract §10.2 lines 3224–3225, §10.1.2 line
 * 3171; ADR-0502).
 *
 * `billing-crons.test.ts` pins the happy paths of the six billing crons. Three
 * behaviours it deliberately leaves unpinned are the subject of this file, and
 * every one of them is a *new* emission or a *new* class, so the pins here are
 * RED-by-design on the shipped trunk (ADR-0306):
 *
 *   - **P1** — the `billing-reconcile` row of §10.2 names
 *     `admin.billing.manual_review` "on mismatch", and the OP-111 card's
 *     `security_and_logging_requirements` require admin alerts via domain events
 *     only. Today the job corrects every drift it can read and emits **nothing**.
 *     A mismatch the job must not silently "correct" is pinned to emit exactly
 *     one outbox row; the resolvable-drift control emits none.
 *   - **P2** — the `webhook-projection-sweep` row names `admin.provider.failing`
 *     "on repeated failure" (§10.1.2 line 3171: always mobile). Today the job
 *     only counts `errors`.
 *   - **P3** — the reconcile classes the card mandates (`past_due` as well as
 *     `incomplete`), the provider-error path and the no-`externalRefs` skip, plus
 *     the two-stamp candidate edge the round-1 review found: the filter requires
 *     `createdAt` **and** `updatedAt` to be stale, and a Mongo `$lt` does not
 *     match a missing field, so a row carrying only one stamp could never be
 *     reconciled.
 *
 * ## The contract this file fixes (ADR-0502)
 *
 * - **The mismatch predicate.** `billing-reconcile` auto-applies **only** drift
 *   toward `status: "active"` — the missed activation/reactivation webhook, which
 *   is idempotent and fabricates no side effects. Any *other* status divergence
 *   (the provider reporting `cancelled`/`expired`/`past_due` while we hold
 *   `incomplete`/`past_due`) needs the webhook's own side effects (the grace
 *   clock, the dunning reset, a refund) that a reconciler must not invent, so it
 *   is the `admin.billing.manual_review` class: the row is left untouched and one
 *   outbox row is emitted with `subjectRef { kind: "subscription", id }` and the
 *   subscription's `tenantId`.
 * - **The repeat threshold.** The sweep persists a consecutive-failure counter
 *   per inbox row (any field name; absent ⇒ 0) and raises
 *   `admin.provider.failing` when a row has failed the sweep **three** times, once
 *   per row. Two failures are the transient tolerance; further sweeps do not
 *   re-raise. The alert's payload carries `mobile: true` (§10.1.2 line 3171).
 * - **The two-stamp edge.** A missing stamp is treated as *not fresh*, so a row
 *   carrying only one stamp is still a candidate. Both-present rows keep the
 *   **AND** the shipped filter applies — `billing-crons.test.ts`'s I4 negative
 *   control (fresh `createdAt`, stale `updatedAt`) must stay unselected.
 *
 * The alert's `tenantId`/`subjectRef` for the *sweep* alert is deliberately not
 * pinned: the inbox row carries no tenant and §10.2 names no subject for it, so
 * the GREEN owns that choice (ADR-0502 §"Open items"). The `manual_review`
 * subject **is** pinned — the card names it.
 */

/** The payments selection this suite drives the reconcile/sweep seams with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The instant every clock-injected reconcile case is evaluated at. */
const NOW = new Date("2026-10-25T12:00:00.000Z");

/** An instant a month earlier — the seed stamp of rows no case expects to move. */
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

/** The §10.2 `billing-reconcile` staleness window (one hour). */
const STUCK_MS_AGO = 2 * 3_600_000;

/** The escalation `webhook-projection-sweep` raises on repeated failure (§10.2). */
const PROVIDER_FAILING_KEY = "admin.provider.failing";

/** The escalation `billing-reconcile` raises on a mismatch (§10.2). */
const MANUAL_REVIEW_KEY = "admin.billing.manual_review";

/**
 * A collection validator no document can satisfy.
 *
 * The driver stamps `_id` on every insert, so `{_id: {$exists: false}}` refuses
 * every write: the ledger "cannot accept money" and a webhook projection fails
 * **after** the provider was acknowledged — which is how this file produces a
 * genuinely unprocessed inbox row without reaching inside the projection.
 */
const ALWAYS_REJECT: Readonly<Record<string, unknown>> = { _id: { $exists: false } };

/** The `subscriptions` row this file reads back (schema §14.3, as stored). */
interface StoredSubscription {
  readonly _id: ObjectId;
  readonly status: SubscriptionStatus;
  readonly mandateStatus: string;
  readonly updatedAt: Date | undefined;
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
  readonly processedAt: Date | null;
  readonly processResult: string | null;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op111-admin-alerts", env: PAYMENTS_ENV });
  // The ledger starts rejecting every write, so a webhook projection fails
  // deterministically and leaves the inbox row unprocessed (the P2 precondition).
  await app.db.createCollection(COLLECTIONS.billingTransactions, {
    validator: { ...ALWAYS_REJECT },
    validationLevel: "strict",
    validationAction: "error",
  });
  // The `domain_events.dedupeKey` unique index is what makes a repeated
  // escalation idempotent, so the suite runs against the real schema.
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  afterMock.mockClear();
  // Re-poison the ledger; no case may depend on which ran first. (Deletes
  // ignore validation, so the cleared ledger is fine.)
  await app.db.command({
    collMod: COLLECTIONS.billingTransactions,
    validator: { ...ALWAYS_REJECT },
  });
  // One booted app serves the whole file: the outbox's unique `dedupeKey`, the
  // inbox's unique event identity and the seeded refs would otherwise leak.
  await Promise.all([
    app.db.collection(COLLECTIONS.subscriptions).deleteMany({}),
    app.db.collection(COLLECTIONS.domainEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.providerWebhookEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.billingTransactions).deleteMany({}),
    app.db.collection(COLLECTIONS.tenants).deleteMany({}),
    app.db.collection(COLLECTIONS.tenantMembers).deleteMany({}),
  ]);
  invalidatePlatformSettings();
});

/** Run one billing cron job with an explicit clock, exactly as its route does. */
async function runJob(
  job: CronJob,
  options: { readonly limit?: string | null; readonly now?: Date } = {}
): Promise<CronResult> {
  return job.run({
    requestedLimit: options.limit ?? null,
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
    name: "OP111 Alerts Studio",
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
  readonly mandateStatus?: string;
  readonly gracePeriodEndsAt?: Date | null;
  readonly pendingDueMinor?: number;
  readonly refs?: readonly ProviderRef[];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** Seed one `subscriptions` row (schema §14.3) and return its id. */
async function seedSubscription(seed: SubscriptionSeed): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: seed.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: seed.status,
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: seed.mandateStatus ?? "active",
    currentPeriodStart: SEEDED_AT,
    currentPeriodEnd: null,
    nextChargeAt: null,
    gracePeriodEndsAt: seed.gracePeriodEndsAt ?? null,
    pendingDueMinor: seed.pendingDueMinor ?? 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [...(seed.refs ?? [])],
    createdAt: seed.createdAt ?? SEEDED_AT,
    updatedAt: seed.updatedAt ?? SEEDED_AT,
  });
  return _id;
}

/** Drop one stamp from a seeded row, so the candidate filter meets a missing field. */
async function unsetStamp(
  subscriptionId: ObjectId,
  field: "createdAt" | "updatedAt"
): Promise<void> {
  await app.db
    .collection(COLLECTIONS.subscriptions)
    .updateOne({ _id: subscriptionId }, { $unset: { [field]: "" } });
}

/** Read a subscription back, failing loudly when the row vanished. */
async function readSubscription(subscriptionId: ObjectId): Promise<StoredSubscription> {
  const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
  if (row === null) {
    throw new Error(`subscription ${subscriptionId.toHexString()} not found`);
  }
  return row as unknown as StoredSubscription;
}

/** Every outbox row, oldest first (the sweep alert's tenant is not pinned). */
async function allDomainEvents(): Promise<StoredDomainEvent[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({})
    .sort({ occurredAt: 1 })
    .toArray();
  return rows as unknown as StoredDomainEvent[];
}

/** The outbox rows a tenant owns, oldest first. */
async function domainEventsFor(tenantId: string): Promise<StoredDomainEvent[]> {
  return (await allDomainEvents()).filter((event) => event.tenantId === tenantId);
}

/** The outbox rows carrying one event key. */
async function eventsWithKey(eventKey: string): Promise<StoredDomainEvent[]> {
  return (await allDomainEvents()).filter((event) => event.eventKey === eventKey);
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

/** Answer every provider status fetch with `vendorStatus`, counting the calls. */
function respondWithStatus(vendorStatus: string): { readonly calls: () => number } {
  let calls = 0;
  server.use(
    http.get(CASHFREE_STATUS_URL, () => {
      calls += 1;
      return HttpResponse.json(
        makeCashfreeSubscriptionStatusResponse({
          subscription_id: VENDOR_SUBSCRIPTION_ID,
          subscription_status: vendorStatus,
        })
      );
    })
  );
  return { calls: () => calls };
}

/** Fail every provider status fetch with a `500`, counting the calls. */
function respondWithFailure(): { readonly calls: () => number } {
  let calls = 0;
  server.use(
    http.get(CASHFREE_STATUS_URL, () => {
      calls += 1;
      return HttpResponse.json({ message: "upstream unavailable" }, { status: 500 });
    })
  );
  return { calls: () => calls };
}

/** Capture the process logger's entries for the duration of one case. */
function captureLogs(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "trace",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

/** A stuck row's `createdAt`/`updatedAt` — two hours before the evaluated instant. */
function stuckSince(): Date {
  return new Date(NOW.getTime() - STUCK_MS_AGO);
}

describe("billing-reconcile — the admin.billing.manual_review mismatch class (P1)", () => {
  it("P1: a provider divergence the job cannot auto-apply emits one admin.billing.manual_review", async () => {
    // Arrange — we hold the subscription as never-activated; the provider says
    // the mandate was cancelled. Silently writing `cancelled` would cut access
    // on a state the missed webhook never explained, so it is a manual review.
    const tenantId = await seedTenant("op111-p1-mismatch");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    const provider = respondWithStatus("CANCELLED");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert — the provider was consulted, nothing was written, and the
    // mismatch is on the outbox exactly once, naming the subscription.
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 0 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "incomplete",
      mandateStatus: "pending",
    });
    const events = await domainEventsFor(tenantId);
    expect(events.map((event) => event.eventKey)).toEqual([MANUAL_REVIEW_KEY]);
    expect(events[0]?.subjectRef).toEqual({
      kind: "subscription",
      id: subscriptionId.toHexString(),
    });
    expect(events[0]?.tenantId).toBe(tenantId);
  });

  it("P1: a resolvable drift is corrected and emits no admin alert", async () => {
    // Arrange — the same stuck row, but the provider confirms it is live: the
    // missed activation webhook, which the job owns and resolves itself.
    const tenantId = await seedTenant("op111-p1-resolvable");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    const provider = respondWithStatus("ACTIVE");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      mandateStatus: "active",
    });
    expect(await eventsWithKey(MANUAL_REVIEW_KEY)).toEqual([]);
  });
});

describe("billing-reconcile — the reconcile classes and the two-stamp edge (P3)", () => {
  it("P3: a stuck past_due subscription is reconciled to active", async () => {
    // Arrange — the missed reactivation webhook: the provider is live but we
    // still hold the row past_due. The reconcile class the card mandates.
    const tenantId = await seedTenant("op111-p3-past-due");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "past_due",
      mandateStatus: "active",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    const provider = respondWithStatus("ACTIVE");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "active" });
    expect(await eventsWithKey(MANUAL_REVIEW_KEY)).toEqual([]);
  });

  it("P3: a provider fetch that fails counts an error, writes nothing and warns", async () => {
    // Arrange
    const ambient = getLogger();
    const sink = captureLogs();
    const tenantId = await seedTenant("op111-p3-provider-error");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    const provider = respondWithFailure();

    // Act
    let result: CronResult;
    try {
      result = await runJob(billingReconcileJob, { now: NOW });
    } finally {
      setLogger(ambient);
    }

    // Assert — the failure is counted, the row is untouched, and the run warns
    // on the drift surface rather than silently swallowing the error.
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 0, errors: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "incomplete",
      mandateStatus: "pending",
    });
    const warnings = sink.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: "billing.reconcile.provider_error" })
    );
    expect(await eventsWithKey(MANUAL_REVIEW_KEY)).toEqual([]);
  });

  it("P3: a stuck row with no subscription externalRef is skipped without a provider call", async () => {
    // Arrange — a row with no refs has nothing to reconcile against.
    const tenantId = await seedTenant("op111-p3-no-refs");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    const provider = respondWithStatus("ACTIVE");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(0);
    expect(result).toMatchObject({ scanned: 1, affected: 0, skipped: 1, errors: 0 });
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "incomplete" });
    expect(await eventsWithKey(MANUAL_REVIEW_KEY)).toEqual([]);
  });

  it("P3: a stuck row whose updatedAt is missing is still reconciled", async () => {
    // Arrange — `{updatedAt: {$lt: …}}` does not match a missing field, so a row
    // carrying only its `createdAt` stamp must not be silently skipped.
    const tenantId = await seedTenant("op111-p3-missing-updated-at");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
    });
    await unsetStamp(subscriptionId, "updatedAt");
    const provider = respondWithStatus("ACTIVE");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      mandateStatus: "active",
    });
  });

  it("P3: a stuck row whose createdAt is missing is still reconciled", async () => {
    // Arrange — the mirror edge: only the `updatedAt` stamp is present.
    const tenantId = await seedTenant("op111-p3-missing-created-at");
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      mandateStatus: "pending",
      refs: [SUBSCRIPTION_REF],
      createdAt: stuckSince(),
      updatedAt: stuckSince(),
    });
    await unsetStamp(subscriptionId, "createdAt");
    const provider = respondWithStatus("ACTIVE");

    // Act
    const result = await runJob(billingReconcileJob, { now: NOW });

    // Assert
    expect(provider.calls()).toBe(1);
    expect(result).toMatchObject({ scanned: 1, affected: 1 });
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "active" });
  });
});

describe("webhook-projection-sweep — the admin.provider.failing escalation (P2)", () => {
  /**
   * Seed one subscription and drive a signed webhook whose deferred projection
   * fails against the poisoned ledger, then age the inbox row past the sweep's
   * 60 s grace. Returns the unprocessed row the sweeps will retry.
   */
  async function seedFailingProjection(tenantId: string, paymentId: string): Promise<void> {
    await seedSubscription({
      tenantId,
      status: "past_due",
      gracePeriodEndsAt: new Date(NOW.getTime() - GRACE_ENDED_MS_AGO),
      pendingDueMinor: 49_900,
      refs: [SUBSCRIPTION_REF],
    });
    const response = await receiveWebhook(
      signedWebhook(paymentSucceededBody(VENDOR_SUBSCRIPTION_ID, paymentId))
    );
    expect(response.status).toBe(200);
    await drainDeferredProjections();
    const failed = await latestInboxRow();
    expect(failed).toMatchObject({ processedAt: null, processResult: "error" });
    await app.db
      .collection(COLLECTIONS.providerWebhookEvents)
      .updateOne({ _id: failed._id }, { $set: { receivedAt: new Date(Date.now() - 5 * 60_000) } });
  }

  it("P2: below the repeat threshold a failing sweep raises no escalation", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-p2-below");
    await seedFailingProjection(tenantId, "49920001");

    // Act — two consecutive failed sweeps.
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);

    // Assert — a transient failure must not page anyone yet.
    expect(await eventsWithKey(PROVIDER_FAILING_KEY)).toEqual([]);
    expect(await latestInboxRow()).toMatchObject({ processedAt: null });
  });

  it("P2: at the repeat threshold the escalation is raised once", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-p2-at-threshold");
    await seedFailingProjection(tenantId, "49920002");

    // Act — the third consecutive failed sweep crosses the threshold.
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);

    // Assert
    const escalations = await eventsWithKey(PROVIDER_FAILING_KEY);
    expect(escalations).toHaveLength(1);
    expect(await latestInboxRow()).toMatchObject({ processedAt: null });
  });

  it("P2: further failing sweeps do not raise a second escalation", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-p2-beyond");
    await seedFailingProjection(tenantId, "49920003");

    // Act — five failed sweeps for the one row.
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);

    // Assert — one alert per failing row, not one per sweep.
    expect(await eventsWithKey(PROVIDER_FAILING_KEY)).toHaveLength(1);
    expect(await latestInboxRow()).toMatchObject({ processedAt: null });
  });

  it("P2: the provider-failure escalation is always mobile", async () => {
    // Arrange
    const tenantId = await seedTenant("op111-p2-mobile");
    await seedFailingProjection(tenantId, "49920004");

    // Act
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);
    await runJob(webhookProjectionSweepJob);

    // Assert — §10.1.2 line 3171: a silent payment-webhook failure means
    // wrongful downgrades, so the alert carries the mobile hint.
    const escalations = await eventsWithKey(PROVIDER_FAILING_KEY);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.payload).toMatchObject({ mobile: true });
  });
});
