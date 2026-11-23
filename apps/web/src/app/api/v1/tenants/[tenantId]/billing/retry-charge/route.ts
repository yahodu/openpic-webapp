import { ObjectId } from "mongodb";

import { startOutstandingCharge } from "@/server/billing/charge-outstanding";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import {
  retryChargeResponseSchema,
  type RetryChargeResponse,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { ownerOnlyTenant } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/retry-charge` — pay the outstanding
 * dues (OP-110, contract §3.3, Appendix A.4; ADR-0480 §1/§3/§6).
 *
 * The "Pay now" button on the `past_due`/`downgraded` banner. The charge path —
 * the §3.3 eligibility decision (`409 no_pending_due` when nothing is owed,
 * `409 mandate_not_chargeable` with `details.recoveryAction` when the mandate
 * cannot be charged), the `pending` ledger intent written **before** the
 * provider call and the refs the confirmation correlates on — lives in
 * {@link startOutstandingCharge}, shared with the notification action endpoint
 * (OP-140). This route owns only the tenant-scoped row selection, the key and
 * the `202` receipt.
 *
 * The §3.3 owner gate is folded into the `tenant` stage slot (`ownerOnlyTenant`)
 * because §0.9's idempotency stage runs before the handler: a `member`/`admin`
 * must be `403 forbidden` rather than `400 idempotency_key_required`.
 */

/**
 * The URL a client polls the retry's ledger row through.
 *
 * There is no single-transaction read route pinned by §3.4, so the receipt names
 * the workspace's transaction list — the endpoint that actually serves the row.
 */
function pollUrlFor(request: Request, tenantId: string): string {
  return new URL(`/api/v1/tenants/${tenantId}/billing/transactions`, request.url).toString();
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/retry-charge",
  response: retryChargeResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: ownerOnlyTenant(),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx): Promise<{ status: number; body: RetryChargeResponse }> => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();

    const stored = ((await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.subscriptions)
      .findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } })) ?? null) as {
      readonly _id: unknown;
    } | null;
    const subscriptionId = stored?._id instanceof ObjectId ? stored._id : null;
    // A workspace with no live row owes nothing, so the same refusal a
    // zero-balance workspace gets is the truthful answer.
    if (subscriptionId === null) {
      throw appError("no_pending_due");
    }

    const idempotencyKey =
      ctx.request.headers.get("idempotency-key")?.trim() ??
      `billing-retry:${subscriptionId.toHexString()}`;
    const charge = await startOutstandingCharge({
      db,
      subscriptionId,
      requesterUserId: scope.userId,
      idempotencyKey,
      now,
    });

    getLogger().info("billing retry charge initiated", {
      event: "billing.retry_charge.initiated",
      tenantId,
      subscriptionId: subscriptionId.toHexString(),
      billingTransactionId: charge.billingTransactionId.toHexString(),
    });

    return {
      status: 202,
      body: {
        status: "charge_initiated",
        billingTransactionId: charge.billingTransactionId.toHexString(),
        pollUrl: pollUrlFor(ctx.request, tenantId),
      },
    };
  },
});
