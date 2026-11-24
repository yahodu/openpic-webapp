import { Collection, ObjectId, type ClientSession } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  seedTenant,
  submitBody,
  submitSelfie,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — what
 * `POST …/selfies/{selfieId}/confirm` publishes, how many times, and with what
 * count (OP-132 review finding **F3**, Medium; contract §6.3/§6.4, §7.6/§7.7,
 * §10.3.2; schema §15.3, §16.4, §17.5; ADR-0805, revised by ADR-0808 — whose
 * §Amends names the lane's liveness-selfie RED and GREEN records this file
 * extends; the concurrent case is ADR-0816).
 *
 * **Why this exists.** The confirmation is the lane's only publisher, and on the
 * F3 tree it publishes on every call: it has no state guard and the
 * `attendee.matches.new` it emits carries no `dedupeKey`, so a client that
 * re-confirms (or retries the call) inserts a second outbox row for the same
 * result — a second notification for one finding. The same handler fills
 * `payload.count` from `countDocuments({ profileId })`, the profile's **total**
 * match count, so the second selfie's notification re-announces the first
 * selfie's matches. And because the handler only publishes when the worker's
 * embedding is already on the row, the I9b confirm (pre-worker) activates the
 * row and publishes nothing, with no path that publishes the late result without
 * a second confirm.
 *
 * ## What is pinned
 *
 * - **A repeat confirm is idempotent in its effect.** The second confirm answers
 *   the same `200` envelope, and exactly **one** `attendee.matches.new` row
 *   exists for the result — the pin the I9 case cannot make, because it only ever
 *   confirms once.
 * - **`payload.count` is the new matches.** Confirm selfie A (3 matches), then
 *   submit and confirm selfie B whose worker run adds 2 more: A's notification
 *   carries `count: 3`, B's carries `count: 2`, and the profile's cached
 *   `matchCount` — the §6.4 total — is 5.
 * - **One activation result is announced exactly once, whichever publisher
 *   writes it.** Confirm before the worker has written anything (the I9b arm),
 *   then let the worker write the embedding and the matches for the
 *   already-active row, and then let the **pipeline** publish that result first
 *   through the one shared writer, carrying the delivery identity
 *   `attendee.matches.new:<eventId>:<profileId>:<selfieId>`. The confirmation
 *   that follows answers `status: "ready"` with the right count and emits
 *   **nothing**, because its `dedupeKey` names the same identity (ADR-0808 §3).
 * - **The confirmation still publishes a late result itself when the pipeline
 *   has not.** With no pipeline emit, the next confirm answers `status: "ready"`
 *   with the right count and emits one notification, and a further confirm emits
 *   nothing. That is the confirmation's own contract — not the designed
 *   recovery and not a client instruction (ADR-0808 §1).
 * - **A double-tap answers two `200`s and notifies once.** Two confirms fired at
 *   the same instant, each with its own `Idempotency-Key`, both answer the
 *   seven-key `200` with the same `selfieId` and produce exactly **one**
 *   `attendee.matches.new` row — the pin the sequential repeat above cannot make,
 *   because there the second call reads the row the first one already committed
 *   (ADR-0816; measured on the cut as `[200,500]`, the loser `500 internal_error`
 *   /`TransactionRetryLimitError`).
 * - **A burst of four answers four `200`s and notifies once.** Four confirms for
 *   one selfie fired at the same instant, each with its own `Idempotency-Key`,
 *   all answer the seven-key `200` with the same `selfieId`, and exactly **one**
 *   `attendee.matches.new` row exists — the width the pair above does not cover,
 *   because the retry budget absorbs one collision and not three (ADR-0821).
 *
 * ## Assumptions (recorded in ADR-0805)
 *
 * - **The two confirms are two requests, not one retried request.** Every call
 *   carries its own `Idempotency-Key` (the helper mints a fresh UUID), so a
 *   repeat that is deduped by the idempotency-key store would not satisfy the
 *   pin: the guarantee has to come from the state the first confirm wrote. The
 *   concurrent case fires the pair through `Promise.all` and holds both at the
 *   transaction boundary, because `Promise.all` alone leaves the interleaving to
 *   the event loop and was measured passing on the defect when the two requests
 *   happened to run one after the other (ADR-0816 §Decision 1).
 * - **"New" is the arrival since the last notification, not the total.** The
 *   §7.6 catalogue describes `attendee.matches.new` as "additional matches
 *   later", and the in-app feed is one rolling row whose `groupCount` is
 *   `$inc`'d by `newMatchCount` (notification design §4) — a total would
 *   double-count every earlier notification. §15.3's `firstMatchNotifiedAt` is
 *   the schema's "fires exactly once" anchor for the delivery; the pins do not
 *   require that field by name, only the count a client sees.
 * - **`matchCount` stays the total.** §6.4 defines it as the cached
 *   `attendeeEventProfiles.matchCount` ("the PRD requires a live total count"),
 *   so the total and the delta answer different questions and are both pinned.
 * - **The worker is simulated, not stubbed**, exactly as the OP-132 suite does
 *   it: `finishSelfieWorker` writes what the queue consumer writes (the vector,
 *   the quality verdict, `processing.status: "done"`, one `faceMatches` row per
 *   photo) and the confirm route is the only thing under test. It writes with
 *   raw driver calls on `app.db`, so it publishes nothing: the shipped worker's
 *   publication transport is `POST /api/v1/internal/domain-events` (ADR-0808
 *   §2), which this tree does not ship.
 * - **The bytes are put through the storage port**, not through the presign
 *   route: `selfie.submit` allows six calls an hour per attendee and this file
 *   spends two submits in one case, so the presign calls (which share the
 *   `selfie.submit` bucket) are avoided. The uploads suite pins the presign
 *   envelope.
 */

/* ────────────────────────────── the race gate ───────────────────────────── */

/** How many confirms the one concurrent case fires at the same instant. */
const CONCURRENT_CONFIRMS = 2;

/**
 * How long a racer waits for its rival at the transaction boundary before a
 * serialising implementation is let through.
 *
 * The gate exists to make the case deterministic, not to require a particular
 * fix: an implementation that serialises confirms before their transactions
 * never brings the second racer to this line, so the first is released by the
 * expiry instead of being parked forever.
 */
const CONFIRM_RACE_GRACE_MS = 250;

/**
 * A bounded latch on the confirmation's transaction boundary.
 *
 * `Promise.all` alone leaves the interleaving to the event loop, and this case
 * was measured passing on the defect when the two requests happened to run one
 * after the other — the wrong pin. Every racer passes this gate **after** it has
 * decided whether to publish and **before** its transaction opens, so both
 * decisions are taken before either write can commit: exactly the window a
 * read-outside-the-transaction check cannot close.
 *
 * The latch is armed only by the concurrent case; every other transaction in
 * this file passes through it untouched.
 */
const confirmRaceGate = vi.hoisted(() => {
  let armed = false;
  let arrivals = 0;
  let expected = 0;
  let released: Promise<void> = Promise.resolve();
  let release = (): void => undefined;

  return {
    /**
     * Close the gate for `count` racers.
     *
     * @param count - How many racers must arrive before either proceeds.
     */
    close(count: number): void {
      armed = true;
      arrivals = 0;
      expected = count;
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    /**
     * Wait at the gate until every racer has arrived, or the grace expires.
     *
     * @param graceMs - The longest a lone racer is held.
     */
    async arrive(graceMs: number): Promise<void> {
      if (!armed) {
        return;
      }
      arrivals += 1;
      if (arrivals >= expected) {
        armed = false;
        release();
        return;
      }
      const expiry = new Promise<void>((resolve) => {
        setTimeout(resolve, graceMs);
      });
      await Promise.race([released, expiry]);
      armed = false;
    },
  };
});

vi.mock("@/server/db/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/transaction")>();
  return {
    ...actual,
    withTransaction: async <T>(
      fn: (session: ClientSession) => Promise<T>,
      options?: Parameters<typeof actual.withTransaction>[1]
    ): Promise<T> => {
      await confirmRaceGate.arrive(CONFIRM_RACE_GRACE_MS);
      return actual.withTransaction(fn, options);
    },
  };
});

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys the confirm's `200` carries, sorted (§6.3/§6.4). */
const CONFIRM_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The one event key the "new photos of you" arrival is recorded under (§7.6). */
const MATCHES_NEW_EVENT = "attendee.matches.new";

