import { describe, expect, it } from "vitest";

import { dateKeyInTimeZone, dayWindowUtc } from "@/server/jobs/analytics-rollup";

/**
 * Unit — the `analytics-rollup` date bucket (OP-139 U1, contract §10.2; schema
 * §20.1; ADR-0918).
 *
 * The user story: *as an operator, the nightly rollup writes one row per
 * calendar day, so a day's row must mean the same day the organizer's dashboard
 * means.* The platform buckets every tenant's day in **Asia/Kolkata** (a fixed
 * `+05:30` with no DST), and the rollup's window is therefore
 * `[IST midnight, next IST midnight)` — never a UTC day, which would cut a
 * Bangalore evening in half and put 18:30–24:00 UTC into the wrong row.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/analytics-rollup` must export two pure functions:
 *
 * - `dateKeyInTimeZone(instant: Date, timeZone: string): string` — the
 *   `YYYY-MM-DD` calendar day `instant` falls in, in `timeZone`. It never reads
 *   the wall clock and never mutates its argument.
 * - `dayWindowUtc(dateKey: string, timeZone: string): { start: Date; end: Date }`
 *   — the half-open instant window `[start, end)` that day covers, expressed in
 *   UTC instants, so source collections can be range-filtered.
 *
 * Both take the zone as an argument rather than closing over `"Asia/Kolkata"`,
 * which is what the second describe block pins: a hard-coded offset would pass
 * the IST table and fail the `UTC` case.
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A1 — the day key is a calendar day, not a 24-hour instant span: a DST zone
 *   would still be one day, and IST needs no special case because it has no DST.
 * - A2 — `dayWindowUtc` is half-open, so a row at exactly `end` belongs to the
 *   next day and never to both.
 */
describe("U1: the date bucket computation in Asia/Kolkata", () => {
  const IST = "Asia/Kolkata";

  it.each([
    // 23:59:59.999 IST — the last instant of the 17th.
    ["2026-11-17T18:29:59.999Z", "2026-11-17"],
    // 00:00:00.000 IST — the first instant of the 18th.
    ["2026-11-17T18:30:00.000Z", "2026-11-18"],
    // 01:30 IST on the 18th, while UTC still reads the 17th: a UTC bucket
    // answers "2026-11-17" here, so this row is the IST discriminator.
    ["2026-11-17T20:00:00.000Z", "2026-11-18"],
    // 10:30 IST — both zones agree, the ordinary arm.
    ["2026-11-17T05:00:00.000Z", "2026-11-17"],
    // 00:29:59.999 IST on 2026-12-01.
    ["2026-11-30T18:29:59.999Z", "2026-11-30"],
    // 00:30 IST on 2026-12-01: the month rolls with the IST midnight.
    ["2026-11-30T19:00:00.000Z", "2026-12-01"],
  ])("buckets %s into the IST day %s", (instant, expected) => {
    expect(dateKeyInTimeZone(new Date(instant), IST)).toBe(expected);
  });

  it("keeps the instant it is given unchanged", () => {
    const instant = new Date("2026-11-17T18:30:00.000Z");

    dateKeyInTimeZone(instant, IST);

    expect(instant.toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });

  it("buckets in the zone it is given, not in Asia/Kolkata", () => {
    const instant = new Date("2026-11-17T20:00:00.000Z");

    expect(dateKeyInTimeZone(instant, "UTC")).toBe("2026-11-17");
    expect(dateKeyInTimeZone(instant, IST)).toBe("2026-11-18");
  });

  it("returns the half-open UTC window of an IST day", () => {
    const window = dayWindowUtc("2026-11-17", IST);

    expect(window.start.toISOString()).toBe("2026-11-17T18:30:00.000Z");
    expect(window.end.toISOString()).toBe("2026-11-18T18:30:00.000Z");
  });

  it("returns the UTC-midnight window when the zone is UTC", () => {
    const window = dayWindowUtc("2026-11-17", "UTC");

    expect(window.start.toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("places the window's own day key on both ends' day", () => {
    const window = dayWindowUtc("2026-11-17", IST);

    expect(dateKeyInTimeZone(window.start, IST)).toBe("2026-11-17");
    // The end is exclusive: the last instant inside the window is one
    // millisecond earlier, and that one is still the 17th.
    expect(dateKeyInTimeZone(new Date(window.end.getTime() - 1), IST)).toBe("2026-11-17");
    expect(dateKeyInTimeZone(window.end, IST)).toBe("2026-11-18");
  });
});
