import { Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { accountDeletionPurgeJob } from "@/server/jobs/account-deletion-purge";
import { eventWindowSweepJob } from "@/server/jobs/event-window-sweep";
import { invitationExpiryJob } from "@/server/jobs/invitation-expiry";
import { verificationNudgeJob } from "@/server/jobs/verification-nudge";
import { fixedClock } from "@/server/runtime/clock";

import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — a sweep's failure window (OP-136 follow-up,
 * finding **F3**; contract §10.2, §1.4, §12, §2.3, §4.5; ADR-0853).
 *
 * The user story: *as the platform I want a sweep's step to be recoverable, so
 * one failed write never loses the state change it was announcing and never
 * loses the outbox row that announces it.*
 *
 * ## What is pinned here
 *
 * Every one of these jobs writes its state change **and** an outbox row. The
 * pins do not prescribe how the two are kept together (a transaction, an
 * emit-first order, a resume marker — all satisfy them); each case injects one
 * failure at a **named** collection for **one** call, lets the run fail, and
 * then requires the *next* run to finish the work:
 *
 * 1. `account-deletion-purge` — a failed `accountDeletionTombstones` write
 *    leaves the profile `deleted` with `purgeStartedAt` stamped but no
 *    tombstone and no `account.deletion.completed`. Run 2 must still finish the
 *    deletion: one tombstone row holding the **last known email** (the only
 *    place the contact survives, and what the fan-out addresses the receipt to,
 *    §12), and one `account.deletion.completed` whose `payload` is `{ userId }`
 *    and nothing else.
 * 2. `verification-nudge` — a failed `userProfiles` increment must not consume
 *    a rung: the next run still delivers the same rung exactly once and the
 *    ladder still reaches `t+72h`.
 * 3. `invitation-expiry` — a failed `domain_events` write must not lose the
 *    reminder: after the retry the invitation holds exactly one
 *    `collab.invite.reminder`.
 * 4. `event-window-sweep` — a failed `event.ended` write must not lose the
 *    announcement: after the retry exactly one `event.ended` exists and the
 *    event is `ended`.
 *
 * The failure injection is a `Collection.prototype` spy gated on
 * `this.collectionName` (the jobs read their handle per call, so an instance
 * spy cannot intercept) and armed for a **single** call, then removed in the
 * same case, so no later case can see it.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The instant every run in this file is timed at, anchored **two UTC days ahead
 * of the real day** (ADR-0940). `invitations` carries
 * `invitations_expire_at_ttl` (`{ expireAt: 1 }`, `expireAfterSeconds: 0`), and
 * mongod evaluates that index against the real wall clock, not against the
 * injected `fixedClock(NOW)`. A literal anchor would therefore seed a row that
 * is already TTL-expired at insert time, and a monitor pass could delete it
 * between the seed and the case's read. The anchor is derived at runtime so
 * every `NOW ± n days` fixture stays in the real future while keeping its
 * position relative to the injected clock. See ADR-0148 for the shared helper
 * and ADR-0940 for this file.
 */
const NOW = new Date(fixtureInstant("09:00:00.000Z", 2));

/** The platform collection the deleted account's contact is retained in. */
const TOMBSTONES = "accountDeletionTombstones";

let app: TestApp;

/** The email the seeded Better Auth row carries for one user id. */
function userEmail(userId: ObjectId): string {
  return `user-${userId.toHexString()}@example.com`;
}

/** Seed one Better Auth user row. */
async function seedUser(options: {
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}): Promise<ObjectId> {
  const userId = new ObjectId();
  await app.db.collection("user").insertOne({
    _id: userId,
    email: userEmail(userId),
    emailVerified: options.emailVerified,
    name: `user-${userId.toHexString()}`,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
  return userId;
}

/** Seed the `userProfiles` row a user is projected through. */
async function seedProfile(
  userId: ObjectId,
  extra: Record<string, unknown> = {}
): Promise<ObjectId> {
  const profileId = new ObjectId();
  await app.db.collection(COLLECTIONS.userProfiles).insertOne({
    _id: profileId,
    userId,
    status: "active",
    primaryTenantId: new ObjectId().toHexString(),
    accountCompletedAt: null,
    verificationNudges: 0,
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    ...extra,
  });
  return profileId;
}

/** The stored verification nudge count for one profile. */
async function nudgeCount(profileId: ObjectId): Promise<unknown> {
  const row = await app.db.collection(COLLECTIONS.userProfiles).findOne({ _id: profileId });
  return row?.verificationNudges;
}

/** The outbox rows of one event key for one subject, oldest first. */
async function eventsFor(eventKey: string, subjectId: string): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey, "subjectRef.id": subjectId })
    .sort({ _id: 1 })
    .toArray();
}

