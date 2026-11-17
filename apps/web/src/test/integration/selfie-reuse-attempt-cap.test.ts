import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import type { StorageLocationKey } from "@/server/storage/locations";
import type { ObjectHead } from "@/server/storage/object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  handlers,
  issueChallenge,
  makeSelfieBytes,
  nextIp,
  outboxLength,
  requestFor,
  seedTenant,
  submitBody,
  submitSelfie,
  type IssuedChallenge,
  type RouteHandler,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the attempt budget on `POST …/selfies:reuse`, the
 * cap under concurrency, and the §0.11 limit the reuse route must mount
 * (OP-132 review finding **F2**, Medium; contract §0.11, §6.3/§6.4, §14.1;
 * schema §15.3, §16.4; ADR-0803).
 *
 * **Why this exists.** The reuse route is the one selfie write that skips the
 * upload and the liveness challenge, and in the F2 tree it also skipped both
 * limits: it resolved **no** attempt budget (so it minted a `selfies` row and a
 * high-priority `q:selfie` pointer on every call, even for an attendee who had
 * spent every attempt) and declared **no** rate stage at all, while every other
 * POST carries one. §14.1 calls `selfies.per_attendee` "the hard cap", so a
 * reuse that ignores it is a cap bypass. The same route also inherits the
 * submit route's TOCTOU: `selfieAttemptNumbers` reads the stored count *outside*
 * the transaction that inserts the row, so two submits that both observe
 * `used = allowed - 1` can both pass and overshoot.
 *
 * ## What is pinned
 *
 * - a reuse for an attendee whose budget is spent answers `403
 *   plan_limit_exceeded` with `details.entitlementKey` and writes **nothing**
 *   (no `selfies` row, no queue entry);
 * - reuse and submit draw on **one** budget of `selfies.per_attendee`
 *   attempts: a reuse decrements `attemptsRemaining` exactly like a submit, and
 *   when the budget is gone both paths refuse with the same code and key;
 * - five submits raced with `allowed = 3` and two attempts already spent mint
 *   **one** attempt — exactly one `202`, four `403`s, three stored rows — which
 *   is the invariant the read-outside-the-transaction check cannot hold;
 * - the reuse route mounts a §0.11 limiter: its answers carry the three
 *   `RateLimit-*` headers and every call consumes a token of the class it
 *   declared, and past the loosest POST bound in §0.11 (60/min) it answers
 *   `429 rate_limited` with `Retry-After`.
 *
 * ## Assumptions (recorded in ADR-0803)
 *
 * - **`allowed` is the §6.1 fallback of 3.** No `selfies.per_attendee` grant is
 *   seeded, so `selfieAttemptNumbers` answers
 *   `platformSettings.selfie.attemptsAllowed` — the same 3 the submit suite
 *   pins. The budget is read per **profile**, and a profile is per event, so
 *   the attempts spent on the source event do not pay for the target event.
 * - **Seeded attempts in the concurrency case.** `selfie.submit` allows six
 *   calls an hour per attendee and this case needs five live submits, so the
 *   two "already spent" attempts are inserted as `selfies` rows instead of
 *   submitted: two more `selfie.submit` calls would push the race past the
 *   class bound and answer `429` instead of the cap this case is about. The
 *   rows carry the fields the budget read needs (`profileId`, `tenantId`) plus
 *   the §16.4 shape.
 * - **The rate class for reuse is not decided yet.** §0.11 gives no reuse row
 *   (contract-drift card), so case 4 does **not** name a class: it asserts the
 *   headers every limited route emits and that a call is counted, then that the
 *   route refuses past the *loosest* POST class in the table (`write.normal`,
 *   60/min). A stricter class (e.g. `selfie.submit`) passes too.
 * - **One object serves both events.** The selfie object key is
 *   content-addressed (§16.1 `selfies/<sha256>`), so the bytes put for the
 *   source event also satisfy the target event's `headObject`. They are written
 *   through the storage port — the same memory store the presigned PUT targets —
 *   so placing the object does not spend a `selfie.submit` token that the live
 *   calls need; the presign route's own envelope is pinned by the uploads suite.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The §6.1 fallback budget (`platformSettings.selfie.attemptsAllowed`). */
const ATTEMPTS_ALLOWED = 3;

/** The §14.1 entitlement the attempt cap is enforced through. */
const ATTEMPTS_KEY = "selfies.per_attendee";

/** The loosest §0.11 POST class (`write.normal`, 60/min) — a rate floor. */
const LOOSEST_POST_LIMIT_PER_MINUTE = 60;

