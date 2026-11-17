import { AppError } from "@/server/http/app-error";

/**
 * The per-event image sequence allocation (OP-124 U2, schema §16.3,
 * ADR-0720 D1).
 *
 * `events.sequence` is the **next** number to issue: creation seeds `1` with
 * zero images, so a fresh event's first image is `sequence: 1` and the counter
 * is left at `2`. The completion transaction advances it with one `$inc`, so
 * two concurrent completions can never mint the same ordering key.
 */

/** The number to issue and the counter value the next image will take. */
export interface SequenceAllocation {
  /** The `event_images.sequence` this image takes. */
  readonly sequence: number;
  /** The `events.sequence` value to store, so the next image takes it. */
  readonly nextCounter: number;
}

/**
 * Allocate the next image sequence for an event.
 *
 * A counter that is not a positive integer cannot come from a healthy `events`
 * row (creation seeds `1`, only `$inc` by a positive integer moves it), so it
 * is an internal invariant violation rather than a client error.
 *
 * @param counter - The event's stored `sequence` (the next number to issue).
 * @returns The number to issue and the counter to store.
 * @throws {AppError} `internal_error` when the counter is not a positive integer.
 */
export function allocateSequence(counter: number): SequenceAllocation {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new AppError("internal_error");
  }
  return { sequence: counter, nextCounter: counter + 1 };
}
