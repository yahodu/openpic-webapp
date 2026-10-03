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
      // The rejection must not leak either tenant's identifier into the logs.
      expect(JSON.stringify(entry)).not.toContain("tenant-b");
    });
  });
});
