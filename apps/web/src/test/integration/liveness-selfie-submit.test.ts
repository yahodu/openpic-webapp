import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  bodyOf,
  confirmSelfie,
  createAttendeeSession,
  entriesSince,
  errorBody,
  finishSelfieWorker,
  grantConsent,
  issueChallenge,
  keysOf,
  makeSelfieBytes,
  nextIp,
  outboxLength,
  requestFor,
  seedTenant,
  submitBody,
  submitHappyPath,
  submitSelfie,
  uploadSelfie,
  withdrawConsent,
  type SeededEvent,
  type UploadedSelfie,
  handlers,
} from "../helpers/selfie-flow";
import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { getObjectStorage } from "@/server/storage/get-object-storage";

/**
 * Integration / contract — liveness challenge, selfie submit, the attempt
 * budget and the two-step confirmation
 * (OP-132 I1–I4, I7–I12; contract §6.2, §6.3, §6.4, §10.4, §14.1, §18.1/§18.2;
 * schema §15.3, §16.4, §17.5, §18.1; green card §1–§6).
 *
 * **Why this exists.** The selfie is the one write that turns an anonymous
 * visitor into a matching data subject, so it carries the whole lane's
 * obligations at once: a consent gate that refuses before anything else
 * (§6.2), a single-use liveness challenge (§6.3), a hard per-attendee attempt
 * budget (§14.1), a `q:selfie` high-priority pointer (§10.4/§18.1), and a
 * **two-step** activation in which nothing the worker found is visible,
 * counted or notified until the attendee confirms (green card §5).
 *
 * ## Contract expected of the implementation
 *
 * - `POST /api/v1/p/events/{slug}/liveness/challenges` (auth `attendee`, rate
 *   `liveness.challenge`, consent required) → `201`
 *   `{challengeId, challengeKind: "gesture", spec: {sequence, timeoutMs},
 *   nonce, expiresAt}`; no consent → `412 consent_required` with the A.7
 *   details.
 * - `POST /api/v1/p/events/{slug}/selfies/uploads` (auth `attendee`) →
 *   `201 {method: "PUT", url, headers, expiresAt, confirmUrl}` for a single
 *   PUT; a declared `size` over `platformSettings.upload.maxFileBytes` →
 *   `413 file_too_large {maxBytes, actualBytes}`.
 * - `POST /api/v1/p/events/{slug}/selfies` (auth `attendee`, idempotency
 *   required) takes `{hash, challengeId, livenessEvidence: {nonce,
 *   frameHashes}}` and answers `202` with exactly
 *   `{selfieId, profileId, status: "processing", pollUrl,
 *   pollIntervalMs: 2000, attemptsUsed, attemptsRemaining}`. It inserts one
 *   `selfies` row (`processing.status: "queued"`, `processing.priority:
 *   "high"`, `queueRef.provider: "memory"` under the test env), upserts the
 *   `attendeeEventProfiles` row (`status: "processing"`, `activeSelfieId:
 *   null`, `matchCount: 0`) and enqueues **one** §10.4 envelope on `q:selfie`
 *   with `kind: "selfie"`, `priority: "high"` and `id` = the selfie id.
 * - `POST /api/v1/p/events/{slug}/selfies/{selfieId}/confirm` (auth
 *   `attendee`) → `200` with the same seven keys, `status: "ready"` once the
 *   worker's embedding is on the row, and it is the **only** place the profile
 *   becomes `ready`, `activeSelfieId` is set, `isActive` flips, `matchCount`
 *   reflects the stored `faceMatches` and `attendee.matches.new` is emitted.
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **Consent is checked before anything else**, including object existence
 *   and challenge validity — §6.2 calls it the hard precondition of *every*
 *   selfie endpoint. The I1 submit therefore presents a challenge id and a hash
 *   that do not exist and must still be refused `412`, not `404`/`409`.
 * - **The submit body has no `uploadSessionId`.** §6.3 says selfies are
 *   "always single-PUT", so there is no resumable session to name; the object
 *   is identified by its content hash.
 * - **`nonce` binds the evidence** (§6.3 gains one key): `livenessEvidence` is
 *   the `{nonce, frameHashes}` pair and a nonce from a *different* challenge is
 *   the `409 liveness_challenge_invalid {reason: "mismatch"}` of I12.
 * - **The attempt budget is the profile's stored selfie count** against the
 *   tenant's `selfies.per_attendee` limit, falling back to
 *   `platformSettings.selfie.attemptsAllowed` (3) exactly as §6.1's
 *   `attemptsAllowed` advertises. §15.3 has no attempt counter; schema wins.
 * - **The colon verb of the green card maps to a nested segment.** Next cannot
 *   express a folder named `[selfieId]:confirm`, so the confirmation is
 *   `POST …/selfies/{selfieId}/confirm` (the `me/sessions:revoke-all`
 *   precedent keeps the colon form for static verbs only).
 * - **The worker is simulated, not stubbed.** The queue consumer is a later
 *   card, so each confirmation case writes what that worker writes (embedding,
 *   quality verdict, `processing.status: "done"`, one `faceMatches` row per
 *   photo) through `finishSelfieWorker`, and then observes the confirm route.
 *   The rows carry no publication marker: "provisional" is a property of the
 *   two-step submission, not of the row.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The seven keys §6.3's `202` and the confirm's `200` carry, sorted. */
