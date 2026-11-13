import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  entriesSince,
  finishSelfieWorker,
  grantConsent,
  handlers,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  outboxLength,
  requestFor,
  seedTenant,
  submitBody,
  submitSelfie,
  uploadSelfie,
  type IssuedChallenge,
  type SeededEvent,
} from "../helpers/selfie-flow";

/**
 * Integration / contract — the attendee retention gate on the four biometric
 * **writes** (OP-132 F4-R2b, decision `t_7e4d553b`; contract §6.1, §6.3, §6.5,
 * Appendix A.7, Appendix B; [ADR-0813](../../../../../docs/adr/ADR-0813-op132-attendee-retention-gate.md)).
 *
 * **Why this exists.** `events.retentionExpiresAt` is the attendee-facing window
 * and nothing refused on it, so the two write paths that mint a selfie row
 * behaved in the worst possible way after the event's window closed:
 *
 *   - `POST …/selfies` and `…/selfies:reuse` pass `event.retentionExpiresAt`
 *     into `chargeSelfieAttempt` → `insertQueuedSelfie`, which stamps
 *     `expireAt: selfieExpireAt(now, retentionExpiresAt)`. After retention that
 *     instant is **in the past**, so the row is born expired and still queued.
 *   - `selfies_expire_at_ttl` (`keys: [["expireAt", 1]]`,
 *     `expireAfterSeconds: 0`) deletes that row within about a minute, but the
 *     `mediaAssets` owner row (`kind: "selfie"`, `refCount: 1`) and the
 *     `originals/selfies/<sha256>` object have no expiry and no sweep. The only
 *     shipped purge is `DELETE …/consent` (the purge lane's own records, which
 *     ADR-0813 §Context names).
 *
 * So a late submit **deterministically** minted orphaned biometric bytes, and a
 * late reuse re-processed bytes after the addressed event's window had closed.
 * The decision is option (a): the four writes refuse, identically, with
 * `410 gallery_expired`.
 *
 * ## Contract pinned here
 *
 * Once `events.retentionExpiresAt` has elapsed (`now >= deadline`, inclusive —
 * the §6.1 reading that `resolvePublicEventOutcome` already uses), all four
 * writes answer `410 gallery_expired`, `retryable: false`,
 * `details: { expiredAt: <retentionExpiresAt>.toISOString() }` — the identical
 * string §6.1 publishes as `gallery.expiredAt`:
 *
 * | case | endpoint | observed today |
 * | ---- | -------- | -------------- |
 * | W1 | `POST …/liveness/challenges` | `201` + a stored challenge |
 * | W2 | `POST …/selfies/uploads` | `201` presign |
 * | W3 | `POST …/selfies` | `202` + a born-expired row |
 * | W4 | `POST …/selfies:reuse` | `202` + a new row on the expired event |
 *
 * A refusal **writes nothing**: no `selfies` row, no `mediaAssets` row, no
 * `q:selfie` pointer, no attempt charged, and the presented challenge stays
 * unspent (`usedAt: null`). Precedence is pinned beside it: `410` wins over the
 * object `404`, the `409 liveness_challenge_invalid`, the `403
 * plan_limit_exceeded` and the `413 file_too_large`, while `412 consent_required`
 * wins over `410` (the gate sits after `requireAttendeeScope`, which is the
 * consent precondition).
 *
 * Four green controls hold the gate's **shape** so a fix cannot over-reach:
 * C1 the four writes still answer `201/201/202/202` inside the window, C2 a
 * `null` retention (an unlimited plan) never refuses, C3 an expired event with
 * no consent still answers `412`, and C4 a selfie submitted before retention and
 * **confirmed** after it answers its documented `200` envelope — a gate placed
 * inside `requireAttendeeScope` reddens C4, and one placed at the reads or at the
 * confirm reddens it too.
 *
 * ## Assumptions (ADR-0813 §Assumptions)
 *
 * - A1 — the elapsed fixture is a direct `events` `updateOne` on the seeded
 *   `_id`, storing `Date.now() - 1`: the routes read the event through
 *   `resolveEventBySlug`, so the stored row is the deadline they see, and one
 *   millisecond behind "now" is unambiguously elapsed. Equality itself cannot be
 *   pinned here (the routes read `systemClock.now()` live), so the inclusive
 *   boundary is pinned in `apps/web/src/test/unit/retention-gate.test.ts`.
 * - A2 — the challenge and the object a refused submit presents are **real**,
 *   created while the window was open, so W3 cannot pass by refusing a request
 *   that would have failed anyway (the object `404` and the challenge `409` arms
 *   are pinned as precedence cases instead).
 * - A3 — `grantConsent` creates the caller's `attendeeEventProfiles` row
 *   (`linkProfile`, contract §6.2), so W1's "no new row" is measured as "the
 *   profile ids are unchanged and no challenge was stored", not "no profile
 *   exists".
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys §6.3's submit and reuse `202`s carry, sorted. */
const SELFIE_202_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The default attempt budget (§6.1 fallback, `settings.selfie.attemptsAllowed`). */
const ATTEMPTS_ALLOWED = 3;

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-retention" });
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
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/** A tenant, its published events and one anonymous attendee caller. */
interface Fixture {
  readonly tenantKey: string;
  readonly events: readonly SeededEvent[];
  /** The first seeded event — the one every single-event case addresses. */
  readonly event: SeededEvent;
  readonly caller: Caller;
}

