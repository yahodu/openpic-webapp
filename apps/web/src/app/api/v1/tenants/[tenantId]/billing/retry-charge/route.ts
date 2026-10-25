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
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { ChargeOnceResult } from "@/server/payments/payment-provider";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import {
  decideRetryEligibility,
  mandateStatusSchema,
  retryChargeResponseSchema,
  subscriptionStatusSchema,
  type RetryChargeResponse,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { ownerOnlyTenant } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/retry-charge` — pay the outstanding
 * dues (OP-110, contract §3.3, Appendix A.4; ADR-0480 §1/§3/§6).
 *
 * The "Pay now" button on the `past_due`/`downgraded` banner. The route decides
 * eligibility with the pure {@link decideRetryEligibility} (`409 no_pending_due`
 * when nothing is owed, `409 mandate_not_chargeable` with
 * `details.recoveryAction: "recreate_mandate"` when the mandate cannot be
 * charged), then charges the live mandate **once** per `Idempotency-Key`.
 *
 * The charge is confirmed by a webhook, never by this response: the `202` names
 * a `pending` ledger row that carries the intent and the provider refs the
 * confirmation will correlate on (§14.4), and a URL the client can poll the
 * ledger through. The response never carries a vendor-shaped field (§0.15).
 *
 * The §3.3 owner gate is folded into the `tenant` stage slot (`ownerOnlyTenant`)
 * because §0.9's idempotency stage runs before the handler: a `member`/`admin`
 * must be `403 forbidden` rather than `400 idempotency_key_required`.
 */

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The `failure.category` a provider outage is recorded under (§14.4). */
const PROVIDER_FAILURE_CATEGORY = "technical" as const;

/** The stored live `subscriptions` fields this route reads (§14.3). */
const liveSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  status: subscriptionStatusSchema,
  mandateStatus: mandateStatusSchema,
  pendingDueMinor: z.number().default(0),
  currency: z.string().default("INR"),
  externalRefs: providerRefsSchema,
});

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
    const config = getConfig();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();

    const stored = await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.subscriptions)
      .findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } });
    // A workspace with no live row owes nothing, so the same refusal a
    // zero-balance workspace gets is the truthful answer.
    const current = stored === null ? null : liveSubscriptionSchema.parse(stored);

    const verdict = decideRetryEligibility({
      status: current?.status ?? "incomplete",
      mandateStatus: current?.mandateStatus ?? null,
      pendingDueMinor: current?.pendingDueMinor ?? 0,
    });
    if (!verdict.allowed && verdict.reason === "no_pending_due") {
      throw appError("no_pending_due");
    }
    if (!verdict.allowed) {
      throw appError("mandate_not_chargeable", {
        details: {
          mandateStatus: current?.mandateStatus ?? null,
          recoveryAction: verdict.recoveryAction,
        },
      });
    }
    // The decision above is only reachable with a live row that owes money.
    if (current === null) {
      throw appError("no_pending_due");
    }

    const mandate = providerRefOf(current.externalRefs, "subscription");
    if (mandate === null) {
      // A row with no mandate reference cannot be charged, and re-authorizing is
      // the only recovery — the same refusal a revoked mandate gets.
      throw appError("mandate_not_chargeable", {
        details: { mandateStatus: current.mandateStatus, recoveryAction: "recreate_mandate" },
      });
    }

    const idempotencyKey =
      ctx.request.headers.get("idempotency-key")?.trim() ??
      `billing-retry:${current._id.toHexString()}`;
    const billingTransactionId = await insertPendingCharge(db, {
      tenantId,
      subscriptionId: current._id,
      amountMinor: current.pendingDueMinor,
      currency: current.currency,
      idempotencyKey,
      now,
    });

    let refs: ChargeOnceResult;
    try {
      refs = await getPaymentProvider().chargeOnce({
        ref: mandate,
        amountMinor: current.pendingDueMinor,
        idempotencyKey,
      });
    } catch {
      // The attempt failed: park the intent as failed so it never dangles at
      // `pending`, and let the client retry under a fresh key.
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

    return {
      status: 202,
      body: {
        status: "charge_initiated",
        billingTransactionId: billingTransactionId.toHexString(),
        pollUrl: pollUrlFor(ctx.request, tenantId),
      },
    };
  },
});
