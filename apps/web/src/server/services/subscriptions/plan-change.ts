import { z } from "zod";

import type { Plan } from "@/server/plans/plans";

/**
 * The plan-change decisions and wire shapes (OP-109, contract §3.3; ADR-0460).
 *
 * The billing plan-change surface makes two decisions **before** it touches
 * Mongo or a payment provider, and both are pure functions here so they are
 * pinnable away from the HTTP pipeline:
 *
 *   - {@link comparePlanTiers} — the `tierRank` relation. §3.3 refuses
 *     `POST /billing/upgrade` with `422 not_an_upgrade` when the target rank is
 *     **not higher** than the current one (`<=`), so the route branches on the
 *     three-way relation (`!== "upgrade"`) rather than on a boolean;
 *   - {@link computeDowngradeConsequences} — what a self-serve downgrade will
 *     constrain, computed from the tenant's resolved usage against the target
 *     plan's limits. §3.3 makes `destructive: false` a **hard invariant**: every
 *     emitted consequence is non-destructive, and nothing already created is
 *     retroactively removed or hidden.
 *
 * The module holds no I/O and reads no clock: the route owns the reads, the
 * writes and the provider call, so these two functions are exercisable without
 * a database.
 */

/**
 * How a target tier relates to the current one (contract §3.3).
 *
 * A three-way relation rather than a boolean, because `not_an_upgrade` covers
 * `<=`: an **equal** rank is refused by the upgrade endpoint too, and the route
 * must be able to distinguish "you are already there" from "that is a
 * downgrade" without re-deriving equality.
 */
export type PlanChangeDirection = "upgrade" | "downgrade" | "same";

/**
 * Classify a target tier against the current one (§3.3).
 *
 * @param currentTierRank - The live plan's `tierRank`.
 * @param targetTierRank - The requested plan's `tierRank`.
 * @returns `upgrade` when the target rank is strictly higher, `downgrade` when
 *   strictly lower, and `same` when equal.
 */
export function comparePlanTiers(
  currentTierRank: number,
  targetTierRank: number
): PlanChangeDirection {
  if (targetTierRank > currentTierRank) {
    return "upgrade";
  }
  if (targetTierRank < currentTierRank) {
    return "downgrade";
  }
  return "same";
}

/** One resolved usage fact for an entitlement the current plan gates (§14.2). */
export interface EntitlementUsageFact {
  /** The entitlement key the counter belongs to. */
  readonly entitlementKey: string;
  /** The counter value for the current period (`0` when no row exists). */
  readonly used: number;
}

/**
 * One consequence a downgrade will constrain (§3.3).
 *
 * `destructive` is typed `boolean` — **not** the literal `false` — so the RED's
 * runtime pin (`consequence.destructive !== false`) stays a meaningful
 * comparison: with a literal-`false` property TypeScript proves the comparison
 * always false and the repository's type-aware ESLint
 * (`@typescript-eslint/no-unnecessary-boolean-literal-compare`) rejects the
 * spec. §3.3's invariant is upheld by the calculator, which emits `false` for
 * every consequence it pushes, and by that runtime pin, not by the type
 * (ADR-0461 records the deviation from ADR-0460 §3).
 */
export interface DowngradeConsequence {
  /** The entitlement key the consequence is about. */
  readonly entitlementKey: string;
  /** A sentence an organizer can act on. */
  readonly effect: string;
  /** §3.3's hard invariant: a downgrade prompt is never a threat (always `false`). */
  readonly destructive: boolean;
  /** The tenant's current usage (metered over-limit shape only). */
  readonly currentUsage?: number;
  /** The target plan's limit (metered over-limit shape only). */
  readonly newLimit?: number;
  /** The current plan's ceiling (policy ceiling-shrink shape only). */
  readonly current?: number;
  /** The target plan's ceiling (policy ceiling-shrink shape only). */
  readonly new?: number;
}

/** The input {@link computeDowngradeConsequences} reasons about. */
export interface DowngradeConsequencesInput {
  /** The plan the tenant is on. */
  readonly currentPlan: Plan;
  /** The plan the tenant is moving down to. */
  readonly targetPlan: Plan;
  /** The tenant's resolved usage facts for the current plan's keys. */
  readonly usage: readonly EntitlementUsageFact[];
}

