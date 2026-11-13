import { describe, expect, it } from "vitest";

import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";

/**
 * Unit contract — the selfie attempt budget
 * (OP-132 U2, contract §6.3 `attemptsUsed`/`attemptsRemaining`, §6.4, §14.1).
 *
 * **Why this exists.** §6.3 answers every submit with `attemptsUsed` and
 * `attemptsRemaining`, §6.4 repeats them on the polling endpoint, and the
 * `selfies.per_attendee` entitlement (a **hard** limit, scope `attendee`) is
 * what turns the fourth attempt into `403 plan_limit_exceeded`. The arithmetic
 * behind those three numbers is one pure function so the submit route, the
 * confirm route and the polling projection cannot disagree about it — and so a
 * budget can never report a negative remainder or an unspent remaining attempt.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/selfie-attempts` must export:
 *
 * ```ts
 * interface SelfieAttemptBudget {
 *   readonly attemptsUsed: number;       // the stored count, never rewritten
 *   readonly attemptsRemaining: number;  // 0 once spent, never negative
 *   readonly exhausted: boolean;         // true once used >= allowed
 * }
 * function selfieAttemptBudget(input: {
 *   readonly used: number;               // selfies this profile has submitted
 *   readonly allowed: number;            // entitlement limit, else settings.selfie
 * }): SelfieAttemptBudget;
 * ```
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **An attempt is a stored selfie row.** Schema §15.3 has no attempt counter,
 *   so `used` is the number of `selfies` rows the profile holds; the two-step
 *   submission (preprocess + confirm) is therefore **one** attempt, because the
 *   confirm activates the row the preprocess created instead of inserting a
 *   second one (I10).
 * - **`allowed` is always a number** at this seam: the route resolves the
 *   tenant's `selfies.per_attendee` entitlement and falls back to
 *   `platformSettings.selfie.attemptsAllowed` (the same fallback §6.1's
 *   `attemptsAllowed` advertises), so the function never has to reason about an
 *   unlimited plan.
 * - `attemptsUsed` echoes `used` verbatim even when it exceeds `allowed`: the
 *   contract reports what happened, and a client that burned attempts on a
 *   downgraded plan must not be told it used fewer than it did.
 */

/** The default budget a tenant with no gating plan gets (§6.1 fallback). */
const DEFAULT_ALLOWED = 3;

describe("selfieAttemptBudget — the numbers §6.3 and §6.4 report", () => {
  it("reports the full budget before the first attempt", () => {
    expect(selfieAttemptBudget({ used: 0, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 0,
      attemptsRemaining: DEFAULT_ALLOWED,
      exhausted: false,
    });
  });

  it("reports one spent attempt after the first submit", () => {
    expect(selfieAttemptBudget({ used: 1, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 1,
      attemptsRemaining: 2,
      exhausted: false,
    });
  });

  it("reports the last attempt as available but not yet exhausted", () => {
    expect(selfieAttemptBudget({ used: 2, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 2,
      attemptsRemaining: 1,
      exhausted: false,
    });
  });

  it("reports the budget as exhausted once the last attempt is spent", () => {
    expect(selfieAttemptBudget({ used: 3, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 3,
      attemptsRemaining: 0,
      exhausted: true,
    });
  });

  it("never reports a negative remainder when more attempts were stored than allowed", () => {
    expect(selfieAttemptBudget({ used: 4, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 4,
      attemptsRemaining: 0,
      exhausted: true,
    });
  });

  it.each([
    { used: 0, allowed: 1, remaining: 1, exhausted: false },
    { used: 1, allowed: 1, remaining: 0, exhausted: true },
    { used: 7, allowed: 10, remaining: 3, exhausted: false },
    { used: 9, allowed: 10, remaining: 1, exhausted: false },
    { used: 10, allowed: 10, remaining: 0, exhausted: true },
  ])(
    "reports $remaining remaining of $allowed after $used used",
    ({ used, allowed, remaining, exhausted }) => {
      expect(selfieAttemptBudget({ used, allowed })).toEqual({
        attemptsUsed: used,
        attemptsRemaining: remaining,
        exhausted,
      });
    }
  );
});
