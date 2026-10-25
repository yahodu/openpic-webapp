import { createHash } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the seam this suite observes for the "respond
 * first, project after" half of the contract (§10.1 step 5/6, the GREEN card's
 * §3). The mock is hoisted above the module graph so
 * `@/server/domain/domain-events` and the inbox route both bind to it on import;
 * the default is inert (`vi.fn()`), which is what lets a spec assert the
 * *scheduling* call and then decide whether to run the deferred work — exactly
 * the pattern `domain-events-after-trigger.test.ts` established.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as receiveWebhook } from "@/app/api/v1/webhooks/[provider]/route";
import { projectProviderWebhookEvent } from "@/server/billing/webhook-projection";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createLogger, getLogger, memoryTransport, setLogger } from "@/server/logging";
import type {
  ProviderRef,
  SubscriptionStatus,
  WebhookHeaders,
} from "@/server/payments/payment-provider";
import {
  invalidatePlatformSettings,
  PLATFORM_SETTINGS_DEFAULTS,
} from "@/server/settings/platform-settings";

import { body } from "../helpers/auth-requests";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { expectNoSecretsInLogs } from "../helpers/log-assertions";
import {
  makeCashfreeWebhookBody,
  makeCashfreeWebhookHeaders,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";

/**
 * Integration / contract — `POST /api/v1/webhooks/{provider}` (OP-108 RED,
 * contract §10.1; ADR-0440).
 *
 * The user story: *as the platform I want provider webhooks verified,
 * deduplicated, acknowledged quickly and projected transactionally so that
 * billing state is correct even under replays and delays.*
 *
 * The route is one generic inbox: verify the signature over the **raw** bytes,
 * insert once into `providerWebhookEvents` (the unique index *is* the dedupe),
 * answer `200` before any domain work, and only then project the event into
 * `billingTransactions` + `subscriptions` in one transaction:
 *
 *   I1  a valid signed activation is `200 {"status":"received"}`; the
 *       subscription is **still `incomplete`** when the response returns and
 *       becomes `active` with a succeeded `authorization` row once the deferred
 *       projection runs;
 *   I2  a replay is `200 duplicate_ignored` and adds nothing — by provider event
 *       id when the payload carries one, and by payload hash when it does not —
 *       while two *different* id-less events both project (the partial unique
 *       indexes of §18.4);
 *   I3  a bad, missing or stale signature is `401` (`invalid_signature` /
 *       `stale_signature`) with **zero rows written**;
 *   I4  an event for another provider environment is `ignored`, never projected;
 *   I6  a failed charge is `past_due` with the grace deadline read from
 *       `platformSettings.dunning.gracePeriodDays` (14 by default, 7 after an
 *       operator changes it, `pendingDueMinor` = the amount attempted);
 *   I7  a failure that arrives *after* a later success does not roll the
 *       subscription back — the projector orders by the provider's `occurredAt`.
 *
 * Around those, the ordinary behaviour §10.1 implies: the `$or` id/payload-hash
 * identity, the §18.4 row shape, the timestamps, the deferral contract, the
 * `after()`-free sweep seam OP-111 reuses, and an inbox for a provider this
 * deployment has no adapter for.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/webhooks/[provider]/route` exports `POST`, declared
 *   `defineRoute({ route: "/api/v1/webhooks/:provider", … })` with **no**
 *   `rateLimit` stage (§0.11: `/webhooks/**` is not rate limited) and no declared
 *   request `body` schema — the handler reads the raw bytes itself
 *   (`ctx.request.text()`), because JSON re-serialisation breaks the HMAC
 *   (§10.1.1). The `{provider}` segment selects the payment adapter whose
 *   normalized events say `provider === <segment>`; anything else is refused
 *   with no write. The response body is exactly the §10.1 step 5 receipt:
 *   `{"status": "received" | "duplicate_ignored"}`.
 * - Verification produces the Appendix A codes `invalid_signature` /
 *   `stale_signature` (both `401`, both writing nothing). The timestamp window
 *   is the port's ±300 s, so the route needs the `x-webhook-timestamp` itself;
 *   a *missing* timestamp or signature is `invalid_signature`.
 * - The inbox row is the §18.4 document (`provider`, `env`, `eventType`,
 *   `providerEventId`, `payloadHash`, `signatureValid`, `rawPayload`,
 *   `receivedAt`, `processedAt`, `processResult`, `processError`, `expireAt`);
 *   `expireAt` is `receivedAt + platformSettings.retention.webhookDays`.
 * - The projection is deferred through `after()` (the GREEN card's §3) and is
 *   also exported as `projectProviderWebhookEvent(eventId: ObjectId | string,
 *   { db?, clock? })` from `@/server/billing/webhook-projection`, so OP-111's
 *   `webhook-projection-sweep` re-projects `processedAt: null` rows.
 * - The ledger row carries §14.4's `rawPayloadRef` → the inbox row's `_id`, so
 *   the raw payload is referenced, never copied.
 * - `billingTransactions` is registered in `COLLECTIONS` as
 *   `"billing_transactions"`.
 *
 * ## Assumptions recorded in the handoff (ADR-0440)
 *
 * - The route is driven with `PAYMENT_PROVIDER=cashfree` + the four
 *   `CASHFREE_*` variables (the OP-107 wiring), so MSW-fail-closed proves the
 *   webhook path makes **no** upstream call — verification is offline HMAC.
 * - `eventType` stores the **normalized** kind: §10.1.1 keeps vendor event names
 *   inside the adapter, and the port's `NormalizedProviderEvent` exposes `kind`
 *   and nothing vendor-shaped.
 * - §18.4's `payloadHash` form is `sha256:<hex>`; the spec strips an optional
 *   `sha256:` prefix and compares the digest, so the *value* is pinned exactly
 *   and the prefix convention stays the implementation's choice.
 * - The row's `receivedAt`/`expireAt` are pinned as bounded intervals
 *   (`[before, after]`) rather than exact instants, so no assertion depends on
 *   how long the request took.
 * - The projection's ordering watermark is a §14.3 field of the implementation's
 *   choosing (the schema has none today); the tests assert only that an older
 *   event is ignored.
 */

const WEBHOOKS_PATH = "/api/v1/webhooks";

/** The payments selection this suite drives the inbox with (OP-107's wiring). */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The vendor subscription id every fixture body addresses. */
const SUBSCRIPTION_REF_ID = "sub_test_001";

/** The §18.4 retention the TTL assertions are bounded by. */
const WEBHOOK_TTL_DAYS = PLATFORM_SETTINGS_DEFAULTS.retention.webhookDays;

/** One day in milliseconds. */
const MS_PER_DAY = 86_400_000;

/** The replay-window edge a stale/future timestamp is signed at (§10.1 step 2). */
const REPLAY_WINDOW_MS = 300_000;

/** The client IP the invalid-signature log pin refuses to echo in the clear. */
const CLIENT_IP = "203.0.113.7";

/** The `subscription_details.subscription_status` an auth-success body carries. */
const VENDOR_ACTIVE = "ACTIVE";

/** The subscription ref a seeded row must carry for a fixture body to match it. */
const SUBSCRIPTION_REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: SUBSCRIPTION_REF_ID,
};

