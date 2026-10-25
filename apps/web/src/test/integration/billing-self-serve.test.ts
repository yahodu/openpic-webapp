import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

/**
 * `next/server`'s `after` is the seam the webhook inbox defers its projection
 * through (§10.1 step 5/6). The mock is hoisted above the module graph so the
 * inbox route binds to it on import; the default is inert, which is what lets a
 * case assert the scheduling call and then run the deferred work itself — the
 * pattern `provider-webhook-inbox.test.ts` established.
 */
const afterMock = vi.hoisted(() => vi.fn<(callback: () => unknown) => void>());

vi.mock("next/server", () => ({ after: afterMock }));

import { POST as purchaseAddon } from "@/app/api/v1/tenants/[tenantId]/billing/addons/route";
import { POST as cancelSubscription } from "@/app/api/v1/tenants/[tenantId]/billing/cancel/route";
import { GET as getInvoice } from "@/app/api/v1/tenants/[tenantId]/billing/invoices/[invoiceNumber]/route";
import { POST as retryCharge } from "@/app/api/v1/tenants/[tenantId]/billing/retry-charge/route";
import { GET as listTransactions } from "@/app/api/v1/tenants/[tenantId]/billing/transactions/route";
import { POST as receiveWebhook } from "@/app/api/v1/webhooks/[provider]/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { Plan } from "@/server/plans/plans";
import type {
  ProviderRef,
  SubscriptionStatus,
  WebhookHeaders,
} from "@/server/payments/payment-provider";
import { checkEntitlement } from "@/server/services/entitlements";

import { makeAddon, type StoredAddon } from "../factories/addon";
import { makeEntitlement, makePlan } from "../factories/plan";
import {
  makeCashfreeChargeResponse,
  makeCashfreeCreateSubscriptionResponse,
  makeCashfreeWebhookBody,
  makeCashfreeWebhookHeaders,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { server } from "./setup";

/**
 * Integration / contract — the self-serve billing surface
 * (OP-110 RED, contract §3.3/§3.4/§3.6, schema §14.2/§14.4; ADR-0480).
 *
 * The user story: *as a tenant owner I want to pay dues, cancel, view my
 * billing history and buy add-ons so that I can manage billing self-serve.*
 *
 *   - `POST   /api/v1/tenants/{tenantId}/billing/retry-charge` (owner, idempotent)
 *   - `POST   /api/v1/tenants/{tenantId}/billing/cancel`       (owner)
 *   - `GET    /api/v1/tenants/{tenantId}/billing/transactions` (owner|admin)
 *   - `GET    /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}` (owner|admin)
 *   - `POST   /api/v1/tenants/{tenantId}/billing/addons`       (owner, idempotent)
 *
 *   I1  a retry with nothing due is `409 no_pending_due` and never reaches the
 *       provider;
 *   I2  a retry on a revoked mandate is `409 mandate_not_chargeable` carrying
 *       `details.recoveryAction: "recreate_mandate"`, and never reaches the
 *       provider;
 *   I3  a retry's success webhook returns the workspace to `active` and emits
 *       `billing.subscription.reactivated` + `usage.limit.restored`;
 *   I4  the transactions list is `occurredAt` desc, paginates with the shared
 *       cursor envelope, filters by `kind`, and passes the never-return scanner;
 *   I5  an add-on's confirmation webhook inserts an **additive**
 *       `entitlementGrants` row, emits `billing.addon.purchased`, and the
 *       entitlement's `effectiveLimit` reflects the grant.
 *
 * Around those: the §3.3 owner-only gate on every mutation (a `member` **and**
 * an `admin` are `403`, a non-member the uniform `404`), the required
 * `Idempotency-Key` on the two idempotent mutations, the `202` retry receipt,
 * the cancel's "status becomes cancelled only via webhook" rule, and the
 * invoice endpoint's `404` when no asset exists.
 *
 * ## Contract expected of the implementation
 *
 * - The five route modules export `POST` / `POST` / `GET` / `GET` / `POST`,
 *   declared `defineRoute({ route: "/api/v1/tenants/:tenantId/billing/…", … })`
 *   with `userAuth()`, the reusable `tenantStage()` and — for `retry-charge` and
 *   `addons` — the idempotency stage (`mongoIdempotencyStore()`,
 *   `required: true`). The owner gate is folded into the `tenant` stage slot
 *   (`ownerOnlyTenant()`, the OP-109 pattern): §0.9's idempotency stage runs
 *   **before** the handler, so a `member`/`admin` must be `403` rather than
 *   `400 idempotency_key_required`.
 * - `@/server/services/subscriptions/retry-charge` exports the pure
 *   `decideRetryEligibility` (pinned by `src/test/unit/retry-charge.test.ts`).
 * - `@/server/services/subscriptions/transactions` exports the pure
 *   `toTransactionDto` (pinned by `src/test/unit/billing-transactions.test.ts`).
 * - A one-time charge — the retry and the add-on purchase — is a
 *   `billingTransactions` row at `status: "pending"` written **before** the
 *   provider call, carrying the provider `externalRefs` the confirmation
 *   webhook correlates on (§14.4).
 * - An add-on purchase snapshots its grant on that pending row under an `addon`
 *   block — `{ addonKey, entitlementKey, delta, quantity }` — so the webhook
 *   projection can write the `entitlementGrants` row without re-reading the
 *   catalogue (`delta = quantity × addon.grantDelta`, ADR-0480).
 * - The add-on catalogue document gains `grantDelta` (the entitlement delta one
 *   ordered quantity unit grants) — the amount ADR-0320's schema of record left
 *   unnamed.
 *
 * ## Assumptions recorded in the handoff (ADR-0480)
 *
 * - The current plan is the workspace's live `subscriptions` row's
 *   `activePlanKey`; the rows are tenant-scoped on the **string** hex `tenantId`
 *   (the OP-103/104/106/107/109 convention), so fixtures write
 *   `tenantId.toHexString()`.
 * - `no_pending_due` and `mandate_not_chargeable` are Appendix A.4 codes the
 *   server catalogue does not yet carry; they are appended to
 *   `BILLING_ERROR_CODES` (the OP-107/OP-109 precedent).
 * - The add-on response body is **not** pinned beyond its `201`: §3.6 says
 *   "checkout envelope as §3.3", but the one-time `chargeOnce` the same sentence
 *   describes returns no hosted URL, so the two halves cannot both hold
 *   literally. The pending-ledger contract is pinned instead; the response shape
 *   is an open question for the GREEN.
 * - Invoice PDF generation is out of scope (the GREEN card's open question), so
 *   only the no-asset `404` and the read's role gate are pinned.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The sandbox on-demand charge endpoint the Cashfree adapter POSTs to. */
const CASHFREE_CHARGE_URL =
  "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId/payments";

/** The pinned v2025-01-01 Manage Subscription endpoint (ADR-0460 §1). */
const CASHFREE_MANAGE_URL = "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId/manage";

/** The vendor subscription id the seeded live mandate carries. */
const VENDOR_SUBSCRIPTION_ID = "sub_op110_001";

/** The vendor payment id the charge response and the confirmation webhook share. */
const VENDOR_PAYMENT_ID = "49914527";

/** The payments selection this suite drives the routes with (the OP-107 wiring). */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The subscription ref a seeded row must carry for a webhook body to match it. */
const SUBSCRIPTION_REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: VENDOR_SUBSCRIPTION_ID,
};

