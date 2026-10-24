import type { EntitlementGrant } from "@/server/services/entitlements";

/**
 * Entitlement fixtures (OP-103, schema §14.2).
 *
 * `usageCounters`, `entitlementGrants` and `subscriptions` are read by the
 * entitlement service inside the metered-write transaction, so every spec that
 * exercises a limit needs schema-shaped rows to state only the field under
 * test. These builders are deliberately **plain objects** — a `buildX` factory
 * that parsed its own output could not produce the boundary rows (an expired
 * grant, a `downgraded` subscription) the specs exist to pin.
 *
 * The `EntitlementGrant` shape is imported **type-only** so this module has no
 * runtime dependency on the not-yet-implemented service.
 *
 * @see {@link https://github.com/yahodu/openpic-webapp} schema §14.2.
 */

/**
 * Build an `entitlementGrants` row.
 *
 * The baseline is a currently-active additive top-up (`validFrom` in the past,
 * `validUntil: null`), so a spec that wants an expired or not-yet-started grant
 * overrides exactly one boundary field.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A schema-shaped grant.
 */
export function makeGrant(overrides: Partial<EntitlementGrant> = {}): EntitlementGrant {
  return {
    delta: 5,
    overrideLimit: null,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: null,
    ...overrides,
  };
}

/**
 * The stored fields of a `subscriptions` row the entitlement check reads.
 */
export interface SubscriptionFixture {
  readonly tenantId: string;
  readonly subscribedPlanKey: string;
  readonly subscribedPlanVersion: number;
  readonly activePlanKey: string;
  readonly status: string;
  readonly pendingDueMinor: number;
  readonly currency: string;
  readonly gracePeriodEndsAt: Date | null;
}

/**
 * Build a `subscriptions` row.
 *
 * The baseline is a paid-up `active` subscription on the paid tier, so the
 * `plan_limit` path is the default and a spec opts into `downgraded` +
 * `pendingDueMinor` for the `payment_downgrade` path (schema §14.3).
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A schema-shaped subscription row.
 */
export function makeSubscription(
  overrides: Partial<SubscriptionFixture> = {}
): SubscriptionFixture {
  return {
    tenantId: "t_op103",
    subscribedPlanKey: "professional",
    subscribedPlanVersion: 1,
    activePlanKey: "professional",
    status: "active",
    pendingDueMinor: 0,
    currency: "INR",
    gracePeriodEndsAt: null,
    ...overrides,
  };
}

/**
 * The stored fields of a `usageCounters` row.
 */
export interface UsageCounterFixture {
  readonly tenantId: string;
  readonly entitlementKey: string;
  readonly periodKey: string;
  readonly value: number;
  readonly updatedAt: Date;
}

/**
 * Build a `usageCounters` row.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A schema-shaped counter row.
 */
export function makeUsageCounter(
  overrides: Partial<UsageCounterFixture> = {}
): UsageCounterFixture {
  return {
    tenantId: "t_op103",
    entitlementKey: "events.active",
    periodKey: "2026-09",
    value: 0,
    updatedAt: new Date("2026-09-15T10:00:00.000Z"),
    ...overrides,
  };
}
