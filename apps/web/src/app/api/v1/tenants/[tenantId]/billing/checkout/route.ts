import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { getConfig, getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { planSchema, type Plan, type PlanPrice } from "@/server/plans/plans";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { CreateMandateResult, MandateCustomer } from "@/server/payments/payment-provider";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import {
  checkoutEnvelopeSchema,
  checkoutRequestSchema,
  decideExistingSubscription,
  isAllowedReturnUrl,
  subscriptionStatusSchema,
  type CheckoutEnvelope,
  type ExistingSubscriptionFacts,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/checkout` — start a hosted mandate
 * (OP-107, contract §3.3, schema §14.3; ADR-0420 / ADR-0421).
 *
 * The one place a workspace turns into a paying one. The owner names a
 * **self-serve** plan and price and a `returnUrl`; the route validates all three,
 * reads the workspace's current subscription and then, for a new or stale
 * checkout:
 *
 *   1. inserts an `incomplete` `subscriptions` row **before** calling the
 *      provider, so the one-live-row unique index is the arbiter of a concurrent
 *      double-submit;
 *   2. calls `provider.createMandate` for the vendor plan id the sold price's
 *      `externalRefs` carries;
 *   3. stores the returned refs plus the hosted link and its expiry on that row
 *      and answers the §3.3 `201` envelope with `Location`.
 *
 * A provider failure parks the row at `expired` (terminal, so it no longer
 * occupies the live slot) and answers `502 upstream_unavailable` with
 * `retryable: true`, which is what makes a retry work. **Landing on the return
 * URL is not proof of success**: only a verified webhook may move the state to
 * `active`, so this route never writes `active`.
 *
 * Idempotency is required (§0.9), so a replay under the same `Idempotency-Key`
 * never reaches the provider a second time. The response is the bare envelope
 * (§0.5) and carries no vendor-shaped field (§0.15).
 */

/** The `returnUrl` a checkout must land on is a *config* fact, not a new env var. */
const CONTACT_SALES_URL = "/contact-sales";

/** The mandate kind every self-serve checkout creates (contract §3.3 example). */
const SELF_SERVE_PAYMENT_METHOD = "mandate_upi" as const;

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The `statusHistory` reason a fresh row records. */
const CHECKOUT_STARTED_REASON = "checkout_started";

/** The `statusHistory` reason a failed checkout records. */
const CHECKOUT_FAILED_REASON = "checkout_failed";

/** The `statusHistory` reason a stale row retired by a restart records. */
const CHECKOUT_RESTARTED_REASON = "checkout_restarted";

/** The `statusHistory.from` value when the workspace had no live subscription. */
const NO_PREVIOUS_STATUS = "none";

/** The Better Auth-owned, platform-scope `user` collection (schema §13.1). */
const BETTER_AUTH_USER = "user";

/**
 * The placeholder phone a mandate carries when the account has none on record.
 *
 * The vendor contract requires a non-empty `customer_phone`; an email-OTP
 * account may not have signed up a number yet, and the mandate is created by
 * the workspace owner, not by the customer filling in a form. Replace this with
 * a "verified phone required" refusal the moment the product collects one
 * (recorded as a coverage gap in ADR-0421).
 */
const UNSET_CONTACT_PHONE = "0000000000";

/** The customer name used when the account has no display name. */
const FALLBACK_CUSTOMER_NAME = "OpenPic customer";

/** The stored row fields this route reads and writes (schema §14.3). */
const storedSubscriptionRowSchema = z.object({
  _id: z.unknown(),
  status: subscriptionStatusSchema,
  cancelledAt: z.date().nullable().optional(),
  checkout: z.object({ url: z.string(), expiresAt: z.date() }).nullable().optional(),
});

/**
 * Read the workspace's current subscription row as the decision facts.
 *
 * @param row - The stored document, or `null`.
 * @returns The facts {@link decideExistingSubscription} reasons about.
 */
function toFacts(row: unknown): ExistingSubscriptionFacts | null {
  if (row === null) {
    return null;
  }
  const parsed = storedSubscriptionRowSchema.parse(row);
  return {
    subscriptionId: String(parsed._id),
    status: parsed.status,
    cancelledAt: parsed.cancelledAt ?? null,
    checkout: parsed.checkout ?? null,
  };
}

/** Load one stored plan from the platform-scope catalogue, or `null`. */
async function loadPlan(db: Db, planKey: string): Promise<Plan | null> {
  const row = await platformRepo(db).collection(COLLECTIONS.plans).findOne({ key: planKey });
  return row === null ? null : planSchema.parse(row);
}

/** The sold price and the vendor plan reference it carries. */
interface SoldPrice {
  readonly price: PlanPrice;
  readonly vendorPlanRef: string;
}

/**
 * Resolve the sold price of a plan, with the vendor plan id the provider needs.
 *
 * The vendor name is confined to `plans.prices[].externalRefs` (ADR-0001), so
 * the reference the mandate is addressed to has to flow from there; a price
 * with no `kind: "plan"` ref cannot be sold and is refused.
 *
 * @param plan - The validated stored plan.
 * @param priceKey - The requested price key.
 * @returns The active price and its vendor ref, or `null` when unsellable.
 */
function soldPrice(plan: Plan, priceKey: string): SoldPrice | null {
  const price = plan.prices.find(
    (candidate) => candidate.priceKey === priceKey && candidate.active
  );
  const ref = price?.externalRefs.find((candidate) => candidate.kind === "plan");
  if (price === undefined || ref === undefined) {
    return null;
  }
  return { price, vendorPlanRef: ref.id };
}

/** A `422 validation_failed` field entry naming one unsellable request field. */
function unsoldField(path: string): {
  readonly path: string;
  readonly code: string;
  readonly message: string;
} {
  return {
    path,
    code: "not_found",
    message: "must name an active plan and price sold by the platform",
  };
}

/** A non-empty trimmed string, or `null`. */
function asContactText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The acting account's contact fields (the Better Auth `user` document). */
const accountContactSchema = z.object({
  email: z.unknown().optional(),
  name: z.unknown().optional(),
  phoneNumber: z.unknown().optional(),
});

/** The profile's display-name field (the `userProfiles` document). */
const profileContactSchema = z.object({
  displayName: z.unknown().optional(),
});

/**
 * Derive the customer a mandate is created for.
 *
 * The customer is never client-supplied: it comes from the acting account's
 * Better Auth user row (the email) and the profile's display name, with a
 * documented placeholder for a missing phone (see {@link UNSET_CONTACT_PHONE}).
 *
 * @param user - The Better Auth `user` document, or `null`.
 * @param profile - The `userProfiles` document, or `null`.
 * @returns The port's {@link MandateCustomer}.
 */
function resolveMandateCustomer(user: unknown, profile: unknown): MandateCustomer {
  const account = accountContactSchema.parse(user ?? {});
  const profileRow = profileContactSchema.parse(profile ?? {});
  return {
    name:
      asContactText(profileRow.displayName) ??
      asContactText(account.name) ??
      FALLBACK_CUSTOMER_NAME,
    email: asContactText(account.email) ?? FALLBACK_CUSTOMER_NAME,
    phone: asContactText(account.phoneNumber) ?? UNSET_CONTACT_PHONE,
  };
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/checkout",
  body: checkoutRequestSchema,
  response: checkoutEnvelopeSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    // §3.3 makes every billing mutation owner-only; an `admin` is a member but
    // is not authorised to spend the workspace's money.
    if (scope.role !== "owner") {
      throw appError("forbidden");
    }

    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();
    const actor = scope.userId;
    const callerId = new ObjectId(actor);
    const { planKey, priceKey, returnUrl } = ctx.body;

    if (!isAllowedReturnUrl(returnUrl, config.app.allowedOrigins)) {
      throw appError("invalid_return_url", {
        details: { allowedOrigins: [...config.app.allowedOrigins] },
      });
    }

    const plan = await loadPlan(db, planKey);
    if (plan === null) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("planKey")] },
      });
    }
    // A sales-assisted tier is refused before its price is even considered: the
    // catalogue embeds no prices for it (a workspace cannot buy it here at all).
    if (!plan.active || !plan.selfServe) {
      throw appError("plan_not_self_serve", { details: { contactSalesUrl: CONTACT_SALES_URL } });
    }
    const sold = soldPrice(plan, priceKey);
    if (sold === null) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("priceKey")] },
      });
    }

    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
    const decision = decideExistingSubscription(
      toFacts(await subscriptions.findOne({}, { sort: { updatedAt: -1 } })),
      now
    );

    if (decision.kind === "blocked") {
      throw appError("subscription_already_active", {
        details: { subscriptionId: decision.subscriptionId, status: decision.status },
      });
    }

    const envelope = {
      status: "incomplete" as const,
      paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
      amountMinor: sold.price.amountMinor,
      currency: "INR" as const,
    };

    // A still-valid checkout is idempotent without a second mandate: the stored
    // link is echoed back and the provider is not called.
    if (decision.kind === "reuse") {
      return created<CheckoutEnvelope>(
        {
          subscriptionId: decision.subscriptionId,
          ...envelope,
          checkout: {
            kind: "redirect",
            url: decision.checkout.url,
            expiresAt: decision.checkout.expiresAt.toISOString(),
          },
        },
        decision.checkout.url
      );
    }

    // A stale `incomplete` row must be retired before the insert: the
    // one-live-row partial index would otherwise reject the new document.
    if (decision.kind === "restart") {
      await subscriptions.updateOne(
        { _id: new ObjectId(decision.subscriptionId) },
        {
          $set: {
            status: "expired",
            mandateStatus: "expired",
            cancelledAt: now,
            cancelReason: CHECKOUT_RESTARTED_REASON,
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              from: "incomplete",
              to: "expired",
              at: now,
              reason: CHECKOUT_RESTARTED_REASON,
              actor,
            },
          },
        }
      );
    }

    // Insert `incomplete` first: the unique partial index is the arbiter of a
    // concurrent double-submit, so the row must exist before the vendor call.
    const subscriptionId = new ObjectId();
    await subscriptions.insertOne({
      _id: subscriptionId,
      subscribedPlanKey: plan.key,
      subscribedPlanVersion: plan.version,
      activePlanKey: plan.key,
      status: "incomplete",
      priceKey: sold.price.priceKey,
      billingCycle: sold.price.billingCycle,
      paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
      mandateStatus: "pending",
      gracePeriodEndsAt: null,
      pendingDueMinor: 0,
      currency: sold.price.currency,
      dunning: { attemptCount: 0, lastAttemptAt: null, remindersSent: [], nextReminderAt: null },
      cancelAt: null,
      cancelledAt: null,
      cancelReason: null,
      scheduledChange: null,
      previousSubscriptionId: null,
      externalRefs: [],
      statusHistory: [
        {
          from: NO_PREVIOUS_STATUS,
          to: "incomplete",
          at: now,
          reason: CHECKOUT_STARTED_REASON,
          actor,
        },
      ],
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });

    const [user, profile] = await Promise.all([
      // The Better Auth-owned `user` collection is platform-scope (schema §13.1).
      platformRepo(db).collection(BETTER_AUTH_USER).findOne({ _id: callerId }),
      platformRepo(db).collection(COLLECTIONS.userProfiles).findOne({ userId: callerId }),
    ]);

    let mandate: CreateMandateResult;
    try {
      mandate = await getPaymentProvider().createMandate({
        planRef: sold.vendorPlanRef,
        customer: resolveMandateCustomer(user, profile),
        returnUrl,
        paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
      });
    } catch {
      // Park the row terminal so the one-live-row slot is released and the
      // client's retry can start a fresh mandate (§3.3).
      await subscriptions.updateOne(
        { _id: subscriptionId },
        {
          $set: {
            status: "expired",
            mandateStatus: "expired",
            cancelledAt: now,
            cancelReason: CHECKOUT_FAILED_REASON,
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              from: "incomplete",
              to: "expired",
              at: now,
              reason: CHECKOUT_FAILED_REASON,
              actor,
            },
          },
        }
      );
      throw appError("upstream_unavailable", {
        details: {
          provider: config.payments.provider,
          retryAfterSeconds: UPSTREAM_RETRY_AFTER_SECONDS,
        },
        expose: true,
      });
    }

    const expiresAt = new Date(mandate.expiresAt);
    await subscriptions.updateOne(
      { _id: subscriptionId },
      {
        $set: {
          externalRefs: [...mandate.externalRefs],
          checkout: { url: mandate.checkoutUrl, expiresAt },
          updatedAt: systemClock.now(),
        },
      }
    );

    getLogger().info("billing checkout created", {
      event: "billing.checkout.created",
      tenantId,
      planKey: plan.key,
    });

    return created<CheckoutEnvelope>(
      {
        subscriptionId: subscriptionId.toHexString(),
        ...envelope,
        checkout: {
          kind: "redirect",
          url: mandate.checkoutUrl,
          expiresAt: expiresAt.toISOString(),
        },
      },
      mandate.checkoutUrl
    );
  },
});