/** How many submits this file races for one attempt. */
const CONCURRENT_SUBMITS = 5;

/**
 * How long a parked submit waits for its peers before it runs alone.
 *
 * The bound is what keeps the case honest in both directions: five peers arrive
 * within milliseconds on the current tree, so the release is the "all parked"
 * signal, while a fix that serializes the whole handler still terminates.
 */
const SUBMIT_PARK_MS = 300;

/** A stored `selfies` row, as these cases count it (schema §16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly subject: Record<string, unknown>;
}

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject: Record<string, unknown>;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-reuse-cap" });
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
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
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

/** Every stored `selfies` row, oldest first. */
async function selfieRows(): Promise<SelfieRow[]> {
  return (await app.db
    .collection(COLLECTIONS.selfies)
    .find({})
    .sort({ _id: 1 })
    .toArray()) as unknown as SelfieRow[];
}

/** The stored `selfies` rows belonging to one profile. */
async function selfiesOf(profileId: ObjectId): Promise<SelfieRow[]> {
  return (await app.db
    .collection(COLLECTIONS.selfies)
    .find({ profileId })
    .toArray()) as unknown as SelfieRow[];
}

/** The `selfies:reuse` route, resolved with a naming failure if it is absent. */
const reuse: RouteHandler = handlers.reuseSelfie;

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A tenant with `eventCount` published events and one consented attendee. */
interface ReadyEvents {
  readonly tenantKey: string;
  readonly events: readonly SeededEvent[];
  readonly cookie: string;
  readonly sessionId: string;
  readonly ip: string;
}

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/**
 * Seed a tenant, mint one anonymous attendee session and grant consent on
 * every event the tenant published.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @param eventCount - How many events to publish (a reuse case needs two).
 * @returns The tenant key, the events and the caller's handles.
 */
async function readyEvents(prefix: string, eventCount: number): Promise<ReadyEvents> {
  const { tenantKey, events } = await seedTenant(app, prefix, eventCount);
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  for (const event of events) {
    await grantConsent(event.slug, { cookie: session.cookie, ip });
  }
  return { tenantKey, events, cookie: session.cookie, sessionId: session.sessionId, ip };
}

/**
 * Read one seeded event, failing loudly when the tenant published fewer.
 *
 * @param events - The events the tenant published.
 * @param index - The position to read.
 * @returns The event at that position.
 */
function eventAt(events: readonly SeededEvent[], index: number): SeededEvent {
  const event = events.at(index);
  if (event === undefined) {
    throw new Error(`expected the tenant to publish at least ${String(index + 1)} events`);
  }
  return event;
}

/**
 * Put one selfie object through the storage port, exactly where the presigned
 * PUT would have written it.
 *
 * The key is content-addressed (§16.1), so the one object backs every submit
 * and every event in a case. The presign route's own five-key envelope is
 * pinned by the uploads suite; writing the bytes through the same memory port
 * the presigned URL targets keeps this file's calls inside the
 * `selfie.submit` budget the cases have to spend (see the assumptions above).
 *
 * @param tag - A per-case tag folded into the bytes.
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
 * Issue a challenge and submit one selfie against an object that already
 * exists, returning the raw response.
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param upload - The already-uploaded object to declare.
 * @returns The submit response.
 */
async function submitAttempt(
  slug: string,
  caller: Caller,
  upload: { readonly hash: string }
): Promise<Response> {
  const challenge = await issueChallenge(slug, caller);
  return submitSelfie(slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    body: submitBody(upload, challenge),
  });
}

/**
 * Submit one selfie, play the worker, then confirm it (the two-step
 * submission) — the source a reuse case needs.
 *
 * @param slug - The event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param upload - The already-uploaded object to declare.
 * @returns The confirmed selfie's id and its profile.
 */
async function readySelfie(
  slug: string,
  caller: Caller,
  upload: { readonly hash: string }
): Promise<{ selfieId: string; profileId: string }> {
  const submitted = await bodyOf(await submitAttempt(slug, caller, upload), 202, `POST ${slug}`);
  const selfieId = String(submitted.selfieId);
  const profileId = String(submitted.profileId);

  const profile = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: new ObjectId(profileId) })) as ProfileRow | null;
  if (profile === null) {
    throw new Error("expected the submit to create the attendee profile");
  }
  const stored = await app.db
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: new ObjectId(selfieId) });
  if (stored === null) {
    throw new Error("expected the submit to store the selfie");
  }
  await finishSelfieWorker(app, {
    selfieId,
    profileId,
    eventId: String(stored.eventId),
    tenantKey: String(stored.tenantId),
    subject: profile.subject,
    matches: 1,
  });

  const confirmed = await confirmSelfie(slug, selfieId, caller);
  if (confirmed.status !== 200) {
    throw new Error(`expected 200 from the confirm route, received ${String(confirmed.status)}`);
  }
  return { selfieId, profileId };
}

