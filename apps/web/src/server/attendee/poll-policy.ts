/**
 * The attendee poll-interval policy (OP-133; contract §6.4; ADR-0794 §1).
 *
 * §6.4 calls adaptive polling "server-driven": the client never decides when to
 * poll again, so the cadence is this table and nothing else. Three values, and
 * only three, because each answers a different cost: a selfie the attendee is
 * waiting on (`processing`), an event the pipeline is still indexing, and a
 * gallery that cannot change until the attendee acts.
 */

/** Every profile status §6.4 defines (schema §15.3). */
export type AttendeeStatus =
  "no_selfie" | "selfie_pending" | "processing" | "ready" | "no_match" | "failed" | "withdrawn";

/** The cadence while the attendee's own selfie is in the pipeline (§6.4). */
export const PROCESSING_POLL_MS = 2_000;

/** The cadence while the event is still indexing (§6.4). */
export const INDEXING_POLL_MS = 15_000;

/** The cadence once nothing can change without the attendee acting (§6.4). */
export const SETTLED_POLL_MS = 60_000;

/** The facts the policy branches on. */
export interface PollPolicyInput {
  readonly status: AttendeeStatus;
  /** The event's own progress: every image processed. */
  readonly indexingComplete: boolean;
}

/**
 * The cadence a client must use for one profile status.
 *
 * A `processing` selfie keeps the fast cadence whatever the event's indexing
 * state says — the page is waiting on that selfie, not on the event.
 *
 * @param input - The profile status and the event's indexing state.
 * @returns One of the three documented intervals.
 */
export function pollIntervalMs(input: PollPolicyInput): number {
  if (input.status === "processing") {
    return PROCESSING_POLL_MS;
  }
  // `no_match` is a settled outcome too: the matcher has run and found nothing.
  if (input.status === "ready" || input.status === "no_match") {
    return input.indexingComplete ? SETTLED_POLL_MS : INDEXING_POLL_MS;
  }
  return SETTLED_POLL_MS;
}

/**
 * The instant the client may poll again.
 *
 * @param now - The instant the answer is computed at (never mutated).
 * @param intervalMs - The cadence {@link pollIntervalMs} answered.
 * @returns `now + intervalMs`.
 */
export function nextPollAfter(now: Date, intervalMs: number): Date {
  return new Date(now.getTime() + intervalMs);
}

/** The `events.counters` fields indexing progress is read from (§15.1). */
export interface EventIndexingCounters {
  readonly imageCount: number;
  readonly processedImageCount: number;
}

/**
 * Whether the event's pipeline has processed every image (§6.4).
 *
 * §6.4 calls this a property of the event, not of the attendee, so the poll and
 * the gallery summary read the same answer from the same place.
 *
 * @param counters - The event's cached counters.
 * @returns `true` once every uploaded image has been processed.
 */
export function eventIndexingComplete(counters: EventIndexingCounters): boolean {
  return counters.processedImageCount >= counters.imageCount;
}
