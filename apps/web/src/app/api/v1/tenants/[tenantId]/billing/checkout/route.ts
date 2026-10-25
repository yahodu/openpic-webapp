import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { getConfig, getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { created, defineRoute } from "@/server/http/define-route";
import type { AppError } from "@/server/http/app-error";
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
  type ExistingSubscriptionDecision,
  type ExistingSubscriptionFacts,
  type SubscriptionStatus,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/checkout` — start a hosted mandate
 * (OP-107, contract §3.3, schema §14.3; ADR-0420 / ADR-0421).
 *
 * The one place a workspace turns into a paying one. The owner names a
 * **self-serve** plan and price and a `returnUrl`; the route validates all three,
 * reads the workspace's current subscription and then, when the workspace has no
 * live row:
 *
 *   1. claims the workspace's one live row by inserting an `incomplete`
 *      `subscriptions` row **before** calling the provider;
 *   2. calls `provider.createMandate` for the vendor plan id the sold price's
 *      `externalRefs` carries;
 *   3. stores the returned refs plus the hosted link and its expiry on that row
 *      and answers the §3.3 `201` envelope with `Location`.
 *
 * **A live row is the `409 subscription_already_active`** (§3.3, read together
 * with the `subscriptions_active_tenant_unique` partial index whose predicate
 * `{cancelledAt: null}` is §3.3's own definition of live): a pending `incomplete`
 * row is another caller's mandate — or this caller's, still in flight — and
 * retiring, replacing or re-serving it under a *new* idempotency key would step
 * on a mandate a user may be approving right now (ADR-0421 follow-up §1). A
 * pending mandate is read back through `GET /billing/subscription` (§3.2); a
 * replay of the *same* request is served by the idempotency stage (§0.9).
 *
 * The one-live-row claim is arbitrated twice over: the partial index refuses the
 * cross-process double-submit (its `E11000` is answered as the same `409`), and
 * {@link runExclusive} serialises the read-then-claim inside this process, which
 * is what makes two concurrent callers deterministic rather than merely
 * usually-correct (ADR-0421 follow-up §1 records the evidence).
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

/** The `statusHistory.from` value when the workspace had no live subscription. */
const NO_PREVIOUS_STATUS = "none";

/** The Better Auth-owned, platform-scope `user` collection (schema §13.1). */
const BETTER_AUTH_USER = "user";

/**
 * MongoDB's duplicate-key server error code — the
 * `subscriptions_active_tenant_unique` partial index refusing an insert into a
 * workspace that already holds a live row (the cross-process arbiter of the
 * one-live-row invariant).
 */
const DUPLICATE_KEY = 11000;

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * In-process serialization of the checkout's read-then-claim, keyed by
 * workspace.
 *
 * The `subscriptions_active_tenant_unique` partial index is the cross-process
 * backstop for §3.3's one-live-row invariant, but a database whose index
 * bootstrap has not run carries no such index — and two writers that both miss
 * can then both insert. Coalescing the same process's checkouts makes that
 * window deterministic instead of merely usually-correct: the second caller
 * reads the first caller's row and refuses, so no caller can retire a mandate
 * that another caller has already answered for (ADR-0421 follow-up §1).
 */
const checkoutQueues = new Map<string, Promise<void>>();

/**
 * Run `task` once every checkout already queued for `lockKey` has settled.
 *
 * @param lockKey - The workspace whose live slot the task claims.
 * @param task - The read-and-claim to run exclusively.
 * @returns The task's result, after any earlier queued checkout has settled.
 */
function runExclusive<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = checkoutQueues.get(lockKey) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  // Keep the map to the checkouts actually in flight: a long-lived process must
  // not accumulate one entry per workspace it has ever served. A checkout
  // queued meanwhile has replaced this entry, so it is left for its own settle.
  void settled.finally(() => {
    if (checkoutQueues.get(lockKey) === settled) {
      checkoutQueues.delete(lockKey);
    }
  });
  checkoutQueues.set(lockKey, settled);
  return result;
}

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

/**
 * The address a mandate carries when the account has none on record.
 *
 * The vendor requires a non-empty `customer_email`, and the account row is the
 * only source of one. A display **name** is not an address, so the fallback is
 * the platform's own no-reply mailbox — the same shape of documented
 * placeholder as {@link UNSET_CONTACT_PHONE}. Replace both with a "verified
 * contact required" refusal the moment the product collects one (recorded as a
 * coverage gap in ADR-0421).
 */
const PLATFORM_NO_REPLY_EMAIL = "no-reply@openpic.in";

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

/** The live row that blocks a checkout — the row §3.3's `409` serves. */
interface LiveSubscriptionRow {
  /** The live row's hex `_id`. */
  readonly subscriptionId: string;
  /** The live row's status. */
  readonly status: SubscriptionStatus;
}

/** What the workspace's live-slot claim resolved to. */
type CheckoutClaim =
  | { readonly kind: "refused"; readonly live: LiveSubscriptionRow }
  | { readonly kind: "claimed"; readonly subscriptionId: ObjectId };

/**
 * The live row a decision names, or `null` when the checkout may proceed.
 *
 * `start` — "there is no document, or only a terminal one" — is the one decision
 * §3.3 lets a new checkout through; `blocked` carries the status it read, and
 * every other shape the table can decide about is a live `incomplete` row.
 *
 * @param decision - The {@link decideExistingSubscription} outcome.
 * @returns The live row, or `null` to claim the slot for a new checkout.
 */
function liveRowOf(decision: ExistingSubscriptionDecision): LiveSubscriptionRow | null {
  switch (decision.kind) {
    case "start":
      return null;
    case "blocked":
      return { subscriptionId: decision.subscriptionId, status: decision.status };
    case "reuse":
    case "restart":
      return { subscriptionId: decision.subscriptionId, status: "incomplete" };
  }
}

/**
 * §3.3's `409 subscription_already_active` refusal for the live row that blocks
 * a checkout.
 *
 * @param subscriptionId - The live row's hex `_id`.
 * @param status - The live row's status.
 * @returns The error the handler throws.
 */
function alreadyActiveError(subscriptionId: string, status: SubscriptionStatus): AppError {
  return appError("subscription_already_active", {
    details: { subscriptionId, status },
  });
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
 * documented placeholder for a missing phone ({@link UNSET_CONTACT_PHONE}) and
 * for a missing address ({@link PLATFORM_NO_REPLY_EMAIL}) — a display name is
 * never handed to the vendor as an address.
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
    email: asContactText(account.email) ?? PLATFORM_NO_REPLY_EMAIL,
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
    // §3.1 excludes a retired plan (`active: false`) from the catalogue, so it is
    // not for sale at all: the same not-sold refusal a *missing* plan gets, naming
    // the request field.
    if (!plan?.active) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("planKey")] },
      });
    }
    // A sales-assisted tier is refused before its price is even considered: the
    // catalogue embeds no prices for it (a workspace cannot buy it here at all).
    if (!plan.selfServe) {
      throw appError("plan_not_self_serve", { details: { contactSalesUrl: CONTACT_SALES_URL } });
    }
    const sold = soldPrice(plan, priceKey);
    if (sold === null) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("priceKey")] },
      });
    }

    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
    // §3.3 refuses a checkout while the workspace has a **live** row, whatever
    // shape that row has: a pending `incomplete` row is a mandate its user may be
    // approving right now, so neither retiring it (the loser of a concurrent
    // double-submit used to expire the winner's in-flight row) nor answering for
    // it as a second `201` is allowed (ADR-0421 follow-up §1).
    let claim: CheckoutClaim;
    try {
      claim = await runExclusive(
        `${tenantId}/${COLLECTIONS.subscriptions}`,
        async (): Promise<CheckoutClaim> => {
          const decision = decideExistingSubscription(
            toFacts(await subscriptions.findOne({}, { sort: { updatedAt: -1 } })),
            now
          );
          const live = liveRowOf(decision);
          if (live !== null) {
            return { kind: "refused", live };
          }
          // Claim the workspace's live slot by inserting `incomplete` before the
          // vendor is called, so a caller that arrives later reads this row and
          // refuses instead of starting a second mandate.
          const claimed = new ObjectId();
          await subscriptions.insertOne({
            _id: claimed,
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
            dunning: {
              attemptCount: 0,
              lastAttemptAt: null,
              remindersSent: [],
              nextReminderAt: null,
            },
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
          return { kind: "claimed", subscriptionId: claimed };
        }
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      // Another process holds the workspace's live row: the one-live-row index
      // refused this insert, so answer the §3.3 refusal for the row that won
      // instead of surfacing the driver's `E11000` as a `500`.
      const winner = toFacts(
        await subscriptions.findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } })
      );
      throw winner === null
        ? appError("subscription_already_active")
        : alreadyActiveError(winner.subscriptionId, winner.status);
    }

    if (claim.kind === "refused") {
      throw alreadyActiveError(claim.live.subscriptionId, claim.live.status);
    }
    const { subscriptionId } = claim;

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
        status: "incomplete" as const,
        paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
        amountMinor: sold.price.amountMinor,
        currency: "INR" as const,
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