/** The target entitlement keys the consequence walk visits. */
function constrainedKeys(targetPlan: Plan): readonly (readonly [string, number])[] {
  const keys: (readonly [string, number])[] = [];
  for (const [key, spec] of Object.entries(targetPlan.entitlements)) {
    // A `feature` gate is not a usage constraint, and an unlimited ceiling
    // cannot be exceeded — neither is something to acknowledge.
    if (spec.enforcement === "feature" || spec.limit === null) {
      continue;
    }
    keys.push([key, spec.limit]);
  }
  return keys;
}

/**
 * Compute the consequences of moving from `currentPlan` to `targetPlan` (§3.3).
 *
 * The walk visits the **target** plan's entitlements — a key the target does not
 * gate is not a constraint — and is pure: the route resolves the usage facts
 * from `usageCounters` and passes them in. Per key:
 *
 *   - `feature` gate, or `limit === null` (unlimited) → no consequence;
 *   - a usage fact exists and `used > target.limit` →
 *     `{ currentUsage, newLimit }`;
 *   - a usage fact exists and `used <= target.limit` (headroom, or a key the
 *     tenant simply has not used) → no consequence;
 *   - no usage fact, and the current plan gates the key with a **larger**
 *     ceiling → `{ current, new }`;
 *   - otherwise → no consequence.
 *
 * @param input - The two plans and the tenant's resolved usage facts.
 * @returns The consequences, every one non-destructive.
 */
export function computeDowngradeConsequences(
  input: DowngradeConsequencesInput
): readonly DowngradeConsequence[] {
  const usedByKey = new Map(input.usage.map((fact) => [fact.entitlementKey, fact.used]));
  const currentLimits = new Map(
    Object.entries(input.currentPlan.entitlements).map(([key, spec]) => [key, spec.limit])
  );
  const consequences: DowngradeConsequence[] = [];

  for (const [key, limit] of constrainedKeys(input.targetPlan)) {
    const used = usedByKey.get(key);
    if (used !== undefined) {
      if (used > limit) {
        consequences.push({
          entitlementKey: key,
          effect: `You are currently using ${String(used)} of "${key}", above the ${String(limit)} allowed on the ${input.targetPlan.name} plan. Nothing already created is removed.`,
          destructive: false,
          currentUsage: used,
          newLimit: limit,
        });
      }
      continue;
    }

    const currentLimit = currentLimits.get(key) ?? null;
    if (currentLimit !== null && currentLimit > limit) {
      consequences.push({
        entitlementKey: key,
        effect: `The "${key}" limit drops from ${String(currentLimit)} to ${String(limit)} on the ${input.targetPlan.name} plan. Nothing already created is removed.`,
        destructive: false,
        current: currentLimit,
        new: limit,
      });
    }
  }

  return consequences;
}

/** The `POST /billing/upgrade` request body (contract §3.3). */
export const upgradeRequestSchema = z.object({
  targetPlanKey: z.string().min(1),
  priceKey: z.string().min(1),
  returnUrl: z.string().min(1),
});

/** The parsed upgrade request. */
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>;

/**
 * The §3.3 upgrade response — the checkout envelope plus the two
 * upgrade-specific fields.
 *
 * Strict by construction (the serializer validates strictly), so a
 * vendor-shaped field or a stored `_id` leaked onto the wire is a serialization
 * failure rather than a §0.15 violation (§0.15 never-return).
 */
export const upgradeEnvelopeSchema = z.object({
  subscriptionId: z.string().min(1),
  status: z.literal("incomplete"),
  paymentMethodKind: z.literal("mandate_upi"),
  amountMinor: z.number().int(),
  currency: z.literal("INR"),
  checkout: z.object({
    kind: z.literal("redirect"),
    url: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
  requiresReauthorization: z.literal(true),
  notice: z.string().min(1),
});

/** The §3.3 upgrade response envelope. */
export type UpgradeEnvelope = z.infer<typeof upgradeEnvelopeSchema>;

/** The `POST /billing/downgrade` request body (contract §3.3). */
export const downgradeRequestSchema = z.object({
  targetPlanKey: z.string().min(1),
  acknowledgeConsequences: z.boolean().optional(),
});

/** The parsed downgrade request. */
export type DowngradeRequest = z.infer<typeof downgradeRequestSchema>;

/** The `scheduledChange` block a downgrade writes and serves (§14.3). */
export const scheduledChangeSchema = z.object({
  toPlanKey: z.string().min(1),
  effectiveAt: z.string().min(1),
});

/** The §3.3 `200` downgrade response. */
export const downgradeResponseSchema = z.object({
  scheduledChange: scheduledChangeSchema,
});

/** The §3.3 downgrade response. */
export type DowngradeResponse = z.infer<typeof downgradeResponseSchema>;
