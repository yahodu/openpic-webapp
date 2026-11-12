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
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";

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
 * - An unknown `eventSlug` is `404 not_found` **and writes no row** (ADR-0770):
 *   F2 pins the binding, the 404 and the no-write half through the
 *   collection-agnostic scanner — a refactor that inserted the row before
 *   validating the slug would leak a credential's row while still answering
 *   404.
 * - `current` reads the `op_att` cookie first and the `X-Attendee-Session`
 *   header second, so a **stale** cookie shadows a valid header. §0.2 says
 *   "cookie **or** header", so F4 pins the intended fall-through (RED on the
 *   shipped implementation; GREEN `t_a909e641`) and keeps the lapsed-cookie
 *   answer (`401 attendee_session_expired`, never a header retry) green beside
 *   it, so the fall-through cannot be bought with a swallowed expiry.
 * - A signed-in user is **admitted** by the `attendee` label (`evaluateAuth`,
 *   pinned by `guards.test.ts`) and then answered `401
 *   authentication_required`, because §1.5 defines only the anonymous body
 *   (F5). That shipped answer is pinned, and the contract question is recorded
 *   in ADR-0782 §3.
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

/** A seeded `events` row: the id a session binds and the slug that names it. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
}

/** Monotonic counter so every seeded event gets its own access-link slug. */
let seededEventSeq = 0;

/**
 * Insert an `events` row carrying one active `accessLinks[0]` entry (schema §15.1).
 *
 * The create route resolves an `eventSlug` through `events.accessLinks[].slug`
 * (ADR-0770), so the row has to be a real event with a real link: a slug seeded
 * anywhere else would pin nothing about the binding.
 *
 * @returns The new row's `_id` and its access-link slug.
 */
async function seedEventWithSlug(): Promise<SeededEvent> {
  seededEventSeq += 1;
  const slug = `op129edge${String(seededEventSeq).padStart(4, "0")}`;
  const _id = new ObjectId();
  const now = new Date();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: new ObjectId(),
    name: `OP-129 edge event ${String(seededEventSeq)}`,
    description: "",
    status: "published",
    startAt: now,
    endAt: now,
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: now,
    retentionExpiresAt: now,
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null }],
    createdAt: now,
    schemaVersion: 1,
  });
  return { id: _id, slug };
}