/**
 * Ask to reuse one selfie on one event.
 *
 * @param slug - The addressed event's active access-link slug.
 * @param caller - The caller's credential and client address.
 * @param selfieId - The source selfie's id.
 * @returns The reuse response.
 */
async function reuseOn(slug: string, caller: Caller, selfieId: string): Promise<Response> {
  return reuse(
    requestFor(`/api/v1/p/events/${slug}/selfies:reuse`, "POST", {
      cookie: caller.cookie,
      ip: caller.ip,
      body: { selfieId },
    })
  );
}

/**
 * Read one §0.11 rate-limit header as an integer.
 *
 * @param response - The route answer to read.
 * @param name - The header's (lower-case) name.
 * @returns The header's integer value.
 */
function rateHeader(response: Response, name: string): number {
  const raw = response.headers.get(name);
  if (raw === null) {
    throw new Error(`expected the reuse answer to carry the §0.11 \`${name}\` header`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`expected \`${name}\` to be an integer, received "${raw}"`);
  }
  return value;
}

/* ───────────── case 1: a spent budget refunds nothing to reuse ───────────── */

describe("when the attendee has spent the whole selfie budget on the event", () => {
  it("refuses a reuse with 403 plan_limit_exceeded and mints no selfie and no work", async () => {
    const ready = await readyEvents("op132-f2-spent", 2);
    const sourceEvent = eventAt(ready.events, 0);
    const targetEvent = eventAt(ready.events, 1);
    const caller: Caller = { cookie: ready.cookie, ip: ready.ip };
    const upload = await prepareSelfie("f2-spent");
    const source = await readySelfie(sourceEvent.slug, caller, upload);

    // Every attempt on the target event is spent, so the reuse below has none
    // left: `selfies.per_attendee` is the §14.1 hard cap, not a submit-only cap.
    const spent: number[] = [];
    for (let attempt = 0; attempt < ATTEMPTS_ALLOWED; attempt += 1) {
      spent.push((await submitAttempt(targetEvent.slug, caller, upload)).status);
    }
    expect(spent).toEqual([202, 202, 202]);

    const rowsBefore = await selfieRows();
    expect(rowsBefore).toHaveLength(ATTEMPTS_ALLOWED + 1);
    const queueBefore = outboxLength();

    const response = await reuseOn(targetEvent.slug, caller, source.selfieId);

    expect(response.status).toBe(403);
    const error = await errorBody(response);
    expect(error.code).toBe("plan_limit_exceeded");
    expect(error.details).toMatchObject({ entitlementKey: ATTEMPTS_KEY });

    // The refusal spends nothing: no fourth row on the target event and no
    // `q:selfie` pointer for a worker to claim.
    const targetProfile = (await app.db.collection(COLLECTIONS.attendeeEventProfiles).findOne({
      eventId: targetEvent.id,
      "subject.attendeeSessionId": ready.sessionId,
    })) as ProfileRow | null;
    if (targetProfile === null) {
      throw new Error("expected the submit route to create the attendee profile");
    }
    expect(await selfieRows()).toHaveLength(rowsBefore.length);
    expect(await selfiesOf(targetProfile._id)).toHaveLength(ATTEMPTS_ALLOWED);
    expect(outboxLength()).toBe(queueBefore);
  });
});

/* ──────────── case 2: reuse and submit draw on one budget ────────────────── */

