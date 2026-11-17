import { addDays, MS_PER_DAY } from "@/server/runtime/time";

/**
 * Event window arithmetic (OP-115, contract §4.1, schema §15.1).
 *
 * The create route materialises two windows at creation — the upload window
 * (`uploadWindowEndsAt = endAt + events.post_upload_days`) and the gallery
 * retention (`retentionExpiresAt = endAt + gallery.retention_days`) — and it
 * refuses a duration longer than `events.duration_days` computed as
 * `ceil((endAt - startAt) / 1 day)`.
 *
 * All three are pure date arithmetic so they can be unit-driven without a
 * clock or a database (OP-115 U1/U2). Whole-day shifts preserve the time of
 * day; the millisecond arithmetic is exactly a calendar-day count, which is
 * what the contract's worked example relies on (`endAt 2026-11-16T18:00:00Z`
 * + 7 → `2026-11-23T18:00:00Z`, + 90 → `2027-02-14T18:00:00Z`).
 */

/**
 * Materialise the upload-window close: `endAt` plus `postUploadDays` whole
 * days, preserving the time of day.
 *
 * A `null` `postUploadDays` is the **unlimited** case — an unbounded window,
 * materialised as `null` rather than a far-future date, so a sweep reads the
 * same "no close" sentinel the entitlement carries (OP-115 I13).
 *
 * @param endAt - The event end instant.
 * @param postUploadDays - Whole days to keep the upload window open, or `null`
 *   when the entitlement is unlimited.
 * @returns `endAt + postUploadDays` whole days, or `null` when unlimited.
 */
export function computeUploadWindowEndsAt(endAt: Date, postUploadDays: number | null): Date | null {
  return postUploadDays === null ? null : addDays(endAt, postUploadDays);
}

/**
 * The upload-window countdown in whole hours, rounded **up** (OP-116 U3).
 *
 * The event detail response derives `closesInHours` from the materialised
 * `uploadWindowEndsAt` and the current clock. An **upward** rounding means a
 * window closing in 2h03m reports `3`, never `2`, so a UI countdown can never
 * claim more time than the caller actually has. A window already past reports
 * `0` (closed), and an **unlimited** window (`uploadWindowEndsAt === null`)
 * reports `null`.
 *
 * @param uploadWindowEndsAt - The materialised upload-window close, or `null`
 *   when the window is unlimited.
 * @param now - The current clock instant.
 * @returns The upward-rounded whole hours until close (clamped at `0`), or
 *   `null` when the window is unlimited.
 */
export function uploadClosesInHours(uploadWindowEndsAt: Date | null, now: Date): number | null {
  if (uploadWindowEndsAt === null) {
    return null;
  }
  return Math.max(0, Math.ceil((uploadWindowEndsAt.getTime() - now.getTime()) / 3_600_000));
}

/**
 * Materialise the gallery expiry: `endAt` plus `retentionDays` whole days.
 *
 * @param endAt - The event end instant.
 * @param retentionDays - Whole days the gallery is retained after the event.
 * @returns `endAt + retentionDays` whole days, preserving the time of day.
 */
export function computeRetentionExpiresAt(endAt: Date, retentionDays: number): Date {
  return addDays(endAt, retentionDays);
}

/** Inputs for {@link recomputeWindows}: the new end instant and the plan's
 * entitlement values (a `null` on either side means that window is unlimited). */
export interface RecomputeWindowsInput {
  readonly endAt: Date;
  readonly postUploadDays: number | null;
  readonly retentionDays: number | null;
}

/** The result of {@link recomputeWindows}: both materialised windows. */
export interface RecomputeWindowsResult {
  readonly uploadWindowEndsAt: Date | null;
  readonly retentionExpiresAt: Date | null;
}

/**
 * Recompute **both** materialised windows from a moved `endAt` (OP-117 U1,
 * contract §4.1).
 *
 * A date edit moves the event's end, so both windows — the upload close
 * (`endAt + events.post_upload_days`) and the gallery retention
 * (`endAt + gallery.retention_days`) — are derived from the **new** end
 * instant and the plan's entitlement values in one call. `null` on either
 * entitlement materialises that window as `null` (the unlimited cases), and
 * whole-day shifts preserve the time of day, exactly like the create route's
 * per-window helpers.
 *
 * @param input - The new end instant and the two entitlement values.
 * @returns Both recomputed windows.
 */
export function recomputeWindows(input: RecomputeWindowsInput): RecomputeWindowsResult {
  return {
    uploadWindowEndsAt: computeUploadWindowEndsAt(input.endAt, input.postUploadDays),
    retentionExpiresAt:
      input.retentionDays === null
        ? null
        : computeRetentionExpiresAt(input.endAt, input.retentionDays),
  };
}

/**
 * Extend an existing upload-window close by `additionalDays` whole days
 * (OP-117 §3, contract §4.1).
 *
 * The organizer's "extend the upload window" action moves the **materialised**
 * close, not the entitlement: `uploadWindowEndsAt + additionalDays` whole days,
 * preserving the time of day, exactly like {@link computeUploadWindowEndsAt}
 * derives it from `endAt`. The instant handed in is never mutated.
 *
 * @param uploadWindowEndsAt - The row's current upload-window close.
 * @param additionalDays - Whole days to add (the route refuses anything that is
 *   not a strictly positive integer).
 * @returns A new `Date` `additionalDays` after `uploadWindowEndsAt`.
 */
export function extendUploadWindow(uploadWindowEndsAt: Date, additionalDays: number): Date {
  return addDays(uploadWindowEndsAt, additionalDays);
}

/**
 * The event duration in whole days, **rounded up** (contract §4.1).
 *
 * A same-day event (`08:00 → 17:00`) is one day, an exact 24h span is one
 * day, and a two-day-plus-one-millisecond span is three days.
 *
 * @param startAt - The event start instant.
 * @param endAt - The event end instant.
 * @returns `ceil((endAt - startAt) / 86_400_000)`.
 */
export function computeDurationDays(startAt: Date, endAt: Date): number {
  return Math.ceil((endAt.getTime() - startAt.getTime()) / MS_PER_DAY);
}
