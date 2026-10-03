import { describe, expect, it } from "vitest";

import { platformRepo } from "@/server/repos";

import { makeFakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — platform-scope repository entry point (OP-77, schema §10.2).
 *
 * `platformRepo(db?)` is the sanctioned door to collections that are
 * deliberately NOT tenant-scoped (`plans`, `faceModels`, `platformSettings`,
 * Better Auth's `user`/`session`, …). It must be a strict pass-through:
 * unlike `tenantRepo` it injects no `tenantId` into a filter, prepends no
 * `$match` to an aggregate, stamps nothing onto an insert or an upsert, and so
 * never raises a `TenantScopeViolation` — an explicit `tenantId` in a caller's
 * query is simply data. "No scope" is the whole contract, and these specs pin
 * it, so a refactor cannot quietly make `platformRepo` start scoping.
 *
 *   platformRepo(db?): { collection(name): RepositoryCollection }
 */
describe("platformRepo", () => {
  it("U7: passes a find filter through without injecting a tenantId", () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    repo.collection("plans").find({ slug: "pro" });

    expect(fake.lastCall("find")?.collection).toBe("plans");
    expect(fake.lastCall("find")?.args[0]).toEqual({ slug: "pro" });
  });

  it("U7: passes an omitted find filter through as an empty document", () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    repo.collection("plans").find();

    expect(fake.lastCall("find")?.args[0]).toEqual({});
  });

  it("U7: accepts an explicit tenantId in a filter (there is no scope to conflict with)", () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    expect(() => repo.collection("plans").find({ tenantId: "tenant-b" })).not.toThrow();
    expect(fake.lastCall("find")?.args[0]).toEqual({ tenantId: "tenant-b" });
  });

  it("U7: passes an aggregate pipeline through without prepending a tenant $match", () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    repo.collection("plans").aggregate([{ $match: { active: true } }, { $count: "n" }]);

    expect(fake.lastCall("aggregate")?.args[0]).toEqual([
      { $match: { active: true } },
      { $count: "n" },
    ]);
  });

  it("U7: does not stamp a tenantId on an inserted document", async () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    await repo.collection("plans").insertOne({ slug: "pro", active: true });

    expect(fake.lastCall("insertOne")?.args[0]).toEqual({ slug: "pro", active: true });
  });

  it("U7: does not add a tenantId via $setOnInsert on an upsert", async () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    await repo
      .collection("plans")
      .updateOne({ slug: "pro" }, { $set: { active: true } }, { upsert: true });

    expect(fake.lastCall("updateOne")?.args[0]).toEqual({ slug: "pro" });
    expect(fake.lastCall("updateOne")?.args[1]).toEqual({ $set: { active: true } });
  });

  it("U7: passes an update that names a tenantId through without a scope assertion", async () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    await repo.collection("plans").updateOne({ slug: "pro" }, { $set: { tenantId: "tenant-b" } });

    expect(fake.lastCall("updateOne")?.args[1]).toEqual({ $set: { tenantId: "tenant-b" } });
  });

  it("U7: passes a delete filter through without injecting a tenantId", async () => {
    const fake = makeFakeMongo();
    const repo = platformRepo(fake.db);

    await repo.collection("plans").deleteMany({ archived: true });

    expect(fake.lastCall("deleteMany")?.args[0]).toEqual({ archived: true });
  });

  /**
   * Gap A (t_863fd2d7) — a platform-scope handle must not coerce an
   * aggregation-pipeline update to `{}`.
   *
   * `Collection.updateOne`/`updateMany`/`findOneAndUpdate` accept a second
   * argument that is either an update document or an update *pipeline*
   * (`Document[]`). On a platform-scope handle there is no tenant scope to
   * inspect, so the array must reach the driver exactly as given: same stages,
   * same order — never a `{}` (which the driver would reject as an update with
   * no atomic operators, silently losing the write).
   */
  describe("aggregation-pipeline updates", () => {
    it("U8: passes an updateOne pipeline through unchanged (never coerced to {})", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      await repo.collection("plans").updateOne({ slug: "pro" }, [{ $set: { active: true } }]);

      expect(fake.lastCall("updateOne")?.args[0]).toEqual({ slug: "pro" });
      expect(fake.lastCall("updateOne")?.args[1]).toEqual([{ $set: { active: true } }]);
    });

    it("U8: passes a multi-stage updateOne pipeline through preserving stage order", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      const stages = [{ $set: { active: true } }, { $unset: "legacy" }];
      await repo.collection("plans").updateOne({ slug: "pro" }, stages);

      expect(fake.lastCall("updateOne")?.args[1]).toEqual([
        { $set: { active: true } },
        { $unset: "legacy" },
      ]);
    });

    it("U8: passes an updateMany pipeline through unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      await repo.collection("plans").updateMany({ tier: "free" }, [{ $set: { active: true } }]);

      expect(fake.lastCall("updateMany")?.args[0]).toEqual({ tier: "free" });
      expect(fake.lastCall("updateMany")?.args[1]).toEqual([{ $set: { active: true } }]);
    });

    it("U8: passes a findOneAndUpdate pipeline through unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      await repo
        .collection("plans")
        .findOneAndUpdate({ slug: "pro" }, [{ $set: { active: true } }]);

      expect(fake.lastCall("findOneAndUpdate")?.args[0]).toEqual({ slug: "pro" });
      expect(fake.lastCall("findOneAndUpdate")?.args[1]).toEqual([{ $set: { active: true } }]);
    });

    it("U8: does not stamp $setOnInsert onto an upsert pipeline update", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      await repo
        .collection("plans")
        .updateOne({ slug: "pro" }, [{ $set: { active: true } }], { upsert: true });

      expect(fake.lastCall("updateOne")?.args[1]).toEqual([{ $set: { active: true } }]);
    });

    it("U8: passes a pipeline that names a tenantId through (there is no scope to conflict with)", async () => {
      const fake = makeFakeMongo();
      const repo = platformRepo(fake.db);

      const stages = [{ $set: { tenantId: "tenant-b", active: true } }];
      await repo.collection("plans").updateOne({ slug: "pro" }, stages);

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(stages);
    });
  });
});
