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
 * Integration / contract — the flush **claim/lease** beyond the overlap pin
 * (OP-96 follow-up F1, ADR-0143 §Consequences; the frozen overlap pin is
 * `notification-digest-flush-overlap-single-send.test.ts`, reviewed and
 * approved as-is under ADR-0139).
 *
 * The claim the F2 GREEN added takes each due bucket with one atomic
 * conditional `findOneAndUpdate` **before** the send, so two overlapping
 * `flushDueDigests` runs deliver at most one summary. The frozen pin proves
 * only that single-delivery contract. Two further properties of the mechanism
 * were called out as **not pinned** by ADR-0143 §Consequences and this spec
 * pins them, plus its two release paths:
 *
 * 1. the claim is a **lease**, not a lock," — a claim older than
 *    `FLUSH_CLAIM_STALE_MS` (5 min) must be reclaimable (a run that died
 *    mid-send must never strand a bucket), while a claim **not** yet stale must
 *    **not** be re-sent by another run;
 * 2. the **retryable-overlap sibling** (ADR-0139 finding F2-3): the same
 *    overlapping pair where the transport rejects **retryably** — one transport
 *    call, one `failed` ledger row that owns its redelivery, the bucket closed
 *    `flushed`/`failed`, nothing delivered;
 * 3. the **release** paths: a failure below `pipeline.maxAttempts` leaves the
 *    bucket `open` **and unclaimed**, so the next tick re-attempts it
 *    immediately rather than waiting out the lease.
 *
 * The pins are deliberately mechanism-agnostic: only observables are asserted
 * — the transport's `calls`/`outbox`, the ledger rows, the stored bucket state
 * (`status`, `flushOutcome`, the presence/absence of `flushClaimedAt`) and the
 * `CronRunOutcome` delivery count (`affected`). A different single-delivery
 * mechanism (an atomic transition-before-send, a queue) satisfies them
 * identically.
 *
 * The `CronRunOutcome` **split** is deliberately not pinned for the overlap
 * case (ADR-0139 §Decision leaves `scanned`/`skipped` free). The one split
 * assertion — `skipped: 1` for a live claim — is made only because a **single**
 * run is under test, where the loser of the claim is unambiguously the only
 * run and a live claim is the only reason it would not deliver.
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
 * The non-retryable attempt ceiling seeded for the release-path case
 * (deliberately not the shipped default `5`, so a single attempt is below the
 * bound and the bucket must be left `open` and immediately re-selectable).
 */
const MAX_FLUSH_ATTEMPTS = 2;

/** Fields of a stored digest bucket this spec inspects (schema §19.6). */
interface StoredBucket {
  readonly status?: unknown;
  readonly flushOutcome?: unknown;
  readonly flushClaimedAt?: unknown;
}

/** A scripted transport that records its deliveries and call count. */
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

/** A real delay, used to hold a scripted send open so two runs overlap. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A transport that accepts every send and records its call count. */
function recordingAcceptingTransport(): ScriptedTransport {
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
      return Promise.resolve({ providerMessageId: `stub-${String(calls)}` });
    },
  };
}

/**
 * Build a transport that blocks {@link SEND_DELAY_MS} and then rejects
 * **retryably** (a transient provider `503`), so the ledger row it writes owns
 * the redelivery.
 */
function delayingRetryableTransport(): ScriptedTransport {
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
      throw new TransportError("scripted transient provider rejection", {
        retryable: true,
        code: "http",
        status: 503,
      });
    },
  };
}

