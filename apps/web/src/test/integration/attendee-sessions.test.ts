import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ObjectId, type Db } from "mongodb";

import * as currentRouteModule from "@/app/api/v1/p/attendee-sessions/current/route";
import * as sessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import {
  invalidatePlatformSettings,
  seedPlatformSettings,
} from "@/server/settings/platform-settings";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";

import { setCookies } from "../helpers/auth-requests";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — anonymous attendee sessions and the attendee auth
 * resolver (OP-129 I1–I5, contract §1.5 + §0.2 `attendee` label + §0.15,
 * schema §13.5, ADR-0768).
 *
 * **Why this exists.** An attendee must be able to upload a selfie without an
 * account (the epic's user story). The session that enables it is a **bearer
 * credential to someone's face photo**, so the contract is narrow and mostly
 * negative: the raw token is issued exactly once, the database holds only its
 * SHA-256, either the `op_att` cookie or the `X-Attendee-Session` header
 * authenticates `GET .../current`, and an expired session fails as an explicit
 * `401 attendee_session_expired` (never as a silent anonymous request).
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/p/attendee-sessions/route` exports `POST`, declared on
 * `defineRoute({ route: "/api/v1/p/attendee-sessions" })`, auth `public`:
 *
 *   - body `{ eventSlug?: string }` (JSON, so `{}` is a valid request — an
 *     absent content type is the pipeline's `415`, not this route's rule);
 *   - an `eventSlug` resolves **only** through an `accessLinks[]` element of
 *     one `events` row that is `active: true` — a revoked (rotated-away) link
 *     must not bind a session, and neither the slug nor the active flag may be
 *     satisfied by two *different* elements of the same row (contract §6
 *     preamble: “Every route is scoped by the event's **active** access-link
 *     `slug`”; §4.2: rotating sets `active: false` and “Already-printed QR
 *     codes stop working”; schema §15.1; ADR-0781 + its F1 amendment);
 *   - `201` with **exactly** `{ sessionToken, expiresAt, issuedAt }`, RFC 3339
 *     UTC with millisecond precision and a `Z` (contract §0.13);
 *   - `Set-Cookie: op_att=<raw token>; Path=/; HttpOnly; SameSite=Lax;
 *     Max-Age=<retention.attendeeSessionDays in seconds>` — `Secure` is added
 *     only on a TLS deployment (U2, ADR-0768 §Assumptions);
 *   - the stored `attendeeSessions` row carries `tokenHash = sha256(token)`,
 *     `claimedByUserId: null`, `claimedAt: null`, `eventIds: []` when no slug is
 *     given, `deviceFingerprint` hashes and `expireAt = createdAt + TTL`
 *     (schema §13.5).
 *
 * `@/app/api/v1/p/attendee-sessions/current/route` exports `GET`, auth
 * `attendee` (either credential form):
 *
 *   - `200` with **exactly** `{ id, kind, eventSlugs, claimedByUserId,
 *     expiresAt }` (`kind: "anonymous"`), and never the raw token;
 *   - an expired session is `401 attendee_session_expired` with
 *     `details.recreateUrl` (contract §1.5 + Appendix A);
 *   - a missing/unknown token is `401 authentication_required` — a distinct
 *     code, so a client can tell "your 30 days are up, re-create" from "you sent
 *     nothing" (ADR-0768 §Decision 3).
 *
 * ## Assumptions (ADR-0768 §Assumptions)
 *
 * - The routes are `/api/v1/p/attendee-sessions[/current]` exactly as contract
 *   §1.5 spells them, and are driven here by invoking the exported handlers
 *   directly (the pipeline never surfaces Next `params`; these routes have none).
 * - The TTL is `platformSettings.retention.attendeeSessionDays` (the shipped
 *   default is 30). This suite seeds it to **7** so a hard-coded 30-day constant
 *   cannot pass, and it invalidates the settings cache around the seed because
 *   the read is process-cached for 30 s.
 * - Expiry is **inclusive**: at `expireAt` the session is already expired
 *   (`now >= expireAt`), matching MongoDB's TTL semantics.
 * - The device fingerprint is three salted hashes named `uaHash`, `ipHash` and
 *   `acceptLangHash` (schema §13.5), derived from the request's `user-agent`,
 *   `x-forwarded-for` and `accept-language`. Which salt and which hash-of-what
 *   are **not** pinned — only that all three are 64-hex digests and that no raw
 *   component survives.
 * - An unknown `eventSlug` is `404 not_found` (ADR-0781 decided what contract
 *   §1.5 left open: a silently unbound session would let an attendee believe a
 *   selfie was attached to an event it never reached). It is pinned here only
 *   as the *control* that proves the 404 machinery exists, so the F1 red cases
 *   below cannot pass merely because every unresolved slug is refused.
 * - A `current` body's `eventSlugs` lists the bound events' **active** link
 *   slugs only. A link deactivated after the session was created is therefore
 *   reported as absent (ADR-0781 F1 amendment), not as a stale slug.
 * - A signed-in user calling `current` is out of scope too: the `attendee` label
 *   admits a user session (`evaluateAuth`, already pinned by
 *   `guards.test.ts`), and what `current` answers for a user with no attendee
 *   session is not in the contract.
 */

let app: TestApp;

/** The seeded `retention.attendeeSessionDays` — deliberately not the 30 default. */
const TTL_DAYS = 7;

/** The TTL in milliseconds, as the row's `expireAt - createdAt` must show. */
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

/** The TTL in seconds, as the cookie's `Max-Age` must show. */
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

/** The `platformSettings` singleton collection (schema §20.4; not in `COLLECTIONS`). */
const PLATFORM_SETTINGS = "platformSettings";

/** The §1.5 create body — exactly three keys. */
const SESSION_RESPONSE_KEYS = ["expiresAt", "issuedAt", "sessionToken"];

/** The §1.5 current body — exactly five keys. */
const CURRENT_RESPONSE_KEYS = ["claimedByUserId", "eventSlugs", "expiresAt", "id", "kind"];

/** Schema §13.5's row, by name: the only place a token may be recorded, hashed. */
const SESSION_DOCUMENT_KEYS = [
  "_id",
  "claimedAt",
  "claimedByUserId",
  "createdAt",
  "deviceFingerprint",
  "eventIds",
  "expireAt",
  "lastSeenAt",
  "tokenHash",
];

/** Schema §13.5's fingerprint object. */
const FINGERPRINT_KEYS = ["acceptLangHash", "ipHash", "uaHash"];

/** A stored digest: lowercase hex SHA-256 (contract §0.13 "Content hash"). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** An RFC 3339 UTC instant with millisecond precision (contract §0.13). */
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The device components this suite announces, so "no raw part" is meaningful. */
const DEVICE_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": "OpenPic-Attendee-Contract/1.0",
  "accept-language": "en-IN,en;q=0.9",
  "x-forwarded-for": "203.0.113.77",
};

/** The §1.5 create response. */
interface CreatedSession {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
}

/** The §1.5 current response. */
interface CurrentSession {
  readonly id: string;
  readonly kind: string;
  readonly eventSlugs: readonly string[];
  readonly claimedByUserId: string | null;
  readonly expiresAt: string;
}

/** One document and the collection it was found in. */
interface FoundDocument {
  readonly collection: string;
  readonly document: Record<string, unknown>;
}

/** Options accepted by {@link createSession}. */
interface CreateOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op129-attendee" });

  // Seed the singleton (create-only) and then tune the one value this suite
  // pins, so a hard-coded 30-day constant cannot satisfy the TTL assertions.
  await seedPlatformSettings({ db: app.db });
  await app.db
    .collection(PLATFORM_SETTINGS)
    .updateOne({}, { $set: { "retention.attendeeSessionDays": TTL_DAYS } });
  invalidatePlatformSettings();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  // The settings read is process-cached: never leave this suite's TTL behind
  // for another file that renders the same worker.
  invalidatePlatformSettings();
  await app.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Read a route export off a namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST",
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const createAttendeeSession = requireHandler(
  sessionsRouteModule,
  "POST",
  "/api/v1/p/attendee-sessions"
);
const getCurrentSession = requireHandler(
  currentRouteModule,
  "GET",
  "/api/v1/p/attendee-sessions/current"
);

/**
 * `POST /api/v1/p/attendee-sessions` through the exported handler.
 *
 * @param options - Extra headers and the JSON body (`{}` by default).
 * @returns The raw response.
 */
function createSession(options: CreateOptions = {}): Promise<Response> {
  return createAttendeeSession(
    new Request(new URL("/api/v1/p/attendee-sessions", APP_ORIGIN), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_ORIGIN,
        ...DEVICE_HEADERS,
        ...options.headers,
      },
      body: JSON.stringify(options.body ?? {}),
    })
  );
}

/**
 * `GET /api/v1/p/attendee-sessions/current` through the exported handler.
 *
 * @param headers - The credential headers to present (cookie or session header).
 * @returns The raw response.
 */
function currentSession(headers: Readonly<Record<string, string>> = {}): Promise<Response> {
  return getCurrentSession(
    new Request(new URL("/api/v1/p/attendee-sessions/current", APP_ORIGIN), {
      method: "GET",
      headers,
    })
  );
}

/** Create a session and return its body. */
async function createdSession(options: CreateOptions = {}): Promise<CreatedSession> {
  const response = await createSession(options);
  expect(response.status).toBe(201);
  return jsonOf<CreatedSession>(response);
}

/**
 * Parse a response body as `T` (the wire shape the contract spells).
 *
 * @param response - The response to read.
 * @returns The parsed body, typed by the caller's contract interface.
 */
async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** True when `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a value as a plain object, failing with a naming message. */
function recordOf(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${field} to be an object, got ${typeof value}`);
  }
  return value;
}

/** Read a value as a `Date`, failing with a naming message. */
function dateOf(value: unknown, field: string): Date {
  if (!(value instanceof Date)) {
    throw new Error(`expected ${field} to be a Date, got ${typeof value}`);
  }
  return value;
}

/** Read a value as an `ObjectId`, returning its hex id. */
function objectIdHex(value: unknown, field: string): string {
  if (!(value instanceof ObjectId)) {
    throw new Error(`expected ${field} to be an ObjectId, got ${typeof value}`);
  }
  return value.toHexString();
}

/** Every collection name in the suite's private database. */
async function collectionNames(db: Db): Promise<string[]> {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos.map((info) => info.name);
}

/**
 * The DB-wide scanner: every document whose JSON carries `needle`.
 *
 * The card asks for a **scanner** rather than a read of one known collection,
 * because the leak being guarded against (a raw bearer token persisted anywhere
 * — an event payload, a dispatch body, an idempotency snapshot) is exactly the
 * case where the collection is not the one the implementation meant to write.
 *
 * @param needle - The raw token (or any literal) to look for.
 * @returns One entry per document that contains it.
 */
async function documentsContaining(needle: string): Promise<FoundDocument[]> {
  const hits: FoundDocument[] = [];
  for (const name of await collectionNames(app.db)) {
    const rows = await app.db.collection(name).find({}).toArray();
    for (const row of rows) {
      if (JSON.stringify(row).includes(needle)) {
        hits.push({ collection: name, document: row });
      }
    }
  }
  return hits;
}

/**
 * Every document that carries `tokenHash` with the given digest.
 *
 * @param tokenHash - The SHA-256 digest of a raw token.
 * @returns One entry per matching document.
 */
async function documentsKeyedByHash(tokenHash: string): Promise<FoundDocument[]> {
  const hits: FoundDocument[] = [];
  for (const name of await collectionNames(app.db)) {
    const row = await app.db.collection(name).findOne({ tokenHash });
    if (row !== null) {
      hits.push({ collection: name, document: row });
    }
  }
  return hits;
}

/** The single stored session for `token`, read through the scanner. */
async function storedSession(token: string): Promise<FoundDocument> {
  const hits = await documentsKeyedByHash(hashAttendeeSessionToken(token));
  const [found] = hits;
  if (found === undefined) {
    throw new Error(`no stored document carries the SHA-256 of the issued token`);
  }
  expect(hits).toHaveLength(1);
  return found;
}

/**
 * Move a stored session's `expireAt` into the past, wherever the row lives.
 *
 * The collection name is the implementation's choice, so the write goes
 * through the scanner's hit rather than a hard-coded name.
 *
 * @param token - The raw token of the session to age.
 * @param expireAt - The instant to store.
 */
async function ageSession(token: string, expireAt: Date): Promise<void> {
  const stored = await storedSession(token);
  await app.db
    .collection(stored.collection)
    .updateOne({ tokenHash: hashAttendeeSessionToken(token) }, { $set: { expireAt } });
}

/** The `op_att` pair of a `Set-Cookie` header value. */
function cookiePairOf(header: string): string {
  const [pair = ""] = header.split("; ");
  return pair;
}

/** A seeded `events` row: the id a session binds and its link slugs, in order. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slugs: readonly string[];
}

/** Monotonic counter so every seeded event gets slugs no other row carries. */
let seededEventSeq = 0;

/**
 * Insert a published `events` row whose `accessLinks[]` is exactly `activeFlags`
 * (schema §15.1).
 *
 * The create route resolves its body's `eventSlug` through
 * `events.accessLinks[]`, so the binding can only be pinned against a real event
 * row. `activeFlags` is given per array position because rotation produces a row
 * that carries a revoked element **and** a fresh active one — the shape in which
 * a document-scoped match and an element-scoped match disagree.
 *
 * @param activeFlags - The `active` flag of each `accessLinks[]` element, in order.
 * @returns The new row's `_id` and its link slugs, in `accessLinks[]` order.
 */
async function seedEvent(activeFlags: readonly boolean[]): Promise<SeededEvent> {
  seededEventSeq += 1;
  const tag = String(seededEventSeq).padStart(4, "0");
  const now = new Date();
  const links = activeFlags.map((active, index) => ({
    slug: `op129f1${tag}${String(index)}`,
    active,
    createdAt: now,
    // A revoked link is stamped by the rotation; an active one is not revoked.
    revokedAt: active ? null : now,
  }));
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: new ObjectId(),
    name: `OP-129 F1 event ${tag}`,
    description: "",
    status: "published",
    startAt: now,
    endAt: now,
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: now,
    retentionExpiresAt: now,
    accessLinks: links,
    createdAt: now,
    schemaVersion: 1,
  });
  return { id: _id, slugs: links.map((link) => link.slug) };
}

/**
 * The slug at `index` of a seeded event, failing with a naming message.
 *
 * @param event - The seeded row.
 * @param index - The `accessLinks[]` position.
 * @returns The slug stored at that position.
 */
function slugAt(event: SeededEvent, index: number): string {
  const slug = event.slugs.at(index);
  if (slug === undefined) {
    throw new Error(`expected the seeded event to carry an access link at index ${String(index)}`);
  }
  return slug;
}

/**
 * Every document in the suite's database that carries a `tokenHash`, tagged as
 * `collection:digest`.
 *
 * The collection that holds a session row is the implementation's choice, so "no
 * session was written" has to be a database-wide scan (like
 * {@link documentsContaining}) rather than a count on a named collection.
 *
 * @returns One tag per stored session row, sorted.
 */
async function sessionRowTags(): Promise<string[]> {
  const tags: string[] = [];
  for (const name of await collectionNames(app.db)) {
    const rows = await app.db
      .collection(name)
      .find({ tokenHash: { $exists: true } })
      .toArray();
    for (const row of rows) {
      tags.push(`${name}:${String(row.tokenHash)}`);
    }
  }
  return tags.sort();
}

/** A route's §Appendix A error envelope, as far as these pins read it. */
interface ErrorBody {
  readonly error: { readonly code: string };
}

describe("POST /api/v1/p/attendee-sessions", () => {
  it("I1: stores only the token's SHA-256 in the database", async () => {
    const created = await createdSession();

    const stored = await storedSession(created.sessionToken);
    const document = stored.document;

    expect(Object.keys(document).sort()).toEqual([...SESSION_DOCUMENT_KEYS].sort());
    expect(document.tokenHash).toBe(hashAttendeeSessionToken(created.sessionToken));
    expect(String(document.tokenHash)).toMatch(HASH_PATTERN);
    expect(document.claimedByUserId).toBeNull();
    expect(document.claimedAt).toBeNull();
    expect(document.eventIds).toEqual([]);
    expect(dateOf(document.expireAt, "expireAt").getTime()).toBe(
      dateOf(document.createdAt, "createdAt").getTime() + TTL_MS
    );
    // The raw token must be nowhere in the row — no `token`, no `sessionToken`.
    expect(JSON.stringify(document)).not.toContain(created.sessionToken);
  });

  it("I1: stores a hashed device fingerprint and no raw device component", async () => {
    const created = await createdSession();

    const stored = await storedSession(created.sessionToken);
    const fingerprint = recordOf(stored.document.deviceFingerprint, "deviceFingerprint");

    expect(Object.keys(fingerprint).sort()).toEqual(FINGERPRINT_KEYS);
    expect(
      [
        String(fingerprint.uaHash),
        String(fingerprint.ipHash),
        String(fingerprint.acceptLangHash),
      ].map((digest) => HASH_PATTERN.test(digest))
    ).toEqual([true, true, true]);

    const serialized = JSON.stringify(stored.document);
    expect(serialized).not.toContain("OpenPic-Attendee-Contract/1.0");
    expect(serialized).not.toContain("203.0.113.77");
    expect(serialized).not.toContain("en-IN,en;q=0.9");
  });

  it("I1: answers the three documented keys and issues the raw token with an op_att cookie", async () => {
    const response = await createSession();
    expect(response.status).toBe(201);

    const created = await jsonOf<CreatedSession>(response);

    expect(Object.keys(created).sort()).toEqual([...SESSION_RESPONSE_KEYS].sort());
    expect(created.sessionToken).toMatch(/^opat_[A-Za-z0-9_-]{43}$/);
    expect(created.issuedAt).toMatch(RFC3339_MS);
    expect(created.expiresAt).toMatch(RFC3339_MS);
    expect(created.expiresAt).toBe(new Date(Date.parse(created.issuedAt) + TTL_MS).toISOString());

    const sessionCookie = setCookies(response).find((cookie) => cookie.startsWith("op_att="));
    if (sessionCookie === undefined) {
      throw new Error("the create response did not set an op_att cookie");
    }
    expect(cookiePairOf(sessionCookie)).toBe(`op_att=${created.sessionToken}`);
    const attributes = sessionCookie.split("; ").slice(1);
    expect(new Set(attributes)).toEqual(
      new Set(["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${String(TTL_SECONDS)}`])
    );
  });

  it("I1: takes the TTL from retention.attendeeSessionDays, not from a constant", async () => {
    // The suite seeds 7 days (the shipped default is 30): a hard-coded 30-day
    // expiry reddens both assertions below.
    const created = await createdSession();
    const stored = await storedSession(created.sessionToken);

    expect(Date.parse(created.expiresAt) - Date.parse(created.issuedAt)).toBe(TTL_MS);
    expect(
      dateOf(stored.document.expireAt, "expireAt").getTime() -
        dateOf(stored.document.createdAt, "createdAt").getTime()
    ).toBe(TTL_MS);
    expect(Date.parse(created.issuedAt)).toBe(
      dateOf(stored.document.createdAt, "createdAt").getTime()
    );
  });
});

