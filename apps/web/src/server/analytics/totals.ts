/**
 * The analytics metric rollup (OP-119, contract §4.5, schema §20.1).
 *
 * `GET /tenants/{tenantId}/analytics` answers a `series` — one element per
 * stored `analyticsDaily` day — plus `totals`: "totals computed from the
 * series". This module is that computation, kept pure so a wrong sum cannot
 * hide behind the route: the endpoint reads rollups and reduces them, and
 * nothing else.
 */

/** The twelve §20.1 metrics a daily rollup row carries. */
export interface AnalyticsMetrics {
  /** Events created during the day. */
  eventsCreated: number;
  /** Original images uploaded during the day. */
  imagesUploaded: number;
  /** Images whose pipeline run succeeded. */
  imagesProcessed: number;
  /** Images whose pipeline run failed. */
  imagesFailed: number;
  /** Attendee selfies uploaded. */
  selfiesUploaded: number;
  /** Face matches created. */
  matchesCreated: number;
  /** That day's unique attendees. */
  uniqueAttendees: number;
  /** Bytes of new object storage. */
  storageBytesAdded: number;
  /** Original downloads. */
  downloads: number;
  /** Notifications sent. */
  notificationsSent: number;
  /** Revenue recognised, in minor units. */
  revenueMinor: number;
  /** p95 pipeline processing latency, in milliseconds. */
  p95ProcessingMs: number;
}

/**
 * Sum one additive metric across the days.
 *
 * @param days - The served days.
 * @param metric - Reads the metric from one day.
 * @returns The metric's total for the window.
 */
function sumMetric(
  days: readonly AnalyticsMetrics[],
  metric: (day: AnalyticsMetrics) => number
): number {
  return days.reduce((total, day) => total + metric(day), 0);
}

/**
 * Reduce a range's daily rollups to its totals.
 *
 * The eleven additive counters are summed across the days — that includes
 * `uniqueAttendees`, because a row stores only *that day's* uniques and no
 * identity set is kept to intersect (ADR-0640 §A4). `p95ProcessingMs` is the
 * **maximum** of the days: summing percentiles is meaningless and the daily
 * rollup stores no latency samples to re-derive the range's percentile from, so
 * the envelope is the only computable reading (ADR-0640 §A3).
 *
 * The function is total and non-mutating: an empty series yields the all-zero
 * object (never `null`), and the days it is given are never written to.
 *
 * @param days - The served `series`, oldest first.
 * @returns The twelve §20.1 totals for the range.
 * @example
 * reduceAnalyticsTotals([{ imagesUploaded: 3, p95ProcessingMs: 900, … }]);
 * // { imagesUploaded: 3, p95ProcessingMs: 900, … }
 */
export function reduceAnalyticsTotals(days: readonly AnalyticsMetrics[]): AnalyticsMetrics {
  return {
    eventsCreated: sumMetric(days, (day) => day.eventsCreated),
    imagesUploaded: sumMetric(days, (day) => day.imagesUploaded),
    imagesProcessed: sumMetric(days, (day) => day.imagesProcessed),
    imagesFailed: sumMetric(days, (day) => day.imagesFailed),
    selfiesUploaded: sumMetric(days, (day) => day.selfiesUploaded),
    matchesCreated: sumMetric(days, (day) => day.matchesCreated),
    uniqueAttendees: sumMetric(days, (day) => day.uniqueAttendees),
    storageBytesAdded: sumMetric(days, (day) => day.storageBytesAdded),
    downloads: sumMetric(days, (day) => day.downloads),
    notificationsSent: sumMetric(days, (day) => day.notificationsSent),
    revenueMinor: sumMetric(days, (day) => day.revenueMinor),
    p95ProcessingMs: days.reduce((highest, day) => Math.max(highest, day.p95ProcessingMs), 0),
  };
}