const SUBMIT_KEYS = [
  "attemptsRemaining",
  "attemptsUsed",
  "pollIntervalMs",
  "pollUrl",
  "profileId",
  "selfieId",
  "status",
];

/** The five keys §6.3 gives the selfie presign envelope, sorted. */
const PRESIGN_KEYS = ["confirmUrl", "expiresAt", "headers", "method", "url"];

/** The default attempt budget (§6.1 fallback, `settings.selfie.attemptsAllowed`). */
const ATTEMPTS_ALLOWED = 3;

/** The §6.3 poll cadence while a selfie is processing. */
const POLL_INTERVAL_MS = 2000;

/** The entitlement key the attempt cap is enforced through (§14.1). */
const ATTEMPTS_KEY = "selfies.per_attendee";

/** The one place the "new photos of you" arrival is recorded (§7.7). */
const MATCHES_NEW_EVENT = "attendee.matches.new";

/** A declared size far over `platformSettings.upload.maxFileBytes` (100 MiB). */
const OVERSIZE_BYTES = 200_000_000;

/** A stored `selfies` row, as these cases read it (schema §16.4). */
interface SelfieRow {
  readonly _id: ObjectId;
  readonly profileId: ObjectId;
  readonly eventId: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly isActive?: boolean;
  readonly embedding?: unknown;
  readonly processing: {
    readonly status: string;
    readonly priority: string;
    readonly queueRef?: { readonly queueKey: string; readonly provider: string };
  };
}

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly activeSelfieId: ObjectId | null;
  readonly matchCount: number;
  readonly subject: Record<string, unknown>;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-selfie" });
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

/* ─────────────────────────────── readers ─────────────────────────────────── */

/** The stored `selfies` rows, oldest first. */
async function selfieRows(): Promise<SelfieRow[]> {
  return (await app.db
    .collection("selfies")
    .find({})
    .sort({ _id: 1 })
    .toArray()) as unknown as SelfieRow[];
}

/** The single stored `attendee_event_profiles` row these cases expect. */
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

/** The stored `attendee.matches.new` outbox rows. */
async function matchesNewRows(): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: MATCHES_NEW_EVENT })
    .toArray();
}

/** One event with an attendee session that has granted consent. */
interface ReadyEvent {
  readonly tenantKey: string;
  readonly event: SeededEvent;
  readonly cookie: string;
  readonly sessionId: string;
  readonly ip: string;
}

/**
 * Seed a published event, mint an attendee session on it and grant consent.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @param eventCount - How many events the tenant publishes.
 * @returns The first event and the granted caller's handles.
 */
async function readyEvent(prefix: string, eventCount = 1): Promise<ReadyEvent> {
  const { tenantKey, events } = await seedTenant(app, prefix, eventCount);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  await grantConsent(event.slug, { cookie: session.cookie, ip });
  return { tenantKey, event, cookie: session.cookie, sessionId: session.sessionId, ip };
}

/** The §6.3 address of one selfie's confirmation. */
function confirmPath(slug: string, selfieId: string): string {
  return `/api/v1/p/events/${slug}/selfies/${selfieId}/confirm`;
}

/* ─────────────────────── I1: consent is the hard gate ────────────────────── */

