import { z } from "zod";

import { dateKeySchema, idSchema, isoDateTimeSchema } from "@openpic/contracts";

import type { AnalyticsMetrics } from "./totals";

/**
 * The `GET /api/v1/tenants/{tenantId}/analytics` wire contract (OP-119,
 * contract §4.5, schema §20.1).
 *
 * §4.5's worked body **flattens** §20.1's `metrics` block onto each `series`
 * element — `dateKey` plus the twelve metrics, not a nested object — and the
 * `totals` is the same twelve keys for the whole window. `serializeResponse`
 * validates strictly, so a response that grew an extra field would fail rather
 * than leak.
 */

/** One non-negative whole-number metric. */
const metricCountSchema = z.number().int().min(0);

/**
 * One schema, one field per §20.1 metric.
 *
 * Typed `satisfies Record<keyof AnalyticsMetrics, …>` so a metric added to the
 * domain interface without a wire field (or vice versa) is a compile error.
 */
const METRIC_SCHEMAS = {
  eventsCreated: metricCountSchema,
  imagesUploaded: metricCountSchema,
  imagesProcessed: metricCountSchema,
  imagesFailed: metricCountSchema,
  selfiesUploaded: metricCountSchema,
  matchesCreated: metricCountSchema,
  uniqueAttendees: metricCountSchema,
  storageBytesAdded: metricCountSchema,
  downloads: metricCountSchema,
  notificationsSent: metricCountSchema,
  revenueMinor: metricCountSchema,
  p95ProcessingMs: metricCountSchema,
} satisfies Record<keyof AnalyticsMetrics, z.ZodType<number>>;

/** The `totals` block: the twelve §20.1 metrics for the whole window. */
export const analyticsMetricsSchema = z.object(METRIC_SCHEMAS);

/** One `series` element: a stored day key plus its twelve metrics, flat. */
export const analyticsSeriesPointSchema = z.object({
  dateKey: dateKeySchema,
  ...METRIC_SCHEMAS,
});

/** The `scope` the request resolved to, echoed with its id as a hex string. */
export const analyticsScopeSchema = z.object({
  kind: z.enum(["tenant", "event"]),
  id: idSchema,
});

/** The `GET /api/v1/tenants/{tenantId}/analytics` response body (§4.5). */
export const analyticsResponseSchema = z.object({
  scope: analyticsScopeSchema,
  from: dateKeySchema,
  to: dateKeySchema,
  series: z.array(analyticsSeriesPointSchema),
  totals: analyticsMetricsSchema,
  computedAt: isoDateTimeSchema,
  note: z.string().min(1),
});

/** One served day: the stored date key plus its metrics. */
export type AnalyticsSeriesPoint = z.infer<typeof analyticsSeriesPointSchema>;

/** The response body of the analytics read. */
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
