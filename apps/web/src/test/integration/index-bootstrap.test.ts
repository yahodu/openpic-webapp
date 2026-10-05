import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTIONS } from "../../server/db/collections";
import { ensureIndexes, INDEX_SPECS } from "../../server/db/indexes";
import { closeMongoClient } from "../../server/db/mongo";
import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration contract — `src/server/db/indexes.ts` (OP-76, schema §21).
 *
 * This suite proves the declarative registry really builds indexes on a live
 * database and that those indexes really enforce the §21 invariants, by running
 * the bootstrap against the `MongoMemoryReplSet` booted by the integration
 * globalSetup and then attempting the writes the invariants must reject.
 *
 *   ensureIndexes(db): Promise<IndexBootstrapReport>
 *   IndexBootstrapReport = { created: readonly string[]; existing: readonly string[] }
 *
 * Assertions are made on observable database behaviour (an insert rejecting
 * with MongoDB's duplicate-key error code 11000, or succeeding), never on the
 * driver calls used to get there.
 *
 * Cases: I1 idempotency; I2 active organizer per event; I3 non-cancelled
 * subscription per tenant; I4 dispatch dedupeKey; I5 event image asset
 * uniqueness; I6 access-link slug uniqueness scoped to active links.
 */

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/** The declared index names, sorted, for idempotency assertions. */
function declaredIndexNames(): string[] {
  return INDEX_SPECS.map((spec) => spec.name).sort();
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_indexes");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

describe("ensureIndexes", () => {
  it("I1: is idempotent — the first run creates every declared index and the second creates none", async () => {
    await withTestDb(async (test) => {
      const first = await ensureIndexes(test.db);
      expect([...first.created].sort()).toEqual(declaredIndexNames());
      expect(first.existing).toEqual([]);

      const second = await ensureIndexes(test.db);
      expect(second.created).toEqual([]);
      expect([...second.existing].sort()).toEqual(declaredIndexNames());
    });
  });

  it("I2: rejects a second active organizer for the same event with E11000", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const organizers = test.db.collection(COLLECTIONS.eventOrganizers);

      const incumbent = await organizers.insertOne({
        tenantId: "tenant-1",
        eventId: "event-1",
        organizerId: "user-1",
        revokedAt: null,
      });

      await expect(
        organizers.insertOne({
          tenantId: "tenant-1",
          eventId: "event-1",
          organizerId: "user-2",
          revokedAt: null,
        })
      ).rejects.toMatchObject({ code: DUPLICATE_KEY });

      // Revoking the incumbent takes it out of the active-unique set, so a new
      // organizer for the same event is then allowed.
      await organizers.updateOne(
        { _id: incumbent.insertedId },
        { $set: { revokedAt: new Date("2026-01-01T00:00:00.000Z") } }
      );
      const replacement = await organizers.insertOne({
        tenantId: "tenant-1",
        eventId: "event-1",
        organizerId: "user-3",
        revokedAt: null,
      });

      expect(replacement.insertedId).toBeDefined();
    });
  });

  it("I3: rejects a second non-cancelled subscription for a tenant; cancelling then adding one succeeds", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const subscriptions = test.db.collection(COLLECTIONS.subscriptions);

      const existing = await subscriptions.insertOne({
        tenantId: "tenant-1",
        status: "active",
        cancelledAt: null,
      });

      await expect(
        subscriptions.insertOne({ tenantId: "tenant-1", status: "active", cancelledAt: null })
      ).rejects.toMatchObject({ code: DUPLICATE_KEY });

      // Cancelling the incumbent takes it out of the unique set …
      await subscriptions.updateOne(
        { _id: existing.insertedId },
        { $set: { status: "cancelled", cancelledAt: new Date("2026-02-01T00:00:00.000Z") } }
      );

      // … so a new active subscription for the same tenant is now allowed.
      const replacement = await subscriptions.insertOne({
        tenantId: "tenant-1",
        status: "active",
        cancelledAt: null,
      });

      expect(replacement.insertedId).toBeDefined();
    });
  });

  it("I4: allows two dispatches with a null dedupeKey but rejects two sharing a key", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const dispatches = test.db.collection(COLLECTIONS.dispatches);

      await dispatches.insertOne({ tenantId: "tenant-1", dedupeKey: null });
      await dispatches.insertOne({ tenantId: "tenant-1", dedupeKey: null });

      await dispatches.insertOne({ tenantId: "tenant-1", dedupeKey: "event-1" });
      await expect(
        dispatches.insertOne({ tenantId: "tenant-1", dedupeKey: "event-1" })
      ).rejects.toMatchObject({ code: DUPLICATE_KEY });
    });
  });

  it("I5: rejects a duplicate eventImages {eventId, assetId} pair", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const images = test.db.collection(COLLECTIONS.eventImages);

      await images.insertOne({ tenantId: "tenant-1", eventId: "event-1", assetId: "asset-1" });
      await images.insertOne({ tenantId: "tenant-1", eventId: "event-1", assetId: "asset-2" });

      await expect(
        images.insertOne({ tenantId: "tenant-1", eventId: "event-1", assetId: "asset-1" })
      ).rejects.toMatchObject({ code: DUPLICATE_KEY });
    });
  });

  it("I6: a revoked access-link slug does not collide with the active unique", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const links = test.db.collection(COLLECTIONS.accessLinks);

      await links.insertOne({ tenantId: "tenant-1", slug: "promo-2026", revokedAt: null });

      // A revoked link with the same slug is outside the active unique set.
      await links.insertOne({
        tenantId: "tenant-1",
        slug: "promo-2026",
        revokedAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      // The active unique is still enforced for active links.
      await expect(
        links.insertOne({ tenantId: "tenant-1", slug: "promo-2026", revokedAt: null })
      ).rejects.toMatchObject({ code: DUPLICATE_KEY });
    });
  });
});
