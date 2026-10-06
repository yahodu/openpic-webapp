import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { flushDueDigests } from "@/server/notifications/digest";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — digest bucket accumulation and the daily cap
 * (OP-96, design §6/§19.6; contract §10.2 `notification-digest-flush`;
 * ADR-0100).
 *
 * A `throttle.strategy: "digest"` type (`attendee.matches.new`, window 6 h) does
 * **not** send on arrival: the fan-out accumulates each arrival into one open
 * `notificationDigests` bucket and the flush cron renders one summary per window
 * (design §6). The bucket carries a single `flushAt` that is pushed forward by
 * each arrival and capped at `firstItemAt + hardFlushHours` (§19.6).
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue. The
 * bucket collection is referenced by its schema §12 name `notificationDigests`.
 *
 * Assumptions (ADR-0100):
 *   - the fan-out resolves the digest quiet period / hard flush from
 *     `platformSettings.notifications` (`digestQuietMinutes` 15,
 *     `digestHardFlushHours` 6), read at send time;
 *   - a digest arrival writes a bucket and **no** dispatch row — a queued
 *     dispatch per arrival would be re-sent by the retry cron and defeat the
 *     one-email-per-window contract;
 *   - the daily cap is enforced by the flush across a local day
 *     (`maxDigestEmailsPerDay`); a bucket beyond the cap stays `open`
 *     (deferred), never dropped.
 */

/** The `notificationDigests` bucket collection (schema §12/§19.6). */
const NOTIFICATION_DIGESTS = "notificationDigests";
/** The Better Auth user collection (schema §13.1). */
const USER = "user";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fields of a stored digest bucket this spec inspects (schema §19.6). */
interface StoredDigest {
  readonly userId?: unknown;
  readonly typeKey?: unknown;
  readonly bucketKey?: unknown;
  readonly itemCount?: unknown;
  readonly sampleItems?: unknown;
  readonly firstItemAt?: unknown;
  readonly lastItemAt?: unknown;
  readonly flushAt?: unknown;
  readonly status?: unknown;
}

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
});

/** The ISO instant `base + ms`. */
function at(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

/** Read the ISO instant of a stored date-ish value. */
function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_digest");
  try {
    await ensureIndexes(test.db);
    await seedCatalogue(test.db);
    await fn(test);
  } finally {
    await test.cleanup();
  }
}

/** Insert the real seed routing catalogue and copy. */
async function seedCatalogue(database: Db): Promise<void> {
  await database.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await database
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
}

/** A fresh hex user id (the stored `user._id` / `userId` are ObjectIds). */
function newUserId(): string {
  return new ObjectId().toHexString();
}

/** Insert the `user`, `userProfiles` and `notificationPreferences` trio. */
async function seedRecipient(database: Db, userId: string): Promise<void> {
  const objectId = new ObjectId(userId);
  await database.collection(USER).insertOne({
    _id: objectId,
    email: `${userId}@example.com`,
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
  });
  await database.collection(COLLECTIONS.userProfiles).insertOne({
    userId: objectId,
    platformRole: "client",
    locale: "en-IN",
    contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
  });
  await database.collection(COLLECTIONS.notificationPreferences).insertOne({
    userId: objectId,
    global: { in_app: "on", email: "on", mobile: "on" },
    byType: {},
    byEvent: {},
    quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
    locale: "en-IN",
  });
}

/** Insert a pending outbox row for an `attendee.matches.new` arrival. */
async function insertArrival(database: Db, eventId: string, attendee: string): Promise<void> {
  const occurredAt = new Date(T0);
  await database.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: "attendee.matches.new",
    tenantId: new ObjectId().toHexString(),
    actorRef: { kind: "system", id: "matcher" },
    subjectRef: { kind: "user", id: attendee },
    payload: { eventId, count: 1 },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * HOUR),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });
}

/** Wrap a fixed value in a resolved promise (repo methods are async by contract). */
function promised<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

/** A deterministic recipient source resolving the seeded attendee. */
function fixedRecipients(attendee: string): RecipientRepository {
  return {
    listEventRoleMembers: promised<readonly string[]>([]),
    listIdentifiedAttendeeUserIds: promised<readonly string[]>([attendee]),
    getBillingContactUserId: promised<string | null>(null),
    listPlatformAdminUserIds: promised<readonly string[]>([]),
  };
}

