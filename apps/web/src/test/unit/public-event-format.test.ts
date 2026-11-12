import { describe, expect, it } from "vitest";

import * as publicEvent from "@/server/attendee/public-event";

/**
 * Unit — `startAtLocal` rendering for the public event page (OP-130 U1,
 * contract §6.1, schema §15.1).
 *
 * **Why this exists.** An attendee who scanned a QR must see the event's local
 * time without the browser owning a timezone database: contract §6.1 has the
 * server pre-render `event.startAtLocal` in the event's `displayTimeZone`
 * ("the attendee page needs no timezone library"). The stored instant is
 * canonical UTC and the zone is a **display preference**, so the renderer is a
 * pure function of `(instant, zone)` — and it must be right across a DST
 * boundary, which is exactly where a hand-rolled offset table fails.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/public-event` exports
 * `formatStartAtLocal(startAt: Date, timeZone: string): string`:
 *
 *   - the result is an RFC 3339 local date-time with a **numeric UTC offset**
 *     — `YYYY-MM-DDTHH:mm:ss±HH:MM`, no milliseconds, no `Z` (contract §6.1
 *     shows `"2026-11-14T17:30:00+05:30"`);
 *   - the wall clock is the instant's clock **in `timeZone`**, and the offset is
 *     that zone's offset **at that instant** — so the same zone renders two
 *     different offsets either side of a DST transition;
 *   - it reads no clock, no database and no configuration: every input is an
 *     argument.
 */
interface StartAtLocalCase {
  readonly name: string;
  /** The canonical UTC instant stored on the event (schema §15.1). */
  readonly startAt: string;
  /** The event's `displayTimeZone` (schema §15.1). */
  readonly displayTimeZone: string;
  /** The §6.1 `startAtLocal` the page renders. */
  readonly expected: string;
}

const CASES: readonly StartAtLocalCase[] = [
  // Asia/Kolkata — a fixed +05:30 offset with no DST, so the whole assertion is
  // about the half-hour offset being preserved rather than truncated to +05:00.
  {
    name: "renders Asia/Kolkata at its +05:30 offset",
    startAt: "2026-11-14T12:00:00.000Z",
    displayTimeZone: "Asia/Kolkata",
    expected: "2026-11-14T17:30:00+05:30",
  },
  {
    name: "keeps the date in the zone's calendar, not UTC's",
    startAt: "2026-11-14T20:00:00.000Z",
    displayTimeZone: "Asia/Kolkata",
    expected: "2026-11-15T01:30:00+05:30",
  },
  // America/New_York — standard time (EST, -05:00). The contract's own example
  // instant cannot be used for this zone: it is in EST, not EDT.
  {
    name: "renders America/New_York in standard time at -05:00",
    startAt: "2026-11-14T12:00:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-11-14T07:00:00-05:00",
  },
  // …and daylight time (EDT, -04:00) for an instant inside the DST window.
  {
    name: "renders America/New_York in daylight time at -04:00",
    startAt: "2026-07-04T12:00:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-07-04T08:00:00-04:00",
  },
  // The 2026 spring-forward boundary: 02:00 EST becomes 03:00 EDT. One minute
  // before the transition the offset is still -05:00…
  {
    name: "still renders -05:00 one minute before the spring-forward transition",
    startAt: "2026-03-08T06:59:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-03-08T01:59:00-05:00",
  },
  // …and the interval that would have been 02:00 is already 03:00 EDT.
  {
    name: "renders -04:00 at the instant after the spring-forward transition",
    startAt: "2026-03-08T07:00:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-03-08T03:00:00-04:00",
  },
  // The fall-back boundary: 2026-11-01 02:00 EDT becomes 01:00 EST. An offset
  // cache keyed on the zone (rather than on the instant) gets these two wrong.
  {
    name: "renders -04:00 for the last instant before the fall-back transition",
    startAt: "2026-11-01T05:59:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-11-01T01:59:00-04:00",
  },
  {
    name: "renders -05:00 for the first instant after the fall-back transition",
    startAt: "2026-11-01T06:00:00.000Z",
    displayTimeZone: "America/New_York",
    expected: "2026-11-01T01:00:00-05:00",
  },
];

/**
 * Read the renderer off the module namespace, failing with a message that names
 * the missing export.
 *
 * A named import of a missing export is not a load error — ESM resolves the
 * module and binds `undefined` — so the spec would otherwise die with
 * `TypeError: formatStartAtLocal is not a function`, which is the wrong reason.
 */
function requireFormatStartAtLocal(): (startAt: Date, timeZone: string) => string {
  const exported = (publicEvent as unknown as { formatStartAtLocal?: unknown }).formatStartAtLocal;
  if (typeof exported !== "function") {
    throw new Error(
      "@/server/attendee/public-event must export formatStartAtLocal(startAt: Date, timeZone: string): string"
    );
  }
  return exported as (startAt: Date, timeZone: string) => string;
}

describe("formatStartAtLocal — the pre-rendered local start time (contract §6.1)", () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const formatStartAtLocal = requireFormatStartAtLocal();

    const rendered = formatStartAtLocal(new Date(testCase.startAt), testCase.displayTimeZone);

    expect(rendered).toBe(testCase.expected);
  });

  it("emits a numeric offset with no milliseconds and no Z", () => {
    const formatStartAtLocal = requireFormatStartAtLocal();

    const rendered = formatStartAtLocal(new Date("2026-11-14T12:00:00.123Z"), "Asia/Kolkata");

    // No millisecond fraction: §6.1's value is second-precision.
    expect(rendered).not.toMatch(/\.\d{1,3}/);
    // No `Z`: a `Z` suffix would say "this is UTC", which is the opposite of
    // what a field named `startAtLocal` means.
    expect(rendered.endsWith("Z")).toBe(false);
    // The offset is numeric (±HH:MM) and present.
    expect(rendered).toMatch(/[+-]\d{2}:\d{2}$/);
    // …and the whole string is one RFC 3339 local date-time.
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("keeps the sub-minute remainder out of the offset but keeps the wall clock", () => {
    const formatStartAtLocal = requireFormatStartAtLocal();

    // 12:00:00.123Z is 17:30:00 in Kolkata: the fractional second is dropped
    // from the rendered value, never rounded into the offset.
    expect(formatStartAtLocal(new Date("2026-11-14T12:00:00.123Z"), "Asia/Kolkata")).toBe(
      "2026-11-14T17:30:00+05:30"
    );
  });
});
