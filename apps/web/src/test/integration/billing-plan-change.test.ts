import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELETE as cancelScheduledChange } from "@/app/api/v1/tenants/[tenantId]/billing/scheduled-change/route";
import { POST as downgradePlan } from "@/app/api/v1/tenants/[tenantId]/billing/downgrade/route";
import { POST as upgradePlan } from "@/app/api/v1/tenants/[tenantId]/billing/upgrade/route";
import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { PaymentProvider, ProviderRef } from "@/server/payments/payment-provider";
import { seedPlans } from "@/server/plans/seed-plans";
import { periodKey } from "@/server/services/entitlements";

import {
  makeCashfreeCreateSubscriptionResponse,
  makePaymentProviderConfig,
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
 * Integration / contract — the billing plan-change surface
 * (OP-109 RED, contract §3.3; ADR-0460):
 *
 *   - `POST   /api/v1/tenants/{tenantId}/billing/upgrade`
 *   - `POST   /api/v1/tenants/{tenantId}/billing/downgrade`
 *   - `DELETE /api/v1/tenants/{tenantId}/billing/scheduled-change`
 *
 * The user story: *as a tenant owner I want immediate upgrades and period-end
 * downgrades with clear consequences so that I can change plans safely.*
 *
 *   I1  an upgrade is cancel-the-old-mandate + create-the-new-one **in that
 *       order**: the workspace's old `subscriptions` row is retained
 *       `status: "cancelled"` for history, a fresh `incomplete` row carries
 *       `previousSubscriptionId`, the caller gets the §3.3 checkout envelope
 *       plus `requiresReauthorization` and a notice, and the `usageCounters`
 *       are **not** reset;
 *   I2  an upgrade to a rank that is not higher is `422 not_an_upgrade` (an
 *       equal rank included) with the two ranks and the downgrade URL, and the
 *       provider is never called;
 *   I3  a downgrade without `acknowledgeConsequences` is `422
 *       acknowledgement_required` carrying the computed consequences, none of
 *       which is destructive;
 *   I4  a downgrade with `acknowledgeConsequences` writes
 *       `scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason:
 *       "self_downgrade" }` and leaves the live plan alone — the change lands at
 *       period end, not now;
 *   I5  `DELETE …/billing/scheduled-change` answers `204` and clears it.
 *
 * Around those, the surface pins the §3.3 ladder the checkout route established
 * (`user:complete`-style auth, owner-only, the uniform non-member `404`, the
 * required `Idempotency-Key` on an upgrade) and the §0.15 never-return rule for
 * the upgrade envelope.
 *
 * ## Contract expected of the implementation
 *
 * - The three route modules export `POST` / `POST` / `DELETE` respectively,
 *   declared `defineRoute({ route: "/api/v1/tenants/:tenantId/billing/…", … })`
 *   with `userAuth()`, the reusable `tenantStage()` and, for the two mutations,
 *   the idempotency stage (`mongoIdempotencyStore()`, `required: true` on the
 *   upgrade — §3.3 makes downgrade idempotency only *recommended*).
 * - `@/server/services/subscriptions/plan-change` exports the pure
 *   `comparePlanTiers` / `computeDowngradeConsequences` (pinned by
 *   `src/test/unit/plan-change.test.ts`) and the request/response schemas.
 * - `@/server/payments/payment-provider` gains the shared cancel seam used by
 *   this lane **and** by OP-110's `POST /billing/cancel`:
 *   `cancelMandate(input: CancelMandateInput): Promise<CancelMandateResult>`
 *   with `CancelMandateInput = { ref: ProviderRef }` and
 *   `CancelMandateResult = { status: NormalizedStatus }`. The Cashfree adapter
 *   implements it over the pinned v2025-01-01 **Manage Subscription** endpoint
 *   (`POST /pg/subscriptions/{subscription_id}/manage`, body
 *   `{ subscription_id, action: "CANCEL" }`), which is what I1's MSW handlers
 *   intercept and what `I1c` pins directly.
 * - The upgrade's provider order is **cancel, then create**: I1 records the
 *   order of the two vendor calls and asserts it.
 *
 * ## Assumptions recorded in the handoff (ADR-0460)
 *
 * - The current plan is the workspace's live `subscriptions` row's
 *   `activePlanKey`; the tier comparison is against the **seeded** catalogue's
 *   `tierRank` values (`free` 0, `starter` 1, `professional` 2, `enterprise` 3).
 * - `usageCounters` are read for `tenant`-scoped keys at the real clock's
 *   period key (`periodKey("monthly", new Date())` = `YYYY-MM` UTC), so the
 *   seeded counter matches the period the route resolves.
 * - The manage-response fixture is the create-response superset with
 *   `subscription_status: "CANCELLED"`; it satisfies both the create-response
 *   and the status-response shapes, so either may be reused for the manage call.
 * - `not_an_upgrade` and `acknowledgement_required` are Appendix A.4 codes the
 *   server catalogue does not yet carry; they are appended to
 *   `BILLING_ERROR_CODES` (the OP-107 precedent).
 */

const TENANTS_PATH = "/api/v1/tenants";

/** The sandbox mandate endpoint the Cashfree adapter creates a subscription on. */
const CASHFREE_CREATE_URL = "https://sandbox.cashfree.com/pg/subscriptions";

/**
 * The pinned v2025-01-01 Manage Subscription endpoint (ADR-0460 §1).
 *
 * Verified against Cashfree's own v2025-01-01 reference: the Manage Subscription
 * call is `POST https://sandbox.cashfree.com/pg/subscriptions/{subscription_id}/manage`
 * with `{ subscription_id, action: "CANCEL" | "PAUSE" | "ACTIVATE" | "CHANGE_PLAN" }`.
 */
const CASHFREE_MANAGE_URL = "https://sandbox.cashfree.com/pg/subscriptions/:subscriptionId/manage";

/** The vendor subscription id the pre-existing (starter) mandate carries. */
const OLD_VENDOR_SUBSCRIPTION_ID = "cf_prev_001";

/** The vendor plan id carried by the seeded `professional-monthly-inr` price. */
const PROFESSIONAL_VENDOR_PLAN_ID = "PROFESSIONAL_MONTHLY_V1";

/** The amount of the seeded `professional-monthly-inr` price, in minor units. */
const PROFESSIONAL_AMOUNT_MINOR = 999_900;

/** The fixed vendor decision expiry every create fixture carries (already UTC `Z`). */
const FIXTURE_EXPIRES_AT = "2026-11-01T05:00:46.000Z";

/** The hosted link the upgrade's fresh mandate answers with. */
const NEW_CHECKOUT_URL = "https://payments-test.cashfree.com/links/upgrade-001";

/** The payments selection this suite drives the routes with. */
const PAYMENTS_ENV: Record<string, string> = {
  PAYMENT_PROVIDER: "cashfree",
  CASHFREE_CLIENT_ID: "test-client-id",
  CASHFREE_CLIENT_SECRET: "test-client-secret",
  CASHFREE_API_VERSION: "2025-01-01",
  CASHFREE_WEBHOOK_SECRET: TEST_CASHFREE_WEBHOOK_SECRET,
};

/** The `returnUrl` every accepted upgrade carries (an allow-listed origin). */
const RETURN_URL = new URL("/billing/return", APP_ORIGIN).toString();

/** The workspace's live period-end, the instant a downgrade lands on. */
const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

/** The `events.active` usage the downgrade consequences are computed against. */
const EVENTS_ACTIVE_USAGE = 5;

/**
 * The `usageCounters` period key the route resolves for a monthly entitlement.
 *
 * Derived at run time rather than written as a literal, so the seeded counter
 * always matches the period the real clock puts the request in.
 */
const MONTHLY_PERIOD_KEY = periodKey("monthly", new Date());

/** An error envelope as served. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** One consequence §3.3 returns in `details.consequences`. */
interface Consequence {
  readonly entitlementKey: string;
  readonly effect: string;
  readonly destructive: boolean;
  readonly currentUsage?: number;
  readonly newLimit?: number;
  readonly current?: number;
  readonly new?: number;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op109-plan-change", env: PAYMENTS_ENV });
  // The upgrade/downgrade resolve the sold price and both plans' entitlements
  // from the catalogue, so the four seeded tiers must be present (§14.1).
  await seedPlans({ db: app.db });
  // §3.3's one-live-row invariant is arbitrated by the partial index
  // `subscriptions_active_tenant_unique`, whose presence is what makes "the old
  // row is cancelled before the new one claims the live slot" observable.
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

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(fields: { slug: string; ownerUserId: ObjectId }): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug: fields.slug,
    name: "OP109 Studio",
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

/** The stored `subscriptions` shape one plan-change case starts from. */
interface SeedSubscriptionOptions {
  readonly tenantId: string;
  readonly planKey: string;
  readonly priceKey: string;
  readonly status: "incomplete" | "active" | "past_due" | "downgraded";
  readonly currentPeriodEnd?: Date;
  readonly scheduledChange?: { toPlanKey: string; effectiveAt: Date; reason: string } | null;
}

/**
 * Seed the workspace's **live** `subscriptions` row (schema §14.3) and return
 * its id.
 *
 * `cancelledAt` is left `null` so the row occupies the
 * `subscriptions_active_tenant_unique` partial index's slot — which is what the
 * upgrade has to release before the new row can be inserted.
 */
async function seedSubscription(options: SeedSubscriptionOptions): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.subscriptions).insertOne({
    _id,
    tenantId: options.tenantId,
    subscribedPlanKey: options.planKey,
    subscribedPlanVersion: 1,
    activePlanKey: options.planKey,
    status: options.status,
    priceKey: options.priceKey,
    billingCycle: "monthly",
    paymentMethodKind: "mandate_upi",
    mandateStatus: "active",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: options.currentPeriodEnd ?? PERIOD_END,
    nextChargeAt: options.currentPeriodEnd ?? PERIOD_END,
    gracePeriodEndsAt: null,
    pendingDueMinor: 0,
    currency: "INR",
    dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
    cancelAt: null,
    cancelledAt: null,
    cancelReason: null,
    scheduledChange: options.scheduledChange ?? null,
    previousSubscriptionId: null,
    statusHistory: [],
    externalRefs: [
      {
        provider: "cashfree",
        env: "sandbox",
        kind: "subscription",
        id: OLD_VENDOR_SUBSCRIPTION_ID,
      },
    ],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/** Seed one `usageCounters` row (schema §14.2) for the current period. */
async function seedUsageCounter(options: {
  tenantId: string;
  entitlementKey: string;
  value: number;
}): Promise<void> {
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    tenantId: options.tenantId,
    entitlementKey: options.entitlementKey,
    periodKey: MONTHLY_PERIOD_KEY,
    value: options.value,
    updatedAt: new Date(),
  });
}

/** The §3.3 upgrade body for the seeded `professional` tier. */
function upgradeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetPlanKey: "professional",
    priceKey: "professional-monthly-inr",
    returnUrl: RETURN_URL,
    ...overrides,
  };
}