describe("when the attendee has not granted biometric consent", () => {
  it("refuses the liveness challenge with 412 consent_required and names the policy", async () => {
    const { events } = await seedTenant(app, "op132-i1a");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    const session = await createAttendeeSession(app, ip);

    const response = await handlers.challenge(
      requestFor(`/api/v1/p/events/${event.slug}/liveness/challenges`, "POST", {
        cookie: session.cookie,
        ip,
        body: {},
        withoutIdempotencyKey: true,
      })
    );

    expect(response.status).toBe(412);
    const error = await errorBody(response);
    expect(error.code).toBe("consent_required");
    expect(error.details?.purpose).toBe("biometric_processing");
    expect(String(error.details?.requiredPolicyVersion)).toMatch(/\S/);
    expect(String(error.details?.policyUrl)).toMatch(/^https:\/\//);
  });

  it("refuses the selfie submit with 412 consent_required before looking at the object", async () => {
    const { events } = await seedTenant(app, "op132-i1b");
    const [event] = events;
    if (event === undefined) {
      throw new Error("expected one seeded event");
    }
    const ip = nextIp();
    const session = await createAttendeeSession(app, ip);

    const response = await submitSelfie(event.slug, {
      cookie: session.cookie,
      ip,
      body: {
        hash: "0".repeat(64),
        challengeId: new ObjectId().toHexString(),
        livenessEvidence: { nonce: "0".repeat(32), frameHashes: ["1".repeat(64)] },
      },
    });

    expect(response.status).toBe(412);
    expect((await errorBody(response)).code).toBe("consent_required");
    expect(await selfieRows()).toHaveLength(0);
  });
});

/* ──────────────────────── I2: a challenge is single-use ──────────────────── */

describe("when a liveness challenge is presented twice", () => {
  it("accepts the first submit and refuses the reuse with 409 already_used", async () => {
    const ready = await readyEvent("op132-i2");
    const challenge = await issueChallenge(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    const first = makeSelfieBytes("i2-first");
    const firstUpload = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: first.bytes,
      hash: first.hash,
    });
    const accepted = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody(firstUpload, challenge),
    });
    expect(accepted.status).toBe(202);

    const second = makeSelfieBytes("i2-second");
    const secondUpload = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: second.bytes,
      hash: second.hash,
    });
    const reused = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody(secondUpload, challenge),
    });

    expect(reused.status).toBe(409);
    const error = await errorBody(reused);
    expect(error.code).toBe("liveness_challenge_invalid");
    expect(error.details).toMatchObject({ reason: "already_used" });
    // The refusal wrote nothing: the reuse is not a second attempt.
    expect(await selfieRows()).toHaveLength(1);
  });
});

/* ────────────────────────── I3: the attempt budget ───────────────────────── */

describe("when an attendee has spent the selfie attempts", () => {
  it("refuses the fourth attempt with 403 plan_limit_exceeded", async () => {
    const ready = await readyEvent("op132-i3");
    const bytes = makeSelfieBytes("i3-one");
    // One object, four submissions: the same content hash is a legitimate
    // retry, and it keeps this case inside the per-session `selfie.submit`
    // bucket (6/hour) that the presign and submit routes share.
    const upload: UploadedSelfie = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });

    const statuses: number[] = [];
    const used: unknown[] = [];
    for (let attempt = 0; attempt < ATTEMPTS_ALLOWED; attempt += 1) {
      const challenge = await issueChallenge(ready.event.slug, {
        cookie: ready.cookie,
        ip: ready.ip,
      });
      const response = await submitSelfie(ready.event.slug, {
        cookie: ready.cookie,
        ip: ready.ip,
        body: submitBody(upload, challenge),
      });
      statuses.push(response.status);
      used.push(((await response.json()) as Record<string, unknown>).attemptsUsed);
    }
    expect(statuses).toEqual([202, 202, 202]);
    expect(used).toEqual([1, 2, 3]);

    const fourthChallenge = await issueChallenge(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    const refused = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody(upload, fourthChallenge),
    });

    expect(refused.status).toBe(403);
    const error = await errorBody(refused);
    expect(error.code).toBe("plan_limit_exceeded");
    expect(error.details).toMatchObject({ entitlementKey: ATTEMPTS_KEY });
    expect(await selfieRows()).toHaveLength(ATTEMPTS_ALLOWED);
  });

  it("gives a second attendee on the same event their own budget", async () => {
    const first = await readyEvent("op132-i3b");
    const bytes = makeSelfieBytes("i3b-one");
    const firstUpload = await uploadSelfie(first.event.slug, {
      cookie: first.cookie,
      ip: first.ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });
    for (let attempt = 0; attempt < ATTEMPTS_ALLOWED; attempt += 1) {
      const challenge = await issueChallenge(first.event.slug, {
        cookie: first.cookie,
        ip: first.ip,
      });
      const response = await submitSelfie(first.event.slug, {
        cookie: first.cookie,
        ip: first.ip,
        body: submitBody(firstUpload, challenge),
      });
      expect(response.status).toBe(202);
    }

    const secondIp = nextIp();
    const secondSession = await createAttendeeSession(app, secondIp);
    await grantConsent(first.event.slug, { cookie: secondSession.cookie, ip: secondIp });
    const secondChallenge = await issueChallenge(first.event.slug, {
      cookie: secondSession.cookie,
      ip: secondIp,
    });
    const secondBytes = makeSelfieBytes("i3b-two");
    const secondUpload = await uploadSelfie(first.event.slug, {
      cookie: secondSession.cookie,
      ip: secondIp,
      bytes: secondBytes.bytes,
      hash: secondBytes.hash,
    });
    const response = await submitSelfie(first.event.slug, {
      cookie: secondSession.cookie,
      ip: secondIp,
      body: submitBody(secondUpload, secondChallenge),
    });

    expect(response.status).toBe(202);
    const body = await bodyOf(response, 202, "the second attendee's submit");
    expect(body.attemptsUsed).toBe(1);
    expect(body.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
  });
});