/**
 * Every document in the suite's database that carries a `tokenHash`.
 *
 * The failed-create pin must prove that **no** attendee-session row was
 * written, and the collection that row lives in is the implementation's
 * choice — so the scan is collection-agnostic, like {@link documentsContaining}.
 *
 * @returns One `collection:tokenHash` tag per matching document, sorted.
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

/** Read a value as an array of `ObjectId` hex ids, failing with a naming message. */
function objectIdHexes(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${field} to be an array, got ${typeof value}`);
  }
  return value.map((entry) => objectIdHex(entry, `${field}[]`));
}

/** A route's §Appendix A error envelope, as much as these pins read. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly details?: { recreateUrl?: unknown } };
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

describe("POST /api/v1/p/attendee-sessions — the eventSlug binding (§1.5)", () => {
  // ADR-0770 decides what contract §1.5 left open: `eventSlug` names an event
  // through `events.accessLinks[].slug`, `eventIds` records exactly that event,
  // and a slug that matches nothing is `404 not_found` rather than a silently
  // unbound session. All three cases below are characterization pins: they
  // describe the shipped implementation and pass on it unchanged.

  it("F2: binds the session to the event named by the slug and current projects it back", async () => {
    const event = await seedEventWithSlug();

    const created = await createdSession({ body: { eventSlug: event.slug } });
    const stored = await storedSession(created.sessionToken);

    expect(objectIdHexes(stored.document.eventIds, "attendeeSessions.eventIds")).toEqual([
      event.id.toHexString(),
    ]);

    const response = await currentSession({ cookie: `op_att=${created.sessionToken}` });
    expect(response.status).toBe(200);
    const current = await jsonOf<CurrentSession>(response);

    expect(current.eventSlugs).toEqual([event.slug]);
    expect(current.kind).toBe("anonymous");
  });

  it("F2: a slug that matches no event is 404 not_found and writes no session row", async () => {
    // The important half: `eventIdsFor()` must run **before** the insert. A
    // refactor that inserted the row first and validated the slug second would
    // still answer 404, but it would leave a bearer credential's row behind —
    // hence the database-wide scan rather than a status-only assertion.
    const before = await sessionRowTags();

    const response = await createSession({ body: { eventSlug: "op129edge-no-such-event" } });

    expect(response.status).toBe(404);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe("not_found");
    expect(await sessionRowTags()).toEqual(before);
  });

  it("F2: a slug naming a different event binds only that event", async () => {
    const other = await seedEventWithSlug();
    const bound = await seedEventWithSlug();

    const created = await createdSession({ body: { eventSlug: bound.slug } });
    const stored = await storedSession(created.sessionToken);

    expect(objectIdHexes(stored.document.eventIds, "attendeeSessions.eventIds")).toEqual([
      bound.id.toHexString(),
    ]);

    const response = await currentSession({ cookie: `op_att=${created.sessionToken}` });
    expect(response.status).toBe(200);
    const current = await jsonOf<CurrentSession>(response);

    expect(current.eventSlugs).toEqual([bound.slug]);
    expect(current.eventSlugs).not.toContain(other.slug);
  });
});

describe("GET /api/v1/p/attendee-sessions/current — cookie vs header precedence (§0.2)", () => {
  /**
   * Contract §0.2 says the `op_att` cookie **or** the `X-Attendee-Session`
   * header authenticates. Today the resolver reads the cookie first and stops
   * when that token matches no row, so a stale cookie shadows a valid header
   * (`t_a909e641` is the GREEN that makes the fall-through reach the header).
   *
   * This case is RED by design: it pins the **intended** answer, not today's.
   * If the contract owner keeps cookie-first precedence instead, the flip is
   * contained in this one case — change the status expectation to `401` and
   * replace the body assertions with
   * `expect((await jsonOf<ErrorBody>(response)).error.code).toBe("authentication_required")`
   * — and the companion case below must stay green either way.
   */
  it("F4: a stale op_att cookie falls through to a valid X-Attendee-Session header", async () => {
    const created = await createdSession();
    const stored = await storedSession(created.sessionToken);

    const response = await currentSession({
      cookie: "op_att=opat_never-issued-000",
      "x-attendee-session": created.sessionToken,
    });

    expect(response.status).toBe(200);

    const current = await jsonOf<CurrentSession>(response);

    expect(current.id).toBe(objectIdHex(stored.document._id, "attendeeSessions._id"));
    expect(current.kind).toBe("anonymous");
    expect(current.expiresAt).toBe(created.expiresAt);
    expect(JSON.stringify(current)).not.toContain(created.sessionToken);
  });

  /**
   * The companion the F4 fix must **not** buy with a swallowed expiry: a
   * lapsed cookie is an explicit `401 attendee_session_expired` with
   * `details.recreateUrl`, never a second attempt against the header. This case
   * is green on the shipped implementation and must stay green.
   */
  it("F4: a lapsed op_att cookie is 401 attendee_session_expired even with a valid header", async () => {
    const lapsed = await createdSession();
    await ageSession(lapsed.sessionToken, new Date(Date.now() - 1_000));
    const valid = await createdSession();

    const response = await currentSession({
      cookie: `op_att=${lapsed.sessionToken}`,
      "x-attendee-session": valid.sessionToken,
    });

    expect(response.status).toBe(401);

    const parsed = await jsonOf<ErrorBody>(response);

    expect(parsed.error.code).toBe("attendee_session_expired");
    if (typeof parsed.error.details?.recreateUrl !== "string") {
      throw new Error("expected details.recreateUrl to be a string");
    }
    expect(parsed.error.details.recreateUrl.startsWith("/")).toBe(true);
  });
});

describe("GET /api/v1/p/attendee-sessions/current — a signed-in user (§1.5)", () => {
  /**
   * The `attendee` label admits a **user** principal (`evaluateAuth`, pinned by
   * `guards.test.ts`), and §1.5 then defines no body for one: the handler
   * answers `401 authentication_required` because it has no attendee token to
   * project. That shipped answer is what this case pins, and the contract
   * question it leaves open ("does §1.5 owe a user projection?") is recorded in
   * ADR-0782 §3 — a future user projection flips this case to `200` with the
   * user's own body.
   *
   * The status alone cannot tell "the guard admitted the user" from "the guard
   * refused the user" — both are `401 authentication_required` — so the case
   * also asserts the guard's own observable: **no** `auth.denied` record is
   * logged for this request. That is what makes the pin bite.
   */
  it("F5: a signed-in user is admitted by the label and answered 401 authentication_required", async () => {
    const user = await app.signIn();

    const previous = getLogger();
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({
        level: "info",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );
    const response = await currentSession({ cookie: user.cookie }).finally(() => {
      setLogger(previous);
    });

    expect(response.status).toBe(401);
    expect((await jsonOf<ErrorBody>(response)).error.code).toBe("authentication_required");
    // The sink must have observed the request, or "no auth.denied" is vacuous.
    expect(sink.entries.some((entry) => entry.event === "http.request.rejected")).toBe(true);
    expect(sink.entries.filter((entry) => entry.event === "auth.denied")).toEqual([]);
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
