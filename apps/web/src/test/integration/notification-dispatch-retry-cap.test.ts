import { ObjectId, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient } from "@/server/db/mongo";
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

/**
 * Integration / contract — retry attempts are bounded by
 * `platformSettings.pipeline.maxAttempts` (OP-96 follow-up RED, review finding
 * F2, ADR-0128 §3).
 *
 * The defect: `retryDueDispatches` re-attempts every
 * `failed && lastError.retryable:true` row forever. `pipeline.maxAttempts`
 * (already in the §20.4 singleton) is never read, so a permanently-retryable
 * row whose backoff has capped at 5 minutes is hammered indefinitely — the
 * card's "attempts < max" / "Retries are bounded" criterion is unmet.
 *
 * The pin drives the cap through the settings seam (a `platformSettings`
 * document with `pipeline.maxAttempts: 2`) so it never depends on the default:
 * a row one attempt below the cap is still selected; a row that has reached the
 * cap is not — the sweep makes no further transport call, leaves `attempts`
 * unchanged and reports no work.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real retry job.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
/** The Better Auth user collection (schema §13.1). */
const USER = "user";
/** The `platformSettings` singleton (schema §20.4). */
const PLATFORM_SETTINGS = "platformSettings";
const SINGLETON_ID = "singleton";

/** The non-digest type this spec drives. */
const TYPE_KEY = "event.details.updated";

/** A fixed instant so every stored timestamp is exact. */
const T0 = "2026-03-01T10:00:00.000Z";
const MINUTE = 60_000;

/** The configured attempt cap this spec pins (never the default 5). */
const MAX_ATTEMPTS = 2;

/** Fields of a stored dispatch row this spec inspects (schema §19.5). */
interface StoredDispatch {
  readonly status?: unknown;
  readonly attempts?: unknown;
  readonly lastError?: { readonly retryable?: unknown; readonly code?: unknown };
}

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
  // Never leak a non-default settings document into the process-wide cache.
  invalidatePlatformSettings();
});

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
  const test = createTestDb("openpic_notification_retry_cap");
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

/** Seed the settings singleton with a non-default `pipeline.maxAttempts`. */
async function seedMaxAttempts(database: Db, maxAttempts: number): Promise<void> {
  await seedPlatformSettings({ db: database, clock: fixedClock(T0) });
  await database
    .collection<{ _id: string } & Record<string, unknown>>(PLATFORM_SETTINGS)
    .updateOne({ _id: SINGLETON_ID }, { $set: { "pipeline.maxAttempts": maxAttempts } });
}

/** A fresh hex user id. */
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

/** Insert a pending `event.details.updated` outbox row and run the fan-out. */
async function deliverWith(
  database: Db,
  transport: MessageTransport,
  recipient: string,
  actor: string
): Promise<void> {
  const occurredAt = new Date(T0);
  await database.collection(COLLECTIONS.domainEvents).insertOne({
    eventKey: TYPE_KEY,
    tenantId: new ObjectId().toHexString(),
    actorRef: { kind: "user", id: actor },
    subjectRef: { kind: "event", id: new ObjectId().toHexString() },
    payload: {
      eventId: new ObjectId().toHexString(),
      eventName: "Rahul & Priya's Wedding",
      actionUrl: "https://app.openpic.in/events/abc",
    },
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 24 * 60 * MINUTE),
    dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
  });

  const recipients: RecipientRepository = {
    listEventRoleMembers: () => Promise.resolve([recipient]),
    listIdentifiedAttendeeUserIds: () => Promise.resolve([]),
    getBillingContactUserId: () => Promise.resolve(null),
    listPlatformAdminUserIds: () => Promise.resolve([]),
  };

  await runNotificationFanOut({
    db: database,
    clock: fixedClock(T0),
    transport,
    recipients,
    batch: 10,
    claimerId: "worker_retry_cap",
  });
}

