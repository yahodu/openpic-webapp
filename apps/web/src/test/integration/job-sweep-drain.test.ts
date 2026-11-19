import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { attendeeNoMatchCheckJob } from "@/server/jobs/attendee-no-match-check";
import type { CronResult } from "@/server/jobs/cron-job";
import { uploadSessionSweepJob } from "@/server/jobs/upload-session-sweep";
import { verificationNudgeJob } from "@/server/jobs/verification-nudge";
import { fixedClock } from "@/server/runtime/clock";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — the drain of the three emit-only sweeps (OP-136
 * follow-up; contract §10.2 `attendee-no-match-check`, `upload-session-sweep`
 * and `verification-nudge`, §6.4, §5.5, §1.4; schema §15.3, §16.2; ADR-0879,
 * the OP-136 jobs lane's RED record for this change).
 *
 * The user story: *as the platform I want a sweep's window to move as it
 * announces, so a row it has already told someone about never keeps the scan
 * slot that a row it has never examined needs.*
 *
 * ## What is pinned here
 *
 * Each of these three jobs is documented as a sweep, but its candidate query is
 * a page of a class whose rows only leave by another actor. A row that is never
 * resolved therefore keeps its slot for as long as it lives — for ever on
 * `attendee_event_profiles` (no TTL, no purge for an event with
 * `retentionExpiresAt: null`) and on Better Auth's `user` table (never reaped),
 * and up to five days on `upload_sessions` (`upload_sessions_expire_at_ttl`) —
 * so every row ordered past the first page is never examined at all, while the
 * run reports a backlog it can never drain. These pins assert only that the
 * window **moves**:
 *
 * 1. `attendee-no-match-check` — three ready profiles whose finished match run
 *    found nothing, examined two at a time, are all announced (and each exactly
 *    once) within two runs (`S1`); a profile whose match inputs move re-enters
 *    the window, is still announced only once because its dedupe key is the
 *    profile, and gives its slot back (`S2`).
 * 2. `upload-session-sweep` — three stalled sessions, examined two at a time,
 *    are all announced within two runs, and a session that resumes and then
 *    stalls again is never announced twice and keeps no slot (`S3`).
 * 3. `verification-nudge` — the clock window is what gives a page slot back: a
 *    row past the window is not a candidate at all, so the two eligible
 *    accounts behind it are nudged in one page (`S4`). A row inside the window
 *    that has no rung left still spends its slot, and that is the lane's
 *    **bounded** residual, pinned executably by `S6`. The window's edges are the
 *    ladder's own: a 20-hour account is too young, a 30-hour one is due its
 *    first rung, an 80-hour one its last, and an account past the whole ladder
 *    is not a candidate at all (`S5`, which states the lane's accepted residual
 *    — such a row is left un-nudged rather than nudged late).
 *
 * ## One correction to the card, measured not assumed
 *
 * The card predicted `S4` as "run 2 must reach the third eligible account" from
 * three accounts at 30/40/50 hours with a page of two. The decided shape for
 * this job is a **clock** window, so a row that was nudged at `t+24h` stays
 * inside the window (and keeps its slot) until its age passes the upper bound,
 * and a page of two over 30/40/50 h re-reads 30/40 h on the second run: the
 * third account is reached when the first two age out, not on the next run. A
 * near-fix probe of the decided shape measured exactly that (`run 1 nudged 2,
 * run 2 nudged 0`), so `S4` is pinned on what the shape actually changes and
 * what the defect actually is: the ladder-exhausted row never leaves the class,
 * where a live row leaves by the clock. Widening the pin into an unbounded
 * drain would have been a pin no correct implementation of the decision could
 * satisfy.
 *
 * The guarantee is therefore *not* "an exhausted ladder never spends a slot":
 * `S4`'s 120-hour row is spared by its **age** (it is past the clock window), not
 * by its exhausted ladder. Put the same exhausted row inside the window and it
 * is examined, so it does cost a page slot and the eligible account behind it
 * waits for a later run. That residual is bounded — a row can keep a slot only
 * while it is inside the window, so the drain still terminates — and `S6` pins
 * it executably.
 *
 * ## What is *not* prescribed
 *
 * ADR-0879 §2 decides the shape — a deterministic page plus one
 * disposition per job. These pins do not re-decide it and do not encode it: no
 * marker field, no window bound, no sort key and no cursor is named here, so a
 * different field name, a tighter upper bound inside the stated margins or an
 * ordered cursor satisfies every case. The only observables asserted are the
 * outbox rows (event key, subject, count and `payload`) and the `details`
 * counters the jobs already publish (`noneFound`, `stalled`, `nudged`) — never
 * `scanned` or `hasMore`, which a draining window and a starved one report
 * identically (`hasMore: scanned >= limit` is true of both).
 *
 * Every seed order is fixed: the row a case turns on is inserted **first**, so
 * the page a run examines is a deterministic prefix of the class — and, on the
 * two jobs that latch on the row, a run that re-examines that prefix announces
 * nothing.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The instant every run in this file is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

/** The page size every draining case runs with — smaller than its population. */
const PAGE = 2;

/** The outbox key of the empty-gallery notice. */
const NONE_FOUND = "attendee.matches.none_found";

/** The outbox key of the stalled-upload notice. */
const STALLED = "upload.session.stalled";

/** The outbox key of the verification nudge. */
const NUDGE = "account.verification.incomplete";

let app: TestApp;

/** The fields a case sets on one `attendeeEventProfiles` row (§15.3). */
interface ProfileSeed {
  /** The instant the profile's last match run finished. */
  readonly lastMatchRunAt: Date;
  /** The matches that run found. */
  readonly matchCount?: number;
}

/**
 * Seed one `ready` attendee profile whose match run has finished.
 *
 * Ladder-independent fields are the §15.3 defaults: an anonymous subject, no
 * claimed selfie (`activeSelfieId: null`, so `pipeline-sweep` can never claim
 * the row) and a creation instant well before the run.
 *
 * @param seed - The match-run instant and (optionally) the match count.
 * @returns The profile id.
 */
async function seedProfile(seed: ProfileSeed): Promise<ObjectId> {
  const profileId = new ObjectId();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id: profileId,
    tenantId: new ObjectId().toHexString(),
    eventId: new ObjectId(),
    subject: { kind: "anonymous", attendeeSessionId: new ObjectId().toHexString() },
    status: "ready",
    activeSelfieId: null,
    matchCount: seed.matchCount ?? 0,
    lastMatchRunAt: seed.lastMatchRunAt,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  return profileId;
}

/**
 * Seed one `in_progress` multipart session last touched at `updatedAt` (§16.2).
 *
 * @param updatedAt - The instant the client last touched the session.
 * @returns The session id.
 */
async function seedSession(updatedAt: Date): Promise<ObjectId> {
  const sessionId = new ObjectId();
  await app.db.collection(COLLECTIONS.uploadSessions).insertOne({
    _id: sessionId,
    tenantId: new ObjectId().toHexString(),
    eventId: new ObjectId(),
    status: "in_progress",
    declaredSize: 4_194_304,
    externalRefs: [
      { kind: "multipart_upload", uploadId: `upload-${sessionId.toHexString()}`, partCount: 0 },
    ],
    createdAt: new Date(updatedAt.getTime() - DAY_MS),
    updatedAt,
    // Inside the §16.2 five-day window, so the TTL monitor cannot race a case.
    expireAt: new Date(NOW.getTime() + 4 * DAY_MS),
  });
  return sessionId;
}

/** The fields a case sets on one Better Auth account and its profile. */
interface AccountSeed {
  /** The account's creation instant — the ladder's only clock. */
  readonly createdAt: Date;
  /** The rungs already delivered, as `userProfiles.verificationNudges` holds them. */
  readonly nudgesSent: number;
}

/**
 * Seed one unverified Better Auth account plus the `userProfiles` row the
 * ladder is counted on (§1.4, §15.3).
 *
 * @param seed - The creation instant and the rungs already delivered.
 * @returns The account's user id (also the outbox subject id).
 */
async function seedAccount(seed: AccountSeed): Promise<ObjectId> {
  const userId = new ObjectId();
  await app.db.collection("user").insertOne({
    _id: userId,
    email: `user-${userId.toHexString()}@example.com`,
    emailVerified: false,
    name: `user-${userId.toHexString()}`,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
  });
  await app.db.collection(COLLECTIONS.userProfiles).insertOne({
    _id: new ObjectId(),
    userId,
    status: "active",
    primaryTenantId: new ObjectId().toHexString(),
    accountCompletedAt: null,
    verificationNudges: seed.nudgesSent,
    createdAt: seed.createdAt,
  });
  return userId;
}

/**
 * The outbox rows one event key holds for one subject, oldest first.
 *
 * @param eventKey - The §7.7 event key the job emits.
 * @param subjectId - The subject the job addresses (`subjectRef.id`).
 * @returns The stored rows.
 */
async function outboxRows(eventKey: string, subjectId: string): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey, "subjectRef.id": subjectId })
    .sort({ _id: 1 })
    .toArray();
}

