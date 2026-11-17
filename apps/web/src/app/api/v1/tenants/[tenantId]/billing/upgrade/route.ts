import { ObjectId, type ClientSession, type Db } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { parseJsonBody } from "@/server/http/respond";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { CreateMandateResult, ProviderRef } from "@/server/payments/payment-provider";
import { planSchema, type Plan } from "@/server/plans/plans";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import {
  comparePlanTiers,
  CONTACT_SALES_URL,
  isAllowedReturnUrl,
  loadPlan,
  resolveMandateCustomer,
  soldPrice,
  unsoldField,
  upgradeEnvelopeSchema,
  upgradeRequestSchema,
  type UpgradeEnvelope,
  type UpgradeRequest,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { ownerOnlyTenant } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/upgrade` — move a workspace up to a
 * higher tier (OP-109, contract §3.3; ADR-0460).
 *
 * §3.3 makes an upgrade **immediate**: because a recurring mandate cannot be
 * mutated in place, this is cancel-old + create-new, in that order, so the old
 * mandate is released before a second one is minted for the same customer. The
 * new `subscriptions` document carries `previousSubscriptionId` and the old one
 * is **retained** `status: "cancelled"` (with its history appended) rather than
 * deleted; `usageCounters` are **not** reset — an upgrade only widens the limits
 * the same counters are measured against.
 *
 * The DB half is one transaction that cancels the old row **before** inserting
 * the new one, so the `subscriptions_active_tenant_unique` partial index
 * (`{cancelledAt: null}`) never sees two live rows: the workspace's live slot is
 * released and then re-claimed.
 *
 * The vendor is called **before** the DB writes (the whole point is to know the
 * old mandate is released and the new one minted): a cancel failure answers
 * `502 upstream_unavailable` and changes nothing, never starting the second
 * mandate; a create failure after a successful cancel is an unpinned case
 * flagged in ADR-0460.
 *
 * Idempotency is required (§0.9), so a replay under the same `Idempotency-Key`
 * never reaches the provider a second time. The response is the §3.3 checkout
 * envelope plus `requiresReauthorization` and `notice`, with `Location` naming
 * the hosted link.
 *
 * ## Request body
 *
 * The §3.3 body is `{ targetPlanKey, priceKey, returnUrl }`. A body-less request
 * (no `application/json` body) upgrades to the **highest active self-serve
 * tier**, which is the one plan a workspace can be moved up to without naming a
 * sales-assisted one; the specs drive that path (ADR-0460 records it as an
 * assumption).
 *
 * ## Owner gate placement
 *
 * `owner`-only is enforced by the **tenant stage wrapper** rather than in the
 * handler, because §0.9's idempotency stage runs *before* the handler: a
 * `member`/`admin` must be `403` rather than `400 idempotency_key_required`.
 */

/** The mandate kind a self-serve upgrade creates (the checkout rule, §3.3). */
const SELF_SERVE_PAYMENT_METHOD = "mandate_upi" as const;

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The `cancelReason` the superseded row records. */
const UPGRADE_CANCEL_REASON = "upgraded";

/** The `statusHistory` reason the replacement row records. */
const UPGRADE_STARTED_REASON = "upgrade_started";

/** The status string a row has when there is no predecessor. */
const NO_PREVIOUS_STATUS = "none";

/** The path a defaulted `returnUrl` lands on. */
const DEFAULT_RETURN_PATH = "/billing/return";

/** The Better Auth-owned, platform-scope `user` collection (schema §13.1). */
const BETTER_AUTH_USER = "user";

/** The §3.3 notice the upgrade carries: it must name the re-authorization. */
const UPGRADE_NOTICE =
  "Your new plan takes effect immediately. You will be asked to authorize a new payment mandate with your provider before your next charge.";

/** A provider reference as stored on a subscription row (§11.1). */
const providerRefSchema = z.object({
  provider: z.enum(["cashfree", "memory"]),
  env: z.enum(["sandbox", "production"]),
  kind: z.enum(["subscription", "payment", "refund"]),
  id: z.string().min(1),
});

/** The stored live-row fields an upgrade reads (schema §14.3). */
const liveSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  activePlanKey: z.string().default("free"),
  status: z.string().default("active"),
  externalRefs: z.array(providerRefSchema).default([]),
});

/** The parsed live row. */
type LiveSubscription = z.infer<typeof liveSubscriptionSchema>;

/** The plan and price a body-less upgrade targets. */
type UpgradeTarget = Pick<UpgradeRequest, "targetPlanKey" | "priceKey">;

/**
 * Build the `returnUrl` a body-less upgrade lands on.
 *
 * The first configured allowed origin is the only safe base: a URL built on it
 * is on the allow-list by construction. A config with no origin yields the
 * relative path, which the allow-list check then refuses.
 *
 * @param origin - The first configured allowed origin, if any.
 * @returns The default `returnUrl`.
 */
function defaultReturnUrl(origin: string | undefined): string {
  return origin === undefined
    ? DEFAULT_RETURN_PATH
    : new URL(DEFAULT_RETURN_PATH, origin).toString();
}

/** True when the request declares an `application/json` body. */
function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (contentType.split(";")[0]?.trim().toLowerCase() ?? "") === "application/json";
}

/**
 * Read the optional §3.3 upgrade request.
 *
 * @param request - The inbound request.
 * @returns The parsed body, or `null` when no JSON body was sent.
 */
async function resolveUpgradeRequest(request: Request): Promise<UpgradeRequest | null> {
  if (!isJsonRequest(request)) {
    return null;
  }
  return (await parseJsonBody(request, upgradeRequestSchema)) as UpgradeRequest;
}

/**
 * The highest active self-serve plan and its active price.
 *
 * @param db - The database handle.
 * @returns The plan/price a body-less upgrade targets, or `null` when the
 *   catalogue offers none.
 */
async function highestSelfServeTarget(db: Db): Promise<UpgradeTarget | null> {
  const rows = await platformRepo(db)
    .collection(COLLECTIONS.plans)
    .find({ active: true, selfServe: true })
    .toArray();
  const plans = rows.map((row) => planSchema.parse(row));
  const top = plans.reduce<Plan | null>(
    (best, plan) => (best === null || plan.tierRank > best.tierRank ? plan : best),
    null
  );
  if (top === null) {
    return null;
  }
  const price = top.prices.find((candidate) => candidate.active);
  return price === undefined ? null : { targetPlanKey: top.key, priceKey: price.priceKey };
}

/**
 * The vendor subscription ref an upgrade releases.
 *
 * @param row - The parsed live row.
 * @returns The provider ref to cancel.
 */
function oldMandateRef(row: LiveSubscription): ProviderRef {
  const ref = row.externalRefs.find((candidate) => candidate.kind === "subscription");
  if (ref === undefined) {
    throw appError("internal_error");
  }
  return ref;
}

/** The `upstream_unavailable` refusal a provider failure is answered with. */
function upstreamUnavailable(provider: string): ReturnType<typeof appError> {
  return appError("upstream_unavailable", {
    details: { provider, retryAfterSeconds: UPSTREAM_RETRY_AFTER_SECONDS },
    expose: true,
  });
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/upgrade",
  response: upgradeEnvelopeSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: ownerOnlyTenant(),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();
    const actor = scope.userId;
    const callerId = new ObjectId(actor);

    const request = await resolveUpgradeRequest(ctx.request);
    let target: UpgradeTarget;
    if (request !== null) {
      target = request;
    } else {
      const fallback = await highestSelfServeTarget(db);
      if (fallback === null) {
        throw appError("internal_error");
      }
      target = fallback;
    }
    const returnUrl = request?.returnUrl ?? defaultReturnUrl(config.app.allowedOrigins[0]);

    if (!isAllowedReturnUrl(returnUrl, config.app.allowedOrigins)) {
      throw appError("invalid_return_url", {
        details: { allowedOrigins: [...config.app.allowedOrigins] },
      });
    }

    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
    const stored = await subscriptions.findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } });
    // An upgrade starts from a live paid tier. A workspace in the implicit free
    // state is not an upgrade source (§3.3's open question, ADR-0460).
    if (stored === null) {
      throw appError("conflict", { details: { reason: "no_live_subscription" } });
    }
    const current = liveSubscriptionSchema.parse(stored);

    const targetPlan = await loadPlan(db, target.targetPlanKey);
    if (!targetPlan?.active) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("targetPlanKey")] },
      });
    }
    const currentPlan = await loadPlan(db, current.activePlanKey);
    if (currentPlan === null) {
      throw appError("internal_error");
    }

    // §3.3 refuses everything that is not strictly an upgrade, an equal rank
    // included; the `downgradeUrl` names the endpoint that *can* serve it.
    if (comparePlanTiers(currentPlan.tierRank, targetPlan.tierRank) !== "upgrade") {
      throw appError("not_an_upgrade", {
        details: {
          currentTierRank: currentPlan.tierRank,
          targetTierRank: targetPlan.tierRank,
          downgradeUrl: `/api/v1/tenants/${tenantId}/billing/downgrade`,
        },
      });
    }

    if (!targetPlan.selfServe) {
      throw appError("plan_not_self_serve", { details: { contactSalesUrl: CONTACT_SALES_URL } });
    }
    const sold = soldPrice(targetPlan, target.priceKey);
    if (sold === null) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("priceKey")] },
      });
    }

    const provider = getPaymentProvider();

    // Cancel the old mandate **first**: two live mandates for one customer is
    // the state this story exists to prevent, and the one-live-row index would
    // reject the new insert while the old row is still live.
    try {
      await provider.cancelMandate({ ref: oldMandateRef(current) });
    } catch {
      throw upstreamUnavailable(config.payments.provider);
    }

    const [user, profile] = await Promise.all([
      platformRepo(db).collection(BETTER_AUTH_USER).findOne({ _id: callerId }),
      platformRepo(db).collection(COLLECTIONS.userProfiles).findOne({ userId: callerId }),
    ]);

    let mandate: CreateMandateResult;
    try {
      mandate = await provider.createMandate({
        planRef: sold.vendorPlanRef,
        customer: resolveMandateCustomer(user, profile),
        returnUrl,
        paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
      });
    } catch {
      throw upstreamUnavailable(config.payments.provider);
    }

    const subscriptionId = new ObjectId();
    await withTransaction(async (session: ClientSession) => {
      // Old row leaves the live slot first, so the partial index admits the new
      // one; both writes commit together or not at all.
      await subscriptions.updateOne(
        { _id: current._id },
        {
          $set: {
            status: "cancelled",
            mandateStatus: "revoked",
            cancelledAt: now,
            cancelReason: UPGRADE_CANCEL_REASON,
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              from: current.status,
              to: "cancelled",
              at: now,
              reason: UPGRADE_CANCEL_REASON,
              actor,
            },
          },
        },
        { session }
      );
      await subscriptions.insertOne(
        {
          _id: subscriptionId,
          tenantId,
          subscribedPlanKey: targetPlan.key,
          subscribedPlanVersion: targetPlan.version,
          activePlanKey: targetPlan.key,
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
          previousSubscriptionId: current._id,
          externalRefs: [...mandate.externalRefs],
          statusHistory: [
            {
              from: NO_PREVIOUS_STATUS,
              to: "incomplete",
              at: now,
              reason: UPGRADE_STARTED_REASON,
              actor,
            },
          ],
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        },
        { session }
      );

      // §3.3 requires `billing.plan.upgraded` on a successful upgrade. Emitting
      // inside this transaction joins the outbox row to the state change; a
      // replayed `Idempotency-Key` never re-enters the handler, so it can never
      // emit a second event.
      await emitDomainEvent(
        {
          eventKey: "billing.plan.upgraded",
          tenantId,
          actorRef: { kind: "user", id: actor },
          subjectRef: { kind: "subscription", id: subscriptionId.toHexString() },
          payload: { fromPlanKey: currentPlan.key, toPlanKey: targetPlan.key },
        },
        { db, session }
      );
    });

    // `usageCounters` are deliberately untouched (§3.3): an upgrade changes only
    // the limit the counters are compared against.
    getLogger().info("billing plan upgraded", {
      event: "billing.plan.upgrade_started",
      tenantId,
      fromPlanKey: currentPlan.key,
      toPlanKey: targetPlan.key,
      previousSubscriptionId: current._id.toHexString(),
    });

    return created<UpgradeEnvelope>(
      {
        subscriptionId: subscriptionId.toHexString(),
        status: "incomplete" as const,
        paymentMethodKind: SELF_SERVE_PAYMENT_METHOD,
        amountMinor: sold.price.amountMinor,
        currency: "INR" as const,
        checkout: {
          kind: "redirect" as const,
          url: mandate.checkoutUrl,
          expiresAt: new Date(mandate.expiresAt).toISOString(),
        },
        requiresReauthorization: true,
        notice: UPGRADE_NOTICE,
      },
      mandate.checkoutUrl
    );
  },
});
