import { ObjectId, type Db } from "mongodb";
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
import { appError } from "@/server/http/errors";
import { getPaymentProvider } from "@/server/payments/get-payment-provider";
import type { ChargeOnceResult } from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";
import {
  decideRetryEligibility,
  mandateStatusSchema,
  subscriptionStatusSchema,
  type SubscriptionStatus,
} from "@/server/services/subscriptions";

/**
 * Start the one-time charge for a workspace's outstanding dues (OP-110/OP-140,
 * contract §3.3/§7.3, schema §14.4; ADR-0480 §1/§3, ADR-0942 §2).
 *
 * Both the "Pay now" banner route and the notification action endpoint charge
 * the same money through this one path: the owner gate, the §3.3 eligibility
 * decision, the `pending` ledger intent written **before** the provider call and
 * the refs the confirmation webhook correlates on all live here. A second call
 * under the same `idempotencyKey` never writes a second intent — it answers
 * `already_charged` — so "applied exactly once" is a ledger fact, not a wish.
 */

/** The `Retry-After`-style hint a provider outage reports (§3.3, Appendix A.4). */
const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/** The `failure.category` a provider outage is recorded under (§14.4). */
const PROVIDER_FAILURE_CATEGORY = "technical" as const;

/** MongoDB's duplicate-key refusal: the unique `idempotencyKey` index fired. */
const DUPLICATE_KEY = 11000;

/** The stored live `subscriptions` fields the charge reads (§14.3). */
const chargeableSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  tenantId: z.string(),
  status: subscriptionStatusSchema,
  mandateStatus: mandateStatusSchema,
  pendingDueMinor: z.number().default(0),
  currency: z.string().default("INR"),
  externalRefs: providerRefsSchema,
});

/** What {@link startOutstandingCharge} needs. */
export interface OutstandingChargeInput {
  /** The database handle. */
  readonly db: Db;
  /** The `subscriptions` row the charge is made against. */
  readonly subscriptionId: ObjectId;
  /** The caller whose owner role is re-checked here (a notification is not a permission). */
  readonly requesterUserId: string;
  /** Our key for this intent, stable across repeats of the same user action. */
  readonly idempotencyKey: string;
  /** The instant the intent is written at. */
  readonly now: Date;
}

/** What {@link startOutstandingCharge} answered. */
export interface OutstandingChargeResult {
  /** `charged` for this call's intent, `already_charged` for a replay. */
  readonly kind: "charged" | "already_charged";
  /** The `billingTransactions` row carrying the intent. */
  readonly billingTransactionId: ObjectId;
  /** The owning subscription's status (a webhook, never this call, confirms it). */
  readonly subscriptionStatus: SubscriptionStatus;
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * Refuse a caller who does not own the workspace (§3.3).
 *
 * @param db - The database handle.
 * @param tenantId - The owning workspace's hex id.
 * @param userId - The caller's Better Auth user id.
 * @throws `403 forbidden` for a non-member and for a `member`/`admin`.
 */
async function requireWorkspaceOwner(db: Db, tenantId: string, userId: string): Promise<void> {
  const membership = ((await platformRepo(db)
    .collection(COLLECTIONS.tenantMembers)
    .findOne({
      tenantId: new ObjectId(tenantId),
      userId: new ObjectId(userId),
      status: "active",
    })) ?? null) as { readonly role: unknown } | null;
  if (membership?.role !== "owner") {
    throw appError("forbidden");
  }
}

/**
 * Charge the outstanding dues of one subscription, exactly once per key.
 *
 * @param input - The row, the caller, the idempotency key and the instant.
 * @returns The ledger row and the subscription's status.
 * @throws `404 not_found` for an unknown subscription.
 * @throws `403 forbidden` when the caller is not the workspace's owner.
 * @throws `409 no_pending_due` / `409 mandate_not_chargeable` per §3.3.
 * @throws `502 upstream_unavailable` when the provider refuses the charge.
 */
export async function startOutstandingCharge(
  input: OutstandingChargeInput
): Promise<OutstandingChargeResult> {
  const { db, now } = input;
  const repo = platformRepo(db);

  const stored = await repo
    .collection(COLLECTIONS.subscriptions)
    .findOne({ _id: input.subscriptionId });
  if (stored === null) {
    throw appError("not_found", { details: { resource: "subscription" } });
  }
  const subscription = chargeableSubscriptionSchema.parse(stored);

  await requireWorkspaceOwner(db, subscription.tenantId, input.requesterUserId);

  // A repeat under the same key is the same intent: answer the ledger, not the
  // provider. This runs before eligibility so a replay stays `already_charged`
  // even once the due has been settled.
  const ledger = repo.collection(COLLECTIONS.billingTransactions);
  const existing = ((await ledger.findOne({ idempotencyKey: input.idempotencyKey })) ?? null) as {
    readonly _id: ObjectId;
  } | null;
  if (existing !== null) {
    return {
      kind: "already_charged",
      billingTransactionId: existing._id,
      subscriptionStatus: subscription.status,
    };
  }

  const verdict = decideRetryEligibility({
    status: subscription.status,
    mandateStatus: subscription.mandateStatus,
    pendingDueMinor: subscription.pendingDueMinor,
  });
  if (!verdict.allowed && verdict.reason === "no_pending_due") {
    throw appError("no_pending_due");
  }
  if (!verdict.allowed) {
    throw appError("mandate_not_chargeable", {
      details: {
        mandateStatus: subscription.mandateStatus,
        recoveryAction: verdict.recoveryAction,
      },
    });
  }

  const mandate = providerRefOf(subscription.externalRefs, "subscription");
  if (mandate === null) {
    // A row with no mandate reference cannot be charged; re-authorizing is the
    // only recovery — the same refusal a revoked mandate gets.
    throw appError("mandate_not_chargeable", {
      details: { mandateStatus: subscription.mandateStatus, recoveryAction: "recreate_mandate" },
    });
  }

  let billingTransactionId: ObjectId;
  try {
    billingTransactionId = await insertPendingCharge(db, {
      tenantId: subscription.tenantId,
      subscriptionId: subscription._id,
      amountMinor: subscription.pendingDueMinor,
      currency: subscription.currency,
      idempotencyKey: input.idempotencyKey,
      now,
    });
  } catch (error) {
    // Two clicks that both missed the read race: the loser answers the winner's
    // intent instead of a 500 (the unique `idempotencyKey` index decides).
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    const raced = ((await ledger.findOne({ idempotencyKey: input.idempotencyKey })) ?? null) as {
      readonly _id: ObjectId;
    } | null;
    if (raced === null) {
      throw error;
    }
    return {
      kind: "already_charged",
      billingTransactionId: raced._id,
      subscriptionStatus: subscription.status,
    };
  }

  let refs: ChargeOnceResult;
  try {
    refs = await getPaymentProvider().chargeOnce({
      ref: mandate,
      amountMinor: subscription.pendingDueMinor,
      idempotencyKey: input.idempotencyKey,
    });
  } catch {
    // The attempt failed: park the intent as failed so it never dangles at
    // `pending`, and let the client retry under a fresh key.
    await failPendingCharge(db, billingTransactionId, PROVIDER_FAILURE_CATEGORY, now);
    throw appError("upstream_unavailable", {
      details: {
        provider: getConfig().payments.provider,
        retryAfterSeconds: UPSTREAM_RETRY_AFTER_SECONDS,
      },
      expose: true,
    });
  }

  await recordChargeRefs(db, billingTransactionId, refs.externalRefs, now);

  return { kind: "charged", billingTransactionId, subscriptionStatus: subscription.status };
}