/* ─────────────────── I4/I7: the pointer a worker would claim ─────────────── */

describe("when a selfie is submitted", () => {
  it("answers 202 with the §6.3 envelope and stores the selfie as queued/high", async () => {
    const ready = await readyEvent("op132-i4");
    const before = outboxLength();

    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i4",
    });

    expect(keysOf(submitted.body)).toEqual(SUBMIT_KEYS);
    expect(submitted.body.status).toBe("processing");
    expect(submitted.body.pollUrl).toBe(`/api/v1/p/events/${ready.event.slug}/me`);
    expect(submitted.body.pollIntervalMs).toBe(POLL_INTERVAL_MS);
    expect(submitted.body.attemptsUsed).toBe(1);
    expect(submitted.body.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);

    const [selfie] = await selfieRows();
    if (selfie === undefined) {
      throw new Error("expected one stored selfie");
    }
    expect(selfie.processing.status).toBe("queued");
    expect(selfie.processing.priority).toBe("high");
    expect(selfie.processing.queueRef).toMatchObject({
      queueKey: "q:selfie",
      provider: "memory",
    });
    expect(selfie.subject).toMatchObject({
      kind: "anonymous",
      attendeeSessionId: ready.sessionId,
    });
    expect(selfie.isActive).not.toBe(true);

    // The pointer is the work: one §10.4 envelope on the high-priority key.
    const queued = entriesSince(before);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.queueKey).toBe("q:selfie");
    expect(queued[0]?.envelope).toMatchObject({
      v: 1,
      kind: "selfie",
      priority: "high",
      id: submitted.selfieId,
      eventId: ready.event.id.toHexString(),
      tenantId: ready.tenantKey,
      attempt: 0,
    });
    expect(queued[0]?.envelope.traceId).toMatch(/\S/);
    expect(queued[0]?.envelope.spaceKey).toMatch(/\S/);
  });

  it("enqueues the work at submit time, not at confirmation", async () => {
    const ready = await readyEvent("op132-i7");
    const before = outboxLength();

    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i7",
    });

    // The queue item must exist while the selfie is still unconfirmed: the
    // worker starts on submit, exactly as green card §5 requires.
    expect(entriesSince(before)).toHaveLength(1);

    const profile = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject,
      matches: 3,
    });
    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    expect(confirmed.status).toBe(200);

    // Confirmation publishes; it never enqueues a second job.
    expect(entriesSince(before)).toHaveLength(1);
  });
});

/* ─────────────── I8/I9: confirmation is what publishes the result ────────── */

describe("when the worker has finished but the attendee has not confirmed", () => {
  it("keeps the gallery empty: no ready profile, no count and no notification", async () => {
    const ready = await readyEvent("op132-i8");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i8",
    });
    const before = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: before.subject,
      matches: 3,
    });

    const profile = await profileRow();
    expect(profile.status).toBe("processing");
    expect(profile.activeSelfieId).toBeNull();
    expect(profile.matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);

    const [selfie] = await selfieRows();
    if (selfie === undefined) {
      throw new Error("expected one stored selfie");
    }
    expect(selfie.isActive).not.toBe(true);
    // The worker's own output is on the row; it is simply not published.
    expect(selfie.embedding).toBeDefined();
  });

  it("returns status ready straight away on confirmation and emits attendee.matches.new", async () => {
    const ready = await readyEvent("op132-i9");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i9",
    });
    const seeded = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: seeded.subject,
      matches: 3,
    });
    expect(await matchesNewRows()).toHaveLength(0);

    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    const body = await bodyOf(confirmed, 200, "POST selfie confirm");
    expect(keysOf(body)).toEqual(SUBMIT_KEYS);
    expect(body.status).toBe("ready");
    expect(body.selfieId).toBe(submitted.selfieId);
    expect(body.profileId).toBe(submitted.profileId);
    expect(body.attemptsUsed).toBe(1);
    expect(body.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);

    const profile = await profileRow();
    expect(profile.status).toBe("ready");
    expect(profile.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(profile.matchCount).toBe(3);

    const [selfie] = await selfieRows();
    expect(selfie?.isActive).toBe(true);

    const events = await matchesNewRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      eventId: ready.event.id.toHexString(),
      count: 3,
    });
  });

  it("returns status processing when confirmed before the worker has written a result", async () => {
    const ready = await readyEvent("op132-i9b");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i9b",
    });

    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    const body = await bodyOf(confirmed, 200, "POST selfie confirm");
    expect(body.status).toBe("processing");
    expect(body.attemptsUsed).toBe(1);

    const profile = await profileRow();
    expect(profile.activeSelfieId?.toHexString()).toBe(submitted.selfieId);
    expect(profile.matchCount).toBe(0);
    expect(await matchesNewRows()).toHaveLength(0);
  });
});

