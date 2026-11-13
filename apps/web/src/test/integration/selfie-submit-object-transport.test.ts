import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TransportError } from "@/server/adapters/transport-error";
import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
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
 * Integration / contract — the **swallowing** half of the submit's object
 * check (OP-132 review of `t_325903f6`, finding **F5-symmetric**, Low;
 * contract §6.2/§6.3; ADR-0807 §Decision 1; ADR-0812).
 *
 * **Why this exists.** `getObjectStorage().headObject(...)` is one port method
 * that throws **two different error classes**, and the submit route only owns
 * the first:
 *
 * - `AppError("not_found")` — R2 answered `HeadObject` with a `404`, or the
 *   memory adapter found no object. That is a fact about the *client's* upload,
 *   so the route reshapes it into `404 not_found` with
 *   `details.resource: "selfie"`.
 * - `TransportError` (`@/server/adapters/transport-error`) — every other
 *   status, or no answer at all (`code: "network" | "timeout" | "http"`). That
 *   is **our** outage, not the attendee's mistake.
 *
 * ADR-0807's F5 file pins the first class only. A route whose `catch` is
 * over-broad — `catch { throw appError("not_found", …) }` — answers the second
 * class as a client-side `404 not_found` too, and a client that trusts the code
 * acts on "your upload did not arrive" by **uploading and submitting again**,
 * which spends the `selfie.submit` budget (§14.1) on our outage. That is the
 * regression this file exists to catch, and it is invisible to every F5/F6/F7
 * case measured on the trunk.
 *
 * ## What is load-bearing, and which half
 *
 * The **first** case is the load-bearing one: it stubs the very port method the
 * route reads with a retryable `TransportError` and requires the wire answer to
 * be the app-wide `500 internal_error`, never `not_found`. The `headObject` spy
 * is asserted to have been called once with the submit's own location key and
 * content-addressed key, so the case cannot pass on a path that never reached
 * the port. Nothing may be charged: no `selfies` row, an unspent presented
 * challenge, no `q:selfie` outbox row — §6.3 verifies the object **before** the
 * challenge, the budget and the enqueue.
 *
 * The **second** case is a cheap characterisation of the shipped post-fix
 * behaviour, kept next to its sibling so the two error classes from that one
 * port method are visibly pinned apart: an object that really was never
 * uploaded still answers `404 not_found` with `details.resource: "selfie"`. It
 * does not repeat the F5 file's shape/charge cases — only enough to prove the
 * narrowing did not close the arm it was written for.
 *
 * ## Assumptions
 *
 * - **The stub is the port, not the adapter's HTTP client.** The port boundary
 *   is where the two error classes are already distinguished, so stubbing it
 *   exercises the route's `catch` — the thing that can be over-broad — without
 *   re-deriving R2's status mapping. `getObjectStorage()` memoizes the memory
 *   adapter, so the instance the route reads is the instance stubbed here.
 * - **`500 internal_error` is the expected class, not a specific message.**
 *   `errorResponse` maps any non-`AppError` throw onto the catalog's generic
 *   500 (§0.12), so the case pins the status and the code and leaves the text
 *   and `requestId` free.
 * - **`retryable` is not asserted.** The generic `internal_error` catalog entry
 *   is `retryable: false`, while the `TransportError` itself is
 *   `retryable: true`; the route's job is to stop swallowing the failure, and
 *   mapping the outage's retry policy onto the envelope is a separate contract
 *   this card does not mint (recorded in ADR-0812 §Out of scope).
 */

let app: TestApp;

/* ─────────────────────────────── row shapes ──────────────────────────────── */

/** A stored challenge element of the caller's profile (schema §15.3). */
interface StoredChallengeRow {
  readonly challengeId?: ObjectId;
  readonly usedAt: Date | null;
}

/** The stored `attendee_event_profiles` fields these cases read (§15.3). */
interface ProfileRow {
  readonly livenessChallenges?: readonly StoredChallengeRow[];
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op132-f5-sym" });
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
 * How many `selfies` rows exist — an attempt is one row (§15.3 has no counter).
 *
 * @returns The stored row count.
 */
async function selfieRows(): Promise<number> {
  return await app.db.collection(COLLECTIONS.selfies).countDocuments({});
}

/**
 * The `usedAt` of the one challenge this case presented.
 *
 * @param challenge - The challenge the evidence was bound to.
 * @returns The stored instant, or `null` while the challenge is unspent.
 * @throws {Error} When no profile or no such challenge is stored, so a case can
 *   never read `null` off a row that does not exist.
 */
async function storedUsedAt(challenge: IssuedChallenge): Promise<Date | null> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({})) as unknown as ProfileRow | null;
  if (row === null) {
    throw new Error("expected the caller's attendee profile to exist");
  }
  const stored = (row.livenessChallenges ?? []).find(
    (candidate) => String(candidate.challengeId) === challenge.challengeId
  );
  if (stored === undefined) {
    throw new Error("expected the presented challenge to be stored on the profile");
  }
  return stored.usedAt;
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** The caller's credential and client address. */
interface Caller {
  readonly cookie: string;
  readonly ip: string;
}