/** How many photos the first selfie's worker run finds. */
const FIRST_RUN_MATCHES = 3;

/** How many *additional* photos the second selfie's worker run finds. */
const SECOND_RUN_NEW_MATCHES = 2;

/**
 * The one delivery identity of an activation result (contract §10.3.2; ADR-0806
 * §3, ADR-0808 §3).
 *
 * Both publishers mint it: the confirmation before it emits, and the worker's
 * `POST /api/v1/internal/domain-events` when the pipeline announces the result.
 * Whichever writes first, the other finds the row and becomes a no-op.
 *
 * @param eventId - The event the matches belong to.
 * @param profileId - The attendee profile the delivery announces.
 * @param selfieId - The selfie whose activation produced the rows.
 * @returns The `dedupeKey` both publishers must carry.
 */
function activationDeliveryKey(eventId: string, profileId: string, selfieId: string): string {
  return `${MATCHES_NEW_EVENT}:${eventId}:${profileId}:${selfieId}`;
}

/* ─────────────────────────────── row shapes ──────────────────────────────── */

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly activeSelfieId: ObjectId | null;
  readonly matchCount: number;
}

/** A stored `domainEvents` row, as these cases read it (§7.7). */
interface DomainEventRow {
  readonly _id: ObjectId;
  readonly payload?: Record<string, unknown>;
}

/** A submitted selfie, as the `202` body names it. */
interface SubmittedSelfie {
  readonly selfieId: string;
  readonly profileId: string;
}

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-confirm-publish" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    COLLECTIONS.consents,
    COLLECTIONS.selfies,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────── readers ────────────────────────────────── */

/**
 * The single stored `attendee_event_profiles` row these cases expect.
 *
 * @returns The profile row.
 */
async function profileRow(): Promise<ProfileRow> {
  const rows = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`expected one attendee profile, received ${String(rows.length)}`);
  }
  return row;
}

/**
 * Every stored `attendee.matches.new` outbox row, in the order it was written.
 *
 * §7.7: every notification originates from a `domainEvents` row, so the row
 * count is the notification count.
 *
 * @returns The outbox rows for that event key, oldest first.
 */
async function matchesNewRows(): Promise<DomainEventRow[]> {
  return await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: MATCHES_NEW_EVENT })
    .sort({ _id: 1 })
    .toArray();
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/**
 * Seed a published event, mint an attendee session on it and grant consent.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @returns The event and the caller's handles.
 */
async function readyEvent(
  prefix: string
): Promise<{ readonly tenantKey: string; readonly event: SeededEvent } & Caller> {
  const { tenantKey, events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  await grantConsent(event.slug, { cookie: session.cookie, ip });
  return { tenantKey, event, cookie: session.cookie, ip };
}

/**
 * Put one selfie's bytes where the presigned `PUT` would have written them.
 *
 * The key is content-addressed (§16.1), and writing through the storage port
 * keeps this file inside the `selfie.submit` budget the submits need.
 *
 * @param tag - A per-case tag folded into the bytes, so each selfie is distinct.
 * @returns The object's content hash.
 */
async function prepareSelfie(tag: string): Promise<{ readonly hash: string }> {
  const bytes = makeSelfieBytes(tag);
  await getObjectStorage().putObject(
    SELFIE_LOCATION_KEY,
    selfieObjectKey(bytes.hash),
    bytes.bytes,
    "image/jpeg"
  );
  return { hash: bytes.hash };
}

/**
 * Issue a challenge and submit one already-uploaded selfie (the §6.3 `202`).
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param tag - The per-selfie tag whose bytes were prepared.
 * @returns The stored selfie's id and its profile's id.
 */
async function submitOne(slug: string, caller: Caller, tag: string): Promise<SubmittedSelfie> {
  const upload = await prepareSelfie(tag);
  const challenge = await issueChallenge(slug, caller);
  const response = await submitSelfie(slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    body: submitBody(upload, challenge),
  });
  const body = await bodyOf(response, 202, `POST selfies on ${slug}`);
  const selfieId = body.selfieId;
  const profileId = body.profileId;
  if (typeof selfieId !== "string" || typeof profileId !== "string") {
    throw new Error(
      `expected the 202 body to carry selfieId and profileId: ${JSON.stringify(body)}`
    );
  }
  return { selfieId, profileId };
}

/**
 * Play the worker for one submitted selfie: write its vector and `count` new
 * `faceMatches` rows for the profile.
 *
 * @param selfie - The submitted selfie the worker claims.
 * @param eventContext - The tenant and event the rows belong to.
 * @param count - How many photos this run found.
 */
async function runWorker(
  selfie: SubmittedSelfie,
  eventContext: { readonly tenantKey: string; readonly eventId: string },
  count: number
): Promise<void> {
  const profile = await profileRow();
  await finishSelfieWorker(app, {
    selfieId: selfie.selfieId,
    profileId: selfie.profileId,
    eventId: eventContext.eventId,
    tenantKey: eventContext.tenantKey,
    subject: profile.subject,
    matches: count,
  });
}

/**
 * Confirm one selfie and parse its `200` envelope.
 *
 * @param slug - The event's active access-link slug.
 * @param selfieId - The selfie to confirm.
 * @param caller - The caller's credential and client address.
 * @returns The parsed §6.3 envelope.
 */
async function confirm(
  slug: string,
  selfieId: string,
  caller: Caller
): Promise<Record<string, unknown>> {
  const response = await confirmSelfie(slug, selfieId, {
    cookie: caller.cookie,
    ip: caller.ip,
  });
  return bodyOf(response, 200, `POST selfie ${selfieId} confirm`);
}

/* ───────────── F3.1: a repeat confirm publishes exactly one notification ─── */

describe("when a confirmed selfie is confirmed a second time", () => {
  it("answers the same 200 envelope and leaves one attendee.matches.new row", async () => {
    const ready = await readyEvent("op132-f3-double");
    const submitted = await submitOne(ready.event.slug, ready, "f3-double");
    await runWorker(
      submitted,
      {
        tenantKey: ready.tenantKey,
        eventId: ready.event.id.toHexString(),
      },
      FIRST_RUN_MATCHES
    );

    const first = await confirm(ready.event.slug, submitted.selfieId, ready);
    const afterFirst = await matchesNewRows();
    expect(afterFirst).toHaveLength(1);

    const second = await confirm(ready.event.slug, submitted.selfieId, ready);

    // The repeat answers the same result, not a conflict and not a fresh job.
    expect(keysOf(second)).toEqual(CONFIRM_KEYS);
    expect(second).toEqual(first);
    expect(second.status).toBe("ready");

    // ...and it does not re-announce a result that was already announced.
    const afterSecond = await matchesNewRows();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.payload).toMatchObject({
      eventId: ready.event.id.toHexString(),
      count: FIRST_RUN_MATCHES,
    });

    // The cached total never inflates on a repeat either (§6.4).
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);
  });
});

/* ───────────── F3.2: the notification carries the *new* match count ──────── */

