import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { systemClock } from "@/server/runtime/clock";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  createAttendeeSession,
  entriesSince,
  errorBody,
  grantConsent,
  issueChallenge,
  makeSelfieBytes,
  nextIp,
  outboxLength,
  seedTenant,
  submitBody,
  submitSelfie,
  type IssuedChallenge,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the submit-side refusals that no case pinned
 * (OP-132 review findings **F5** and **F6** of `t_3b8151c3`, Low; contract
 * §6.2/§6.3, Appendix A row 3587; schema §15.3, §16.4; ADR-0807 — whose
 * §Amends names the lane's liveness/selfie records this file extends).
 *
 * **Why this exists.** Every refusal is a client-visible fact, and three of
 * `POST /p/events/{slug}/selfies`' arms were unobserved:
 *
 * - **F5 — the object-miss refusal has no shape of its own.** The handler
 *   verifies the uploaded object with `getObjectStorage().headObject(...)`
 *   (`selfies/route.ts:112`) and lets the port's bare `AppError("not_found")`
 *   through. Every other refusal in these routes names what was missing
 *   (`details.resource`, e.g. the confirm route's `{ resource: "selfie" }`), so
 *   this one is the only `404` an attendee can receive with no machine-readable
 *   detail at all. Two cases pin it apart: the *status and the absence of a
 *   charge* (true today) and the *shape* (red until the handler names the
 *   resource — the one deliberate RED of this card).
 * - **F6 — `expired` was implemented but unpinned.** Only `already_used` and
 *   `mismatch` had cases, so a regression that collapsed the expiry arm into
 *   `mismatch` would have kept the suite green.
 * - **F6 — the five-element challenge cap was unpinned.** The challenge route
 *   stores a `$slice: -5` list on `attendeeEventProfiles` (§15.3, no challenge
 *   collection), so the sixth issue evicts the first; nothing proved the
 *   eviction, and nothing proved that a *kept* challenge still buys an attempt.
 *
 * ## What is pinned
 *
 * - A submit whose `hash` names an object that was never uploaded answers
 *   `404 not_found`, spends no attempt, writes no `selfies` row, enqueues
 *   nothing and leaves the presented challenge unspent.
 * - The same refusal carries `details.resource: "selfie"` — the vocabulary the
 *   confirm route already uses for the same resource. **This case is RED on the
 *   branch cut** (`details` is absent); the GREEN that adds it is the reason the
 *   card may ship a draft PR.
 * - A challenge whose `expiresAt` has passed answers
 *   `409 liveness_challenge_invalid` with `details.reason: "expired"`, and the
 *   refusal charges nothing.
 * - Six issues for one profile leave five stored challenges: the first is gone,
 *   presenting it answers `409 … reason: "mismatch"` (it is no longer a
 *   challenge the caller holds), while the fifth and sixth still answer `202`,
 *   and no submit changes the stored length.
 *
 * ## Assumptions (recorded in ADR-0807)
 *
 * - **`details.resource: "selfie"` is the shape the finding asks for**, because
 *   the confirm route refuses the same resource with exactly that detail
 *   (`…/[selfieId]/confirm/route.ts`). The alternative — a distinct
 *   `"selfie_object"` token — was rejected: the client's own upload is the
 *   missing resource, and §6.3 has no vocabulary for a sub-object.
 * - **The expiry is driven through the clock port**, not by rewriting the
 *   stored row: `systemClock.now()` is the seam the route reads, so spying it to
 *   one second past the challenge's own `expiresAt` exercises the real
 *   comparison (`decideLivenessChallenge`) instead of a hand-edited document.
 * - **The eviction is observed on the stored list** (length + the surviving
 *   ids), because that is the §15.3 fact the route owns; the *refusals* are
 *   observed on the wire. The card asks for the length explicitly.
 * - **The bytes are put through the storage port**, never the presign route:
 *   the three submits in the cap case would otherwise share the
 *   `selfie.submit` bucket (6/hour) with their presigns. One presign belongs to
 *   the uploads suite.
 */

let app: TestApp;

/* ─────────────────────────────── row shapes ──────────────────────────────── */

/** A stored challenge element of the caller's profile (schema §15.3). */
interface StoredChallengeRow {
  readonly challengeId?: ObjectId;
  readonly nonce: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/** The stored `attendee_event_profiles` fields these cases read (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly livenessChallenges?: readonly StoredChallengeRow[];
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-refusal-edges" });
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
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({})) as unknown as ProfileRow | null;
  if (row === null) {
    throw new Error("expected the caller's attendee profile to exist");
  }
  return row;
}

/**
 * The challenges the profile currently holds, in issue order (§15.3).
 *
 * @returns The stored challenge list, or `[]` before the first issue.
 */
async function storedChallenges(): Promise<readonly StoredChallengeRow[]> {
  return (await profileRow()).livenessChallenges ?? [];
}

/**
 * How many `selfies` rows exist — an attempt is one row (§15.3 has no counter).
 *
 * @returns The stored row count.
 */
async function selfieRows(): Promise<number> {
  return await app.db.collection(COLLECTIONS.selfies).countDocuments({});
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/** A published event with a consented caller (the §6.2 precondition met). */
type ReadyEvent = { readonly tenantKey: string; readonly event: SeededEvent } & Caller;

/**
 * Seed a published event, mint an attendee session on it and grant consent.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @returns The event and the caller's handles.
 */
async function readyEvent(prefix: string): Promise<ReadyEvent> {
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
 * @param tag - A per-case tag folded into the bytes, so each selfie is distinct.
 * @returns The object's content hash.
 */
async function uploadedHash(tag: string): Promise<string> {
  const bytes = makeSelfieBytes(tag);
  await getObjectStorage().putObject(
    SELFIE_LOCATION_KEY,
    selfieObjectKey(bytes.hash),
    bytes.bytes,
    "image/jpeg"
  );
  return bytes.hash;
}

/**
 * Issue `count` challenges in order, through the shipped route.
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param count - How many to issue.
 * @returns The issued challenges, oldest first.
 */
async function issueChallenges(
  slug: string,
  caller: Caller,
  count: number
): Promise<readonly IssuedChallenge[]> {
  const issued: IssuedChallenge[] = [];
  for (let index = 0; index < count; index += 1) {
    issued.push(await issueChallenge(slug, caller));
  }
  return issued;
}

/* ────────── F5: the object the submit names was never uploaded ───────────── */

describe("when the submitted selfie's object was never uploaded", () => {
  it("answers 404 not_found and spends neither the challenge nor an attempt", async () => {
    const ready = await readyEvent("op132-f5-miss");
    const bytes = makeSelfieBytes("f5-miss");
    const challenge = await issueChallenge(ready.event.slug, ready);
    const outboxBefore = outboxLength();

    // Non-vacuity: the object really is absent from the port the route reads,
    // so the refusal below cannot be an artefact of a broken fixture.
    await expect(
      getObjectStorage().headObject(SELFIE_LOCATION_KEY, selfieObjectKey(bytes.hash))
    ).rejects.toMatchObject({ code: "not_found" });

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: bytes.hash }, challenge),
    });

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");

    // §6.3: the object is verified *before* anything is charged, so a miss
    // leaves no attempt, no row, no pointer and an unspent challenge.
    expect(await selfieRows()).toBe(0);
    const challenges = await storedChallenges();
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.usedAt).toBeNull();
    expect(entriesSince(outboxBefore)).toHaveLength(0);
  });

  it("names the selfie resource in the refusal's details", async () => {
    const ready = await readyEvent("op132-f5-shape");
    const bytes = makeSelfieBytes("f5-shape");
    const challenge = await issueChallenge(ready.event.slug, ready);

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: bytes.hash }, challenge),
    });

    expect(response.status).toBe(404);
    const error = await errorBody(response);
    expect(error.code).toBe("not_found");

    // The confirm route refuses this same resource with this same detail, so a
    // client that branches on `details.resource` must not have to special-case
    // the submit's object miss. RED on the branch cut: `details` is absent.
    expect(error.details).toEqual({ resource: "selfie" });
  });
});

