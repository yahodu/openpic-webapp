import { randomUUID } from "node:crypto";

import { Collection, ObjectId, type Document, type InsertOneOptions } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { POST as startCheckout } from "@/app/api/v1/tenants/[tenantId]/billing/checkout/route";
import { cashfreeCreateSubscriptionRequestSchema } from "@/server/adapters/cashfree/schemas";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { seedPlans } from "@/server/plans/seed-plans";

import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  makeCashfreeCreateSubscriptionResponse,
  TEST_CASHFREE_WEBHOOK_SECRET,
} from "../factories/payment";
import { server } from "./setup";

/**
 * Integration / contract — `POST /api/v1/tenants/{tenantId}/billing/checkout`
 * (OP-107 RED, contract §3.3; ADR-0420).
 *
 * The user story: *as a tenant owner I want to subscribe to a paid plan via a
 * hosted mandate flow so that I can unlock paid limits.*
 *
 *   I1  the happy path — a schema-valid mandate request reaches the provider and
 *       the workspace gains an `incomplete` row carrying the provider refs while
 *       the caller gets the §3.3 `201` envelope;
 *   I2  a sales-assisted tier is `422 plan_not_self_serve` with the sales URL;
 *   I3  a workspace that already has a live subscription is `409
 *       subscription_already_active` with its id and status;
 *   I4  a provider failure is `502 upstream_unavailable` (retryable) and leaves
 *       **no blocking document** — the retry succeeds;
 *   I5  a replay under the same `Idempotency-Key` calls the provider exactly
 *       once;
 *   I6  a non-owner member is `403 forbidden`.
 *
 * The follow-up pins extend that list (ADR-0421 §"Follow-up pins" / §"Follow-up
 * GREEN"): `I7`/`I7b` the concurrent double-submit, `I8` a retired plan, `I9`×3
 * / `I9b` / `I9c` the mandate customer, this card's `I10` / `I10b` / `I11` —
 * the one-live-row **index** exit and what an abandoned `incomplete` row means —
 * and the follow-up `I12`, the symmetric half of `I10b`: a **non**-duplicate
 * insert failure is a `500`, never the `409` refusal.
 *
 * ## This suite runs against the bootstrapped schema
 *
 * `ensureIndexes(app.db)` runs in the `beforeAll` hook below, so the route faces
 * the real `subscriptions_active_tenant_unique` partial index — §3.3's
 * **cross-process** one-live-row arbiter — exactly as production does. Without
 * it the harness carries only the `_id_` index and two racing inserts both
 * succeed, which is why the insert exit could not be pinned before (ADR-0421's
 * follow-up GREEN records it as "the index exit is still unpinned").
 *
 * Around those, the ordinary behaviour §3.3 implies: the `401`/`400` ladder
 * (`user:complete` auth, a required `Idempotency-Key`), the `422
 * invalid_return_url` with the allow-list in `details`, and the §0.15
 * never-return rule — **no vendor field ever reaches the response**.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/billing/checkout/route` exports `POST`,
 *   `defineRoute({ route: "/api/v1/tenants/:tenantId/billing/checkout", … })`
 *   with `userAuth()`, the reusable `tenantStage()`, the idempotency stage
 *   (`required: true`, the `mongoIdempotencyStore`) and a `write.normal` rate
 *   limit; the 201 body is the bare §3.3 `CheckoutEnvelope` (§0.5 single
 *   resource) and carries `Location: <checkout url>`.
 * - The provider comes from `getPaymentProvider()` (`@/server/payments/
 *   get-payment-provider`), selected through `getConfig()`. `PAYMENT_PROVIDER=
 *   cashfree` **plus** `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` /
 *   `CASHFREE_API_VERSION` / `CASHFREE_WEBHOOK_SECRET` build the Cashfree
 *   adapter in its `sandbox` environment, so MSW can intercept
 *   `https://sandbox.cashfree.com/pg/subscriptions`. Without that selection the
 *   route cannot be driven against a vendor at all.
 * - The subscription row is tenant-scoped on the **string** hex `tenantId` (the
 *   OP-103/OP-104/OP-106 convention) and is inserted **before** the provider is
 *   called: I4 asserts the `expired` row a failed attempt leaves behind.
 * - `PAYMENT_PROVIDER=cashfree` must be an accepted `PROVIDER_SPECS` value, and
 *   the four `CASHFREE_*` names must be part of the validated configuration
 *   (`@/server/config/env`). Today neither exists.
 *
 * ## Assumptions recorded in the handoff (ADR-0420)
 *
 * - The allow-list for `returnUrl` is `config.app.allowedOrigins`, which the
 *   test harness sets to `APP_ORIGIN`.
 * - The vendor plan reference sent to Cashfree is the `id` of the sold price's
 *   `externalRefs` entry (`STARTER_MONTHLY_V1` for `starter-monthly-inr`).
 * - The checkout expiry is normalized to an RFC 3339 UTC `Z` timestamp on the
 *   wire, so the fixture's `subscription_expiry_time` is seeded in that shape.
 * - `plan_not_self_serve` / `subscription_already_active` / `invalid_return_url`
 *   / `upstream_unavailable` are Appendix A.4/A.2 codes the server catalogue
 *   does not carry yet; their `details` are asserted as the contract tables
 *   specify them.
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The Better Auth-owned, platform-scope `user` collection (schema §13.1). */
const BETTER_AUTH_USER = "user";

