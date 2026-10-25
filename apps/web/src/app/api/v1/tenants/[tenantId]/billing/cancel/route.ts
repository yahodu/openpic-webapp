import { ObjectId } from "mongodb";
import { z } from "zod";

import { providerRefOf, providerRefsSchema } from "@/server/billing/one-time-charge";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { subscriptionStatusSchema } from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { ownerOnlyTenant } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/cancel` — stop the subscription
 * (OP-110, contract §3.3; ADR-0480 §2).
 *
 * The route asks the provider to release the live mandate through the shared
 * `cancelMandate` seam (OP-109, ADR-0460 §1) and parks the intent on the row;
 * `status` becomes `cancelled` **only when the provider confirms it by
 * webhook**, so this route never writes a terminal status. The response is the
 * §3.3 receipt: the row's current status, the instant the subscription ends and
 * the reassurance that nothing is deleted.
 *
 * The §3.3 owner gate is folded into the `tenant` stage slot.
 */

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The §3.3 reassurance: content survives a cancellation. */
const CANCEL_NOTE =
  "Your subscription is scheduled to stop. Your workspace and its content are not deleted — you keep access until then.";

/** The §3.3 cancel request body. */
const cancelRequestSchema = z.object({
  atPeriodEnd: z.boolean(),
  reason: z.string().optional(),
});

/** The §3.3 cancel receipt. */
const cancelResponseSchema = z.object({
  status: subscriptionStatusSchema,
  cancelAt: z.string(),
  note: z.string(),
});

/** The stored live `subscriptions` fields this route reads (§14.3). */
const liveSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  status: subscriptionStatusSchema,
  currentPeriodEnd: z.date().nullish(),
  externalRefs: providerRefsSchema,
});

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/cancel",
  body: cancelRequestSchema,
  response: cancelResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: ownerOnlyTenant(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();

    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
    const stored = await subscriptions.findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } });
    if (stored === null) {
      throw appError("not_found", { details: { reason: "no_live_subscription" } });
    }
    const current = liveSubscriptionSchema.parse(stored);

    const mandate = providerRefOf(current.externalRefs, "subscription");
    if (mandate === null) {
      throw appError("mandate_not_chargeable", {
        details: { recoveryAction: "recreate_mandate" },
      });
    }

    try {
      await getPaymentProvider().cancelMandate({ ref: mandate });
    } catch {
      throw appError("upstream_unavailable", {
        details: {
          provider: config.payments.provider,
          retryAfterSeconds: UPSTREAM_RETRY_AFTER_SECONDS,
        },
        expose: true,
      });
    }

    // §3.3: the status becomes `cancelled` only when the provider confirms it by
    // webhook. This route records when the subscription ends and nothing else.
    const cancelAt = ctx.body.atPeriodEnd ? (current.currentPeriodEnd ?? now) : now;
    await subscriptions.updateOne(
      { _id: current._id },
      { $set: { cancelAt, cancelReason: ctx.body.reason ?? null, updatedAt: now } }
    );

    return {
      status: 200,
      body: {
        status: current.status,
        cancelAt: cancelAt.toISOString(),
        note: CANCEL_NOTE,
      },
    };
  },
});