/**
 * Seed one still-pending invitation that has lived long enough to be reminded.
 *
 * `expiresAt` is in the future, so the row is not in the expiry sweep's `due`
 * set: the reminder is the only write this case can drive.
 *
 * @returns The invitation's id.
 */
async function seedStaleInvitation(): Promise<ObjectId> {
  const invitationId = new ObjectId();
  await app.db.collection(COLLECTIONS.invitations).insertOne({
    _id: invitationId,
    kind: "event_co_organizer",
    tenantId: new ObjectId().toHexString(),
    eventId: new ObjectId(),
    invitedByUserId: new ObjectId(),
    invitee: { kind: "user", userId: new ObjectId().toHexString() },
    status: "pending",
    role: "co_organizer",
    tokenHash: `op136-failure-window-${invitationId.toHexString()}`,
    channelsNotified: ["email"],
    expiresAt: new Date(NOW.getTime() + 4 * DAY_MS),
    expireAt: new Date(NOW.getTime() + 4 * DAY_MS),
    resolvedAt: null,
    resolvedVia: null,
    resolvedByUserId: null,
    revokedAt: null,
    revokedByUserId: null,
    revokeReason: null,
    reminderSentAt: null,
    createdAt: new Date(NOW.getTime() - 4 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 4 * DAY_MS),
    schemaVersion: 1,
  });
  return invitationId;
}

/**
 * Seed one published event whose window has already closed and whose end is an
 * hour past, so the run's only message is `event.ended`.
 *
 * `uploadWindowEndsAt` is `null`: a closed window would emit before the status
 * decision and eat the one-shot injection.
 *
 * @returns The event's id.
 */
async function seedEndedEvent(): Promise<ObjectId> {
  const eventId = new ObjectId();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id: eventId,
    tenantId: new ObjectId().toHexString(),
    name: `event-${eventId.toHexString()}`,
    status: "published",
    startAt: new Date(NOW.getTime() - 2 * DAY_MS),
    endAt: new Date(NOW.getTime() - HOUR_MS),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: null,
    retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    accessLinks: [],
    counters: { imageCount: 0, processedImageCount: 0, failedImageCount: 0 },
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  return eventId;
}

/** The driver's own `updateOne`, captured before any spy replaces it. */
const driverUpdateOne = ((): typeof Collection.prototype.updateOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#updateOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.updateOne;
})();

/** The driver's own `updateOne` argument tuple. */
type DriverUpdateOneArgs = Parameters<typeof driverUpdateOne>;

/** The driver's own `insertOne`, captured before any spy replaces it. */
const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#insertOne is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.insertOne;
})();

/** The driver's own `insertOne` argument tuple. */
type DriverInsertOneArgs = Parameters<typeof driverInsertOne>;

/** A one-shot driver-write failure, and how to take it back. */
interface InjectedWriteFailure {
  /** How many times the injected failure actually fired — the pin is vacuous unless 1. */
  readonly fired: () => number;
  /** Remove the injection. Call it in the same case (a `finally` is best). */
  readonly restore: () => void;
}

/**
 * Arm one transient driver failure on the next `updateOne` of `collectionName`.
 *
 * The error carries `code: 91` (a replica-set election), never `11000`, so no
 * caller can mistake it for the dedupe collision the outbox relies on.
 *
 * @param collectionName - The collection whose write fails, matched on `this`.
 * @returns The injection, whose `fired` count proves it was reached.
 */