/** A transport that rejects **non-retryably** (a permanent provider `400`). */
function nonRetryableTransport(): ScriptedTransport {
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
  const test = createTestDb("openpic_notification_digest_flush_claim_lease");
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
    claimerId: "worker_digest_flush_claim_lease",
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

/**
 * Park a pre-existing claim on the one open bucket, as a run that died mid-send
 * (or one still mid-send) would have left it, without otherwise changing it.
 */
async function parkClaim(database: Db, claimedAt: Date): Promise<void> {
  await database
    .collection(NOTIFICATION_DIGESTS)
    .updateOne({ status: "open" }, { $set: { flushClaimedAt: claimedAt } });
}

/** Every stored dispatch ledger row for the digest type (schema §19.5). */
async function ledgerRows(database: Db, status: "sent" | "failed"): Promise<readonly Document[]> {
  return database.collection(DISPATCHES).find({ typeKey: TYPE_KEY, status }).toArray();
}

describe("the digest-flush claim is a lease: stale claims recover, live claims are honoured", () => {
  it("reclaims a claim older than the lease and delivers the summary", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);
      const flushAt = at(T0, 20 * MINUTE);
      // A claim 6 minutes old is older than the 5-minute lease: a run that died
      // mid-send must be reclaimable, so the bucket is not stranded.
      await parkClaim(test.db, new Date(new Date(flushAt).getTime() - 6 * MINUTE));

      // --- One flush run over the stale-claimed, due, open bucket. ---
      const transport = recordingAcceptingTransport();
      const outcome = await flushDueDigests({
        db: test.db,
        clock: fixedClock(flushAt),
        transport,
        limit: 100,
      });

      // The summary is delivered exactly once.
      expect(transport.calls).toBe(1);
      expect(transport.outbox).toHaveLength(1);
      expect(await ledgerRows(test.db, "sent")).toHaveLength(1);

      // The bucket is closed as delivered, and the reclaimed lease is cleared
      // with the close rather than left to outlive the work it guarded.
      const bucket = await theBucket(test.db);
      expect(bucket?.status).toBe("flushed");
      expect(bucket?.flushOutcome).toBe("sent");
      expect(bucket?.flushClaimedAt).toBeUndefined();
      expect(outcome.affected).toBe(1);
    });
  });

  it("honours a claim that is not yet stale and does not deliver", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);
      const flushAt = at(T0, 20 * MINUTE);
      // A claim 1 minute old is inside the 5-minute lease: another run is still
      // (presumed) mid-send, so this run must leave the bucket alone.
      const claimAt = new Date(new Date(flushAt).getTime() - 1 * MINUTE);
      await parkClaim(test.db, claimAt);

      // --- One flush run over the live-claimed, due, open bucket. ---
      const transport = recordingAcceptingTransport();
      const outcome = await flushDueDigests({
        db: test.db,
        clock: fixedClock(flushAt),
        transport,
        limit: 100,
      });

      // Nothing is delivered and no ledger row is written.
      expect(transport.calls).toBe(0);
      expect(transport.outbox).toHaveLength(0);
      expect(await ledgerRows(test.db, "sent")).toHaveLength(0);
      expect(await ledgerRows(test.db, "failed")).toHaveLength(0);

      // The bucket is untouched: still open, its live claim unchanged.
      const bucket = await theBucket(test.db);
      expect(bucket?.status).toBe("open");
      expect(bucket?.flushClaimedAt).toEqual(claimAt);

      // The single run reports no delivery and counts the bucket skipped.
      expect(outcome.affected).toBe(0);
      expect(outcome.skipped).toBe(1);
    });
  });
});

describe("overlapping digest-flush runs where the transport rejects retryably (F2-3)", () => {
  it("delivers nothing once, records one owner-bearing failure and closes the bucket failed", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);

      // --- Two flush runs with overlapping lifetimes, one due bucket, every
      // send held open then rejected retryably. ---
      const transport = delayingRetryableTransport();
      const flushAt = at(T0, 20 * MINUTE);

      const [firstFlush, secondFlush] = await Promise.all([
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
        flushDueDigests({ db: test.db, clock: fixedClock(flushAt), transport, limit: 100 }),
      ]);

      // The claim means only one run reached the transport.
      expect(transport.calls).toBe(1);

      // Exactly one `failed` ledger row exists, and it owns the redelivery —
      // the retry sweep selects `lastError.retryable: true`.
      const failed = await ledgerRows(test.db, "failed");
      expect(failed).toHaveLength(1);
      expect(
        (failed[0]?.lastError as { readonly retryable?: unknown } | undefined)?.retryable
      ).toBe(true);
      expect(await ledgerRows(test.db, "sent")).toHaveLength(0);

      // The bucket is closed as failed: the ledger row owns the redelivery, so
      // the flush cron must not re-select and re-send the summary.
      const bucket = await theBucket(test.db);
      expect(bucket?.status).toBe("flushed");
      expect(bucket?.flushOutcome).toBe("failed");

      // Neither run reports a delivery.
      expect(firstFlush.affected + secondFlush.affected).toBe(0);
    });
  });
});

describe("a failed flush releases the claim when the bucket stays selectable", () => {
  it("leaves a non-retryably-failed bucket open and unclaimed below the attempt bound", async () => {
    await withTestDb(async (test) => {
      await seedOneDueBucket(test);
      await seedMaxAttempts(test.db, MAX_FLUSH_ATTEMPTS);
      invalidatePlatformSettings();

      // --- One flush run whose send rejects non-retryably. ---
      const transport = nonRetryableTransport();
      const flushAt = at(T0, 20 * MINUTE);
      const outcome = await flushDueDigests({
        db: test.db,
        clock: fixedClock(flushAt),
        transport,
        limit: 100,
      });

      // One attempt, one failed ledger row, nothing delivered.
      expect(transport.calls).toBe(1);
      expect(await ledgerRows(test.db, "failed")).toHaveLength(1);
      expect(await ledgerRows(test.db, "sent")).toHaveLength(0);

      // A single recorded failure is below `maxAttempts`, so the bucket stays
      // `open` — and the claim is **released**, not merely left to expire, so
      // the very next tick re-attempts it immediately.
      const bucket = await theBucket(test.db);
      expect(bucket?.status).toBe("open");
      expect(bucket?.flushClaimedAt).toBeUndefined();
      expect(outcome.affected).toBe(0);
    });
  });
});