describe("when submits and reuses are mixed on one event", () => {
  it("counts a reuse as an attempt and refuses the fourth call on both paths", async () => {
    const ready = await readyEvents("op132-f2-mixed", 2);
    const sourceEvent = eventAt(ready.events, 0);
    const targetEvent = eventAt(ready.events, 1);
    const caller: Caller = { cookie: ready.cookie, ip: ready.ip };
    const upload = await prepareSelfie("f2-mixed");
    const source = await readySelfie(sourceEvent.slug, caller, upload);

    const firstSubmit = await bodyOf(
      await submitAttempt(targetEvent.slug, caller, upload),
      202,
      "the first submit on the second event"
    );
    expect(firstSubmit.attemptsUsed).toBe(1);
    expect(firstSubmit.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);

    // A reuse is an attempt of the same budget: it spends attempt two.
    const firstReuse = await bodyOf(
      await reuseOn(targetEvent.slug, caller, source.selfieId),
      202,
      "the first reuse on the second event"
    );
    expect(firstReuse.attemptsUsed).toBe(2);
    expect(firstReuse.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 2);

    const lastSubmit = await bodyOf(
      await submitAttempt(targetEvent.slug, caller, upload),
      202,
      "the third attempt on the second event"
    );
    expect(lastSubmit.attemptsUsed).toBe(ATTEMPTS_ALLOWED);
    expect(lastSubmit.attemptsRemaining).toBe(0);

    const fourthSubmit = await submitAttempt(targetEvent.slug, caller, upload);
    expect(fourthSubmit.status).toBe(403);
    expect((await errorBody(fourthSubmit)).code).toBe("plan_limit_exceeded");

    const fourthReuse = await reuseOn(targetEvent.slug, caller, source.selfieId);
    expect(fourthReuse.status).toBe(403);
    const fourthError = await errorBody(fourthReuse);
    expect(fourthError.code).toBe("plan_limit_exceeded");
    expect(fourthError.details).toMatchObject({ entitlementKey: ATTEMPTS_KEY });

    // Three attempts on the target event, plus the confirmed source on the
    // first one: neither refused fourth call created a row.
    expect(await selfieRows()).toHaveLength(ATTEMPTS_ALLOWED + 1);
  });
});

/* ──────────── case 3: concurrency cannot exceed the cap ─────────────────── */

describe("when five submits race for one remaining attempt", () => {
  it("mints exactly one attempt: one 202, four 403 and three stored rows", async () => {
    const ready = await readyEvents("op132-f2-race", 1);
    const event = eventAt(ready.events, 0);
    const caller: Caller = { cookie: ready.cookie, ip: ready.ip };
    const upload = await prepareSelfie("f2-race");

    // One challenge per racer, all issued before the race so the challenge
    // single-use guard cannot be what refuses a loser.
    const challenges: IssuedChallenge[] = [];
    for (let index = 0; index < CONCURRENT_SUBMITS; index += 1) {
      challenges.push(await issueChallenge(event.slug, caller));
    }

    // The two attempts already spent are seeded: `selfie.submit` allows six
    // calls an hour per attendee and this case needs five live submits, so two
    // more calls would answer `429` and hide the cap.
    const owner = (await app.db.collection(COLLECTIONS.attendeeEventProfiles).findOne({
      eventId: event.id,
      "subject.attendeeSessionId": ready.sessionId,
    })) as ProfileRow | null;
    if (owner === null) {
      throw new Error("expected the challenge route to create the attendee profile");
    }
    const now = new Date();
    const spentAttempt = {
      _id: new ObjectId(),
      tenantId: ready.tenantKey,
      eventId: event.id,
      profileId: owner._id,
      subject: owner.subject,
      contentHash: upload.hash,
      assetId: null,
      liveness: { required: true, challengeKind: "gesture" },
      processing: { status: "done", priority: "high" },
      isActive: false,
      createdAt: now,
      expireAt: new Date(now.getTime() + 86_400_000),
    };
    await app.db
      .collection(COLLECTIONS.selfies)
      .insertMany([spentAttempt, { ...spentAttempt, _id: new ObjectId() }]);
    expect(await selfiesOf(owner._id)).toHaveLength(ATTEMPTS_ALLOWED - 1);

    // Walk the five requests to the same starting line. `Promise.all` alone
    // leaves the interleaving to the event loop, and this case was measured
    // passing by luck when the requests happened to run one after another —
    // which is the wrong pin. `headObject` is the submit route's own first step
    // (contract §6.3: the object exists before anything is charged), so parking
    // every request there and releasing them together makes all five cap reads
    // happen before any insert can commit, which is exactly the window the
    // read-outside-the-transaction check cannot close. The release is bounded so
    // a fix that serializes the whole handler still finishes.
    const storage = getObjectStorage();
    const headDescriptor = Object.getOwnPropertyDescriptor(storage, "headObject");
    if (headDescriptor === undefined || typeof headDescriptor.value !== "function") {
      throw new Error("expected the storage port to expose headObject");
    }
    const realHeadObject = headDescriptor.value as (
      location: StorageLocationKey,
      objectKey: string
    ) => Promise<ObjectHead>;
    let parked = 0;
    let releaseParked = (): void => undefined;
    const allParked = new Promise<void>((resolve) => {
      releaseParked = () => {
        resolve();
      };
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, SUBMIT_PARK_MS);
    });
    vi.spyOn(storage, "headObject").mockImplementation(async (location, objectKey) => {
      parked += 1;
      if (parked >= CONCURRENT_SUBMITS) {
        releaseParked();
      }
      await Promise.race([allParked, timeout]);
      return realHeadObject(location, objectKey);
    });

    const queueBefore = outboxLength();
    const responses = await Promise.all(
      challenges.map((challenge) =>
        submitSelfie(event.slug, {
          cookie: caller.cookie,
          ip: caller.ip,
          body: submitBody(upload, challenge),
          idempotencyKey: randomUUID(),
        })
      )
    );

    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);
    expect(
      statuses,
      `the five concurrent submits answered [${statuses.join(",")}]; exactly one may be admitted`
    ).toEqual([202, 403, 403, 403, 403]);

    const refusals = await Promise.all(
      responses
        .filter((response) => response.status === 403)
        .map(async (response) => errorBody(response))
    );
    expect(refusals.map((error) => error.code)).toEqual(
      Array.from({ length: CONCURRENT_SUBMITS - 1 }, () => "plan_limit_exceeded")
    );
    expect(refusals.map((error) => error.details?.entitlementKey)).toEqual(
      Array.from({ length: CONCURRENT_SUBMITS - 1 }, () => ATTEMPTS_KEY)
    );

    // The invariant, stated as stored state rather than as a status: the count
    // never exceeds `allowed`, and only the winner published work.
    expect(await selfiesOf(owner._id)).toHaveLength(ATTEMPTS_ALLOWED);
    expect(outboxLength()).toBe(queueBefore + 1);
  });
});