function failNextUpdateOne(collectionName: string): InjectedWriteFailure {
  let remaining = 1;
  let fired = 0;
  const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
    this: Collection,
    ...args: DriverUpdateOneArgs
  ) {
    if (this.collectionName === collectionName && remaining > 0) {
      remaining -= 1;
      fired += 1;
      return Promise.reject(
        Object.assign(new Error(`injected failure: updateOne on ${collectionName}`), { code: 91 })
      );
    }
    return driverUpdateOne.call(this, ...args);
  } as never);

  return {
    fired: () => fired,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * Arm one transient driver failure on the next `insertOne` of one event key.
 *
 * @param collectionName - The collection whose insert fails, matched on `this`.
 * @param eventKey - The `eventKey` of the document that must fail (narrowing the
 *   injection to one announcement of a run that may emit several).
 * @returns The injection, whose `fired` count proves it was reached.
 */
function failNextInsertOne(collectionName: string, eventKey: string): InjectedWriteFailure {
  let remaining = 1;
  let fired = 0;
  const spy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
    this: Collection,
    ...args: DriverInsertOneArgs
  ) {
    const doc = args[0] as { readonly eventKey?: unknown };
    if (this.collectionName === collectionName && doc.eventKey === eventKey && remaining > 0) {
      remaining -= 1;
      fired += 1;
      return Promise.reject(
        Object.assign(new Error(`injected failure: insertOne of ${eventKey}`), { code: 91 })
      );
    }
    return driverInsertOne.call(this, ...args);
  } as never);

  return {
    fired: () => fired,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** What one run told its caller, whether it returned or threw. */
interface RunReport {
  /** `scanned` from the §10.2 result (0 when the run threw before it could answer). */
  readonly scanned: number;
  /** `errors` from the §10.2 result (0 when the run threw). */
  readonly errors: number;
  /** True when the run surfaced the failure, by a throw or by a non-zero `errors`. */
  readonly reported: boolean;
}

/**
 * Run a job and record what it reported.
 *
 * A sweep that swallows the per-record failure into `errors` and one that lets
 * it escape are both acceptable: the pin is that the failure is *reported*, not
 * that it takes a particular shape.
 *
 * @param run - The job invocation.
 * @returns What the caller learned, plus whether the failure was surfaced.
 */
async function runReporting(
  run: () => Promise<{ readonly scanned: number; readonly errors: number }>
): Promise<RunReport> {
  try {
    const result = await run();
    return { scanned: result.scanned, errors: result.errors, reported: result.errors >= 1 };
  } catch {
    // The job surfaced the failure by throwing; that is a report, not a silence.
    return { scanned: 0, errors: 0, reported: true };
  }
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-failure-windows" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      "user",
      "session",
      COLLECTIONS.userProfiles,
      COLLECTIONS.domainEvents,
      COLLECTIONS.invitations,
      COLLECTIONS.events,
      TOMBSTONES,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("when a sweep's step fails after its state change", () => {
  it("the account purge finishes the deletion on the next run after a failed tombstone write", async () => {
    // Arrange — one account inside its purge window, with a contact to retain.
    const userId = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const email = userEmail(userId);
    await seedProfile(userId, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
    });

    // ── Act: the daily run, with one injected tombstone-write failure ──
    const injection = failNextUpdateOne(TOMBSTONES);
    let first: RunReport;
    try {
      first = await runReporting(() =>
        accountDeletionPurgeJob.run({
          requestedLimit: null,
          clock: fixedClock(NOW),
          logger: recordingLogger(),
        })
      );
    } finally {
      injection.restore();
    }

    // ── Assert: the run reports the one account it could not finish ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.errors, "run 1 reports the account whose step failed").toBe(1);

    // ── Act: the next daily run, with the failure gone ──
    const retry = await accountDeletionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the deletion is finished, not lost ──
    const tombstones = await app.db
      .collection(TOMBSTONES)
      .find({ userId: userId.toHexString() })
      .toArray();
    const receipts = await eventsFor("account.deletion.completed", userId.toHexString());
    expect(
      { tombstones: tombstones.length, receipts: receipts.length },
      `run 2 must finish the deletion the failed tombstone write left unfinished (run 2 reported scanned: ${String(retry.scanned)}, errors: ${String(retry.errors)})`
    ).toMatchObject({ tombstones: 1, receipts: 1 });
    expect(tombstones[0]?.email, "the retained contact is the last known email").toBe(email);
    expect(Object.keys(receipts[0]?.payload as Record<string, unknown>).sort()).toEqual(["userId"]);
    expect(receipts[0]?.payload, "the receipt addresses the user and nothing else").toMatchObject({
      userId: userId.toHexString(),
    });
  });

  it("the verification nudge counter survives a failed increment, so the ladder still reaches t+72h", async () => {
    // Arrange — an account 80 h old: rung 1 was due at T+24h, rung 2 at T+72h.
    const userId = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 80 * HOUR_MS),
    });
    const profileId = await seedProfile(userId);
    const rungKey = (rung: string): string =>
      `account.verification.incomplete:${userId.toHexString()}:${rung}`;

    // ── Act: the hourly run, with one injected counter-increment failure ──
    const injection = failNextUpdateOne(COLLECTIONS.userProfiles);
    let first: RunReport;
    try {
      first = await runReporting(() =>
        verificationNudgeJob.run({
          requestedLimit: null,
          clock: fixedClock(NOW),
          logger: recordingLogger(),
        })
      );
    } finally {
      injection.restore();
    }

    // ── Assert: the run reports the failed increment ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.reported, "run 1 must report the failed increment").toBe(true);

    // ── Act: the next hourly tick ──
    await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(new Date(NOW.getTime() + HOUR_MS)),
      logger: recordingLogger(),
    });

    // ── Assert: the rung is delivered once and counted, not deduped into silence ──
    expect(await nudgeCount(profileId), "the T+24h rung must still advance the counter").toBe(1);
    expect(
      (await eventsFor("account.verification.incomplete", userId.toHexString())).map(
        (row) => row.dedupeKey
      ),
      "exactly one T+24h delivery, never two"
    ).toEqual([rungKey("t+24h")]);

    // ── Act: the run after that ──
    await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(new Date(NOW.getTime() + 2 * HOUR_MS)),
      logger: recordingLogger(),
    });

    // ── Assert: with the counter intact the ladder reaches its second rung ──
    expect(await nudgeCount(profileId), "the ladder must reach its second rung").toBe(2);
    expect(
      (await eventsFor("account.verification.incomplete", userId.toHexString())).map(
        (row) => row.dedupeKey
      ),
      "the T+72h rung must fire"
    ).toEqual([rungKey("t+24h"), rungKey("t+72h")]);
  });

  it("the invitation reminder survives a failed outbox write", async () => {
    // Arrange — a pending invitation inside its window, old enough to be reminded.
    const invitationId = await seedStaleInvitation();

    // ── Act: the hourly run, with one injected outbox-insert failure ──
    const injection = failNextInsertOne(COLLECTIONS.domainEvents, "collab.invite.reminder");
    let first: RunReport;
    try {
      first = await runReporting(() =>
        invitationExpiryJob.run({
          requestedLimit: null,
          clock: fixedClock(NOW),
          logger: recordingLogger(),
        })
      );
    } finally {
      injection.restore();
    }

    // ── Assert: the run reports the failed write ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.reported, "run 1 must report the failed outbox write").toBe(true);

    // ── Act: the next two hourly ticks ──
    await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(new Date(NOW.getTime() + HOUR_MS)),
      logger: recordingLogger(),
    });
    await invitationExpiryJob.run({
      requestedLimit: null,
      clock: fixedClock(new Date(NOW.getTime() + 2 * HOUR_MS)),
      logger: recordingLogger(),
    });

    // ── Assert: the reminder is delivered, and only once ──
    expect(
      await eventsFor("collab.invite.reminder", invitationId.toHexString()),
      "the reminder must survive the failed write and must not double"
    ).toHaveLength(1);
  });

  it("the ended announcement survives a failed outbox write", async () => {
    // Arrange — a published event whose end is an hour past.
    const eventId = await seedEndedEvent();

    // ── Act: the hourly run, with one injected `event.ended` write failure ──
    const injection = failNextInsertOne(COLLECTIONS.domainEvents, "event.ended");
    let first: RunReport;
    try {
      first = await runReporting(() =>
        eventWindowSweepJob.run({
          requestedLimit: null,
          clock: fixedClock(NOW),
          logger: recordingLogger(),
        })
      );
    } finally {
      injection.restore();
    }

    // ── Assert: the run reports the failed write ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.reported, "run 1 must report the failed outbox write").toBe(true);

    // ── Act: the next hourly tick ──
    await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(new Date(NOW.getTime() + HOUR_MS)),
      logger: recordingLogger(),
    });

    // ── Assert: the announcement is delivered, and only once ──
    expect(
      await eventsFor("event.ended", eventId.toHexString()),
      "the ended announcement must survive the failed write"
    ).toHaveLength(1);
    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect(row?.status, "the event is still ended").toBe("ended");
  });
});