/**
 * Seed a tenant, mint one anonymous attendee session and (by default) grant
 * biometric consent on the first event.
 *
 * @param prefix - The suite-local identity/slug prefix.
 * @param options - How many events to publish and whether consent is granted.
 * @returns The tenant, its events and the caller's handles.
 */
async function fixture(
  prefix: string,
  options: { readonly eventCount?: number; readonly consent?: boolean } = {}
): Promise<Fixture> {
  const seeded = await seedTenant(app, prefix, options.eventCount ?? 1);
  const [event] = seeded.events;
  if (event === undefined) {
    throw new Error("expected at least one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  const caller: Caller = { cookie: session.cookie, ip };
  if (options.consent ?? true) {
    await grantConsent(event.slug, caller);
  }
  return { tenantKey: seeded.tenantKey, events: seeded.events, event, caller };
}

/**
 * Store one retention deadline on the seeded event's own row.
 *
 * @param event - The seeded event to move.
 * @param value - The deadline to store, or `null` for an unlimited event.
 */
async function setRetention(event: SeededEvent, value: Date | null): Promise<void> {
  await app.db
    .collection(COLLECTIONS.events)
    .updateOne({ _id: event.id }, { $set: { retentionExpiresAt: value } });
}

/**
 * Move the event's retention deadline one millisecond into the past.
 *
 * @param event - The seeded event to expire.
 * @returns The stored deadline, which the refusal's `details.expiredAt` echoes.
 */
async function expireRetention(event: SeededEvent): Promise<Date> {
  const elapsed = new Date(Date.now() - 1);
  await setRetention(event, elapsed);
  return elapsed;
}

/* ───────────────────────────────── readers ───────────────────────────────── */

/** A stored `attendeeEventProfiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly subject?: Record<string, unknown>;
  readonly livenessChallenges?: readonly StoredChallenge[];
}

/** One stored `livenessChallenges` element of the caller's profile (§15.3). */
interface StoredChallenge {
  readonly challengeId?: unknown;
  readonly usedAt?: Date | null;
}

/** The stored `attendeeEventProfiles` rows of one event. */
async function profilesOf(eventId: ObjectId): Promise<readonly ProfileRow[]> {
  return app.db.collection(COLLECTIONS.attendeeEventProfiles).find({ eventId }).toArray();
}

/** The ids of one event's profiles, so a case can prove the set is unchanged. */
async function profileIds(eventId: ObjectId): Promise<string[]> {
  return (await profilesOf(eventId)).map((row) => row._id.toHexString()).sort();
}

/** The stored profile row, by id. */
async function profileById(profileId: string): Promise<ProfileRow> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: new ObjectId(profileId) })) as unknown as ProfileRow | null;
  if (row === null) {
    throw new Error(`expected a stored attendee profile ${profileId}`);
  }
  return row;
}