/** The §14.3 `subscriptions` row this suite seeds. */
interface SubscriptionRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly subscribedPlanKey: string;
  readonly subscribedPlanVersion: number;
  readonly activePlanKey: string;
  readonly status: SubscriptionStatus;
  readonly priceKey: string;
  readonly paymentMethodKind: string;
  readonly mandateStatus: string;
  readonly billingCycle: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly nextChargeAt: Date | null;
  readonly gracePeriodEndsAt: Date | null;
  readonly pendingDueMinor: number;
  readonly currency: string;
  readonly dunning: {
    readonly attemptCount: number;
    readonly lastAttemptAt: Date | null;
    readonly remindersSent: readonly string[];
    readonly nextReminderAt: Date | null;
  };
  readonly externalRefs: readonly ProviderRef[];
}

/** The §18.4 `providerWebhookEvents` row as this suite reads it. */
interface WebhookEventRow {
  readonly _id: unknown;
  readonly provider: string;
  readonly env: string;
  readonly eventType: string;
  readonly providerEventId: string | null;
  readonly payloadHash: string | null;
  readonly signatureValid: boolean;
  readonly rawPayload: unknown;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processResult: string | null;
  readonly processError: string | null;
  readonly expireAt: Date;
}

/** The §14.4 `billingTransactions` row as this suite reads it. */
interface BillingTransactionRow {
  readonly _id: unknown;
  readonly tenantId: string;
  readonly subscriptionId: unknown;
  readonly kind: string;
  readonly status: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly failure: { readonly code?: string; readonly category?: string } | null;
  readonly idempotencyKey: string;
  readonly externalRefs: readonly ProviderRef[];
  readonly occurredAt: Date;
  readonly settledAt: Date | null;
  readonly periodCovered: { readonly start: Date; readonly end: Date } | null;
  readonly invoiceNumber: string | null;
  readonly rawPayloadRef: unknown;
}