describe("GET /api/v1/p/attendee-sessions/current", () => {
  it("I2: the op_att cookie authenticates current", async () => {
    const createResponse = await createSession();
    expect(createResponse.status).toBe(201);
    const created = await jsonOf<CreatedSession>(createResponse);
    const stored = await storedSession(created.sessionToken);

    const response = await currentSession({ cookie: `op_att=${created.sessionToken}` });
    expect(response.status).toBe(200);

    const current = await jsonOf<CurrentSession>(response);

    expect(Object.keys(current).sort()).toEqual([...CURRENT_RESPONSE_KEYS].sort());
    expect(current.kind).toBe("anonymous");
    expect(current.id).toBe(objectIdHex(stored.document._id, "attendeeSessions._id"));
    expect(current.eventSlugs).toEqual([]);
    expect(current.claimedByUserId).toBeNull();
    expect(current.expiresAt).toBe(created.expiresAt);
    // §0.15: a raw bearer token is returned by its single issuance response only.
    expect(JSON.stringify(current)).not.toContain(created.sessionToken);
  });

  it("I3: the X-Attendee-Session header authenticates current", async () => {
    const created = await createdSession();
    const stored = await storedSession(created.sessionToken);

    const response = await currentSession({ "x-attendee-session": created.sessionToken });
    expect(response.status).toBe(200);

    const current = await jsonOf<CurrentSession>(response);

    expect(Object.keys(current).sort()).toEqual([...CURRENT_RESPONSE_KEYS].sort());
    expect(current.kind).toBe("anonymous");
    expect(current.id).toBe(objectIdHex(stored.document._id, "attendeeSessions._id"));
    expect(current.expiresAt).toBe(created.expiresAt);
    expect(JSON.stringify(current)).not.toContain(created.sessionToken);
  });

  it("I4: a session whose expireAt has passed is 401 attendee_session_expired", async () => {
    const created = await createdSession();
    await ageSession(created.sessionToken, new Date(Date.now() - 1_000));

    const response = await currentSession({ "x-attendee-session": created.sessionToken });
    expect(response.status).toBe(401);

    const parsed = await jsonOf<{
      error: { code: string; details?: { recreateUrl?: unknown } };
    }>(response);
    expect(parsed.error.code).toBe("attendee_session_expired");

    const recreateUrl = parsed.error.details?.recreateUrl;
    if (typeof recreateUrl !== "string") {
      throw new Error("expected details.recreateUrl to be a string");
    }
    expect(recreateUrl.startsWith("/")).toBe(true);
  });

  it("I4: the clock decides expiry — 1 ms before expireAt is 200, at expireAt is 401", async () => {
    const created = await createdSession();
    const expiresAt = Date.parse(created.expiresAt);

    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date(expiresAt - 1));
    const beforeExpiry = await currentSession({ "x-attendee-session": created.sessionToken });
    expect(beforeExpiry.status).toBe(200);

    vi.setSystemTime(new Date(expiresAt));
    const atExpiry = await currentSession({ "x-attendee-session": created.sessionToken });
    expect(atExpiry.status).toBe(401);
    const parsed = await jsonOf<{ error: { code: string } }>(atExpiry);
    expect(parsed.error.code).toBe("attendee_session_expired");
  });

  it("I4: no credential is 401 authentication_required, not the expired code", async () => {
    const response = await currentSession();
    expect(response.status).toBe(401);

    const parsed = await jsonOf<{ error: { code: string } }>(response);
    expect(parsed.error.code).toBe("authentication_required");
  });

  it("I4: an unknown or malformed token is 401 authentication_required", async () => {
    const unknown = await currentSession({ "x-attendee-session": "opat_never-issued-000" });
    expect(unknown.status).toBe(401);
    expect((await jsonOf<{ error: { code: string } }>(unknown)).error.code).toBe(
      "authentication_required"
    );

    const malformed = await currentSession({ cookie: "op_att=not-a-token" });
    expect(malformed.status).toBe(401);
    expect((await jsonOf<{ error: { code: string } }>(malformed)).error.code).toBe(
      "authentication_required"
    );
  });
});

