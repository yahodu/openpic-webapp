import { randomUUID } from "node:crypto";

import type { Db, Document, WithId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as deletionPost, DELETE as deletionCancel } from "@/app/api/v1/me/deletion/route";
import { GET as sessionsGet } from "@/app/api/v1/me/sessions/route";
import { POST as revokeAll } from "@/app/api/v1/me/sessions:revoke-all/route";
import { DELETE as sessionDelete } from "@/app/api/v1/me/sessions/[sessionId]/route";
import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient, getDb } from "@/server/db/mongo";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";

import { authPost, body, cookiePair, sessionCookie } from "../helpers/auth-requests";
import { MONGO_READY_HOOK_TIMEOUT_MS, requireMongoTestUri, waitForMongoReady } from "../helpers/db";
import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration / contract — sessions & devices and account deletion (OP-91,
 * contract §1.3–§1.4).
 *
 * The specs drive the **real** exported route handlers with a real Better Auth
 * email-OTP session cookie against a real `mongodb-memory-server` replica set:
 *
 *   I0  an unauthenticated caller is refused on both write surfaces;
 *   I1  the sessions list returns only the caller's sessions, active-only, with
 *       the documented fields and none of the never-return fields;
 *   I2  revoking a foreign (or unknown) session id is `404 not_found`, and the
 *       owner's session survives;
 *   I3  revoke-all leaves the current session when `keepCurrent` is true and
 *       nothing when false, and emits `account.sessions.revoked` through the
 *       lifecycle seam;
 *   I4  a `confirmEmail` that does not match is `422 confirmation_mismatch`;
 *   I5  request → cancel returns the profile to `active` with
 *       `deletionScheduledAt: null`, and the schedule is computed from
 *       `platformSettings.account.deletionGraceDays`;
 *   I6  cancelling once the purge window has elapsed is `409
 *       deletion_already_executed`;
 *   I7  a matching `confirmEmail` emits exactly one `account.deletion.requested`
 *       row through the lifecycle seam (§1.4).
 *
 * ## Contract expected of the implementation
 *
 * Exported route handlers (all guarded with the `user` label):
 *
 *   @/app/api/v1/me/sessions/route                 GET  -> 200 { data: [...] }
 *   @/app/api/v1/me/sessions/[sessionId]/route     DELETE -> 204 | 404 not_found
 *   @/app/api/v1/me/sessions:revoke-all/route      POST { keepCurrent: boolean } -> 204
 *   @/app/api/v1/me/deletion/route                 POST { reason?, confirmEmail } -> 202
 *                                                  DELETE -> 204 | 409 deletion_already_executed
 *
 * `POST /me/sessions:revoke-all` revokes through the identity lifecycle seam
 * (`createIdentityLifecycleSeams().sessionsRevoked`, ADR-0043 §3), which emits
 * one `account.sessions.revoked` row into the `domainEvents` outbox. The spec
 * asserts that observable row, so a route that deletes session documents
 * directly (bypassing the emit) fails I3.
 *
 * The list item is `{ id, current, deviceLabel, ipCountry, createdAt,
 * lastActiveAt, expiresAt }`. Raw `ipAddress`, `userAgent`, the session `token`
 * and the owning `userId` are never returned (§0.15); the IP is only projected
 * as `ipCountry`, which is `null` until a geo resolver exists.
 *
 * The deletion schedule is read from `platformSettings.account.deletionGraceDays`
 * (ADR-0008 names the additive `account` section), never hard-coded; the body is
 * `{ status: "deletion_pending", scheduledAt, cancelUntil, cancelUrl }`.
 *
 * ## Deliberate assumptions (see ADR-0067)
 *
 * - "The purge has started" is modelled as a `deletion_pending` profile whose
 *   `deletionScheduledAt` is in the past — the exact predicate the
 *   `account-deletion-purge` cron acts on (§10.2 `deletionScheduledAt < now`).
 * - Because `requireAuth("user")` currently denies `deletion_pending` with
 *   `403`, the deletion-cancel route must exempt that status (like `GET /me`'s
 *   `allowBanned` exemption) for §1.4's cancel window to exist at all.
 * - The `confirmation_mismatch` and `deletion_already_executed` codes are named
 *   by the contract (§1.4 / Appendix A.2) but are not yet in the contract
 *   error-code sets; the implementer adds them.
 */

