import { describe, expect, it } from "vitest";

import {
  decideRetryEligibility,
  type RetryEligibility,
  type RetryEligibilityInput,
} from "@/server/services/subscriptions/retry-charge";

/**
 * Unit contract — the retry-charge eligibility decision (OP-110 RED, contract
 * §3.3, Appendix A.4; ADR-0480).
 *
 * `POST /tenants/{tenantId}/billing/retry-charge` is the "Pay now" button on the
 * `past_due`/`downgraded` banner. §3.3 names exactly two refusals and the amount
 * of money that is due is the only other input the decision reads:
 *
 *   - `409 no_pending_due` when `pendingDueMinor == 0` — there is nothing to
 *     charge, so the button is a no-op;
 *   - `409 mandate_not_chargeable` when `mandateStatus ∈ {revoked, expired}` —
 *     the mandate cannot be charged, so the body carries
 *     `details.recoveryAction: "recreate_mandate"` and the client is directed to
 *     checkout.
 *
 * The decision is a **pure function** of `{ status, mandateStatus,
 * pendingDueMinor }`, so every row of that table is pinnable away from Mongo,
 * from the HTTP pipeline and from the vendor. `pendingDueMinor` is checked
 * **first**: a workspace with nothing due is told `no_pending_due` even when its
 * mandate is also unchargeable, because "nothing is owed" is the truthful,
 * actionable answer and it does not send the user through a re-authorization
 * they do not need.
 *
 * `paused` is deliberately allowed here: §3.3's unchargeable set is exactly
 * `{revoked, expired}`, and the contract names no third state. A product
 * decision to refuse a paused mandate is a new RED, not a silent reading of
 * this one (recorded in ADR-0480).
 */

/** One row of the §3.3 decision table. */
interface RetryCase {
  readonly label: string;
  readonly input: RetryEligibilityInput;
  readonly expected: RetryEligibility;
}

/** The §3.3 refusals, so a case states which one it expects by name. */
const NO_DUE: RetryEligibility = { allowed: false, reason: "no_pending_due" };
const UNCHARGEABLE: RetryEligibility = {
  allowed: false,
  reason: "mandate_not_chargeable",
  recoveryAction: "recreate_mandate",
};
const ALLOWED: RetryEligibility = { allowed: true };

/** The amount of one month of the seeded starter price, in minor units. */
const DUE_MINOR = 49_900;

const CASES: readonly RetryCase[] = [
  {
    label: "a past_due workspace with an active mandate and money due may retry",
    input: { status: "past_due", mandateStatus: "active", pendingDueMinor: DUE_MINOR },
    expected: ALLOWED,
  },
  {
    label: "a downgraded workspace with an active mandate and money due may retry",
    input: { status: "downgraded", mandateStatus: "active", pendingDueMinor: DUE_MINOR },
    expected: ALLOWED,
  },
  {
    label: "a pending mandate is still chargeable (only revoked/expired are refused)",
    input: { status: "past_due", mandateStatus: "pending", pendingDueMinor: DUE_MINOR },
    expected: ALLOWED,
  },
  {
    label: "a paused mandate is still chargeable (only revoked/expired are refused)",
    input: { status: "past_due", mandateStatus: "paused", pendingDueMinor: DUE_MINOR },
    expected: ALLOWED,
  },
  {
    label: "a revoked mandate is refused as mandate_not_chargeable with a recovery action",
    input: { status: "past_due", mandateStatus: "revoked", pendingDueMinor: DUE_MINOR },
    expected: UNCHARGEABLE,
  },
  {
    label: "an expired mandate is refused as mandate_not_chargeable with a recovery action",
    input: { status: "past_due", mandateStatus: "expired", pendingDueMinor: DUE_MINOR },
    expected: UNCHARGEABLE,
  },
  {
    label: "nothing due is no_pending_due even on a healthy mandate",
    input: { status: "active", mandateStatus: "active", pendingDueMinor: 0 },
    expected: NO_DUE,
  },
  {
    label: "nothing due outranks an unchargeable mandate (nothing is owed)",
    input: { status: "past_due", mandateStatus: "revoked", pendingDueMinor: 0 },
    expected: NO_DUE,
  },
  {
    label: "nothing due with no mandate at all is no_pending_due",
    input: { status: "incomplete", mandateStatus: null, pendingDueMinor: 0 },
    expected: NO_DUE,
  },
  {
    label: "a negative outstanding amount is no_pending_due",
    input: { status: "past_due", mandateStatus: "active", pendingDueMinor: -1 },
    expected: NO_DUE,
  },
];

describe("decideRetryEligibility", () => {
  it.each(CASES)("$label", ({ input, expected }) => {
    expect(decideRetryEligibility(input)).toEqual(expected);
  });

  it("never reports an allowed retry for a workspace whose mandate is revoked", () => {
    // The whole point of the refusal: a revoked mandate can never be charged,
    // whatever the outstanding amount is.
    const verdict = decideRetryEligibility({
      status: "past_due",
      mandateStatus: "revoked",
      pendingDueMinor: DUE_MINOR,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("names the recovery action a client needs to re-create the mandate", () => {
    const verdict = decideRetryEligibility({
      status: "downgraded",
      mandateStatus: "expired",
      pendingDueMinor: DUE_MINOR,
    });
    expect(verdict).toMatchObject({ recoveryAction: "recreate_mandate" });
  });
});