describe("the raw attendee token never reaches storage", () => {
  it("I5: no collection stores the raw token — not the session, not a snapshot", async () => {
    const created = await createdSession();

    expect(await documentsContaining(created.sessionToken)).toEqual([]);
  });

  it("I5: a repeated create with an Idempotency-Key persists neither raw token", async () => {
    const first = await createdSession({ headers: { "idempotency-key": "op129-attendee-once" } });
    const second = await createSession({ headers: { "idempotency-key": "op129-attendee-once" } });

    // A create is not idempotency-required (contract §1.5 declares no
    // `Idempotency-Key`), so a replay may mint a second session or serve the
    // stored one; either way the raw token must not be persisted.
    expect([200, 201]).toContain(second.status);
    const replayed = await jsonOf<CreatedSession>(second);

    expect(await documentsContaining(first.sessionToken)).toEqual([]);
    expect(await documentsContaining(replayed.sessionToken)).toEqual([]);
  });
});

/**
 * F1 (review finding on the OP-129 landing) — the `eventSlug` binding must be
 * scoped by an **active** access link.
 *
 * Contract §6 preamble: “Every route is scoped by the event's **active**
 * access-link `slug`, resolved through the unique partial index on
 * `accessLinks.slug` where `active: true`.” Contract §4.2: rotation sets
 * `active: false` on the previous link and “**Already-printed QR codes stop
 * working**”. Schema §15.1 embeds `accessLinks[]` on the event row and makes the
 * slug index partial on `active: true`, so a rotated-away slug is not a
 * resolvable public identifier even though the string still exists on the row.
 *
 * The two red cases below fail on the trunk that prompted them (a revoked slug
 * answers `201` and binds its event); the three controls keep the assertion
 * honest — they prove a slug is still refused when it matches nothing (so the
 * red is about the *active* predicate, not about a blanket refusal) and still
 * binds when it names an active link wherever that element sits in the array (so
 * the red is not satisfied by refusing every slug, nor by reading
 * `accessLinks[0]`).
 */
