import { describe, expect, it } from "vitest";

import { reduceAnalyticsTotals } from "@/server/analytics/totals";

import { ANALYTICS_METRIC_KEYS, makeAnalyticsMetrics } from "../factories/analytics";

/**
 * Unit — the analytics totals reducer (OP-119 U2, contract §4.5, schema §20.1).
 *
 * `GET /tenants/{t}/analytics` returns `series` (one element per rolled-up day)
 * and `totals` — "totals computed from the series" (the GREEN card's §2). The
 * reducer is the pure function that produces `totals`, so a wrong sum cannot
 * hide behind the route.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/analytics/totals
 *   interface AnalyticsMetrics { … the twelve §20.1 metrics … }
 *   reduceAnalyticsTotals(days: readonly AnalyticsMetrics[]): AnalyticsMetrics
 * ```
 *
 * ## Assumptions (ADR-0640 §Assumptions)
 *
 * - A3 — eleven of the twelve §20.1 metrics are **additive** counters and are
 *   summed across the days. `p95ProcessingMs` is a *percentile*, so summing it
 *   would be meaningless: it is reduced with `Math.max`, the only defensible
 *   day-granularity rollup (a rollup of percentiles cannot be recomputed from
 *   the daily values, and the envelope is what a "p95 over the range" means).
 * - A4 — `uniqueAttendees` is summed, not de-duplicated: each row already
 *   holds that **day's** unique attendees, and the daily rollup stores no
 *   identity set to intersect, so summing is the only computable reading.
 * - A5 — an empty series yields the zero object rather than `null`: `totals`
 *   is always present on the wire (contract §4.5 shows `"totals": { … }`).
 */

describe("U2 — the totals reducer", () => {
  it("returns every metric as zero for an empty series", () => {
    expect(reduceAnalyticsTotals([])).toEqual(makeAnalyticsMetrics());
  });

  it("sums the eleven additive counters across the days", () => {
    const totals = reduceAnalyticsTotals([
      makeAnalyticsMetrics({
        eventsCreated: 3,
        imagesUploaded: 4120,
        imagesProcessed: 4118,
        imagesFailed: 2,
        selfiesUploaded: 87,
        matchesCreated: 1904,
        uniqueAttendees: 84,
        storageBytesAdded: 12_884_901_888,
        downloads: 412,
        notificationsSent: 260,
        revenueMinor: 49_900,
      }),
      makeAnalyticsMetrics({
        eventsCreated: 1,
        imagesUploaded: 900,
        imagesProcessed: 899,
        imagesFailed: 1,
        selfiesUploaded: 13,
        matchesCreated: 400,
        uniqueAttendees: 12,
        storageBytesAdded: 1_073_741_824,
        downloads: 88,
        notificationsSent: 40,
        revenueMinor: 1_000,
      }),
    ]);

    expect(totals).toMatchObject({
      eventsCreated: 4,
      imagesUploaded: 5020,
      imagesProcessed: 5017,
      imagesFailed: 3,
      selfiesUploaded: 100,
      matchesCreated: 2304,
      uniqueAttendees: 96,
      storageBytesAdded: 13_958_643_712,
      downloads: 500,
      notificationsSent: 300,
      revenueMinor: 50_900,
    });
  });

  it("takes the largest p95 of the series instead of summing the percentiles", () => {
    const totals = reduceAnalyticsTotals([
      makeAnalyticsMetrics({ p95ProcessingMs: 3400 }),
      makeAnalyticsMetrics({ p95ProcessingMs: 9100 }),
      makeAnalyticsMetrics({ p95ProcessingMs: 1200 }),
    ]);

    expect(totals.p95ProcessingMs).toBe(9100);
  });

  it("returns exactly the twelve §20.1 metrics and nothing else", () => {
    const totals = reduceAnalyticsTotals([makeAnalyticsMetrics({ imagesUploaded: 7 })]);

    expect(Object.keys(totals).sort()).toEqual([...ANALYTICS_METRIC_KEYS].sort());
  });

  it("reduces a single day to that day's own values", () => {
    const day = makeAnalyticsMetrics({ imagesUploaded: 5, p95ProcessingMs: 700 });

    expect(reduceAnalyticsTotals([day])).toEqual(day);
  });

  it("leaves the days it is given untouched", () => {
    const days = [
      makeAnalyticsMetrics({ imagesUploaded: 2, p95ProcessingMs: 100 }),
      makeAnalyticsMetrics({ imagesUploaded: 3, p95ProcessingMs: 900 }),
    ];
    const snapshot = days.map((day) => ({ ...day }));

    reduceAnalyticsTotals(days);

    expect(days).toEqual(snapshot);
  });
});