/**
 * How many outbox rows of one event key each labelled subject holds.
 *
 * A map rather than a count so a failure names the subject that is wrong, and
 * so "one per subject" is asserted in one strict comparison.
 *
 * @param eventKey - The §7.7 event key the job emits.
 * @param subjects - The subjects to count, keyed by the label the case uses.
 * @returns One count per label, in the order given.
 */
async function outboxCounts(
  eventKey: string,
  subjects: Record<string, ObjectId>
): Promise<Record<string, number>> {
  const counts = await Promise.all(
    Object.entries(subjects).map(
      async ([label, id]) => [label, (await outboxRows(eventKey, id.toHexString())).length] as const
    )
  );
  return Object.fromEntries(counts);
}

/**
 * One counter a run published in its §10.2 `details`.
 *
 * `undefined` when the run did not publish that key, so a missing counter reads
 * as `expected undefined to be 1` in the failure instead of a silent zero.
 *
 * @param run - The §10.2 result envelope the job returned.
 * @param key - The counter's name (`noneFound`, `stalled`, `nudged`).
 * @returns The published value, or `undefined`.
 */
function detail(run: CronResult, key: string): unknown {
  return run.details === undefined ? undefined : run.details[key];
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-sweep-drain" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      "user",
      COLLECTIONS.userProfiles,
      COLLECTIONS.domainEvents,
      COLLECTIONS.attendeeEventProfiles,
      COLLECTIONS.uploadSessions,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("when the empty-gallery notice has more candidates than one run may examine", () => {
  it("the next run reaches the profile the first run left behind, so the window drains", async () => {
    // Arrange — three profiles whose finished match run found nothing, in a
    // fixed order: the page a starving run re-reads is a fixed prefix of them.
    const profiles = {
      first: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 3 * HOUR_MS) }),
      second: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 2 * HOUR_MS) }),
      third: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 1 * HOUR_MS) }),
    };

    // ── Act: two hourly runs, each bounded to two candidates ──
    const firstRun = await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const secondRun = await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the first page is full, and the second run finishes the class ──
    expect(detail(firstRun, "noneFound"), "run 1 announces the two profiles in its page").toBe(2);
    expect(
      detail(secondRun, "noneFound"),
      "run 2 must reach the profile its first page left behind: no seeded row changed, so a re-examined prefix announces nothing"
    ).toBe(1);
    expect(
      await outboxCounts(NONE_FOUND, profiles),
      "every profile past the empty gallery is announced exactly once"
    ).toEqual({ first: 1, second: 1, third: 1 });
  });

  it("a profile whose match inputs move re-enters the window without a second notice and without wedging the page", async () => {
    // Arrange — three candidates, and a page that covers only the first two.
    const profiles = {
      first: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 3 * HOUR_MS) }),
      second: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 2 * HOUR_MS) }),
      third: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 1 * HOUR_MS) }),
    };
    await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Act: a later match run advances the first profile's watermark ──
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne(
        { _id: profiles.first },
        { $set: { lastMatchRunAt: new Date(NOW.getTime() - 30 * 60_000) } }
      );
    const secondRun = await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: re-opened, still announced once, and the page moved past it ──
    expect(
      detail(secondRun, "noneFound"),
      "run 2 must reach the third profile: the re-opened one shares the page but its notice is deduped"
    ).toBe(1);
    expect(
      await outboxCounts(NONE_FOUND, profiles),
      "a re-opened profile is announced exactly once — its dedupe key is the profile, not the run"
    ).toEqual({ first: 1, second: 1, third: 1 });

    const thirdRun = await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    expect(detail(thirdRun, "noneFound"), "a run over a drained window announces nothing").toBe(0);

    // Arrange — two new candidates arrive behind the re-opened profile.
    const later = {
      fourth: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 55 * 60_000) }),
      fifth: await seedProfile({ lastMatchRunAt: new Date(NOW.getTime() - 45 * 60_000) }),
    };
    const fourthRun = await attendeeNoMatchCheckJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the re-opened profile keeps no slot of its own ──
    expect(
      detail(fourthRun, "noneFound"),
      "the re-opened profile gives its scan slot back: both later profiles are reached in one page"
    ).toBe(2);
    expect(await outboxCounts(NONE_FOUND, later), "each later profile is announced once").toEqual({
      fourth: 1,
      fifth: 1,
    });
  });
});