let app: TestApp;

/** The process logger in place before the log-hygiene spec replaces it. */
let ambientLogger: ReturnType<typeof getLogger>;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op108-webhooks", env: PAYMENTS_ENV });
  // The unique indexes of §18.4 **are** the deduplication, so the suite builds
  // the declared registry against its private database first. Without this a
  // replay inserts twice and every dedupe pin is vacuous.
  await ensureIndexes(app.db);
  ambientLogger = getLogger();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  afterMock.mockClear();
  // The `platformSettings` singleton is process-cached and shared by the whole
  // file: drop the document and the cache so each case starts from the
  // documented defaults (14 grace days, 90-day webhook retention).
  await settingsCollection().deleteMany({});
  invalidatePlatformSettings();
});

afterEach(() => {
  setLogger(ambientLogger);
});

/** The origin-relative URL of one provider's inbox. */
function webhookUrl(provider = "cashfree"): string {
  return new URL(`${WEBHOOKS_PATH}/${provider}`, APP_ORIGIN).toString();
}

/** A `POST` to the inbox: a raw body, its signature headers, and no session. */
function webhookRequest(options: {
  readonly rawBody: string;
  readonly headers?: Record<string, string>;
  readonly provider?: string;
}): Request {
  return new Request(webhookUrl(options.provider ?? "cashfree"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.rawBody,
  });
}

/** The `platformSettings` singleton document: a string `_id` plus the settings tree. */
type StoredSettings = Document & { readonly _id: string };

/** Open the `platformSettings` singleton with its string `_id` typed (the OP-82 precedent). */
function settingsCollection() {
  return app.db.collection<StoredSettings>("platformSettings");
}

/** The factory's optional-valued header map as the plain record a `Request` accepts. */
function asHeaders(headers: WebhookHeaders): Record<string, string> {
  return { ...headers } as Record<string, string>;
}

/** Sign `rawBody` the Cashfree way, at the given epoch-ms instant. */
function signedHeaders(rawBody: string, timestampMs: number = Date.now()): Record<string, string> {
  return asHeaders(
    makeCashfreeWebhookHeaders(TEST_CASHFREE_WEBHOOK_SECRET, String(timestampMs), rawBody)
  );
}

/** An ISO instant a fixed number of minutes before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** A `SUBSCRIPTION_AUTH_STATUS` success body — the mandate authorization (§10.1.2). */
function activationBody(eventTime = minutesAgo(5)): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_AUTH_STATUS", {
    subscriptionDetails: { subscription_status: VENDOR_ACTIVE },
    authorizationDetails: { authorization_status: "SUCCESS" },
    eventTime,
    extraData: {
      payment_id: "ab-auth-001",
      cf_payment_id: "49988825",
      payment_type: "AUTH",
      payment_status: "SUCCESS",
      payment_amount: 2,
      payment_currency: "INR",
    },
  });
}

/** A `SUBSCRIPTION_PAYMENT_SUCCESS` body for one charge (₹499 → `49900`). */
function paymentSucceededBody(paymentId: string, eventTime = minutesAgo(5)): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
    subscriptionDetails: { subscription_status: VENDOR_ACTIVE },
    eventTime,
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