/** Every liveness challenge stored on one event's profiles (§15.3). */
async function storedChallenges(eventId: ObjectId): Promise<readonly StoredChallenge[]> {
  const rows = await profilesOf(eventId);
  return rows.flatMap((row) => row.livenessChallenges ?? []);
}

/** How many `selfies` rows one event holds (§16.4 — one attempt is one row). */
async function selfieRows(eventId: ObjectId): Promise<number> {
  return app.db.collection(COLLECTIONS.selfies).countDocuments({ eventId });
}

/** How many `mediaAssets` owner rows carry one content hash as a selfie (§16.1). */
async function assetRows(contentHash: string): Promise<number> {
  return app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ contentHash, kind: "selfie" });
}

/** The stored `selfies` row, by id. */
async function storedSelfie(selfieId: string): Promise<Record<string, unknown>> {
  const row = await app.db.collection(COLLECTIONS.selfies).findOne({ _id: new ObjectId(selfieId) });
  if (row === null) {
    throw new Error(`expected a stored selfie ${selfieId}`);
  }
  return row;
}

/** A refusal, read once from the response body (the envelope plus its status). */
interface Refusal {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
}

/**
 * Read a refusal's envelope off its response.
 *
 * @param response - The refusal under test.
 * @returns The `error` block's code, retry policy and details.
 */
async function refusalOf(response: Response): Promise<Refusal> {
  const parsed = (await response.json()) as Record<string, unknown>;
  const envelope = parsed.error;
  if (envelope === null || typeof envelope !== "object") {
    throw new Error(`expected a refusal envelope, received ${JSON.stringify(parsed)}`);
  }
  const { code, retryable, details } = envelope as {
    code?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  if (typeof code !== "string") {
    throw new Error(`expected the refusal to name a code: ${JSON.stringify(envelope)}`);
  }
  return {
    code,
    retryable: retryable === true,
    details:
      details !== null && typeof details === "object"
        ? (details as Record<string, unknown>)
        : undefined,
  };
}

/* ────────────────────────────── driving the flow ─────────────────────────── */

/**
 * Post one selfie's bytes to the presigned URL, as the browser does.
 *
 * @param bytes - The image bytes the presign body declared.
 * @param url - The presigned `PUT` URL the route minted.
 */
async function putBytes(bytes: Buffer, url: string): Promise<void> {
  const put = await handlers.putObject(
    new Request(url, { method: "PUT", body: new Uint8Array(bytes) })
  );
  if (put.status !== 200) {
    throw new Error(`expected the presigned PUT to answer 200, received ${String(put.status)}`);
  }
}

/**
 * Submit one selfie and finish the worker, leaving a confirmed, reusable row.
 *
 * @param event - The event the selfie belongs to (its window must be open).
 * @param caller - The caller's credential and client address.
 * @param tag - A per-case tag, so no two cases share a content hash.
 * @returns The selfie and profile ids.
 */
async function confirmedSelfie(
  event: SeededEvent,
  caller: Caller,
  tag: string
): Promise<{ selfieId: string; profileId: string }> {
  const challenge = await issueChallenge(event.slug, caller);
  const selfie = makeSelfieBytes(tag);
  const upload = await uploadSelfie(event.slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    bytes: selfie.bytes,
    hash: selfie.hash,
  });
  const response = await submitSelfie(event.slug, {
    cookie: caller.cookie,
    ip: caller.ip,
    body: submitBody(upload, challenge),
  });
  const body = await bodyOf(response, 202, `POST selfies on ${event.slug}`);
  const selfieId = String(body.selfieId);
  const profileId = String(body.profileId);
  const stored = await storedSelfie(selfieId);
  const profile = await profileById(profileId);
  await finishSelfieWorker(app, {
    selfieId,
    profileId,
    eventId: String(stored.eventId),
    tenantKey: String(stored.tenantId),
    subject: profile.subject ?? {},
    matches: 2,
  });
  const confirmed = await confirmSelfie(event.slug, selfieId, caller);
  if (confirmed.status !== 200) {
    throw new Error(`expected 200 from the confirm route, received ${String(confirmed.status)}`);
  }
  return { selfieId, profileId };
}