describe("when the stalled-upload notice has more candidates than one run may examine", () => {
  it("the next run reaches the session the first run left behind, and a re-stalled session never re-takes a slot", async () => {
    // Arrange — three sessions idle past the one-day threshold, in a fixed order.
    const sessions = {
      first: await seedSession(new Date(NOW.getTime() - 4 * DAY_MS)),
      second: await seedSession(new Date(NOW.getTime() - 3 * DAY_MS)),
      third: await seedSession(new Date(NOW.getTime() - 2 * DAY_MS)),
    };

    // ── Act: two hourly runs, each bounded to two candidates ──
    const firstRun = await uploadSessionSweepJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const secondRun = await uploadSessionSweepJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the first page is full, and the second run finishes the class ──
    expect(detail(firstRun, "stalled"), "run 1 announces the two sessions in its page").toBe(2);
    expect(
      detail(secondRun, "stalled"),
      "run 2 must reach the session its first page left behind: no seeded row changed, so a re-examined prefix announces nothing"
    ).toBe(1);
    expect(
      await outboxCounts(STALLED, sessions),
      "every stalled session is announced exactly once — the key is the session, not the run"
    ).toEqual({ first: 1, second: 1, third: 1 });

    // ── Act: the first session resumes, and then stalls again ──
    await app.db
      .collection(COLLECTIONS.uploadSessions)
      .updateOne(
        { _id: sessions.first },
        { $set: { updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS) } }
      );
    const resumedRun = await uploadSessionSweepJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    await app.db
      .collection(COLLECTIONS.uploadSessions)
      .updateOne(
        { _id: sessions.first },
        { $set: { updatedAt: new Date(NOW.getTime() - 2 * DAY_MS) } }
      );
    const restalledRun = await uploadSessionSweepJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: a touched session is not stalled, and a re-stall is silent ──
    expect(detail(resumedRun, "stalled"), "a session the client is touching is not stalled").toBe(
      0
    );
    expect(
      detail(restalledRun, "stalled"),
      "a session that stalls again is not announced a second time"
    ).toBe(0);

    // Arrange — two fresh stalled sessions arrive behind the re-stalled one.
    const later = {
      fourth: await seedSession(new Date(NOW.getTime() - 3 * DAY_MS)),
      fifth: await seedSession(new Date(NOW.getTime() - 2 * DAY_MS)),
    };
    const fourthRun = await uploadSessionSweepJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the re-stalled session keeps no slot of its own ──
    expect(
      detail(fourthRun, "stalled"),
      "the re-stalled session gives its scan slot back: both fresh sessions are reached in one page"
    ).toBe(2);
    expect(await outboxCounts(STALLED, later), "each fresh session is announced once").toEqual({
      fourth: 1,
      fifth: 1,
    });
  });
});

