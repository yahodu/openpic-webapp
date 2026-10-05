import type { Document, Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { platformRepo, type RepositoryCollection } from "@/server/repos";
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
 * Every plan is written with **one atomic upsert** that computes `version`
 * server-side from the stored entitlements (ADR-0015). Nothing is read before
 * the write, so a run cannot reconcile against a stale document. The
 * `{key:1}` unique index (`plans_key_unique`, `indexes.ts`) is the database
 * backstop for cross-process concurrency; overlapping runs in one process are
 * additionally coalesced ({@link runExclusive}), because MongoDB's upsert can
 * still insert twice when the index has not been bootstrapped yet. A racing
 * cross-process upsert can surface `E11000`, which {@link upsertPlan} absorbs
 * as "another writer won" and reconciles with a non-upsert update.
 *
 * The catalogue is parsed through {@link planCatalogueSchema} before any
 * write, so a duplicate `tierRank`/`key` or a malformed entitlement is refused
 * at the seed rather than persisted.
 */

/** The platform-scope collection the catalogue is stored in (schema §14.1). */
const PLANS_COLLECTION = COLLECTIONS.plans;

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** Optional seams for {@link seedPlans}. */
export interface SeedPlansOptions {
  /** The database handle; defaults to the shared client (OP-75). */
  readonly db?: Db;
  /** The catalogue to seed; defaults to {@link SEED_PLANS}. Tests inject a mutated catalogue. */
  readonly plans?: readonly Plan[];
  /** The clock stamped into `updatedAt`; defaults to the system clock. */
  readonly clock?: Clock;
}

/** True when `error` is MongoDB's duplicate-key error (the unique index rejected an insert). */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * In-process serialization of seed runs, keyed by database + collection.
 *
 * The `{key:1}` unique index is the cross-process backstop, but a database that
 * has not been bootstrapped yet carries no index — and MongoDB's upsert has a
 * documented race where two writers that both miss can both insert. Coalescing
 * same-process runs here makes that case deterministic (a process never runs
 * two overlapping seeds for one collection); cross-process races are still
 * absorbed by the unique index (see {@link upsertPlan}).
 */
const seedQueues = new Map<string, Promise<void>>();

/**
 * Run `task` after any in-flight seed already queued for `lockKey`.
 *
 * @param lockKey - The database + collection the seed writes.
 * @param task - The work to run exclusively.
 * @returns The task's result, once every earlier queued seed has settled.
 */
function runExclusive<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = seedQueues.get(lockKey) ?? Promise.resolve();
  const result = previous.then(task, task);
  // Keep the chain alive even when a run rejects, so later callers still run.
  seedQueues.set(
    lockKey,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
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
 * The single atomic upsert that reconciles one plan (ADR-0015).
 *
 * An aggregation-pipeline update computes `version` from the document already
 * in the database, so the read and the write are one operation:
 *
 *   - **inserted** (missing `entitlements`) → `version` is the catalogue's;
 *   - **entitlements differ** → the stored `version` advances by exactly one;
 *   - **entitlements equal** → the stored `version` is left untouched.
 *
 * `$eq` compares the stored entitlements with the catalogue's as BSON
 * documents; the seed reader and writer both use the catalogue's field order,
 * so a value-only change is detected and a re-run is a no-op.
 *
 * @param plan - The validated catalogue plan.
 * @param updatedAt - The clock reading stamped into the document.
 * @returns The update pipeline for `updateOne({ key }, …, { upsert: true })`.
 */
function planUpsert(plan: Plan, updatedAt: Date): Document[] {
  // Entitlement keys are dotted (`events.active`), which an aggregation
  // expression would read as a field path — `$literal` keeps the catalogue
  // object an opaque value in both the `$set` and the `$eq` comparison.
  const entitlements = { $literal: plan.entitlements };

  return [
    {
      $set: {
        ...catalogueFields(plan),
        updatedAt,
        entitlements,
        version: {
          $cond: [
            { $eq: ["$entitlements", entitlements] },
            { $ifNull: ["$version", plan.version] },
            { $add: [{ $ifNull: ["$version", { $subtract: [plan.version, 1] }] }, 1] },
          ],
        },
      },
    },
  ];
}

/**
 * Upsert one plan, tolerating the documented racing-upsert `E11000`.
 *
 * When two writers race the initial insert, one wins and the other's upsert
 * surfaces a duplicate-key error from the unique index. That is not an error
 * the caller should see: the loser re-applies the same pipeline as a plain
 * update, reconciling against the document the winner created.
 *
 * @param collection - The platform-scope `plans` handle.
 * @param plan - The validated catalogue plan.
 * @param updatedAt - The clock reading stamped into the document.
 */
async function upsertPlan(
  collection: RepositoryCollection,
  plan: Plan,
  updatedAt: Date
): Promise<void> {
  const pipeline = planUpsert(plan, updatedAt);

  try {
    await collection.updateOne({ key: plan.key }, pipeline, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    // Another writer inserted the document between our query and our insert;
    // reconcile against it instead of surfacing the duplicate.
    await collection.updateOne({ key: plan.key }, pipeline);
  }
}

/**
 * Seed the `plans` catalogue, create-or-reconcile.
 *
 * For each plan, one atomic upsert by `key`:
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
  const db = options.db ?? getDb();
  const collection = platformRepo(db).collection(PLANS_COLLECTION);
  const updatedAt = clock.now();

  return runExclusive(`${db.databaseName}\u0000${PLANS_COLLECTION}`, async () => {
    for (const plan of catalogue) {
      await upsertPlan(collection, plan, updatedAt);
    }
    return catalogue;
  });
}
