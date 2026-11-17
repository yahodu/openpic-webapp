import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { accountDeletionPurgeJob } from "@/server/jobs/account-deletion-purge";
import { verificationNudgeJob } from "@/server/jobs/verification-nudge";
import { fixedClock } from "@/server/runtime/clock";

import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `verification-nudge` and `account-deletion-purge`
 * (OP-136, contract §10.2, §1.4; notification §4.2; schema §13.2; ADR-0849).
 *
 * The user story: *as the platform I want a bounded nudge ladder and a
 * deletion that fires only on the scheduled instant, so an incomplete account
 * is reminded at most twice and a cancellation window is never cut short.*
 *
 * ## The contract this file pins
 *
 * `@/server/jobs/verification-nudge` exports `verificationNudgeJob`:
 *
 * - the candidates are Better Auth `user` rows that are not verified
 *   (`emailVerified !== true`), created at least 24 h ago;
 * - the ladder is the pure `verificationNudgePoint`: T+24h then T+72h, **max
 *   2 ever**, and an account that is complete (verified, or a
 *   `userProfiles.accountCompletedAt` stamp) is never nudged;
 * - the count is `userProfiles.verificationNudges` (a number) and it is
 *   incremented in the same run that emits `account.verification.incomplete`;
 * - each rung's delivery is keyed `` `account.verification.incomplete:<userId>:t+24h` ``
 *   (or `:t+72h`), so a repeat run cannot double-deliver;
 * - `details.nudged` counts the deliveries of a run.
 *
 * `@/server/jobs/account-deletion-purge` exports `accountDeletionPurgeJob`:
 *
 * - the candidate predicate is exactly `userProfiles.status: "deletion_pending"`
 *   **and** `deletionScheduledAt <= now` — a future-scheduled profile is
 *   untouched, which is the cancellation window;
 * - the purge stamps `purgeStartedAt`, marks the profile `deleted`, anonymizes
 *   the account — the Better Auth `user` row loses its `email` and `name`, and
 *   the profile's `displayName` / `avatarAssetId` are cleared — revokes the
 *   user's sessions, retains the last known contact in the
 *   `accountDeletionTombstones` platform collection (the only place the email
 *   survives) and emits one `account.deletion.completed` whose payload carries
 *   `{ userId }` and nothing else;
 * - `details.purged` counts the accounts.
 */

const DAY_MS = 86_400_000;

/** The instant every run in this file is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

/** The platform collection the deleted account's contact is retained in. */
const TOMBSTONES = "accountDeletionTombstones";

let app: TestApp;

/** The email `seedUser` stores for one user id. */
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

/**
 * The collections of the test database that hold `value` in any document.
 *
 * @param value - The string to look for (an email, in this file).
 * @returns The collection names that hold at least one copy, sorted.
 */
async function collectionsHolding(value: string): Promise<string[]> {
  const collections = await app.db.listCollections().toArray();
  const holdings: string[] = [];
  for (const { name } of collections) {
    const rows = await app.db.collection(name).find({}).toArray();
    if (rows.some((row) => JSON.stringify(row).includes(value))) {
      holdings.push(name);
    }
  }
  return holdings.sort();
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

/** The outbox rows of one event key for one subject. */
async function eventsFor(eventKey: string, subjectId: string): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey, "subjectRef.id": subjectId })
    .toArray();
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-account-lifecycle" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    ["user", "session", COLLECTIONS.userProfiles, COLLECTIONS.domainEvents, TOMBSTONES].map(
      (name) => app.db.collection(name).deleteMany({})
    )
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("verification-nudge", () => {
  it("I8: nudges at T+24h, stops at the cap of 2, and stops once the account is complete", async () => {
    // Three incomplete accounts at different ages and one complete account.
    const fresh = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    const freshProfile = await seedProfile(fresh);

    const halfWay = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 80 * 3_600_000),
    });
    const halfWayProfile = await seedProfile(halfWay, { verificationNudges: 1 });

    const capped = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    const cappedProfile = await seedProfile(capped, { verificationNudges: 2 });

    const verified = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    const verifiedProfile = await seedProfile(verified);

    const completed = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    });
    const completedProfile = await seedProfile(completed, {
      accountCompletedAt: new Date(NOW.getTime() - 29 * DAY_MS),
    });

    // ── Act ──
    const result = await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: exactly the two eligible rungs were delivered ──
    expect(result.details?.nudged).toBe(2);

    const first = await eventsFor("account.verification.incomplete", fresh.toHexString());
    expect(first).toHaveLength(1);
    expect(first[0]?.dedupeKey).toBe(
      `account.verification.incomplete:${fresh.toHexString()}:t+24h`
    );
    expect(await nudgeCount(freshProfile)).toBe(1);

    const second = await eventsFor("account.verification.incomplete", halfWay.toHexString());
    expect(second).toHaveLength(1);
    expect(second[0]?.dedupeKey).toBe(
      `account.verification.incomplete:${halfWay.toHexString()}:t+72h`
    );
    expect(await nudgeCount(halfWayProfile)).toBe(2);

    // ── Assert: the cap and the completion guard ──
    expect(await eventsFor("account.verification.incomplete", capped.toHexString())).toHaveLength(
      0
    );
    expect(await nudgeCount(cappedProfile)).toBe(2);
    expect(await eventsFor("account.verification.incomplete", verified.toHexString())).toHaveLength(
      0
    );
    expect(await nudgeCount(verifiedProfile)).toBe(0);
    expect(
      await eventsFor("account.verification.incomplete", completed.toHexString())
    ).toHaveLength(0);
    expect(await nudgeCount(completedProfile)).toBe(0);

    // ── Act: the next hourly tick ──
    const again = await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: nothing is delivered twice ──
    expect(again.details?.nudged).toBe(0);
    expect(await eventsFor("account.verification.incomplete", fresh.toHexString())).toHaveLength(1);
    expect(await nudgeCount(freshProfile)).toBe(1);
  });

  it("leaves an account younger than 24 hours alone", async () => {
    const userId = await seedUser({
      emailVerified: false,
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    const profileId = await seedProfile(userId);

    const result = await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect(result.details?.nudged).toBe(0);
    expect(await nudgeCount(profileId)).toBe(0);
  });
});

