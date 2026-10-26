import { describe, expect, it } from "vitest";

import { normalizeInstantToUtc } from "@/server/events/dates";

/**
 * Unit — instant normalisation for event dates (OP-115 U4, contract §4.1,
 * schema §15.1).
 *
 * Event instants are **canonical UTC**: a client may send
 * `startAt` with any RFC 3339 offset (e.g. `+05:30`), and the server stores
 * and returns the same instant as a `Z`-suffixed UTC string. The event's
 * `displayTimeZone` is a *display preference stored separately* — it never
 * participates in the instant arithmetic, so it can differ from the offset the
 * client wrote (the create route pins that separation, I1).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/dates
 *   normalizeInstantToUtc(input: string): string   // parse + re-serialize as "…Z"; throws on a non-instant
 * ```
 */

describe("normalizeInstantToUtc (U4)", () => {
  it("normalises a +05:30 offset instant to the UTC instant with a Z suffix", () => {
    expect(normalizeInstantToUtc("2026-11-14T17:30:00+05:30")).toBe("2026-11-14T12:00:00.000Z");
  });

  it("returns an already-UTC instant unchanged", () => {
    expect(normalizeInstantToUtc("2026-11-14T12:00:00.000Z")).toBe("2026-11-14T12:00:00.000Z");
  });

  it("normalises a negative offset to the UTC instant", () => {
    expect(normalizeInstantToUtc("2026-11-14T07:00:00-05:00")).toBe("2026-11-14T12:00:00.000Z");
  });

  it("normalises an explicit zero offset to the Z form", () => {
    expect(normalizeInstantToUtc("2026-11-14T12:00:00+00:00")).toBe("2026-11-14T12:00:00.000Z");
  });

  it("rejects a non-instant string instead of guessing", () => {
    expect(() => normalizeInstantToUtc("sometime next week")).toThrow();
  });
});
