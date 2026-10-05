import { randomUUID } from "node:crypto";

import type { Db, Document } from "mongodb";
import { describe, expect, it } from "vitest";

import { SEED_PLANS } from "@/server/plans/plans.values";
import { seedPlans } from "@/server/plans/seed-plans";

/**
 * Unit contract — `seedPlans` absorbs a racing-upsert duplicate-key error
 * (OP-83 follow-up, ADR-0015 §2 "The unique index + `E11000` absorption").
 *
 * The `{key:1}` unique index (`plans_key_unique`) is the cross-process backstop
 * for two deploy instances that race the initial insert. One writer wins; the
 * other's `updateOne(…, { upsert: true })` surfaces MongoDB's `E11000`
 * (duplicate key). That is not an error the caller may see — `seedPlans` must
 * treat the collision as "another writer won" and re-apply the same pipeline as
 * a **plain** (non-upsert) update against the document the winner inserted,
 * so it converges rather than crashing a deploy.
 *
 * These specs drive the platform collection handle directly (a scripted fake
 * `Db` handed in through the `db` seam) because the integration concurrency
 * specs run in a single process and never call `ensureIndexes`, so
 * `runExclusive` serialization means the real `updateOne` never throws
 * `E11000` there — the absorption path would otherwise be unreachable.
 *
 * Contract expected of the implementation (`@/server/plans/seed-plans`):
 *
 *   seedPlans({ db?, plans?, clock? }): Promise<readonly Plan[]>
 *     - on a `{ code: 11000 }` rejection from the upsert, retries the SAME
 *       pipeline with no `upsert` option and resolves with the catalogue;
 *     - a rejection that is NOT a duplicate-key error is re-thrown unchanged.
 */

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** One captured `updateOne` call, as it reached the driver boundary. */
interface CapturedUpdate {
  readonly filter: Document;
  readonly pipeline: Document[];
  readonly options: Document;
}

/** A fake `Db` whose `plans` handle is scripted per `updateOne` attempt. */
interface ScriptedPlansDb {
  readonly db: Db;
  readonly updates: CapturedUpdate[];
}

/**
 * Build a fake `Db` exposing only the `plans` collection handle `seedPlans`
 * reaches through `platformRepo`.
 *
 * @param run - The `updateOne` implementation; receives the captured call and
 *   the 1-based attempt number so a spec can fail the first call and succeed
 *   the retry.
 * @returns The fake `db` and the calls it captured, in order.
 */
function scriptedPlansDb(
  run: (update: CapturedUpdate, attempt: number) => Promise<unknown>
): ScriptedPlansDb {
  const updates: CapturedUpdate[] = [];
  let attempt = 0;

  const collection = {
    updateOne(filter: Document, pipeline: Document[], options: Document = {}) {
      const update: CapturedUpdate = { filter, pipeline, options };
      updates.push(update);
      attempt += 1;
      return run(update, attempt);
    },
  };

  const db = {
    // Unique per spec so the module-level `runExclusive` queue key never
    // couples one spec's seeds to another's.
    databaseName: `openpic_plans_unit_${randomUUID().replace(/-/g, "")}`,
    collection: (name: string) => {
      if (name !== "plans") {
        throw new Error(`seedPlans must only touch the plans collection, reached "${name}"`);
      }
      return collection;
    },
  } as unknown as Db;

  return { db, updates };
}

/** MongoDB's duplicate-key error shape, as the driver surfaces it. */
function duplicateKeyError(): Error {
  return Object.assign(new Error("E11000 duplicate key error collection: plans index: key"), {
    code: DUPLICATE_KEY,
  });
}

describe("seedPlans duplicate-key absorption (E11000)", () => {
  it("resolves with the catalogue when the upsert loses the insert race", async () => {
    const { db, updates } = scriptedPlansDb((_update, attempt) =>
      attempt === 1 ? Promise.reject(duplicateKeyError()) : Promise.resolve({ acknowledged: true })
    );

    await expect(seedPlans({ db, plans: SEED_PLANS })).resolves.toEqual(SEED_PLANS);

    // Absorbing one plan's collision must not abandon the rest: every plan is
    // still written (the raced one twice — upsert then reconcile).
    expect(new Set(updates.map((update) => update.filter.key))).toEqual(
      new Set(SEED_PLANS.map((plan) => plan.key))
    );
  });

  it("re-applies the identical pipeline as a plain update against the winner's document", async () => {
    const { db, updates } = scriptedPlansDb((_update, attempt) =>
      attempt === 1 ? Promise.reject(duplicateKeyError()) : Promise.resolve({ acknowledged: true })
    );

    await seedPlans({ db, plans: SEED_PLANS });

    const upsert = updates[0];
    const reconcile = updates[1];

    expect(upsert?.options).toEqual({ upsert: true });
    // The reconcile must NOT ask to upsert again: the winner's document exists,
    // so this is a plain update (a second upsert could re-throw E11000).
    expect(reconcile?.options).toEqual({});
    expect(reconcile?.filter).toEqual(upsert?.filter);
    expect(reconcile?.pipeline).toEqual(upsert?.pipeline);
  });

  it("re-throws a non-duplicate error from the upsert instead of swallowing it", async () => {
    const { db } = scriptedPlansDb(() => Promise.reject(new Error("mongo unavailable")));

    await expect(seedPlans({ db, plans: SEED_PLANS })).rejects.toThrow("mongo unavailable");
  });
});
