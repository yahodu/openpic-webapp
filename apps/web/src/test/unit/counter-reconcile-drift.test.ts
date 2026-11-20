import { describe, expect, it } from "vitest";

import { isDriftSignificant } from "@/server/jobs/counter-reconcile";

/**
 * Unit — the `counter-reconcile` drift threshold decision (OP-139 U2, contract
 * §10.2, §9.10; ADR-0918).
 *
 * The user story: *as an operator I want cached counters corrected nightly, and
 * only a drift big enough to be worth an alert raised to the admin channel.*
 * Correcting every drift is unconditional; **alerting** is the part with a
 * threshold, and `admin.abuse.flagged` carries admin users on a digest throttle
 * (§7.6), so one noisy field must not page on every tick.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/counter-reconcile` must export:
 *
 * ```ts
 * export function isDriftSignificant(
 *   drift: { readonly cached: number; readonly actual: number },
 *   thresholdPercent: number
 * ): boolean;
 * ```
 *
 * - the drift is expressed **relative to the recomputed value**:
 *   `|cached - actual| / actual * 100` when `actual > 0`;
 * - when `actual === 0` the drift is `0` if `cached === 0` (nothing cached,
 *   nothing in the source) and `100` otherwise (the cache claims rows the source
 *   does not have) — never a division by zero and never `Infinity`;
 * - the comparison is **strictly above** the threshold, so a drift exactly at
 *   the configured threshold is not significant (the card's "drift above a
 *   settings threshold").
 *
 * The function is pure: no clock, no database, no logger. The job supplies the
 * threshold it read from `platformSettings.jobs.counterReconcile`.
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A3 — drift is measured against the **actual** (recomputed) value, not the
 *   cached one: the question is "how wrong is the cache", and the source is the
 *   truth.
 * - A4 — the threshold is inclusive at its own value and exclusive above it,
 *   matching the contract's "above".
 */
describe("U2: the drift threshold decision", () => {
  it.each([
    {
      label: "no drift against a zero threshold",
      drift: { cached: 100, actual: 100 },
      threshold: 0,
      expected: false,
    },
    // 4 % of 100 against a 5 % threshold is inside the tolerance.
    {
      label: "a 4 % under-rating against 5 %",
      drift: { cached: 96, actual: 100 },
      threshold: 5,
      expected: false,
    },
    // The cache over-rated by 4 % is the same 4 %.
    {
      label: "a 4 % over-rating against 5 %",
      drift: { cached: 104, actual: 100 },
      threshold: 5,
      expected: false,
    },
    // Exactly at the threshold is not *above* it.
    {
      label: "an over-rating exactly at the threshold",
      drift: { cached: 105, actual: 100 },
      threshold: 5,
      expected: false,
    },
    {
      label: "an under-rating exactly at the threshold",
      drift: { cached: 95, actual: 100 },
      threshold: 5,
      expected: false,
    },
    // One point above, in both directions.
    {
      label: "an over-rating one point above the threshold",
      drift: { cached: 106, actual: 100 },
      threshold: 5,
      expected: true,
    },
    {
      label: "an under-rating one point above the threshold",
      drift: { cached: 94, actual: 100 },
      threshold: 5,
      expected: true,
    },
    // Nothing cached and nothing in the source: the two agree.
    {
      label: "an empty cache over an empty source",
      drift: { cached: 0, actual: 0 },
      threshold: 5,
      expected: false,
    },
    // The cache claims rows the source does not have: a full 100 % drift.
    {
      label: "a cache claiming rows the source does not have",
      drift: { cached: 7, actual: 0 },
      threshold: 5,
      expected: true,
    },
    // Nothing cached but rows exist: equally a full 100 % drift.
    {
      label: "an empty cache over a populated source",
      drift: { cached: 0, actual: 40 },
      threshold: 5,
      expected: true,
    },
    // A zero threshold makes any difference significant, and an exact match not.
    {
      label: "one row of drift against a zero threshold",
      drift: { cached: 101, actual: 100 },
      threshold: 0,
      expected: true,
    },
    {
      label: "no drift against a zero threshold, again",
      drift: { cached: 100, actual: 100 },
      threshold: 0,
      expected: false,
    },
  ])("decides $label as $expected", ({ drift, threshold, expected }) => {
    expect(isDriftSignificant(drift, threshold)).toBe(expected);
  });
});
