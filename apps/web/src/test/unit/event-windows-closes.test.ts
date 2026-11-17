import { describe, expect, it } from "vitest";

import { uploadClosesInHours } from "@/server/events/windows";

/**
 * Unit — the upload-window countdown rounding (OP-116 U3, §3 "windows").
 *
 * The event detail response derives `closesInHours` from the materialised
 * `uploadWindowEndsAt` and the current clock. It is an **upward-rounded whole
 * number of hours**: a window closing in 2h03m reports `3`, never `2`, so a
 * UI countdown can never claim more time than the caller actually has. A
 * window already past reports `0` (closed), and an **unlimited** window
 * (`uploadWindowEndsAt === null`) reports `null`.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/windows
 *   uploadClosesInHours(uploadWindowEndsAt: Date | null, now: Date): number | null
 *     // null  -> null
 *     // else  -> max(0, ceil((uploadWindowEndsAt - now) / 3_600_000))
 * ```
 */

const NOW = new Date("2026-11-16T18:00:00.000Z");

/** An instant `hours` after {@link NOW}, plus `extraMs`. */
function hoursFromNow(hours: number, extraMs = 0): Date {
  return new Date(NOW.getTime() + hours * 3_600_000 + extraMs);
}

describe("uploadClosesInHours (U3)", () => {
  it("returns null when the upload window is unlimited (null)", () => {
    expect(uploadClosesInHours(null, NOW)).toBeNull();
  });

  it("rounds a fractional hour up to the next whole hour", () => {
    expect(uploadClosesInHours(hoursFromNow(2.05), NOW)).toBe(3);
  });

  it("keeps an exact whole-hour window at its whole hour", () => {
    expect(uploadClosesInHours(hoursFromNow(3), NOW)).toBe(3);
  });

  it("reports a sub-hour open window as 1, never 0", () => {
    expect(uploadClosesInHours(hoursFromNow(0.5), NOW)).toBe(1);
  });

  it("rounds a hair over a whole hour up, not down", () => {
    expect(uploadClosesInHours(hoursFromNow(2, 1), NOW)).toBe(3);
  });

  it("reports a window at the exact instant as closed (0)", () => {
    expect(uploadClosesInHours(hoursFromNow(0), NOW)).toBe(0);
  });

  it("reports a window already in the past as closed (0)", () => {
    expect(uploadClosesInHours(hoursFromNow(-0.08), NOW)).toBe(0);
  });
});