/** A `SUBSCRIPTION_PAYMENT_FAILED` body for one charge, with a mapped category. */
function paymentFailedBody(
  paymentId: string,
  options: { readonly eventTime?: string; readonly failureReason?: string } = {}
): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_FAILED", {
    subscriptionDetails: { subscription_status: VENDOR_ACTIVE },
    eventTime: options.eventTime ?? minutesAgo(5),
    extraData: {
      payment_id: `ab-${paymentId}`,
      cf_payment_id: paymentId,
      payment_type: "CHARGE",
      payment_status: "FAILED",
      payment_amount: 499,
      payment_currency: "INR",
      failure_details: { failure_reason: options.failureReason ?? "MANDATE_REVOKED" },
    },
  });
}

/** A `SUBSCRIPTION_STATUS_CHANGED` body — carries no provider event id (§10.1 step 3). */
function statusChangedBody(vendorStatus: string, eventTime = minutesAgo(5)): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED", {
    subscriptionDetails: { subscription_status: vendorStatus },
    eventTime,
  });
}

/** A random hex tenant id: the inbox is platform-scoped, so no tenant row is needed. */
function newTenantId(): string {
  return new ObjectId().toHexString();
}

/** Seed one `subscriptions` row (schema §14.3) and return its id. */
async function seedSubscription(options: {
  readonly tenantId: string;
  readonly status?: SubscriptionStatus;
  readonly mandateStatus?: string;
  readonly refs?: readonly ProviderRef[];
  readonly currentPeriodEnd?: Date | null;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  const row: SubscriptionRow = {
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: options.status ?? "incomplete",
    priceKey: "starter-monthly-inr",
    paymentMethodKind: "mandate_upi",
    mandateStatus: options.mandateStatus ?? "pending",
    billingCycle: "monthly",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: options.currentPeriodEnd ?? null,
    nextChargeAt: null,
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    externalRefs: options.refs ?? [SUBSCRIPTION_REF],
  };
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({ ...row });
  return _id;
}

/** Read the seeded subscription back, failing loudly when the row vanished. */
async function readSubscription(subscriptionId: ObjectId): Promise<SubscriptionRow> {
  const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
  expect(row).not.toBeNull();
  return row as unknown as SubscriptionRow;
}

/** Every `providerWebhookEvents` row this suite wrote, oldest first. */
async function webhookRows(): Promise<readonly WebhookEventRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.providerWebhookEvents)
    .find({ provider: "cashfree" })
    .sort({ receivedAt: 1 })
    .toArray();
  return rows as unknown as WebhookEventRow[];
}

/** The most recently received inbox row, failing loudly when there is none. */
async function latestWebhookRow(): Promise<WebhookEventRow> {
  const rows = await webhookRows();
  const last = rows.at(-1);
  if (last === undefined) {
    throw new Error("expected at least one providerWebhookEvents row");
  }
  return last;
}

/** The `billingTransactions` rows for one tenant, oldest first. */
async function ledgerRows(tenantId: string): Promise<readonly BillingTransactionRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.billingTransactions)
    .find({ tenantId })
    .sort({ occurredAt: 1 })
    .toArray();
  return rows as unknown as BillingTransactionRow[];
}