/**
 * The stored post-purge state of one account, read in one place so each pin's
 * assertions stay about the step whose failure it injected.
 */
interface DeletionState {
  /** Tombstone rows keyed at the user — the only place the contact survives (§12). */
  readonly tombstones: number;
  /** The contact the tombstone retains. */
  readonly tombstoneEmail: unknown;
  /** `account.deletion.completed` rows for this user. */
  readonly receipts: number;
  /** The receipt's payload keys — the fan-out resolves the recipient itself. */
  readonly receiptKeys: string[];
  /** The receipt's payload. */
  readonly receiptPayload: Record<string, unknown>;
  /** The profile's lifecycle status. */
  readonly profileStatus: unknown;
  /** The Better Auth sessions still addressing this user. */
  readonly sessions: number;
  /** The Better Auth row's email, `null` when the purge anonymized it. */
  readonly accountEmail: unknown;
  /** The Better Auth row's name, `null` when the purge anonymized it. */
  readonly accountName: unknown;
}

/** The stored purge state of one account — the facts every post-claim pin asserts. */
async function deletionState(userId: ObjectId): Promise<DeletionState> {
  const tombstones = await app.db
    .collection(TOMBSTONES)
    .find({ userId: userId.toHexString() })
    .toArray();
  const receipts = await eventsFor("account.deletion.completed", userId.toHexString());
  const profile = await app.db.collection(COLLECTIONS.userProfiles).findOne({ userId });
  const account = await app.db.collection("user").findOne({ _id: userId });
  const sessions = await app.db
    .collection("session")
    .countDocuments({ userId: { $in: [userId.toHexString(), userId] } });

  return {
    tombstones: tombstones.length,
    tombstoneEmail: tombstones[0]?.email,
    receipts: receipts.length,
    receiptKeys: Object.keys(receipts[0]?.payload ?? {}).sort(),
    receiptPayload: (receipts[0]?.payload ?? {}) as Record<string, unknown>,
    profileStatus: profile?.status,
    sessions,
    accountEmail: account?.email ?? null,
    accountName: account?.name ?? null,
  };
}