/* ───────────────── I10: preprocess plus confirm is one attempt ────────────── */

describe("when the same selfie is submitted and then confirmed", () => {
  it("counts one attempt, not two", async () => {
    const ready = await readyEvent("op132-i10");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "i10",
    });
    expect(submitted.body.attemptsUsed).toBe(1);

    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    const body = await bodyOf(confirmed, 200, "POST selfie confirm");
    expect(body.attemptsUsed).toBe(1);
    expect(body.attemptsRemaining).toBe(ATTEMPTS_ALLOWED - 1);
    // One attempt is one stored selfie: confirmation activates the row the
    // preprocess created, it never inserts a second one (§15.3 has no counter).
    expect(await selfieRows()).toHaveLength(1);
    const profile = await profileRow();
    expect(profile._id.toHexString()).toBe(submitted.profileId);
  });
});

/* ─────────────────────── I11/I12: the evidence contract ──────────────────── */

describe("when the submitted liveness evidence is missing or bound to another challenge", () => {
  it("refuses a submit with no evidence at all with 422 validation_failed", async () => {
    const ready = await readyEvent("op132-i11");
    const challenge = await issueChallenge(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    const bytes = makeSelfieBytes("i11");
    const upload = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: { hash: upload.hash, challengeId: challenge.challengeId },
    });

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");
    expect(await selfieRows()).toHaveLength(0);
  });

  it("refuses evidence bound to a different challenge with 409 mismatch", async () => {
    const ready = await readyEvent("op132-i12");
    const mine = await issueChallenge(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    const other = await issueChallenge(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    const bytes = makeSelfieBytes("i12");
    const upload = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody(upload, other, { challengeId: mine.challengeId }),
    });

    expect(response.status).toBe(409);
    const error = await errorBody(response);
    expect(error.code).toBe("liveness_challenge_invalid");
    expect(error.details).toMatchObject({ reason: "mismatch" });
    expect(await selfieRows()).toHaveLength(0);
  });
});

/* ─────────────────────── the §6.3 upload presign envelope ────────────────── */

describe("when a selfie upload is presigned", () => {
  it("answers the five-key single-PUT envelope", async () => {
    const ready = await readyEvent("op132-presign");
    const bytes = makeSelfieBytes("presign");
    const upload = await uploadSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      bytes: bytes.bytes,
      hash: bytes.hash,
    });

    expect(keysOf(upload.presign)).toEqual(PRESIGN_KEYS);
    expect(upload.presign.method).toBe("PUT");
    const url = new URL(String(upload.presign.url));
    expect(url.origin).toMatch(/^https?:\/\//);
    // §0.15: the URL is an opaque token, never the object's coordinates.
    expect(url.pathname).not.toContain(upload.hash);
    const confirmUrl = String(upload.presign.confirmUrl);
    expect(confirmUrl.endsWith(`/p/events/${ready.event.slug}/selfies`)).toBe(true);
  });

  it("refuses a declared size over the upload ceiling with 413 file_too_large", async () => {
    const ready = await readyEvent("op132-presign-413");
    const response = await handlers.presignSelfie(
      requestFor(`/api/v1/p/events/${ready.event.slug}/selfies/uploads`, "POST", {
        cookie: ready.cookie,
        ip: ready.ip,
        body: { hash: "a".repeat(64), size: OVERSIZE_BYTES, mimeType: "image/jpeg" },
        withoutIdempotencyKey: true,
      })
    );

    expect(response.status).toBe(413);
    const error = await errorBody(response);
    expect(error.code).toBe("file_too_large");
    expect(error.details).toMatchObject({ actualBytes: OVERSIZE_BYTES });
  });
});

/* ────────────────────────────── the confirm path ─────────────────────────── */

describe("the confirmation route", () => {
  it("is addressed at …/selfies/{selfieId}/confirm and refuses a caller without a session", async () => {
    const ready = await readyEvent("op132-confirm-auth");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "confirm-auth",
    });

    const response = await handlers.confirmSelfie(
      requestFor(confirmPath(ready.event.slug, submitted.selfieId), "POST", {
        ip: nextIp(),
        body: {},
      })
    );

    expect(response.status).toBe(401);
    const profile = await profileRow();
    expect(profile.activeSelfieId).toBeNull();
  });
});

/* ────────── F1: the object's owner row, its retention and its erasure ────── */