describe("when a second selfie finds more photos than the first", () => {
  it("notifies the second selfie with the new matches only, and keeps matchCount the total", async () => {
    const ready = await readyEvent("op132-f3-newcount");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    const first = await submitOne(ready.event.slug, ready, "f3-newcount-a");
    await runWorker(first, eventContext, FIRST_RUN_MATCHES);
    const firstConfirm = await confirm(ready.event.slug, first.selfieId, ready);
    expect(firstConfirm.status).toBe("ready");
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);

    const firstNotification = await matchesNewRows();
    expect(firstNotification).toHaveLength(1);
    expect(firstNotification[0]?.payload).toMatchObject({ count: FIRST_RUN_MATCHES });

    // §6.3's second step again: a new challenge, new bytes, a new selfie row —
    // the worker's run finds two photos this profile had never seen.
    const second = await submitOne(ready.event.slug, ready, "f3-newcount-b");
    await runWorker(second, eventContext, SECOND_RUN_NEW_MATCHES);
    const secondConfirm = await confirm(ready.event.slug, second.selfieId, ready);
    expect(secondConfirm.status).toBe("ready");

    // §6.4's `matchCount` is the cached total: 3 + 2.
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES + SECOND_RUN_NEW_MATCHES);

    // §7.6 calls `attendee.matches.new` "additional matches later" and the feed
    // increments one rolling row by that number, so the delivery's `count` is
    // the delta — a total here would re-announce the first three.
    const notifications = await matchesNewRows();
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.payload).toMatchObject({ count: FIRST_RUN_MATCHES });
    expect(notifications[1]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: SECOND_RUN_NEW_MATCHES,
    });

    // One profile, one running total, two announcements whose counts add up to it.
    const announced = notifications.reduce((sum, row) => {
      const count = row.payload?.count;
      return sum + (typeof count === "number" ? count : 0);
    }, 0);
    expect(announced).toBe((await profileRow()).matchCount);
  });
});

/* ── F3.3: one activation result, one delivery, whichever publisher writes ── */

describe("when the worker's result arrives after the confirmation", () => {
  it("announces the late result exactly once, whichever publisher writes first", async () => {
    const ready = await readyEvent("op132-f3-late-pipeline");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-late-pipeline");
    const profileId = (await profileRow())._id.toHexString();

    // The I9b arm (pinned in liveness-selfie-submit.test.ts, used here as the
    // starting point and not re-pinned): the confirmation activates the row and
    // there is nothing to publish yet.
    const early = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(early.status).toBe("processing");
    expect(early.profileId).toBe(profileId);
    expect((await profileRow()).matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);

    // The worker's own writes, before any publisher: the embedding and the three
    // matches land on the row that is already active. The unchanged outbox is an
    // OBSERVATION, not a prohibition — `finishSelfieWorker` writes with raw driver
    // calls, so no production code ran, and the shipped worker's publication is
    // the internal endpoint (ADR-0808 §2).
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);
    expect(await matchesNewRows()).toHaveLength(0);

    // The pipeline publishes first, through the one shared writer and with the
    // identity every publisher of this activation result must carry.
    const deliveryKey = activationDeliveryKey(eventContext.eventId, profileId, submitted.selfieId);
    const emitted = await emitDomainEvent(
      {
        eventKey: MATCHES_NEW_EVENT,
        tenantId: ready.tenantKey,
        actorRef: { kind: "attendee", id: profileId },
        subjectRef: { kind: "event", id: eventContext.eventId },
        payload: { eventId: eventContext.eventId, count: FIRST_RUN_MATCHES },
        dedupeKey: deliveryKey,
      },
      { db: app.db }
    );
    expect(emitted).toEqual({ deduped: false, id: expect.any(String) });
    expect(await matchesNewRows()).toHaveLength(1);

    // Now the confirmation: it answers the same result and publishes NOTHING,
    // because its own `dedupeKey` names the delivery the pipeline already wrote.
    // This is the pin — a divergent key shape in the confirm inserts a second row
    // for one activation result (ADR-0808 §3).
    const confirmed = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(confirmed)).toEqual(CONFIRM_KEYS);
    expect(confirmed.status).toBe("ready");
    expect(confirmed.selfieId).toBe(submitted.selfieId);
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);

    const published = await matchesNewRows();
    expect(published).toHaveLength(1);
    // The surviving row is the pipeline's own: the confirmation added no second
    // delivery of the same activation result.
    expect(published[0]?._id.toHexString()).toBe(emitted.id);
    expect(published[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });

    // A further confirm is a normal repeat: the same envelope, still one row.
    const repeated = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(repeated).toEqual(confirmed);
    expect(await matchesNewRows()).toHaveLength(1);
  });
});

describe("when the pipeline stays silent about a late worker result", () => {
  it("publishes the late result on the next confirm when the pipeline has not", async () => {
    const ready = await readyEvent("op132-f3-late");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-late");

    // The I9b arm again: the confirmation activates the row, and there is nothing
    // to publish yet.
    const early = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(early.status).toBe("processing");
    expect((await profileRow()).matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);

    // The worker finishes on the row that is already active and the pipeline
    // emits nothing, so nothing has published this result yet.
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);
    expect(await matchesNewRows()).toHaveLength(0);

    // This is the confirmation's own contract (§6.3/§7.6), not the designed
    // recovery and not a client instruction: the pipeline owns the late result
    // (ADR-0808 §1), and a client is never told to confirm again.
    const recovered = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(recovered)).toEqual(CONFIRM_KEYS);
    expect(recovered.status).toBe("ready");
    expect(recovered.selfieId).toBe(submitted.selfieId);
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);

    const published = await matchesNewRows();
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });

    // The recovery confirm is a normal confirm: repeating it publishes nothing.
    const repeated = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(repeated).toEqual(recovered);
    expect(await matchesNewRows()).toHaveLength(1);
  });
});

/* ───── F3.4: two simultaneous confirms answer 200 twice, notify once ─────── */

describe("when the same selfie is confirmed twice at the same instant", () => {
  it("answers 200 to both requests and leaves one attendee.matches.new row", async () => {
    const ready = await readyEvent("op132-f3-concurrent");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-concurrent");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    // Two REQUESTS, not one retried request: `confirmSelfie` mints a fresh
    // `Idempotency-Key` per call, so the idempotency-key store cannot make this
    // case pass — the only thing that may serialize the pair is the publication's
    // own state. A double-tap and a client timeout-retry both have this shape,
    // and §6.3 promises the same seven-key envelope for a second confirm.
    //
    // Both racers are walked to the transaction boundary together (see
    // `confirmRaceGate`), so the case measures the race rather than the event
    // loop's mood: both have read the publication state before either writes.
    confirmRaceGate.close(CONCURRENT_CONFIRMS);
    const responses = await Promise.all([
      confirmSelfie(ready.event.slug, submitted.selfieId, { cookie: ready.cookie, ip: ready.ip }),
      confirmSelfie(ready.event.slug, submitted.selfieId, { cookie: ready.cookie, ip: ready.ip }),
    ]);

    // Which racer finishes first is the event loop's business, so the pin is
    // order-independent: sorted, the pair is two `200`s. A `5xx` here is a
    // double-tap the attendee reads as a failure after their selfie did activate.
    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);
    expect(
      statuses,
      `the two simultaneous confirms answered [${statuses.join(",")}]; both must be 200`
    ).toEqual([200, 200]);

    const [first, second] = await Promise.all(
      responses.map(async (response) => (await response.json()) as Record<string, unknown>)
    );
    if (first === undefined || second === undefined) {
      throw new Error(`expected two confirm bodies, received ${String(responses.length)}`);
    }
    expect(keysOf(first)).toEqual(CONFIRM_KEYS);
    expect(keysOf(second)).toEqual(CONFIRM_KEYS);
    expect(first.selfieId).toBe(submitted.selfieId);
    expect(second.selfieId).toBe(submitted.selfieId);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    // One activation result, one answer: the racers do not report different
    // results for the same selfie.
    expect(second).toEqual(first);

    // One announcement, not one per racer (§7.7: every notification originates
    // from a `domainEvents` row, so the row count is the notification count).
    const notifications = await matchesNewRows();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });

    // §6.4's cached total, once.
    expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);
  });
});

/* ── F3.5: a burst of four simultaneous confirms answer 200 four times ────── */

/** How many confirms the burst fires at the same instant (the card's width). */
const BURST_CONFIRMS = 4;

