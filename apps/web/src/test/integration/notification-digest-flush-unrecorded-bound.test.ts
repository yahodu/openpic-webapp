import { ObjectId, type Db, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

/**
 * Integration / contract — a digest bucket whose flush **always** fails
 * *unrecorded* (the recipient has no address for the bucket's channel) must stop
 * being re-attempted after a bounded number of attempts (OP-96 follow-up round
 * 3 RED, review finding F1, ADR-0138).
 *
 * ## The defect this pins
 *
 * `flushOneBucket` returns `failed_unrecorded` when it cannot resolve a
 * destination for the bucket's channel (`resolveDestination(...) === null`) or
 * cannot build the message (`buildRedeliveryMessage(...) === null`). That
 * condition is **permanent** for a given `{recipient, channel}`: a user with no
 * address for the channel never gains one. The failure writes no ledger row, and
 * `flushDueDigests` deliberately leaves such a bucket `open` and counts
 * `errors += 1` — with nothing bounding it. The flush cron therefore re-selects
 * the bucket on **every** tick, re-resolving the destination and re-rendering the
 * summary, counting an error each time, until the bucket's `expireAt` TTL
 * retires it.
 *
 * The round-3 GREEN (ADR-0137) just bounded the **transport** variant of a
 * permanent failure (`failed_terminal`, counted in `nonRetryableFailures` and
 * capped at `platformSettings.pipeline.maxAttempts`), which makes the asymmetry
 * visible: a permanently non-retryable *transport* failure is bounded at `N`,
 * while a permanently *unrecorded* failure is unbounded. In a system where a
 * failure with no owner means "nobody will ever retry this", an unbounded
 * re-attempt loop is a contradiction — and `errors` is permanently non-zero for
 * that recipient, which is alert noise.
 *
 * ## The pinned contract (bounded, terminal — mirrors ADR-0137 §Decision)
 *
 * Of the card's two listed shapes this pin selects the **terminal-state** shape
 * (option (a)), so the two permanent-failure paths share one rule:
 *
 * 1. a digest bucket is re-attempted after an *unrecorded* flush failure at most
 *    `platformSettings.pipeline.maxAttempts` times — the app's single "attempts
 *    before giving up" ceiling, read through the same `getPlatformSettings`
 *    seam the flush already uses (and the same one the sibling ADR-0137 bound
 *    reads);
 * 2. when the number of unrecorded flush failures reaches that ceiling the
 *    bucket reaches a **terminal classification** and leaves the selectable set
 *    (`status` stops being `"open"`, recorded as `status: "flushed"`,
 *    `flushOutcome: "failed"` — reusing the field the round-2 F1c closure
 *    introduced rather than inventing a second one), so no later flush tick
 *    re-selects it;
 * 3. the individual attempt stays **cheap**: `failed_unrecorded` is resolved
 *    before the transport is ever called, so no attempt makes a transport call,
 *    writes a ledger row, or delivers anything — before *or* after the bound
 *    (`errors` is bounded by the ceiling too).
 *
 * Observable over `N + 2` flush ticks, with the bucket's destination removed
 * after the fan-out and `pipeline.maxAttempts` seeded to a non-default `N`:
 *
 * 1. the bucket is still `open` after the first unrecorded failure (the bound is
 *    `N`, not `1`);
 * 2. after the `N`th unrecorded failure the bucket is terminal
 *    (`status !== "open"`, `flushOutcome: "failed"`) and the two trailing ticks
 *    select nothing (`scanned: 0`, `errors: 0`);
 * 3. the transport is never called (0 calls, empty outbox) and no ledger row is
 *    ever written — the whole point of `failed_unrecorded` is that nothing is
 *    durably recorded to own a retry.
 *
 * Runs against a real `MongoMemoryReplSet` and the real seed catalogue, driven
 * through the real fan-out + the real flush job. The only scripted seam is the
 * transport (which this scenario never reaches).
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
const T0 = "2026-03-01T10:00:00.000Z";
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

/** A transport that accepts every send (this scenario never reaches it). */
interface CountingTransport extends MessageTransport {
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

/** A transport that accepts every send and counts the calls made to it. */
function countingTransport(): CountingTransport {
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
      outbox.push(message);
      return Promise.resolve({ providerMessageId: `msg-${String(calls)}` });
    },
  };
}