/** The §3.3 downgrade body for the seeded `free` tier. */
function downgradeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { targetPlanKey: "free", acknowledgeConsequences: true, ...overrides };
}

/** A mutation request against one of the three plan-change routes. */
function planChangeRequest(options: {
  tenantPath: string;
  route: string;
  cookie?: string;
  method?: "POST" | "DELETE";
  body?: Record<string, unknown> | undefined;
  idempotencyKey?: string;
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

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/** The sorted own keys of a JSON object value (a §0.15 rule is about *fields*). */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/**
 * The vendor's Manage Subscription response, as Cashfree v2025-01-01 answers it.
 *
 * A superset of both candidate adapter schema shapes (the create-subscription
 * response and the fetch-status response), so the adapter may reuse either one
 * for the manage call without the fixture being the reason it fails.
 */
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

/** A recorded vendor call, in the order the route made it. */
interface RecordedCall {
  readonly kind: "cancel" | "create";
  readonly body: unknown;
}

/**
 * Answer the upgrade's two vendor calls, recording them in order.
 *
 * @returns A record whose `calls()` is the ordered call log.
 */
function recordProviderCalls(): { readonly calls: () => readonly RecordedCall[] } {
  const calls: RecordedCall[] = [];
  server.use(
    http.post(CASHFREE_MANAGE_URL, async ({ request, params }) => {
      calls.push({ kind: "cancel", body: await request.json() });
      return HttpResponse.json(makeManageResponse(String(params.subscriptionId)));
    }),
    http.post(CASHFREE_CREATE_URL, async ({ request }) => {
      calls.push({ kind: "create", body: await request.json() });
      return HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({
          subscription_id: "sub_new_001",
          cf_subscription_id: "98765432",
          subscription_expiry_time: FIXTURE_EXPIRES_AT,
          auth_link: NEW_CHECKOUT_URL,
        })
      );
    })
  );
  return { calls: () => calls };
}

/** The three routes, so the auth/tenancy ladder is pinned for each of them. */
const ROUTES: readonly {
  readonly name: string;
  readonly route: string;
  readonly method: "POST" | "DELETE";
  readonly handler: (request: Request) => Promise<Response>;
  readonly body: () => Record<string, unknown> | undefined;
}[] = [
  {
    name: "upgrade",
    route: "upgrade",
    method: "POST",
    handler: upgradePlan,
    body: () => upgradeBody(),
  },
  {
    name: "downgrade",
    route: "downgrade",
    method: "POST",
    handler: downgradePlan,
    body: () => downgradeBody(),
  },
  {
    name: "scheduled-change cancel",
    route: "scheduled-change",
    method: "DELETE",
    handler: cancelScheduledChange,
    body: () => undefined,
  },
];

describe("POST /api/v1/tenants/{tenantId}/billing/upgrade", () => {
  it("I1: cancels the old mandate, then creates the new one, and preserves the old subscription as history", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-upgrade",
    });
    const tenantPath = tenantId.toHexString();
    const oldId = await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    await seedUsageCounter({
      tenantId: tenantPath,
      entitlementKey: "events.active",
      value: EVENTS_ACTIVE_USAGE,
    });
    const provider = recordProviderCalls();

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);

    const payload = await body(response);
    expect(payload).toMatchObject({
      status: "incomplete",
      paymentMethodKind: "mandate_upi",
      amountMinor: PROFESSIONAL_AMOUNT_MINOR,
      currency: "INR",
      requiresReauthorization: true,
      checkout: {
        kind: "redirect",
        url: NEW_CHECKOUT_URL,
        expiresAt: FIXTURE_EXPIRES_AT,
      },
    });
    // §3.3's notice has to name the re-authorization the user is about to do,
    // or "immediate" reads as a bait-and-switch (Subscription flow §4.5).
    expect(payload.notice).toMatch(/mandate/i);
    expect(response.headers.get("location")).toBe(NEW_CHECKOUT_URL);

    // The vendor saw the cancel first and the create second, addressed to the
    // old mandate and to the target plan's vendor plan id.
    const calls = provider.calls();
    expect(calls.map((call) => call.kind)).toEqual(["cancel", "create"]);
    expect(calls[0]?.body).toMatchObject({
      subscription_id: OLD_VENDOR_SUBSCRIPTION_ID,
      action: "CANCEL",
    });
    expect(calls[1]?.body).toMatchObject({
      plan_details: { plan_id: PROFESSIONAL_VENDOR_PLAN_ID },
    });

    // The old row is *retained* and terminal — history, never deleted.
    const oldRow = await app.db.collection(COLLECTIONS.subscriptions).findOne({ _id: oldId });
    expect(oldRow).toMatchObject({ status: "cancelled", cancelReason: expect.any(String) });
    expect(oldRow?.cancelledAt).toBeInstanceOf(Date);

    // The new row is the workspace's live one and names its predecessor.
    const newRow = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ _id: new ObjectId(payload.subscriptionId as string) });
    expect(newRow).toMatchObject({
      status: "incomplete",
      subscribedPlanKey: "professional",
      activePlanKey: "professional",
      priceKey: "professional-monthly-inr",
      mandateStatus: "pending",
    });
    expect(String(newRow?.previousSubscriptionId)).toBe(oldId.toHexString());

    const live = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath, cancelledAt: null })
      .toArray();
    expect(live.map((row) => String(row._id))).toEqual([payload.subscriptionId]);

    // §3.3: an upgrade changes only the limit the counter is compared against.
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: tenantPath, entitlementKey: "events.active" });
    expect(counter?.value).toBe(EVENTS_ACTIVE_USAGE);
  });

  it("I1: the upgrade envelope carries no vendor-shaped field and no stored refs", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-upgrade-no-vendor",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    recordProviderCalls();

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(payload).not.toHaveProperty("externalRefs");
    expect(payload).not.toHaveProperty("_id");
    // §0.15 is a rule about **fields**: the exact key set of the envelope plus
    // the two upgrade-specific fields. `checkout.url` is vendor-hosted by §3.2,
    // so a substring sweep would assert the opposite rule.
    expect(keysOf(payload)).toEqual([
      "amountMinor",
      "checkout",
      "currency",
      "notice",
      "paymentMethodKind",
      "requiresReauthorization",
      "status",
      "subscriptionId",
    ]);
  });

  it("I1: a replay under the same Idempotency-Key cancels and creates exactly once", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-upgrade-replay",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    const provider = recordProviderCalls();
    const idempotencyKey = randomUUID();

    const request = (): Request =>
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey,
      });

    const first = await upgradePlan(request());
    expect(first.status).toBe(201);
    const firstBody = await body(first);

    const second = await upgradePlan(request());

    expect(second.status).toBe(200);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await body(second)).toEqual(firstBody);
    expect(provider.calls().map((call) => call.kind)).toEqual(["cancel", "create"]);
  });

  it("I1: a provider failure while cancelling is 502 upstream_unavailable and changes nothing", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-upgrade-cancel-500",
    });
    const tenantPath = tenantId.toHexString();
    const oldId = await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    let creates = 0;
    server.use(
      http.post(CASHFREE_MANAGE_URL, () => new HttpResponse(null, { status: 500 })),
      http.post(CASHFREE_CREATE_URL, () => {
        creates += 1;
        return HttpResponse.json(makeCashfreeCreateSubscriptionResponse());
      })
    );

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(502);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "upstream_unavailable" });

    // Nothing moved: the old mandate is still the workspace's live row and no
    // second mandate was started.
    const rows = await app.db
      .collection(COLLECTIONS.subscriptions)
      .find({ tenantId: tenantPath, cancelledAt: null })
      .toArray();
    expect(rows.map((row) => String(row._id))).toEqual([oldId.toHexString()]);
    expect(rows[0]).toMatchObject({ status: "active" });
    expect(creates).toBe(0);
  });

  it("I1c: the payment port cancels a mandate over the pinned Manage Subscription endpoint", async () => {
    // The same seam OP-110's `POST /billing/cancel` needs, pinned once here so
    // the two lanes cannot diverge on its name or its wire shape.
    const provider: PaymentProvider = createCashfreeProvider(makePaymentProviderConfig());
    const ref: ProviderRef = {
      provider: "cashfree",
      env: "sandbox",
      kind: "subscription",
      id: OLD_VENDOR_SUBSCRIPTION_ID,
    };
    let captured: unknown = null;
    server.use(
      http.post(CASHFREE_MANAGE_URL, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json(makeManageResponse(OLD_VENDOR_SUBSCRIPTION_ID));
      })
    );

    const result = await provider.cancelMandate({ ref });

    expect(captured).toMatchObject({
      subscription_id: OLD_VENDOR_SUBSCRIPTION_ID,
      action: "CANCEL",
    });
    expect(result.status).toEqual({ status: "cancelled", mandateStatus: "revoked" });
  });

  it("I2: an upgrade to a lower tier is refused as 422 not_an_upgrade naming both ranks", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-not-an-upgrade",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "professional",
      priceKey: "professional-monthly-inr",
      status: "active",
    });
    const provider = recordProviderCalls();

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
        body: upgradeBody({ targetPlanKey: "starter", priceKey: "starter-monthly-inr" }),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "not_an_upgrade" });
    expect(error.details).toMatchObject({
      currentTierRank: 2,
      targetTierRank: 1,
      downgradeUrl: expect.any(String),
    });
    expect(provider.calls()).toEqual([]);
  });

  it("I2: an upgrade to the tier the workspace is already on is refused the same way", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-not-an-upgrade-equal",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "professional",
      priceKey: "professional-monthly-inr",
      status: "active",
    });
    const provider = recordProviderCalls();

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath,
        route: "upgrade",
        cookie: owner.cookie,
        idempotencyKey: randomUUID(),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "not_an_upgrade" });
    expect(error.details).toMatchObject({ currentTierRank: 2, targetTierRank: 2 });
    expect(provider.calls()).toEqual([]);
  });

  it("requires an Idempotency-Key header", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-upgrade-no-key",
    });
    await seedSubscription({
      tenantId: tenantId.toHexString(),
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });

    const response = await upgradePlan(
      planChangeRequest({
        tenantPath: tenantId.toHexString(),
        route: "upgrade",
        cookie: owner.cookie,
      })
    );

    expect(response.status).toBe(400);
    expect(await errorEnvelope(response)).toMatchObject({ code: "idempotency_key_required" });
  });
});