/** The first dispatch row for the type (there is exactly one). */
async function emailDispatch(database: Db): Promise<StoredDispatch | undefined> {
  const rows = await database
    .collection<StoredDispatch>(DISPATCHES)
    .find({ typeKey: TYPE_KEY })
    .toArray();
  return rows[0];
}

/** Count every dispatch row for the type. */
async function rowCount(database: Db): Promise<number> {
  return database.collection(DISPATCHES).countDocuments({ typeKey: TYPE_KEY });
}

describe("retry attempts are bounded by pipeline.maxAttempts (F2)", () => {
  it("F2: a row one attempt below the cap is retried; a row at the cap is not selected", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient);
      await seedMaxAttempts(test.db, MAX_ATTEMPTS);
      invalidatePlatformSettings();

      const transport = alwaysFailingTransport();

      // The fan-out's first attempt fails retryably: attempts = 1 (< cap 2).
      await deliverWith(test.db, transport, recipient, actor);
      expect(transport.calls).toBe(1);
      expect(await emailDispatch(test.db)).toMatchObject({
        status: "failed",
        attempts: 1,
      });

      // One attempt below the cap: the row IS selected and re-attempted.
      const firstRetry = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:02:00.000Z"),
        transport,
        limit: 100,
      });
      expect(firstRetry.affected).toBe(0);
      expect(transport.calls).toBe(2);
      expect(await emailDispatch(test.db)).toMatchObject({ status: "failed", attempts: 2 });

      // At the cap: the row is NOT selected — no transport call, no work.
      const atCap = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:10:00.000Z"),
        transport,
        limit: 100,
      });
      expect(atCap.affected).toBe(0);
      expect(transport.calls).toBe(2);
      expect(await emailDispatch(test.db)).toMatchObject({ status: "failed", attempts: 2 });
      expect(await rowCount(test.db)).toBe(1);

      // And it stays out of the sweep on the following tick.
      const nextTick = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:20:00.000Z"),
        transport,
        limit: 100,
      });
      expect(nextTick.affected).toBe(0);
      expect(transport.calls).toBe(2);
    });
  });

  it("F2b: a row that has reached the cap reaches a terminal, non-retryable classification", async () => {
    await withTestDb(async (test) => {
      const recipient = newUserId();
      const actor = newUserId();
      await seedRecipient(test.db, recipient);
      await seedMaxAttempts(test.db, MAX_ATTEMPTS);
      invalidatePlatformSettings();

      const transport = alwaysFailingTransport();

      // The fan-out's first attempt fails retryably: attempts = 1 (< cap 2).
      await deliverWith(test.db, transport, recipient, actor);
      expect(await emailDispatch(test.db)).toMatchObject({ status: "failed", attempts: 1 });

      // The retry brings the row to the cap (attempts = 2).
      const firstRetry = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:02:00.000Z"),
        transport,
        limit: 100,
      });
      expect(firstRetry.affected).toBe(0);
      expect(await emailDispatch(test.db)).toMatchObject({ status: "failed", attempts: 2 });

      // At the cap the row is not selected and must be observably terminal, so a
      // backlog metric keyed on `lastError.retryable` does not report a
      // permanently growing queue.
      const atCap = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:10:00.000Z"),
        transport,
        limit: 100,
      });
      expect(atCap.affected).toBe(0);
      expect(transport.calls).toBe(2);

      const capped = await emailDispatch(test.db);
      expect(capped).toMatchObject({ status: "failed", attempts: 2 });
      expect(capped?.lastError).toBeDefined();
      expect(capped?.lastError).toMatchObject({
        retryable: false,
        code: "attempts_exhausted",
      });

      // And it stays terminal on the following tick, still with no transport call.
      const nextTick = await retryDueDispatches({
        db: test.db,
        clock: fixedClock("2026-03-01T10:20:00.000Z"),
        transport,
        limit: 100,
      });
      expect(nextTick.affected).toBe(0);
      expect(transport.calls).toBe(2);
      expect(await emailDispatch(test.db)).toMatchObject({ status: "failed", attempts: 2 });
      expect(await rowCount(test.db)).toBe(1);
    });
  });
});