/**
 * Seed `selfies.per_attendee` rows against the caller's profile, so the next
 * attempt is the `403 plan_limit_exceeded` arm.
 *
 * The budget is a count of `selfies` rows (§15.3 has no counter), and the
 * `selfie.submit` class allows six calls an hour per attendee, so spending the
 * three attempts through the route would hide the refusal behind a `429`.
 *
 * @param event - The event whose caller profile is exhausted.
 * @param tenantKey - The event's tenant (hex), as the write path stores it.
 */
async function exhaustAttempts(event: SeededEvent, tenantKey: string): Promise<void> {
  const [profile] = await profilesOf(event.id);
  if (profile === undefined) {
    throw new Error("expected the challenge route to create the caller's attendee profile");
  }
  const now = new Date();
  const spent = Array.from({ length: ATTEMPTS_ALLOWED }, () => ({
    _id: new ObjectId(),
    tenantId: tenantKey,
    eventId: event.id,
    profileId: profile._id,
    subject: profile.subject ?? {},
    contentHash: makeSelfieBytes("rg-spent-attempt").hash,
    assetId: null,
    liveness: { required: true, challengeKind: "gesture" },
    processing: { status: "done", priority: "high" },
    isActive: false,
    createdAt: now,
    expireAt: new Date(now.getTime() + 86_400_000),
  }));
  await app.db.collection(COLLECTIONS.selfies).insertMany(spent);
}

/* ───────────────── the elapsed window: all four writes refuse ────────────── */