/** The `sha256` digest of a raw body, whatever prefix convention the row uses. */
function digestOf(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Run every callback the route deferred, exactly as Next.js does once the
 * response has been sent.
 */
async function drainDeferredProjections(): Promise<void> {
  const callbacks = afterMock.mock.calls.map((call) => call[0]);
  afterMock.mockClear();
  await Promise.all(callbacks.map((callback) => callback()));
}

describe("POST /api/v1/webhooks/{provider} — acknowledgement and projection", () => {
  it("I1: a valid signed activation is 200 received, and the subscription is active only after the deferred projection", async () => {
    // Arrange
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({ tenantId });
    const rawBody = activationBody();
    const before = Date.now();

    // Act — the provider's POST.
    const response = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    const after = Date.now();

    // Assert — §10.1 step 5: acknowledged first, with the pinned receipt body.
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });
    expect(response.headers.get("cache-control")).toBe("no-store");

    // …and the projection has not run yet: accessing state is the second step.
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "incomplete" });
    expect(await ledgerRows(tenantId)).toEqual([]);

    // The §18.4 inbox row is written before the response: identity, signature
    // verdict, retention and the raw payload the sweep re-projects from.
    const recorded = await latestWebhookRow();
    expect(recorded).toMatchObject({
      provider: "cashfree",
      env: "sandbox",
      eventType: "subscription_activated",
      providerEventId: "49988825",
      signatureValid: true,
      processedAt: null,
      processResult: null,
    });
    expect(recorded.receivedAt).toBeInstanceOf(Date);
    expect(recorded.expireAt.getTime()).toBeGreaterThanOrEqual(
      before + WEBHOOK_TTL_DAYS * MS_PER_DAY
    );
    expect(recorded.expireAt.getTime()).toBeLessThanOrEqual(after + WEBHOOK_TTL_DAYS * MS_PER_DAY);
    expect(JSON.stringify(recorded.rawPayload)).toContain(SUBSCRIPTION_REF_ID);

    // Act — the post-response projection.
    await drainDeferredProjections();

    // Assert — money and access moved together (§23).
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "active",
      mandateStatus: "active",
    });
    const activated = await readSubscription(subscriptionId);
    expect(activated.currentPeriodStart).toBeInstanceOf(Date);
    expect(activated.currentPeriodEnd).toBeInstanceOf(Date);
    expect(activated.nextChargeAt).toBeInstanceOf(Date);
    expect(activated.currentPeriodEnd?.getTime()).toBeGreaterThan(
      activated.currentPeriodStart?.getTime() ?? 0
    );

    const ledger = await ledgerRows(tenantId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "authorization",
      status: "succeeded",
      amountMinor: 200,
      currency: "INR",
    });
    expect(String(ledger[0]?.subscriptionId)).toBe(subscriptionId.toHexString());
    // §14.4: the ledger *references* the raw payload instead of copying it.
    expect(String(ledger[0]?.rawPayloadRef)).toBe(String(recorded._id));

    const processed = await latestWebhookRow();
    expect(processed.processedAt).toBeInstanceOf(Date);
    expect(processed.processResult).toBe("applied");
    expect(processed.processError ?? null).toBeNull();
  });

  it("I2: a replayed payment payload is 200 duplicate_ignored and never reprocesses", async () => {
    // Arrange — one subscription, one charge, delivered twice byte-identically.
    const tenantId = newTenantId();
    await seedSubscription({ tenantId, status: "active", mandateStatus: "active" });
    const rawBody = paymentSucceededBody("49914526");

    // Act
    const first = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();
    const second = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({ status: "received" });
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual({ status: "duplicate_ignored" });
    expect(await webhookRows()).toHaveLength(1);
    expect(await ledgerRows(tenantId)).toHaveLength(1);
    expect((await latestWebhookRow()).processResult).toBe("applied");
  });

  it("I2: an id-less event is deduplicated by its payload hash", async () => {
    // Arrange — a status change carries no vendor event id (§10.1 step 3), so
    // identity is `sha256(rawBody)`.
    const tenantId = newTenantId();
    await seedSubscription({ tenantId });
    const rawBody = statusChangedBody("BANK_APPROVAL_PENDING");

    // Act
    const first = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();
    const second = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert
    expect(await body(first)).toEqual({ status: "received" });
    expect(await body(second)).toEqual({ status: "duplicate_ignored" });
    expect(await webhookRows()).toHaveLength(1);
    const recorded = await latestWebhookRow();
    expect(recorded.providerEventId).toBeNull();
    // The hash *value* is pinned exactly; the `sha256:` prefix convention of
    // §18.4's example stays the implementation's choice.
    expect(String(recorded.payloadHash).replace(/^sha256:/, "")).toBe(digestOf(rawBody));
  });

  it("I2: two different id-less events both insert and both project", async () => {
    // Arrange — `{provider, providerEventId}` may only be unique for payloads
    // that *carry* an id (§18.4); the id-less rows are held apart by the payload
    // hash. A plain unique index here would swallow every second status change.
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({ tenantId });
    const approved = statusChangedBody("BANK_APPROVAL_PENDING", minutesAgo(30));
    const cancelled = statusChangedBody("CUSTOMER_CANCELLED", minutesAgo(10));

    // Act
    const first = await receiveWebhook(
      webhookRequest({ rawBody: approved, headers: signedHeaders(approved) })
    );
    const second = await receiveWebhook(
      webhookRequest({ rawBody: cancelled, headers: signedHeaders(cancelled) })
    );
    await drainDeferredProjections();

    // Assert
    expect(await body(first)).toEqual({ status: "received" });
    expect(await body(second)).toEqual({ status: "received" });
    expect(await webhookRows()).toHaveLength(2);
    expect((await webhookRows()).map((row) => row.processResult)).toEqual(["applied", "applied"]);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "cancelled" });
  });

  it("the exported projection seam re-projects a row the route left unprocessed", async () => {
    // Arrange — the route records and defers; here the deferred run is dropped,
    // which is exactly the state OP-111's `webhook-projection-sweep` picks up.
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({ tenantId });
    const rawBody = activationBody();
    await receiveWebhook(webhookRequest({ rawBody, headers: signedHeaders(rawBody) }));

    const recorded = await latestWebhookRow();
    expect(recorded.processedAt).toBeNull();

    // Act — the sweep's entry point, with an explicit database seam.
    await projectProviderWebhookEvent(String(recorded._id), { db: app.db });

    // Assert
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "active" });
    expect(await ledgerRows(tenantId)).toHaveLength(1);
    expect((await latestWebhookRow()).processResult).toBe("applied");
  });

  it("an inbox for a provider this deployment has no adapter for refuses the request and writes nothing", async () => {
    // Arrange
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({ tenantId });
    const rawBody = activationBody();
    const rowsBefore = (await webhookRows()).length;

    // Act — "stripe" is not a registered payment adapter.
    const response = await receiveWebhook(
      webhookRequest({ provider: "stripe", rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — an unroutable provider is a client error, never a crash, and the
    // inbox stays empty either way.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await webhookRows()).toHaveLength(rowsBefore);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "incomplete" });
    expect(await ledgerRows(tenantId)).toEqual([]);
  });
});

describe("POST /api/v1/webhooks/{provider} — signature verification", () => {
  it("I3: a body that was modified after signing is 401 invalid_signature and writes nothing", async () => {
    // Arrange
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({ tenantId });
    const rawBody = activationBody();
    const tampered = rawBody.replace(SUBSCRIPTION_REF_ID, "sub_test_999");
    const rowsBefore = (await webhookRows()).length;

    // Act
    const response = await receiveWebhook(
      webhookRequest({ rawBody: tampered, headers: signedHeaders(rawBody) })
    );

    // Assert
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ error: { code: "invalid_signature" } });
    expect(await webhookRows()).toHaveLength(rowsBefore);
    expect(await readSubscription(subscriptionId)).toMatchObject({ status: "incomplete" });
    expect(await ledgerRows(tenantId)).toEqual([]);
  });

  it("I3: a body signed with another secret is 401 invalid_signature and writes nothing", async () => {
    // Arrange
    const tenantId = newTenantId();
    await seedSubscription({ tenantId });
    const rawBody = activationBody();
    const rowsBefore = (await webhookRows()).length;
    const forged = makeCashfreeWebhookHeaders(
      "not-the-webhook-secret",
      String(Date.now()),
      rawBody
    );

    // Act
    const response = await receiveWebhook(webhookRequest({ rawBody, headers: asHeaders(forged) }));

    // Assert
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ error: { code: "invalid_signature" } });
    expect(await webhookRows()).toHaveLength(rowsBefore);
    expect(await ledgerRows(tenantId)).toEqual([]);
  });

  it("I3: a request with no signature headers at all is 401 invalid_signature and writes nothing", async () => {
    // Arrange
    const tenantId = newTenantId();
    await seedSubscription({ tenantId });
    const rowsBefore = (await webhookRows()).length;

    // Act
    const response = await receiveWebhook(webhookRequest({ rawBody: activationBody() }));

    // Assert
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ error: { code: "invalid_signature" } });
    expect(await webhookRows()).toHaveLength(rowsBefore);
    expect(await ledgerRows(tenantId)).toEqual([]);
  });

  it("I3: a correctly signed body outside the ±300 s replay window is 401 stale_signature", async () => {
    // Arrange — both directions of the window, so neither is a silent pass.
    const tenantId = newTenantId();
    await seedSubscription({ tenantId });
    const staleBody = activationBody();
    const futureBody = activationBody(minutesAgo(-5));
    const rowsBefore = (await webhookRows()).length;

    // Act
    const stale = await receiveWebhook(
      webhookRequest({
        rawBody: staleBody,
        headers: signedHeaders(staleBody, Date.now() - REPLAY_WINDOW_MS - 60_000),
      })
    );
    const future = await receiveWebhook(
      webhookRequest({
        rawBody: futureBody,
        headers: signedHeaders(futureBody, Date.now() + REPLAY_WINDOW_MS + 60_000),
      })
    );

    // Assert
    expect(stale.status).toBe(401);
    expect(await body(stale)).toMatchObject({ error: { code: "stale_signature" } });
    expect(future.status).toBe(401);
    expect(await body(future)).toMatchObject({ error: { code: "stale_signature" } });
    expect(await webhookRows()).toHaveLength(rowsBefore);
    expect(await ledgerRows(tenantId)).toEqual([]);
  });

  it("I3: a rejected signature warns with the provider and never logs the payload or the client IP", async () => {
    // Arrange — the fixture body carries a real customer email and phone; the
    // §0.15 / CONVENTIONS §5.3 rules apply to the log sink as much as to a body.
    const sink = memoryTransport();
    setLogger(
      createLogger({
        level: "trace",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
        base: { requestId: "req-op108-invalid-signature" },
      })
    );
    const tenantId = newTenantId();
    await seedSubscription({ tenantId });
    const rawBody = activationBody();
    const rowsBefore = (await webhookRows()).length;

    // Act
    const response = await receiveWebhook(
      webhookRequest({
        rawBody,
        headers: { ...signedHeaders(rawBody), "x-forwarded-for": CLIENT_IP },
      })
    );

    // Assert
    expect(response.status).toBe(401);
    const warnings = sink.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toContainEqual(expect.objectContaining({ provider: "cashfree" }));
    expectNoSecretsInLogs(sink);
    expect(JSON.stringify(sink.entries)).not.toContain(CLIENT_IP);
    expect(await webhookRows()).toHaveLength(rowsBefore);
  });
});

