import { z } from "zod";

import { formatEntitlementDisplay } from "./plan-display";
import {
  enforcementSchema,
  entitlementScopeSchema,
  resetPeriodSchema,
  type Entitlement,
  type Plan,
  type PlanPrice,
} from "./plans";

/**
 * The served projection of the `plans` catalogue (OP-102, contract §3.1,
 * schema §14.1, ADR-0320).
 *
 * The stored plan document carries fields the public pricing page must never
 * see — the payment vendor refs in `prices[].externalRefs` (contract §0.15) and
 * the price lifecycle (`validFrom`/`validUntil`) — so every document is
 * projected onto a served shape with the never-return fields dropped. Each
 * entitlement gains the synthesised `display` string
 * ({@link formatEntitlementDisplay}) and each price is filtered to the
 * requested `currency`/`billingCycle` and to `active: true`.
 *
 * The schemas are the executable §3.1 contract: the route serializes every body
 * through {@link servedPlanListSchema}, so a leaked field is a validation
 * failure rather than a silent wire detail.
 */

/** Fields shared by a served plan price (contract §3.1; no lifecycle, no refs). */
export const servedPriceSchema = z
  .object({
    priceKey: z.string(),
    billingCycle: z.enum(["monthly", "yearly"]),
    amountMinor: z.number().int(),
    currency: z.string(),
    taxBehavior: z.enum(["inclusive", "exclusive"]),
    trialDays: z.number().int(),
    active: z.boolean(),
  })
  .strict();

/** One entitlement as the §3.1 projection serves it — stored spec plus `display`. */
export const servedEntitlementSchema = z
  .object({
    limit: z.number().int().nullable(),
    resetPeriod: resetPeriodSchema,
    scope: entitlementScopeSchema,
    enforcement: enforcementSchema,
    enabled: z.boolean().optional(),
    display: z.string(),
  })
  .strict();

/** One plan as the §3.1 projection serves it. */
export const servedPlanSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    marketingFeatures: z.array(z.string()),
    tierRank: z.number().int(),
    selfServe: z.boolean(),
    salesAssisted: z.boolean(),
    version: z.number().int(),
    prices: z.array(servedPriceSchema),
    entitlements: z.record(z.string(), servedEntitlementSchema),
    contactSalesUrl: z.string().optional(),
  })
  .strict();

/** The §3.1 `{ data }` envelope. */
export const servedPlanListSchema = z.object({ data: z.array(servedPlanSchema) });

/** A served plan (contract §3.1). */
export type ServedPlan = z.infer<typeof servedPlanSchema>;

/** A served plan price (contract §3.1). */
export type ServedPrice = z.infer<typeof servedPriceSchema>;

/** The sales-assisted tiers' call-to-action target (contract §3.1 example). */
const CONTACT_SALES_URL = "/contact-sales";

/** The `currency`/`billingCycle` query filters; `null` means "not supplied". */
export interface PlanPriceFilter {
  readonly currency: string | null;
  readonly billingCycle: string | null;
}

/**
 * Project one stored price onto the §3.1 served shape.
 *
 * Drops the lifecycle fields (`validFrom`/`validUntil`) and **never** carries
 * `externalRefs` (contract §0.15).
 *
 * @param price - The stored embedded price.
 * @returns The served price.
 */
export function projectPrice(price: PlanPrice): ServedPrice {
  return {
    priceKey: price.priceKey,
    billingCycle: price.billingCycle,
    amountMinor: price.amountMinor,
    currency: price.currency,
    taxBehavior: price.taxBehavior,
    trialDays: price.trialDays,
    active: price.active,
  };
}

/**
 * Project one stored entitlement onto the §3.1 served shape.
 *
 * The stored spec is served verbatim plus its synthesised `display`; `enabled`
 * is carried only when the stored spec sets it (a feature gate).
 *
 * @param key - The entitlement key.
 * @param spec - The stored entitlement spec.
 * @returns The served entitlement.
 */
export function projectEntitlement(
  key: string,
  spec: Entitlement
): z.infer<typeof servedEntitlementSchema> {
  return {
    limit: spec.limit,
    resetPeriod: spec.resetPeriod,
    scope: spec.scope,
    enforcement: spec.enforcement,
    ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    display: formatEntitlementDisplay(key, spec),
  };
}

/** True when a price is active and matches the requested currency/billingCycle. */
function priceMatches(price: PlanPrice, filter: PlanPriceFilter): boolean {
  if (!price.active) {
    return false;
  }
  if (filter.currency !== null && price.currency !== filter.currency) {
    return false;
  }
  return filter.billingCycle === null || price.billingCycle === filter.billingCycle;
}

/**
 * Project one stored plan onto the §3.1 pricing-page shape.
 *
 * @param plan - The validated stored plan.
 * @param filter - The requested `currency`/`billingCycle` price filter.
 * @returns The served plan, with `contactSalesUrl` on sales-assisted tiers.
 */
export function projectPlan(plan: Plan, filter: PlanPriceFilter): ServedPlan {
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description,
    marketingFeatures: [...plan.marketingFeatures],
    tierRank: plan.tierRank,
    selfServe: plan.selfServe,
    salesAssisted: plan.salesAssisted,
    version: plan.version,
    prices: plan.prices.filter((price) => priceMatches(price, filter)).map(projectPrice),
    entitlements: Object.fromEntries(
      Object.entries(plan.entitlements).map(([key, spec]) => [key, projectEntitlement(key, spec)])
    ),
    ...(plan.salesAssisted ? { contactSalesUrl: CONTACT_SALES_URL } : {}),
  };
}
