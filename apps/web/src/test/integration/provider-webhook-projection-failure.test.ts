import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is mocked for the same reason the inbox suite mocks it
 * (see `provider-webhook-inbox.test.ts`): the spec must control *when* the
 * deferred projection runs so it can observe the post-response failure.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as receiveWebhook } from "@/app/api/v1/webhooks/[provider]/route";
import { projectProviderWebhookEvent } from "@/server/billing/webhook-projection";
import { COLLECTIONS } from "@/server/db/collections";
import type { ProviderRef, SubscriptionStatus } from "@/server/payments/payment-provider";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  makeCashfreeWebhookBody,
  makeCashfreeWebhookHeaders,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";

/**
 * Integration / contract — a projection that fails (OP-108 RED, contract §10.1
 * step 7, §23; ADR-0440).
 *
 * The user story: *as the platform I want provider webhooks verified,
 * deduplicated, acknowledged quickly and projected transactionally so that
 * billing state is correct even under replays and delays.*
 *
 * The failure is injected where a real one would come from: the ledger
 * collection refuses the insert (a collection validator that no document can
 * satisfy). The projection therefore fails **after** the provider was already
 * acknowledged, which is the only interesting shape of this bug — a webhook
 * handler that let a projection error escape would answer the provider `5xx`,
 * and a redelivery storm during a payment incident is how wrongful downgrades
 * happen (§10.1 step 5).
 *
 * Three properties are pinned, none of which reaches inside the implementation:
 *
 *   1. the provider still gets `200 {"status":"received"}` (step 7: a projection
 *      failure never causes a non-`200`);
 *   2. the row stays unprocessed — `processedAt: null` with `processResult:
 *      "error"` and a `processError`, which is what makes OP-111's
 *      `webhook-projection-sweep` pick it up (`processedAt: null`);
 *   3. **nothing moved**: the `subscriptions` row is exactly as seeded and no
 *      `billingTransactions` row exists — money and access move together (§23),
 *      so a half-applied projection would be corruption, not a retry.
 *
 * The second spec drives the sweep seam on that same row once the ledger accepts
 * writes again, proving the failure is recoverable rather than lost.
 *
 * ## Assumptions recorded in the handoff (ADR-0440)
 *
 * - The projection is a MongoDB transaction (§23, contract §10.1 step 6), so the
 *   rejected ledger insert aborts the whole unit of work. A non-transactional
 *   implementation that wrote the subscription first would leave it dunned here
 *   and fail pin 3 — which is the point of the pin.
 * - `processResult: "error"` and a non-empty `processError` are §10.1 step 7's
 *   own vocabulary; the sweep retries on `processedAt: null`.
 * - The deferred callback is awaited **without** a catch: a projection failure
 *   must be handled by the projection (which records the error), never surfaced
 *   as a rejected unit of deferred work.
 */

/** The vendor subscription id every fixture body addresses. */
const SUBSCRIPTION_REF_ID = "sub_test_001";

/** The payments selection this suite drives the inbox with (OP-107's wiring). */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The subscription ref a seeded row must carry for the fixture body to match it. */
const SUBSCRIPTION_REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: SUBSCRIPTION_REF_ID,
};

/**
 * A collection validator no document can satisfy.
 *
 * The driver stamps `_id` on every inserted document, so `{_id: {$exists: false}}`
 * refuses every insert into the collection with a write error — the ledger
 * "cannot accept money" and the projection has to cope.
 */
const ALWAYS_REJECT: Readonly<Record<string, unknown>> = { _id: { $exists: false } };

/** The §14.3 `subscriptions` row this suite reads back. */
interface SubscriptionRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly mandateStatus: string;
  readonly gracePeriodEndsAt: Date | null;
  readonly pendingDueMinor: number;
  readonly externalRefs: readonly ProviderRef[];
}

/** The §18.4 `providerWebhookEvents` row this suite reads back. */
interface WebhookEventRow {
  readonly _id: unknown;
  readonly processedAt: Date | null;
  readonly processResult: string | null;
  readonly processError: string | null;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op108-projection-failure", env: PAYMENTS_ENV });
  // Create the ledger collection *rejecting* every write, before anything in the
  // suite can touch it, so a failed projection is the deterministic outcome.
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
  // Restore the poison: the recovery spec lifts it, and no spec may depend on
  // which ran first.
  await app.db.command({
    collMod: COLLECTIONS.billingTransactions,
    validator: { ...ALWAYS_REJECT },
  });
  invalidatePlatformSettings();
});