/** The `returnUrl` every accepted mutation carries (an allow-listed origin). */
const RETURN_URL = new URL("/billing/return", APP_ORIGIN).toString();

/** The workspace's live period-end, the instant a period-end cancel lands on. */
const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

/** The outstanding amount a `past_due` workspace owes, in minor units. */
const DUE_MINOR = 49_900;

/** The `storage.bytes` ceiling the seeded plan gates (100 GiB). */
const STORAGE_PLAN_LIMIT = 107_374_182_400;

/** The `storage.bytes` delta one `storage-50gb` purchase grants (50 GiB). */
const STORAGE_ADDON_DELTA = 53_687_091_200;

/** The add-on the suite buys. */
const ADDON_KEY = "storage-50gb";

/** An error envelope as served. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op110-self-serve", env: PAYMENTS_ENV });
  // §3.3's one-live-row invariant is arbitrated by the partial index
  // `subscriptions_active_tenant_unique`, and §14.2's counter identity by the
  // unique `{tenantId, entitlementKey, periodKey}` index; the suite builds the
  // declared registry so those are real.
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  afterMock.mockClear();
  // The whole file shares one booted app, so each case owns its slice of the
  // database: without this a second case's `plans` seed collides on the unique
  // `plans_key_unique` index, the ledger accumulates across cases, and the
  // `domain_events` outbox's unique `dedupeKey` aborts a later projection.
  await Promise.all([
    app.db.collection(COLLECTIONS.plans).deleteMany({}),
    app.db.collection(COLLECTIONS.addons).deleteMany({}),
    app.db.collection(COLLECTIONS.subscriptions).deleteMany({}),
    app.db.collection(COLLECTIONS.billingTransactions).deleteMany({}),
    app.db.collection(COLLECTIONS.entitlementGrants).deleteMany({}),
    app.db.collection(COLLECTIONS.usageCounters).deleteMany({}),
    app.db.collection(COLLECTIONS.domainEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.providerWebhookEvents).deleteMany({}),
    app.db.collection(COLLECTIONS.idempotencyKeys).deleteMany({}),
  ]);
});

/** Merge fields into a caller's auto-provisioned `userProfiles` row. */
async function updateProfile(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { ...fields, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; ownerUserId: ObjectId }): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP110 Studio",
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