/**
 * How many fresh rounds of the burst this case runs.
 *
 * A single round is **not** a pin on this tree, and that was measured rather
 * than assumed. Fifteen focused runs of the single-round shape against the cut
 * (`origin/main` `553a92f`) answered `[200,200,200,200]` six times and
 * `[200,200,200,500]` or `[200,200,500,500]` nine times: the loser's retry
 * either reads the winner's committed outbox row and answers `200`, or spends
 * its last attempt on the same collision. That is a race against the commit,
 * not a property of the implementation, so a single-round case would report the
 * defect as fixed on two runs in five.
 *
 * The contract assertion is therefore unchanged and repeated over fresh rounds
 * — this repository's rule for race pins (`it.each`, a fresh database per run;
 * ADR-0816 §Decision 1). Forty further round-samples measured the one-round red
 * rate at ~48 %, so ten rounds leave roughly a 1-in-600 chance that a file run
 * passes on the defect (ADR-0821 §Evidence), and an implementation that really
 * answers four `200`s does so in every round.
 */
const BURST_ROUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

describe("when the same selfie is confirmed by a burst of four requests", () => {
  it.each(BURST_ROUNDS)(
    "answers 200 to all four and leaves one attendee.matches.new row (round %i)",
    async (round) => {
      const ready = await readyEvent(`op132-f3-burst-${String(round)}`);
      const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
      const submitted = await submitOne(ready.event.slug, ready, `f3-burst-${String(round)}`);
      await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

      // Four REQUESTS for one activation result, not one retried request: every
      // call carries its own `Idempotency-Key` (the helper mints a fresh one),
      // so the idempotency-key store cannot answer any of them. A burst is what
      // a gallery page with several open tabs — or a client that retries twice
      // on timeout — actually produces, and §6.3 promises the same seven-key
      // envelope to every one of them.
      //
      // All four are walked to the transaction boundary together by the same
      // bounded latch case 5 uses (`confirmRaceGate`), so the case measures the
      // contended write rather than the event loop's mood.
      confirmRaceGate.close(BURST_CONFIRMS);
      const responses = await Promise.all([
        confirmSelfie(ready.event.slug, submitted.selfieId, {
          cookie: ready.cookie,
          ip: ready.ip,
        }),
        confirmSelfie(ready.event.slug, submitted.selfieId, {
          cookie: ready.cookie,
          ip: ready.ip,
        }),
        confirmSelfie(ready.event.slug, submitted.selfieId, {
          cookie: ready.cookie,
          ip: ready.ip,
        }),
        confirmSelfie(ready.event.slug, submitted.selfieId, {
          cookie: ready.cookie,
          ip: ready.ip,
        }),
      ]);

      expect(responses).toHaveLength(BURST_CONFIRMS);

      // Which racer finishes first is the event loop's business, so the pin is
      // order-independent: sorted, the burst is four `200`s. Any `5xx` here is
      // an attendee reading a failure after their selfie did activate — the
      // defect class ADR-0816 closed for the pair, at the width the retry
      // budget no longer absorbs (ADR-0821 §Context).
      const statuses = responses
        .map((response) => response.status)
        .sort((left, right) => left - right);
      expect(
        statuses,
        `the four simultaneous confirms answered [${statuses.join(",")}]; all four must be 200`
      ).toEqual([200, 200, 200, 200]);

      const [bodyOne, bodyTwo, bodyThree, bodyFour] = await Promise.all(
        responses.map(async (response) => (await response.json()) as Record<string, unknown>)
      );
      if (
        bodyOne === undefined ||
        bodyTwo === undefined ||
        bodyThree === undefined ||
        bodyFour === undefined
      ) {
        throw new Error(`expected four confirm bodies, received ${String(responses.length)}`);
      }

      // Every answer is the §6.3 envelope, and they are one result, not four
      // different readings of the same activation.
      expect(keysOf(bodyOne)).toEqual(CONFIRM_KEYS);
      expect(keysOf(bodyTwo)).toEqual(CONFIRM_KEYS);
      expect(keysOf(bodyThree)).toEqual(CONFIRM_KEYS);
      expect(keysOf(bodyFour)).toEqual(CONFIRM_KEYS);
      expect(bodyOne.selfieId).toBe(submitted.selfieId);
      expect(bodyOne.status).toBe("ready");
      expect(bodyTwo).toEqual(bodyOne);
      expect(bodyThree).toEqual(bodyOne);
      expect(bodyFour).toEqual(bodyOne);

      // One announcement for one activation result, not one per racer (§7.7:
      // every notification originates from a `domainEvents` row, so the row
      // count is the notification count).
      const notifications = await matchesNewRows();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.payload).toMatchObject({
        eventId: eventContext.eventId,
        count: FIRST_RUN_MATCHES,
      });

      // §6.4's cached total, once.
      expect((await profileRow()).matchCount).toBe(FIRST_RUN_MATCHES);
    }
  );
});

/* ─── §15.3: `firstMatchNotifiedAt` is stamped once, by the first delivery ─── */

/**
 * The §15.3 `firstMatchNotifiedAt` watermark, as these cases read it.
 *
 * `ProfileRow` above declares only the fields the earlier cases read, and the
 * helper module `../helpers/selfie-flow.ts` is frozen, so the one extra field is
 * named here rather than widening either of them.
 */
interface WatermarkRow {
  readonly firstMatchNotifiedAt?: Date | null;
}

/**
 * The profile's §15.3 watermark, normalised to `null` while nothing has been
 * delivered.
 *
 * @returns The stamp, or `null` before the first delivery.
 */
async function firstMatchNotifiedStamp(): Promise<Date | null> {
  const row = (await profileRow()) as unknown as WatermarkRow;
  return row.firstMatchNotifiedAt ?? null;
}

/**
 * The stamp the first delivery wrote, refusing `null` in one place so a deleted
 * stamp is reported as a missing stamp rather than as a mismatched date.
 *
 * @returns The §15.3 watermark the first delivery committed.
 */
async function firstDeliveryStamp(): Promise<Date> {
  const stamped = await firstMatchNotifiedStamp();
  if (stamped === null) {
    throw new Error("expected the first delivery to stamp firstMatchNotifiedAt, received null");
  }
  return stamped;
}

describe("when a confirmation is the profile's first delivery", () => {
  it("stamps firstMatchNotifiedAt with the confirmation's own instant", async () => {
    const ready = await readyEvent("op132-f5-stamp");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f5-stamp");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    // The field is a delivery watermark, not a submit-time one: both profile
    // creation sites leave it `null` (schema §15.3, "fires exactly once"), so a
    // value can only come from the delivery below.
    expect(await firstMatchNotifiedStamp()).toBeNull();

    // The card leaves the time assertion open; this file takes the real-clock
    // bracket. The route reads the clock once and writes that one instant, so
    // the stamp cannot precede the call and cannot follow the answer — a
    // tolerance would only weaken an assertion that needs none.
    const before = Date.now();
    const confirmed = await confirm(ready.event.slug, submitted.selfieId, ready);
    const after = Date.now();

    // One delivery really happened: this is not the "nothing to publish" arm.
    expect(confirmed.status).toBe("ready");
    const delivered = await matchesNewRows();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: FIRST_RUN_MATCHES,
    });

    const stamped = await firstDeliveryStamp();
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(after);
  });

  it("leaves firstMatchNotifiedAt unset when the confirmation delivers nothing", async () => {
    const ready = await readyEvent("op132-f5-nodelivery");
    const submitted = await submitOne(ready.event.slug, ready, "f5-nodelivery");

    // The I9b arm, pinned in `liveness-selfie-submit.test.ts` and used here as
    // the starting point and not re-pinned: no worker run, so there is no
    // embedding, nothing is published, and the watermark must stay unset.
    const confirmed = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(confirmed.status).toBe("processing");
    expect(await matchesNewRows()).toHaveLength(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
  });

  it("keeps the first delivery's stamp when a later selfie is delivered", async () => {
    const ready = await readyEvent("op132-f5-later");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    const first = await submitOne(ready.event.slug, ready, "f5-later-a");
    await runWorker(first, eventContext, FIRST_RUN_MATCHES);
    const firstConfirm = await confirm(ready.event.slug, first.selfieId, ready);
    expect(firstConfirm.status).toBe("ready");
    const stamped = await firstDeliveryStamp();

    const second = await submitOne(ready.event.slug, ready, "f5-later-b");
    await runWorker(second, eventContext, SECOND_RUN_NEW_MATCHES);
    const secondConfirm = await confirm(ready.event.slug, second.selfieId, ready);
    expect(secondConfirm.status).toBe("ready");

    // The second selfie IS a delivery — that is what makes this case
    // discriminating: the outbox gains its own row...
    const delivered = await matchesNewRows();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.payload).toMatchObject({
      eventId: eventContext.eventId,
      count: SECOND_RUN_NEW_MATCHES,
    });

    // ...and the §15.3 watermark is still the FIRST delivery's instant: it
    // records when the profile was first notified, not the latest notifying.
    expect((await firstDeliveryStamp()).getTime()).toBe(stamped.getTime());
  });

  it("keeps the first delivery's stamp when the same selfie is confirmed again", async () => {
    const ready = await readyEvent("op132-f5-repeat");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    const submitted = await submitOne(ready.event.slug, ready, "f5-repeat");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);
    const firstConfirm = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(firstConfirm.status).toBe("ready");
    const stamped = await firstDeliveryStamp();

    // One delivery per activation result: the repeat answers the same envelope
    // and adds no outbox row, so there is nothing a re-stamp could record.
    const repeated = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(repeated).toEqual(firstConfirm);
    const delivered = await matchesNewRows();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toMatchObject({ count: FIRST_RUN_MATCHES });

    expect((await firstDeliveryStamp()).getTime()).toBe(stamped.getTime());
  });
});

