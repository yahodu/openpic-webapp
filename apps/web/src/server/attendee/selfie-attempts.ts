/**
 * The selfie attempt budget (OP-132, contract §6.3/§6.4, §14.1; ADR-0792).
 *
 * §6.3 answers every submit with `attemptsUsed`/`attemptsRemaining`, §6.4
 * repeats them on the polling endpoint, and `selfies.per_attendee` is the hard
 * limit that turns the next attempt into `403 plan_limit_exceeded`. The
 * arithmetic is one function so those three answers cannot disagree, and so a
 * budget can never report a negative remainder.
 *
 * An attempt is a stored `selfies` row: schema §15.3 has no attempt counter, so
 * the two-step submission is one attempt — the confirm activates the row the
 * submit created instead of inserting a second one.
 */

/** The three numbers §6.3 and §6.4 report. */
export interface SelfieAttemptBudget {
  /** The stored count, echoed verbatim even past the limit. */
  readonly attemptsUsed: number;
  /** `allowed - used`, clamped at zero. */
  readonly attemptsRemaining: number;
  /** `true` once no attempt is left. */
  readonly exhausted: boolean;
}

/** Options accepted by {@link selfieAttemptBudget}. */
export interface SelfieAttemptBudgetInput {
  /** The selfies this profile has submitted on the event. */
  readonly used: number;
  /** The `selfies.per_attendee` limit, else `settings.selfie.attemptsAllowed`. */
  readonly allowed: number;
}

/**
 * Compute the budget §6.3 reports.
 *
 * @param input - The stored count and the resolved limit.
 * @returns The used, remaining and exhausted facts.
 */
export function selfieAttemptBudget(input: SelfieAttemptBudgetInput): SelfieAttemptBudget {
  const attemptsRemaining = Math.max(0, input.allowed - input.used);
  return {
    attemptsUsed: input.used,
    attemptsRemaining,
    exhausted: attemptsRemaining === 0,
  };
}