/** The driver's own `deleteMany`, captured before any spy replaces it. */
const driverDeleteMany = ((): typeof Collection.prototype.deleteMany => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "deleteMany");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#deleteMany is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.deleteMany;
})();

/** The driver's own `deleteMany` argument tuple. */
type DriverDeleteManyArgs = Parameters<typeof driverDeleteMany>;

/**
 * Arm one transient driver failure on the next `deleteMany` of `collectionName`.
 *
 * The error carries `code: 91` (a replica-set election), never `11000`, so no
 * caller can mistake it for the dedupe collision the outbox relies on.
 *
 * @param collectionName - The collection whose delete fails, matched on `this`.
 * @returns The injection, whose `fired` count proves it was reached.
 */
function failNextDeleteMany(collectionName: string): InjectedWriteFailure {
  let remaining = 1;
  let fired = 0;
  const spy = vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(function (
    this: Collection,
    ...args: DriverDeleteManyArgs
  ) {
    if (this.collectionName === collectionName && remaining > 0) {
      remaining -= 1;
      fired += 1;
      return Promise.reject(
        Object.assign(new Error(`injected failure: deleteMany on ${collectionName}`), { code: 91 })
      );
    }
    return driverDeleteMany.call(this, ...args);
  } as never);

  return {
    fired: () => fired,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/** The driver's own `updateMany`, captured before any spy replaces it. */
const driverUpdateMany = ((): typeof Collection.prototype.updateMany => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateMany");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#updateMany is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.updateMany;
})();

/** The driver's own `updateMany` argument tuple. */
type DriverUpdateManyArgs = Parameters<typeof driverUpdateMany>;

/** The driver's own `findOneAndUpdate`, captured before any spy replaces it. */
const driverFindOneAndUpdate = ((): typeof Collection.prototype.findOneAndUpdate => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "findOneAndUpdate");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#findOneAndUpdate is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.findOneAndUpdate;
})();

/** The driver's own `findOneAndUpdate` argument tuple. */
type DriverFindOneAndUpdateArgs = Parameters<typeof driverFindOneAndUpdate>;

