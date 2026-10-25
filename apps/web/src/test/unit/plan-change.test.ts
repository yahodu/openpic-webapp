import { describe, expect, it } from "vitest";

import type { Plan } from "@/server/plans/plans";
import {
  comparePlanTiers,
  computeDowngradeConsequences,
  type DowngradeConsequence,
  type EntitlementUsageFact,
} from "@/server/services/subscriptions/plan-change";

import { makeEntitlement, makePlan } from "../factories/plan";

/**
 * Unit contract — the plan-change decisions (OP-109 RED, contract §3.3;
 * ADR-0460).
 *
 * The billing plan-change surface makes two decisions **before** it touches
 * Mongo or a payment provider, and both are pure functions here so they are
 * pinnable away from the HTTP pipeline:
 *
 *   - **U2** {@link comparePlanTiers} — the `tierRank` comparison. §3.3 refuses
 *     `POST /billing/upgrade` with `422 not_an_upgrade` when the target rank is
 *     **not higher** than the current one (`<=`), so an equal rank is refused by
 *     the upgrade endpoint too. Everything the route has to decide about the two
 *     ranks is this one three-way relation, so a plan added to the catalogue
 *     cannot make "upgrade or downgrade?" ambiguous.
 *   - **U1** {@link computeDowngradeConsequences} — what a self-serve downgrade
 *     will constrain, computed from the tenant's current usage against the
 *     target plan's limits. §3.3 makes `destructive: false` a **hard invariant**:
 *     "Every `effect` must have `destructive: false`. Nothing already created is
 *     retroactively removed or hidden. If any computed consequence would be
 *     destructive, that is a bug in the consequence calculator, not a valid
 *     response." That invariant holds for *every* consequence this suite can
 *     produce, not just the two the contract's worked example shows.
 *
 * The two shapes the contract's example carries are both pinned: a metered key
 * the tenant has already out-used (`currentUsage` + `newLimit`) and a policy key
 * whose ceiling simply shrinks (`current` + `new`). The calculator's other
 * edges — headroom under the new limit, a key the target plan stops gating
 * entirely, and the no-op plan change — are pinned so the route cannot over- or
 * under-warn.
 */

/** A key the target plan already has the tenant over the limit for. */
const EVENTS_ACTIVE = "events.active";

/** A `policy` key with no usage counter: only its ceiling changes. */
const RETENTION = "gallery.retention_days";

/** A metered key the tenant is well **under** the target limit for. */
const IMAGES = "images.per_event";

/** A key the target plan stops gating altogether. */
const COORGANIZERS = "coorganizers.per_event";

/**
 * A key both plans gate, but the target plan gates as a boolean `feature`
 * rather than a usage ceiling (schema §14.1: a `feature` gate carries
 * `limit: null` and an explicit `enabled` flag).
 */
const FEATURE_KEY = "originals.download";

/**
 * The plan the tenant is on: the higher of the two tiers.
 *
 * Built through the shared factories rather than the seeded catalogue, so the
 * only limits in play are the ones each case states.
 */
const CURRENT_PLAN: Plan = makePlan({
  key: "professional",
  name: "Professional",
  tierRank: 2,
  entitlements: {
    [EVENTS_ACTIVE]: makeEntitlement({ limit: 28 }),
    [RETENTION]: makeEntitlement({
      limit: 365,
      resetPeriod: "none",
      scope: "event",
      enforcement: "policy",
    }),
    [IMAGES]: makeEntitlement({ limit: 20_000, resetPeriod: "none", scope: "event" }),
    [COORGANIZERS]: makeEntitlement({ limit: 10, resetPeriod: "none", scope: "event" }),
  },
});

/**
 * The plan the tenant is moving down to.
 *
 * `coorganizers.per_event` is deliberately **absent**: the target plan does not
 * gate the key at all, which is not a constraint to acknowledge.
 */
const TARGET_PLAN: Plan = makePlan({
  key: "starter",
  name: "Starter",
  tierRank: 1,
  entitlements: {
    [EVENTS_ACTIVE]: makeEntitlement({ limit: 7 }),
    [RETENTION]: makeEntitlement({
      limit: 90,
      resetPeriod: "none",
      scope: "event",
      enforcement: "policy",
    }),
    [IMAGES]: makeEntitlement({ limit: 5_000, resetPeriod: "none", scope: "event" }),
  },
});