/** An RFC 3339 UTC timestamp string. */
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not an ISO date-time" });

/** The §3.3 checkout envelope, as served. */
const envelopeSchema = z.object({
  subscriptionId: z.string().regex(/^[0-9a-f]{24}$/i),
  status: z.literal("incomplete"),
  checkout: z.object({
    kind: z.literal("redirect"),
    url: z.string().min(1),
    expiresAt: isoDateTime,
  }),
  paymentMethodKind: z.enum(["mandate_upi", "mandate_bank_debit", "card", "invoice", "manual"]),
  amountMinor: z.number().int(),
  currency: z.literal("INR"),
});

/** The sandbox subscriptions endpoint the Cashfree adapter posts a mandate to. */
const CAShFREE_CREATE_URL = "https://sandbox.cashfree.com/pg/subscriptions";

/** The vendor plan id carried by the seeded `starter-monthly-inr` price. */
const STARTER_VENDOR_PLAN_ID = "STARTER_MONTHLY_V1";

/** The amount of the seeded `starter-monthly-inr` price, in minor units. */
const STARTER_AMOUNT_MINOR = 49_900;

/** The fixed vendor decision expiry every fixture carries (already UTC `Z`). */
const FIXTURE_EXPIRES_AT = "2026-11-01T05:00:46.000Z";

/** The phone number on file for the mandate-customer pins (a fixed value). */
const ACCOUNT_PHONE = "9812345670";

/** The hosted link an abandoned `incomplete` row still carries (§3.3, `I11`). */
const ABANDONED_LINK_URL = "https://payments-test.cashfree.com/links/abandoned-001";

/** The payments selection this suite drives the route with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The error envelope of a failed response. */
interface ErrorEnvelope {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

/** The `returnUrl` every accepted request carries (an allow-listed origin). */
const RETURN_URL = new URL("/billing/return", APP_ORIGIN).toString();

/**
 * The driver's own `Collection#insertOne`, read off the prototype **descriptor**
 * at module load — before any spec installs a stub.
 *
 * `I12` replaces `Collection.prototype.insertOne` with a spy so the route's
 * claim insert fails with a **non**-duplicate driver error; every other
 * collection's insert (the idempotency key, another spec's seed) must still
 * reach the real driver. Resolving `Collection.prototype.insertOne` *at call
 * time* would find the spy and recurse, so the original is captured here once,
 * straight from the property descriptor.
 */
const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#insertOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.insertOne;
})();

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op107-checkout", env: PAYMENTS_ENV });
  // The pricing catalogue is data (§14.1); the checkout resolves the sold price
  // from it, so a workspace cannot buy a tier the platform does not sell.
  await seedPlans({ db: app.db });
  // §3.3's one-live-row invariant is arbitrated by the partial index
  // `subscriptions_active_tenant_unique` (`{cancelledAt: null}`), and the route's
  // `E11000` mapping is what answers the cross-process race with the same
  // `409`. The schema the route runs against therefore has to be the bootstrapped
  // one — the `plans-seed.test.ts:197` precedent — or `I10b` cannot reach the
  // insert exit at all.
  await ensureIndexes(app.db);
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

/** Replace fields on the acting account's Better Auth `user` row (schema §13.1). */
async function updateAccount(userId: ObjectId, fields: Record<string, unknown>): Promise<void> {
  const result = await app.db
    .collection(BETTER_AUTH_USER)
    .updateOne({ _id: userId }, { $set: fields });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; ownerUserId: ObjectId }): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP107 Studio",
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

/** Seed a workspace with `user` as a member and its `current` alias target. */
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