describe("when the verification ladder has more candidates than one run may examine", () => {
  it("a row past the clock window gives its page slot back, so the accounts behind it are reached", async () => {
    // Arrange — the exhausted account is inserted FIRST. Both rungs were sent
    // long ago, so it has no rung left; at 120 hours it is also past the clock
    // window, so it is spared the page by its age, not by its exhausted ladder.
    const accounts = {
      exhausted: await seedAccount({
        createdAt: new Date(NOW.getTime() - 120 * HOUR_MS),
        nudgesSent: 2,
      }),
      thirty: await seedAccount({
        createdAt: new Date(NOW.getTime() - 30 * HOUR_MS),
        nudgesSent: 0,
      }),
      forty: await seedAccount({
        createdAt: new Date(NOW.getTime() - 40 * HOUR_MS),
        nudgesSent: 0,
      }),
      fifty: await seedAccount({
        createdAt: new Date(NOW.getTime() - 50 * HOUR_MS),
        nudgesSent: 0,
      }),
    };

    // ── Act: one hourly run, bounded to two candidates ──
    const run = await verificationNudgeJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the page carries two eligible accounts, not the aged-out one ──
    expect(
      detail(run, "nudged"),
      "the page is two candidates: a row past the clock window takes no slot, so two eligible accounts fit"
    ).toBe(2);
    expect(
      await outboxCounts(NUDGE, accounts),
      "the two accounts due their first rung are nudged and the page stops at its size; the exhausted 120-hour row is past the clock window, so it is not a candidate at all"
    ).toEqual({ exhausted: 0, thirty: 1, forty: 1, fifty: 0 });
  });

  it("the window's edges are the ladder's own: too young is silent, a last rung still due is not", async () => {
    // Arrange — one account younger than the first rung, one due its first
    // rung, one that is 80 hours old having sent only the first, and one that
    // is older than the whole ladder (120 h) with nothing sent at all.
    const accounts = {
      tooYoung: await seedAccount({
        createdAt: new Date(NOW.getTime() - 20 * HOUR_MS),
        nudgesSent: 0,
      }),
      firstRung: await seedAccount({
        createdAt: new Date(NOW.getTime() - 30 * HOUR_MS),
        nudgesSent: 0,
      }),
      lastRung: await seedAccount({
        createdAt: new Date(NOW.getTime() - 80 * HOUR_MS),
        nudgesSent: 1,
      }),
      pastLadder: await seedAccount({
        createdAt: new Date(NOW.getTime() - 120 * HOUR_MS),
        nudgesSent: 0,
      }),
    };

    // ── Act: one hourly run with no page boundary ──
    await verificationNudgeJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: each account is nudged at the rung its age has reached ──
    expect(
      await outboxCounts(NUDGE, accounts),
      "a 20-hour account is too young, a 30-hour one is due its first rung, an 80-hour one its last, and an account past the whole ladder is not a candidate at all (the lane's accepted residual: such a row is left un-nudged rather than nudged late)"
    ).toEqual({ tooYoung: 0, firstRung: 1, lastRung: 1, pastLadder: 0 });

    const firstRungRows = await outboxRows(NUDGE, accounts.firstRung.toHexString());
    expect(firstRungRows[0]?.payload, "the 30-hour account is nudged at the first rung").toEqual({
      rung: "t+24h",
    });

    const lastRungRows = await outboxRows(NUDGE, accounts.lastRung.toHexString());
    expect(
      lastRungRows[0]?.payload,
      "the 80-hour account is still owed the last rung, so no window bound may exclude it"
    ).toEqual({ rung: "t+72h" });
  });

  it("a ladder-exhausted row inside the clock window still spends a page slot, so the eligible row behind it waits", async () => {
    // Arrange — the residual the clock window bounds rather than removes. The
    // exhausted account is 50 hours old, so it is inside the window and is a
    // candidate; it is inserted FIRST, so it heads the page. Both rungs are
    // already sent, so the run examines it and has nothing to deliver to it.
    const accounts = {
      exhaustedInsideWindow: await seedAccount({
        createdAt: new Date(NOW.getTime() - 50 * HOUR_MS),
        nudgesSent: 2,
      }),
      thirty: await seedAccount({
        createdAt: new Date(NOW.getTime() - 30 * HOUR_MS),
        nudgesSent: 0,
      }),
      forty: await seedAccount({
        createdAt: new Date(NOW.getTime() - 40 * HOUR_MS),
        nudgesSent: 0,
      }),
    };

    // ── Act: one hourly run, bounded to two candidates ──
    const run = await verificationNudgeJob.run({
      requestedLimit: PAGE,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: the exhausted row costs the slot, so only the 30-hour account
    // behind it is reached and the 40-hour one waits for a later run ──
    expect(
      detail(run, "nudged"),
      "the page carries the exhausted row and one eligible account, so exactly one nudge is due"
    ).toBe(1);
    expect(
      await outboxCounts(NUDGE, accounts),
      "the exhausted account inside the window costs a page slot without a nudge, the 30-hour account behind it is nudged, and the 40-hour one is not reached on this run"
    ).toEqual({ exhaustedInsideWindow: 0, thirty: 1, forty: 0 });
  });
});
