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
 * Materialise the gallery expiry: `endAt` plus `retentionDays` whole days.
 *
 * @param endAt - The event end instant.
 * @param retentionDays - Whole days the gallery is retained after the event.
 * @returns `endAt + retentionDays` whole days, preserving the time of day.
 */
export function computeRetentionExpiresAt(endAt: Date, retentionDays: number): Date {
  return addDays(endAt, retentionDays);
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