describe("when the event's retention deadline has elapsed", () => {
  it("W1: refuses a liveness challenge with 410 gallery_expired and stores no challenge", async () => {
    // Arrange — inside the window, the caller's consent already exists.
    const ready = await fixture("op132-rg-w1");
    const profilesBefore = await profileIds(ready.event.id);
    const expiredAt = await expireRetention(ready.event);

    // Act
    const response = await handlers.challenge(
      requestFor(`/api/v1/p/events/${ready.event.slug}/liveness/challenges`, "POST", {
        cookie: ready.caller.cookie,
        ip: ready.caller.ip,
        body: {},
        withoutIdempotencyKey: true,
      })
    );

    // Assert — the §6.3 refusal, with the instant §6.1 publishes.
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.retryable).toBe(false);
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });

    // Nothing written: no new profile row and no challenge on the existing one.
    expect(await profileIds(ready.event.id)).toEqual(profilesBefore);
    expect(await storedChallenges(ready.event.id)).toHaveLength(0);
  });

  it("W2: refuses the selfie upload presign with 410 and mints no presigned URL", async () => {
    // Arrange
    const ready = await fixture("op132-rg-w2");
    const expiredAt = await expireRetention(ready.event);
    const { bytes, hash } = makeSelfieBytes("rg-w2");
    const presign = vi.spyOn(getObjectStorage(), "presignPut");

    // Act
    const response = await handlers.presignSelfie(
      requestFor(`/api/v1/p/events/${ready.event.slug}/selfies/uploads`, "POST", {
        cookie: ready.caller.cookie,
        ip: ready.caller.ip,
        body: { hash, size: bytes.byteLength, mimeType: "image/jpeg" },
        withoutIdempotencyKey: true,
      })
    );

    // Assert — no URL is handed out, so the client cannot upload any bytes.
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.retryable).toBe(false);
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });
    expect(presign).not.toHaveBeenCalled();
  });

  it("W3: refuses a submit with 410, minting no selfie, no asset and no queue entry", async () => {
    // Arrange — a real challenge and a real object, both created in the window,
    // so the refusal below cannot be the object-absent or stale-challenge arm.
    const ready = await fixture("op132-rg-w3");
    const challenge = await issueChallenge(ready.event.slug, ready.caller);
    const { bytes, hash } = makeSelfieBytes("rg-w3");
    await uploadSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      bytes,
      hash,
    });
    const expiredAt = await expireRetention(ready.event);
    const outboxBefore = outboxLength();

    // Act
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: submitBody({ hash }, challenge),
    });

    // Assert — the load-bearing case: the orphaned-biometric-bytes path is shut.
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.retryable).toBe(false);
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });

    expect(await selfieRows(ready.event.id)).toBe(0);
    expect(await assetRows(hash)).toBe(0);
    expect(entriesSince(outboxBefore)).toHaveLength(0);
    const challenges = await storedChallenges(ready.event.id);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.usedAt).toBeNull();
  });

  it("W4: refuses a reuse into the expired event and leaves the source selfie active", async () => {
    // Arrange — one confirmed selfie on a second event that is still open, and
    // consent on the event this call addresses.
    const ready = await fixture("op132-rg-w4", { eventCount: 2 });
    const [source, target] = ready.events;
    if (source === undefined || target === undefined) {
      throw new Error("expected two seeded events");
    }
    const caller = ready.caller;
    await grantConsent(source.slug, caller);
    const mine = await confirmedSelfie(source, caller, "rg-w4");
    await grantConsent(target.slug, caller);
    const expiredAt = await expireRetention(target);
    const outboxBefore = outboxLength();

    // Act
    const response = await handlers.reuseSelfie(
      requestFor(`/api/v1/p/events/${target.slug}/selfies:reuse`, "POST", {
        cookie: caller.cookie,
        ip: caller.ip,
        body: { selfieId: mine.selfieId },
      })
    );

    // Assert — nothing minted on the expired event, and the source is untouched.
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.retryable).toBe(false);
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });

    expect(await selfieRows(target.id)).toBe(0);
    expect(entriesSince(outboxBefore)).toHaveLength(0);
    expect((await storedSelfie(mine.selfieId)).isActive).toBe(true);
  });
});

/* ─────────── the gate runs before the route's own input checks ───────────── */

