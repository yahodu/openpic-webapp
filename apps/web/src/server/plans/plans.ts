import { z } from "zod";

/**
 * The `plans` catalogue schema (OP-83, schema §14.1, contract §3.1 / Appendix A
 * money rule).
 *
 * `plans` is **policy as data**: each plan carries self-describing
 * entitlements (`limit` + `resetPeriod` + `scope` + `enforcement`, and an
 * optional `enabled` gate) so a new limit is a data edit, and the embedded
 * `prices[]` is the **only** place a payment vendor may appear (design
 * principle P1 / U5). The schema is the gate a seed must pass before a document
 * reaches the database — a malformed plan is rejected here, not discovered by
 * the entitlement service at runtime.
 *
 *   - {@link entitlementSchema} — one self-describing entitlement spec;
 *   - {@link priceSchema} — one embedded price, including the vendor refs that
 *     the never-return rule keeps out of API responses;
 *   - {@link planSchema} — a stored plan document (non-strict, so the driver's
 *     `_id` is tolerated);
 *   - {@link planCatalogueSchema} — a `plan[]` that additionally enforces the
 *     catalogue invariants (unique `tierRank`, unique `key`).
 *
 * The stored entitlement deliberately has **no `display`**: `display` is added
 * by the `GET /plans` projection from the stored spec (ADR-0014 §2).
 */

/** Reset cadence of an entitlement (schema §14.1). */
export const resetPeriodSchema = z.enum(["monthly", "yearly", "lifetime", "none"]);

/** What an entitlement's usage is counted against (schema §14.1). */
export const entitlementScopeSchema = z.enum(["tenant", "event", "attendee"]);

/** How an entitlement failure is handled (schema §14.1). */
export const enforcementSchema = z.enum(["hard", "soft", "policy", "feature"]);

/**
 * One self-describing entitlement spec (schema §14.1).
 *
 * `limit: null` means *unlimited* for `hard`/`soft`/`policy` and *boolean gate*
 * for `feature`. `enabled` is required — and only meaningful — when
 * `enforcement === "feature"`; the refinement rejects a feature entitlement
 * whose on/off flag is missing, at the `enabled` issue path (U2).
 */
export const entitlementSchema = z
  .object({
    limit: z.number().int().min(0).nullable(),
    resetPeriod: resetPeriodSchema,
    scope: entitlementScopeSchema,
    enforcement: enforcementSchema,
    enabled: z.boolean().optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.enforcement === "feature" && spec.enabled === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "a feature entitlement requires an explicit `enabled` flag",
      });
    }
  });

/**
 * A vendor reference on an embedded price (schema §14.1).
 *
 * The provider name (e.g. `cashfree`) is confined to this document so no
 * vendor term leaks into any other field (U5).
 */
export const externalRefSchema = z.object({
  provider: z.string().min(1),
  env: z.string().min(1),
  kind: z.string().min(1),
  id: z.string().min(1),
});

/**
 * One embedded price (schema §14.1).
 *
 * Money is **integer minor units** — a float is rejected at the
 * `amountMinor` issue path (U1, Appendix A). `validFrom`/`validUntil` and
 * `externalRefs` live only in storage; the never-return rule (§0.15) strips
 * the refs from API responses.
 */
export const priceSchema = z.object({
  priceKey: z.string().min(1),
  billingCycle: z.enum(["monthly", "yearly"]),
  amountMinor: z.number().int().min(0),
  currency: z.string().min(1),
  taxBehavior: z.enum(["inclusive", "exclusive"]),
  trialDays: z.number().int().min(0),
  active: z.boolean(),
  validFrom: z.date(),
  validUntil: z.date().nullable(),
  externalRefs: z.array(externalRefSchema).default([]),
});

/**
 * A stored plan document (schema §14.1).
 *
 * Non-strict by design: a document read back from Mongo carries the driver's
 * `_id`, which a default (strip) object tolerates (ADR-0014 §4).
 */
export const planSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  marketingFeatures: z.array(z.string()),
  tierRank: z.number().int().min(0),
  selfServe: z.boolean(),
  salesAssisted: z.boolean(),
  active: z.boolean(),
  version: z.number().int().min(1),
  prices: z.array(priceSchema),
  entitlements: z.record(z.string(), entitlementSchema),
});

/**
 * A plan catalogue — a `plan[]` plus the cross-document invariants the seed
 * must ship: `tierRank` values are unique (a duplicate would make "upgrade or
 * downgrade?" ambiguous, U3) and `key` values are unique (the schema's
 * `{key: 1}` index mirrors this at the database level).
 */
export const planCatalogueSchema = z.array(planSchema).superRefine((plans, ctx) => {
  const seenRanks = new Map<number, number>();
  const seenKeys = new Map<string, number>();

  plans.forEach((plan, index) => {
    const firstRank = seenRanks.get(plan.tierRank);
    if (firstRank !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [index, "tierRank"],
        message: `tierRank ${String(plan.tierRank)} is already used by plan at index ${String(firstRank)}`,
      });
    } else {
      seenRanks.set(plan.tierRank, index);
    }

    const firstKey = seenKeys.get(plan.key);
    if (firstKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [index, "key"],
        message: `plan key "${plan.key}" is already used at index ${String(firstKey)}`,
      });
    } else {
      seenKeys.set(plan.key, index);
    }
  });
});

/** A validated entitlement spec. */
export type Entitlement = z.infer<typeof entitlementSchema>;

/** A validated embedded price. */
export type PlanPrice = z.infer<typeof priceSchema>;

/** A validated stored plan document. */
export type Plan = z.infer<typeof planSchema>;
