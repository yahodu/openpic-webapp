import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import {
  claimPendingEvents,
  emitDomainEvent,
  markDone,
  markFailed,
} from "@/server/domain/domain-events";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { fixedClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeDomainEventInput } from "../factories/domain-event";
import { makeNotificationType } from "../factories/notification";
import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

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

/** The ISO instant `plusMs` after `T0` — used to cross the 30 s TTL window. */
function at(plusMs: number): string {
  return new Date(Date.parse(T0) + plusMs).toISOString();
}

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
  readonly claimedBy?: string;
}

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidatePlatformSettings();
  invalidateNotificationTypeCache();
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

/**
 * Seed the enabled notification type the emitted `collab.invite.accepted` event
 * needs so its `dispatch.notifications` flag is claimable.
 *
 * The writer marks `notifications` "skipped" when no enabled type row exists for
 * the eventKey (unit spec U4) and a "skipped" flag is never claimable, so the
 * notifications-consumer specs below must seed this row — otherwise there is
 * nothing for the consumer to claim.
 */
async function seedEnabledNotificationType(test: TestDb): Promise<void> {
  await test.db
    .collection(COLLECTIONS.notificationTypes)
    .insertOne(makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }));
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
      await seedEnabledNotificationType(test);

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
      await seedEnabledNotificationType(test);
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

describe("claimPendingEvents — attribution", () => {
  it("records the claimer id on the event it claims", async () => {
    await withTestDb(async (test) => {
      await seedEnabledNotificationType(test);
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      await claimPendingEvents("notifications", 1, {
        db: test.db,
        clock: fixedClock(T0),
        claimerId: "worker_7",
      });

      const stored = await eventsOf(test).findOne({});
      expect(stored?.claimedBy).toBe("worker_7");
    });
  });
});

describe("claim completion", () => {
  it("marks a claimed event done for its consumer", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      await seedEnabledNotificationType(test);
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      const claimedEvents = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(T0),
      });
      expect(claimedEvents).toHaveLength(1);
      const claimed = claimedEvents[0];
      if (claimed === undefined) {
        throw new Error("expected claimPendingEvents to claim one event");
      }

      await markDone(String(claimed._id), "notifications", { db: test.db });

      const stored = await events.findOne({ _id: claimed._id });
      expect(stored?.dispatch.notifications).toBe("done");
    });
  });

  it("returns a failed claim to pending so the consumer can retry", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      await seedEnabledNotificationType(test);
      await emitDomainEvent(makeDomainEventInput(), { db: test.db, clock: fixedClock(T0) });

      const claimedEvents = await claimPendingEvents("notifications", 10, {
        db: test.db,
        clock: fixedClock(T0),
      });
      expect(claimedEvents).toHaveLength(1);
      const claimed = claimedEvents[0];
      if (claimed === undefined) {
        throw new Error("expected claimPendingEvents to claim one event");
      }

      await markFailed(claimed._id, "notifications", { db: test.db });

      const stored = await events.findOne({ _id: claimed._id });
      expect(stored?.dispatch.notifications).toBe("pending");
    });
  });
});

describe("emitDomainEvent — notification-type cache staleness (OP-88 follow-up D1)", () => {
  it("I5: observes a notification-type change no later than the 30 s window", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      const types = test.db.collection(COLLECTIONS.notificationTypes);

      // A disabled type at T0: the writer marks the event skipped and caches the
      // (empty) enabled set.
      await types.insertOne(
        makeNotificationType({ typeKey: "collab.invite.accepted", enabled: false })
      );

      const first = await emitDomainEvent(makeDomainEventInput(), {
        db: test.db,
        clock: fixedClock(T0),
      });
      expect(first.id).toBeTruthy();
      const firstStored = await events.findOne({ _id: new ObjectId(String(first.id)) });
      expect(firstStored?.dispatch.notifications).toBe("skipped");

      // The operator enables the type behind the cache's back.
      await types.updateOne({ typeKey: "collab.invite.accepted" }, { $set: { enabled: true } });

      // Inside the accepted staleness window the cached set still wins.
      const second = await emitDomainEvent(makeDomainEventInput(), {
        db: test.db,
        clock: fixedClock(at(10_000)),
      });
      const secondStored = await events.findOne({ _id: new ObjectId(String(second.id)) });
      expect(secondStored?.dispatch.notifications).toBe("skipped");

      // At the 30 s boundary the change is observed.
      const third = await emitDomainEvent(makeDomainEventInput(), {
        db: test.db,
        clock: fixedClock(at(30_000)),
      });
      const thirdStored = await events.findOne({ _id: new ObjectId(String(third.id)) });
      expect(thirdStored?.dispatch.notifications).toBe("pending");
    });
  });
});

describe("claimPendingEvents — missing claimedAt reclaim (OP-88 follow-up D3)", () => {
  it("I6: reclaims an in_progress claim whose claimedAt is missing", async () => {
    await withTestDb(async (test) => {
      const events = eventsOf(test);
      const raw = test.db.collection(DOMAIN_EVENTS);

      // A crashed consumer's row: flipped in_progress but the lease stamp never
      // landed, so `claimedAt` is absent entirely.
      await raw.insertOne({
        eventKey: "collab.invite.accepted",
        dispatch: {
          notifications: "in_progress",
          analytics: "not_applicable",
          queue: "not_applicable",
        },
        occurredAt: new Date(T0),
      });

      const claimed = await claimPendingEvents("notifications", 1, {
        db: test.db,
        clock: fixedClock(T0),
        claimerId: "worker_7",
      });

      expect(claimed).toHaveLength(1);
      const claimedEvent = claimed[0];
      if (claimedEvent === undefined) {
        throw new Error("expected claimPendingEvents to reclaim the missing-claimedAt row");
      }
      expect(claimedEvent.claimedAt).toEqual(new Date(T0));
      expect(claimedEvent.claimedBy).toBe("worker_7");

      const stored = await events.findOne({ _id: claimedEvent._id });
      expect(stored?.claimedAt).toEqual(new Date(T0));
      expect(stored?.dispatch.notifications).toBe("in_progress");
    });
  });

  it("I7: does not reclaim an in_progress claim with a fresh claimedAt", async () => {
    await withTestDb(async (test) => {
      const raw = test.db.collection(DOMAIN_EVENTS);

      await raw.insertOne({
        eventKey: "collab.invite.accepted",
        dispatch: {
          notifications: "in_progress",
          analytics: "not_applicable",
          queue: "not_applicable",
        },
        occurredAt: new Date(T0),
        claimedAt: new Date(T0),
      });

      const claimed = await claimPendingEvents("notifications", 1, {
        db: test.db,
        clock: fixedClock(T0),
      });

      expect(claimed).toHaveLength(0);
    });
  });
});