/**
 * Arm one transient driver failure on the next write that touches a single
 * document of `collectionName`, **whichever driver method carries it**:
 * `updateOne`, `updateMany` (identical to `updateOne` for a filter that names
 * one `_id`) or `findOneAndUpdate`.
 *
 * The method is not part of the behaviour a pin protects, and ADR-0857's
 * §Alternatives rejects prescribing the erase mechanism, so gating on one
 * method would redden a behaviour-preserving refactor (ADR-0858). The gate stays
 * the collection name — the narrowest honest one — and one call is armed across
 * the three methods, so `fired()` still proves the injection was reached
 * exactly once.
 *
 * The error carries `code: 91` (a replica-set election), never `11000`, so no
 * caller can mistake it for the dedupe collision the outbox relies on.
 *
 * @param collectionName - The collection whose write fails, matched on `this`.
 * @returns The injection, whose `fired` count proves it was reached.
 */
function failNextDocumentUpdate(collectionName: string): InjectedWriteFailure {
  let remaining = 1;
  let fired = 0;

  const inject = (method: string): Promise<never> => {
    remaining -= 1;
    fired += 1;
    return Promise.reject(
      Object.assign(new Error(`injected failure: ${method} on ${collectionName}`), { code: 91 })
    );
  };

  const updateOne = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
    this: Collection,
    ...args: DriverUpdateOneArgs
  ) {
    if (this.collectionName === collectionName && remaining > 0) {
      return inject("updateOne");
    }
    return driverUpdateOne.call(this, ...args);
  } as never);

  const updateMany = vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
    this: Collection,
    ...args: DriverUpdateManyArgs
  ) {
    if (this.collectionName === collectionName && remaining > 0) {
      return inject("updateMany");
    }
    return driverUpdateMany.call(this, ...args);
  } as never);

  const findOneAndUpdate = vi
    .spyOn(Collection.prototype, "findOneAndUpdate")
    .mockImplementation(function (this: Collection, ...args: DriverFindOneAndUpdateArgs) {
      if (this.collectionName === collectionName && remaining > 0) {
        return inject("findOneAndUpdate");
      }
      return driverFindOneAndUpdate.call(this, ...args);
    } as never);

  return {
    fired: () => fired,
    restore: () => {
      updateOne.mockRestore();
      updateMany.mockRestore();
      findOneAndUpdate.mockRestore();
    },
  };
}