/** The tenant's resolved usage: over the new events ceiling, under the images one. */
const USAGE: readonly EntitlementUsageFact[] = [
  { entitlementKey: EVENTS_ACTIVE, used: 15 },
  { entitlementKey: IMAGES, used: 100 },
];

/** The consequences the `USAGE`/`TARGET_PLAN` baseline produces, once. */
const CONSEQUENCES: readonly DowngradeConsequence[] = computeDowngradeConsequences({
  currentPlan: CURRENT_PLAN,
  targetPlan: TARGET_PLAN,
  usage: USAGE,
});

/**
 * The one consequence for `key`, failing loudly when the calculator emitted
 * none (a bare `.find(...)` would make every later assertion vacuous).
 *
 * @param key - The entitlement key to look up.
 * @returns The consequence for that key.
 */
function consequenceFor(key: string): DowngradeConsequence {
  const found = CONSEQUENCES.find((consequence) => consequence.entitlementKey === key);
  if (found === undefined) {
    throw new Error(
      `expected a consequence for "${key}", got ${JSON.stringify(CONSEQUENCES.map((c) => c.entitlementKey))}`
    );
  }
  return found;
}

describe("comparePlanTiers", () => {
  it.each([
    ["a two-rank jump up is an upgrade", 0, 2, "upgrade"],
    ["the next rank up is an upgrade", 1, 2, "upgrade"],
    ["the lowest paid rank up to the top is an upgrade", 0, 3, "upgrade"],
    ["the next rank down is a downgrade", 2, 1, "downgrade"],
    ["the top rank down to free is a downgrade", 3, 0, "downgrade"],
    ["the same paid rank is not a change", 1, 1, "same"],
    ["the same top rank is not a change", 3, 3, "same"],
    ["free to free is not a change", 0, 0, "same"],
  ])("classifies %s", (_description, currentTierRank, targetTierRank, expected) => {
    expect(comparePlanTiers(currentTierRank, targetTierRank)).toBe(expected);
  });

  it("treats an equal rank as not-an-upgrade, which is what the upgrade endpoint refuses", () => {
    // §3.3 refuses `422 not_an_upgrade` for `target.tierRank <= current.tierRank`,
    // so the relation — not a `>` boolean — is what the route branches on.
    expect(comparePlanTiers(2, 2)).not.toBe("upgrade");
  });
});