/** A published event with a consented caller (the §6.2 precondition met). */
type ReadyEvent = { readonly event: SeededEvent } & Caller;

/**
 * Seed a published event, mint an attendee session on it and grant consent,
 * exactly as the F5 file does — the submit's object check runs last of the
 * preconditions, so anything earlier would mask the refusal.
 *
 * @param prefix - The suite-local prefix for the seeded organizer.
 * @returns The event and the caller's handles.
 */
async function readyEvent(prefix: string): Promise<ReadyEvent> {
  const { events } = await seedTenant(app, prefix);
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  const ip = nextIp();
  const session = await createAttendeeSession(app, ip);
  await grantConsent(event.slug, { cookie: session.cookie, ip });
  return { event, cookie: session.cookie, ip };
}

/* ───── the load-bearing arm: our outage must not read as the client's miss ─── */

describe("when the object store fails while the submit checks the uploaded object", () => {
  it("answers 500 internal_error instead of reporting a client-side 404 not_found", async () => {
    const ready = await readyEvent("op132-f5-sym-outage");
    const bytes = makeSelfieBytes("f5-sym-outage");
    const challenge = await issueChallenge(ready.event.slug, ready);
    const outboxBefore = outboxLength();

    // R2 answering `503`, or the request never reaching it: one error class,
    // and it is not the client's `not_found`. Stub it on the instance the route
    // reads (the storage composition root memoizes the memory adapter).
    const head = vi.spyOn(getObjectStorage(), "headObject");
    head.mockRejectedValueOnce(
      new TransportError("Transport request failed.", { retryable: true, code: "network" })
    );

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: bytes.hash }, challenge),
    });

    // Non-vacuity: the answer below must be the one the stub produced. A route
    // that never consulted the port would answer a `404` for the absent object
    // and would make this case pass for the wrong reason.
    expect(head).toHaveBeenCalledTimes(1);
    expect(head).toHaveBeenCalledWith(SELFIE_LOCATION_KEY, selfieObjectKey(bytes.hash));

    // §0.12: a throw that is not an `AppError` is the app-wide 500. The one
    // code it must never be is the client-actionable miss — a client that sees
    // `not_found` re-uploads and re-submits, spending `selfie.submit` on our
    // outage (§14.1).
    expect(response.status).toBe(500);
    const error = await errorBody(response);
    expect(error.code).toBe("internal_error");
    expect(error.code).not.toBe("not_found");
    expect(error.details).toBeUndefined();

    // §6.3: the object is verified before the challenge and the budget, so a
    // failed check charges nothing and queues nothing.
    expect(await selfieRows()).toBe(0);
    expect(await storedUsedAt(challenge)).toBeNull();
    expect(
      entriesSince(outboxBefore).filter((entry) => entry.queueKey === "q:selfie")
    ).toHaveLength(0);
  });
});

/* ──── the sibling arm: the narrowing must not close the real object miss ───── */

describe("when the uploaded object is genuinely absent", () => {
  it("still answers 404 not_found and names the selfie resource", async () => {
    const ready = await readyEvent("op132-f5-sym-miss");
    const bytes = makeSelfieBytes("f5-sym-miss");
    const challenge = await issueChallenge(ready.event.slug, ready);

    const response = await submitSelfie(ready.event.slug, {
      cookie: ready.cookie,
      ip: ready.ip,
      body: submitBody({ hash: bytes.hash }, challenge),
    });

    expect(response.status).toBe(404);
    const error = await errorBody(response);
    expect(error.code).toBe("not_found");
    expect(error.details).toEqual({ resource: "selfie" });

    // The same charge-free state as the outage arm: a miss is decided before
    // the challenge is spent and before an attempt exists.
    expect(await selfieRows()).toBe(0);
    expect(await storedUsedAt(challenge)).toBeNull();
  });
});