/** Run one fan-out pass at a fixed instant. */
async function runFanOutAt(
  database: Db,
  transport: ReturnType<typeof memoryMessageTransport>,
  recipients: RecipientRepository,
  instant: string
): Promise<void> {
  await runNotificationFanOut({
    db: database,
    clock: fixedClock(instant),
    transport,
    recipients,
    batch: 10,
    claimerId: "worker_digest",
  });
}

/** Read every stored digest bucket. */
async function digestsOf(database: Db): Promise<readonly StoredDigest[]> {
  return database.collection<StoredDigest>(NOTIFICATION_DIGESTS).find({}).toArray();
}

describe("digest bucket accumulation (I1)", () => {
  it("I1: three arrivals over 10 minutes collapse into one bucket whose flushAt is last + 15m", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients(attendee);

      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 0));
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 5 * MINUTE));
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 10 * MINUTE));

      const digests = await digestsOf(test.db);
      expect(digests).toHaveLength(1);
      const bucket = digests[0];
      expect(bucket).toMatchObject({
        typeKey: "attendee.matches.new",
        bucketKey: `attendee.matches.new:${eventId}`,
        status: "open",
        itemCount: 3,
      });
      expect(String(bucket?.userId)).toBe(attendee);
      expect(Array.isArray(bucket?.sampleItems)).toBe(true);
      expect(iso(bucket?.firstItemAt)).toBe(T0);
      expect(iso(bucket?.lastItemAt)).toBe(at(T0, 10 * MINUTE));
      expect(iso(bucket?.flushAt)).toBe(at(T0, 25 * MINUTE));

      // A digest arrival is accumulated, never sent on the spot.
      expect(transport.outbox).toHaveLength(0);
      // ...and it is not a per-arrival dispatch (which the retry cron would re-send).
      const dispatches = await test.db.collection(COLLECTIONS.dispatches).find({}).toArray();
      expect(dispatches).toHaveLength(0);
    });
  });
});

describe("digest hard flush cap (I2)", () => {
  it("I2: a burst that keeps arriving past the cap flushes at firstItemAt + 6h", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients(attendee);

      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 0));
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 7 * HOUR));

      const digests = await digestsOf(test.db);
      expect(digests).toHaveLength(1);
      const bucket = digests[0];
      expect(bucket?.itemCount).toBe(2);
      expect(iso(bucket?.firstItemAt)).toBe(T0);
      expect(iso(bucket?.lastItemAt)).toBe(at(T0, 7 * HOUR));
      // Push-forward would be last + 15m (t0 + 7h15m); the cap wins.
      expect(iso(bucket?.flushAt)).toBe(at(T0, 6 * HOUR));
      expect(transport.outbox).toHaveLength(0);
    });
  });
});

describe("digest daily cap (I3)", () => {
  it("I3: a fourth digest email in the day is deferred, not sent", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      await seedRecipient(test.db, attendee);

      const transport = memoryMessageTransport();
      const recipients = fixedRecipients(attendee);

      // Three separate buckets, all due by t0 + 20m.
      for (let index = 0; index < 3; index += 1) {
        await insertArrival(test.db, new ObjectId().toHexString(), attendee);
        await runFanOutAt(test.db, transport, recipients, at(T0, index * MINUTE));
      }

      const firstFlush = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 20 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(firstFlush.affected).toBe(3);
      expect(transport.outbox).toHaveLength(3);

      // A fourth bucket becomes due later the same day.
      await insertArrival(test.db, new ObjectId().toHexString(), attendee);
      await runFanOutAt(test.db, transport, recipients, at(T0, 20 * MINUTE));

      const secondFlush = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 40 * MINUTE)),
        transport,
        limit: 100,
      });

      // The daily cap (3) is reached: the fourth email is deferred.
      expect(secondFlush.affected).toBe(0);
      expect(transport.outbox).toHaveLength(3);

      const digests = await digestsOf(test.db);
      expect(digests).toHaveLength(4);
      expect(digests.filter((bucket) => bucket.status === "flushed")).toHaveLength(3);
      const deferred = digests.filter((bucket) => bucket.status === "open");
      expect(deferred).toHaveLength(1);
      // Deferred, not dropped: the pending arrival is still counted.
      expect(deferred[0]?.itemCount).toBe(1);
    });
  });
});