/** Seed a workspace with `userId` as a member and its `current` alias target. */
async function seedWorkspace(options: {
  userId: ObjectId;
  role: "owner" | "admin" | "member";
  slug: string;
}): Promise<ObjectId> {
  const tenantId = await insertTenant({
    slug: options.slug,
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

/** The stored `subscriptions` shape one case starts from. */
interface SeedSubscriptionOptions {
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly mandateStatus?: string;
  readonly pendingDueMinor?: number;
  readonly currentPeriodEnd?: Date;
  readonly refs?: readonly ProviderRef[];
}

/** Seed the workspace's live `subscriptions` row (schema §14.3) and return its id. */
async function seedSubscription(options: SeedSubscriptionOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: options.status,
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: options.mandateStatus ?? "active",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: options.currentPeriodEnd ?? PERIOD_END,
    nextChargeAt: options.currentPeriodEnd ?? PERIOD_END,
    gracePeriodEndsAt: null,
    pendingDueMinor: options.pendingDueMinor ?? 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [...(options.refs ?? [SUBSCRIPTION_REF])],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/** Insert one `plans` catalogue row (platform scope, schema §14.1). */
async function seedPlan(entitlements: Plan["entitlements"]): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne({ ...makePlan({ entitlements }) });
}

/** Replace the add-on catalogue with exactly `addons`. */
async function seedAddons(addons: readonly StoredAddon[]): Promise<void> {
  await app.db.collection(COLLECTIONS.addons).deleteMany({});
  if (addons.length > 0) {
    await app.db.collection(COLLECTIONS.addons).insertMany([...addons]);
  }
}

/** One stored `billingTransactions` row (§14.4). */
interface SeedTransactionOptions {
  readonly tenantId: string;
  readonly subscriptionId: ObjectId;
  readonly kind?: string;
  readonly status?: string;
  readonly amountMinor?: number;
  readonly occurredAt?: Date;
  readonly refs?: readonly ProviderRef[];
  readonly failure?: Record<string, unknown> | null;
  readonly addon?: Record<string, unknown>;
}

/** Seed one `billingTransactions` row and return its id. */
async function seedTransaction(options: SeedTransactionOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.billingTransactions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscriptionId: options.subscriptionId,
    kind: options.kind ?? "charge",
    status: options.status ?? "succeeded",
    amountMinor: options.amountMinor ?? DUE_MINOR,
    currency: "INR",
    failure: options.failure ?? null,
    idempotencyKey: randomUUID(),
    externalRefs: [...(options.refs ?? [])],
    occurredAt: options.occurredAt ?? new Date(),
    settledAt: new Date(),
    periodCovered: null,
    invoiceNumber: null,
    rawPayloadRef: null,
    createdAt: new Date(),
    ...(options.addon === undefined ? {} : { addon: options.addon }),
  });
  return _id;
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/** A mutation request against one billing route. */
function billingRequest(options: {
  readonly tenantPath: string;
  readonly route: string;
  readonly cookie?: string;
  readonly method?: "POST" | "GET";
  readonly body?: Record<string, unknown> | undefined;
  readonly idempotencyKey?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return new Request(
    new URL(`${TENANTS_PATH}/${options.tenantPath}/billing/${options.route}`, APP_ORIGIN),
    {
      method: options.method ?? "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }
  );
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

/** A `POST` to the webhook inbox: a raw body, its signature headers, no session. */
function webhookRequest(rawBody: string): Request {
  return new Request(new URL("/api/v1/webhooks/cashfree", APP_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", ...signedHeaders(rawBody) },
    body: rawBody,
  });
}

/** A `SUBSCRIPTION_PAYMENT_SUCCESS` body for one charge (₹499 → `49900`). */
function paymentSucceededBody(
  paymentId: string,
  eventTime = new Date(Date.now() - 60_000).toISOString()
): string {
  return makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
    subscriptionDetails: { subscription_status: "ACTIVE" },
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

/** Run every callback the inbox deferred, in the order it was scheduled. */
async function drainDeferredProjections(): Promise<void> {
  const callbacks = afterMock.mock.calls.map((call) => call[0]);
  afterMock.mockClear();
  for (const callback of callbacks) {
    await callback();
  }
}

/** The vendor's Manage Subscription response, as Cashfree v2025-01-01 answers it. */
function makeManageResponse(vendorSubscriptionId: string): Record<string, unknown> {
  return {
    ...makeCashfreeCreateSubscriptionResponse({
      subscription_id: vendorSubscriptionId,
      subscription_status: "CANCELLED",
    }),
    subscription_first_charge_time: null,
    next_schedule_date: null,
  };
}

/** A recorded vendor charge call. */
interface ChargeCall {
  readonly subscriptionId: string;
  readonly body: unknown;
}

/** Answer the on-demand charge, recording every call. */
function recordChargeCalls(): { readonly calls: () => readonly ChargeCall[] } {
  const calls: ChargeCall[] = [];
  server.use(
    http.post(CASHFREE_CHARGE_URL, async ({ request, params }) => {
      calls.push({ subscriptionId: String(params.subscriptionId), body: await request.json() });
      return HttpResponse.json(
        makeCashfreeChargeResponse({
          subscription_id: VENDOR_SUBSCRIPTION_ID,
          cf_payment_id: VENDOR_PAYMENT_ID,
        })
      );
    })
  );
  return { calls: () => calls };
}

/** The domain-event keys the outbox holds for one subject id, in order. */
async function emittedKeys(subjectId: string): Promise<readonly string[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ "subjectRef.id": subjectId })
    .toArray();
  return rows.map((row) => String(row.eventKey));
}

/** A tenant path plus an owner, ready for a billing request. */
async function ownerWorkspace(slug: string): Promise<{ tenantPath: string; owner: SignedInUser }> {
  const owner = await app.signIn(makeIdentity("op110-owner"));
  const tenantId = await seedWorkspace({ userId: owner.userId, role: "owner", slug });
  return { tenantPath: tenantId.toHexString(), owner };
}

describe("POST /api/v1/tenants/{tenantId}/billing/retry-charge", () => {
  it("I1: refuses a retry with nothing due as 409 no_pending_due, without calling the provider", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-retry-no-due");
    await seedSubscription({ tenantId: tenantPath, status: "active", pendingDueMinor: 0 });
    const provider = recordChargeCalls();

    const response = await retryCharge(
      billingRequest({
        tenantPath,
        route: "retry-charge",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(409);
    expect(await errorEnvelope(response)).toMatchObject({ code: "no_pending_due" });
    expect(provider.calls()).toEqual([]);
  });

  it("I2: refuses a retry on a revoked mandate as 409 mandate_not_chargeable with the recovery action", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-retry-revoked");
    await seedSubscription({
      tenantId: tenantPath,
      status: "past_due",
      mandateStatus: "revoked",
      pendingDueMinor: DUE_MINOR,
    });
    const provider = recordChargeCalls();

    const response = await retryCharge(
      billingRequest({
        tenantPath,
        route: "retry-charge",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(409);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "mandate_not_chargeable" });
    expect(error.details).toMatchObject({ recoveryAction: "recreate_mandate" });
    expect(provider.calls()).toEqual([]);
  });

  it("charges the outstanding amount once and answers the 202 receipt with a pending transaction", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-retry-success");
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "past_due",
      mandateStatus: "active",
      pendingDueMinor: DUE_MINOR,
    });
    const provider = recordChargeCalls();

    const response = await retryCharge(
      billingRequest({
        tenantPath,
        route: "retry-charge",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(202);
    const payload = await body(response);
    expect(payload).toMatchObject({ status: "charge_initiated" });
    expect(typeof payload.billingTransactionId).toBe("string");
    expect(typeof payload.pollUrl).toBe("string");

    // The vendor was charged once, for the amount that was due, against the
    // workspace's live mandate.
    const calls = provider.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subscriptionId).toBe(VENDOR_SUBSCRIPTION_ID);
    expect(calls[0]?.body).toMatchObject({ payment_amount: 499 });

    // The receipt names a `pending` ledger row that exists (§14.4, append-only).
    const pending = await app.db
      .collection(COLLECTIONS.billingTransactions)
      .findOne({ _id: new ObjectId(String(payload.billingTransactionId)) });
    expect(pending).not.toBeNull();
    expect(pending).toMatchObject({
      kind: "charge",
      status: "pending",
      amountMinor: DUE_MINOR,
    });
    expect(String(pending?.subscriptionId)).toBe(subscriptionId.toHexString());
  });

  it("replays a retry under the same Idempotency-Key without charging twice", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-retry-replay");
    await seedSubscription({
      tenantId: tenantPath,
      status: "past_due",
      mandateStatus: "active",
      pendingDueMinor: DUE_MINOR,
    });
    const provider = recordChargeCalls();
    const idempotencyKey = randomUUID();
    const request = (): Request =>
      billingRequest({
        tenantPath,
        route: "retry-charge",
        cookie: owner.cookie,
        idempotencyKey,
      });

    const first = await retryCharge(request());
    expect(first.status).toBe(202);
    const firstBody = await body(first);

    const second = await retryCharge(request());

    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await body(second)).toEqual(firstBody);
    expect(provider.calls()).toHaveLength(1);
  });

  it("requires an Idempotency-Key header", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-retry-no-key");
    await seedSubscription({
      tenantId: tenantPath,
      status: "past_due",
      mandateStatus: "active",
      pendingDueMinor: DUE_MINOR,
    });

    const response = await retryCharge(
      billingRequest({ tenantPath, route: "retry-charge", cookie: owner.cookie })
    );

    expect(response.status).toBe(400);
    expect(await errorEnvelope(response)).toMatchObject({ code: "idempotency_key_required" });
  });
});

describe("POST /api/v1/tenants/{tenantId}/billing/cancel", () => {
  it("asks the provider to cancel and answers the 200 receipt, leaving the status to the webhook", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-cancel");
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "active",
      currentPeriodEnd: PERIOD_END,
    });
    const calls: unknown[] = [];
    server.use(
      http.post(CASHFREE_MANAGE_URL, async ({ request, params }) => {
        calls.push({ subscriptionId: String(params.subscriptionId), body: await request.json() });
        return HttpResponse.json(makeManageResponse(VENDOR_SUBSCRIPTION_ID));
      })
    );

    const response = await cancelSubscription(
      billingRequest({
        tenantPath,
        route: "cancel",
        cookie: owner.cookie,
        body: { atPeriodEnd: true, reason: "too expensive" },
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload).toMatchObject({ status: "active", cancelAt: PERIOD_END.toISOString() });
    // §3.3's reassurance is the point of the response: nothing is deleted.
    expect(String(payload.note)).toMatch(/not deleted/i);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subscriptionId: VENDOR_SUBSCRIPTION_ID,
      body: { subscription_id: VENDOR_SUBSCRIPTION_ID, action: "CANCEL" },
    });

    // The status becomes `cancelled` only when the provider confirms it.
    const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
    expect(row).toMatchObject({ status: "active", cancelledAt: null });
    expect(new Date(row?.cancelAt as Date).getTime()).toBe(PERIOD_END.getTime());
  });
});