/* ─ F3.6: a genuine transaction failure is a 500, never a masked 200 ──────── */

/**
 * The driver's own `Collection#updateOne`, resolved **once at module load**,
 * before any case installs a spy.
 *
 * Resolving it inside the stub would find the spy itself and recurse (the
 * `billing-checkout.test.ts:177` precedent): a `RangeError` is also a `500`, so
 * the pin would pass for the wrong reason.
 */
const driverUpdateOne = ((): typeof Collection.prototype.updateOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("expected Collection.prototype.updateOne to be a function");
  }
  return descriptor.value as typeof Collection.prototype.updateOne;
})();

/** The driver's own `Collection#insertOne`, resolved once at module load (same trap). */
const driverInsertOne = ((): typeof Collection.prototype.insertOne => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "insertOne");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("expected Collection.prototype.insertOne to be a function");
  }
  return descriptor.value as typeof Collection.prototype.insertOne;
})();

/**
 * One field of a driver operand, without widening the operand's type.
 *
 * @param document - The filter, update, document or options object a driver call received.
 * @param key - The field to read.
 * @returns The field's value, or `undefined` when the operand does not carry it.
 */
function fieldOf(document: unknown, key: string): unknown {
  return document !== null && typeof document === "object" ? Reflect.get(document, key) : undefined;
}

/**
 * The `$set` operand of an update document.
 *
 * @param update - The driver's `update` argument.
 * @returns The `$set` document, or `undefined` for a pipeline update.
 */
function setOf(update: unknown): unknown {
  return Array.isArray(update) ? undefined : fieldOf(update, "$set");
}

/** One write the confirmation asked of `attendeeEventProfiles`, as the spy saw it. */
interface ProfileWrite {
  /** The profile the write addressed, so the case cannot pass on another row. */
  readonly profileId: string;
  /** The `status` the write would have stored — the activation itself. */
  readonly askedStatus: unknown;
  /** True when the write carried a session, i.e. ran inside the transaction. */
  readonly inSession: boolean;
}

/** One write the confirmation asked of the outbox, as the spy saw it. */
interface OutboxWrite {
  /** The delivery identity the write was recording (§10.3.2). */
  readonly dedupeKey: unknown;
  /** True when the write carried a session, i.e. ran inside the transaction. */
  readonly inSession: boolean;
}

/**
 * True when the stored selfie is the profile's active one (§16.4).
 *
 * @param selfieId - The selfie the case submitted, as the `202` named it.
 * @returns `isActive === true` for that row.
 */
async function selfieIsActive(selfieId: string): Promise<boolean> {
  const row = (await app.db
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: new ObjectId(selfieId) })) as unknown as { readonly isActive?: boolean } | null;
  return row?.isActive === true;
}

/**
 * The notification fan-out rows a workspace holds for this delivery (§7.7, §4).
 *
 * Every in-app feed row is written by the fan-out from an outbox row, so the
 * count is the notification count the attendee would see.
 *
 * @param tenantKey - The workspace the delivery would belong to.
 * @returns The stored feed rows for that workspace.
 */
async function workspaceNotificationRows(tenantKey: string): Promise<unknown[]> {
  return await app.db
    .collection(COLLECTIONS.notifications)
    .find({ tenantId: tenantKey, typeKey: MATCHES_NEW_EVENT })
    .toArray();
}

/**
 * The confirmation's transaction body, with a driver write failing.
 *
 * **Why this exists.** Every case above is green under a `catch` that swallows
 * the transaction's abort and continues: measured on this head, wrapping the
 * confirm's `.catch` so it swallows every error leaves `20 passed (21)` — the
 * nineteen shipped cases and the control below — and reds only the case below
 * (probe A, ADR-0965 §Evidence). That leaves a genuine transaction failure — a
 * real database error, **not** the outbox's duplicate-key collision the retry
 * path exists for — answered `200 status: "ready"` with no activation write, no
 * watermark and no notification: a silent failure dressed as success, where the
 * attendee reads a ready selfie that was never activated (contract §6.3/§6.4,
 * §0.12; ADR-0965).
 *
 * The first case fails the transaction's **own** write: the
 * `attendeeEventProfiles` update that sets `activeSelfieId`/`status`/
 * `matchCount` fails with a driver `not primary` (`code: 91`, which carries no
 * `TransientTransactionError` label, so no retry absorbs it), the transaction
 * aborts and the route answers the app-wide `500 internal_error`. The dedupe
 * `countDocuments` is deliberately **not** stubbed, so the case cannot pass by
 * making the dedupe read fail instead.
 *
 * The second case is that pin's **control**, and it is what stops the first one
 * from being satisfied by turning every driver error into a `500`: the same
 * stubbing technique, but the outbox refuses the announcement with a
 * duplicate-key collision (`code: 11000`). The shipped writer catches that code
 * and reports the delivery as already recorded (`domain-events.ts`'s
 * `deduped: true`), so the confirmation still answers the documented `200` and
 * its activation commits — a duplicate key is a dedupe, not a failure.
 */
