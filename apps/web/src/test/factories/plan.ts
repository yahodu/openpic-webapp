/**
 * Plan / entitlement / price fixture builders (OP-83, schema §14.1).
 *
 * The `plans` catalogue is seed data, so every spec that touches a plan needs a
 * complete, schema-shaped document to state only the field under test. These
 * builders are deliberately **plain objects that are not parsed**: the whole
 * point of U1/U2/U3 is to hand a *malformed* document to the Zod schema, and a
 * `buildX` factory that parsed its own output could not produce one. The
 * "fixtures are built through factories that call `schema.parse`" convention
 * (`docs/CONVENTIONS.md` §3) applies to contract/route fixtures, not to the
 * deliberately-invalid inputs of a schema-rejection spec.
 *
 * @see {@link https://github.com/yahodu/openpic-webapp} schema §14.1.
 */
import type { Entitlement, Plan, PlanPrice } from "@/server/plans/plans";

/**
 * Build a self-describing entitlement spec.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid entitlement.
 */
export function makeEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    limit: 1,
    resetPeriod: "monthly",
    scope: "tenant",
    enforcement: "hard",
    ...overrides,
  };
}

/**
 * Build an embedded price.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid price.
 */
export function makePrice(overrides: Partial<PlanPrice> = {}): PlanPrice {
  return {
    priceKey: "starter-monthly-inr",
    billingCycle: "monthly",
    amountMinor: 49900,
    currency: "INR",
    taxBehavior: "inclusive",
    trialDays: 0,
    active: true,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: null,
    externalRefs: [
      { provider: "cashfree", env: "production", kind: "plan", id: "STARTER_MONTHLY_V1" },
    ],
    ...overrides,
  };
}

/**
 * Build a complete plan document.
 *
 * @param overrides - Fields to replace on the baseline.
 * @returns A valid plan.
 */
export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    key: "starter",
    name: "Starter",
    description: "For small events",
    marketingFeatures: ["7 active events"],
    tierRank: 1,
    selfServe: true,
    salesAssisted: false,
    active: true,
    version: 1,
    prices: [makePrice()],
    entitlements: {
      "events.active": makeEntitlement({ limit: 7 }),
      "originals.download": makeEntitlement({
        limit: null,
        resetPeriod: "none",
        scope: "event",
        enforcement: "feature",
        enabled: false,
      }),
    },
    ...overrides,
  };
}
