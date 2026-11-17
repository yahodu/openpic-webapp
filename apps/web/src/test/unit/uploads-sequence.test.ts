import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import { allocateSequence } from "@/server/uploads/sequence";

/**
 * Unit — the per-event image sequence allocation (OP-124 U2, contract §5.3,
 * schema §16.3, ADR-0720).
 *
 * `eventImages.sequence` is the gallery's ordering key: "monotonic per event;
 * stable 'newest first' ordering that can't tie like `createdAt` can"
 * (schema §16.3). The counter lives on the `events` document
 * (`events.sequence`, "sequence counter initialised" at creation — contract
 * §4.1) and the completion transaction advances it with one `$inc`, so two
 * concurrent completions can never mint the same number.
 *
 * The events row is created with `sequence: 1` and **zero** images, which fixes
 * the counter's meaning: it is the **next** sequence to issue, not the last one
 * issued. A fresh event's first image is therefore `sequence: 1`, and the
 * counter is left pointing at the number the next image will take — contiguous,
 * with no off-by-one gap at either end.
 *
 * Contract the implementation owes:
 *
 * ```ts
 * // @/server/uploads/sequence
 * export function allocateSequence(counter: number): {
 *   readonly sequence: number;
 *   readonly nextCounter: number;
 * };
 * ```
 *
 * A counter that is not a positive integer cannot come from a healthy `events`
 * row (creation seeds `1`, only `$inc` by a positive integer moves it), so it is
 * an internal invariant violation rather than a client error: the helper throws
 * `AppError("internal_error")` instead of minting `0`, a duplicate or a
 * fractional ordering key.
 */

/** One `[label, counter, sequence, nextCounter]` case of the rule. */
type SequenceCase = readonly [string, number, number, number];

/** The counter readings a healthy `events` row can hold. */
const COUNTER_CASES: readonly SequenceCase[] = [
  ["a fresh event issues sequence 1 and leaves the counter at 2", 1, 1, 2],
  ["an event with one image issues 2 and leaves the counter at 3", 2, 2, 3],
  ["an event with 41 images issues 42 and leaves the counter at 43", 42, 42, 43],
  ["a large counter keeps advancing by exactly one", 4_120, 4_120, 4_121],
];

/** Counters a corrupted or missing row could hand over. */
const INVALID_COUNTERS: readonly (readonly [string, number])[] = [
  ["zero would collide with itself", 0],
  ["a negative counter has no meaning", -1],
  ["a fractional counter cannot order images", 1.5],
  ["NaN is not a sequence", Number.NaN],
];

describe("allocateSequence (U2, schema §16.3)", () => {
  it.each(COUNTER_CASES)("%s", (_label, counter, sequence, nextCounter) => {
    expect(allocateSequence(counter)).toEqual({ sequence, nextCounter });
  });

  it.each(INVALID_COUNTERS)("refuses a counter where %s", (_label, counter) => {
    expect(() => allocateSequence(counter)).toThrow(AppError);
  });

  it("hands out contiguous numbers when three images complete in a row", () => {
    // The transaction's `$inc` is what makes this hold under concurrency; here
    // the helper alone must never skip or repeat a value.
    const first = allocateSequence(1);
    const second = allocateSequence(first.nextCounter);
    const third = allocateSequence(second.nextCounter);

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(third.nextCounter).toBe(4);
  });
});