describe("POST /api/v1/webhooks/{provider} — the retry confirmation", () => {
  it("I3: a retry success returns the workspace to active and emits the restored events", async () => {
    const { tenantPath } = await ownerWorkspace("op110-retry-webhook");
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "past_due",
      mandateStatus: "active",
      pendingDueMinor: DUE_MINOR,
    });
    const rawBody = paymentSucceededBody(VENDOR_PAYMENT_ID);

    const response = await receiveWebhook(webhookRequest(rawBody));
    expect(response.status).toBe(200);
    await drainDeferredProjections();

    const row = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: subscriptionId });
    expect(row).toMatchObject({
      status: "active",
      pendingDueMinor: 0,
      gracePeriodEndsAt: null,
    });
    expect(row?.activePlanKey).toBe(row?.subscribedPlanKey);

    const keys = await emittedKeys(subscriptionId.toHexString());
    expect(keys).toContain("billing.subscription.reactivated");
    expect(keys).toContain("usage.limit.restored");
  });
});

describe("GET /api/v1/tenants/{tenantId}/billing/transactions", () => {
  it("I4: lists the ledger occurredAt desc, paginates and passes the never-return scanner", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-transactions");
    const subscriptionId = await seedSubscription({ tenantId: tenantPath, status: "active" });
    const newest = await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      occurredAt: new Date("2026-10-03T10:00:00.000Z"),
      failure: {
        code: "MANDATE_REVOKED",
        message: "Your bank declined the debit.",
        providerCode: "MANDATE_REVOKED",
        category: "mandate_revoked",
        retryable: false,
      },
      status: "failed",
    });
    const middle = await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      occurredAt: new Date("2026-10-02T10:00:00.000Z"),
    });
    const oldest = await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    });

    const first = await listTransactions(
      billingRequest({
        tenantPath,
        route: "transactions?limit=2",
        cookie: owner.cookie,
        method: "GET",
      })
    );

    expect(first.status).toBe(200);
    const firstText = await first.text();
    const firstPage = JSON.parse(firstText) as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null; hasMore: boolean; limit: number };
    };
    expect(firstPage.data.map((row) => row.id)).toEqual([
      newest.toHexString(),
      middle.toHexString(),
    ]);
    expect(firstPage.page).toMatchObject({ hasMore: true, limit: 2 });
    expect(typeof firstPage.page.nextCursor).toBe("string");

    // §0.15: the vendor's own code is never exposed, and the shared scanner
    // agrees — on a non-empty page, so the scan is not vacuously green.
    expect(firstText).not.toContain("providerCode");
    expect(firstText).not.toContain("MANDATE_REVOKED");
    expect(findForbiddenFields(JSON.parse(firstText), "default")).toEqual([]);

    const second = await listTransactions(
      billingRequest({
        tenantPath,
        route: `transactions?limit=2&cursor=${encodeURIComponent(String(firstPage.page.nextCursor))}`,
        cookie: owner.cookie,
        method: "GET",
      })
    );

    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null; hasMore: boolean };
    };
    expect(secondPage.data.map((row) => row.id)).toEqual([oldest.toHexString()]);
    expect(secondPage.page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("I4: filters the ledger by kind", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-transactions-kind");
    const subscriptionId = await seedSubscription({ tenantId: tenantPath, status: "active" });
    await seedTransaction({ tenantId: tenantPath, subscriptionId, kind: "charge" });
    const refund = await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      kind: "refund",
      occurredAt: new Date("2026-10-05T10:00:00.000Z"),
    });

    const response = await listTransactions(
      billingRequest({
        tenantPath,
        route: "transactions?kind=refund",
        cookie: owner.cookie,
        method: "GET",
      })
    );

    expect(response.status).toBe(200);
    const page = (await response.json()) as { data: Array<{ id: string; kind: string }> };
    expect(page.data.map((row) => row.id)).toEqual([refund.toHexString()]);
    expect(page.data.map((row) => row.kind)).toEqual(["refund"]);
  });

  it("an admin may read the ledger", async () => {
    const owner = await app.signIn(makeIdentity("op110-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op110-transactions-admin",
    });
    const admin = await app.signIn(makeIdentity("op110-admin"));
    await addMember(tenantId, admin, "admin");

    const response = await listTransactions(
      billingRequest({
        tenantPath: tenantId.toHexString(),
        route: "transactions",
        cookie: admin.cookie,
        method: "GET",
      })
    );

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
  });
});