/** Run `fn` against a fresh throwaway database, always dropping it. */
async function withTestDb(fn: (test: TestDb) => Promise<void>): Promise<void> {
  const test = createTestDb("openpic_notification_digest_unrecorded_bound");
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

/**
 * Remove the recipient's address for the bucket's channel.
 *
 * The digest type this spec drives buckets to the `email` group, so clearing the
 * `user.email` makes `resolveDestination(...) === null` for that bucket —
 * permanently, since nothing in the flush path can re-create an address. This is
 * the faithful encoding of "a user with no address for the channel never gains
 * one": the fan-out could only have created the bucket while the address existed
 * (the routing decision needs a verified contact), so the failure is created by
 * an address that disappears between the digest being scheduled and its flush.
 */
async function clearRecipientAddress(database: Db, userId: string): Promise<void> {
  await database
    .collection(USER)
    .updateOne({ _id: new ObjectId(userId) }, { $set: { email: null } });
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
    claimerId: "worker_digest_unrecorded_bound",
  });
}

/** Flush the due buckets at a fixed instant. */
async function flushAt(
  database: Db,
  transport: MessageTransport,
  instant: string
): Promise<Awaited<ReturnType<typeof flushDueDigests>>> {
  return flushDueDigests({
    db: database,
    clock: fixedClock(instant),
    transport,
    limit: 100,
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

describe("a permanently unrecorded digest flush failure is bounded and terminal (F1)", () => {
  it("F1: with maxAttempts of two, the unrecorded failure stops being re-attempted and the bucket goes terminal", async () => {
    await withTestDb(async (test) => {
      const attendee = newUserId();
      const eventId = new ObjectId().toHexString();
      await seedRecipient(test.db, attendee);
      await seedMaxAttempts(test.db, MAX_FLUSH_ATTEMPTS);
      invalidatePlatformSettings();

      // One arrival → one open bucket whose flushAt is t0 + 15m. The fan-out can
      // only create it while the recipient still has a verified address.
      await insertArrival(test.db, eventId, attendee);
      await runFanOutAt(test.db, countingTransport(), fixedRecipients(attendee), at(T0, 0));
      expect(
        await test.db.collection(NOTIFICATION_DIGESTS).countDocuments({ status: "open" })
      ).toBe(1);

      // The address disappears before the bucket is due: every flush now fails
      // *unrecorded* (no destination to resolve, so no ledger row, no send).
      await clearRecipientAddress(test.db, attendee);

      const transport = countingTransport();

      // --- Attempt 1 (inside the bound): the failure is counted, but the bucket
      // --- stays selectable — the bound is `N`, not `1`.
      const firstTick = await flushAt(test.db, transport, at(T0, 20 * MINUTE));
      expect(firstTick.scanned).toBe(1);
      expect(firstTick.errors).toBe(1);
      expect((await theBucket(test.db))?.status).toBe("open");
      expect((await theBucket(test.db))?.flushOutcome).toBeUndefined();

      // --- Attempts 2..N and the two trailing ticks (N + 2 ticks in total). ---
      const laterTicks = [];
      for (const minutes of [21, 22, 23]) {
        laterTicks.push(await flushAt(test.db, transport, at(T0, minutes * MINUTE)));
      }

      // (3) The per-attempt cost stays zero: no transport call, no delivery, and
      // nothing durably recorded to own a retry.
      expect(transport.calls).toBe(0);
      expect(transport.outbox).toHaveLength(0);
      expect(await ledgerRows(test.db)).toHaveLength(0);
      expect(
        await test.db.collection(DISPATCHES).countDocuments({ typeKey: TYPE_KEY, status: "sent" })
      ).toBe(0);

      // (2) After the Nth unrecorded failure the bucket is terminal: it has left
      // the selectable set the flush cron reads (`status: "open"`).
      const terminal = await theBucket(test.db);
      expect(terminal?.status).toBe("flushed");
      expect(terminal?.flushOutcome).toBe("failed");

      // (1)+(2) The two trailing ticks select nothing and report no error: the
      // flush cron no longer re-attempts a permanently unrecorded failure, so the
      // permanent `errors: 1` alert noise is gone.
      expect(laterTicks[0]?.errors).toBe(1);
      expect(laterTicks[1]?.scanned).toBe(0);
      expect(laterTicks[1]?.errors).toBe(0);
      expect(laterTicks[2]?.scanned).toBe(0);
      expect(laterTicks[2]?.errors).toBe(0);
    });
  });
});