describe("POST /api/v1/webhooks/{provider} — environment isolation", () => {
  it("I4: a sandbox event for a production subscription is recorded and ignored, never projected", async () => {
    // Arrange — §11.1: every ref carries its environment, and a sandbox event
    // must never reach a production subscription's state.
    const tenantId = newTenantId();
    const productionRef: ProviderRef = {
      provider: "cashfree",
      env: "production",
      kind: "subscription",
      id: SUBSCRIPTION_REF_ID,
    };
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "incomplete",
      refs: [productionRef],
    });
    const rawBody = activationBody();

    // Act
    const response = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    await drainDeferredProjections();

    // Assert — the inbox keeps the raw record, the projection refuses the move.
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: "incomplete",
      mandateStatus: "pending",
    });
    expect(await ledgerRows(tenantId)).toEqual([]);
    const recorded = await latestWebhookRow();
    expect(recorded.processResult).toBe("ignored");
    expect(recorded.processedAt).toBeInstanceOf(Date);
  });
});

describe("POST /api/v1/webhooks/{provider} — dunning from settings", () => {
  it("I6: a failed charge is past_due with the default 14-day grace and the amount attempted", async () => {
    // Arrange
    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      mandateStatus: "active",
    });
    const rawBody = paymentFailedBody("49914527");
    const before = Date.now();

    // Act
    const response = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    const after = Date.now();
    await drainDeferredProjections();

    // Assert
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "received" });
    const dunned = await readSubscription(subscriptionId);
    expect(dunned).toMatchObject({
      status: "past_due",
      pendingDueMinor: 49_900,
      dunning: { attemptCount: 1 },
    });
    expect(dunned.gracePeriodEndsAt).toBeInstanceOf(Date);
    expect(dunned.gracePeriodEndsAt?.getTime()).toBeGreaterThanOrEqual(before + 14 * MS_PER_DAY);
    expect(dunned.gracePeriodEndsAt?.getTime()).toBeLessThanOrEqual(after + 14 * MS_PER_DAY);

    const ledger = await ledgerRows(tenantId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "charge",
      status: "failed",
      amountMinor: 49_900,
      currency: "INR",
      failure: { category: "mandate_revoked" },
    });
    expect((await latestWebhookRow()).processResult).toBe("applied");
  });

  it("I6: after the operator sets gracePeriodDays to 7 the same event duns for 7 days", async () => {
    // Arrange — the tunable is data, not a constant (§9.10, CONVENTIONS §6):
    // write the singleton, invalidate the read cache, and drive the same event.
    await settingsCollection().insertOne({
      _id: "singleton",
      ...PLATFORM_SETTINGS_DEFAULTS,
      dunning: {
        ...PLATFORM_SETTINGS_DEFAULTS.dunning,
        gracePeriodDays: 7,
        reminderDays: [1, 5],
      },
      updatedAt: new Date().toISOString(),
      updatedByUserId: null,
    });
    invalidatePlatformSettings();

    const tenantId = newTenantId();
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      mandateStatus: "active",
    });
    const rawBody = paymentFailedBody("49914527");
    const before = Date.now();

    // Act
    const response = await receiveWebhook(
      webhookRequest({ rawBody, headers: signedHeaders(rawBody) })
    );
    const after = Date.now();
    await drainDeferredProjections();

    // Assert
    expect(response.status).toBe(200);
    const dunned = await readSubscription(subscriptionId);
    expect(dunned).toMatchObject({ status: "past_due" });
    expect(dunned.gracePeriodEndsAt).toBeInstanceOf(Date);
    expect(dunned.gracePeriodEndsAt?.getTime()).toBeGreaterThanOrEqual(before + 7 * MS_PER_DAY);
    expect(dunned.gracePeriodEndsAt?.getTime()).toBeLessThanOrEqual(after + 7 * MS_PER_DAY);
  });
});

