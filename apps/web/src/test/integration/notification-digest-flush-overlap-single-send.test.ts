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

/**
 * Integration / contract — **overlapping** digest-flush runs deliver a bucket's
 * summary at most once (OP-96 follow-up round 3 RED, review finding F2,
 * ADR-0139; evidence: ADR-0137 §"Review sign-off (round 1 GREEN, artifact lens)"
 * §Findings §F2).
 *
 * ## The defect this pins
 *
 * `flushDueDigests` selects `{ status: "open", flushAt: { $lte: now } }` and
 * guards only the **write** (`updateOne({ _id, status: "open" })` in
 * `markFlushed`); nothing **claims** a bucket before the send. Two invocations
 * whose lifetimes overlap therefore both read the bucket before either closes
 * it and both hand the same summary to the transport — two identical emails,
 * two `sent` ledger rows, both runs reporting `affected: 1`. That contradicts
 * ADR-0130 F1's stated intent ("the flush cron can never re-select the bucket
 * and double-send the summary") and ADR-0028 §1's "concurrency-safe" cron claim
 * (`apps/web/src/server/jobs/cron-job.ts` doc-comment). Overlap is reachable:
 * the framework explicitly supports a scheduler re-invoking to drain a backlog
 * (`hasMore`), a platform retry after a timeout, or a manual/signed trigger
 * running next to the cron.
 *
 * ## The pinned contract (at most one delivery per bucket)
 *
 * **At most one delivery per bucket per open → flushed transition, even when
 * flush runs overlap.** The pin is deliberately mechanism-agnostic: a
 * claim/lease taken with a conditional `findOneAndUpdate` before the send, or an
 * atomic transition-before-send, both satisfy it. Only observables are asserted
 * — the transport's deliveries, the ledger rows, the stored bucket state and the
 * `CronRunOutcome` delivery count (`affected`) summed across the two runs.
 *
 * Observable, with one due bucket and two concurrent `flushDueDigests` runs
 * whose transport blocks long enough for the second run's read to overlap the
 * first run's send:
 *
 * 1. the transport is invoked **once** and holds **one** delivered message;
 * 2. exactly **one** `sent` dispatch ledger row exists for the digest type;
 * 3. the bucket ends `status: "flushed"`, `flushOutcome: "sent"`;
 * 4. the two runs report **one** delivery in total (`affected` sums to 1) — the
 *    defect's signature is both runs reporting `affected: 1` for one bucket.
 *
 * The `CronRunOutcome` **split** is deliberately not pinned (`scanned`/`skipped`
 * are free to differ per mechanism); only the summed delivery count is. The
 * failure-path sibling below pins the same overlap for a non-retryable
 * rejection, where over-counting the bucket's failure would flip it terminal
 * one attempt early and break the F1b "stays selectable" contract.
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
const T0 = "2026-03-01T10:00:00.000Z";
const MINUTE = 60_000;

/**
 * How long the scripted transport blocks before answering, in ms.
 *
 * This is what makes the overlap **deterministic** rather than racy: both runs
 * reach their `send` within a few ms of each other and neither closes the bucket
 * until its send resolves, so each run's select provably happens before the
 * other run's close. It is a real timer (never a fake one) and both runs share
 * it, so it adds one delay to the suite, not one per run.
 */
const SEND_DELAY_MS = 150;

/**
 * The non-retryable attempt ceiling seeded for the failure case (deliberately
 * not the shipped default `5`, so a single overlapped attempt must leave the
 * bucket **open** and only a double-count could close it).
 */
const MAX_FLUSH_ATTEMPTS = 2;

/** Fields of a stored digest bucket this spec inspects (schema §19.6). */
interface StoredBucket {
  readonly status?: unknown;
  readonly flushOutcome?: unknown;
}

/** A scripted transport that delays every answer and records its deliveries. */
interface DelayingTransport extends MessageTransport {
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

/** A real delay, used to hold a scripted send open so two runs overlap. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a transport that blocks {@link SEND_DELAY_MS} before accepting, so a
 * second flush run reads the still-open bucket while the first run is sending.
 */
function delayingAcceptingTransport(): DelayingTransport {
  const outbox: OutboundMessage[] = [];
  let calls = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    get calls(): number {
      return calls;
    },
    async send(message: OutboundMessage): Promise<TransportReceipt> {
      calls += 1;
      await delay(SEND_DELAY_MS);
      outbox.push(message);
      return { providerMessageId: `stub-${String(calls)}` };
    },
  };
}

