import { z } from "zod";

import type { MandateStatus, SubscriptionStatus } from "./view";

/**
 * The retry-charge eligibility decision and the §3.3 `202` receipt (OP-110,
 * contract §3.3, Appendix A.4; ADR-0480 §1).
 *
 * `POST /tenants/{tenantId}/billing/retry-charge` is the "Pay now" button on the
 * `past_due`/`downgraded` banner. §3.3 names exactly two refusals and the amount
 * of money that is due is the only other input the decision reads, so the
 * decision is one pure function — a boolean pair of guards inside the route
 * would hide the precedence between them.
 */

/** The facts the retry decision reads (§3.3). */
export interface RetryEligibilityInput {
  /** The live subscription's status (§14.3). */
  readonly status: SubscriptionStatus;
  /** The live mandate's status, or `null` when the row carries none. */
  readonly mandateStatus: MandateStatus | null;
  /** The outstanding amount, in minor units. */
  readonly pendingDueMinor: number;
}

/**
 * What the retry decision answered.
 *
 * `no_pending_due` and `mandate_not_chargeable` are the two Appendix A.4
 * refusals §3.3 documents; the unchargeable one names the recovery action the
 * client needs (`recreate_mandate`).
 */
export type RetryEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "no_pending_due" }
  | {
      readonly allowed: false;
      readonly reason: "mandate_not_chargeable";
      readonly recoveryAction: "recreate_mandate";
    };

/**
 * The mandate statuses a retry cannot charge (§3.3).
 *
 * The set is exactly `{revoked, expired}`: the contract names no third state, so
 * a `paused` mandate stays chargeable (ADR-0480 §1).
 */
const UNCHARGEABLE_MANDATE_STATUSES: readonly MandateStatus[] = ["revoked", "expired"];

/**
 * Decide whether a workspace may be charged its outstanding dues (§3.3).
 *
 * Precedence matters: `pendingDueMinor <= 0` is answered `no_pending_due`
 * **first**, even on an unchargeable mandate, because "nothing is owed" is the
 * truthful, actionable answer and it does not send the user through a
 * re-authorization they do not need.
 *
 * @param input - The live status, mandate status and outstanding amount.
 * @returns The verdict: allowed, `no_pending_due`, or `mandate_not_chargeable`.
 */
export function decideRetryEligibility(input: RetryEligibilityInput): RetryEligibility {
  if (input.pendingDueMinor <= 0) {
    return { allowed: false, reason: "no_pending_due" };
  }
  if (input.mandateStatus !== null && UNCHARGEABLE_MANDATE_STATUSES.includes(input.mandateStatus)) {
    return {
      allowed: false,
      reason: "mandate_not_chargeable",
      recoveryAction: "recreate_mandate",
    };
  }
  return { allowed: true };
}

/**
 * The §3.3 `202` receipt for an accepted retry.
 *
 * The charge itself is confirmed by a webhook, never by this response: the
 * receipt names the `pending` ledger row that carries the intent and a URL the
 * client can poll the ledger through.
 */
export const retryChargeResponseSchema = z.object({
  status: z.literal("charge_initiated"),
  billingTransactionId: z.string(),
  pollUrl: z.string(),
});

/** The body of the §3.3 `202` receipt. */
export type RetryChargeResponse = z.infer<typeof retryChargeResponseSchema>;
