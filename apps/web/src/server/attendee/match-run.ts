import { matchesNewDedupeKey } from "@/server/domain/domain-events";

/**
 * The incremental match run's delivery identity (OP-136, ADR-0808 §3).
 *
 * The confirmation and the worker own the first announcement of a selfie's
 * matches; a later run that finds new rows is a **second** delivery for the same
 * selfie, so its key extends the activation key with the run it was minted for.
 * Two runs for one selfie are therefore two deliveries, and no run can be
 * swallowed by `domain_events`' dedupe index.
 */

/**
 * Mint the run-discriminated delivery identity.
 *
 * @param input - The event, the profile, the selfie and the run instant.
 * @returns `` `<activation key>:run:<runAt ISO>` ``.
 */
export function incrementalMatchRunKey(input: {
  readonly eventId: string;
  readonly profileId: string;
  readonly selfieId: string;
  readonly runAt: Date;
}): string {
  return `${matchesNewDedupeKey(input.eventId, input.profileId, input.selfieId)}:run:${input.runAt.toISOString()}`;
}
