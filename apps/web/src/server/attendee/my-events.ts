/**
 * `expiringSoon` for the attendee's own event list (OP-134, contract §6.7).
 *
 * Contract §6.7 fixes the window exactly — "`expiringSoon` is `true` within 7
 * days of `galleryExpiresAt`" — so the window is one named constant and the
 * comparison is a pure function of its inputs. The clock is an **input**: a
 * read of the current time here would make the boundary untestable to the
 * millisecond and impossible to reproduce in a review.
 *
 * The two ends the contract does not spell out, decided in ADR-0815:
 * the window is **inclusive** at both ends of `[0, 7 days]`, and an
 * **already-expired** gallery is not "expiring soon" — its `status` and
 * `galleryExpiresAt` tell that story, and a permanently-true badge is noise.
 */

/** The `expiringSoon` window: seven days in milliseconds. */
export const EXPIRING_SOON_WINDOW_MS = 604_800_000;

/** Inputs for {@link computeExpiringSoon}. */
export interface ExpiringSoonInput {
  /** The gallery's retention deadline, or `null` when the event never expires. */
  readonly galleryExpiresAt: Date | null;
  /** The instant the answer is computed at. */
  readonly now: Date;
}

/**
 * Whether a gallery expires within the next seven days.
 *
 * @param input - The deadline and the instant to compare it at.
 * @returns `true` for a deadline in `[now, now + 7 days]`, `false` otherwise
 *   (including no deadline at all and a deadline already past).
 */
export function computeExpiringSoon(input: ExpiringSoonInput): boolean {
  if (input.galleryExpiresAt === null) {
    return false;
  }
  const remainingMs = input.galleryExpiresAt.getTime() - input.now.getTime();
  return remainingMs >= 0 && remainingMs <= EXPIRING_SOON_WINDOW_MS;
}