describe("when the confirmation's transaction fails for a reason that is not a duplicate-key collision", () => {
  it("answers 500 internal_error and activates and announces nothing", async () => {
    const ready = await readyEvent("op132-f3-txfail");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-txfail");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    // The worker's result is on the row, so this confirmation WOULD publish and
    // set `ready`: the fixture is the happy path the cases above confirm. The
    // pre-call reads are the state the refusal must leave untouched.
    const before = await profileRow();
    expect(before.status).toBe("processing");
    expect(before.activeSelfieId).toBeNull();
    expect(before.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await matchesNewRows()).toHaveLength(0);
    expect(await workspaceNotificationRows(ready.tenantKey)).toHaveLength(0);

    // The activation write fails, and it fails for a reason that is NOT the
    // outbox's duplicate-key collision: a driver error on the profile update.
    const failure = Object.assign(new Error("not primary"), { code: 91 });
    const profileWrites: ProfileWrite[] = [];
    const writeSpy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
      this: Collection,
      filter,
      update,
      options
    ) {
      if (this.collectionName === COLLECTIONS.attendeeEventProfiles) {
        profileWrites.push({
          profileId: String(fieldOf(filter, "_id")),
          askedStatus: fieldOf(setOf(update), "status"),
          inSession: fieldOf(options, "session") !== undefined,
        });
        return Promise.reject(failure);
      }
      return driverUpdateOne.call(this, filter, update, options);
    });

    let response: Response;
    try {
      response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
    } finally {
      writeSpy.mockRestore();
    }

    // Non-vacuity: the transaction opened and reached THIS profile's activation
    // write, under its session, asking for `ready`. A route that answered `500`
    // before the transaction — or one that never entered it — fails here.
    expect(profileWrites).toEqual([
      { profileId: submitted.profileId, askedStatus: "ready", inSession: true },
    ]);

    // §0.12: a throw that is not an `AppError` is the app-wide `500`, and the
    // envelope leaks nothing. A `200` here is a silent failure with a success
    // envelope: `status: "ready"` for a selfie that no write activated.
    expect(
      response.status,
      "a confirm whose transaction failed with a non-retry driver error answered " +
        `${String(response.status)}; it must answer the app-wide 500`
    ).toBe(500);
    const error = await errorBody(response);
    expect(error.code).toBe("internal_error");
    expect(error.details).toBeUndefined();

    // Nothing was activated: the §15.3 row is exactly as the submit left it,
    // the watermark never fired, the selfie is still not the active one and
    // nothing was announced (§7.6/§7.7).
    const after = await profileRow();
    expect(after.status).toBe(before.status);
    expect(after.activeSelfieId).toBeNull();
    expect(after.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(false);
    expect(await matchesNewRows()).toHaveLength(0);
    expect(await workspaceNotificationRows(ready.tenantKey)).toHaveLength(0);

    // The `500` is the injected failure, not a broken fixture: the same request
    // with a healthy driver answers the documented `200` and publishes once, so
    // the API can be retried (a `5xx` leaves no `Idempotency-Key` state behind).
    const retried = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(retried)).toEqual(CONFIRM_KEYS);
    expect(retried.status).toBe("ready");
    expect(retried.selfieId).toBe(submitted.selfieId);
    expect((await profileRow()).status).toBe("ready");
    expect(await firstMatchNotifiedStamp()).not.toBeNull();
    expect(await matchesNewRows()).toHaveLength(1);
  });

  it("still answers 200 when the outbox refuses the announcement as a duplicate key", async () => {
    const ready = await readyEvent("op132-f3-txdup");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-txdup");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    const before = await profileRow();
    expect(before.status).toBe("processing");
    expect(before.activeSelfieId).toBeNull();
    expect(before.matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);

    // The collision a rival publisher's row produces: the outbox insert is
    // refused with MongoDB's duplicate-key code. `emitDomainEvent` owns that
    // code and reports the delivery as already recorded instead of aborting, so
    // this failure class must NOT reach the client as a `500`.
    const collision = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    const outboxWrites: OutboxWrite[] = [];
    const insertSpy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document,
      options
    ) {
      if (this.collectionName === COLLECTIONS.domainEvents) {
        outboxWrites.push({
          dedupeKey: fieldOf(document, "dedupeKey"),
          inSession: fieldOf(options, "session") !== undefined,
        });
        return Promise.reject(collision);
      }
      return driverInsertOne.call(this, document, options);
    });

    let response: Response;
    try {
      response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
    } finally {
      insertSpy.mockRestore();
    }

    // Non-vacuity: the confirmation really did ask the outbox to record this
    // selfie's delivery, inside its transaction. A route that skipped the emit
    // — or one whose request never reached it — fails here.
    expect(outboxWrites).toEqual([
      {
        dedupeKey: activationDeliveryKey(
          eventContext.eventId,
          submitted.profileId,
          submitted.selfieId
        ),
        inSession: true,
      },
    ]);

    // §6.3: the documented answer, and the activation it promises really did
    // commit — a duplicate key is a dedupe, not a failure.
    expect(
      response.status,
      "a confirm whose outbox insert was refused as a duplicate key answered " +
        `${String(response.status)}; the shipped writer dedupes it and must answer 200`
    ).toBe(200);
    const answered = await bodyOf(response, 200, "POST selfie confirm (duplicate-key control)");
    expect(keysOf(answered)).toEqual(CONFIRM_KEYS);
    expect(answered.status).toBe("ready");
    expect(answered.selfieId).toBe(submitted.selfieId);

    const after = await profileRow();
    expect(after.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(after.status).toBe("ready");
    expect(after.matchCount).toBe(FIRST_RUN_MATCHES);
    expect(await firstMatchNotifiedStamp()).not.toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(true);

    // The refused insert added nothing: the row the collision stands for is the
    // rival's, and this request announced nothing of its own.
    expect(await matchesNewRows()).toHaveLength(0);
  });
});

/* ─ F3.7: the outbox write's own failure is a 500, never a masked 200 ─────── */

/** A `selfies` write the confirmation asked for, as the spy saw it. */
interface SelfieWrite {
  /** The selfie the write addressed, so the case cannot pass on another row. */
  readonly selfieId: string;
  /** The `isActive` the write asked for — the §16.4 pointer itself. */
  readonly askedIsActive: unknown;
  /** True when the write carried a session, i.e. ran inside the transaction. */
  readonly inSession: boolean;
}

/**
 * The confirmation's transaction, with the **outbox insert** failing for a
 * reason that is not a duplicate key.
 *
 * **Why this exists.** F3.6 above pins the *activation* write's failure: stubbing
 * the `attendeeEventProfiles` update reds it. That leaves the transaction's
 * **other** write — the in-transaction `emitDomainEvent` call, the announcement
 * itself — unpinned, and measured on `origin/main` `3a9231bd` a `catch` around
 * exactly that call is invisible to the whole file: wrapping the emit in
 * `try { … } catch {}` answers `200 status: "ready"` with the activation
 * committed (`status: "ready"`, `activeSelfieId` set, `matchCount: 3`, the
 * §15.3 watermark set) and **no** `attendee.matches.new` row — the announcement
 * silently lost — while the shipped cases stay `21 passed (21)` (ADR-0966
 * §Evidence). ADR-0965's Reversal condition already forbids it ("the confirm's
 * transaction fails for a reason that is not the outbox's duplicate-key
 * collision → `500 internal_error` … and announces nothing"); this describe is
 * that sentence's second half.
 *
 * The injection is the same driver-level shape as the F3.6 cases: a non-duplicate
 * replica-set error (`code: 91`, no `TransientTransactionError` label, so
 * `withTransaction` rethrows on the first attempt) rejected from
 * `Collection.prototype.insertOne` only for `COLLECTIONS.domainEvents`, with
 * every other collection forwarded to the real method resolved once at module
 * load ({@link driverInsertOne}). The dedupe `countDocuments` is deliberately
 * **not** stubbed, so the case cannot pass by making the dedupe read fail.
 *
 * The first case fails the outbox insert; the second fails the `selfies` row's
 * `isActive` write (the transaction's other, earlier write) — the same
 * transaction, the same expectations, so a swallow anywhere in the body reds one
 * of them.
 *
 * What the client sees is the app-wide `500 internal_error` with no `details`,
 * and nothing committed: the profile row keeps its pre-call `processing` /
 * `null` / `0` / unset watermark, the selfie is still not the active one, and no
 * outbox row exists. Non-vacuity is the recorded **attempt**: exactly one outbox
 * insert, carrying this selfie's delivery identity
 * (`attendee.matches.new:<eventId>:<profileId>:<selfieId>`, §10.3.2) and the
 * transaction's session — a route that answered `500` before the transaction, or
 * removed the emit, fails there.
 *
 * The `notifications` feed rows are **not** asserted here: the fan-out is
 * deferred through `after()`, which throws outside a request scope, so in this
 * harness the zero-row claim cannot red on its own (ADR-0965 §Consequences). The
 * primary "announces nothing" observable is the `domainEvents` row count, and the
 * recorded attempt is what makes even that non-vacuous.
 */