describe("when the event's retention deadline has elapsed and the payload is also refusable", () => {
  it("P1: answers 410 gallery_expired, not the object's 404", async () => {
    // Arrange — the hash names bytes that were never PUT to storage.
    const ready = await fixture("op132-rg-p1");
    const challenge = await issueChallenge(ready.event.slug, ready.caller);
    const { hash } = makeSelfieBytes("rg-p1-never-uploaded");
    const expiredAt = await expireRetention(ready.event);

    // Act
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: submitBody({ hash }, challenge),
    });

    // Assert
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });
  });

  it("P2: answers 410 gallery_expired, not the declared size's 413", async () => {
    // Arrange — a declared size far past `platformSettings.upload.maxFileBytes`.
    const ready = await fixture("op132-rg-p2");
    const expiredAt = await expireRetention(ready.event);
    const { hash } = makeSelfieBytes("rg-p2");

    // Act
    const response = await handlers.presignSelfie(
      requestFor(`/api/v1/p/events/${ready.event.slug}/selfies/uploads`, "POST", {
        cookie: ready.caller.cookie,
        ip: ready.caller.ip,
        body: { hash, size: 1_000_000_000_000, mimeType: "image/jpeg" },
        withoutIdempotencyKey: true,
      })
    );

    // Assert
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });
  });

  it("P3: answers 410 gallery_expired, not the challenge's 409", async () => {
    // Arrange — a real object, but a challenge id the caller does not hold.
    const ready = await fixture("op132-rg-p3");
    const { bytes, hash } = makeSelfieBytes("rg-p3");
    await uploadSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      bytes,
      hash,
    });
    const expiredAt = await expireRetention(ready.event);

    // Act
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: {
        hash,
        challengeId: new ObjectId().toHexString(),
        livenessEvidence: { nonce: "0123456789abcdef0123456789abcdef", frameHashes: ["ab"] },
      },
    });

    // Assert
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });
  });

  it("P4: answers 410 gallery_expired, not the exhausted budget's 403", async () => {
    // Arrange — a real challenge, an uploaded object and a spent budget.
    const ready = await fixture("op132-rg-p4");
    const challenge = await issueChallenge(ready.event.slug, ready.caller);
    const { bytes, hash } = makeSelfieBytes("rg-p4");
    await uploadSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      bytes,
      hash,
    });
    await exhaustAttempts(ready.event, ready.tenantKey);
    const expiredAt = await expireRetention(ready.event);

    // Act
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: submitBody({ hash }, challenge),
    });

    // Assert — the window is checked before the budget, so the client learns the
    // reason it can never fix by waiting or by freeing an attempt.
    expect(response.status).toBe(410);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("gallery_expired");
    expect(refusal.details).toEqual({ expiredAt: expiredAt.toISOString() });
  });
});

/* ─────────────────────────────── green controls ──────────────────────────── */