describe("GET /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}", () => {
  it("answers 404 when no stored invoice asset carries the number", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-invoices-missing");

    const response = await getInvoice(
      billingRequest({
        tenantPath,
        route: "invoices/OP-2026-000431",
        cookie: owner.cookie,
        method: "GET",
      })
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });
});

describe("POST /api/v1/tenants/{tenantId}/billing/addons", () => {
  it("charges once and records the pending add-on intent the confirmation webhook projects", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-addon-purchase");
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "active",
      mandateStatus: "active",
    });
    await seedAddons([makeAddon()]);
    const provider = recordChargeCalls();

    const response = await purchaseAddon(
      billingRequest({
        tenantPath,
        route: "addons",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: { addonKey: ADDON_KEY, quantity: 1, returnUrl: RETURN_URL },
      })
    );

    expect(response.status).toBe(201);

    const calls = provider.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subscriptionId).toBe(VENDOR_SUBSCRIPTION_ID);

    const pending = await app.db
      .collection(COLLECTIONS.billingTransactions)
      .findOne({ tenantId: tenantPath, "addon.addonKey": ADDON_KEY });
    expect(pending).not.toBeNull();
    expect(pending).toMatchObject({
      subscriptionId,
      kind: "charge",
      status: "pending",
      addon: {
        addonKey: ADDON_KEY,
        entitlementKey: "storage.bytes",
        delta: STORAGE_ADDON_DELTA,
        quantity: 1,
      },
    });
    // The confirmation webhook correlates on the provider's payment ref, so the
    // intent must carry it.
    const refs = (pending?.externalRefs ?? []) as Array<{ kind?: string; id?: string }>;
    expect(refs.some((ref) => ref.kind === "payment" && ref.id === VENDOR_PAYMENT_ID)).toBe(true);
  });

  it("refuses an add-on the catalogue does not sell", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-addon-unknown");
    await seedSubscription({ tenantId: tenantPath, status: "active" });
    await seedAddons([makeAddon()]);

    const response = await purchaseAddon(
      billingRequest({
        tenantPath,
        route: "addons",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: { addonKey: "does-not-exist", quantity: 1, returnUrl: RETURN_URL },
      })
    );

    expect(response.status).toBe(422);
    expect(await errorEnvelope(response)).toMatchObject({ code: "validation_failed" });
  });

  it("requires an Idempotency-Key header", async () => {
    const { tenantPath, owner } = await ownerWorkspace("op110-addon-no-key");
    await seedSubscription({ tenantId: tenantPath, status: "active" });
    await seedAddons([makeAddon()]);

    const response = await purchaseAddon(
      billingRequest({
        tenantPath,
        route: "addons",
        cookie: owner.cookie,
        body: { addonKey: ADDON_KEY, quantity: 1, returnUrl: RETURN_URL },
      })
    );

    expect(response.status).toBe(400);
    expect(await errorEnvelope(response)).toMatchObject({ code: "idempotency_key_required" });
  });
});