describe("POST /api/v1/webhooks/{provider} — out-of-order delivery", () => {
  it("I7: a failure that arrives after a later success does not roll the subscription back", async () => {
    // Arrange — a paid-up row, then a renewal success at T+1h and a charge
    // failure *for an earlier instant* arriving later (§10.1 step 6 orders by
    // the provider's `occurredAt`, never by arrival).
    const tenantId = newTenantId();
    const seededPeriodEnd = new Date(Date.now() + 10 * MS_PER_DAY);
    const subscriptionId = await seedSubscription({
      tenantId,
      status: "active",
      mandateStatus: "active",
      currentPeriodEnd: seededPeriodEnd,
    });
    const successBody = paymentSucceededBody("49914526", minutesAgo(60));
    const lateFailureBody = paymentFailedBody("49914527", { eventTime: minutesAgo(120) });

    // Act — the later success first…
    const success = await receiveWebhook(
      webhookRequest({ rawBody: successBody, headers: signedHeaders(successBody) })
    );
    await drainDeferredProjections();
    const renewed = await readSubscription(subscriptionId);

    // …then the older failure.
    const lateFailure = await receiveWebhook(
      webhookRequest({ rawBody: lateFailureBody, headers: signedHeaders(lateFailureBody) })
    );
    await drainDeferredProjections();

    // Assert
    expect(await body(success)).toEqual({ status: "received" });
    expect(renewed.status).toBe("active");
    expect(renewed.currentPeriodEnd?.getTime()).toBeGreaterThan(seededPeriodEnd.getTime());

    expect(await body(lateFailure)).toEqual({ status: "received" });
    const afterLateFailure = await readSubscription(subscriptionId);
    expect(afterLateFailure).toMatchObject({
      status: "active",
      gracePeriodEndsAt: null,
      pendingDueMinor: 0,
    });
    expect((await latestWebhookRow()).processResult).toBe("ignored");
    const failures = (await ledgerRows(tenantId)).filter((row) => row.status === "failed");
    expect(failures).toEqual([]);
  });
});