/**
 * Build a transport that blocks {@link SEND_DELAY_MS} and then rejects
 * **non-retryably** (a permanent provider `400`), so the overlapped pair must
 * still leave the bucket selectable for the F1b retry.
 */
function delayingNonRetryableTransport(): DelayingTransport {
  const outbox: OutboundMessage[] = [];
  let calls = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    get calls(): number {
      return calls;
    },
    async send(): Promise<TransportReceipt> {
      calls += 1;
      await delay(SEND_DELAY_MS);
      throw new TransportError("scripted permanent provider rejection", {
        retryable: false,
        code: "http",
        status: 400,
      });
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
  const test = createTestDb("openpic_notification_digest_flush_overlap");
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
    claimerId: "worker_digest_flush_overlap",
  });
}

/**
 * Seed exactly one **due** open digest bucket: one fan-out arrival, then the
 * flush clock moved past the bucket's `flushAt` (`t0 + 15m`).
 */
async function seedOneDueBucket(test: TestDb): Promise<void> {
  const attendee = newUserId();
  const eventId = new ObjectId().toHexString();
  await seedRecipient(test.db, attendee);
  await insertArrival(test.db, eventId, attendee);
  await runFanOutAt(test.db, acceptingTransport(), fixedRecipients(attendee), at(T0, 0));
  expect(await test.db.collection(NOTIFICATION_DIGESTS).countDocuments({ status: "open" })).toBe(1);
}

/** The one stored bucket (schema §19.6). */
async function theBucket(database: Db): Promise<StoredBucket | null> {
  return database.collection<StoredBucket>(NOTIFICATION_DIGESTS).findOne({});
}

/** Every stored dispatch ledger row for the digest type (schema §19.5). */
async function ledgerRows(database: Db, status: "sent" | "failed"): Promise<readonly Document[]> {
  return database.collection(DISPATCHES).find({ typeKey: TYPE_KEY, status }).toArray();
}

describe("overlapping digest-flush runs deliver a bucket's summary at most once (F2)", () => {
  it("F2: two concurrent runs deliver one summary, one sent ledger row and one reported delivery", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);

      // --- Two flush runs with overlapping lifetimes, one due bucket. ---
      // The transport holds each send open for SEND_DELAY_MS, so both runs
      // select the still-open bucket before either can close it.
      const transport = delayingAcceptingTransport();
      const flushAt = at(T0, 20 * MINUTE);

      const [firstFlush, secondFlush] = await Promise.all([
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
      ]);

      // (1) One delivery: the transport is invoked once and holds one message.
      expect(transport.outbox).toHaveLength(1);
      expect(transport.calls).toBe(1);

      // (2) One `sent` ledger row for the digest type.
      expect(await ledgerRows(test.db, "sent")).toHaveLength(1);

      // (3) The bucket is closed exactly once, as delivered.
      const bucket = await theBucket(test.db);
      expect(bucket?.status).toBe("flushed");
      expect(bucket?.flushOutcome).toBe("sent");

      // (4) The two runs report one delivery in total — not one each.
      expect(firstFlush.affected + secondFlush.affected).toBe(1);
    });
  });

  it("F2: two concurrent non-retryable flush runs record one failure and leave the bucket selectable", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);
      await seedMaxAttempts(test.db, MAX_FLUSH_ATTEMPTS);
      invalidatePlatformSettings();

      // --- Same overlap, but every send rejects non-retryably. ---
      const transport = delayingNonRetryableTransport();
      const flushAt = at(T0, 20 * MINUTE);

      const [firstFlush, secondFlush] = await Promise.all([
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
      ]);

      // One attempt, one failed ledger row — the overlapped pair must not spend
      // two of the bucket's bounded non-retryable attempts on one flush.
      expect(transport.calls).toBe(1);
      expect(await ledgerRows(test.db, "failed")).toHaveLength(1);

      // Nothing was delivered, and the bucket is still selectable for the F1b
      // retry: a single recorded failure is below `maxAttempts`, so an
      // over-counted pair would (wrongly) flip it terminal one attempt early.
      expect(transport.outbox).toHaveLength(0);
      expect(await ledgerRows(test.db, "sent")).toHaveLength(0);
      expect((await theBucket(test.db))?.status).toBe("open");
      expect(firstFlush.affected + secondFlush.affected).toBe(0);
    });
  });
});
