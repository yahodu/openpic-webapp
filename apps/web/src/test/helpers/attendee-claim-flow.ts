import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";

import * as claimRouteModule from "@/app/api/v1/me/attendee-sessions:claim/route";
import * as myEventsRouteModule from "@/app/api/v1/me/events/route";
import * as attendeeSessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import { ATTENDEE_COOKIE_NAME } from "@/server/attendee/session-cookie";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";

import { cookiePair, setCookies } from "./auth-requests";
import { makeIdentity, type SignedInUser, type TestApp } from "./authed-app";
import { nextIp, requestFor, requireHandler, type CallOptions } from "./selfie-flow";

/**
 * Shared fixture flow for the OP-134 claim + my-events suites (contract §6.7,
 * schema §13.5, §15.3, §15.4; ADR-0814).
 *
 * Three things every case needs are built here once: the two HTTP surfaces
 * (`POST /me/attendee-sessions:claim` and `GET /me/events`), a stored
 * `attendeeEventProfiles` row a case can shape exactly (the merge rule needs
 * two rows with controlled selfie timestamps), and the `attendeeSessions` row a
 * claim is about.
 *
 * Route modules are reached by their **intended paths**, so a module that does
 * not exist is an honest load failure and a module that exists without the
 * handler is named explicitly by `requireHandler`.
 */

/* ───────────────────────────── route handlers ────────────────────────────── */

/** The two §6.7 routes these suites drive, resolved once. */
export const claimHandlers = {
  claim: requireHandler(claimRouteModule, "POST", "/api/v1/me/attendee-sessions:claim"),
  myEvents: requireHandler(myEventsRouteModule, "GET", "/api/v1/me/events"),
  createSession: requireHandler(attendeeSessionsRouteModule, "POST", "/api/v1/p/attendee-sessions"),
} as const;

/* ──────────────────────────────── requests ───────────────────────────────── */

/** Options a claim call accepts: the credential, the address and an optional token. */
export interface ClaimCallOptions extends CallOptions {
  /** The raw `opat_…` token, when the case sends it in the body. */
  readonly sessionToken?: string;
}

/**
 * Call `POST /api/v1/me/attendee-sessions:claim`.
 *
 * §0.9 lists the claim nowhere, so the key is **optional but honoured**; the
 * helper sends one anyway, so a GREEN that declares the optional stage and a
 * GREEN that does not are both accepted — the pin is the behaviour, not the
 * header.
 *
 * @param options - The caller's credential, client address and optional token.
 * @returns The raw response, so a case can assert a `409` or the `Set-Cookie`.
 */
export function claimSession(options: ClaimCallOptions): Promise<Response> {
  return claimHandlers.claim(
    requestFor("/api/v1/me/attendee-sessions:claim", "POST", {
      ...options,
      body: options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken },
    })
  );
}

/**
 * Call `GET /api/v1/me/events`.
 *
 * @param options - The caller's credential, client address and query string.
 * @returns The raw response.
 */
export function myEvents(options: CallOptions & { readonly query?: string }): Promise<Response> {
  const path =
    options.query === undefined ? "/api/v1/me/events" : `/api/v1/me/events?${options.query}`;
  return claimHandlers.myEvents(requestFor(path, "GET", options));
}

/* ──────────────────────────────── the session ────────────────────────────── */

/** A real anonymous attendee session, bound to one event. */
export interface BoundAttendeeSession {
  /** The `op_att=<token>` pair to replay as a cookie. */
  readonly cookie: string;
  /** The raw bearer token (what `sessionToken` carries). */
  readonly token: string;
  /** The stored session row's id, as a hex string. */
  readonly sessionId: string;
}

/**
 * Create a real anonymous attendee session **bound to one event**.
 *
 * The bind matters: §13.5 stores `eventIds` on the session, so a claim that
 * walks the session's events and a claim that walks the session's profiles both
 * see the same event.
 *
 * @param app - The booted test app.
 * @param eventSlug - The event's active access-link slug.
 * @returns The cookie, the raw token and the stored session id.
 */
export async function createBoundAttendeeSession(
  app: TestApp,
  eventSlug: string
): Promise<BoundAttendeeSession> {
  const response = await claimHandlers.createSession(
    requestFor("/api/v1/p/attendee-sessions", "POST", {
      ip: nextIp(),
      body: { eventSlug },
      withoutIdempotencyKey: true,
    })
  );
  if (response.status !== 201) {
    throw new Error(
      `expected 201 from the attendee-session route, received ${String(response.status)}`
    );
  }
  const header = setCookies(response).find((cookie) => cookie.startsWith(ATTENDEE_COOKIE_NAME));
  if (header === undefined) {
    throw new Error("the attendee-session route did not set an op_att cookie");
  }
  const cookie = cookiePair(header);
  const token = rawTokenOf(cookie);
  const row = await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) });
  if (row === null) {
    throw new Error("expected the attendee session row to exist");
  }
  return { cookie, token, sessionId: String(row._id) };
}