/**
 * F1 of the OP-132 round-1 review (card `t_dd9cbd7c`). The selfie's bytes are
 * biometric data, so a submit must leave an owner row that the erasure path can
 * follow, a retention deadline the TTL sweep can act on, and — once the attendee
 * withdraws consent — no readable object at all.
 *
 * ## Contract expected of the implementation
 *
 * - `POST …/selfies` creates **one** `mediaAssets` row for the uploaded content
 *   hash (schema §15.2 `kind: "selfie"`, §16.1 `refCount`), and stores its id on
 *   the `selfies` row's `assetId` (§16.4 "The image") instead of `null`.
 * - The same `selfies` row carries an `expireAt` (§16.4 TTL field) in the future
 *   from the moment it is queued — retention is not a property of confirmation.
 * - `DELETE …/consent` (OP-131) deletes the `selfies` and `faceMatches` rows,
 *   reports them in `X-Deleted-Counts`, **and** removes the bytes from storage,
 *   so `getObject` at the selfie's own location/object key rejects `not_found`.
 *   The object is read back through `getObjectStorage()` — the memoized port the
 *   submit route wrote through — so the case measures the stored object itself,
 *   not a row that claims to describe it.
 */

/** A stored `mediaAssets` row, as these cases read it (schema §16.1). */
interface MediaAssetRow {
  readonly _id: ObjectId;
  readonly kind: string;
  readonly contentHash: string;
  readonly refCount?: number;
}

/** The stored `selfies` fields these cases read (schema §16.4). */
interface AccountedSelfieRow {
  readonly contentHash: string;
  readonly assetId?: ObjectId | null;
  readonly expireAt?: Date | null;
  readonly createdAt: Date;
  readonly processing: { readonly status: string };
}

/** The one stored `selfies` row for `selfieId`, failing loudly when absent. */
async function selfieById(selfieId: string): Promise<AccountedSelfieRow> {
  const row = (await app.db
    .collection("selfies")
    .findOne({ _id: new ObjectId(selfieId) })) as unknown as AccountedSelfieRow | null;
  if (row === null) {
    throw new Error(`expected a stored selfie ${selfieId}`);
  }
  return row;
}

describe("when a selfie's bytes are submitted", () => {
  it("records one mediaAssets row of kind selfie with refCount 1 and points the selfie at it", async () => {
    const ready = await readyEvent("op132-f1-asset");
    const { hash } = makeSelfieBytes("f1-asset");

    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "f1-asset",
    });

    const assets = (await app.db
      .collection(COLLECTIONS.mediaAssets)
      .find({ kind: "selfie" })
      .toArray()) as unknown as MediaAssetRow[];
    expect(assets).toHaveLength(1);
    const [asset] = assets;
    if (asset === undefined) {
      throw new Error("expected one mediaAssets row of kind selfie");
    }
    expect(asset.contentHash).toBe(hash);
    expect(asset.refCount).toBe(1);

    const selfie = await selfieById(submitted.selfieId);
    expect(selfie.contentHash).toBe(hash);
    expect(selfie.assetId).toEqual(asset._id);
  });

  it("stamps the queued selfie row with an expireAt after its createdAt", async () => {
    const ready = await readyEvent("op132-f1-expiry");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "f1-expiry",
    });

    // No confirmation in this case: the deadline is a property of the row.
    const selfie = await selfieById(submitted.selfieId);
    expect(selfie.processing.status).toBe("queued");

    const expireAt = selfie.expireAt;
    expect(expireAt).toBeInstanceOf(Date);
    if (!(expireAt instanceof Date)) {
      throw new Error(
        `expected the selfie row to carry an expireAt date, received ${String(expireAt)}`
      );
    }
    expect(expireAt.getTime()).toBeGreaterThan(selfie.createdAt.getTime());
    expect(expireAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("when a confirmed selfie's consent is withdrawn", () => {
  it("erases the stored bytes along with the rows and reports the counts", async () => {
    const ready = await readyEvent("op132-f1-erasure");
    const { hash } = makeSelfieBytes("f1-erasure");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "f1-erasure",
    });
    const profile = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject,
      matches: 2,
    });
    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    expect(confirmed.status).toBe(200);

    // The object is really stored before the withdrawal, so the case cannot
    // pass by measuring bytes that were never uploaded.
    const storage = getObjectStorage();
    const storedBefore = await storage.getObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash));
    expect(storedBefore.byteLength).toBeGreaterThan(0);

    const response = await withdrawConsent(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("x-deleted-counts")).toBe("selfies=1;embeddings=1;matches=2");
    expect(await app.db.collection("selfies").countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments({})).toBe(0);
    await expect(
      storage.getObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash))
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

/* ────── P1/P2: a failed purge, and a purge that races a live reference ───── */

