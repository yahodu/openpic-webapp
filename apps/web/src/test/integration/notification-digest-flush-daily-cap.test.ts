import { ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
import { flushDueDigests } from "@/server/notifications/digest";
import { runNotificationFanOut, type RecipientRepository } from "@/server/notifications/fan-out";
import type {
  MessageTransport,
  OutboundMessage,
  TransportReceipt,
} from "@/server/notifications/message-transport";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";

/**
 * Integration / contract — a **failed** digest flush must not consume the
 * recipient's `notifications.maxDigestEmailsPerDay` allowance (OP-96 follow-up
 * round 2 RED, review finding F1c, ADR-0130 §"Review sign-off (round 1)").
 *
 * The defect: `flushDueDigests` increments `sentByUser` on the
 * `failed_recorded` branch and `countFlushedToday` counts every `flushed`
 * bucket since local midnight. A provider outage during the digest window
 * therefore burns a recipient's allowance for a digest that never arrived —
 * later digests in the same day are deferred even though nothing was sent.
 *
 * The pin seeds a **non-default** `maxDigestEmailsPerDay` of `1` into the
 * `platformSettings` singleton so it never depends on the shipped default (`3`).
 * The recipient has two due buckets; the transport fails the **first** send
 * (retryably) and then accepts. Because the failed flush consumed no allowance,
 * the **second** digest is still sent in the same run — an observable delivery
 * rather than a private counter.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real flush job.
 */

/** The `notificationDigests` bucket collection (schema §12/§19.6). */
const NOTIFICATION_DIGESTS = "notificationDigests";
/** The Better Auth user collection (schema §13.1). */
const USER = "user";
/** The `platformSettings` singleton (schema §20.4). */
const PLATFORM_SETTINGS = "platformSettings";
const SINGLETON_ID = "singleton";

/** The digest type this spec drives (throttle `digest`, 6 h window). */
const TYPE_KEY = "attendee.matches.new";

/** A fixed instant so every stored timestamp is exact. */
const T0 = fixtureInstant("10:00:00.000Z");
const MINUTE = 60_000;

/** The configured per-recipient daily cap this spec pins (never the default 3). */
const MAX_DIGEST_EMAILS_PER_DAY = 1;

/** A scripted transport that fails the first `failures` sends retryably, then accepts. */
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

afterEach(() => {
  // Never leak a non-default settings document into the process-wide cache.
  invalidatePlatformSettings();
});

/** The ISO instant `base + ms`. */
function at(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

/** Build a transport that rejects the first `failures` sends retryably, then accepts. */
function scriptedTransport(failures: number): ScriptedTransport {
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
          new TransportError("scripted provider outage", {
            retryable: true,
            code: "http",
            status: 503,
          })
        );
      }
      outbox.push(message);
      return Promise.resolve({ providerMessageId: `stub-${String(calls)}` });
    },
  };
}

/** A transport that accepts every send (used to seed buckets via the fan-out). */
function acceptingTransport(): MessageTransport {
  return {
    send(): Promise<TransportReceipt> {
      return Promise.resolve({ providerMessageId: "seed" });
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_digest_daily_cap");
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

/** Seed the settings singleton with a non-default `maxDigestEmailsPerDay`. */
async function seedDailyCap(database: Db, maxPerDay: number): Promise<void> {
  await seedPlatformSettings({ db: database, clock: fixedClock(T0) });
  await database
    .collection<{ _id: string } & Record<string, unknown>>(PLATFORM_SETTINGS)
    .updateOne(
      { _id: SINGLETON_ID },
      { $set: { "notifications.maxDigestEmailsPerDay": maxPerDay } }
    );
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
    claimerId: "worker_digest_daily_cap",
  });
}

describe("a failed digest flush does not consume the daily allowance (F1c)", () => {
  it("F1c: with a cap of one, a failed flush still lets the recipient's next digest go out", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      await seedRecipient(test.db, attendee);
      await seedDailyCap(test.db, MAX_DIGEST_EMAILS_PER_DAY);
      invalidatePlatformSettings();

      // Two arrivals → two open buckets; the first is due one minute earlier.
      await insertArrival(test.db, new ObjectId().toHexString(), attendee);
      await runFanOutAt(test.db, acceptingTransport(), fixedRecipients(attendee), at(T0, 0));
      await insertArrival(test.db, new ObjectId().toHexString(), attendee);
      await runFanOutAt(test.db, acceptingTransport(), fixedRecipients(attendee), at(T0, MINUTE));

      expect(
        await test.db.collection(NOTIFICATION_DIGESTS).countDocuments({ status: "open" })
      ).toBe(2);

      // The first digest's send fails retryably; the second would succeed.
      const transport = scriptedTransport(1);

      const outcome = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 20 * MINUTE)),
        transport,
        limit: 100,
      });

      // The failed flush consumed no allowance: the second digest is still sent.
      expect(transport.calls).toBe(2);
      expect(outcome.affected).toBe(1);
      expect(outcome.errors).toBe(1);
      expect(outcome.skipped).toBe(0);
      expect(transport.outbox).toHaveLength(1);
    });
  });
});
