import type { Db } from "mongodb";

import { canonicalJson } from "@/server/idempotency";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { planCatalogueSchema, type Plan } from "./plans";
import { SEED_PLANS } from "./plans.values";

/**
 * The `plans` catalogue seed (OP-83, Appendix F "Seed plans catalogue").
 *
 * Unlike the create-only `platformSettings` seed, {seedPlans} is
 * **create-or-reconcile**: `plans` is code-owned policy that a deploy updates,
 * so an existing plan's entitlements are rewritten when the catalogue's differ
 * — and `version` (what a subscription records as "the plan I bought",
 * schema §14.1) is bumped by exactly one when that happens. An idempotent
 * re-run changes nothing, so a cron/deploy re-run never re-versions a plan and
 * strands a grandfathered customer (I1, ADR-0014 §6).
 *
 * The catalogue is parsed through {@link planCatalogueSchema} before any
 * write, so a duplicate `tierRank`/`key` or a malformed entitlement is refused
 * at the seed rather than persisted.
 */

/** The platform-scope collection the catalogue is stored in (schema §14.1). */
const PLANS_COLLECTION = "plans";

/** The stored plan fields the seed reads back to reconcile. */
interface StoredPlan {
  readonly entitlements: Plan["entitlements"];
  readonly version: number;
}

/** Optional seams for {@link seedPlans}. */
export interface SeedPlansOptions {
  /** The database handle; defaults to the shared client (OP-75). */
  readonly db?: Db;
  /** The catalogue to seed; defaults to {@link SEED_PLANS}. Tests inject a mutated catalogue. */
  readonly plans?: readonly Plan[];
  /** The clock stamped into `updatedAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** The catalogue fields that are refreshed on every run, independently of `version`. */
function catalogueFields(plan: Plan): Record<string, unknown> {
  return {
    name: plan.name,
    description: plan.description,
    marketingFeatures: plan.marketingFeatures,
    tierRank: plan.tierRank,
    selfServe: plan.selfServe,
    salesAssisted: plan.salesAssisted,
    active: plan.active,
    prices: plan.prices,
  };
}

/**
 * Seed the `plans` catalogue, create-or-reconcile.
 *
 * For each plan, one document is upserted by `key`:
 *
 *   - a missing plan is inserted with the catalogue's `version`;
 *   - a plan whose **entitlements changed** is updated and its `version`
 *     advanced by exactly one;
 *   - a plan whose entitlements are unchanged is updated in place with
 *     `version` **untouched**.
 *
 * @param options - The database/catalogue/clock seams.
 * @returns The validated catalogue that was seeded.
 */
export async function seedPlans(options: SeedPlansOptions = {}): Promise<readonly Plan[]> {
  const clock = options.clock ?? systemClock;
  const catalogue = planCatalogueSchema.parse(options.plans ?? SEED_PLANS);
  const collection = platformRepo(options.db).collection(PLANS_COLLECTION);
  const updatedAt = clock.now();

  for (const plan of catalogue) {
    const existing = (await collection.findOne({ key: plan.key })) as StoredPlan | null;
    const fields = { ...catalogueFields(plan), updatedAt };

    if (existing === null) {
      await collection.insertOne({
        key: plan.key,
        ...fields,
        version: plan.version,
        entitlements: plan.entitlements,
      });
      continue;
    }

    const entitlementsChanged =
      canonicalJson(existing.entitlements) !== canonicalJson(plan.entitlements);

    await collection.updateOne(
      { key: plan.key },
      entitlementsChanged
        ? {
            $set: {
              ...fields,
              entitlements: plan.entitlements,
              version: existing.version + 1,
            },
          }
        : { $set: fields }
    );
  }

  return catalogue;
}
