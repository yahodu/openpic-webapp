import type { Db, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

import type { AnalyticsRange } from "./date-range";
import type { AnalyticsSeriesPoint } from "./schema";
import type { AnalyticsMetrics } from "./totals";

/**
 * The `analyticsDaily` read model (OP-119, contract §4.5, schema §20.1).
 *
 * The endpoint's hard rule is that it reads **only** pre-aggregated rollups —
 * never a transactional collection at request time — so this module is the
 * whole data path: one `find` over the requested scope and day window, sorted
 * oldest first. Whatever the nightly rollup job stored is exactly what the
 * dashboard sees, which is what keeps request latency independent of how many
 * images an event has.

 * The collection carries `scope.id` instead of a `tenantId` field, so it is read
 * through `platformRepo`; the tenant boundary is the `scope` filter the caller
 * passes in, which the route builds from the authorised tenant (or the event
 * verified to belong to it).
 */

/** Which aggregate a rollup row belongs to. */
export interface AnalyticsScopeTarget {
  /** The stored `scope.kind` discriminant (never `platform`: the route refuses it). */
  readonly kind: "tenant" | "event";
  /** The stored `scope.id` — the tenant or event the row aggregates. */
  readonly id: ObjectId;
}

/** A stored `analyticsDaily` document, as far as this read cares (schema §20.1). */
interface AnalyticsDailyRow {
  readonly dateKey?: unknown;
  readonly metrics?: Record<string, unknown>;
}

/** Read one stored metric, defaulting an absent or non-numeric value to zero. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Project a stored `metrics` block onto the twelve §20.1 fields.
 *
 * @param metrics - The stored block, when the row carries one.
 * @returns The metrics, with every absent counter at zero.
 */
function toMetrics(metrics: Record<string, unknown> | undefined): AnalyticsMetrics {
  return {
    eventsCreated: toCount(metrics?.eventsCreated),
    imagesUploaded: toCount(metrics?.imagesUploaded),
    imagesProcessed: toCount(metrics?.imagesProcessed),
    imagesFailed: toCount(metrics?.imagesFailed),
    selfiesUploaded: toCount(metrics?.selfiesUploaded),
    matchesCreated: toCount(metrics?.matchesCreated),
    uniqueAttendees: toCount(metrics?.uniqueAttendees),
    storageBytesAdded: toCount(metrics?.storageBytesAdded),
    downloads: toCount(metrics?.downloads),
    notificationsSent: toCount(metrics?.notificationsSent),
    revenueMinor: toCount(metrics?.revenueMinor),
    p95ProcessingMs: toCount(metrics?.p95ProcessingMs),
  };
}

/**
 * Read the stored rollups for one scope and window.
 *
 * Both `from` and `to` are inclusive. A day with no stored row is **not**
 * materialised as a zero element: `series` carries stored days only, because a
 * synthetic zero day is indistinguishable from a real zero-activity day
 * (ADR-0640 §A9).
 *
 * @param db - The database to read.
 * @param scope - The aggregate the caller resolved to.
 * @param range - The validated inclusive window.
 * @returns The stored days, oldest first, each with its twelve flat metrics.
 */
export async function readAnalyticsSeries(
  db: Db,
  scope: AnalyticsScopeTarget,
  range: AnalyticsRange
): Promise<AnalyticsSeriesPoint[]> {
  const rows = (await platformRepo(db)
    .collection(COLLECTIONS.analyticsDaily)
    .find({
      "scope.kind": scope.kind,
      "scope.id": scope.id,
      dateKey: { $gte: range.from, $lte: range.to },
    })
    .sort({ dateKey: 1 })
    .toArray()) as AnalyticsDailyRow[];

  return rows.map((row) => ({ dateKey: String(row.dateKey), ...toMetrics(row.metrics) }));
}