const APP_ORIGIN = "http://localhost:3000";
const SESSIONS_PATH = "/api/v1/me/sessions";
const DELETION_PATH = "/api/v1/me/deletion";

/** Better Auth-owned collections (schema §13.1) plus the app-owned profile. */
const SESSION_COLLECTION = "session";
const USER_PROFILES_COLLECTION = "userProfiles";
const PLATFORM_SETTINGS_COLLECTION = "platformSettings";
/** The transactional outbox (schema §18.3) the lifecycle hooks write to. */
const DOMAIN_EVENTS_COLLECTION = "domain_events";

/** The deletion grace window used to prove the setting is read, not hard-coded. */
const SEEDED_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock slack between the request instant and the computed `scheduledAt`. */
const SCHEDULE_TOLERANCE_MS = 5_000;

/**
 * A private database shared by this spec's auth instance and the route's
 * process singletons, uniquely named per run so stale state cannot leak in.
 */
const DB_NAME = `openpic_op91_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

let database: Db;
let auth: AuthLike;

/** Point a MongoDB URI at `dbName`, preserving options. */
function uriWithDb(uri: string, dbName: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

type OtpChannel = "email" | "sms";
interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

interface Identity {
  readonly email: string;
  readonly ip: string;
}

/** One session summary as returned by the list route (§1.3). */
interface SessionSummary {
  readonly id: string;
  readonly current: boolean;
  readonly deviceLabel: string;
  readonly ipCountry: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
}

/** The error envelope of a failed response. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

let identitySeq = 0;

/** A unique email/phone/IP so no two specs share a rate-limit bucket. */
function makeIdentity(): Identity {
  identitySeq += 1;
  const serial = String(identitySeq).padStart(4, "0");
  return {
    email: `op91-sessions-${serial}@example.com`,
    ip: `203.0.113.${String(identitySeq + 40)}`,
  };
}

beforeAll(async () => {
  const uri = requireMongoTestUri();

  // Rebuild the singleton client from this file's configuration: a previous
  // file in the same worker may have left a client bound to the shared URI.
  await closeMongoClient();
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: uriWithDb(uri, DB_NAME),
        RATE_LIMIT_PROVIDER: "memory",
        MESSAGE_TRANSPORT: "memory",
      })
    )
  );

  // Built inside the hook so they read this file's configuration, not an
  // earlier file's environment.
  database = getDb();
  auth = createAuth({ db: database });

  // Cold connect / replica-set discovery / primary election belong in this
  // hook, never inside a timed spec.
  await waitForMongoReady();

  // The singletons must be bound to this spec's private database, or the route
  // would read a database no session was written to.
  expect(database.databaseName).toBe(DB_NAME);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await getDb().dropDatabase();
  await closeMongoClient();
});

/** The captured OTP, failing loudly when the transport recorded none. */
function requireOtp(channel: OtpChannel, to: string): CapturedOtp {
  const otp = otpInbox.take(channel, to) as CapturedOtp | undefined;
  if (otp === undefined) {
    throw new Error(`expected an OTP captured for ${channel}:${to}, got none`);
  }
  return otp;
}

function forward(identity: Identity): Record<string, string> {
  return { "x-forwarded-for": identity.ip };
}

/** Sign in with a valid email OTP; returns the session cookie pair. */
async function signInWithEmailOtp(identity: Identity): Promise<string> {
  const sent = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/email-otp/send-verification-otp",
    { email: identity.email, type: "sign-in" },
    forward(identity)
  );
  expect(sent.status).toBe(200);
  const otp = requireOtp("email", identity.email);

  const response = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/sign-in/email-otp",
    { email: identity.email, otp: otp.code },
    forward(identity)
  );
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  if (cookie === undefined) {
    throw new Error("sign-in did not set a session cookie");
  }
  return cookiePair(cookie);
}

/** Read the raw Better Auth user document for an identity. */
async function findUser(identity: Identity): Promise<WithId<Document>> {
  const user = await database.collection("user").findOne({ email: identity.email });
  if (user === null) {
    throw new Error(`no user document for ${identity.email}`);
  }
  return user;
}

/** The `userProfiles` row for a user, or `null`. */
async function findProfile(userId: unknown): Promise<WithId<Document> | null> {
  return database.collection(USER_PROFILES_COLLECTION).findOne({ userId } as never);
}

/** Parse and return the JSON error envelope. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

function sessionHeaders(cookie: string | undefined): Record<string, string> {
  return cookie === undefined ? {} : { cookie };
}

/** A GET /me/sessions request carrying the session cookie. */
function sessionsRequest(cookie?: string): Request {
  return new Request(new URL(SESSIONS_PATH, APP_ORIGIN), {
    method: "GET",
    headers: sessionHeaders(cookie),
  });
}

/** A DELETE /me/sessions/{id} request carrying the session cookie. */
function deleteSessionRequest(cookie: string | undefined, sessionId: string): Request {
  return new Request(new URL(`${SESSIONS_PATH}/${sessionId}`, APP_ORIGIN), {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
}

/** A POST /me/sessions:revoke-all request carrying the session cookie. */
function revokeAllRequest(cookie: string | undefined, keepCurrent: boolean): Request {
  return new Request(new URL("/api/v1/me/sessions:revoke-all", APP_ORIGIN), {
    method: "POST",
    headers: { ...sessionHeaders(cookie), "content-type": "application/json" },
    body: JSON.stringify({ keepCurrent }),
  });
}

/** A POST /me/deletion request carrying the session cookie and body. */
function deletionRequest(cookie: string | undefined, payload: unknown): Request {
  return new Request(new URL(DELETION_PATH, APP_ORIGIN), {
    method: "POST",
    headers: { ...sessionHeaders(cookie), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** A DELETE /me/deletion request carrying the session cookie. */
function cancelDeletionRequest(cookie?: string): Request {
  return new Request(new URL(DELETION_PATH, APP_ORIGIN), {
    method: "DELETE",
    headers: sessionHeaders(cookie),
  });
}

/** Drive the list route and return its `data` array, asserting the 200. */
async function listSessions(cookie: string): Promise<SessionSummary[]> {
  const response = await sessionsGet(sessionsRequest(cookie));
  expect(response.status).toBe(200);
  const payload = await body(response);
  return payload.data as SessionSummary[];
}

/** The session ids visible to a caller. */
async function sessionIds(cookie: string): Promise<string[]> {
  return (await listSessions(cookie)).map((session) => session.id);
}

describe("sessions & devices (contract §1.3)", () => {
  it("I0: an unauthenticated caller cannot list sessions", async () => {
    const response = await sessionsGet(sessionsRequest());
    expect(response.status).toBe(401);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("authentication_required");
  });

  it("I1: lists only the caller's own sessions", async () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    const ownerCookie = await signInWithEmailOtp(owner);
    const strangerCookie = await signInWithEmailOtp(stranger);

    const ownerSessions = await listSessions(ownerCookie);
    const strangerIds = new Set(await sessionIds(strangerCookie));

    // Exactly the caller's one session, and none of the stranger's.
    expect(ownerSessions).toHaveLength(1);
    for (const session of ownerSessions) {
      expect(strangerIds.has(session.id)).toBe(false);
    }

    // Exactly one session is marked current.
    expect(ownerSessions.filter((session) => session.current)).toHaveLength(1);

    // The documented projection, and nothing from the never-return list.
    const session = ownerSessions[0];
    if (session === undefined) {
      throw new Error("expected the caller's session in the list");
    }
    expect(typeof session.id).toBe("string");
    expect(typeof session.deviceLabel).toBe("string");
    expect(session.ipCountry === null || typeof session.ipCountry === "string").toBe(true);
    expect(Number.isNaN(Date.parse(session.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(session.lastActiveAt))).toBe(false);
    expect(Number.isNaN(Date.parse(session.expiresAt))).toBe(false);
    expect(session).not.toHaveProperty("ipAddress");
    expect(session).not.toHaveProperty("userAgent");
    expect(session).not.toHaveProperty("token");
    expect(session).not.toHaveProperty("userId");
  });

  it("I1: excludes a session whose expiry has passed", async () => {
    const identity = makeIdentity();
    // Two sign-ins create two active sessions for the same user.
    const cookie = await signInWithEmailOtp(identity);
    await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    const before = await listSessions(cookie);
    expect(before).toHaveLength(2);
    const current = before.find((session) => session.current);
    expect(current).toBeDefined();

    // Expire the *other* session, leaving the current one usable.
    const stored = await database
      .collection(SESSION_COLLECTION)
      .find({ userId: user._id } as never)
      .toArray();
    expect(stored).toHaveLength(2);
    const other = stored.find((session) => String(session._id) !== current?.id);
    expect(other).toBeDefined();
    await database.collection(SESSION_COLLECTION).updateOne({ _id: other?._id } as never, {
      $set: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const after = await listSessions(cookie);
    expect(after.map((session) => session.id)).toEqual([current?.id]);
  });

  it("I2: revoking another user's session id is 404 and leaves it intact", async () => {
    const owner = makeIdentity();
    const stranger = makeIdentity();
    const ownerCookie = await signInWithEmailOtp(owner);
    const strangerCookie = await signInWithEmailOtp(stranger);

    const foreignId = (await sessionIds(strangerCookie))[0];
    expect(foreignId).toBeDefined();

    const response = await sessionDelete(deleteSessionRequest(ownerCookie, foreignId ?? ""));
    expect(response.status).toBe(404);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("not_found");

    // The stranger's session is untouched — a probe must not leak a delete.
    expect(await sessionIds(strangerCookie)).toContain(foreignId);
  });

  it("I2: revoking an unknown session id is 404", async () => {
    const owner = makeIdentity();
    const ownerCookie = await signInWithEmailOtp(owner);

    const unknownId = "0123456789abcdef01234567";
    const response = await sessionDelete(deleteSessionRequest(ownerCookie, unknownId));
    expect(response.status).toBe(404);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("not_found");

    // The caller's own session is untouched.
    expect(await sessionIds(ownerCookie)).toHaveLength(1);
  });

  it("I2: revoking one of the caller's own sessions removes just that session", async () => {
    const identity = makeIdentity();
    const keepCookie = await signInWithEmailOtp(identity);
    const revokeCookie = await signInWithEmailOtp(identity);

    // Select revokeCookie's *own* session via `current`: §1.3 fixes no list
    // order, so indexing [0] could pick keepCookie's session and invalidate it.
    const revokeId = (await listSessions(revokeCookie)).find((session) => session.current)?.id;
    expect(revokeId).toBeDefined();
    expect(await sessionIds(keepCookie)).toContain(revokeId);

    const response = await sessionDelete(deleteSessionRequest(keepCookie, revokeId ?? ""));
    expect(response.status).toBe(204);

    // The revoked session no longer authenticates nor appears in the list.
    expect(await sessionIds(keepCookie)).not.toContain(revokeId);
    const revoked = await sessionsGet(sessionsRequest(revokeCookie));
    expect(revoked.status).toBe(401);
  });

  it("I3: revoke-all with keepCurrent keeps exactly the current session", async () => {
    const identity = makeIdentity();
    const currentCookie = await signInWithEmailOtp(identity);
    const otherCookie = await signInWithEmailOtp(identity);
    await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    expect(await sessionIds(currentCookie)).toHaveLength(3);

    const response = await revokeAll(revokeAllRequest(currentCookie, true));
    expect(response.status).toBe(204);

    const remaining = await listSessions(currentCookie);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.current).toBe(true);

    // A revoked session can no longer authenticate.
    const revoked = await sessionsGet(sessionsRequest(otherCookie));
    expect(revoked.status).toBe(401);

    // The revocation is emitted through the lifecycle seam (ADR-0040 §4 /
    // ADR-0048 §6): the endpoint revokes via Better Auth, not by deleting rows.
    // The contract says EXACTLY ONE row per revoke-all, so assert the count — a
    // `not.toBeNull()` check would silently pass a double-emit (e.g. a future
    // `session.delete` database hook firing alongside the explicit seam).
    const emitted = await database.collection(DOMAIN_EVENTS_COLLECTION).countDocuments({
      eventKey: "account.sessions.revoked",
      "subjectRef.id": String(user._id),
    });
    expect(emitted).toBe(1);
  });

  it("I3: revoke-all with keepCurrent false revokes every session", async () => {
    const identity = makeIdentity();
    const currentCookie = await signInWithEmailOtp(identity);
    await signInWithEmailOtp(identity);

    expect(await sessionIds(currentCookie)).toHaveLength(2);

    const response = await revokeAll(revokeAllRequest(currentCookie, false));
    expect(response.status).toBe(204);

    // Nothing survives — not even the caller's own session.
    const revoked = await sessionsGet(sessionsRequest(currentCookie));
    expect(revoked.status).toBe(401);
  });
});

describe("account deletion (contract §1.4)", () => {
  it("I0: an unauthenticated caller cannot request deletion", async () => {
    const response = await deletionPost(
      deletionRequest(undefined, { confirmEmail: "x@example.com" })
    );
    expect(response.status).toBe(401);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("authentication_required");
  });

  it("I4: a confirmEmail that does not match is 422 confirmation_mismatch", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const response = await deletionPost(
      deletionRequest(cookie, { confirmEmail: `not-${identity.email}` })
    );
    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("confirmation_mismatch");
    expect(envelope.details?.field).toBe("confirmEmail");

    // Nothing was scheduled.
    const user = await findUser(identity);
    const profile = await findProfile(user._id);
    expect(profile?.status ?? "active").toBe("active");
    expect(profile?.deletionScheduledAt ?? null).toBeNull();
  });

  it("I5: request then cancel restores active with deletionScheduledAt null, on the settings grace window", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    // The grace window is a runtime tunable: seed a non-default value so a
    // hard-coded 14-day offset fails this spec.
    await seedPlatformSettings({ db: database });
    await database
      .collection(PLATFORM_SETTINGS_COLLECTION)
      .updateOne({ _id: "singleton" } as never, {
        $set: { "account.deletionGraceDays": SEEDED_GRACE_DAYS },
      });
    invalidatePlatformSettings();

    const before = Date.now();
    const requested = await deletionPost(deletionRequest(cookie, { confirmEmail: identity.email }));
    const after = Date.now();
    expect(requested.status).toBe(202);

    const payload = await body(requested);
    expect(payload.status).toBe("deletion_pending");
    expect(payload.cancelUrl).toBe(DELETION_PATH);

    const scheduledAt = Date.parse(String(payload.scheduledAt));
    const cancelUntil = Date.parse(String(payload.cancelUntil));
    expect(Number.isNaN(scheduledAt)).toBe(false);
    expect(cancelUntil).toBe(scheduledAt);
    // scheduledAt must be SEEDED_GRACE_DAYS after the request instant.
    expect(scheduledAt).toBeGreaterThanOrEqual(
      before + SEEDED_GRACE_DAYS * DAY_MS - SCHEDULE_TOLERANCE_MS
    );
    expect(scheduledAt).toBeLessThanOrEqual(
      after + SEEDED_GRACE_DAYS * DAY_MS + SCHEDULE_TOLERANCE_MS
    );

    // The profile is persisted as pending until the scheduled instant.
    const user = await findUser(identity);
    const pending = await findProfile(user._id);
    expect(pending?.status).toBe("deletion_pending");
    expect(pending?.deletionScheduledAt).toBeInstanceOf(Date);

    // Cancel inside the window.
    const cancelled = await deletionCancel(cancelDeletionRequest(cookie));
    expect(cancelled.status).toBe(204);

    const restored = await findProfile(user._id);
    expect(restored?.status).toBe("active");
    expect(restored?.deletionScheduledAt).toBeNull();
  });

  it("I6: cancelling once the purge window has elapsed is 409 deletion_already_executed", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);

    // The purge predicate (§10.2): `deletion_pending` with a scheduled instant
    // already in the past.
    await database
      .collection(USER_PROFILES_COLLECTION)
      .updateOne(
        { userId: user._id },
        { $set: { status: "deletion_pending", deletionScheduledAt: new Date(Date.now() - DAY_MS) } }
      );

    const response = await deletionCancel(cancelDeletionRequest(cookie));
    expect(response.status).toBe(409);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("deletion_already_executed");

    // The profile stays pending — a refused cancel never resurrects it.
    const profile = await findProfile(user._id);
    expect(profile?.status).toBe("deletion_pending");
  });

  it("I7: requesting deletion emits exactly one account.deletion.requested row", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);

    const requested = await deletionPost(deletionRequest(cookie, { confirmEmail: identity.email }));
    expect(requested.status).toBe(202);

    const user = await findUser(identity);

    // §1.4 requires the request to announce itself: the route emits through the
    // lifecycle seam (the `handleDeletionRequested` counterpart of the I3
    // `handleSessionsRevoked` emit), giving EXACTLY ONE outbox row subject to
    // the deleting user. A route that only flips the profile to
    // `deletion_pending` (zero rows) or double-emits (count 2) fails here.
    const emitted = await database.collection(DOMAIN_EVENTS_COLLECTION).countDocuments({
      eventKey: "account.deletion.requested",
      "subjectRef.id": String(user._id),
    });
    expect(emitted).toBe(1);
  });
});
