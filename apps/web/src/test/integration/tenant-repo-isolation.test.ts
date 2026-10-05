import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "../../server/db/collections";
import { closeMongoClient } from "../../server/db/mongo";
import { tenantRepo } from "../../server/repos";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — tenant isolation at the database boundary (OP-77,
 * schema §10.2, conventions §8).
 *
 * With two tenants seeded into the same collection, tenant A's repository must
 * be physically unable to read, update or delete tenant B's rows — the merged
 * `tenantId` is what makes that true, and a live MongoDB proves the merge
 * actually reaches the query. Assertions are made on observable database state
 * (what `find` returns, whether a raw document survived an update or a delete),
 * never on the driver calls used to get there.
 *
 *   tenantRepo(tenantId, db?).collection(name)
 *
 * Cases: I1 read isolation (`find`, `findOne`), write isolation
 * (`findOneAndUpdate`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`,
 * `countDocuments`) and insert stamping (`insertOne`).
 */

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_tenant_repo");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

describe("tenantRepo isolation across two tenants", () => {
  it("I1: find returns only the scoped tenant's rows", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertOne({ tenantId: "tenant-a", name: "A1", status: "active" });
      await raw.insertOne({ tenantId: "tenant-b", name: "B1", status: "active" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      const rows = (await repo.find({}).toArray()) as Array<Record<string, unknown>>;

      expect(rows.map((row) => row.name)).toEqual(["A1"]);
      expect(rows.every((row) => row.tenantId === "tenant-a")).toBe(true);
    });
  });

  it("I1: findOne cannot read another tenant's document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const foreign = await raw.insertOne({ tenantId: "tenant-b", name: "B1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      expect(await repo.findOne({ _id: foreign.insertedId })).toBeNull();
    });
  });

  it("I1: countDocuments counts only the scoped tenant's rows", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertMany([
        { tenantId: "tenant-a", name: "A1" },
        { tenantId: "tenant-a", name: "A2" },
        { tenantId: "tenant-b", name: "B1" },
      ]);

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      expect(await repo.countDocuments({})).toBe(2);
    });
  });

  it("I1: findOneAndUpdate cannot modify another tenant's document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const foreign = await raw.insertOne({ tenantId: "tenant-b", name: "B1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      const result = await repo.findOneAndUpdate(
        { _id: foreign.insertedId },
        { $set: { name: "hacked" } }
      );

      expect(result).toBeNull();
      expect((await raw.findOne({ _id: foreign.insertedId }))?.name).toBe("B1");
    });
  });

  it("I1: updateOne modifies only the scoped tenant's document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });
      const foreign = await raw.insertOne({ tenantId: "tenant-b", name: "B1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await repo.updateOne({ _id: mine.insertedId }, { $set: { name: "renamed" } });
      const untouched = await repo.updateOne(
        { _id: foreign.insertedId },
        { $set: { name: "hacked" } }
      );

      expect(untouched.matchedCount).toBe(0);
      expect((await raw.findOne({ _id: mine.insertedId }))?.name).toBe("renamed");
      expect((await raw.findOne({ _id: foreign.insertedId }))?.name).toBe("B1");
    });
  });

  it("I1: updateMany touches only the scoped tenant's rows", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertMany([
        { tenantId: "tenant-a", name: "A1" },
        { tenantId: "tenant-a", name: "A2" },
        { tenantId: "tenant-b", name: "B1" },
      ]);

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      const result = await repo.updateMany({}, { $set: { status: "archived" } });

      expect(result.modifiedCount).toBe(2);
      expect(await raw.countDocuments({ tenantId: "tenant-b", status: "archived" })).toBe(0);
    });
  });

  it("I1: deleteOne cannot delete another tenant's document", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });
      const foreign = await raw.insertOne({ tenantId: "tenant-b", name: "B1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await repo.deleteOne({ _id: mine.insertedId });
      await repo.deleteOne({ _id: foreign.insertedId });

      expect(await raw.countDocuments({ _id: mine.insertedId })).toBe(0);
      expect(await raw.countDocuments({ _id: foreign.insertedId })).toBe(1);
    });
  });

  it("I1: deleteMany deletes only the scoped tenant's rows", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertMany([
        { tenantId: "tenant-a", name: "A1" },
        { tenantId: "tenant-a", name: "A2" },
        { tenantId: "tenant-b", name: "B1" },
      ]);

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      const result = await repo.deleteMany({});

      expect(result.deletedCount).toBe(2);
      expect(await raw.countDocuments({ tenantId: "tenant-b" })).toBe(1);
    });
  });

  it("I1: insertOne stamps the scoped tenantId on the stored document", async () => {
    await withTestDb(async (test) => {
      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      const inserted = await repo.insertOne({ name: "A-new" });

      const stored = await test.db
        .collection(COLLECTIONS.events)
        .findOne({ _id: inserted.insertedId });
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored?.name).toBe("A-new");
    });
  });
});
