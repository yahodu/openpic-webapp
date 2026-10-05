import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeMongoClient } from "../../server/db/mongo";
import { platformRepo, tenantRepo } from "../../server/repos";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — aggregation-pipeline updates at the database boundary
 * (OP-77 follow-up t_863fd2d7, finding A).
 *
 * A unit spec pins the arguments the repository hands to the driver; this spec
 * pins the *effect* those arguments have against a real MongoDB. A
 * platform-scope pipeline update must actually reach the driver and mutate the
 * stored document — if the scope transform coerces the pipeline to `{}`, the
 * write is lost (the driver rejects an update with no atomic operators) and
 * `active` never flips, which is what the pre-fix behaviour looked like.
 *
 *   platformRepo(db?).collection(name).updateOne/updateMany/findOneAndUpdate
 *
 * The tenant-scoped pipeline update is also exercised end to end so the fix
 * cannot regress that path: the row is mutated in place and keeps its
 * `tenantId`.
 */

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_platform_repo_pipeline");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

describe("platform-scope aggregation-pipeline updates reach the driver", () => {
  it("I: updateOne applies a $set pipeline to the stored document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection("plans");
      await raw.insertOne({ slug: "pro", active: false });

      const repo = platformRepo(test.db).collection("plans");
      await repo.updateOne({ slug: "pro" }, [{ $set: { active: true } }]);

      const stored = await raw.findOne({ slug: "pro" });
      expect(stored?.active).toBe(true);
      expect(stored?.slug).toBe("pro");
    });
  });

  it("I: updateMany applies a $set pipeline to every matching document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection("plans");
      await raw.insertMany([
        { slug: "free-1", tier: "free", active: false },
        { slug: "free-2", tier: "free", active: false },
        { slug: "pro-1", tier: "pro", active: false },
      ]);

      const repo = platformRepo(test.db).collection("plans");
      const result = await repo.updateMany({ tier: "free" }, [{ $set: { active: true } }]);

      expect(result.modifiedCount).toBe(2);
      expect(await raw.countDocuments({ tier: "free", active: true })).toBe(2);
      expect(await raw.countDocuments({ tier: "pro", active: true })).toBe(0);
    });
  });

  it("I: findOneAndUpdate applies a $set pipeline to the matched document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection("plans");
      await raw.insertOne({ slug: "pro", active: false });

      const repo = platformRepo(test.db).collection("plans");
      await repo.findOneAndUpdate({ slug: "pro" }, [{ $set: { active: true } }]);

      expect((await raw.findOne({ slug: "pro" }))?.active).toBe(true);
    });
  });

  it("I: a multi-stage pipeline applies in order", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection("plans");
      await raw.insertOne({ slug: "legacy", active: false, legacy: true });

      const repo = platformRepo(test.db).collection("plans");
      await repo.updateOne({ slug: "legacy" }, [{ $set: { active: true } }, { $unset: "legacy" }]);

      const stored = await raw.findOne({ slug: "legacy" });
      expect(stored?.active).toBe(true);
      expect(stored).not.toHaveProperty("legacy");
    });
  });
});

describe("tenant-scoped aggregation-pipeline updates still apply and keep the scope", () => {
  it("I: updateOne mutates the scoped row in place and preserves tenantId", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection("events");
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });
      const foreign = await raw.insertOne({ tenantId: "tenant-b", name: "B1" });

      const repo = tenantRepo("tenant-a", test.db).collection("events");
      await repo.updateOne({ _id: mine.insertedId }, [{ $set: { name: "renamed" } }]);

      const mineStored = await raw.findOne({ _id: mine.insertedId });
      expect(mineStored?.name).toBe("renamed");
      expect(mineStored?.tenantId).toBe("tenant-a");
      expect((await raw.findOne({ _id: foreign.insertedId }))?.name).toBe("B1");
    });
  });
});
