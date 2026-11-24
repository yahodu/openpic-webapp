import { describe, expect, it } from "vitest";

import { auditExpireAt } from "./audit-log";

/**
 * Unit contract — the `auditLogs` retention instant (schema §20.2/§22,
 * ADR-0970 §D2, ADR-0971).
 *
 * §20.2 gives every `auditLogs` document an `expireAt` and §22 sets the TTL at
 * **400 days**, "a full audit year". ADR-0970 §D2 puts that arithmetic in one
 * exported pure function, `auditExpireAt(at)`, so the two member verbs and every
 * later audit writer share one definition instead of three copies that can drift
 * by a day each.
 *
 * The function is the smallest load-bearing seam in the decision: the row's
 * `expireAt` is the only field whose **absence** is silent — a row dated a year
 * out instead of 400 days is still a valid document, still queryable, and simply
 * disappears early, after the dispute it was written for. The rows themselves are
 * pinned end-to-end in `tenant-members.test.ts` (`expireAt - at === 400 days`);
 * these cases pin the arithmetic directly, so a drift reds here with the numbers
 * in the message instead of only inside an integration run.
 *
 * ## Contract pinned here (ADR-0970 §D2)
 *
 * ```
 * auditExpireAt(at: Date): Date
 * ```
 *
 * A **new** `Date` exactly `400 * 24 * 60 * 60 * 1000` milliseconds after `at`,
 * and `at` itself is never mutated — the caller keeps the instant it read from the
 * clock, and the row's `at` is that same value. The offset is a fixed
 * millisecond distance, not a calendar addition: a row written before a leap day
 * expires on the same wall-clock instant 400 × 24 h later.
 */
describe("auditExpireAt — the §20.2/§22 retention instant", () => {
  /** §22 — the retention, in milliseconds. */
  const FOUR_HUNDRED_DAYS_MS = 400 * 24 * 60 * 60 * 1000;

  it("returns an instant exactly 400 days after the one it is given", () => {
    const at = new Date("2026-03-04T05:06:07.890Z");

    const expireAt = auditExpireAt(at);

    expect(expireAt.getTime() - at.getTime()).toBe(FOUR_HUNDRED_DAYS_MS);
    // 2026-03-04 + 400 × 24 h — the same clock time, four days past the same
    // date a year on.
    expect(expireAt.toISOString()).toBe("2027-04-08T05:06:07.890Z");
  });

  it("returns a new Date and leaves its argument untouched", () => {
    const at = new Date("2026-03-04T05:06:07.890Z");
    const instantBefore = at.getTime();

    const expireAt = auditExpireAt(at);

    expect(expireAt).not.toBe(at);
    expect(at.getTime()).toBe(instantBefore);
    expect(at.toISOString()).toBe("2026-03-04T05:06:07.890Z");
  });
});
