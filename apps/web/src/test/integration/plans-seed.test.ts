import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import type { Entitlement, Plan } from "@/server/plans/plans";
import { SEED_PLANS } from "@/server/plans/plans.values";
import { seedPlans } from "@/server/plans/seed-plans";

import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

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
 * changed to a value that provably differs from the current one — the shape of
 * a seed edit shipped in a deploy.
 *
 * The changed limit is derived from the stored/current value (and returned, so
 * the spec can assert the fixture really changed) rather than hard-coded: a
 * fixed sentinel could equal a future seeded limit and turn the "changed
 * catalogue" into a no-op, making the version-bump assertion vacuous.
 */
function withChangedStarterEntitlement(): {
  readonly plans: readonly Plan[];
  readonly entitlementKey: string;
  readonly changedLimit: number;
} {
  const starter = SEED_PLANS.find((plan) => plan.key === "starter");
  if (starter === undefined) {
    throw new Error("SEED_PLANS has no starter plan");
  }

  const entitlementKey = Object.keys(starter.entitlements)[0];
  if (entitlementKey === undefined) {
    throw new Error("the starter plan has no entitlements");
  }

  // Read the current limit through `Object.entries` (the security lint treats a
  // dynamic member access as an object-injection sink).
  const currentEntry = Object.entries(starter.entitlements).find(([key]) => key === entitlementKey);
  const currentLimit = currentEntry?.[1].limit ?? null;

  // `+1` is always a different value; a null (unlimited) becomes a finite
  // number, which is also a change. Both stay non-negative integers.
  const changedLimit = currentLimit === null ? 1 : currentLimit + 1;

  const changed: Plan = {
    ...starter,
    entitlements: Object.fromEntries(
      Object.entries(starter.entitlements).map(([key, spec]): [string, Entitlement] =>
        key === entitlementKey ? [key, { ...spec, limit: changedLimit }] : [key, spec]
      )
    ),
  };

  return {
    plans: SEED_PLANS.map((plan) => (plan.key === "starter" ? changed : plan)),
    entitlementKey,
    changedLimit,
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

      const { plans: changed, entitlementKey, changedLimit } = withChangedStarterEntitlement();

      // Guard against a vacuous fixture: the injected limit must differ from the
      // seeded one, or the "bumps version" assertion below proves nothing.
      expect(changedLimit).not.toBe(storedEntitlementLimit(before, entitlementKey));

      await seedPlans({ db: test.db, plans: changed });
      const afterFirst = await raw.findOne({ key: "starter" });

      expect(afterFirst?.version).toBe((before?.version ?? 0) + 1);
      expect(storedEntitlementLimit(afterFirst, entitlementKey)).toBe(changedLimit);

      // The very same catalogue seeded again must not bump a second time.
      await seedPlans({ db: test.db, plans: changed });
      const afterSecond = await raw.findOne({ key: "starter" });

      expect(afterSecond?.version).toBe(afterFirst?.version);
    });
  });
});

describe("plans.key unique index (schema §14.1)", () => {
  it("I2: ensureIndexes builds a unique {key:1} index that rejects a duplicate plan key", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const plans = test.db.collection("plans");

      await plans.insertOne({ key: "starter", version: 1 });

      await expect(plans.insertOne({ key: "starter", version: 2 })).rejects.toMatchObject({
        code: DUPLICATE_KEY,
      });
    });
  });
});

describe("seedPlans concurrency", () => {
  it("I2: overlapping seeds against a fresh database leave exactly one document per key", async () => {
    await withTestDb(async (test) => {
      // Several deploy instances (or a cron racing a deploy) starting together.
      await Promise.all([
        seedPlans({ db: test.db }),
        seedPlans({ db: test.db }),
        seedPlans({ db: test.db }),
        seedPlans({ db: test.db }),
        seedPlans({ db: test.db }),
      ]);

      const rows = await plansCollection(test).find({}).toArray();

      expect(rows).toHaveLength(4);
      expect(rows.map((plan) => plan.key).sort()).toEqual([
        "enterprise",
        "free",
        "professional",
        "starter",
      ]);
    });
  });

  it("I2: overlapping seeds of a changed catalogue store the change once, with no duplicate key", async () => {
    await withTestDb(async (test) => {
      const { plans: changed, entitlementKey, changedLimit } = withChangedStarterEntitlement();

      // A deploy ships an entitlement change and several instances seed it at
      // once. The reconcile must be atomic: one document per key, and the
      // changed entitlement applied exactly once (no half-inserted duplicate).
      await Promise.all([
        seedPlans({ db: test.db, plans: changed }),
        seedPlans({ db: test.db, plans: changed }),
        seedPlans({ db: test.db, plans: changed }),
      ]);

      const rows = await plansCollection(test).find({}).toArray();
      expect(rows).toHaveLength(4);

      const starters = rows.filter((plan) => plan.key === "starter");
      expect(starters).toHaveLength(1);
      expect(storedEntitlementLimit(starters[0] ?? null, entitlementKey)).toBe(changedLimit);
    });
  });
});

