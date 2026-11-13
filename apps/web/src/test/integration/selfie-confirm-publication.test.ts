import { ObjectId } from "mongodb";
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
 * extends).
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
 *
 * ## Assumptions (recorded in ADR-0805)
 *
 * - **The two confirms are two requests, not one retried request.** Every call
 *   carries its own `Idempotency-Key` (the helper mints a fresh UUID), so a
 *   repeat that is deduped by the idempotency-key store would not satisfy the
 *   pin: the guarantee has to come from the state the first confirm wrote.
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
