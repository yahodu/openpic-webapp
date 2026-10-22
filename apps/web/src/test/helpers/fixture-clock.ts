/**
 * Fixture-clock anchors for integration specs (ADR-0148).
 *
 * **Why this exists.** Integration suites drive the product through an injected
 * clock. When a spec pinned that clock to a literal calendar date (e.g.
 * `2026-03-01`), every row it persisted carried
 * `expireAt = now + retentionDays` — a date already in the *past* against the
 * real wall clock. MongoDB's TTL monitor then deletes those rows asynchronously,
 * and on a loaded host one of its passes lands between the write and the
 * assertion, so the spec asserts against fewer rows than it wrote. That is the
 * class-wide race ADR-0146 diagnosed for the first instance
 * (`notification-quiet-hours-release.test.ts`); this helper is the shared shape
 * the follow-up (OP-96 finding F1) applies across every exposed spec.
 *
 * `fixtureDay()` / `fixtureInstant()` derive the anchor calendar day from the
 * real clock **once, at module load**, so every derived `expireAt` lands
 * ~180 days in the future while the scenario's time-of-day, ordering and
 * relative offsets are unchanged.
 *
 * Never re-introduce a literal fixture date. A fixed *future* literal (e.g.
 * `2027-03-01`) simply re-arms the same time bomb a year out; the anchor must be
 * derived at runtime.
 *
 * @see docs/adr/ADR-0148-integration-fixture-clock-anchor.md
 */

/**
 * The anchor UTC calendar day as `YYYY-MM-DD`, read exactly once when this
 * module is first imported. Caching it here — rather than calling `new Date()`
 * per instant — keeps every instant a spec derives in one run on a single day,
 * even if the wall clock crosses UTC midnight between two fixtures.
 */
const ANCHOR_DAY = new Date().toISOString().slice(0, 10);

/**
 * The anchor day shifted by a whole number of UTC days.
 *
 * @param offsetDays - Whole UTC days from the anchor (`0` today, `1` tomorrow,
 * `-1` yesterday). Defaults to `0`, the anchor itself.
 * @returns The shifted calendar day as `YYYY-MM-DD`.
 * @example
 * ```ts
 * fixtureDay(0) === ANCHOR_DAY; // today, UTC
 * fixtureDay(1); // tomorrow, UTC
 * ```
 */
export function fixtureDay(offsetDays = 0): string {
  if (offsetDays === 0) {
    return ANCHOR_DAY;
  }
  const shifted = new Date(`${ANCHOR_DAY}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * An ISO instant at `timeOfDay` on the anchor day shifted by `offsetDays`.
 *
 * The result is a drop-in replacement for a former `"2026-03-01T10:00:00.000Z"`
 * literal: same time-of-day, anchored calendar day.
 *
 * @param timeOfDay - The UTC time-of-day including its `Z` suffix, e.g.
 * `"10:00:00.000Z"`.
 * @param offsetDays - Whole UTC days from the anchor day (default `0`).
 * @returns The instant as an ISO-8601 string.
 * @example
 * ```ts
 * fixtureInstant("10:00:00.000Z"); // today 10:00 UTC
 * fixtureInstant("07:00:00.000Z", 1); // tomorrow 07:00 UTC
 * ```
 */
export function fixtureInstant(timeOfDay: string, offsetDays = 0): string {
  return `${fixtureDay(offsetDays)}T${timeOfDay}`;
}