/**
 * The stored starter document, narrowed to the catalogue fields these specs
 * inspect verbatim (ADR-0015 §2 / planUpsert's `$literal`).
 */
interface StoredCataloguePlan {
  readonly name?: string;
  readonly description?: string;
  readonly marketingFeatures?: readonly string[];
  readonly prices?: ReadonlyArray<{ readonly priceKey?: string }>;
}

/** Read the stored starter plan, typed to the catalogue fields under test. */
function storedStarterCatalogue(test: TestDb) {
  return test.db.collection<StoredCataloguePlan>("plans").findOne({ key: "starter" });
}

/**
 * The canonical catalogue with the starter plan's fields replaced — the shape a
 * marketing-copy or pricing edit shipped in a deploy can take.
 */
function withStarterFields(overrides: Partial<Plan>): readonly Plan[] {
  return SEED_PLANS.map((plan) => (plan.key === "starter" ? { ...plan, ...overrides } : plan));
}

/**
 * Catalogue round-trip at the database boundary (ADR-0015 §2, `planUpsert`).
 *
 * The seed writes each plan's catalogue fields with an aggregation-pipeline
 * `$set`. In an aggregation expression, a **string value beginning with `$`**
 * is parsed as a *field path* (and an object key beginning with `$` as an
 * operator) — so unless the value is wrapped in `$literal`, a legitimate
 * marketing value such as `"$5 add-on plan"` silently resolves to a missing
 * field and the value is dropped from the stored document, or a `$`-leading
 * array element becomes `null`. The catalogue is code-owned data, so every
 * field it carries must round-trip byte-for-byte; a silent drop is data loss
 * the operator cannot see.
 *
 * Each spec changes exactly one shape (a scalar, an array element, a nested
 * object field) so a fix that `$literal`-wraps only some catalogue fields is
 * caught rather than passing on one representative value.
 */
describe("seedPlans catalogue round-trip ($-leading values)", () => {
  it("I3: stores a `description` beginning with `$` verbatim", async () => {
    await withTestDb(async (test) => {
      const description = "$5 add-on plan";

      await seedPlans({ db: test.db, plans: withStarterFields({ description }) });

      expect((await storedStarterCatalogue(test))?.description).toBe(description);
    });
  });

  it("I3: stores a `name` beginning with `$` verbatim", async () => {
    await withTestDb(async (test) => {
      const name = "$5 add-on plan";

      await seedPlans({ db: test.db, plans: withStarterFields({ name }) });

      expect((await storedStarterCatalogue(test))?.name).toBe(name);
    });
  });

  it("I3: stores a `marketingFeatures` element beginning with `$` verbatim", async () => {
    await withTestDb(async (test) => {
      const feature = "$5 add-on plan";
      const control = "7 active events / month";

      await seedPlans({
        db: test.db,
        plans: withStarterFields({ marketingFeatures: [feature, control] }),
      });

      expect((await storedStarterCatalogue(test))?.marketingFeatures).toEqual([feature, control]);
    });
  });

  it("I3: stores a nested `prices[].priceKey` beginning with `$` verbatim", async () => {
    await withTestDb(async (test) => {
      const starter = SEED_PLANS.find((plan) => plan.key === "starter");
      if (starter === undefined) {
        throw new Error("SEED_PLANS has no starter plan");
      }

      const priceKey = "$5-add-on";
      const prices = starter.prices.map((price) => ({ ...price, priceKey }));

      await seedPlans({ db: test.db, plans: withStarterFields({ prices }) });

      expect((await storedStarterCatalogue(test))?.prices?.[0]?.priceKey).toBe(priceKey);
    });
  });
});
