import { ObjectId } from "mongodb";
import { z } from "zod";

import {
  failPendingCharge,
  insertPendingCharge,
  providerRefOf,
  providerRefsSchema,
  recordChargeRefs,
} from "@/server/billing/one-time-charge";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { ChargeOnceResult } from "@/server/payments/payment-provider";
import { storedAddonSchema } from "@/server/plans/addons";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { isAllowedReturnUrl } from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { ownerOnlyTenant } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/addons` — buy a top-up (OP-110,
 * contract §3.6, schema §14.4/§14.2; ADR-0480 §3–§4/§6).
 *
 * The add-on catalogue is data (§3.6, ADR-0320): the route reads the add-on the
 * request names, checks its orderable quantity bounds, and charges the
 * workspace's live mandate **once** per `Idempotency-Key` through
 * `provider.chargeOnce`.
 *
 * A top-up is confirmed by a webhook, never by this response. The route writes a
 * `pending` `billingTransactions` row before the provider call that
 * **snapshots the grant** (`{addonKey, entitlementKey, delta, quantity}`,
 * `delta = quantity × addon.grantDelta`); the projection then inserts the
 * additive `entitlementGrants` row the purchase paid for, so a catalogue edit
 * between purchase and confirmation cannot change what was bought.
 *
 * The §3.3 owner gate is folded into the `tenant` stage slot.
 */

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The `failure.category` a provider outage is recorded under (§14.4). */
const PROVIDER_FAILURE_CATEGORY = "technical" as const;

/** The §3.6 add-on purchase body. */
const addonPurchaseRequestSchema = z.object({
  addonKey: z.string().min(1),
  quantity: z.number().int().min(1),
  returnUrl: z.string().min(1),
});

/** The §3.6 purchase receipt. */
const addonPurchaseResponseSchema = z.object({
  status: z.literal("charge_initiated"),
  billingTransactionId: z.string(),
  addonKey: z.string(),
  quantity: z.number(),
  amountMinor: z.number(),
  currency: z.string(),
});

/** A `422 validation_failed` field entry naming one unbuyable request field. */
function rejectedField(path: string): {
  readonly path: string;
  readonly code: string;
  readonly message: string;
} {
  return {
    path,
    code: "not_found",
    message: "must name an active add-on the catalogue sells in the requested quantity",
  };
}

/** The stored live `subscriptions` fields this route reads (§14.3). */
const liveSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  currency: z.string().default("INR"),
  activePlanKey: z.string().default("free"),
  externalRefs: providerRefsSchema,
});

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/addons",
  body: addonPurchaseRequestSchema,
  response: addonPurchaseResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: ownerOnlyTenant(),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();
    const { addonKey, quantity, returnUrl } = ctx.body;

    if (!isAllowedReturnUrl(returnUrl, config.app.allowedOrigins)) {
      throw appError("invalid_return_url", {
        details: { allowedOrigins: [...config.app.allowedOrigins] },
      });
    }

    // The add-on catalogue is platform-scope policy-as-data (ADR-0320), exactly
    // like `plans`: the workspace scope is not part of its identity.
    const stored = await platformRepo(db)
      .collection(COLLECTIONS.addons)
      .findOne({ addonKey, active: true });
    const addon = stored === null ? null : storedAddonSchema.safeParse(stored);
    if (!addon?.success) {
      throw appError("validation_failed", { details: { fields: [rejectedField("addonKey")] } });
    }
    if (quantity < addon.data.quantity.min || quantity > addon.data.quantity.max) {
      throw appError("validation_failed", { details: { fields: [rejectedField("quantity")] } });
    }
    const price = addon.data.prices.find((candidate) => candidate.active);
    if (price === undefined) {
      throw appError("validation_failed", { details: { fields: [rejectedField("addonKey")] } });
    }

    const live = await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.subscriptions)
      .findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } });
    if (live === null) {
      throw appError("conflict", { details: { reason: "no_live_subscription" } });
    }
    const subscription = liveSubscriptionSchema.parse(live);
    const mandate = providerRefOf(subscription.externalRefs, "subscription");
    if (mandate === null) {
      throw appError("mandate_not_chargeable", {
        details: { recoveryAction: "recreate_mandate" },
      });
    }

    const idempotencyKey =
      ctx.request.headers.get("idempotency-key")?.trim() ??
      `billing-addon:${new ObjectId().toHexString()}`;
    const billingTransactionId = await insertPendingCharge(db, {
      tenantId,
      subscriptionId: subscription._id,
      amountMinor: price.amountMinor * quantity,
      currency: price.currency,
      idempotencyKey,
      now,
      addon: {
        addonKey: addon.data.addonKey,
        entitlementKey: addon.data.entitlementKey,
        delta: addon.data.grantDelta * quantity,
        quantity,
      },
    });

    let refs: ChargeOnceResult;
    try {
      refs = await getPaymentProvider().chargeOnce({
        ref: mandate,
        amountMinor: price.amountMinor * quantity,
        idempotencyKey,
      });
    } catch {
      await failPendingCharge(
        db,
        billingTransactionId,
        PROVIDER_FAILURE_CATEGORY,
        systemClock.now()
      );
      throw appError("upstream_unavailable", {
        details: {
          provider: config.payments.provider,
          retryAfterSeconds: UPSTREAM_RETRY_AFTER_SECONDS,
        },
        expose: true,
      });
    }

    await recordChargeRefs(db, billingTransactionId, refs.externalRefs, systemClock.now());

    getLogger().info("billing add-on purchase initiated", {
      event: "billing.addon.purchase_initiated",
      tenantId,
      subscriptionId: subscription._id.toHexString(),
      billingTransactionId: billingTransactionId.toHexString(),
      addonKey: addon.data.addonKey,
      quantity,
    });

    return created(
      {
        status: "charge_initiated" as const,
        billingTransactionId: billingTransactionId.toHexString(),
        addonKey: addon.data.addonKey,
        quantity,
        amountMinor: price.amountMinor * quantity,
        currency: price.currency,
      },
      new URL(`/api/v1/tenants/${tenantId}/billing/transactions`, ctx.request.url).toString()
    );
  },
});