describe("account-deletion-purge", () => {
  it("I9: purges only the account whose deletionScheduledAt has passed", async () => {
    const dueUser = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const dueProfile = await seedProfile(dueUser, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
    });
    const dueEmail = `user-${dueUser.toHexString()}@example.com`;
    await app.db.collection("session").insertOne({
      _id: new ObjectId(),
      userId: dueUser.toHexString(),
      token: `session-${dueUser.toHexString()}`,
      createdAt: new Date(NOW.getTime() - DAY_MS),
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });

    const waitingUser = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const waitingProfile = await seedProfile(waitingUser, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() + DAY_MS),
    });

    // ── Act ──
    const result = await accountDeletionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the due account is purged and its sessions are gone ──
    const purged = await app.db.collection(COLLECTIONS.userProfiles).findOne({ _id: dueProfile });
    expect(purged?.status).toBe("deleted");
    expect(purged?.purgeStartedAt).toBeInstanceOf(Date);
    expect(
      await app.db.collection("session").countDocuments({ userId: dueUser.toHexString() })
    ).toBe(0);
    expect(
      await app.db.collection(TOMBSTONES).countDocuments({ userId: dueUser.toHexString() })
    ).toBe(1);
    const tombstone = await app.db
      .collection(TOMBSTONES)
      .findOne({ userId: dueUser.toHexString() });
    expect(tombstone?.email).toBe(dueEmail);

    // ── Assert: one receipt addressed at the user and nothing else ──
    const receipts = await eventsFor("account.deletion.completed", dueUser.toHexString());
    expect(receipts).toHaveLength(1);
    expect(Object.keys(receipts[0]?.payload as Record<string, unknown>).sort()).toEqual(["userId"]);
    expect(result.details?.purged).toBe(1);

    // ── Assert: the cancellation window is untouched ──
    const waiting = await app.db
      .collection(COLLECTIONS.userProfiles)
      .findOne({ _id: waitingProfile });
    expect(waiting?.status).toBe("deletion_pending");
    expect(waiting?.purgeStartedAt ?? null).toBeNull();
    expect(await eventsFor("account.deletion.completed", waitingUser.toHexString())).toHaveLength(
      0
    );

    // ── Act: a second run ──
    const again = await accountDeletionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: idempotent — one receipt, no second tally ──
    expect(again.details?.purged).toBe(0);
    expect(await eventsFor("account.deletion.completed", dueUser.toHexString())).toHaveLength(1);
  });

  it("anonymizes the account, leaving the tombstone as the only copy of the email", async () => {
    const userId = await seedUser({
      emailVerified: true,
      createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });
    const email = userEmail(userId);
    const profileId = await seedProfile(userId, {
      status: "deletion_pending",
      deletionScheduledAt: new Date(NOW.getTime() - DAY_MS),
      displayName: "Due Person",
      avatarAssetId: new ObjectId(),
    });

    // ── Act ──
    await accountDeletionPurgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: no copy of the contact survives outside the tombstone ──
    expect(await collectionsHolding(email)).toEqual([TOMBSTONES]);

    const user = await app.db.collection("user").findOne({ _id: userId });
    expect(user?.email ?? null).not.toBe(email);
    expect(user?.name ?? null).toBeNull();

    const profile = await app.db.collection(COLLECTIONS.userProfiles).findOne({ _id: profileId });
    expect(profile?.displayName ?? null).toBeNull();
    expect(profile?.avatarAssetId ?? null).toBeNull();

    const tombstone = await app.db.collection(TOMBSTONES).findOne({ userId: userId.toHexString() });
    expect(tombstone?.email).toBe(email);
  });
});