describe("when the confirmation's outbox write fails for a reason that is not a duplicate key", () => {
  it("answers 500 internal_error and commits neither the activation nor the announcement", async () => {
    const ready = await readyEvent("op132-f3-emitfail");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-emitfail");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    // The worker's result is on the row, so this confirmation WOULD publish and
    // set `ready`: the pre-call reads are the state a rollback must preserve.
    const before = await profileRow();
    expect(before.status).toBe("processing");
    expect(before.activeSelfieId).toBeNull();
    expect(before.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await matchesNewRows()).toHaveLength(0);

    // The transaction reaches its announcement and the driver refuses it for a
    // reason that is NOT a duplicate key: `emitDomainEvent` dedupes `11000` and
    // only `11000`, so this error must abort the whole transaction.
    const failure = Object.assign(new Error("not primary"), { code: 91 });
    const outboxAttempts: OutboxWrite[] = [];
    const insertSpy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
      this: Collection,
      document,
      options
    ) {
      if (this.collectionName === COLLECTIONS.domainEvents) {
        outboxAttempts.push({
          dedupeKey: fieldOf(document, "dedupeKey"),
          inSession: fieldOf(options, "session") !== undefined,
        });
        return Promise.reject(failure);
      }
      return driverInsertOne.call(this, document, options);
    });

    let response: Response;
    try {
      response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
    } finally {
      insertSpy.mockRestore();
    }

    // Non-vacuity: the confirmation really did ask the outbox to record THIS
    // selfie's delivery, once, under its transaction. A route that answered
    // `500` before the transaction — or one whose emit never ran — fails here.
    expect(outboxAttempts).toEqual([
      {
        dedupeKey: activationDeliveryKey(
          eventContext.eventId,
          submitted.profileId,
          submitted.selfieId
        ),
        inSession: true,
      },
    ]);

    // §0.12: the failure is the app-wide `500`, and the envelope leaks nothing.
    // A `200` here is a silent failure with a success envelope: `status: "ready"`
    // for a selfie whose announcement was never recorded.
    expect(
      response.status,
      "a confirm whose outbox write failed with a non-retry driver error answered " +
        `${String(response.status)}; it must answer the app-wide 500`
    ).toBe(500);
    const error = await errorBody(response);
    expect(error.code).toBe("internal_error");
    expect(error.details).toBeUndefined();

    // Nothing was activated and nothing was announced: the §15.3 row is exactly
    // as the submit left it, the watermark never fired, the selfie is still not
    // the active one and the outbox holds no row (§6.4, §7.6/§7.7, §16.4).
    const after = await profileRow();
    expect(after.status).toBe(before.status);
    expect(after.activeSelfieId).toBeNull();
    expect(after.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(false);
    expect(await matchesNewRows()).toHaveLength(0);

    // The `500` is the injected failure, not a broken fixture: the same request
    // with a healthy driver answers the documented `200`, activates the row and
    // publishes exactly once, so the client can retry (a `5xx` leaves no
    // `Idempotency-Key` state behind).
    const retried = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(retried)).toEqual(CONFIRM_KEYS);
    expect(retried.status).toBe("ready");
    expect(retried.selfieId).toBe(submitted.selfieId);
    const recovered = await profileRow();
    expect(recovered.status).toBe("ready");
    expect(recovered.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(recovered.matchCount).toBe(FIRST_RUN_MATCHES);
    expect(await firstMatchNotifiedStamp()).not.toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(true);
    expect(await matchesNewRows()).toHaveLength(1);
  });

  it("answers 500 internal_error when the isActive write fails the same way", async () => {
    const ready = await readyEvent("op132-f3-isactive");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };
    const submitted = await submitOne(ready.event.slug, ready, "f3-isactive");
    await runWorker(submitted, eventContext, FIRST_RUN_MATCHES);

    const before = await profileRow();
    expect(before.status).toBe("processing");
    expect(before.activeSelfieId).toBeNull();
    expect(before.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await matchesNewRows()).toHaveLength(0);

    // The transaction's earlier write: the `isActive` flip on the submitted
    // selfie fails with the same non-duplicate driver error. A swallow here
    // commits an activation whose selfie is not the active one — the same
    // silent-failure class, one write earlier.
    const failure = Object.assign(new Error("not primary"), { code: 91 });
    const selfieWrites: SelfieWrite[] = [];
    const writeSpy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
      this: Collection,
      filter,
      update,
      options
    ) {
      if (this.collectionName === COLLECTIONS.selfies) {
        selfieWrites.push({
          selfieId: String(fieldOf(filter, "_id")),
          askedIsActive: fieldOf(setOf(update), "isActive"),
          inSession: fieldOf(options, "session") !== undefined,
        });
        return Promise.reject(failure);
      }
      return driverUpdateOne.call(this, filter, update, options);
    });

    let response: Response;
    try {
      response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
    } finally {
      writeSpy.mockRestore();
    }

    // Non-vacuity: the transaction opened and reached THIS selfie's `isActive`
    // write, under its session, asking for `true` (§16.4).
    expect(selfieWrites).toEqual([
      { selfieId: submitted.selfieId, askedIsActive: true, inSession: true },
    ]);

    expect(
      response.status,
      "a confirm whose isActive write failed with a non-retry driver error answered " +
        `${String(response.status)}; it must answer the app-wide 500`
    ).toBe(500);
    const error = await errorBody(response);
    expect(error.code).toBe("internal_error");
    expect(error.details).toBeUndefined();

    const after = await profileRow();
    expect(after.status).toBe(before.status);
    expect(after.activeSelfieId).toBeNull();
    expect(after.matchCount).toBe(0);
    expect(await firstMatchNotifiedStamp()).toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(false);
    expect(await matchesNewRows()).toHaveLength(0);

    const retried = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(retried)).toEqual(CONFIRM_KEYS);
    expect(retried.status).toBe("ready");
    expect(retried.selfieId).toBe(submitted.selfieId);
    const recovered = await profileRow();
    expect(recovered.status).toBe("ready");
    expect(recovered.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(recovered.matchCount).toBe(FIRST_RUN_MATCHES);
    expect(await firstMatchNotifiedStamp()).not.toBeNull();
    expect(await selfieIsActive(submitted.selfieId)).toBe(true);
    expect(await matchesNewRows()).toHaveLength(1);
  });
});

/* ── F3.8: the deactivation sweep's failure is a 500, never a masked 200 ──── */

/**
 * The driver's own `Collection#updateMany`, resolved **once at module load**,
 * before any case installs a spy.
 *
 * Resolving it inside the stub would find the spy itself and recurse (the
 * `driverUpdateOne` precedent above): a `RangeError` is also a `500`, so the
 * pin would pass for the wrong reason.
 */
const driverUpdateMany = ((): typeof Collection.prototype.updateMany => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "updateMany");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("expected Collection.prototype.updateMany to be a function");
  }
  return descriptor.value as typeof Collection.prototype.updateMany;
})();

/** A `selfies` sweep the confirmation asked for, as the spy saw it. */
interface SelfieSweep {
  /** The profile whose other selfies the sweep addressed. */
  readonly profileId: string;
  /** The one selfie the sweep excluded — the row being activated (§16.4). */
  readonly excludedSelfieId: string;
  /** The `isActive` the sweep asked for every other row: `false`. */
  readonly askedIsActive: unknown;
  /** True when the write carried a session, i.e. ran inside the transaction. */
  readonly inSession: boolean;
}

/**
 * Every selfie the profile currently has active, oldest `_id` first (§16.4).
 *
 * The count is the pin: §16.4's pointer is singular, so two active rows is a
 * corrupted pointer even while `activeSelfieId` still names one of them.
 *
 * @returns The hex ids of the `isActive: true` selfie rows.
 */
async function activeSelfieIds(): Promise<string[]> {
  const rows = (await app.db
    .collection(COLLECTIONS.selfies)
    .find({ isActive: true })
    .sort({ _id: 1 })
    .toArray()) as unknown as { readonly _id: ObjectId }[];
  return rows.map((row) => row._id.toHexString());
}

