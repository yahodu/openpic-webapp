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
import { fixtureInstant } from "../helpers/fixture-clock";

/**
 * Integration / contract — a **non-retryable** digest-flush failure must not
 * silently drop the digest (OP-96 follow-up round 2 RED, review finding F1b,
 * ADR-0130 §"Review sign-off (round 1)").
 *
 * The defect: `flushOneBucket` returns `failed_recorded` for *any* transport
 * failure and `flushDueDigests` closes the bucket (`status: "flushed"`) on that
 * branch, while the ledger row keeps the transport's own classification and
 * `retryDueDispatches` only re-selects `lastError.retryable: true`. So a
 * **non-retryable** transport failure (HTTP 400) closes the bucket with **no
 * owner**: the flush cron never re-selects it and the retry cron never picks
 * the row up — the summary is silently lost.
 *
 * ## The pinned contract (option (a), bucket stays selectable)
 *
 * The bucket is closed only when the recorded failure actually has an owner
 * (a **retryable** transport failure → the ledger row owns the redelivery,
 * exactly as the F1 pin fixes). A **non-retryable** failure has no owner, so
 * the bucket stays `open` and selectable and a later flush tick re-attempts it.
 *
 * Observable outcome over a failure tick + a retry tick + a recovery flush
 * tick + a trailing flush tick: the summary is delivered **exactly once** (the
 * recovering flush), no path double-sends (the non-retryable ledger row is
 * never re-selected by `notification-dispatch-retry`), and the bucket is only
 * `flushed` once the summary has actually gone out.
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
const T0 = fixtureInstant("10:00:00.000Z");
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

/** Build a transport that rejects the first `failures` sends non-retryably. */
function scriptedNonRetryableTransport(failures: number): ScriptedTransport {
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
          new TransportError("scripted provider rejection", {
            retryable: false,
            code: "http",
            status: 400,
          })
        );
      }
      outbox.push(message);
      return Promise.resolve({ providerMessageId: `stub-${String(calls)}` });
    },
  };
}

/** A transport that accepts every send (used to seed the bucket via the fan-out). */
function acceptingTransport(): MessageTransport {
  return {
    send(): Promise<TransportReceipt> {
      return Promise.resolve({ providerMessageId: "seed" });
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_digest_non_retryable");
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
    claimerId: "worker_digest_non_retryable",
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

describe("a non-retryable digest flush failure keeps the summary owned (F1b)", () => {
  it("F1b: a non-retryable flush failure leaves the bucket selectable and a later flush delivers the summary exactly once", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);

      // One arrival → one open bucket whose flushAt is t0 + 15m.
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, acceptingTransport(), fixedRecipients(attendee), at(T0, 0));

      // The transport rejects the first (flush) send non-retryably, then accepts.
      const transport = scriptedNonRetryableTransport(1);

      // --- Failure tick: the bucket is due; the send is rejected (400). ---
      const failureTick = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 20 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(failureTick.affected).toBe(0);
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);

      // The failure is durably recorded, classified non-retryable.
      const failedRows = await ledgerRows(test.db);
      expect(failedRows).toHaveLength(1);
      expect(failedRows[0]).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: { retryable: false, code: "http", status: 400 },
      });

      // No owner closed the bucket: it stays selectable for a later flush.
      expect((await theBucket(test.db))?.status).toBe("open");

      // --- Retry tick: the non-retryable row has no owner and is not re-selected. ---
      const retryTick = await retryDueDispatches({
        db: test.db,
        clock: fixedClock(at(T0, 22 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(retryTick.affected).toBe(0);
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(0);

      // --- Recovery flush tick: the still-selectable bucket is re-attempted and delivered. ---
      const recoveryFlush = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 30 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(recoveryFlush.affected).toBe(1);
      expect(transport.calls).toBe(2);
      expect(transport.outbox).toHaveLength(1);
      expect((await theBucket(test.db))?.status).toBe("flushed");

      // --- Trailing flush tick: the summary must not be sent a second time. ---
      const callsBeforeTrailing = transport.calls;
      const trailingFlush = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 40 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(trailingFlush.affected).toBe(0);
      expect(transport.calls).toBe(callsBeforeTrailing);
      expect(transport.outbox).toHaveLength(1);
    });
  });
});