/** A `POST` to the Cashfree inbox carrying a correctly signed raw body. */
function signedRequest(rawBody: string): Request {
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

/** A `SUBSCRIPTION_PAYMENT_FAILED` body — a money event, so it must write a ledger row. */
function paymentFailedBody(): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_FAILED", {
    subscriptionDetails: { subscription_status: "ACTIVE" },
    eventTime: new Date(Date.now() - 5 * 60_000).toISOString(),
    extraData: {
      payment_id: "ab-charge-002",
      cf_payment_id: "49914527",
      payment_type: "CHARGE",
      payment_status: "FAILED",
      payment_amount: 499,
      payment_currency: "INR",
      failure_details: { failure_reason: "MANDATE_REVOKED" },
    },
  });
}

/** Seed one paid-up `subscriptions` row and return its id. */
async function seedActiveSubscription(tenantId: string): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: "active",
    priceKey: "starter-monthly-inr",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    billingCycle: "monthly",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    nextChargeAt: new Date("2026-11-01T00:00:00.000Z"),
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    externalRefs: [SUBSCRIPTION_REF],
  });
  return _id;
}

/** Read the seeded subscription back, failing loudly when the row vanished. */
async function readSubscription(subscriptionId: ObjectId): Promise<SubscriptionRow> {
  const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
  expect(row).not.toBeNull();
  return row as unknown as SubscriptionRow;
}

/** The most recently received inbox row, failing loudly when there is none. */
async function latestWebhookRow(): Promise<WebhookEventRow> {
  const rows = await app.db
    .collection(COLLECTIONS.providerWebhookEvents)
    .find({})
    .sort({ receivedAt: 1 })
    .toArray();
  const last = rows.at(-1);
  expect(last).toBeDefined();
  return last as unknown as WebhookEventRow;
}

/** Run every callback the route deferred, exactly as Next.js does after the response. */
async function drainDeferredProjections(): Promise<void> {
  const callbacks = afterMock.mock.calls.map((call) => call[0]);
  afterMock.mockClear();
  await Promise.all(callbacks.map((callback) => callback()));
}

describe("a projection whose ledger write fails", () => {
  it("I5: still answers 200, leaves processedAt null with an error, and moves neither money nor access", async () => {
    // Arrange
    const tenantId = new ObjectId().toHexString();
    const subscriptionId = await seedActiveSubscription(tenantId);
    const rawBody = paymentFailedBody();

    // Act — the provider's POST, then the deferred projection.
    const response = await receiveWebhook(signedRequest(rawBody));
    await drainDeferredProjections();

    // Assert — §10.1 step 7: the provider is answered whatever the projection did.
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });

    const recorded = await latestWebhookRow();
    expect(recorded.processedAt).toBeNull();
    expect(recorded.processResult).toBe("error");
    expect(recorded.processError ?? "").not.toBe("");

    // …and nothing moved: the subscription is exactly as seeded (§23 — money and
    // access move in one transaction, so an aborted projection leaves no dunning).
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      gracePeriodEndsAt: null,
      pendingDueMinor: 0,
    });
    expect(
      await app.db.collection(COLLECTIONS.billingTransactions).countDocuments({ tenantId })
    ).toBe(0);
  });

  it("the sweep seam applies the same row once the ledger accepts the write", async () => {
    // Arrange — reproduce the failed projection with the poison in place.
    const tenantId = new ObjectId().toHexString();
    const subscriptionId = await seedActiveSubscription(tenantId);
    await receiveWebhook(signedRequest(paymentFailedBody()));
    await drainDeferredProjections();
    const recorded = await latestWebhookRow();
    expect(recorded.processResult).toBe("error");

    // Act — the operator repairs the collection; the sweep retries the row.
    await app.db.command({ collMod: COLLECTIONS.billingTransactions, validator: {} });
    await projectProviderWebhookEvent(String(recorded._id), { db: app.db });

    // Assert
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "past_due",
      pendingDueMinor: 49_900,
    });
    const ledger = await app.db
      .collection(COLLECTIONS.billingTransactions)
      .find({ tenantId })
      .toArray();
    expect(ledger).toHaveLength(1);
    const processed = await latestWebhookRow();
    expect(processed.processedAt).toBeInstanceOf(Date);
    expect(processed.processResult).toBe("applied");
  });
});