describe("POST /api/v1/webhooks/{provider} — the add-on confirmation", () => {
  it("I5: inserts an additive grant and the entitlement's effectiveLimit reflects it", async () => {
    const { tenantPath } = await ownerWorkspace("op110-addon-webhook");
    await seedPlan({
      "storage.bytes": makeEntitlement({
        limit: STORAGE_PLAN_LIMIT,
        resetPeriod: "none",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "active",
      mandateStatus: "active",
    });
    await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      kind: "charge",
      status: "pending",
      amountMinor: 19_900,
      refs: [{ provider: "cashfree", env: "sandbox", kind: "payment", id: VENDOR_PAYMENT_ID }],
      addon: {
        addonKey: ADDON_KEY,
        entitlementKey: "storage.bytes",
        delta: STORAGE_ADDON_DELTA,
        quantity: 1,
      },
    });

    const response = await receiveWebhook(webhookRequest(paymentSucceededBody(VENDOR_PAYMENT_ID)));
    expect(response.status).toBe(200);
    await drainDeferredProjections();

    // §14.2: a grant is an **additive row**, never a mutation of the plan.
    const grants = await app.db
      .collection(COLLECTIONS.entitlementGrants)
      .find({ tenantId: tenantPath, entitlementKey: "storage.bytes" })
      .toArray();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      delta: STORAGE_ADDON_DELTA,
      overrideLimit: null,
      validUntil: null,
      source: { kind: "purchase" },
    });
    expect(grants[0]?.validFrom).toBeInstanceOf(Date);
    expect(grants[0]?.source?.billingTransactionId).toBeDefined();
    // The grant is additive: the plan row is untouched.
    const plan = await app.db.collection(COLLECTIONS.plans).findOne({ key: "starter" });
    expect(plan?.entitlements["storage.bytes"]).toMatchObject({ limit: STORAGE_PLAN_LIMIT });

    const events = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ tenantId: tenantPath })
      .toArray();
    expect(events.map((row) => String(row.eventKey))).toContain("billing.addon.purchased");

    // §3.5: `effectiveLimit = plan.limit + Σ active grants.delta`.
    const verdict = await checkEntitlement(tenantPath, "storage.bytes", 0, {}, { db: app.db });
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.limit).toBe(STORAGE_PLAN_LIMIT);
      expect(verdict.effectiveLimit).toBe(STORAGE_PLAN_LIMIT + STORAGE_ADDON_DELTA);
    }
  });

  it("I5: emits usage.limit.restored when the grant clears a block", async () => {
    const { tenantPath } = await ownerWorkspace("op110-addon-unblock");
    await seedPlan({
      "storage.bytes": makeEntitlement({
        limit: STORAGE_PLAN_LIMIT,
        resetPeriod: "none",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    const subscriptionId = await seedSubscription({
      tenantId: tenantPath,
      status: "active",
      mandateStatus: "active",
    });
    // The workspace is over its plan limit but inside the topped-up one.
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      tenantId: tenantPath,
      entitlementKey: "storage.bytes",
      periodKey: "lifetime",
      value: STORAGE_PLAN_LIMIT + 1,
      updatedAt: new Date(),
    });
    await seedTransaction({
      tenantId: tenantPath,
      subscriptionId,
      kind: "charge",
      status: "pending",
      amountMinor: 19_900,
      refs: [{ provider: "cashfree", env: "sandbox", kind: "payment", id: VENDOR_PAYMENT_ID }],
      addon: {
        addonKey: ADDON_KEY,
        entitlementKey: "storage.bytes",
        delta: STORAGE_ADDON_DELTA,
        quantity: 1,
      },
    });

    const response = await receiveWebhook(webhookRequest(paymentSucceededBody(VENDOR_PAYMENT_ID)));
    expect(response.status).toBe(200);
    await drainDeferredProjections();

    const events = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ tenantId: tenantPath })
      .toArray();
    const keys = events.map((row) => String(row.eventKey));
    expect(keys).toContain("billing.addon.purchased");
    expect(keys).toContain("usage.limit.restored");

    const verdict = await checkEntitlement(tenantPath, "storage.bytes", 0, {}, { db: app.db });
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.remaining).toBe(STORAGE_ADDON_DELTA - 1);
    }
  });
});