/**
 * F-A2 of the OP-132 round-2 review (this card, `t_c146a82e`), the gap
 * ADR-0796 §Consequences records as "Known gap, routed". The withdrawal deletes
 * the `selfies` and `faceMatches` rows **before** it releases the references and
 * deletes the blob, so a transient object-store failure destroys the only
 * pointer to the object and the retry reports a completed erasure.
 *
 * ## What the pins require
 *
 * - **P1 — no orphan across a retry.** After a withdrawal whose `deleteObject`
 *   failed once and a second withdrawal against a healthy port, the bytes are
 *   either gone, or the `mediaAssets` row is a durable purge candidate
 *   (`refCount: 0` **and** `status: "purged"`/`purgedAt`) a sweep can act on.
 *   Which branch the fix takes is the GREEN's decision (ADR-0797 §Open
 *   questions): the case pins the *invariant*, never the shape. The retry keeps
 *   the withdrawal's own contract — `204` plus `X-Deleted-Counts` — and its
 *   counts are deliberately read as a format, not as fixed numbers, because
 *   they state what *that attempt* deleted: a rollback-based fix retries with
 *   the rows still in place (`selfies=1`), a purge-candidate fix finds them
 *   already deleted (`selfies=0`). Both are complete erasures.
 * - **P2 — a release must not purge bytes a live reference just took back**
 *   (ADR-0796 §3 `shortcut:`). The reference release and the object delete are
 *   two calls, so a submit that re-references the hash in between loses its
 *   blob. The second attendee's submit is driven from *inside* the
 *   `deleteObject` stub — the only deterministic seam for that window — and the
 *   case pins the invariant that survives it: **a reference must not outlive its
 *   object**. It does *not* pin "the bytes stay readable", because inside the
 *   delete the withdrawal has already committed to the purge: no implementation
 *   can un-ask that call, so the only satisfiable answers are "the purge is
 *   skipped" (bytes readable) or "the second submit is deflected" (not `202`).
 *   Pinning only the readable branch would be a pin no correct fix can pass;
 *   pinning only the deflection would hide the orphan. ADR-0797 §Decision
 *   records that reasoning and leaves *how* the losing submit is answered to
 *   the GREEN.
 *
 * ## Not pinned here
 *
 * - The **status of the surviving `refCount: 0` row** after a *successful*
 *   purge. §16.1 carries both `stored` and `purged`, and ADR-0796 §3 keeps the
 *   row on purpose (the OP-131 case pins it surviving), so whether it moves to
 *   `purged`/`purgedAt` is the GREEN's record to make, not this card's to
 *   assert: P1 accepts the marker as a second branch but nothing requires it.
 * - **Two concurrent submits of one hash.** The same-hash upsert resolves
 *   through the `(tenantId, contentHash)` unique index, so a `Promise.all` of
 *   two submits lands in the driver's `WriteConflict`/`E11000` path with no
 *   synchronous seam to interleave at; a spec built on that ordering is flaky
 *   by construction and would redden a correct implementation. P2 drives the
 *   same re-reference deterministically, so the row's accounting is exercised
 *   without pinning the concurrent write path.
 */

/** A stored `mediaAssets` row, with the §16.1 purge slots these cases read. */
interface PurgeLedgerRow {
  readonly _id: ObjectId;
  readonly kind: string;
  readonly contentHash: string;
  readonly refCount?: number;
  readonly status?: string;
  readonly purgedAt?: Date | null;
}

/** The stored `mediaAssets` row for one content hash, or `null` when absent. */
async function assetByHash(contentHash: string): Promise<PurgeLedgerRow | null> {
  const row = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ contentHash });
  return row as unknown as PurgeLedgerRow | null;
}

/**
 * Whether the selfie's bytes are still readable through the storage port.
 *
 * @param contentHash - The lowercase 64-hex SHA-256 of the selfie bytes.
 * @returns `true` while `getObject` answers bytes, `false` once it refuses
 *   `not_found` — the port's own absent-object answer, so the case measures the
 *   stored object itself.
 */