/**
 * The raw bearer token inside an `op_att=<token>` cookie pair.
 *
 * @param cookie - The `name=value` pair (no attributes).
 * @returns The token the body's `sessionToken` carries.
 */
export function rawTokenOf(cookie: string): string {
  return cookie.slice(`${ATTENDEE_COOKIE_NAME}=`.length);
}

/** The stored `attendeeSessions` fields these cases read (§13.5). */
export interface SessionRow {
  readonly _id: ObjectId;
  readonly tokenHash: string;
  readonly claimedByUserId?: ObjectId | null;
  readonly claimedAt?: Date | null;
  readonly eventIds?: readonly ObjectId[];
  readonly expireAt: Date;
}

/**
 * Read one stored session row by its raw token.
 *
 * @param app - The booted test app.
 * @param token - The raw bearer token.
 * @returns The row.
 */
export async function readSessionRow(app: TestApp, token: string): Promise<SessionRow> {
  const row = (await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) })) as unknown as SessionRow | null;
  if (row === null) {
    throw new Error("expected the attendee session row to exist");
  }
  return row;
}

/**
 * Move one session's `expireAt` into the past, so a claim meets a lapsed TTL.
 *
 * @param app - The booted test app.
 * @param token - The raw bearer token of the session to lapse.
 */
export async function lapseSession(app: TestApp, token: string): Promise<void> {
  await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .updateOne(
      { tokenHash: hashAttendeeSessionToken(token) },
      { $set: { expireAt: new Date(Date.now() - 60_000) } }
    );
}

/* ──────────────────────────────── the profile ────────────────────────────── */

/** The stored `attendeeEventProfiles` fields these cases assert on (§15.3). */
export interface ClaimProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status: string;
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount: number;
  readonly claimedAt?: Date | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** What a case states about the profile it seeds. */
export interface SeedProfileInput {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly subject: Record<string, unknown>;
  readonly status?: string;
  readonly activeSelfieId?: ObjectId | null;
  readonly matchCount?: number;
  readonly lastSeenGalleryAt?: Date | null;
  readonly claimedAt?: Date | null;
  readonly updatedAt?: Date;
}

/**
 * Insert one `attendee_event_profiles` row in its stored shape (§15.3).
 *
 * The claim cases need two rows with controlled subjects and selfie pointers —
 * a state the shipped routes cannot produce (a user only ever gets one row per
 * event), so the row is seeded rather than driven.
 *
 * @param app - The booted test app.
 * @param input - The tenant, event, subject and the fields a case varies.
 * @returns The new row's id.
 */
export async function seedProfile(app: TestApp, input: SeedProfileInput): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id,
    tenantId: input.tenantKey,
    eventId: input.eventId,
    subject: input.subject,
    status: input.status ?? "ready",
    activeSelfieId: input.activeSelfieId ?? null,
    matchCount: input.matchCount ?? 0,
    lastMatchRunAt: null,
    lastSeenGalleryAt: input.lastSeenGalleryAt ?? null,
    firstMatchNotifiedAt: null,
    consentId: null,
    claimedAt: input.claimedAt ?? null,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    schemaVersion: 1,
  });
  return _id;
}

/**
 * Insert one `selfies` row with a chosen `createdAt` (§16.4).
 *
 * §15.3 makes `activeSelfieId` a pointer, so the merge rule compares the two
 * *selfies'* `createdAt`. Seeding the row (not the upload flow) is the only way
 * to state "this selfie is the newer one".
 *
 * @param app - The booted test app.
 * @param input - The owning profile, subject, tenant/event and the timestamp.
 * @returns The new selfie's id.
 */
export async function seedSelfie(
  app: TestApp,
  input: {
    readonly tenantKey: string;
    readonly eventId: ObjectId;
    readonly profileId: ObjectId;
    readonly subject: Record<string, unknown>;
    readonly createdAt: Date;
  }
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.selfies).insertOne({
    _id,
    tenantId: input.tenantKey,
    eventId: input.eventId,
    profileId: input.profileId,
    subject: input.subject,
    assetId: null,
    contentHash: randomUUID().replace(/-/g, ""),
    isActive: true,
    liveness: { required: true, passed: true, score: 0.93 },
    quality: { faceCount: 1, accepted: true, rejectionReason: null },
    processing: { status: "done", startedAt: input.createdAt, finishedAt: input.createdAt },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    schemaVersion: 1,
  });
  return _id;
}

