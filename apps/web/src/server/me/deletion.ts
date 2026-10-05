import { z } from "zod";

/**
 * Account-deletion schedule and wire shapes (OP-91, contract §1.4).
 *
 * `POST /api/v1/me/deletion` does not delete anything: it schedules the purge
 * `deletionGraceDays` after the request and opens a cancel window until that
 * instant. The grace window is a runtime tunable read from
 * `platformSettings.account.deletionGraceDays` (CONVENTIONS §6), never a
 * hard-coded 14-day constant — {@link computeDeletionScheduledAt} is the pure
 * arithmetic the route feeds the loaded settings into.
 */

/** The deletion route path (the response `cancelUrl`, contract §1.4). */
export const DELETION_PATH = "/api/v1/me/deletion";

/** Milliseconds in one calendar day, used for the grace-window offset. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The `POST /me/deletion` request body (§1.4). */
export const deletionRequestSchema = z.object({
  reason: z.string().optional(),
  confirmEmail: z.string(),
});

/** The `POST /me/deletion` 202 body (§1.4). */
export const deletionResponseSchema = z.object({
  status: z.literal("deletion_pending"),
  scheduledAt: z.string(),
  cancelUntil: z.string(),
  cancelUrl: z.string(),
});

/** The parsed deletion request body. */
export type DeletionRequest = z.infer<typeof deletionRequestSchema>;

/** The projected deletion response body. */
export type DeletionResponse = z.infer<typeof deletionResponseSchema>;

/** The settings slice the schedule reads (§20.4). */
export interface DeletionScheduleSettings {
  readonly account: { readonly deletionGraceDays: number };
}

/**
 * Compute the instant an account purge becomes eligible.
 *
 * @param now - The request instant; never mutated.
 * @param settings - The loaded platform settings carrying the grace window.
 * @returns A **new** `Date` `deletionGraceDays` after `now`.
 */
export function computeDeletionScheduledAt(now: Date, settings: DeletionScheduleSettings): Date {
  return new Date(now.getTime() + settings.account.deletionGraceDays * DAY_MS);
}
