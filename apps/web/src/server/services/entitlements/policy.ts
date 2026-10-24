import type { EntitlementGrant, EntitlementSpec, ResetPeriod } from "./types";

/**
 * The pure limit arithmetic of the entitlement service (OP-103, schema §14.2;
 * ADR-0340 §4).
 *
 * These two functions carry no I/O and no plan knowledge: the limit is a
 * function of the stored, self-describing spec and the tenant's grants, and the
 * period key is a function of the reset cadence alone.
 */

/**
 * Whether a grant's window covers `now` (`validFrom <= now < validUntil`).
 *
 * Exposed so the entitlements read view can serve exactly the grants it counted
 * into `effectiveLimit` (OP-104, contract §3.5).
 *
 * @param grant - The grant under test.
 * @param now - The instant the check reasons about.
 * @returns `true` while the grant is active.
 */
export function isGrantActive(grant: EntitlementGrant, now: Date): boolean {
  const at = now.getTime();
  if (grant.validFrom.getTime() > at) {
    return false;
  }
  return grant.validUntil === null || at < grant.validUntil.getTime();
}

/**
 * The effective limit: `overrideLimit ?? plan.limit + Σ active grants.delta`.
 *
 * An unlimited plan limit (`limit: null`) stays unlimited however many grants
 * exist; an active grant's non-null `overrideLimit` replaces the plan limit and
 * the deltas entirely.
 *
 * @param spec - The stored entitlement spec.
 * @param grants - Every grant row for the key (active ones are selected here).
 * @param now - The instant the check reasons about.
 * @returns The effective limit, or `null` when unlimited.
 */
export function effectiveLimit(
  spec: EntitlementSpec,
  grants: readonly EntitlementGrant[],
  now: Date
): number | null {
  if (spec.limit === null) {
    return null;
  }

  const active = grants.filter((grant) => isGrantActive(grant, now));
  const override = active.find((grant) => grant.overrideLimit !== null);
  if (override !== undefined && override.overrideLimit !== null) {
    return override.overrideLimit;
  }

  const delta = active.reduce((total, grant) => total + grant.delta, 0);
  return spec.limit + delta;
}

/**
 * The counter identity for a reset cadence.
 *
 * `monthly` → `YYYY-MM` in **UTC**, `yearly` → `YYYY`, and `lifetime` / `none`
 * → the literal `"lifetime"`. UTC (not the tenant time zone) is deliberate: the
 * counter row's identity must not change when a tenant edits
 * `settings.defaultTimeZone` (ADR-0340 §4).
 *
 * @param resetPeriod - The cadence from the entitlement spec.
 * @param now - The instant the check reasons about.
 * @returns The period key.
 */
export function periodKey(resetPeriod: ResetPeriod, now: Date): string {
  if (resetPeriod === "monthly") {
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${String(now.getUTCFullYear())}-${month}`;
  }
  if (resetPeriod === "yearly") {
    return String(now.getUTCFullYear());
  }
  return "lifetime";
}