/* ───────────── case 4: the §0.11 limiter reuse must mount ───────────────── */

describe("when the reuse route is called repeatedly", () => {
  it("carries the §0.11 rate-limit headers and counts every reuse", async () => {
    const ready = await readyEvents("op132-f2-rate", 2);
    const sourceEvent = eventAt(ready.events, 0);
    const targetEvent = eventAt(ready.events, 1);
    const caller: Caller = { cookie: ready.cookie, ip: ready.ip };
    const upload = await prepareSelfie("f2-rate");
    const source = await readySelfie(sourceEvent.slug, caller, upload);

    const first = await reuseOn(targetEvent.slug, caller, source.selfieId);
    expect(first.status).toBe(202);
    const limit = rateHeader(first, "ratelimit-limit");
    const firstRemaining = rateHeader(first, "ratelimit-remaining");
    expect(limit).toBeGreaterThan(0);
    expect(firstRemaining).toBeLessThan(limit);
    expect(rateHeader(first, "ratelimit-reset")).toBeGreaterThanOrEqual(0);
    expect(first.headers.get("retry-after")).toBeNull();

    const second = await reuseOn(targetEvent.slug, caller, source.selfieId);
    expect(second.status).toBe(202);
    const secondRemaining = rateHeader(second, "ratelimit-remaining");
    expect(secondRemaining).toBe(firstRemaining - 1);

    const third = await reuseOn(targetEvent.slug, caller, source.selfieId);
    expect(third.status).toBe(202);
    expect(rateHeader(third, "ratelimit-remaining")).toBe(secondRemaining - 1);
  });

  it("answers 429 rate_limited with Retry-After past the loosest POST bound", async () => {
    const ready = await readyEvents("op132-f2-429", 1);
    const event = eventAt(ready.events, 0);
    const caller: Caller = { cookie: ready.cookie, ip: ready.ip };
    const absent = new ObjectId().toHexString();

    const startedAt = Date.now();
    const responses: Response[] = [];
    for (let call = 0; call < LOOSEST_POST_LIMIT_PER_MINUTE + 1; call += 1) {
      responses.push(await reuseOn(event.slug, caller, absent));
    }
    const elapsedMs = Date.now() - startedAt;

    // Every class in §0.11 has a window of at least a minute, so a run this
    // fast cannot have reset the counter the assertion below relies on.
    expect(
      elapsedMs,
      `driving ${String(responses.length)} calls took ${String(elapsedMs)} ms`
    ).toBeLessThan(60_000);

    const limitedIndex = responses.findIndex((response) => response.status === 429);
    expect(
      limitedIndex,
      `the reuse route never answered 429: statuses ${responses.map((response) => String(response.status)).join(",")}`
    ).toBeGreaterThanOrEqual(0);

    const limited = responses.at(limitedIndex);
    if (limited === undefined) {
      throw new Error("expected a 429 among the reuse answers");
    }
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("ratelimit-limit")).toMatch(/^\d+$/);
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("ratelimit-reset")).toMatch(/^\d+$/);
    expect((await errorBody(limited)).code).toBe("rate_limited");
  });
});