describe("when the retention deadline is still in the future", () => {
  it("C1: the four writes answer 201, 201, 202 and 202, exactly as today", async () => {
    // Arrange — two events, both inside their retention window.
    const ready = await fixture("op132-rg-c1", { eventCount: 2 });
    const [source, target] = ready.events;
    if (source === undefined || target === undefined) {
      throw new Error("expected two seeded events");
    }
    const caller = ready.caller;

    // Act 1 — the challenge.
    const challengeResponse = await handlers.challenge(
      requestFor(`/api/v1/p/events/${source.slug}/liveness/challenges`, "POST", {
        cookie: caller.cookie,
        ip: caller.ip,
        body: {},
        withoutIdempotencyKey: true,
      })
    );
    // Assert 1
    expect(challengeResponse.status).toBe(201);
    const challengeBody = (await challengeResponse.json()) as Record<string, unknown>;
    const challenge: IssuedChallenge = {
      challengeId: String(challengeBody.challengeId),
      challengeKind: String(challengeBody.challengeKind),
      nonce: String(challengeBody.nonce),
      expiresAt: String(challengeBody.expiresAt),
    };

    // Act 2 — the upload presign, then the PUT it authorises.
    const { bytes, hash } = makeSelfieBytes("rg-c1");
    const presignResponse = await handlers.presignSelfie(
      requestFor(`/api/v1/p/events/${source.slug}/selfies/uploads`, "POST", {
        cookie: caller.cookie,
        ip: caller.ip,
        body: { hash, size: bytes.byteLength, mimeType: "image/jpeg" },
        withoutIdempotencyKey: true,
      })
    );
    // Assert 2
    expect(presignResponse.status).toBe(201);
    const presignBody = (await presignResponse.json()) as Record<string, unknown>;
    const url = presignBody.url;
    if (typeof url !== "string") {
      throw new Error(`expected the presign body to carry a url: ${JSON.stringify(presignBody)}`);
    }
    await putBytes(bytes, url);

    // Act 3 — the submit.
    const submitResponse = await submitSelfie(source.slug, {
      cookie: caller.cookie,
      ip: caller.ip,
      body: submitBody({ hash }, challenge),
    });
    // Assert 3
    expect(submitResponse.status).toBe(202);
    const submitted = (await submitResponse.json()) as Record<string, unknown>;
    expect(keysOf(submitted)).toEqual(SELFIE_202_KEYS);
    expect(submitted.status).toBe("processing");

    // Act 4 — the confirmation (so the selfie is reusable), then the reuse.
    const confirmed = await confirmSelfie(source.slug, String(submitted.selfieId), caller);
    expect(confirmed.status).toBe(200);
    await grantConsent(target.slug, caller);
    const reuseResponse = await handlers.reuseSelfie(
      requestFor(`/api/v1/p/events/${target.slug}/selfies:reuse`, "POST", {
        cookie: caller.cookie,
        ip: caller.ip,
        body: { selfieId: String(submitted.selfieId) },
      })
    );
    // Assert 4
    expect(reuseResponse.status).toBe(202);
    expect(keysOf((await reuseResponse.json()) as Record<string, unknown>)).toEqual(
      SELFIE_202_KEYS
    );
  });

  it("C2: an unlimited event (a null deadline) lets the flow proceed", async () => {
    // Arrange — the plan leaves no deadline at all.
    const ready = await fixture("op132-rg-c2");
    await setRetention(ready.event, null);
    const challenge = await issueChallenge(ready.event.slug, ready.caller);
    const { bytes, hash } = makeSelfieBytes("rg-c2");

    // Act
    const upload = await uploadSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      bytes,
      hash,
    });
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: submitBody(upload, challenge),
    });

    // Assert
    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, `POST selfies on ${ready.event.slug}`);
    expect(keysOf(body)).toEqual(SELFIE_202_KEYS);
    expect(await selfieRows(ready.event.id)).toBe(1);
  });

  it("C3: an expired event with no consent answers 412 consent_required, not 410", async () => {
    // Arrange — consent is the hard precondition (§6.2), so it is checked first.
    const ready = await fixture("op132-rg-c3", { consent: false });
    await expireRetention(ready.event);
    const { hash } = makeSelfieBytes("rg-c3");

    // Act
    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      body: {
        hash,
        challengeId: new ObjectId().toHexString(),
        livenessEvidence: { nonce: "0123456789abcdef0123456789abcdef", frameHashes: ["ab"] },
      },
    });

    // Assert
    expect(response.status).toBe(412);
    const refusal = await refusalOf(response);
    expect(refusal.code).toBe("consent_required");
  });

  it("C4: a selfie submitted before retention and confirmed after it answers its 200 envelope", async () => {
    // Arrange — the attempt is created inside the window, the worker finishes,
    // and the confirmation arrives after the deadline.
    const ready = await fixture("op132-rg-c4");
    const challenge = await issueChallenge(ready.event.slug, ready.caller);
    const { bytes, hash } = makeSelfieBytes("rg-c4");
    const upload = await uploadSelfie(ready.event.slug, {
      cookie: ready.caller.cookie,
      ip: ready.caller.ip,
      bytes,
      hash,
    });
    const submitted = await bodyOf(
      await submitSelfie(ready.event.slug, {
        cookie: ready.caller.cookie,
        ip: ready.caller.ip,
        body: submitBody(upload, challenge),
      }),
      202,
      `POST selfies on ${ready.event.slug}`
    );
    const selfieId = String(submitted.selfieId);
    const profileId = String(submitted.profileId);
    const profile = await profileById(profileId);
    await finishSelfieWorker(app, {
      selfieId,
      profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject ?? {},
      matches: 0,
    });
    await expireRetention(ready.event);

    // Act
    const response = await confirmSelfie(ready.event.slug, selfieId, ready.caller);

    // Assert — the documented envelope, and the row really was activated: a gate
    // inside `requireAttendeeScope` would refuse here instead.
    expect(response.status).toBe(200);
    const body = await bodyOf(response, 200, `POST confirm on ${ready.event.slug}`);
    expect(keysOf(body)).toEqual(SELFIE_202_KEYS);
    expect(body.status).toBe("ready");
    expect((await storedSelfie(selfieId)).isActive).toBe(true);
  });
});