describe("computeDowngradeConsequences", () => {
  it("flags a metered entitlement the tenant is already over the target's limit for", () => {
    expect(consequenceFor(EVENTS_ACTIVE)).toMatchObject({
      entitlementKey: EVENTS_ACTIVE,
      currentUsage: 15,
      newLimit: 7,
      destructive: false,
    });
  });

  it("flags a policy ceiling that shrinks even though there is no usage counter for it", () => {
    expect(consequenceFor(RETENTION)).toMatchObject({
      entitlementKey: RETENTION,
      current: 365,
      new: 90,
      destructive: false,
    });
  });

  it("does not flag a limit that shrinks while the tenant is under it", () => {
    // `images.per_event` drops 20 000 → 5 000, but only 100 are used: there is
    // headroom, so warning would be a false consequence.
    expect(CONSEQUENCES.map((consequence) => consequence.entitlementKey)).not.toContain(IMAGES);
  });

  it("does not flag an entitlement the target plan stops gating altogether", () => {
    expect(CONSEQUENCES.map((consequence) => consequence.entitlementKey)).not.toContain(
      COORGANIZERS
    );
  });

  it.each([
    ["the catalogue's unlimited feature shape", null],
    ["a feature shape that carries a limit of its own", 1],
  ] as const)(
    "does not flag a key the target plan gates as a feature (%s), though the key is used",
    (_description, featureLimit) => {
      // `originals.download` is present on **both** plans, but the target
      // version is a `feature` gate: a boolean toggle is not a usage ceiling,
      // so it is never something to acknowledge — `constrainedKeys` skips it on
      // `enforcement === "feature"`. The other target key (`events.active`) is
      // over its limit and still emits, so the feature key's absence is the
      // skip and not an accidental absence from the target plan.
      //
      // The second row gives the feature gate a limit *below* the recorded
      // usage, so it would produce a consequence if the walk visited it: the
      // `enforcement` guard — not the `limit === null` guard — is what the pin
      // observes for that row.
      const currentPlan = makePlan({
        key: "professional",
        name: "Professional",
        tierRank: 2,
        entitlements: {
          [EVENTS_ACTIVE]: makeEntitlement({ limit: 28 }),
          [FEATURE_KEY]: makeEntitlement({
            limit: null,
            resetPeriod: "none",
            scope: "event",
            enforcement: "feature",
            enabled: false,
          }),
        },
      });
      const targetPlan = makePlan({
        key: "starter",
        name: "Starter",
        tierRank: 1,
        entitlements: {
          [EVENTS_ACTIVE]: makeEntitlement({ limit: 7 }),
          [FEATURE_KEY]: makeEntitlement({
            limit: featureLimit,
            resetPeriod: "none",
            scope: "event",
            enforcement: "feature",
            enabled: true,
          }),
        },
      });

      const keys = computeDowngradeConsequences({
        currentPlan,
        targetPlan,
        usage: [
          { entitlementKey: EVENTS_ACTIVE, used: 15 },
          { entitlementKey: FEATURE_KEY, used: 3 },
        ],
      }).map((consequence) => consequence.entitlementKey);

      expect(keys).toEqual([EVENTS_ACTIVE]);
    }
  );

  it("does not flag a key the target plan leaves unlimited, though usage exists", () => {
    // `images.per_event` is metered on the current plan and the tenant has used
    // it, but the target plan makes it unlimited (`limit: null`): an unlimited
    // ceiling cannot be exceeded, so a usage fact is not a constraint
    // (`constrainedKeys` skips it on `limit === null`). Without the skip the
    // walk would compare `100 > null` and emit a bogus consequence.
    const currentPlan = makePlan({
      key: "professional",
      name: "Professional",
      tierRank: 2,
      entitlements: {
        [IMAGES]: makeEntitlement({ limit: 20_000, resetPeriod: "none", scope: "event" }),
      },
    });
    const targetPlan = makePlan({
      key: "starter",
      name: "Starter",
      tierRank: 1,
      entitlements: {
        [IMAGES]: makeEntitlement({ limit: null, resetPeriod: "none", scope: "event" }),
      },
    });

    expect(
      computeDowngradeConsequences({
        currentPlan,
        targetPlan,
        usage: [{ entitlementKey: IMAGES, used: 100 }],
      })
    ).toEqual([]);
  });

  it("marks every consequence non-destructive, and reports the offending entries when one is not", () => {
    // §3.3 makes this a hard invariant of the calculator itself. The pin reads
    // each consequence's `destructive` **as a value** and compares it to
    // `false`, keyed by the entitlement it belongs to, so a failure names the
    // offending consequence rather than a bare boolean. Reading the value —
    // instead of a `filter((c) => c.destructive)` predicate or a
    // `c.destructive !== false` comparison — is what lints under
    // `strictTypeChecked` whichever way the field is typed
    // (`no-unnecessary-boolean-literal-compare` rejects the comparison, and a
    // truthiness predicate trips `no-unnecessary-condition` once the field is
    // the literal `false`). ADR-0462 records why this unblocks restoring the
    // literal `false`.
    expect(
      CONSEQUENCES.map((consequence) => [consequence.entitlementKey, consequence.destructive])
    ).toEqual(CONSEQUENCES.map((consequence) => [consequence.entitlementKey, false]));
  });

  it("explains every consequence in a sentence an organizer can act on", () => {
    expect(CONSEQUENCES.filter((consequence) => consequence.effect.trim() === "")).toEqual([]);
  });

  it("returns no consequences when the two plans gate the same limits", () => {
    expect(
      computeDowngradeConsequences({ currentPlan: TARGET_PLAN, targetPlan: TARGET_PLAN, usage: [] })
    ).toEqual([]);
  });

  it("returns no consequences for an upgrade, which only widens limits", () => {
    expect(
      computeDowngradeConsequences({
        currentPlan: TARGET_PLAN,
        targetPlan: CURRENT_PLAN,
        usage: USAGE,
      })
    ).toEqual([]);
  });
});
