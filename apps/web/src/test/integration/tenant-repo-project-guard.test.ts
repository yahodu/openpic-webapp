import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "../../server/db/collections";
import { closeMongoClient } from "../../server/db/mongo";
import { TenantScopeViolation, tenantRepo } from "../../server/repos";
import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Integration contract — update-pipeline `$project` tenant-field removal at the
 * database boundary (OP-77 follow-up t_5bf439f4, review finding from
 * t_863fd2d7).
 *
 * A unit spec pins the arguments the repository hands to the driver; this spec
 * pins the *effect* against a real MongoDB. Without the guard, an
 * `updateOne`/`updateMany`/`findOneAndUpdate` on a tenant-scoped handle whose
 * update is an aggregation pipeline can carry a `$project` stage that rewrites
 * the stored document and drops `tenantId` — orphaning/de-scoping the row, the
 * exact outcome the t_863fd2d7 pins refuse for `$unset`. The refusal must
 * happen in the scope transform (before the driver), so the stored row keeps
 * its `tenantId` and its other fields untouched.
 *
 *   tenantRepo(tenantId, db?).collection(name).updateOne/updateMany/findOneAndUpdate
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

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_tenant_repo_project");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

describe("tenant-scoped update pipelines cannot drop tenantId via $project", () => {
  it("I: refuses an inclusion $project that omits tenantId and leaves the stored row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertOne({ tenantId: "tenant-a", name: "A1", status: "active" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await expect(
        repo.updateOne({ name: "A1" }, [{ $project: { name: 1 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);

      const stored = await raw.findOne({ name: "A1" });
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored?.status).toBe("active");
    });
  });

  it("I: refuses a $project that explicitly excludes tenantId and leaves the stored row scoped", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(COLLECTIONS.events);
      await raw.insertOne({ tenantId: "tenant-a", name: "A1", status: "active" });

      const repo = tenantRepo("tenant-a", test.db).collection(COLLECTIONS.events);

      await expect(
        repo.updateOne({ name: "A1" }, [{ $project: { status: 0, tenantId: 0 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);

      const stored = await raw.findOne({ name: "A1" });
      expect(stored?.tenantId).toBe("tenant-a");
      expect(stored?.status).toBe("active");
    });
  });
});