/**
 * Seed one `subscriptions` row that still occupies the workspace's live slot
 * (schema §14.3) and return its id.
 *
 * `cancelledAt` is deliberately left `null`, so the row is a member of the
 * `subscriptions_active_tenant_unique` partial index whatever its `status` —
 * which is the disagreement `I10b` exercises, and why `status` admits the
 * terminal values too.
 */
async function seedLiveSubscription(options: {
  tenantId: string;
  status: "incomplete" | "active" | "past_due" | "downgraded" | "expired" | "cancelled";
  /** The hosted link the row carries (absent for a link-less row). */
  checkout?: { readonly url: string; readonly expiresAt: Date };
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: "starter",
    subscribedPlanVersion: 1,
    activePlanKey: "starter",
    status: options.status,
    ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
    priceKey: "starter-monthly-inr",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "pending",
    billingCycle: "monthly",
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
    externalRefs: [
      { provider: "cashfree", env: "sandbox", kind: "subscription", id: "cf_prev_001" },
    ],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/** The §3.3 request body for a self-serve tier. */
function checkoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planKey: "starter",
    priceKey: "starter-monthly-inr",
    returnUrl: RETURN_URL,
    ...overrides,
  };
}

/** A `POST …/billing/checkout` request, optionally carrying an idempotency key. */
function checkoutRequest(options: {
  tenantPath: string;
  cookie?: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return new Request(
    new URL(`${TENANTS_PATH}/${options.tenantPath}/billing/checkout`, APP_ORIGIN),
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? checkoutBody()),
    }
  );
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/**
 * The sorted own keys of a JSON object value.
 *
 * §0.15 is a rule about **fields**, so the never-return sweep has to look at key
 * names: a `not.toMatch(/cashfree/i)` sweep over the serialised body is a rule
 * about *strings* and can be tripped — or satisfied — by a legitimate value.
 */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/** Count provider calls while answering every mandate request successfully. */
function countProviderCalls(): { readonly calls: () => number } {
  let calls = 0;
  server.use(
    http.post(CAShFREE_CREATE_URL, () => {
      calls += 1;
      return HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({ subscription_expiry_time: FIXTURE_EXPIRES_AT })
      );
    })
  );
  return { calls: () => calls };
}

/** The `customer_details` block the adapter sends (§3.3 derives it server-side). */
interface MandateCustomerDetails {
  readonly customer_name: string;
  readonly customer_email: string;
  readonly customer_phone: string;
}

/**
 * Capture the mandate request the adapter sends, answering it successfully.
 *
 * §3.3 sends no customer in the request, so the vendor wire body is the only
 * place the provenance of `customer_details` is observable.
 */
function captureMandateRequest(): { readonly customer: () => MandateCustomerDetails } {
  let captured: unknown = null;
  server.use(
    http.post(CAShFREE_CREATE_URL, async ({ request }) => {
      captured = await request.json();
      return HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({ subscription_expiry_time: FIXTURE_EXPIRES_AT })
      );
    })
  );
  return {
    customer: () => cashfreeCreateSubscriptionRequestSchema.parse(captured).customer_details,
  };
}

/**
 * Insert a **retired** (`active: false`) clone of the `starter` plan.
 *
 * §3.1 excludes a retired plan from the catalogue, so it is not for sale; the
 * clone keeps `selfServe: true` and a sellable price with its vendor ref, so
 * `active` is the only fact that makes the request unsellable. A distinct key
 * keeps the shared seed untouched.
 */
async function seedRetiredPlan(): Promise<string> {
  const starter = await app.db.collection(COLLECTIONS.plans).findOne({ key: "starter" });
  if (starter === null) {
    throw new Error("the seeded starter plan is missing");
  }
  const key = "retired-starter";
  await app.db.collection(COLLECTIONS.plans).insertOne({
    key,
    name: "Retired Starter",
    description: starter.description,
    marketingFeatures: starter.marketingFeatures,
    tierRank: 9,
    selfServe: true,
    salesAssisted: false,
    active: false,
    version: 1,
    prices: starter.prices,
    entitlements: starter.entitlements,
  });
  return key;
}

