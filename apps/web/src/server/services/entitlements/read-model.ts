import { z } from "zod";

import type { Entitlement } from "@/server/plans/plans";
import { startOfNextUtcMonth, startOfNextUtcYear } from "@/server/runtime/time";

import type { ResetPeriod } from "./types";

/**
 * The entitlements read model (OP-104, contract §3.5, schema §14.1/§14.2).
 *
 * Two pieces of the `GET /tenants/{t}/entitlements` response are pure functions
 * of data the endpoint has already resolved, so they live here (and are pinned
 * by `src/test/unit/entitlements-read-model.test.ts`) rather than through a
 * booted app:
 *
 *   - {@link resetsAtFor} — the next reset boundary a quota bar's countdown
 *     counts to; a function of the cadence alone (ADR-0360 §1).
 *   - {@link blockReasonFor} — the global banner's reason; a function of the
 *     subscription status and the resolved entitlement rows (ADR-0360 §2).
 */

/**
 * The `subscriptions.status` enum plus `"none"` for a tenant with no live
 * subscription row (schema §14.3; a free tenant has no document at all).
 */
export const subscriptionStatusSchema = z.enum([
  "none",
  "incomplete",
  "active",
  "past_due",
  "downgraded",
  "cancelled",
  "expired",
]);

/** The subscription lifecycle status as the entitlements view serves it. */
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * The global banner's reason: an exhausted hard limit (`plan_limit`) or a
 * `downgraded` subscription (`payment_downgrade`); `null` when nothing blocks.
 */
export const blockReasonSchema = z.enum(["plan_limit", "payment_downgrade"]).nullable();

/** Why the global banner shows, or `null`. */
export type BlockReason = z.infer<typeof blockReasonSchema>;

/**
 * The slice of a served entitlement row the banner reasons about.
 *
 * `effectiveLimit: null` is unlimited (it can never be exhausted) and `used` is
 * absent for an `event`/`attendee`-scoped row, which carries no count here.
 */
export interface EntitlementQuota {
  readonly enforcement: Entitlement["enforcement"];
  readonly effectiveLimit: number | null;
  readonly used?: number | null;
}

/**
 * The next reset boundary for a cadence, as the start of the next **UTC**
 * period.
 *
 * `monthly` → the first of the next month, `yearly` → the first of the next
 * year, and `lifetime` / `none` → `null` (no boundary). UTC — not the tenant
 * time zone — mirrors the `periodKey` cadence OP-103 pinned (ADR-0340 §4), so
 * the countdown lines up with the counter row it is drawn from.
 *
 * @param resetPeriod - The cadence from the entitlement spec.
 * @param now - The instant the read reasons about.
 * @returns The boundary instant, or `null` when the cadence never resets.
 */
export function resetsAtFor(resetPeriod: ResetPeriod, now: Date): Date | null {
  if (resetPeriod === "monthly") {
    return startOfNextUtcMonth(now);
  }
  if (resetPeriod === "yearly") {
    return startOfNextUtcYear(now);
  }
  return null;
}

/**
 * Derive the global banner's reason (schema §14.2 pseudo-code; ADR-0360 §2).
 *
 * In order:
 *
 *   1. `"payment_downgrade"` when the subscription is `downgraded` — it
 *      outranks a limit block (matching the write-time `402` vs `403` split);
 *   2. `"plan_limit"` when any **`hard`** row is exhausted
 *      (`effectiveLimit !== null && used >= effectiveLimit`);
 *   3. `null` otherwise.
 *
 * Only `hard` blocks: `soft`/`policy` limits tolerate the overage and a
 * `feature` row is a boolean gate. A `past_due` tenant with room is therefore
 * **not** blocked — the subscription endpoint's banner (OP-106) carries the
 * past-due warning.
 *
 * @param subscriptionStatus - The tenant's resolved subscription status.
 * @param entitlements - The resolved entitlement rows.
 * @returns The banner reason, or `null` when nothing blocks.
 */
export function blockReasonFor(
  subscriptionStatus: SubscriptionStatus,
  entitlements: readonly EntitlementQuota[]
): BlockReason {
  if (subscriptionStatus === "downgraded") {
    return "payment_downgrade";
  }
  const exhausted = entitlements.some(
    (row) =>
      row.enforcement === "hard" &&
      row.effectiveLimit !== null &&
      typeof row.used === "number" &&
      row.used >= row.effectiveLimit
  );
  return exhausted ? "plan_limit" : null;
}
