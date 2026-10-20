import { ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
import { releaseDeferredDispatches } from "@/server/notifications/quiet-hours-release";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";
import { fixedClock } from "@/server/runtime/clock";

import {
  createTestDb,
  MONGO_READY_HOOK_TIMEOUT_MS,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";

/**
 * Integration / contract — the three sweeps bound the **read**, not just the
 * work (OP-96 follow-up RED, review finding F3, ADR-0128 §3).
 *
 * The defect: `dispatch-retry.ts`, `quiet-hours-release.ts` and `digest.ts` all
 * `.toArray()` the whole selectable set before applying `limit` in the loop, so
 * a post-outage backlog is read in full. Worse, `limit` only bounds *successes*
 * (`affected`): when every send fails the loop never reaches `affected >= limit`
 * and processes the entire backlog in one run.
 *
 * The pinned contract of a bounded query: with a backlog of `N > limit` due rows
 * `scanned` must not exceed `limit + 1` (the implementation is free to add
 * `.limit(limit + 1)` or a cursor) while `hasMore` still reports the remaining
 * backlog. This deliberately changes the `scanned` semantics of the over-limit
 * case. The existing I6/I9/I11 pins assert only `affected`/`hasMore`/`outbox`,
 * so they are unaffected.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real jobs.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The `notificationDigests` bucket collection (schema §12/§19.6). */
const NOTIFICATION_DIGESTS = "notificationDigests";
/** The Better Auth user collection (schema §13.1). */
const USER = "user";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An instant inside the quiet window (23:00 UTC). */
const INSIDE = "2026-03-01T23:00:00.000Z";
/** The window end the deferral targets (07:00 UTC the next day). */
const WINDOW_END = "2026-03-02T07:00:00.000Z";

/** The due backlog used by every case; strictly greater than `limit`. */
const BACKLOG = 10;
/** The per-run budget; every case expects `scanned <= LIMIT + 1`. */
const LIMIT = 2;

/** A transport that rejects every send with a retryable transport error. */
interface AlwaysFailingTransport extends MessageTransport {
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
  invalidatePlatformSettings();
});

/** The ISO instant `base + ms`. */
function at(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

/** A transport that fails every send retryably. */
function alwaysFailingTransport(): AlwaysFailingTransport {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    send(_message: OutboundMessage): Promise<TransportReceipt> {
      calls += 1;
      return Promise.reject(
        new TransportError("scripted provider outage", {
          retryable: true,
          code: "http",
          status: 503,
        })
      );
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_bounded_sweeps");
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

/** A fresh hex user id. */
function newUserId(): string {
  return new ObjectId().toHexString();
}

/** Insert the `user`, `userProfiles` and `notificationPreferences` trio. */
async function seedRecipient(
  database: Db,
  userId: string,
  quietHours = { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" }
): Promise<void> {
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
    quietHours,
    locale: "en-IN",
  });
}

/** Insert a pending outbox row for one `event.details.updated`. */
async function insertEvent(
  database: Db,
  eventId: string,
  actor: string,
  instant: string
): Promise<void> {
  const occurredAt = new Date(instant);
  await database.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: "event.details.updated",
    tenantId: new ObjectId().toHexString(),
    actorRef: { kind: "user", id: actor },
    subjectRef: { kind: "event", id: eventId },
    payload: {
      eventId,
      eventName: "Rahul & Priya's Wedding",
      actionUrl: "https://app.openpic.in/e",
    },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * HOUR),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });
}

/** Insert a pending outbox row for one `attendee.matches.new` (a digest type). */
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

/** A recipient source resolving only the given event-role member. */
function eventRoleRecipient(recipient: string): RecipientRepository {
  return {
    listEventRoleMembers: () => Promise.resolve([recipient]),
    listIdentifiedAttendeeUserIds: () => Promise.resolve([]),
    getBillingContactUserId: () => Promise.resolve(null),
    listPlatformAdminUserIds: () => Promise.resolve([]),
  };
}

/** A recipient source resolving only the given attendee (digest path). */
function attendeeRecipient(attendee: string): RecipientRepository {
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
  instant: string,
  claimerId: string
): Promise<void> {
  await runNotificationFanOut({
    db: database,
    clock: fixedClock(instant),
    transport,
    recipients,
    batch: BACKLOG + 5,
    claimerId,
  });
}

describe("the retry sweep bounds its read (F3)", () => {
  it("F3: with a failing transport a backlog larger than `limit` scans at most `limit + 1` rows and reports hasMore", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient);

      const transport = alwaysFailingTransport();
      for (let index = 0; index < BACKLOG; index += 1) {
        await insertEvent(test.db, new ObjectId().toHexString(), actor, T0);
        await runFanOutAt(
          test.db,
          transport,
          eventRoleRecipient(recipient),
          T0,
          "worker_bounded_retry"
        );
      }
      expect(await test.db.collection(DISPATCHES).countDocuments({ status: "failed" })).toBe(
        BACKLOG
      );

      const outcome = await retryDueDispatches({
        db: test.db,
        clock: fixedClock(at(T0, 2 * MINUTE)),
        transport,
        limit: LIMIT,
      });

      expect(outcome.affected).toBe(0);
      expect(outcome.scanned).toBeLessThanOrEqual(LIMIT + 1);
      expect(outcome.hasMore).toBe(true);
    });
  });
});

describe("the quiet-hours release sweep bounds its read (F3)", () => {
  it("F3: with a failing transport a backlog larger than `limit` scans at most `limit + 1` rows and reports hasMore", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient, {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timeZone: "UTC",
      });

      const transport = alwaysFailingTransport();
      for (let index = 0; index < BACKLOG; index += 1) {
        await insertEvent(test.db, new ObjectId().toHexString(), actor, INSIDE);
        await runFanOutAt(
          test.db,
          transport,
          eventRoleRecipient(recipient),
          INSIDE,
          "worker_bounded_release"
        );
      }
      expect(await test.db.collection(DISPATCHES).countDocuments({ status: "deferred" })).toBe(
        BACKLOG
      );

      const outcome = await releaseDeferredDispatches({
        db: test.db,
        clock: fixedClock(WINDOW_END),
        transport,
        limit: LIMIT,
      });

      expect(outcome.affected).toBe(0);
      expect(outcome.scanned).toBeLessThanOrEqual(LIMIT + 1);
      expect(outcome.hasMore).toBe(true);
    });
  });
});

describe("the digest flush sweep bounds its read (F3)", () => {
  it("F3: with a failing transport a backlog larger than `limit` scans at most `limit + 1` buckets and reports hasMore", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      await seedRecipient(test.db, attendee);

      const transport = alwaysFailingTransport();
      // One bucket per arrival; all become due at t0 + 15m.
      for (let index = 0; index < BACKLOG; index += 1) {
        await insertArrival(test.db, new ObjectId().toHexString(), attendee);
        await runFanOutAt(
          test.db,
          transport,
          attendeeRecipient(attendee),
          at(T0, index * MINUTE),
          "worker_bounded_digest"
        );
      }
      expect(
        await test.db.collection(NOTIFICATION_DIGESTS).countDocuments({ status: "open" })
      ).toBe(BACKLOG);

      const outcome = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 40 * MINUTE)),
        transport,
        limit: LIMIT,
      });

      expect(outcome.affected).toBe(0);
      expect(outcome.scanned).toBeLessThanOrEqual(LIMIT + 1);
      expect(outcome.hasMore).toBe(true);
    });
  });
});