describe("POST /api/v1/tenants/{tenantId}/billing/checkout", () => {
  it("I1: a valid request returns the 201 checkout envelope and stores an incomplete subscription with the provider refs", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-happy",
    });

    const response = makeCashfreeCreateSubscriptionResponse({
      subscription_expiry_time: FIXTURE_EXPIRES_AT,
    });
    let mandateRequest: unknown = undefined;
    server.use(
      http.post(CAShFREE_CREATE_URL, async ({ request }) => {
        mandateRequest = await request.json();
        return HttpResponse.json(response);
      })
    );

    const result = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(result.status).toBe(201);
    expect(result.headers.get("location")).toBe(response.auth_link);

    const payload = await body(result);
    expect(() => envelopeSchema.parse(payload)).not.toThrow();
    expect(payload).toMatchObject({
      status: "incomplete",
      paymentMethodKind: "mandate_upi",
      amountMinor: STARTER_AMOUNT_MINOR,
      currency: "INR",
      checkout: {
        kind: "redirect",
        url: response.auth_link,
        expiresAt: FIXTURE_EXPIRES_AT,
      },
    });

    // The mandate left the building in the pinned wire format, addressed to the
    // vendor plan id the sold price carries, with the caller's return URL.
    expect(cashfreeCreateSubscriptionRequestSchema.safeParse(mandateRequest).success).toBe(true);
    expect(mandateRequest).toMatchObject({
      plan_details: { plan_id: STARTER_VENDOR_PLAN_ID },
      subscription_meta: { return_url: RETURN_URL },
    });

    // The workspace now holds one incomplete row carrying the vendor refs.
    const stored = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ tenantId: tenantId.toHexString(), status: "incomplete" });
    expect(stored).not.toBeNull();
    expect(String(stored?._id)).toBe(payload.subscriptionId);
    expect(stored).toMatchObject({
      subscribedPlanKey: "starter",
      activePlanKey: "starter",
      priceKey: "starter-monthly-inr",
      mandateStatus: "pending",
      currency: "INR",
    });
    const refs = stored?.externalRefs as { provider: string; kind: string; id: string }[];
    expect(refs).toContainEqual(
      expect.objectContaining({
        provider: "cashfree",
        kind: "subscription",
        id: response.subscription_id,
      })
    );
    const history = stored?.statusHistory as { to: string }[];
    expect(history.some((entry) => entry.to === "incomplete")).toBe(true);
  });

  it("I1: the response carries no vendor-shaped field, no stored refs and no driver id", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-happy-no-vendor",
    });
    server.use(
      http.post(CAShFREE_CREATE_URL, () =>
        HttpResponse.json(
          makeCashfreeCreateSubscriptionResponse({ subscription_expiry_time: FIXTURE_EXPIRES_AT })
        )
      )
    );

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(payload).not.toHaveProperty("externalRefs");
    expect(payload).not.toHaveProperty("_id");

    // §0.15 / CONVENTIONS §8.1 are rules about **fields**, not about strings, so
    // the pin is the exact key set of the bare §0.5 single resource: no stored
    // refs, no driver `_id` and no vendor-shaped key (`cf_subscription_id`, …).
    // `checkout.url` *is* the provider-hosted auth link (§3.2/§3.3 make it opaque
    // and vendor-hosted), so the vendor name inside that one value is mandated —
    // a substring sweep over the serialised body asserts the opposite rule.
    expect(keysOf(payload)).toEqual([
      "amountMinor",
      "checkout",
      "currency",
      "paymentMethodKind",
      "status",
      "subscriptionId",
    ]);
    expect(keysOf(payload.checkout)).toEqual(["expiresAt", "kind", "url"]);
  });

  it("I2: a sales-assisted tier is refused with 422 plan_not_self_serve and the sales URL, without calling the provider", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-enterprise",
    });
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: checkoutBody({ planKey: "enterprise", priceKey: "enterprise-monthly-inr" }),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "plan_not_self_serve" });
    expect(error.details).toMatchObject({ contactSalesUrl: expect.any(String) });
    expect(provider.calls()).toBe(0);
  });

  it("I3: a workspace with a live subscription is refused with 409 subscription_already_active, without calling the provider", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-active",
    });
    const existingId = await seedLiveSubscription({
      tenantId: tenantId.toHexString(),
      status: "active",
    });
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(409);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "subscription_already_active" });
    expect(error.details).toMatchObject({
      subscriptionId: existingId.toHexString(),
      status: "active",
    });
    expect(provider.calls()).toBe(0);
  });

  it("I4: a provider 500 is 502 upstream_unavailable, leaves the row expired, and the retry succeeds", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-provider-500",
    });

    const success = makeCashfreeCreateSubscriptionResponse({
      subscription_expiry_time: FIXTURE_EXPIRES_AT,
    });
    let attempt = 0;
    server.use(
      http.post(CAShFREE_CREATE_URL, () => {
        attempt += 1;
        if (attempt === 1) {
          return new HttpResponse(null, { status: 500 });
        }
        return HttpResponse.json(success);
      })
    );

    const failed = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(failed.status).toBe(502);
    const error = await errorEnvelope(failed);
    expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(error.details).toMatchObject({ provider: "cashfree" });

    // The failed attempt must not block the workspace: its row is terminal.
    expect(
      await app.db
        .collection(COLLECTIONS.subscriptions)
        .countDocuments({ tenantId: tenantId.toHexString(), status: "expired" })
    ).toBeGreaterThan(0);

    // …so a retry (a fresh idempotency key) can start the mandate again.
    const retried = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(retried.status).toBe(201);
    const payload = await body(retried);
    expect(() => envelopeSchema.parse(payload)).not.toThrow();

    const stored = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ tenantId: tenantId.toHexString(), status: "incomplete" });
    expect(stored).not.toBeNull();
    expect(String(stored?._id)).toBe(payload.subscriptionId);
  });

  it("I5: a replay with the same Idempotency-Key calls the provider exactly once", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-replay",
    });
    const provider = countProviderCalls();
    const idempotencyKey = randomUUID();

    const first = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey,
      })
    );
    expect(first.status).toBe(201);
    const firstBody = await body(first);

    const second = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey,
      })
    );

    expect(second.status).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await body(second)).toEqual(firstBody);
    expect(provider.calls()).toBe(1);
  });

  it("I6: a non-owner member may not start a checkout", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-member",
    });
    const member = await app.signIn(makeIdentity("op107-member"));
    await addMember(tenantId, member, "member");
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: member.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
    expect(provider.calls()).toBe(0);
  });

  it("I6: an admin — who §3.3 does not authorise — may not start a checkout either", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-admin",
    });
    const admin = await app.signIn(makeIdentity("op107-admin"));
    await addMember(tenantId, admin, "admin");
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: admin.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
    expect(provider.calls()).toBe(0);
  });

  it("rejects an unauthenticated caller with 401 before any tenancy resolution", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-anon",
    });

    const response = await startCheckout(
      checkoutRequest({ tenantPath: tenantId.toHexString(), idempotencyKey: randomUUID() })
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });

  it("requires an Idempotency-Key header", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-no-key",
    });

    const response = await startCheckout(
      checkoutRequest({ tenantPath: tenantId.toHexString(), cookie: owner.cookie })
    );

    expect(response.status).toBe(400);
    expect(await errorEnvelope(response)).toMatchObject({ code: "idempotency_key_required" });
  });

  it("refuses a returnUrl that is not on the allow-list with 422 invalid_return_url", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-bad-return",
    });
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: checkoutBody({ returnUrl: "https://app.openpic.in.evil.com/billing/return" }),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "invalid_return_url" });
    expect(error.details).toMatchObject({ allowedOrigins: expect.any(Array) });
    expect(provider.calls()).toBe(0);
  });

  it("a non-member is denied with the uniform 404 and never reaches the provider", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-outsider",
    });
    const outsider = await app.signIn(makeIdentity("op107-outsider"));
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: outsider.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
    expect(provider.calls()).toBe(0);
  });

  it("I7: two concurrent checkouts with different Idempotency-Keys answer 201 and 409 and call the provider once", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-double-submit",
    });
    const tenantPath = tenantId.toHexString();
    const provider = countProviderCalls();

    // Two owners' clicks land together. §3.3 says a live subscription is the
    // `409 subscription_already_active`, and the one-live-row partial index
    // (`subscriptions_active_tenant_unique`, `{cancelledAt: null}`) is what
    // arbitrates the race — so exactly one caller may create a mandate, and the
    // loser must never surface the raw duplicate-key error as a `500`.
    const [one, two] = await Promise.all([
      startCheckout(
        checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
      ),
      startCheckout(
        checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
      ),
    ]);

    const statuses = [one.status, two.status].sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409]);

    const winner = one.status === 201 ? one : two;
    const loser = one.status === 201 ? two : one;
    const winnerBody = await body(winner);
    const error = await errorEnvelope(loser);
    expect(error).toMatchObject({ code: "subscription_already_active" });

    // Exactly one mandate left the building, and the workspace holds exactly one
    // live row: the winner's `incomplete` row, still carrying its hosted link.
    expect(provider.calls()).toBe(1);
    const live = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath, cancelledAt: null })
      .toArray();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      status: "incomplete",
      mandateStatus: "pending",
      cancelReason: null,
    });
    expect(live[0]?.checkout).toMatchObject({ url: expect.any(String) });
    expect(String(live[0]?._id)).toBe(winnerBody.subscriptionId);

    // The refusal names the row that won the race, and nothing was retired on
    // the way in.
    expect(error.details).toMatchObject({ subscriptionId: winnerBody.subscriptionId });
    expect(
      await app.db
        .collection(COLLECTIONS.subscriptions)
        .countDocuments({ tenantId: tenantPath, status: "expired" })
    ).toBe(0);
  });

  it("I7b: a checkout that loses the race never retires the winner's in-flight row", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-in-flight",
    });
    const tenantPath = tenantId.toHexString();

    // Hold the first request's vendor call open, so the first row is provably
    // still in flight (inserted, hosted link not yet stored) when the second
    // request arrives — the exact window in which a loser used to observe a
    // link-less live row, answer `restart` and expire the winner's mandate.
    let calls = 0;
    let releaseFirst: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    server.use(
      http.post(CAShFREE_CREATE_URL, async () => {
        calls += 1;
        if (calls === 1) {
          await inFlight;
        }
        return HttpResponse.json(
          makeCashfreeCreateSubscriptionResponse({ subscription_expiry_time: FIXTURE_EXPIRES_AT })
        );
      })
    );

    const first = startCheckout(
      checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );

    // The row is inserted before the vendor call, so its appearance is the
    // deterministic signal that the first request is past its decision point.
    const deadline = Date.now() + 10_000;
    while (
      (await app.db
        .collection(COLLECTIONS.subscriptions)
        .countDocuments({ tenantId: tenantPath })) === 0
    ) {
      if (Date.now() > deadline) {
        throw new Error("the first checkout never stored its incomplete row");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }

    const second = startCheckout(
      checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );
    await second;
    releaseFirst();
    const early = await first;

    expect(early.status).toBe(201);
    const earlyBody = await body(early);

    // The row the first caller named must still be the live one; the second
    // request may not expire or cancel it, leave a second live row behind, or
    // reach the vendor a second time.
    const live = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath, cancelledAt: null })
      .toArray();
    expect(
      live.map((row) => ({
        id: String(row._id),
        status: row.status,
        cancelReason: row.cancelReason,
      }))
    ).toEqual([{ id: earlyBody.subscriptionId, status: "incomplete", cancelReason: null }]);
    expect(live[0]?.checkout).toMatchObject({ url: expect.any(String) });
    expect(
      await app.db
        .collection(COLLECTIONS.subscriptions)
        .countDocuments({ tenantId: tenantPath, status: "expired" })
    ).toBe(0);
    expect(calls).toBe(1);
  });

  it("I8: a retired plan is refused as not sold, not as a sales-assisted tier", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-retired-plan",
    });
    const planKey = await seedRetiredPlan();
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: checkoutBody({ planKey }),
      })
    );

    // §3.1 excludes a retired plan (`active: false`) from the catalogue, so it
    // is not for sale: the same not-sold refusal a *missing* plan gets, naming
    // the request field — not the sales-assisted refusal, whose `contactSalesUrl`
    // points a buyer at sales for a tier they can no longer buy at all.
    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "validation_failed" });
    expect(error.details).toMatchObject({
      fields: [expect.objectContaining({ path: "planKey" })],
    });
    expect(error.details).not.toHaveProperty("contactSalesUrl");
    expect(provider.calls()).toBe(0);
  });

  const CUSTOMER_NAME_CASES: readonly {
    readonly slug: string;
    readonly description: string;
    readonly displayName: string | null;
    readonly accountName: string | null;
    readonly expected: string;
  }[] = [
    {
      slug: "op107-customer-profile-name",
      description: "the profile's display name",
      displayName: "Ada Lovelace",
      accountName: "Account Holder",
      expected: "Ada Lovelace",
    },
    {
      slug: "op107-customer-account-name",
      description: "the account's name when the profile has none",
      displayName: null,
      accountName: "Account Holder",
      expected: "Account Holder",
    },
    {
      slug: "op107-customer-placeholder-name",
      description: "the placeholder when neither is set",
      displayName: null,
      accountName: null,
      expected: "OpenPic customer",
    },
  ];

  it.each(CUSTOMER_NAME_CASES)("I9: names the mandate customer after $description", async (row) => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: row.slug,
    });
    await updateProfile(owner.userId, { displayName: row.displayName });
    await updateAccount(owner.userId, { name: row.accountName, phoneNumber: ACCOUNT_PHONE });
    const mandate = captureMandateRequest();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    const customer = mandate.customer();
    expect(customer.customer_name).toBe(row.expected);
    // The account row stays the source of the address and the number.
    expect(customer.customer_email).toBe(owner.identity.email);
    expect(customer.customer_phone).toBe(ACCOUNT_PHONE);
  });

  it("I9b: the mandate customer's email never falls back to the display-name placeholder", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-customer-email-fallback",
    });
    await updateAccount(owner.userId, { email: null });
    const mandate = captureMandateRequest();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    const customer = mandate.customer();
    // The vendor requires a non-empty `customer_email`, but a display name in
    // an address field is not an address: the fallback is the platform's own
    // no-reply address (ADR-0421 follow-up).
    expect(customer.customer_email).toBe("no-reply@openpic.in");
    expect(customer.customer_email).not.toBe(customer.customer_name);
  });

  it("I9c: the mandate customer's phone falls back to the documented placeholder", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-customer-phone-fallback",
    });
    await updateAccount(owner.userId, { phoneNumber: null });
    const mandate = captureMandateRequest();

    const response = await startCheckout(
      checkoutRequest({
        tenantPath: tenantId.toHexString(),
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    expect(mandate.customer().customer_phone).toBe("0000000000");
  });

  it("I10: with the one-live-row index built, two concurrent checkouts answer 201 and 409 and reach the provider once", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-index-double-submit",
    });
    const tenantPath = tenantId.toHexString();
    const provider = countProviderCalls();

    // `ensureIndexes` (in `beforeAll`) has built
    // `subscriptions_active_tenant_unique`, so this pairing runs against the
    // real schema instead of a database carrying only `_id_`. The observable
    // contract is exactly `I7`'s: one caller wins, the loser is §3.3's `409`
    // naming the winner, and nothing expires the winner's in-flight mandate.
    const [one, two] = await Promise.all([
      startCheckout(
        checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
      ),
      startCheckout(
        checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
      ),
    ]);

    const statuses = [one.status, two.status].sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409]);

    const winner = one.status === 201 ? one : two;
    const loser = one.status === 201 ? two : one;
    const winnerBody = await body(winner);
    const error = await errorEnvelope(loser);
    expect(error).toMatchObject({ code: "subscription_already_active" });
    // The refusal names the row that won the race.
    expect(error.details).toMatchObject({ subscriptionId: winnerBody.subscriptionId });

    expect(provider.calls()).toBe(1);
    const live = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath, cancelledAt: null })
      .toArray();
    expect(live).toHaveLength(1);
    expect(String(live[0]?._id)).toBe(winnerBody.subscriptionId);
    expect(
      await app.db
        .collection(COLLECTIONS.subscriptions)
        .countDocuments({ tenantId: tenantPath, status: "expired" })
    ).toBe(0);
  });

  it("I10b: an insert the one-live-row index refuses is answered as the same 409, never a 500", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-index-refusal",
    });
    const tenantPath = tenantId.toHexString();

    // The window a second process sees: the row holding the workspace's live
    // slot is one this caller's read did not classify as live. Seeding it with a
    // terminal `status` while `cancelledAt` is still null is exactly that
    // disagreement — ADR-0421 §4 names it ("a row parked at `expired` with
    // `cancelledAt` still null would keep occupying the one-live-row slot") —
    // so the route decides `start`, inserts, and the partial index refuses the
    // insert.
    const occupantId = await seedLiveSubscription({ tenantId: tenantPath, status: "expired" });
    const provider = countProviderCalls();

    const response = await startCheckout(
      checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );

    // The driver's `E11000` is mapped to §3.3's refusal for the row that won. A
    // raw `MongoServerError` falls through `errorResponse` as a `500`, which is
    // the regression this pin exists for.
    expect(response.status).toBe(409);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "subscription_already_active" });
    expect(error.details).toMatchObject({
      subscriptionId: occupantId.toHexString(),
      status: "expired",
    });

    // The refused insert never reached the provider, added no row, and left the
    // occupant exactly as it found it.
    expect(provider.calls()).toBe(0);
    const rows = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath })
      .toArray();
    expect(rows.map((row) => String(row._id))).toEqual([occupantId.toHexString()]);
    expect(rows[0]).toMatchObject({
      status: "expired",
      cancelledAt: null,
      cancelReason: null,
    });
  });

  it("I11: an abandoned `incomplete` mandate is the same 409 and is not retired by this route", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-abandoned-incomplete",
    });
    const tenantPath = tenantId.toHexString();
    // Expired **by construction**, so the fact that matters — "the hosted link
    // is no longer usable" — holds whatever wall clock the suite runs against.
    const expiresAt = new Date(Date.now() - 60 * 60 * 1000);
    const abandonedId = await seedLiveSubscription({
      tenantId: tenantPath,
      status: "incomplete",
      checkout: { url: ABANDONED_LINK_URL, expiresAt },
    });
    const provider = countProviderCalls();

    const refused = await startCheckout(
      checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );

    // An `incomplete` mandate whose link has expired is still **live**, so §3.3
    // refuses it with the same `409 subscription_already_active` a live `active`
    // row gets — naming the row and its status, with no provider call.
    expect(refused.status).toBe(409);
    const error = await errorEnvelope(refused);
    expect(error).toMatchObject({
      code: "subscription_already_active",
      retryable: false,
      details: { subscriptionId: abandonedId.toHexString(), status: "incomplete" },
    });

    // The refusal is exactly `{subscriptionId, status}`: it carries **no**
    // recovery affordance. The stored (expired) link and its expiry are not
    // echoed, and there is no sales/support target and no retry hint — the two
    // plausible "how do I get unstuck" shapes a caller might hope for.
    expect(keysOf(error.details)).toEqual(["status", "subscriptionId"]);
    expect(error.details).not.toHaveProperty("checkout");
    expect(error.details).not.toHaveProperty("expiresAt");
    expect(error.details).not.toHaveProperty("contactSalesUrl");
    expect(error.details).not.toHaveProperty("supportUrl");

    // Nothing in this tree retires the row (the webhook projection that would is
    // OP-108's, and no webhook route exists yet), so the refusal is stable: a
    // second attempt under a **fresh** idempotency key answers identically.
    const retried = await startCheckout(
      checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
    );
    expect(retried.status).toBe(409);
    expect(await errorEnvelope(retried)).toMatchObject({
      code: "subscription_already_active",
      details: { subscriptionId: abandonedId.toHexString(), status: "incomplete" },
    });
    expect(provider.calls()).toBe(0);

    // The abandoned row is untouched — still live, still `incomplete`, still
    // carrying its expired link — and no second row was written.
    const rows = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "incomplete",
      mandateStatus: "pending",
      cancelledAt: null,
      cancelReason: null,
    });
    const storedCheckout = rows[0]?.checkout as
      { readonly url: string; readonly expiresAt: Date } | undefined;
    expect(storedCheckout?.url).toBe(ABANDONED_LINK_URL);
    expect(storedCheckout?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("I12: a non-duplicate insert failure is not masked as the 409 refusal", async () => {
    const owner = await app.signIn(makeIdentity("op107-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op107-non-duplicate-insert-failure",
    });
    const tenantPath = tenantId.toHexString();
    const provider = countProviderCalls();

    // The workspace has **no** live row, so the route decides `start` and makes
    // the claim insert this pin fails — the exact write `I10b` lets succeed into
    // the partial index. The driver failure is deliberately *not* a duplicate
    // key: `code: 91` is a transient primary-election error, which is the whole
    // point (a `catch` that maps *any* insert failure to §3.3's refusal would
    // answer a server error as a `409` naming a live row the workspace does not
    // have).
    const driverError = Object.assign(new Error("not primary"), { code: 91 });
    const insertStub = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document: Document,
      options?: InsertOneOptions
    ) {
      if (this.collectionName === COLLECTIONS.subscriptions) {
        return Promise.reject(driverError);
      }
      return driverInsertOne.call(this, document, options);
    });

    let response: Response;
    try {
      response = await startCheckout(
        checkoutRequest({ tenantPath, cookie: owner.cookie, idempotencyKey: randomUUID() })
      );
    } finally {
      insertStub.mockRestore();
    }

    // The symmetric direction of `I10b`: a non-duplicate driver failure is
    // rethrown and surfaces as the app-wide `500 internal_error`. It must never
    // be reported as the `409 subscription_already_active`, which is what the
    // swallowed-error regression would answer.
    expect(response.status).toBe(500);
    const error = await errorEnvelope(response);
    expect(error.code).toBe("internal_error");
    expect(error.code).not.toBe("subscription_already_active");
    expect(error.details).toBeUndefined();

    // The refused insert wrote nothing, reached no provider, and left the
    // workspace with no row at all.
    expect(provider.calls()).toBe(0);
    expect(
      await app.db.collection(COLLECTIONS.subscriptions).countDocuments({ tenantId: tenantPath })
    ).toBe(0);
  });
});
