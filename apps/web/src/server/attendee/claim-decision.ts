/**
 * The claim decision table (OP-134, contract §6.7, schema §15.3; ADR-0815).
 *
 * A claim answers one question per event the anonymous session touched: does
 * the caller already own a profile here?
 *
 * - **No** → schema §15.3's atomic re-point is safe: the row keeps its `_id`,
 *   its matches and its selfie, and only `subject` changes.
 * - **Yes** → the re-point is impossible (the unique partial index
 *   `{eventId:1, "subject.userId":1}` on `subject.kind:"user"` forbids a second
 *   user profile per event), so the row is skipped and the only remaining
 *   question is which of the two active selfies survives.
 *
 * The documented rule is "keep the newest active selfie". A **tie** keeps the
 * existing profile's own selfie: the row that already owns the matches is not
 * rewritten for a coin flip.
 */

/** Why an event the caller already owns was skipped (contract §6.7). */
export type ClaimSkipReason = "already_claimed_by_this_user";

/** The facts one event's claim decision needs. */
export interface ClaimDecisionInput {
  /** Whether the caller already has a `user` profile for this event. */
  readonly hasExistingUserProfile: boolean;
  /** The anonymous profile's active selfie `createdAt`, when it has one. */
  readonly anonymousSelfieCreatedAt: Date | null;
  /** The existing user profile's active selfie `createdAt`, when it has one. */
  readonly existingSelfieCreatedAt: Date | null;
}

/** The action to take for one event of the session. */
export type ClaimDecision =
  | { readonly action: "repoint" }
  | {
      readonly action: "merge";
      readonly skipReason: ClaimSkipReason;
      readonly adoptAnonymousSelfie: boolean;
    };

/**
 * Decide one event's claim action.
 *
 * @param input - Whether the caller owns a profile here, and both selfie times.
 * @returns `repoint` for a fresh event, else `merge` with the selfie to adopt.
 */
export function decideClaim(input: ClaimDecisionInput): ClaimDecision {
  if (!input.hasExistingUserProfile) {
    return { action: "repoint" };
  }

  const anonymous = input.anonymousSelfieCreatedAt;
  const existing = input.existingSelfieCreatedAt;
  const adoptAnonymousSelfie =
    anonymous !== null && (existing === null || anonymous.getTime() > existing.getTime());

  return {
    action: "merge",
    skipReason: "already_claimed_by_this_user",
    adoptAnonymousSelfie,
  };
}
