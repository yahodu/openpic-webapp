import { ObjectId, type Db, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { flushDueDigests } from "@/server/notifications/digest";
import { retryDueDispatches } from "@/server/notifications/dispatch-retry";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import type {
  MessageTransport,
  OutboundMessage,
  TransportReceipt,
} from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — a failed digest flush is delivered exactly once
 * (OP-96 follow-up RED, review finding F1, ADR-0128 §3).
 *
 * The defect: `flushDueDigests` leaves a failed bucket `open` **and** writes a
 * retryable `failed` dispatch row. The next flush tick re-selects the still-open
 * bucket and sends the summary again, while `notification-dispatch-retry`
 * re-sends the same failed row — so the recipient gets the digest email twice.
 *
 * ## The pinned design (option (a), one owner)
 *
 * The **ledger row owns the retry** (mirroring ADR-0127): a flush failure is
 * durably recorded on the `notificationDispatches` row and the bucket is marked
 * `flushed`, so the flush cron never re-selects it. `notification-dispatch-retry`
 * is the single path that re-sends the summary.
 *
 * Observable outcome: over a failure tick + a retry tick + a second flush tick a
 * scripted failing-then-succeeding transport delivers **exactly one** message,
 * there is **exactly one** ledger row for the bucket, and the second flush tick
 * makes **no** further transport call.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real flush/retry jobs.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The `notificationDigests` bucket collection (schema §12/§19.6). */
const NOTIFICATION_DIGESTS = "notificationDigests";
/** The Better Auth user collection (schema §13.1). */
const USER = "user";

/** The digest type this spec drives (throttle `digest`, 6 h window). */
const TYPE_KEY = "attendee.matches.new";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";
const MINUTE = 60_000;

/** Fields of a stored digest bucket this spec inspects (schema §19.6). */
interface StoredBucket {
  readonly status?: unknown;
}

/** A scripted transport that fails the first `failures` sends, then succeeds. */
interface ScriptedTransport extends MessageTransport {
  readonly outbox: readonly OutboundMessage[];
  readonly calls: number;
}

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  invalidateNotificationTypeCache();
  invalidatePlatformSettings();
});

/** The ISO instant `base + ms`. */
function at(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

/** Build a transport that rejects the first `failures` sends with `retryable`. */
function scriptedTransport(failures: number, retryable: boolean): ScriptedTransport {
  const outbox: OutboundMessage[] = [];
  let calls = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    get calls(): number {
      return calls;
    },
    send(message: OutboundMessage): Promise<TransportReceipt> {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(
          new TransportError("scripted provider failure", {
            retryable,
            code: "http",
            status: retryable ? 503 : 400,
          })
        );
      }
      outbox.push(message);
      return Promise.resolve({ providerMessageId: `stub-${String(calls)}` });
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_digest_failure");
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

/** Insert a pending outbox row for one `attendee.matches.new` arrival. */
async function insertArrival(database: Db, eventId: string, attendee: string): Promise<void> {
  const occurredAt = new Date(T0);
  await database.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: TYPE_KEY,
    tenantId: new ObjectId().toHexString(),
    actorRef: { kind: "system", id: "matcher" },
    subjectRef: { kind: "user", id: attendee },
    payload: { eventId, count: 1 },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * 60 * MINUTE),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });
}

/** A deterministic recipient source resolving the seeded attendee. */
function fixedRecipients(attendee: string): RecipientRepository {
  return {
    listEventRoleMembers: () => Promise.resolve([]),
    listIdentifiedAttendeeUserIds: () => Promise.resolve([attendee]),
    getBillingContactUserId: () => Promise.resolve(null),
    listPlatformAdminUserIds: () => Promise.resolve([]),
  };
}

/** Run one fan-out pass at a fixed instant. */
async function runFanOutAt(
  database: Db,
  transport: MessageTransport,
  recipients: RecipientRepository,
  instant: string
): Promise<void> {
  await runNotificationFanOut({
    db: database,
    clock: fixedClock(instant),
    transport,
    recipients,
    batch: 10,
    claimerId: "worker_digest_failure",
  });
}

/** The one stored bucket (schema §19.6). */
async function theBucket(database: Db): Promise<StoredBucket | null> {
  return database.collection<StoredBucket>(NOTIFICATION_DIGESTS).findOne({});
}

/** Every stored dispatch ledger row for the digest type (schema §19.5). */
async function ledgerRows(database: Db): Promise<readonly Document[]> {
  return database.collection(DISPATCHES).find({ typeKey: TYPE_KEY }).toArray();
}

describe("a failed digest flush is delivered exactly once (F1)", () => {
  it("F1: a failing-then-succeeding flush yields one delivered summary and one ledger row across flush + retry + re-flush", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);

      // One arrival → one open bucket whose flushAt is t0 + 15m.
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, scriptedTransport(0, true), fixedRecipients(attendee), at(T0, 0));

      // The transport fails the first send (the flush tick) then succeeds.
      const transport = scriptedTransport(1, true);

      // --- Failure tick: the bucket is due; the send fails. ---
      const failureTick = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 20 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(failureTick.affected).toBe(0);
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);
      expect(await ledgerRows(test.db)).toHaveLength(1);

      // --- Retry tick: the ledger row is the single owner of the redelivery. ---
      const retryTick = await retryDueDispatches({
        db: test.db,
        clock: fixedClock(at(T0, 22 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(retryTick.affected).toBe(1);
      expect(transport.calls).toBe(2);
      expect(transport.outbox).toHaveLength(1);

      // --- Second flush tick: the bucket must no longer be selectable. ---
      const callsBeforeReflush = transport.calls;
      const secondFlush = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 30 * MINUTE)),
        transport,
        limit: 100,
      });

      // No duplicate: one delivered message, one ledger row, no extra send.
      expect(secondFlush.affected).toBe(0);
      expect(transport.calls).toBe(callsBeforeReflush);
      expect(transport.outbox).toHaveLength(1);
      expect(await ledgerRows(test.db)).toHaveLength(1);

      // The bucket was durably closed when its failure was recorded.
      expect((await theBucket(test.db))?.status).toBe("flushed");
    });
  });
});