/** The mutations, so the §3.3 owner gate is pinned for each of them. */
const MUTATION_ROUTES: readonly {
  readonly name: string;
  readonly route: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly body: () => Record<string, unknown>;
  readonly idempotency: boolean;
}[] = [
  {
    name: "retry-charge",
    route: "retry-charge",
    handler: retryCharge,
    body: () => ({}),
    idempotency: true,
  },
  {
    name: "cancel",
    route: "cancel",
    handler: cancelSubscription,
    body: () => ({ atPeriodEnd: true }),
    idempotency: false,
  },
  {
    name: "addons",
    route: "addons",
    handler: purchaseAddon,
    body: () => ({ addonKey: ADDON_KEY, quantity: 1, returnUrl: RETURN_URL }),
    idempotency: true,
  },
];

/** The reads §3.4 opens to an `admin` as well as the owner. */
const READ_ROUTES: readonly {
  readonly name: string;
  readonly route: string;
  readonly handler: (request: Request) => Promise<Response>;
}[] = [
  { name: "transactions", route: "transactions", handler: listTransactions },
  { name: "invoices", route: "invoices/OP-2026-000431", handler: getInvoice },
];

/** Build the request one ladder case sends. */
function ladderRequest(options: {
  readonly tenantPath: string;
  readonly route: string;
  readonly cookie?: string;
  readonly method: "POST" | "GET";
  readonly body?: Record<string, unknown>;
  readonly idempotencyKey?: string;
}): Request {
  return billingRequest(options);
}

