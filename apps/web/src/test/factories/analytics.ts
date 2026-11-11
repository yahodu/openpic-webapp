import type { AnalyticsMetrics } from "@/server/analytics/totals";

/**
 * Analytics rollup fixtures (OP-119, schema §20.1).
 *
 * `analyticsDaily` is the **only** collection the tenant analytics endpoint may
 * read (contract §4.5), so every analytics spec seeds the same row shape
 * rather than re-typing a twelve-field `metrics` block. The metrics are built
 * as plain objects with a zero baseline: a spec overrides exactly the counters
 * it asserts, so a wrong reducer cannot be hidden by an unrelated default.
 *
 * The `AnalyticsMetrics` shape is imported **type-only**, so this module has no
 * runtime dependency on the module the RED spec expects to exist.
 */

/** The twelve §20.1 metric field names, in schema order. */
export const ANALYTICS_METRIC_KEYS = [
  "eventsCreated",
  "imagesUploaded",
  "imagesProcessed",
  "imagesFailed",
  "selfiesUploaded",
  "matchesCreated",
  "uniqueAttendees",
  "storageBytesAdded",
  "downloads",
  "notificationsSent",
  "revenueMinor",
  "p95ProcessingMs",
] as const;

/** The keys one `series[]` element carries on the wire (contract §4.5). */
export const ANALYTICS_SERIES_KEYS: readonly string[] = [
  "dateKey",
  ...ANALYTICS_METRIC_KEYS,
].sort();

/**
 * Build a `metrics` object with every §20.1 field defaulted to zero.
 *
 * @param overrides - The counters the calling spec asserts.
 * @returns A complete `metrics` block.
 */
export function makeAnalyticsMetrics(overrides: Partial<AnalyticsMetrics> = {}): AnalyticsMetrics {
  return {
    eventsCreated: 0,
    imagesUploaded: 0,
    imagesProcessed: 0,
    imagesFailed: 0,
    selfiesUploaded: 0,
    matchesCreated: 0,
    uniqueAttendees: 0,
    storageBytesAdded: 0,
    downloads: 0,
    notificationsSent: 0,
    revenueMinor: 0,
    p95ProcessingMs: 0,
    ...overrides,
  };
}

/** The `scope` half of an `analyticsDaily` row (schema §20.1). */
export interface AnalyticsScopeFixture {
  /** Which aggregate the row belongs to. */
  readonly kind: "tenant" | "event" | "platform";
  /** The tenant or event id (`ObjectId`), or `null` for the platform scope. */
  readonly id: unknown;
}

/** The stored `analyticsDaily` row shape the endpoint reads (schema §20.1). */
export interface AnalyticsDailyFixture {
  readonly scope: AnalyticsScopeFixture;
  readonly dateKey: string;
  readonly metrics: AnalyticsMetrics;
  readonly computedAt: Date;
}

/**
 * Build a stored `analyticsDaily` row.
 *
 * @param input - The scope, the `YYYY-MM-DD` day and any counters to override.
 * @returns A schema §20.1 document, ready for `insertOne`.
 */
export function makeAnalyticsDailyRow(input: {
  readonly scope: AnalyticsScopeFixture;
  readonly dateKey: string;
  readonly metrics?: Partial<AnalyticsMetrics>;
  readonly computedAt?: Date;
}): AnalyticsDailyFixture {
  return {
    scope: input.scope,
    dateKey: input.dateKey,
    metrics: makeAnalyticsMetrics(input.metrics ?? {}),
    computedAt: input.computedAt ?? new Date("2026-09-26T02:00:00.000Z"),
  };
}
