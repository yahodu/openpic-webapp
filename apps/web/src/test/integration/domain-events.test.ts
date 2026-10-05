import type { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import {
  claimPendingEvents,
  emitDomainEvent,
  markDone,
  markFailed,
} from "@/server/domain/domain-events";
import { fixedClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeDomainEventInput } from "../factories/domain-event";
import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Integration contract — the `domainEvents` transactional outbox (OP-88,
 * schema §18.3, contract §7.7).
 *
 * Four properties are only provable at the database boundary against a replica
 * set (`MongoMemoryReplSet`):
 *
 *   1. the write can join a caller's transaction, so an aborted domain change
 *      leaves **no** event (at-least-once without dual writes);
 *   2. a repeated `dedupeKey` persists exactly one document (the unique partial
 *      index is the deduplication, not an application-level check);
 *   3. concurrent consumers claim each event **exactly once** — the atomic
 *      `pending -> in_progress` transition is what makes fan-out safe to scale;
 *   4. a claim stale for more than five minutes is reclaimable, and a fresh one
 *      is not (the crash-recovery lease).
 *
 * Contract expected of the implementation:
 *
 *   emitDomainEvent(input, { db?, clock?, session? })
 *     -> Promise<{ deduped: boolean; id: string | null }>
 *   claimPendingEvents(consumer, batch, { db?, clock?, claimerId? })
 *     -> Promise<readonly DomainEventDocument[]>   // up to `batch`, atomically
 *        claimed; `dispatch[consumer]` becomes "in_progress" and `claimedAt`
 *        is stamped from the clock. An `in_progress` claim older than 5 minutes
 *        is reclaimable; calling with nothing claimable returns [].
 *   markDone(eventId, consumer, { db? }): Promise<void>   // dispatch -> "done"
 *   markFailed(eventId, consumer, { db? }): Promise<void> // dispatch -> "pending" (retryable)
 *
 * `consumer` is one of "notifications" | "analytics" | "queue".
 */

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = "domain_events";

/** A fixed instant so timestamps are exact, not run-dependent. */
const T0 = "2026-03-01T00:00:00.000Z";

/** The stored outbox document fields these specs inspect. */
interface StoredEvent {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly dispatch: {
    readonly notifications: string;
    readonly analytics: string;
    readonly queue: string;
  };
  readonly claimedAt?: Date | null;
}

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

beforeEach(() => {
  invalidatePlatformSettings();
});

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_domain_events");
  try {
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** The outbox collection handle for a test database. */
function eventsOf(test: TestDb) {
  return test.db.collection<StoredEvent>(DOMAIN_EVENTS);
}

describe("emitDomainEvent — transactional write", () => {
  it("I1: an event emitted inside an aborted transaction is not persisted", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);

      await expect(
        withTransaction(async (session) => {
          await emitDomainEvent(makeDomainEventInput(), {
            db: test.db,
            clock: fixedClock(T0),
            session,
          });
          throw new Error("domain write failed");
        })
      ).rejects.toThrow("domain write failed");

      expect(await events.countDocuments()).toBe(0);
    });
  });

  it("I2: a repeated dedupeKey persists exactly one document", async () => {
    await withTestDb(async (test) => {
      await ensureIndexes(test.db);
      const events = eventsOf(test);
      const input = makeDomainEventInput({ dedupeKey: "pipeline.event.indexed:ev_1" });

      const first = await emitDomainEvent(input, { db: test.db, clock: fixedClock(T0) });
      const second = await emitDomainEvent(input, { db: test.db, clock: fixedClock(T0) });

      expect(first.deduped).toBe(false);
      expect(first.id).toBeTruthy();
      expect(second.deduped).toBe(true);
      expect(await events.countDocuments()).toBe(1);
    });
  });
});

describe("claimPendingEvents — concurrent consumers", () => {
  it("I3: two concurrent claimers over ten events claim each event exactly once", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);

      await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          emitDomainEvent(makeDomainEventInput({ payload: { inviteId: `inv_${String(index)}` } }), {
            db: test.db,
            clock: fixedClock(T0),
          })
        )
      );

      const stored = await events.find({}).toArray();
      expect(stored).toHaveLength(10);
      const expectedIds = stored.map((doc: StoredEvent) => String(doc._id)).sort();

      const [left, right] = await Promise.all([
        claimPendingEvents("notifications", 10, { db: test.db, clock: fixedClock(T0) }),
        claimPendingEvents("notifications", 10, { db: test.db, clock: fixedClock(T0) }),
      ]);

      const claimedIds = [...left, ...right].map((doc: StoredEvent) => String(doc._id));

      expect(claimedIds).toHaveLength(10);
      expect(new Set(claimedIds).size).toBe(10);
      expect(claimedIds.sort()).toEqual(expectedIds);

      const afterClaim = await events.find({}).toArray();
      expect(afterClaim).toHaveLength(10);
      expect(afterClaim.every((doc) => doc.dispatch.notifications === "in_progress")).toBe(true);
    });
  });
});

describe("claimPendingEvents — stale lease recovery", () => {
  it("I4: a claim older than five minutes is reclaimed, a fresh one is not", async () => {
    await withTestDb(async (test) => {
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      const claimedAt = new Date("2026-06-01T00:00:00.000Z");

      const first = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(claimedAt),
      });
      expect(first).toHaveLength(1);
      expect(first[0]?.claimedAt).toEqual(claimedAt);

      const fourMinutesLater = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(new Date(claimedAt.getTime() + 4 * 60_000)),
      });
      expect(fourMinutesLater).toHaveLength(0);

      const sixMinutesLater = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(new Date(claimedAt.getTime() + 6 * 60_000)),
      });
      expect(sixMinutesLater).toHaveLength(1);
    });
  });
});

describe("claim completion", () => {
  it("marks a claimed event done for its consumer", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      const [claimed] = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(T0),
      });
      expect(claimed).toBeDefined();

      await markDone(claimed._id, "notifications", { db: test.db });

      const stored = await events.findOne({ _id: claimed._id });
      expect(stored?.dispatch.notifications).toBe("done");
    });
  });

  it("returns a failed claim to pending so the consumer can retry", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      const [claimed] = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(T0),
      });
      expect(claimed).toBeDefined();

      await markFailed(claimed._id, "notifications", { db: test.db });

      const stored = await events.findOne({ _id: claimed._id });
      expect(stored?.dispatch.notifications).toBe("pending");
    });
  });
});