async function selfieBytesReadable(contentHash: string): Promise<boolean> {
  try {
    const bytes = await getObjectStorage().getObject(
      SELFIE_LOCATION_KEY,
      selfieObjectKey(contentHash)
    );
    return bytes.byteLength > 0;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "not_found"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether the row durably records that its object still has to be purged.
 *
 * Two shapes satisfy it — the §16.1 terminal `status: "purged"` and its
 * `purgedAt` stamp — and both are readable without the `selfies` rows the
 * withdrawal already deleted, which is what makes them a candidate a sweep can
 * act on.
 *
 * @param row - The asset row for the hash, or `null` when there is none.
 * @returns `true` when the row is a zero-reference purge candidate.
 */
function recordsPendingPurge(row: PurgeLedgerRow | null): boolean {
  if (row === null) {
    return false;
  }
  return (row.refCount ?? -1) === 0 && (row.status === "purged" || row.purgedAt instanceof Date);
}

describe("when the object store fails the purge during a withdrawal", () => {
  it("leaves no orphaned selfie object behind once the withdrawal is retried", async () => {
    // Arrange: a confirmed selfie whose bytes are really in the store.
    const ready = await readyEvent("op132-p1-purge");
    const { hash } = makeSelfieBytes("p1-purge");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "p1-purge",
    });
    const profile = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject,
      matches: 2,
    });
    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    expect(confirmed.status).toBe(200);
    expect(await selfieBytesReadable(hash)).toBe(true);

    // Act: one transient object-store failure, then a retry on a healthy port.
    const storage = getObjectStorage();
    const deleteSpy = vi
      .spyOn(storage, "deleteObject")
      .mockRejectedValueOnce(new Error("object store unavailable"));
    const first = await withdrawConsent(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    deleteSpy.mockRestore();
    const retry = await withdrawConsent(ready.event.slug, { cookie: ready.cookie, ip: ready.ip });

    // Assert: the retry still answers the withdrawal's own contract …
    expect(retry.status).toBe(204);
    expect(retry.headers.get("x-deleted-counts")).toMatch(
      /^selfies=\d+;embeddings=\d+;matches=\d+$/
    );

    // … and the object is not orphaned: the retry purged it, or the asset row
    // is a purge candidate a sweep can act on.
    const bytesReadable = await selfieBytesReadable(hash);
    const asset = await assetByHash(hash);
    const pendingPurge = recordsPendingPurge(asset);
    expect(
      bytesReadable && !pendingPurge,
      `the withdrawal retry orphaned the selfie object: ${SELFIE_LOCATION_KEY}/${selfieObjectKey(hash)} ` +
        `${bytesReadable ? "is still readable" : "is gone"} and the mediaAssets row ` +
        `${JSON.stringify(asset)} records ${pendingPurge ? "a pending purge" : "no pending purge"} ` +
        `(the first attempt answered ${String(first.status)}, the retry ${String(retry.status)})`
    ).toBe(false);
  });
});

describe("when another attendee re-references the same bytes during a withdrawal", () => {
  it("leaves no reference pointing at bytes the purge deleted", async () => {
    // Arrange: attendee A's confirmed selfie, and a second attendee on the same
    // event who has consented and holds a challenge.
    const ready = await readyEvent("op132-p2-race");
    const bytes = makeSelfieBytes("p2-race");
    const submitted = await submitHappyPath(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      tag: "p2-race",
    });
    const profile = await profileRow();
    await finishSelfieWorker(app, {
      selfieId: submitted.selfieId,
      profileId: submitted.profileId,
      eventId: ready.event.id.toHexString(),
      tenantKey: ready.tenantKey,
      subject: profile.subject,
      matches: 1,
    });
    const confirmed = await confirmSelfie(ready.event.slug, submitted.selfieId, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    expect(confirmed.status).toBe(200);
    expect(await selfieBytesReadable(bytes.hash)).toBe(true);

    const otherIp = nextIp();
    const other = await createAttendeeSession(app, otherIp);
    await grantConsent(ready.event.slug, { cookie: other.cookie, ip: otherIp });
    const otherChallenge = await issueChallenge(ready.event.slug, {
      cookie: other.cookie,
      ip: otherIp,
    });

    // Act: the second attendee's submit of the very same bytes lands in the
    // window between the first attendee's reference release and the delete.
    const storage = getObjectStorage();
    const deleteThroughPort = storage.deleteObject.bind(storage);
    let interleaved = false;
    let otherSubmitStatus = 0;
    const deleteSpy = vi
      .spyOn(storage, "deleteObject")
      .mockImplementation(async (locationKey, objectKey) => {
        const taken = await submitSelfie(ready.event.slug, {
          cookie: other.cookie,
          ip: otherIp,
          // The bytes are already stored under this hash — A's own upload — so
          // the submit's `headObject` check passes with no second PUT.
          body: submitBody({ hash: bytes.hash }, otherChallenge),
        });
        interleaved = true;
        otherSubmitStatus = taken.status;
        return deleteThroughPort(locationKey, objectKey);
      });

    const response = await withdrawConsent(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
    });
    deleteSpy.mockRestore();

    // Assert: the withdrawal completed and really reached the object delete, so
    // the window the second submit interleaved into was open.
    expect(response.status).toBe(204);
    expect(
      interleaved,
      "the withdrawal never called the object delete, so this case opened no race window"
    ).toBe(true);

    // … and it left no reference dangling: a submit that was answered `202`
    // must still find its bytes, so the purge must either be refused or skipped.
    const stillReadable = await selfieBytesReadable(bytes.hash);
    const secondHoldsReference = otherSubmitStatus === 202;
    expect(
      secondHoldsReference && !stillReadable,
      `the withdrawal purged ${SELFIE_LOCATION_KEY}/${selfieObjectKey(bytes.hash)} although the ` +
        `second attendee's submit (answered ${String(otherSubmitStatus)}) had taken a reference ` +
        `to those bytes: a reference must not outlive its object`
    ).toBe(false);
  });
});
