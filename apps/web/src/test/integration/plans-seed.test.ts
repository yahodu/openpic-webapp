import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeMongoClient } from "@/server/db/mongo";
import type { Entitlement, Plan } from "@/server/plans/plans";
import { SEED_PLANS } from "@/server/plans/plans.values";
import { seedPlans } from "@/server/plans/seed-plans";

import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Integration contract — the `plans` seed against a real MongoDB (OP-83, schema
 * §14.1, Appendix F "Seed plans catalogue").
 *
 * Two properties can only be proven at the database boundary:
 *
 *   1. seeding is idempotent — running the admin script twice (cron / deploy)
 *      leaves exactly the four tiers, one document per `key`;
 *   2. seeding reconciles entitlements **without spurious version churn** — a
 *      changed entitlement bumps `version` exactly once, and a re-run that
 *      changes nothing leaves every `version` untouched. `version` is what a
 *      subscription records as "the plan I bought" (§14.1), so an extra bump
 *      would silently grandfather customers out of a plan they never bought.
 *
 * Contract expected of the implementation:
 *
 *   seedPlans({ db?, plans?, clock? }): Promise<unknown>
 *     `plans` defaults to `SEED_PLANS`; tests inject a mutated catalogue to
 *     simulate a seed change shipped in a deploy.
 *   SEED_PLANS: readonly Plan[]  (`@/server/plans/plans.values`)
 */

beforeAll(() => {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet"
    );
  }

  Object.assign(process.env, toProcessEnv(makeEnv({ APP_ENV: "test", MONGODB_URI: uri })));
});

afterAll(async () => {
  await closeMongoClient();
});

/** The stored plan document, narrowed to the fields these specs inspect. */
interface StoredPlan {
  readonly key: string;
  readonly version: number;
  readonly entitlements: Record<string, { readonly limit: number | null }>;
}

/** Open the platform-scope `plans` collection with its fields typed. */
function plansCollection(test: TestDb) {
  return test.db.collection<StoredPlan>("plans");
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_plans_seed");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Every stored plan as `[key, version]` pairs, sorted for a stable comparison. */
async function versionsByKey(test: TestDb): Promise<Array<[string, number]>> {
  const rows = await plansCollection(test).find({}).toArray();
  const pairs = rows.map((plan): [string, number] => [plan.key, plan.version]);
  return pairs.sort((left, right) => left[0].localeCompare(right[0]));
}

/**
 * The canonical catalogue with the starter plan's first entitlement limit
 * changed — the shape of a seed edit shipped in a deploy.
 */
function withChangedStarterEntitlement(limit: number): {
  readonly plans: readonly Plan[];
  readonly entitlementKey: string;
} {
  const starter = SEED_PLANS.find((plan) => plan.key === "starter");
  if (starter === undefined) {
    throw new Error("SEED_PLANS has no starter plan");
  }

  const entitlementKey = Object.keys(starter.entitlements)[0];
  if (entitlementKey === undefined) {
    throw new Error("the starter plan has no entitlements");
  }

  const changed: Plan = {
    ...starter,
    entitlements: Object.fromEntries(
      Object.entries(starter.entitlements).map(([key, spec]): [string, Entitlement] =>
        key === entitlementKey ? [key, { ...spec, limit }] : [key, spec]
      )
    ),
  };

  return {
    plans: SEED_PLANS.map((plan) => (plan.key === "starter" ? changed : plan)),
    entitlementKey,
  };
}

/**
 * Read one entitlement's stored limit without a computed member access (the
 * security lint treats dynamic indexing as an object-injection sink).
 */
function storedEntitlementLimit(
  plan: StoredPlan | null,
  entitlementKey: string
): number | null | undefined {
  const entry = Object.entries(plan?.entitlements ?? {}).find(([key]) => key === entitlementKey);
  return entry?.[1].limit;
}

describe("seedPlans idempotency", () => {
  it("I1: seeding twice leaves exactly the four catalogue plans, one document per key", async () => {
    await withTestDb(async (test) => {
      await seedPlans({ db: test.db });
      await seedPlans({ db: test.db });

      const raw = plansCollection(test);
      expect(await raw.countDocuments({})).toBe(4);

      const keys = (await raw.find({}).toArray()).map((plan) => plan.key).sort();
      expect(keys).toEqual(["enterprise", "free", "professional", "starter"]);
    });
  });

  it("I1: a re-run with unchanged entitlements leaves every version untouched", async () => {
    await withTestDb(async (test) => {
      await seedPlans({ db: test.db });
      const before = await versionsByKey(test);

      await seedPlans({ db: test.db });

      expect(await versionsByKey(test)).toEqual(before);
    });
  });
});

describe("seedPlans entitlement versioning", () => {
  it("I1: a changed entitlement bumps the version exactly once across re-runs", async () => {
    await withTestDb(async (test) => {
      const raw = plansCollection(test);

      await seedPlans({ db: test.db });
      const before = await raw.findOne({ key: "starter" });
      expect(before).not.toBeNull();

      const { plans: changed, entitlementKey } = withChangedStarterEntitlement(9_999);

      await seedPlans({ db: test.db, plans: changed });
      const afterFirst = await raw.findOne({ key: "starter" });

      expect(afterFirst?.version).toBe((before?.version ?? 0) + 1);
      expect(storedEntitlementLimit(afterFirst, entitlementKey)).toBe(9_999);

      // The very same catalogue seeded again must not bump a second time.
      await seedPlans({ db: test.db, plans: changed });
      const afterSecond = await raw.findOne({ key: "starter" });

      expect(afterSecond?.version).toBe(afterFirst?.version);
    });
  });
});
