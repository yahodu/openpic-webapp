import { describe, expect, it } from "vitest";

import * as myEvents from "@/server/attendee/my-events";

/**
 * Unit contract — `expiringSoon` for the attendee's own event list (OP-134 U1,
 * contract §6.7 `GET /api/v1/me/events`; ADR-0813).
 *
 * **Why this exists.** `expiringSoon` is the only field in §6.7 that is a
 * *computed warning* rather than a projection: it is what makes the client show
 * "your photos are deleted on <date>" without re-deriving retention at render
 * time. Contract §6.7 fixes the window exactly:
 *
 * > `expiringSoon` is `true` within 7 days of `galleryExpiresAt`.
 *
 * Two ways to get it wrong are invisible in a happy-path case and expensive in
 * production: a window off by a unit (7 * 1000 * 60 * 60 is 7 hours, and the
 * warning then never fires) and a window that also fires for a gallery that has
 * **already** expired (the row's `status`/`galleryExpiresAt` tells that story,
 * and a permanently-true badge is noise the attendee learns to ignore).
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/my-events` must export:
 *
 * ```ts
 * export const EXPIRING_SOON_WINDOW_MS: number; // 604_800_000 (7 days)
 *
 * export function computeExpiringSoon(input: {
 *   readonly galleryExpiresAt: Date | null;
 *   readonly now: Date;
 * }): boolean;
 * ```
 *
 * The function is **pure**: the clock is an input, never a read, so the boundary
 * is testable to the millisecond.
 *
 * ## The decision (documented in ADR-0813)
 *
 * `expiringSoon` is `true` when `galleryExpiresAt - now` is **inclusive** at both
 * ends of `[0, 7 days]`:
 *
 * - exactly 7 days away → `true` ("within 7 days" is inclusive);
 * - 7 days and 1 ms away → `false`;
 * - exactly now → `true` (a gallery that expires this instant has expired);
 * - 1 ms in the past → `false` (already expired is not "expiring soon");
 * - no retention deadline at all → `false`.
 *
 * The inclusive lower end and the zero-width "this instant" arm are the parts
 * the contract does not spell out; ADR-0813 §Assumptions records the choice so
 * the GREEN cannot silently pick the other one.
 */

/** A fixed instant, so no arm depends on when the suite runs. */
const NOW = new Date("2027-02-14T18:00:00.000Z");

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** One case of the window table. */
interface WindowCase {
  readonly name: string;
  /** The offset from `NOW` to `galleryExpiresAt`, in ms; `null` means "no deadline". */
  readonly offsetMs: number | null;
  readonly expected: boolean;
}

const WINDOW_CASES: readonly WindowCase[] = [
  { name: "exactly 7 days away is expiring soon", offsetMs: 7 * DAY_MS, expected: true },
  { name: "7 days and 1 ms away is not", offsetMs: 7 * DAY_MS + 1, expected: false },
  { name: "6 days away is expiring soon", offsetMs: 6 * DAY_MS, expected: true },
  { name: "1 day away is expiring soon", offsetMs: DAY_MS, expected: true },
  { name: "1 ms away is expiring soon", offsetMs: 1, expected: true },
  { name: "expiring this instant is expiring soon", offsetMs: 0, expected: true },
  { name: "1 ms past expiry is not", offsetMs: -1, expected: false },
  { name: "one day past expiry is not", offsetMs: -DAY_MS, expected: false },
  {
    name: "30 days away is not (the window is 7 days, not 30)",
    offsetMs: 30 * DAY_MS,
    expected: false,
  },
  { name: "no retention deadline is not expiring soon", offsetMs: null, expected: false },
];

/** The input one table case builds. */
function inputFor(offsetMs: number | null): { galleryExpiresAt: Date | null; now: Date } {
  return {
    galleryExpiresAt: offsetMs === null ? null : new Date(NOW.getTime() + offsetMs),
    now: NOW,
  };
}

describe("computeExpiringSoon — the 7-day window (contract §6.7)", () => {
  it("the window constant is exactly seven days in milliseconds", () => {
    expect(myEvents.EXPIRING_SOON_WINDOW_MS).toBe(604_800_000);
    expect(myEvents.EXPIRING_SOON_WINDOW_MS).toBe(7 * DAY_MS);
  });

  it.each(WINDOW_CASES)("$name", (testCase) => {
    // Act
    const expiringSoon = myEvents.computeExpiringSoon(inputFor(testCase.offsetMs));

    // Assert
    expect(expiringSoon).toBe(testCase.expected);
  });

  it("does not read the clock itself: the same deadline gives a different answer at a different `now`", () => {
    // Arrange — a deadline 3 days ahead of NOW.
    const galleryExpiresAt = new Date(NOW.getTime() + 3 * DAY_MS);

    // Act / Assert — the answer is a function of `now` alone, so a later `now`
    // moves the same row out of the window without any row changing.
    expect(myEvents.computeExpiringSoon({ galleryExpiresAt, now: NOW })).toBe(true);
    expect(
      myEvents.computeExpiringSoon({
        galleryExpiresAt,
        now: new Date(NOW.getTime() + 4 * DAY_MS),
      })
    ).toBe(false);
  });
});