describe("the self-serve billing surface's auth and tenancy ladder", () => {
  it.each(MUTATION_ROUTES)("$name rejects an unauthenticated caller with 401", async (route) => {
    const { tenantPath } = await ownerWorkspace(`op110-${route.name}-anon`);

    const response = await route.handler(
      ladderRequest({
        tenantPath,
        route: route.route,
        method: "POST",
        body: route.body(),
        ...(route.idempotency ? { idempotencyKey: randomUUID() } : {}),
      })
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });

  it.each(MUTATION_ROUTES)(
    "$name is owner-only, so a member is refused with 403",
    async (route) => {
      const owner = await app.signIn(makeIdentity("op110-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: `op110-${route.name}-member`,
      });
      const member = await app.signIn(makeIdentity("op110-member"));
      await addMember(tenantId, member, "member");

      const response = await route.handler(
        ladderRequest({
          tenantPath: tenantId.toHexString(),
          route: route.route,
          cookie: member.cookie,
          method: "POST",
          body: route.body(),
          ...(route.idempotency ? { idempotencyKey: randomUUID() } : {}),
        })
      );

      expect(response.status).toBe(403);
      expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
    }
  );

  it.each(MUTATION_ROUTES)(
    "$name is owner-only, so an admin is refused with 403",
    async (route) => {
      const owner = await app.signIn(makeIdentity("op110-owner"));
      const tenantId = await seedWorkspace({
        userId: owner.userId,
        role: "owner",
        slug: `op110-${route.name}-admin`,
      });
      const admin = await app.signIn(makeIdentity("op110-admin"));
      await addMember(tenantId, admin, "admin");

      const response = await route.handler(
        ladderRequest({
          tenantPath: tenantId.toHexString(),
          route: route.route,
          cookie: admin.cookie,
          method: "POST",
          body: route.body(),
          ...(route.idempotency ? { idempotencyKey: randomUUID() } : {}),
        })
      );

      expect(response.status).toBe(403);
      expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
    }
  );

  it.each(MUTATION_ROUTES)("$name answers a non-member the uniform 404", async (route) => {
    const owner = await app.signIn(makeIdentity("op110-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op110-${route.name}-outsider`,
    });
    const outsider = await app.signIn(makeIdentity("op110-outsider"));

    const response = await route.handler(
      ladderRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: outsider.cookie,
        method: "POST",
        body: route.body(),
        ...(route.idempotency ? { idempotencyKey: randomUUID() } : {}),
      })
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });

  it.each(READ_ROUTES)("$name rejects an unauthenticated caller with 401", async (route) => {
    const { tenantPath } = await ownerWorkspace(`op110-${route.name}-read-anon`);

    const response = await route.handler(
      ladderRequest({ tenantPath, route: route.route, method: "GET" })
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });

  it.each(READ_ROUTES)("$name is not open to a member", async (route) => {
    const owner = await app.signIn(makeIdentity("op110-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op110-${route.name}-read-member`,
    });
    const member = await app.signIn(makeIdentity("op110-member"));
    await addMember(tenantId, member, "member");

    const response = await route.handler(
      ladderRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: member.cookie,
        method: "GET",
      })
    );

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
  });

  it.each(READ_ROUTES)("$name answers a non-member the uniform 404", async (route) => {
    const owner = await app.signIn(makeIdentity("op110-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op110-${route.name}-read-outsider`,
    });
    const outsider = await app.signIn(makeIdentity("op110-outsider"));

    const response = await route.handler(
      ladderRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: outsider.cookie,
        method: "GET",
      })
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });
});