/* ──────────── F6: an expired challenge is its own refusal reason ─────────── */

describe("when the presented liveness challenge has expired", () => {
  it("answers 409 liveness_challenge_invalid with reason expired and charges nothing", async () => {
    const ready = await readyEvent("op132-f6-expired");
    const hash = await uploadedHash("f6-expired");
    const challenge = await issueChallenge(ready.event.slug, ready);

    // The challenge's own 60 s life has passed when the evidence arrives. The
    // clock port is the seam the route reads, so this exercises the real
    // decision rather than a hand-edited document.
    const oneSecondAfterExpiry = new Date(Date.parse(challenge.expiresAt) + 1_000);
    vi.spyOn(systemClock, "now").mockReturnValue(oneSecondAfterExpiry);

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash }, challenge),
    });

    expect(response.status).toBe(409);
    const error = await errorBody(response);
    expect(error.code).toBe("liveness_challenge_invalid");
    expect(error.details).toMatchObject({ reason: "expired" });

    // A lapsed challenge is not an attempt: the refusal writes nothing.
    expect(await selfieRows()).toBe(0);
    expect((await storedChallenges())[0]?.usedAt).toBeNull();
  });
});

/* ──────────── F6: the profile keeps only the five newest challenges ──────── */

describe("when more challenges are issued than the profile keeps", () => {
  it("evicts the oldest challenge and still accepts the fifth and sixth", async () => {
    const ready = await readyEvent("op132-f6-cap");
    const issued = await issueChallenges(ready.event.slug, ready, 6);
    const first = issued[0];
    const fifth = issued[4];
    const sixth = issued[5];
    if (first === undefined || fifth === undefined || sixth === undefined) {
      throw new Error(`expected six issued challenges, received ${String(issued.length)}`);
    }

    // §15.3: the list is capped, so the document cannot grow without bound.
    const kept = await storedChallenges();
    expect(kept).toHaveLength(5);
    expect(kept.map((row) => String(row.challengeId))).toEqual(
      issued.slice(1).map((challenge) => challenge.challengeId)
    );

    // The evicted challenge is no longer one the caller holds, which is the
    // same observable as evidence bound to another challenge (§6.3).
    const evictedHash = await uploadedHash("f6-cap-evicted");
    const evicted = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: evictedHash }, first),
    });
    expect(evicted.status).toBe(409);
    const evictedError = await errorBody(evicted);
    expect(evictedError.code).toBe("liveness_challenge_invalid");
    expect(evictedError.details).toMatchObject({ reason: "mismatch" });

    // The two most recent challenges still buy an attempt.
    const fifthHash = await uploadedHash("f6-cap-fifth");
    const fifthSubmit = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: fifthHash }, fifth),
    });
    const fifthBody = await bodyOf(fifthSubmit, 202, "POST selfies with the fifth challenge");
    expect(fifthBody.status).toBe("processing");

    const sixthHash = await uploadedHash("f6-cap-sixth");
    const sixthSubmit = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: sixthHash }, sixth),
    });
    const sixthBody = await bodyOf(sixthSubmit, 202, "POST selfies with the sixth challenge");
    expect(sixthBody.status).toBe("processing");

    // Neither the retainable rows nor a submit change the cap.
    expect(await storedChallenges()).toHaveLength(5);
    expect(await selfieRows()).toBe(2);
  });
});