describe("POST /api/v1/tenants/{tenantId}/billing/downgrade", () => {
  it("I3: a downgrade without acknowledgement is 422 acknowledgement_required with the consequences", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-downgrade-unacked",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    await seedUsageCounter({
      tenantId: tenantPath,
      entitlementKey: "events.active",
      value: EVENTS_ACTIVE_USAGE,
    });

    const response = await downgradePlan(
      planChangeRequest({
        tenantPath,
        route: "downgrade",
        cookie: owner.cookie,
        body: downgradeBody({ acknowledgeConsequences: false }),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorEnvelope(response);
    expect(error).toMatchObject({ code: "acknowledgement_required" });

    const consequences = error.details?.consequences as Consequence[];
    expect(consequences.length).toBeGreaterThan(0);

    const overLimit = consequences.find((item) => item.entitlementKey === "events.active");
    expect(overLimit).toMatchObject({
      currentUsage: EVENTS_ACTIVE_USAGE,
      newLimit: 1,
    });
    const retention = consequences.find((item) => item.entitlementKey === "gallery.retention_days");
    expect(retention).toMatchObject({ current: 90, new: 7 });

    // §3.3's hard invariant: an acknowledgement prompt is never destructive.
    expect(consequences.filter((item) => item.destructive)).toEqual([]);

    // Nothing was scheduled, and no money moved.
    const row = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ tenantId: tenantPath, cancelledAt: null });
    expect(row?.scheduledChange).toBeNull();
    expect(row).toMatchObject({ status: "active", activePlanKey: "starter" });
  });

  it("I3: an omitted acknowledgeConsequences is refused the same way", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-downgrade-unacked-omitted",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });

    const response = await downgradePlan(
      planChangeRequest({
        tenantPath,
        route: "downgrade",
        cookie: owner.cookie,
        body: { targetPlanKey: "free" },
      })
    );

    expect(response.status).toBe(422);
    expect(await errorEnvelope(response)).toMatchObject({ code: "acknowledgement_required" });
  });

  it("I4: an acknowledged downgrade schedules the change at period end and leaves the live plan alone", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-downgrade-acked",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
    });
    await seedUsageCounter({
      tenantId: tenantPath,
      entitlementKey: "events.active",
      value: EVENTS_ACTIVE_USAGE,
    });

    const response = await downgradePlan(
      planChangeRequest({
        tenantPath,
        route: "downgrade",
        cookie: owner.cookie,
        body: downgradeBody(),
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload).toMatchObject({
      scheduledChange: { toPlanKey: "free", effectiveAt: PERIOD_END.toISOString() },
    });

    const row = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ tenantId: tenantPath, cancelledAt: null });
    // §3.3 writes `currentPeriodEnd` as the effective instant and names the
    // reason; the live plan is untouched until that instant is reached.
    expect(row?.scheduledChange).toMatchObject({
      toPlanKey: "free",
      reason: "self_downgrade",
    });
    expect(new Date(row?.scheduledChange.effectiveAt as Date).getTime()).toBe(PERIOD_END.getTime());
    expect(row).toMatchObject({ status: "active", activePlanKey: "starter" });
  });
});

