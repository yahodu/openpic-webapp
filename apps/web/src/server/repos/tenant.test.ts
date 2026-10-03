import type { Document } from "mongodb";
import { describe, expect, it } from "vitest";

import { TenantScopeViolation, tenantRepo } from "@/server/repos";
import { createLogger, memoryTransport, setLogger } from "@/server/logging";

import { makeFakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — tenant-scoped repository layer (OP-77, schema §10.2).
 *
 * `tenantRepo(tenantId, db?)` is the *only* sanctioned way to build a filter
 * for a tenant-scoped collection. It must make the `tenantId` unavoidable:
 * merge it into every read filter, prepend it to every aggregation, stamp it on
 * every inserted document and every upsert, and refuse — loudly — when a caller
 * tries to supply a different scope.
 *
 *   tenantRepo(tenantId, db?): TenantRepository
 *   TenantRepository.collection(name): TenantCollection   // find, findOne,
 *     findOneAndUpdate, updateOne/Many, deleteOne/Many, insertOne/Many,
 *     countDocuments, aggregate
 *   class TenantScopeViolation extends Error {}
 *
 * `db` is optional and defaults to the shared client; the unit specs inject a
 * recording fake so they assert on the query handed to the driver — the only
 * observable effect of this layer — without a live server. The rejection path
 * also emits one `tenancy.scope_violation` line at `error`, carrying the
 * collection name and nothing tenant-identifying.
 *
 * Cases: U1 filter merge; U2 aggregate `$match`; U3 insert stamping; U4 upsert
 * `$setOnInsert`; U5 conflict rejection.
 */
describe("tenantRepo", () => {
  describe("filter injection", () => {
    it("U1: merges tenantId into a find filter", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      repo.collection("events").find({ status: "active" });

      expect(fake.lastCall("find")?.collection).toBe("events");
      expect(fake.lastCall("find")?.args[0]).toEqual({
        status: "active",
        tenantId: "tenant-a",
      });
    });

    it("U1: injects tenantId into an omitted find filter", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      repo.collection("events").find();

      expect(fake.lastCall("find")?.args[0]).toEqual({ tenantId: "tenant-a" });
    });

    it("U1: injects tenantId into findOne and countDocuments filters", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo.collection("events").findOne({ eventId: "event-1" });
      await repo.collection("events").countDocuments({ status: "active" });

      expect(fake.lastCall("findOne")?.args[0]).toEqual({
        eventId: "event-1",
        tenantId: "tenant-a",
      });
      expect(fake.lastCall("countDocuments")?.args[0]).toEqual({
        status: "active",
        tenantId: "tenant-a",
      });
    });

    it("U1: injects tenantId into update and delete filters", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo.collection("events").updateOne({ eventId: "event-1" }, { $set: { name: "x" } });
      await repo.collection("events").deleteMany({ status: "archived" });

      expect(fake.lastCall("updateOne")?.args[0]).toEqual({
        eventId: "event-1",
        tenantId: "tenant-a",
      });
      expect(fake.lastCall("deleteMany")?.args[0]).toEqual({
        status: "archived",
        tenantId: "tenant-a",
      });
    });

    it("U1: an explicit filter that repeats the repository's own tenantId is accepted", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      repo.collection("events").find({ tenantId: "tenant-a", status: "active" });

      expect(fake.lastCall("find")?.args[0]).toEqual({
        tenantId: "tenant-a",
        status: "active",
      });
    });
  });

  describe("aggregate injection", () => {
    it("U2: prepends a tenantId $match as the first aggregate stage", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      repo.collection("events").aggregate([{ $match: { status: "active" } }, { $count: "n" }]);

      expect(fake.lastCall("aggregate")?.args[0]).toEqual([
        { $match: { tenantId: "tenant-a" } },
        { $match: { status: "active" } },
        { $count: "n" },
      ]);
    });

    it("U2: an empty pipeline still starts with the tenantId $match", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      repo.collection("events").aggregate([]);

      expect(fake.lastCall("aggregate")?.args[0]).toEqual([{ $match: { tenantId: "tenant-a" } }]);
    });
  });

  describe("write stamping", () => {
    it("U3: adds tenantId to every document in insertMany", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo.collection("events").insertMany([{ name: "one" }, { name: "two" }]);

      expect(fake.lastCall("insertMany")?.args[0]).toEqual([
        { name: "one", tenantId: "tenant-a" },
        { name: "two", tenantId: "tenant-a" },
      ]);
    });

    it("U3: adds tenantId to an inserted document", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo.collection("events").insertOne({ name: "one" });

      expect(fake.lastCall("insertOne")?.args[0]).toEqual({ name: "one", tenantId: "tenant-a" });
    });

    it("U4: sets tenantId via $setOnInsert on an upsert", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo
        .collection("events")
        .updateOne({ externalRef: "ref-1" }, { $set: { status: "ok" } }, { upsert: true });

      expect(fake.lastCall("updateOne")?.args[0]).toEqual({
        externalRef: "ref-1",
        tenantId: "tenant-a",
      });
      expect(fake.lastCall("updateOne")?.args[1]).toEqual({
        $set: { status: "ok" },
        $setOnInsert: { tenantId: "tenant-a" },
      });
    });

    it("U4: sets tenantId via $setOnInsert on a findOneAndUpdate upsert", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo
        .collection("events")
        .findOneAndUpdate({ externalRef: "ref-1" }, { $set: { status: "ok" } }, { upsert: true });

      expect(fake.lastCall("findOneAndUpdate")?.args[0]).toEqual({
        externalRef: "ref-1",
        tenantId: "tenant-a",
      });
      expect(fake.lastCall("findOneAndUpdate")?.args[1]).toEqual({
        $set: { status: "ok" },
        $setOnInsert: { tenantId: "tenant-a" },
      });
    });
  });

  describe("aggregation-pipeline updates", () => {
    /**
     * A pipeline update (`[{ $set: … }]`) is a legitimate MongoDB update form —
     * `Collection.updateOne` accepts a `Document[]`. The scope transform must
     * inspect its stages exactly as it inspects a document update: a stage that
     * names a foreign `tenantId` is refused, and a benign pipeline reaches the
     * driver unchanged (never coerced to `{}`).
     */
    const asPipeline = (stages: Document[]): Document => stages;

    it("U6: rejects an updateOne pipeline stage that names another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, asPipeline([{ $set: { tenantId: "tenant-b" } }]))
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U6: rejects an updateMany pipeline stage that names another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateMany({}, asPipeline([{ $set: { tenantId: "tenant-b" } }]))
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateMany")).toBeUndefined();
    });

    it("U6: rejects a findOneAndUpdate pipeline stage that names another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .findOneAndUpdate(
            { eventId: "event-1" },
            asPipeline([{ $set: { tenantId: "tenant-b" } }])
          )
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("findOneAndUpdate")).toBeUndefined();
    });

    it("U6: rejects a foreign tenantId in any stage of a multi-stage pipeline", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne(
            { eventId: "event-1" },
            asPipeline([{ $set: { name: "renamed" } }, { $set: { tenantId: "tenant-b" } }])
          )
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U6: accepts a pipeline that sets the repository's own tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const stages = [{ $set: { tenantId: "tenant-a", name: "renamed" } }];
      await repo.collection("events").updateOne({ eventId: "event-1" }, asPipeline(stages));

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(stages);
    });

    it("U6: passes a benign pipeline through to the driver unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const stages = [{ $set: { name: "renamed" } }];
      await repo.collection("events").updateOne({ eventId: "event-1" }, asPipeline(stages));

      expect(fake.lastCall("updateOne")?.args[0]).toEqual({
        eventId: "event-1",
        tenantId: "tenant-a",
      });
      expect(fake.lastCall("updateOne")?.args[1]).toEqual(stages);
    });

    /**
     * Gap B (t_863fd2d7) — operators that can strip or overwrite the tenant
     * field are refused. A tenant-scoped pipeline update that removes
     * `tenantId` (`$unset`) or replaces the whole document
     * (`$replaceWith`/`$replaceRoot`) would orphan or de-scope the row, so the
     * scope transform refuses it with a {@link TenantScopeViolation} and never
     * reaches the driver. Operators that cannot touch the tenant field pass
     * through unchanged.
     *
     * `$project` (an alias namespace of `$unset`) is deliberately NOT pinned:
     * the update-pipeline `$project` form rewrites the whole document and its
     * decision is out of scope for this card.
     */
    it("U6: rejects an updateOne pipeline $unset that names tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, [{ $unset: "tenantId" }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U6: rejects an updateMany pipeline $unset that names tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateMany({}, [{ $unset: "tenantId" }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateMany")).toBeUndefined();
    });

    it("U6: rejects a findOneAndUpdate pipeline $unset that names tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").findOneAndUpdate({ eventId: "event-1" }, [{ $unset: "tenantId" }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("findOneAndUpdate")).toBeUndefined();
    });

    it("U6: rejects a pipeline $unset naming tenantId in document form", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, [{ $unset: { tenantId: "" } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U6: rejects a pipeline $unset array that includes tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [{ $unset: ["name", "tenantId"] }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U6: rejects a pipeline stage that removes tenantId even when a later stage also runs", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne(
            { eventId: "event-1" },
            asPipeline([{ $set: { name: "renamed" } }, { $unset: "tenantId" }])
          )
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U6: accepts a pipeline $unset of a field other than tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const stages = [{ $unset: "legacy" }];
      await repo.collection("events").updateOne({ eventId: "event-1" }, asPipeline(stages));

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(stages);
    });

    it("U6: rejects a pipeline $replaceWith stage (it can drop the tenant field)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, [{ $replaceWith: {} }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U6: rejects a pipeline $replaceRoot stage (it can drop the tenant field)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [{ $replaceRoot: { newRoot: {} } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });
  });

  describe("document-update tenant-field removal", () => {
    /**
     * Gap (t_a55af189) — the *plain* (non-pipeline) update document path.
     *
     * `assertUpdateScope` inspects only `$set`/`$setOnInsert` for a foreign
     * `tenantId`; operators that can remove or rename the field (`$unset`
     * naming `tenantId`, `$rename` naming `tenantId`) sail through and reach
     * the driver, de-scoping the row. That is the same de-scoping outcome the
     * pipeline refusals close, on the more common update form, so the
     * document branch must refuse those operators with a
     * {@link TenantScopeViolation} and never reach the driver.
     *
     * Syntactic forms pinned: `$unset` string, `$unset` document, `$unset`
     * array (the three shapes MongoDB accepts) and `$rename`, across the three
     * update methods. A `$rename` whose *destination* is `tenantId` (it
     * overwrites the scope with another field's value) is refused too.
     * Operators that cannot touch the tenant field pass through unchanged, and
     * a `$set`/`$setOnInsert` naming the repository's own `tenantId` is
     * explicitly still accepted.
     */
    it("U9: rejects an updateOne $unset that removes tenantId (document form)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, { $unset: { tenantId: "" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U9: rejects an updateMany $unset that removes tenantId (string form)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateMany({}, { $unset: "tenantId" })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateMany")).toBeUndefined();
    });

    it("U9: rejects a findOneAndUpdate $unset array that includes tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .findOneAndUpdate({ eventId: "event-1" }, { $unset: ["name", "tenantId"] })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("findOneAndUpdate")).toBeUndefined();
    });

    it("U9: rejects a findOneAndUpdate $rename whose source is tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .findOneAndUpdate({ eventId: "event-1" }, { $rename: { tenantId: "oldTenant" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("findOneAndUpdate")).toBeUndefined();
    });

    it("U9: rejects an updateOne $rename whose source is tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, { $rename: { tenantId: "oldTenant" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U9: rejects a $rename whose destination is tenantId (it overwrites the scope)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, { $rename: { oldTenant: "tenantId" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U9: rejects a $unset naming tenantId even when a benign $set is also present", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne(
            { eventId: "event-1" },
            { $set: { name: "renamed" }, $unset: { tenantId: "" } }
          )
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U9: accepts a document $unset of a field other than tenantId unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const update = { $unset: { legacy: "" } };
      await repo.collection("events").updateOne({ eventId: "event-1" }, update);

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(update);
    });

    it("U9: accepts a document $rename that does not involve tenantId unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const update = { $rename: { legacy: "oldLegacy" } };
      await repo.collection("events").updateOne({ eventId: "event-1" }, update);

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(update);
    });

    it("U9: accepts a document $set that repeats the repository's own tenantId unchanged", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      const update = { $set: { tenantId: "tenant-a", name: "renamed" } };
      await repo.collection("events").updateOne({ eventId: "event-1" }, update);

      expect(fake.lastCall("updateOne")?.args[1]).toEqual(update);
    });

    it("U9: accepts a document $setOnInsert that repeats the repository's own tenantId on an upsert", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await repo
        .collection("events")
        .updateOne(
          { externalRef: "ref-1" },
          { $setOnInsert: { tenantId: "tenant-a", name: "new" } },
          { upsert: true }
        );

      expect(fake.lastCall("updateOne")?.args[1]).toEqual({
        $setOnInsert: { tenantId: "tenant-a", name: "new" },
      });
    });

    it("U9: rejects a document $set that names another tenantId (control)", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, { $set: { tenantId: "tenant-b" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });
  });

  /**
   * Gap C (t_5bf439f4) — the update-pipeline `$project` operator (the
   * inclusion/exclusion alias namespace of `$unset`) can rewrite the output
   * document and drop or overwrite `tenantId`, orphaning/de-scoping the row —
   * the same outcome the t_863fd2d7 pins refuse for `$unset`. A tenant-scoped
   * pipeline update is therefore refused with a {@link TenantScopeViolation}
   * (and never reaches the driver) whenever a `$project` stage can remove or
   * overwrite the tenant field:
   *
   *   - an **inclusion form** (any field mapped to a truthy projection or an
   *     expression) that does not name `tenantId` outputs only the named
   *     fields, dropping it — e.g. `{ $project: { name: 1 } }`;
   *   - an explicit **exclusion of `tenantId`** (`tenantId: 0` / `false`),
   *     alone or mixed into an otherwise-inclusive spec — e.g.
   *     `{ $project: { name: 1, tenantId: 0 } }`;
   *   - a **non-inclusion value for `tenantId`** (`tenantId: "$name"`) that
   *     overwrites it.
   *
   * A `$project` that cannot touch the tenant field (a pure exclusion of some
   * *other* field, e.g. `{ $project: { status: 0 } }`) or that explicitly keeps
   * it (`{ $project: { tenantId: 1, name: 1 } }`) is a legitimate in-scope
   * update. This card pins the **refusals** only, so an implementation may
   * refuse every tenant-scoped `$project` stage (a safe superset) or exactly
   * the de-scoping forms; either satisfies these specs.
   */
  describe("update-pipeline $project tenant-field removal", () => {
    it("U7: rejects an updateOne pipeline $project inclusion form that omits tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, [{ $project: { name: 1 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateOne")).toBeUndefined();
    });

    it("U7: rejects an updateMany pipeline $project inclusion form that omits tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateMany({}, [{ $project: { name: 1 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("updateMany")).toBeUndefined();
    });

    it("U7: rejects a findOneAndUpdate pipeline $project inclusion form that omits tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .findOneAndUpdate({ eventId: "event-1" }, [{ $project: { name: 1 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
      expect(fake.lastCall("findOneAndUpdate")).toBeUndefined();
    });

    it("U7: rejects a pipeline $project that excludes tenantId with 0", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").updateOne({ eventId: "event-1" }, [{ $project: { tenantId: 0 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U7: rejects a pipeline $project that excludes tenantId with false", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [{ $project: { tenantId: false } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U7: rejects a mixed projection that keeps a field but excludes tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [{ $project: { name: 1, tenantId: 0 } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U7: rejects a pipeline $project that overwrites tenantId with an expression", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [{ $project: { tenantId: "$name" } }])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U7: rejects a $project stage that drops tenantId even when a later stage also runs", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, [
            { $set: { name: "renamed" } },
            { $project: { name: 1 } },
          ])
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });
  });

  describe("scope violations", () => {
    it("U5: throws TenantScopeViolation when a filter supplies another tenantId", () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      expect(() => repo.collection("events").find({ tenantId: "tenant-b" })).toThrow(
        TenantScopeViolation
      );
    });

    it("U5: rejects an insert whose document supplies another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo.collection("events").insertOne({ name: "x", tenantId: "tenant-b" })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U5: rejects an update that tries to move a row to another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne({ eventId: "event-1" }, { $set: { tenantId: "tenant-b" } })
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U5: rejects an upsert whose $setOnInsert supplies another tenantId", async () => {
      const fake = makeFakeMongo();
      const repo = tenantRepo("tenant-a", fake.db);

      await expect(
        repo
          .collection("events")
          .updateOne(
            { externalRef: "ref-1" },
            { $setOnInsert: { tenantId: "tenant-b" } },
            { upsert: true }
          )
      ).rejects.toBeInstanceOf(TenantScopeViolation);
    });

    it("U5: logs tenancy.scope_violation at error with the collection name and no tenant identifiers", () => {
      const sink = memoryTransport();
      setLogger(createLogger({ level: "error", transports: [sink] }));
      const repo = tenantRepo("tenant-a", makeFakeMongo().db);

      expect(() => repo.collection("events").find({ tenantId: "tenant-b" })).toThrow();

      const entry = sink.entries.find((candidate) => candidate.event === "tenancy.scope_violation");
      expect(entry).toBeDefined();
      expect(entry?.level).toBe("error");
      expect(entry?.collection).toBe("events");
      // The rejection must not leak either tenant's identifier into the logs:
      // neither the foreign one the caller tried (tenant-b) nor the repository's
      // own scope (tenant-a). The whole sink is checked, not just this entry, so
      // an identifier escaping in any other field or line is caught too.
      expect(JSON.stringify(entry)).not.toContain("tenant-b");
      expect(JSON.stringify(entry)).not.toContain("tenant-a");
      expect(JSON.stringify(sink.entries)).not.toContain("tenant-b");
      expect(JSON.stringify(sink.entries)).not.toContain("tenant-a");
    });
  });
});