/**
 * The confirmation's transaction, with its **deactivation sweep** failing for a
 * reason that is not a duplicate key.
 *
 * **Why this exists.** `F3.6` pins the activation and ADR-0966 pins the
 * `isActive` flip and the outbox insert, but the transaction opens with a
 * fourth write before all three: `selfies.updateMany({ profileId, _id: { $ne:
 * selfieId } }, { $set: { isActive: false } }, { session })` deactivates the
 * profile's previously active selfie (`confirm/route.ts:212-215`, §16.4's
 * single pointer). ADR-0966's §Context enumerates three writes and Reversal
 * condition names them; this sweep is the fourth, and it was unmeasured.
 *
 * Measured on `origin/main` `ed625e6d`: with `Collection.prototype.updateMany`
 * refusing only `COLLECTIONS.selfies` (a non-duplicate driver error), the
 * second confirm answers `500 internal_error` and the profile keeps exactly one
 * active selfie today. Wrap that call in `try { … } catch {}` and the same
 * request answers **`200 status: "ready"`** while the profile ends with **two**
 * active selfies — the previously active one and the new one — and the spec
 * stays `23 passed (23)` (ADR-0968 §Evidence). Both cases above call
 * `updateOne`/`insertOne` stubs, and no shipped fixture ever creates a
 * *previous* active selfie, so neither can see it.
 *
 * The fixture is what makes the sweep non-vacuous: selfie A is submitted,
 * worked and **confirmed** first, so a previously active row exists to
 * deactivate; selfie B is then submitted and worked. The injection is the same
 * driver-level shape as the F3.6 cases — `code: 91`, no
 * `TransientTransactionError` label, so `withTransaction` rethrows on the first
 * attempt — rejected from `Collection.prototype.updateMany` only for
 * `COLLECTIONS.selfies`, every other collection forwarded to the real method
 * resolved once at module load ({@link driverUpdateMany}).
 *
 * Non-vacuity is the recorded attempt: exactly one sweep, naming this profile,
 * excluding **this** selfie (from the filter's `_id.$ne`), asking for
 * `isActive: false`, under the transaction's session. A route that answered
 * `500` before the transaction — or one that never reached the sweep — fails
 * there.
 *
 * What the client sees is the app-wide `500 internal_error` with no `details`,
 * and nothing committed: the profile row keeps its pre-call state exactly —
 * `processing`, `activeSelfieId: A`, `matchCount: 3` (the submit that created
 * B returns the status to `processing` while the pointer and the total still
 * describe A) and its §15.3 watermark — **exactly one** active selfie exists
 * and it is still A, and no `attendee.matches.new` row's count moves. The
 * `notifications` rows are **not** asserted: the fan-out is deferred through
 * `after()`, which throws outside a request scope, so in this harness the
 * claim cannot red on its own (ADR-0965 §Consequences, finding F2).
 */
describe("when the confirmation's deactivation sweep fails for a reason that is not a duplicate key", () => {
  it("answers 500 internal_error and leaves exactly the previous selfie active", async () => {
    const ready = await readyEvent("op132-f3-deactivate");
    const eventContext = { tenantKey: ready.tenantKey, eventId: ready.event.id.toHexString() };

    // The precondition no shipped case creates: one CONFIRMED selfie, so the
    // profile has a previously active row the sweep below must deactivate.
    const previous = await submitOne(ready.event.slug, ready, "f3-deactivate-a");
    await runWorker(previous, eventContext, FIRST_RUN_MATCHES);
    const previousConfirm = await confirm(ready.event.slug, previous.selfieId, ready);
    expect(previousConfirm.status).toBe("ready");

    const submitted = await submitOne(ready.event.slug, ready, "f3-deactivate-b");
    await runWorker(submitted, eventContext, SECOND_RUN_NEW_MATCHES);

    // The second selfie's worker result is on the row, so this confirmation
    // WOULD publish and move the pointer: the pre-call reads are the state a
    // rollback must preserve. The submit that created B put the profile back to
    // `processing` (`upsertProcessingProfile`: "a submit always leaves the
    // profile `processing`"), while the pointer and the cached total still
    // describe A — exactly the state the sweep's failure must not move.
    const before = await profileRow();
    expect(before.status).toBe("processing");
    expect(before.activeSelfieId?.toHexString()).toBe(previous.selfieId);
    expect(before.matchCount).toBe(FIRST_RUN_MATCHES);
    const stamped = await firstDeliveryStamp();
    const outboxBefore = await matchesNewRows();
    expect(outboxBefore).toHaveLength(1);
    expect(outboxBefore[0]?.payload).toMatchObject({ count: FIRST_RUN_MATCHES });
    const activeBefore = await activeSelfieIds();
    expect(activeBefore).toEqual([previous.selfieId]);

    // The transaction's FIRST write is refused, for a reason that is NOT the
    // outbox's duplicate-key collision: a driver error on the deactivation
    // sweep. A swallow here commits the new activation on top of the old one
    // and answers a success envelope.
    const failure = Object.assign(new Error("not primary"), { code: 91 });
    const sweeps: SelfieSweep[] = [];
    const sweepSpy = vi.spyOn(Collection.prototype, "updateMany").mockImplementation(function (
      this: Collection,
      filter,
      update,
      options
    ) {
      if (this.collectionName === COLLECTIONS.selfies) {
        sweeps.push({
          profileId: String(fieldOf(filter, "profileId")),
          excludedSelfieId: String(fieldOf(fieldOf(filter, "_id"), "$ne")),
          askedIsActive: fieldOf(setOf(update), "isActive"),
          inSession: fieldOf(options, "session") !== undefined,
        });
        return Promise.reject(failure);
      }
      return driverUpdateMany.call(this, filter, update, options);
    });

    let response: Response;
    try {
      response = await confirmSelfie(ready.event.slug, submitted.selfieId, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
    } finally {
      sweepSpy.mockRestore();
    }

    // Non-vacuity: the transaction opened and reached ITS deactivation sweep,
    // once, under its session, excluding this selfie and asking for `false`. A
    // route that answered `500` before the transaction — or one that dropped
    // the sweep — fails here.
    expect(sweeps).toEqual([
      {
        profileId: submitted.profileId,
        excludedSelfieId: submitted.selfieId,
        askedIsActive: false,
        inSession: true,
      },
    ]);

    // §0.12: the failure is the app-wide `500`, and the envelope leaks nothing.
    // A `200` here is the §16.4 pointer silently corrupted: two active selfies
    // and a `status: "ready"` that claims the sweep happened.
    expect(
      response.status,
      "a confirm whose deactivation sweep failed with a non-retry driver error answered " +
        `${String(response.status)}; it must answer the app-wide 500`
    ).toBe(500);
    const error = await errorBody(response);
    expect(error.code).toBe("internal_error");
    expect(error.details).toBeUndefined();

    // Nothing moved: the §15.3 row is exactly as the first confirmation left it,
    // and §16.4's pointer is still a single row — the previous selfie's.
    const after = await profileRow();
    expect(after.status).toBe(before.status);
    expect(after.activeSelfieId?.toHexString()).toBe(previous.selfieId);
    expect(after.matchCount).toBe(FIRST_RUN_MATCHES);
    expect((await firstDeliveryStamp()).getTime()).toBe(stamped.getTime());
    expect(await selfieIsActive(previous.selfieId)).toBe(true);
    expect(await selfieIsActive(submitted.selfieId)).toBe(false);
    expect(await activeSelfieIds()).toEqual([previous.selfieId]);

    // The announcement was not re-issued either: the refused request committed
    // no outbox row, so every `count` the attendee already saw is unchanged.
    const outboxAfter = await matchesNewRows();
    expect(outboxAfter.map((row) => row.payload?.count)).toEqual(
      outboxBefore.map((row) => row.payload?.count)
    );

    // The `500` is the injected failure, not a broken fixture: the same request
    // with a healthy driver answers the documented `200`, moves the pointer to
    // the new selfie and leaves exactly one active row (§16.4).
    const retried = await confirm(ready.event.slug, submitted.selfieId, ready);
    expect(keysOf(retried)).toEqual(CONFIRM_KEYS);
    expect(retried.status).toBe("ready");
    expect(retried.selfieId).toBe(submitted.selfieId);
    const recovered = await profileRow();
    expect(recovered.status).toBe("ready");
    expect(recovered.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(recovered.matchCount).toBe(FIRST_RUN_MATCHES + SECOND_RUN_NEW_MATCHES);
    expect(await selfieIsActive(previous.selfieId)).toBe(false);
    expect(await selfieIsActive(submitted.selfieId)).toBe(true);
    expect(await activeSelfieIds()).toEqual([submitted.selfieId]);
    const delivered = await matchesNewRows();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.payload).toMatchObject({ count: SECOND_RUN_NEW_MATCHES });
  });
});