/**
 * Insert unseen `faceMatches` rows for one profile (§17.5).
 *
 * `newMatchCount` is the count of matches the attendee has not seen; seeding
 * the rows is what makes the cached `matchCount` and the "new" count agree.
 *
 * @param app - The booted test app.
 * @param input - The owning profile, its event, and how many rows to add.
 */
export async function seedUnseenMatches(
  app: TestApp,
  input: {
    readonly tenantKey: string;
    readonly eventId: ObjectId;
    readonly profileId: ObjectId;
    readonly subject: Record<string, unknown>;
    readonly count: number;
  }
): Promise<void> {
  const createdAt = new Date();
  const rows = Array.from({ length: input.count }, (_unused, faceIndex) => ({
    tenantId: input.tenantKey,
    eventId: input.eventId,
    profileId: input.profileId,
    subject: input.subject,
    imageId: new ObjectId(),
    faceIndex,
    selfieId: null,
    similarity: 0.71,
    confidence: "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: null,
    hiddenAt: null,
    createdAt,
  }));
  if (rows.length > 0) {
    await app.db.collection(COLLECTIONS.faceMatches).insertMany(rows);
  }
}

/**
 * Read every stored profile, so a case can assert the row it seeded and no other.
 *
 * @param app - The booted test app.
 * @returns All `attendee_event_profiles` rows.
 */
export async function allProfiles(app: TestApp): Promise<ClaimProfileRow[]> {
  return (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ClaimProfileRow[];
}

/**
 * Read every stored selfie id, so a case can prove no selfie was replaced.
 *
 * @param app - The booted test app.
 * @returns The stored selfie ids, as hex strings, sorted.
 */
export async function selfieIds(app: TestApp): Promise<string[]> {
  const rows = await app.db
    .collection(COLLECTIONS.selfies)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return rows.map((row) => String(row._id)).sort();
}

/* ──────────────────────────────── the caller ─────────────────────────────── */

/**
 * Sign in a fresh identity while presenting the anonymous `op_att` cookie.
 *
 * A browser that signs in from the attendee page still holds the cookie, so the
 * session-created hook sees it and claims the session (contract §6.7). A sign-in
 * with no cookie proves the opposite: nothing is claimed.
 *
 * @param app - The booted test app.
 * @param cookie - The `op_att=<token>` pair to present.
 * @returns The signed-in caller.
 */
export function signInWithAttendeeCookie(app: TestApp, cookie: string): Promise<SignedInUser> {
  return app.signIn(makeIdentity("op134"), { headers: { cookie } });
}

/* ───────────────────────────────── bodies ────────────────────────────────── */

/** The `POST /me/attendee-sessions:claim` body, reduced to what a case reads. */
export interface ClaimBody {
  readonly claimed: readonly {
    readonly eventId: string;
    readonly eventName: string;
    readonly profileId: string;
    readonly matchCount: number;
    readonly galleryUrl: string;
  }[];
  readonly skipped: readonly { readonly eventId: string; readonly reason: string }[];
}

/** The `GET /me/events` body, reduced to what a case reads. */
export interface MyEventsBody {
  readonly data: readonly {
    readonly eventId: string;
    readonly eventName: string;
    readonly organizerDisplayName: string;
    readonly startAt: string;
    readonly displayTimeZone: string;
    readonly slug: string;
    readonly galleryUrl: string;
    readonly coverThumbnailUrl: string | null;
    readonly matchCount: number;
    readonly newMatchCount: number;
    readonly status: string;
    readonly galleryExpiresAt: string | null;
    readonly expiringSoon: boolean;
  }[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly limit: number;
  };
}

/**
 * Parse a JSON body, failing loudly when the status is not the expected one.
 *
 * @param response - The response to read.
 * @param expectedStatus - The status the case expects.
 * @param label - What the call is, for the failure message.
 * @returns The parsed body in the caller's shape.
 */
async function jsonOf<T>(response: Response, expectedStatus: number, label: string): Promise<T> {
  const parsed: unknown = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `expected ${String(expectedStatus)} from ${label}, received ${String(response.status)}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed as T;
}

/**
 * Read a `200` claim body, failing loudly on any other status.
 *
 * @param response - The claim response.
 * @returns The parsed body.
 */
export function claimBodyOf(response: Response): Promise<ClaimBody> {
  return jsonOf<ClaimBody>(response, 200, "POST /me/attendee-sessions:claim");
}

/**
 * Read a `200` my-events body, failing loudly on any other status.
 *
 * @param response - The my-events response.
 * @returns The parsed body.
 */
export function myEventsBodyOf(response: Response): Promise<MyEventsBody> {
  return jsonOf<MyEventsBody>(response, 200, "GET /me/events");
}