describe("DELETE /api/v1/tenants/{tenantId}/billing/scheduled-change", () => {
  it("I5: cancelling a scheduled downgrade answers 204 and clears it", async () => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: "op109-cancel-scheduled",
    });
    const tenantPath = tenantId.toHexString();
    await seedSubscription({
      tenantId: tenantPath,
      planKey: "starter",
      priceKey: "starter-monthly-inr",
      status: "active",
      scheduledChange: { toPlanKey: "free", effectiveAt: PERIOD_END, reason: "self_downgrade" },
    });

    const response = await cancelScheduledChange(
      planChangeRequest({
        tenantPath,
        route: "scheduled-change",
        cookie: owner.cookie,
        method: "DELETE",
      })
    );

    expect(response.status).toBe(204);
    expect((await response.arrayBuffer()).byteLength).toBe(0);

    const row = await app.db
      .collection(COLLECTIONS.subscriptions)
      .findOne({ tenantId: tenantPath, cancelledAt: null });
    expect(row?.scheduledChange).toBeNull();
    // The subscription itself is untouched — only the pending change is gone.
    expect(row).toMatchObject({ status: "active", activePlanKey: "starter" });
  });
});

describe("the plan-change surface's auth and tenancy ladder", () => {
  it.each(ROUTES)("$name rejects an unauthenticated caller with 401", async (route) => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op109-${route.name}-anon`,
    });

    const response = await route.handler(
      planChangeRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        method: route.method,
        body: route.body(),
      })
    );

    expect(response.status).toBe(401);
    expect(await errorEnvelope(response)).toMatchObject({ code: "authentication_required" });
  });

  it.each(ROUTES)("$name is owner-only, so a member is refused with 403", async (route) => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op109-${route.name}-member`,
    });
    const member = await app.signIn(makeIdentity("op109-member"));
    await addMember(tenantId, member, "member");

    const response = await route.handler(
      planChangeRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: member.cookie,
        method: route.method,
        body: route.body(),
      })
    );

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
  });

  it.each(ROUTES)("$name is owner-only, so an admin is refused with 403", async (route) => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op109-${route.name}-admin`,
    });
    const admin = await app.signIn(makeIdentity("op109-admin"));
    await addMember(tenantId, admin, "admin");

    const response = await route.handler(
      planChangeRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: admin.cookie,
        method: route.method,
        body: route.body(),
      })
    );

    expect(response.status).toBe(403);
    expect(await errorEnvelope(response)).toMatchObject({ code: "forbidden" });
  });

  it.each(ROUTES)("$name answers a non-member the uniform 404", async (route) => {
    const owner = await app.signIn(makeIdentity("op109-owner"));
    const tenantId = await seedWorkspace({
      userId: owner.userId,
      role: "owner",
      slug: `op109-${route.name}-outsider`,
    });
    const outsider = await app.signIn(makeIdentity("op109-outsider"));

    const response = await route.handler(
      planChangeRequest({
        tenantPath: tenantId.toHexString(),
        route: route.route,
        cookie: outsider.cookie,
        method: route.method,
        body: route.body(),
      })
    );

    expect(response.status).toBe(404);
    expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
  });
});
