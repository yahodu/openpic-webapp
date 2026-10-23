import { ObjectId, type Db, type Document } from "mongodb";
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
 * Integration / contract — a **permanently** non-retryable digest-flush failure
 * must stop being re-attempted after a bounded number of attempts (OP-96
 * follow-up round 3 RED, review finding F1b-r2, ADR-0134 §"Accepted consequence
 * (reviewer finding F1b-r2, routed)").
 *
 * ## The defect this pins
 *
 * The round-2 F1b contract (ADR-0133 §"F1b — the design choice", implemented in
 * ADR-0134) chose **option (a)**: after a **non-retryable** transport failure the
 * bucket stays `open` so a later flush tick re-attempts the summary. That is
 * correct for the *transient* case the F1b pin scripts (one failure, then a
 * recovery), but it leaves this boundary unpinned: a failure that is
 * non-retryable **every** time — e.g. a provider `400` for a bad destination —
 * leaves the bucket `open` and therefore re-attempts it on **every** subsequent
 * flush tick, calling the transport again and inserting a fresh `attempts: 1`
 * `failed` ledger row each time, until the bucket's `expireAt` TTL retires it.
 * In a system where `retryable: false` means "never retry", an unbounded retry
 * loop of a non-retryable failure is a contradiction.
 *
 * ## The pinned contract (bounded, terminal)
 *
 * A digest bucket is re-attempted after a non-retryable flush failure at most
 * `platformSettings.pipeline.maxAttempts` times — the app's single "attempts
 * before giving up" ceiling, read through the same `getPlatformSettings` seam
 * the flush already uses (the sibling F2b pin bounds the dispatch retry sweep by
 * the same setting). When the number of non-retryable flush failures reaches
 * that ceiling the bucket reaches a **terminal classification** and leaves the
 * selectable set (`status` stops being `"open"`, recorded as
 * `status: "flushed"`, `flushOutcome: "failed"` — reusing the field the round-2
 * F1c closure introduced rather than inventing a second one), so no later flush
 * tick re-selects it. Each attempt still durably records its own `failed` ledger
 * row, so the row count is bounded by the ceiling; the summary is never
 * delivered.
 *
 * Observable over `N + 2` flush ticks with a transport that rejects
 * non-retryably on **every** send and `pipeline.maxAttempts` seeded to a
 * non-default `N`:
 *
 * 1. the transport is not called more than `N` times;
 * 2. no `failed` ledger rows accumulate beyond `N`;
 * 3. the summary is never delivered;
 * 4. after the `N`th failure the bucket is terminal (`status !== "open"`) and
 *    the two trailing ticks select nothing.
 *
 * ## Semantics note (F1b synthetic recovery)
 *
 * The round-2 F1b pin's scripted transport makes a `retryable: false` error
 * *succeed* on its second call, so the recovery it asserts is **synthetic**: the
 * pin proves failure *ownership* (the bucket stays selectable and the retry cron
 * is not a second owner), not that a non-retryable failure actually recovers.
 * This pin deliberately drives a *permanent* non-retryable rejection so the
 * unbounded-repeat boundary is what is measured.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real flush job.
 */

/** The `notification_dispatches` collection (schema §12). */
const DISPATCHES = COLLECTIONS.dispatches;
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

/**
 * The attempt ceiling this spec pins (deliberately not the shipped default `5`,
 * so the pin never depends on it). `N + 2` flush ticks are driven below.
 */
const MAX_FLUSH_ATTEMPTS = 2;

/** Fields of a stored digest bucket this spec inspects (schema §19.6). */
interface StoredBucket {
  readonly status?: unknown;
  readonly flushOutcome?: unknown;
}

/** A scripted transport that rejects **every** send non-retryably. */
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

/**
 * Build a transport that rejects **every** send non-retryably (a permanent
 * provider `400` for a bad destination), so the bucket can never recover.
 */
function permanentlyNonRetryableTransport(): ScriptedTransport {
  const outbox: OutboundMessage[] = [];
  let calls = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    get calls(): number {
      return calls;
    },
    send(): Promise<TransportReceipt> {
      calls += 1;
      return Promise.reject(
        new TransportError("scripted permanent provider rejection", {
          retryable: false,
          code: "http",
          status: 400,
        })
      );
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
  const test = createTestDb("openpic_notification_digest_non_retryable_bound");
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
    claimerId: "worker_digest_non_retryable_bound",
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

describe("a permanently non-retryable digest flush failure is bounded and terminal (F1b-r2)", () => {
  it("F1b-r2: with maxAttempts of two, the transport is called twice across four ticks and the bucket goes terminal", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);
      await seedMaxAttempts(test.db, MAX_FLUSH_ATTEMPTS);
      invalidatePlatformSettings();

      // One arrival → one open bucket whose flushAt is t0 + 15m.
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, acceptingTransport(), fixedRecipients(attendee), at(T0, 0));
      expect(
        await test.db.collection(NOTIFICATION_DIGESTS).countDocuments({ status: "open" })
      ).toBe(1);

      // The transport rejects **every** send non-retryably (a permanent 400).
      const transport = permanentlyNonRetryableTransport();

      // --- Attempt 1 (inside the bound): the failure is recorded, the bucket stays
      // --- selectable — exactly what the round-2 F1b pin requires.
      const firstTick = await flushDueDigests({
        db: test.db,
        clock: fixedClock(at(T0, 20 * MINUTE)),
        transport,
        limit: 100,
      });
      expect(firstTick.errors).toBe(1);
      expect(transport.calls).toBe(1);
      expect((await theBucket(test.db))?.status).toBe("open");

      // --- Attempts 2..N and the two trailing ticks (N + 2 ticks in total). ---
      const laterTicks = [];
      for (const minutes of [21, 22, 23]) {
        laterTicks.push(
          await flushDueDigests({
            db: test.db,
            clock: fixedClock(at(T0, minutes * MINUTE)),
            transport,
            limit: 100,
          })
        );
      }

      // (i) The transport is not called more than the bound across N + 2 ticks.
      expect(transport.calls).toBe(MAX_FLUSH_ATTEMPTS);

      // (iv) After the Nth non-retryable failure the bucket is terminal: it has left
      // the selectable set the flush cron reads (`status: "open"`).
      const terminal = await theBucket(test.db);
      expect(terminal?.status).toBe("flushed");
      expect(terminal?.flushOutcome).toBe("failed");

      // (ii) No `failed` ledger rows accumulate beyond the bound.
      const failedRows = await ledgerRows(test.db);
      expect(failedRows.length).toBeGreaterThanOrEqual(1);
      expect(failedRows.length).toBeLessThanOrEqual(MAX_FLUSH_ATTEMPTS);
      expect(failedRows[0]).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: { retryable: false, code: "http", status: 400 },
      });
      expect(
        await test.db.collection(DISPATCHES).countDocuments({ typeKey: TYPE_KEY, status: "sent" })
      ).toBe(0);

      // (iii) The summary is never delivered.
      expect(transport.outbox).toHaveLength(0);

      // The two trailing ticks select nothing: the flush cron no longer re-attempts.
      expect(laterTicks[1]?.scanned).toBe(0);
      expect(laterTicks[2]?.scanned).toBe(0);
    });
  });
});
