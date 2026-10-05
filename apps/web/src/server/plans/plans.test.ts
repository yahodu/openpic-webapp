import type { ZodError } from "zod";
import { describe, expect, it } from "vitest";

import { entitlementSchema, planCatalogueSchema, planSchema } from "@/server/plans/plans";
import { SEED_PLANS } from "@/server/plans/plans.values";

import { makeEntitlement, makePlan, makePrice } from "../../test/factories/plan";

/**
 * Unit contract — the `plans` catalogue schema (OP-83, schema §14.1, contract
 * §3.1 / Appendix A money rule).
 *
 * `plans` is *policy as data*: entitlements are self-describing (limit +
 * resetPeriod + scope + enforcement) so a new limit is a data edit, and the
 * embedded `prices[]` is the only place a payment vendor may appear. The seed
 * is the code that ships that data, and the schema is the gate it must pass; a
 * malformed plan must be rejected before it reaches the database, not
 * discovered by the entitlement service at runtime.
 *
 * Contract expected of the implementation (`@/server/plans/plans`):
 *
 *   planSchema           : Zod schema of a stored plan document
 *   entitlementSchema    : Zod schema of one self-describing entitlement
 *   planCatalogueSchema  : Zod schema of a plan[] that also enforces catalogue
 *                          invariants (unique `tierRank`, unique `key`)
 *   type Plan, Entitlement, PlanPrice
 *
 * `@/server/plans/plans.values` exports `SEED_PLANS: readonly Plan[]`, the four
 * documented tiers (`free`, `starter`, `professional`, `enterprise`).
 *
 * These specs deliberately assert on the **issue path** of a rejection so a
 * schema that fails for an unrelated reason (a missing required field) cannot
 * masquerade as "the float was caught".
 */

/** The issue paths a failed parse reported, dotted for exact matching. */
type ParseOutcome =
  { readonly success: true } | { readonly success: false; readonly error: ZodError };

function issuePaths(outcome: ParseOutcome): string[] {
  return outcome.success ? [] : outcome.error.issues.map((issue) => issue.path.join("."));
}

describe("planSchema money rule", () => {
  it("U1: rejects a float amountMinor and names the offending price path", () => {
    const plan = makePlan({ prices: [makePrice({ amountMinor: 49900.5 })] });

    expect(issuePaths(planSchema.safeParse(plan))).toContain("prices.0.amountMinor");
  });

  it("U1: accepts an integer amountMinor in minor units", () => {
    const plan = makePlan({ prices: [makePrice({ amountMinor: 49900 })] });

    expect(planSchema.safeParse(plan).success).toBe(true);
  });
});

describe("entitlementSchema feature gate", () => {
  it("U2: a feature entitlement without `enabled` is rejected at the enabled path", () => {
    const entitlement = {
      limit: null,
      resetPeriod: "none",
      scope: "event",
      enforcement: "feature",
    };

    expect(issuePaths(entitlementSchema.safeParse(entitlement))).toContain("enabled");
  });

  it("U2: a feature entitlement with an explicit `enabled` flag is accepted", () => {
    const entitlement = makeEntitlement({
      limit: null,
      resetPeriod: "none",
      scope: "event",
      enforcement: "feature",
      enabled: false,
    });

    expect(entitlementSchema.safeParse(entitlement).success).toBe(true);
  });
});

describe("planCatalogueSchema tierRank uniqueness", () => {
  it("U3: rejects two plans that share a tierRank at the offending tierRank path", () => {
    const catalogue = [
      makePlan({ key: "starter", tierRank: 1 }),
      makePlan({ key: "professional", tierRank: 1 }),
    ];

    // The issue path is asserted, not just failure: the second plan (index 1)
    // must be named, so an unrelated schema failure cannot masquerade as "the
    // duplicate tierRank was caught" (U1/U2 assert their paths the same way).
    expect(issuePaths(planCatalogueSchema.safeParse(catalogue))).toContain("1.tierRank");
  });

  it("U3: accepts a catalogue with distinct tierRanks", () => {
    const catalogue = [
      makePlan({ key: "starter", tierRank: 1 }),
      makePlan({ key: "professional", tierRank: 2 }),
    ];

    expect(planCatalogueSchema.safeParse(catalogue).success).toBe(true);
  });

  it("U3: the seeded catalogue has unique tierRank values", () => {
    const tierRanks = SEED_PLANS.map((plan) => plan.tierRank);

    expect(new Set(tierRanks).size).toBe(SEED_PLANS.length);
    expect(planCatalogueSchema.safeParse(SEED_PLANS).success).toBe(true);
  });
});

describe("seeded plan catalogue invariants", () => {
  it("U4: the enterprise plan is not self-serve and carries no embedded prices", () => {
    const enterprise = SEED_PLANS.find((plan) => plan.key === "enterprise");

    expect(enterprise).toBeDefined();
    expect(enterprise?.selfServe).toBe(false);
    expect(enterprise?.salesAssisted).toBe(true);
    expect(enterprise?.prices).toEqual([]);
  });

  it("U5: the payment vendor name is confined to prices[].externalRefs", () => {
    const withoutExternalRefs = SEED_PLANS.map((plan) => ({
      ...plan,
      prices: plan.prices.map(({ externalRefs: _externalRefs, ...price }) => price),
    }));

    expect(JSON.stringify(withoutExternalRefs).toLowerCase()).not.toContain("cashfree");
  });
});
