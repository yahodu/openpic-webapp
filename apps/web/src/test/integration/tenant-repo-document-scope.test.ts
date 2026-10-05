import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "../../server/db/collections";
import { closeMongoClient } from "../../server/db/mongo";
import { TenantScopeViolation, tenantRepo } from "../../server/repos";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — the plain (non-pipeline) update document cannot strip
 * the tenant scope (OP-77 follow-up t_a55af189).
 *
 * A unit spec pins the arguments the repository hands to the driver; this spec
 * pins the *effect* against a real MongoDB. A tenant-scoped document update
 * that removes `tenantId` (`$unset`) or renames it away (`$rename`) must be
 * refused before it reaches the driver, so the stored row keeps its scope. If
 * the transform let it through, the driver would remove/rename the field and
 * the row would be orphaned — which is what the pre-fix behaviour looked like.
 *
 *   tenantRepo(tenantId, db?).collection(name)
 *
 * The benign document forms are exercised end to end too, so the fix cannot
 * over-block them: a `$unset` of another field applies and the row keeps its
 * `tenantId`, and a `$set` repeating the scope is accepted.
 */

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_tenant_document_scope");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

describe("tenant-scoped document updates cannot strip the scope", () => {
  it("I: refuses a document $unset of tenantId and leaves the stored row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await expect(
        repo.updateOne({ _id: mine.insertedId }, { $unset: { tenantId: "" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);

      const stored = await raw.findOne({ _id: mine.insertedId });
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored?.name).toBe("A1");
    });
  });

  it("I: refuses a document $rename of tenantId and leaves the stored row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await expect(
        repo.findOneAndUpdate({ _id: mine.insertedId }, { $rename: { tenantId: "oldTenant" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);

      const stored = await raw.findOne({ _id: mine.insertedId });
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored).not.toHaveProperty("oldTenant");
    });
  });

  it("I: applies a benign document $unset and keeps the stored row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1", legacy: true });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      await repo.updateOne({ _id: mine.insertedId }, { $unset: { legacy: "" } });

      const stored = await raw.findOne({ _id: mine.insertedId });
      expect(stored).not.toHaveProperty("legacy");
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored?.name).toBe("A1");
    });
  });

  it("I: accepts a document $set repeating the scope tenantId and keeps the row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      const mine = await raw.insertOne({ tenantId: "tenant-a", name: "A1" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);
      await repo.updateOne(
        { _id: mine.insertedId },
        { $set: { tenantId: "tenant-a", name: "renamed" } }
      );

      const stored = await raw.findOne({ _id: mine.insertedId });
      expect(stored?.name).toBe("renamed");
      expect(stored?.tenantId).toBe("tenant-a");
    });
  });
});