/** Seed one Better Auth session row for a user. */
async function seedSession(userId: ObjectId): Promise<void> {
  await app.db.collection("session").insertOne({
    _id: new ObjectId(),
    userId: userId.toHexString(),
    token: `session-${userId.toHexString()}`,
    createdAt: new Date(NOW.getTime() - DAY_MS),
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
}

/** The instant one purge run is timed at — every run in these pins shares it. */
function purgeRun(): Promise<{ readonly scanned: number; readonly errors: number }> {
  return accountDeletionPurgeJob.run({
    requestedLimit: null,
    clock: fixedClock(NOW),
    logger: recordingLogger(),
  });
}

/**
 * Integration / contract — the account purge's **remaining** post-claim failure
 * windows (OP-136 follow-up, finding **F3a**; contract §10.2, §1.4, §12;
 * ADR-0857).
 *
 * The user story: *as the platform I want any failed step of a delete I have
 * already claimed to be recoverable, so no single transient write failure can
 * leave an account `deleted` with no receipt and a live session.*
 *
 * The tombstone window is pinned above (ADR-0853). These pins cover the other
 * three steps the purge performs after it claims the account, one injected
 * failure each — the session `deleteMany`, the `account.deletion.completed`
 * receipt, and the contact anonymize — and each one then requires the *next*
 * run to finish the deletion: one tombstone holding the last known email, one
 * receipt whose `payload` is `{ userId }` only, and a `deleted` profile.
 *
 * The mechanism is deliberately unpinned: one transaction, a resumable
 * intermediate state or an emit-first order all satisfy them. A near-fix that
 * only passes the tombstone pin fails the session-delete pin.
 */
describe("when a purge step fails after the account is claimed", () => {
  it("the session is revoked by the next run after a failed session delete", async () => {
    // Arrange — one account inside its purge window, with a session to revoke.
    const userId = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const email = userEmail(userId);
    await seedProfile(userId, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
    });
    await seedSession(userId);

    // ── Act: the daily run, with one injected session-delete failure ──
    const injection = failNextDeleteMany("session");
    let first: RunReport;
    try {
      first = await runReporting(purgeRun);
    } finally {
      injection.restore();
    }

    // ── Assert: the injection was reached and the run reported it ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.errors, "run 1 reports the account whose session delete failed").toBe(1);

    // ── Act: the next daily run, with the failure gone ──
    const retry = await purgeRun();

    // ── Assert: the deletion is finished, sessions included, not lost ──
    const state = await deletionState(userId);
    expect(
      {
        tombstones: state.tombstones,
        receipts: state.receipts,
        sessions: state.sessions,
      },
      `run 2 must finish the deletion the failed session delete left unfinished (run 2 reported scanned: ${String(retry.scanned)}, errors: ${String(retry.errors)})`
    ).toMatchObject({ tombstones: 1, receipts: 1, sessions: 0 });
    expect(state.tombstoneEmail, "the retained contact is the last known email").toBe(email);
    expect(state.receiptKeys).toEqual(["userId"]);
    expect(state.receiptPayload, "the receipt addresses the user and nothing else").toMatchObject({
      userId: userId.toHexString(),
    });
    expect(state.profileStatus, "the profile is deleted once run 2 finishes").toBe("deleted");
  });

  it("the receipt is emitted by the next run after a failed receipt write", async () => {
    // Arrange — one account inside its purge window, with a contact to retain.
    const userId = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const email = userEmail(userId);
    await seedProfile(userId, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
    });
    await seedSession(userId);

    // ── Act: the daily run, with one injected receipt-insert failure ──
    const injection = failNextInsertOne(COLLECTIONS.domainEvents, "account.deletion.completed");
    let first: RunReport;
    try {
      first = await runReporting(purgeRun);
    } finally {
      injection.restore();
    }

    // ── Assert: the injection was reached and the run reported it ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.errors, "run 1 reports the account whose receipt write failed").toBe(1);

    // ── Act: the next daily run, with the failure gone ──
    const retry = await purgeRun();

    // ── Assert: the receipt exists once, and the deletion it announces is done ──
    const state = await deletionState(userId);
    expect(
      { tombstones: state.tombstones, receipts: state.receipts },
      `run 2 must emit the receipt the failed write lost (run 2 reported scanned: ${String(retry.scanned)}, errors: ${String(retry.errors)})`
    ).toMatchObject({ tombstones: 1, receipts: 1 });
    expect(state.tombstoneEmail, "the retained contact is the last known email").toBe(email);
    expect(state.receiptKeys, "the receipt addresses the user and nothing else").toEqual([
      "userId",
    ]);
    expect(state.receiptPayload).toMatchObject({ userId: userId.toHexString() });
    expect(state.profileStatus, "the profile is deleted once run 2 finishes").toBe("deleted");
  });

  it("the account is anonymized by the next run after a failed anonymize write", async () => {
    // Arrange — one account inside its purge window, with a contact to retain.
    const userId = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const email = userEmail(userId);
    await seedProfile(userId, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
    });
    await seedSession(userId);

    // ── Act: the daily run, with one injected anonymize failure ──
    // The erase is one write to the `user` collection; which driver method
    // carries it (`updateOne`, `updateMany`, `findOneAndUpdate`) is not part of
    // the behaviour this pin protects, so the injection takes any of the three.
    const injection = failNextDocumentUpdate("user");
    let first: RunReport;
    try {
      first = await runReporting(purgeRun);
    } finally {
      injection.restore();
    }

    // ── Assert: the injection was reached and the run reported it ──
    expect(injection.fired(), "the injection must fire exactly once").toBe(1);
    expect(first.errors, "run 1 reports the account whose anonymize write failed").toBe(1);

    // ── Act: the next daily run, with the failure gone ──
    const retry = await purgeRun();

    // ── Assert: the contact is revoked from the account and kept in the tombstone ──
    const state = await deletionState(userId);
    expect(
      { tombstones: state.tombstones, receipts: state.receipts },
      `run 2 must finish the anonymize the failed write left undone (run 2 reported scanned: ${String(retry.scanned)}, errors: ${String(retry.errors)})`
    ).toMatchObject({ tombstones: 1, receipts: 1 });
    expect(state.accountEmail, "the account keeps no contact of its own").toBeNull();
    expect(state.accountName, "the account keeps no display name of its own").toBeNull();
    expect(
      state.tombstoneEmail,
      "the last known email survives only because the contact was read before the erase"
    ).toBe(email);
    expect(state.receiptKeys).toEqual(["userId"]);
    expect(state.receiptPayload, "the receipt addresses the user and nothing else").toMatchObject({
      userId: userId.toHexString(),
    });
    expect(state.profileStatus, "the profile is deleted once run 2 finishes").toBe("deleted");
  });
});