describe("POST /api/v1/p/attendee-sessions — eventSlug binds through an active access link (F1)", () => {
  it("F1: a deactivated access-link slug is 404 not_found and writes no session row", async () => {
    // The only link on the row was rotated away: nothing resolvable is left.
    const event = await seedEvent([false]);
    const before = await sessionRowTags();

    const response = await createSession({ body: { eventSlug: slugAt(event, 0) } });

    expect(response.status).toBe(404);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe("not_found");
    // A refused create must not leave a bearer credential's row behind.
    expect(await sessionRowTags()).toEqual(before);
  });

  it("F1: a revoked slug does not bind even when the same event carries a newer active link", async () => {
    // The shape rotation actually produces: the old element is revoked, a fresh
    // active element sits beside it. The slug and the `active: true` flag are
    // satisfied by two *different* elements, which is not a resolvable link.
    const event = await seedEvent([false, true]);
    const before = await sessionRowTags();

    const response = await createSession({ body: { eventSlug: slugAt(event, 0) } });

    expect(response.status).toBe(404);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe("not_found");
    expect(await sessionRowTags()).toEqual(before);
  });

  it("F1 control: an active slug still binds the session and current reports it", async () => {
    const event = await seedEvent([true]);
    const slug = slugAt(event, 0);

    const created = await createdSession({ body: { eventSlug: slug } });
    const stored = await storedSession(created.sessionToken);

    // `eventIds` holds exactly the named event (ObjectId `toString()` is its hex).
    expect(String(stored.document.eventIds)).toBe(event.id.toHexString());

    const response = await currentSession({ cookie: `op_att=${created.sessionToken}` });
    expect(response.status).toBe(200);
    const current = await jsonOf<CurrentSession>(response);
    expect(current.eventSlugs).toEqual([slug]);
  });

  it("F1 control: a slug that matches no event is 404 not_found and writes no session row", async () => {
    // The 404 machinery every unresolved slug already gets: the red case above
    // must be refused because its link is inactive, not because 404 is new.
    const before = await sessionRowTags();

    const response = await createSession({ body: { eventSlug: "op129f1-no-such-event" } });

    expect(response.status).toBe(404);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe("not_found");
    expect(await sessionRowTags()).toEqual(before);
  });

  it("F1 control: an active link binds even when it is not the first accessLinks element", async () => {
    // A fix that inspects `accessLinks[0]` only would break the post-rotation
    // row: the active link is appended, so it is usually the *last* element.
    const event = await seedEvent([false, true]);

    const created = await createdSession({ body: { eventSlug: slugAt(event, 1) } });
    const stored = await storedSession(created.sessionToken);

    expect(String(stored.document.eventIds)).toBe(event.id.toHexString());
  });
});

/**
 * F1, read side — `current` must not echo a slug whose link was rotated away.
 *
 * Contract §4.2: “Already-printed QR codes stop working”. A session created
 * while a link was active stays valid (the credential is the session, not the
 * link), but the slug it projects back must stop being advertised the moment the
 * link is deactivated — otherwise the attendee UI keeps offering a public URL
 * that no longer resolves.
 */
describe("GET /api/v1/p/attendee-sessions/current — eventSlugs reports only active links (F1)", () => {
  it("F1: a link deactivated after the session was created is not reported in eventSlugs", async () => {
    const event = await seedEvent([true]);
    const created = await createdSession({ body: { eventSlug: slugAt(event, 0) } });

    // Rotation, exactly as §4.2 describes it: the row keeps the element and
    // stamps it inactive.
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne(
        { _id: event.id },
        { $set: { "accessLinks.0.active": false, "accessLinks.0.revokedAt": new Date() } }
      );

    const response = await currentSession({ cookie: `op_att=${created.sessionToken}` });
    expect(response.status).toBe(200);

    const current = await jsonOf<CurrentSession>(response);
    expect(current.eventSlugs).toEqual([]);
  });
});
