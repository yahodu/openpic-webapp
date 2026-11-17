import { createHash } from "node:crypto";

import { Binary, ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as attendeeSessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import * as consentRouteModule from "@/app/api/v1/p/events/[slug]/consent/route";
import { requireConsent } from "@/server/attendee/consent-guard";
import { ATTENDEE_COOKIE_NAME } from "@/server/attendee/session-cookie";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { AppError } from "@/server/http/app-error";
import { isAppError } from "@/server/http/errors";

import { cookiePair, setCookies } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — biometric consent grant and withdrawal
 * (OP-131 I1–I5, contract §6.2 + Appendix A.7, schema §15.3/§15.4/§16.1/§16.4,
 * green card §1–§4; ADR-0789).
 *
 * **Why this exists.** Consent is the *hard* precondition of the whole attendee
 * surface (contract §6.2: "No selfie endpoint may be reached without it"), so
 * two opposite obligations meet on this one resource:
 *
 *   - the **grant** must be *demonstrable* years later — who agreed, to which
 *     policy version, to which *document* (`policyDocumentHash`, worthless
 *     without it), when, and how (hashed IP/UA + `method: "checkbox"`);
 *   - the **withdrawal** must actually destroy the biometric data — the selfie,
 *     its face vector and every `faceMatches` row — and report what it destroyed
 *     in `X-Deleted-Counts`, because a `204` has nowhere else to say it.
 *
 * Between them sits the gate OP-132's liveness and selfie routes call:
 * `requireConsent`, which must refuse `412 consent_required` with the policy the
 * client has to agree to, and must refuse again the moment the consent is
 * withdrawn or the policy version moves on.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/p/events/[slug]/consent/route` exports `POST` and `DELETE`,
 * declared on `defineRoute({ route: "/api/v1/p/events/:slug/consent" })` with
 * the §6.2 `attendee` auth label, reading the slug off `request.url`:
 *
 *   - `POST { purpose: "biometric_processing", policyVersion, granted: true,
 *     ageConfirmed: true }` → `201` with exactly
 *     `{consentId, purpose, policyVersion, grantedAt, receiptSent, receiptNote}`,
 *     a `consents` row (schema §15.4) with `policyDocumentHash` (`sha256:<64 hex>`),
 *     `grantedAt`, `withdrawnAt: null` and `evidence {ipHash, uaHash, method:
 *     "checkbox", locale}`, and an `attendee_event_profiles` row for this
 *     event + session carrying `consentId`;
 *   - a `policyVersion` that is not the current one → `422 policy_version_stale`
 *     with `details {currentPolicyVersion, policyUrl}` (Appendix A.7) and **no**
 *     write;
 *   - a missing or false `ageConfirmed` → `422 age_confirmation_required` and
 *     **no** write (green card §4 — the contract has no row for it, so the schema
 *     keeps the field optional and the handler refuses it);
 *   - `DELETE` → `204`, no body, `X-Deleted-Counts: selfies=<n>;embeddings=<n>;matches=<n>`,
 *     `consents.withdrawnAt` set, `attendeeEventProfiles.status = "withdrawn"`,
 *     and every `selfies` / `faceMatches` row of that profile deleted;
 *   - no attendee credential → `401 authentication_required` on both methods.
 *
 * `@/server/attendee/consent-guard` exports
 * `requireConsent({db, tenantKey, eventId, subject})`:
 *
 * ```ts
 * subject: {kind: "anonymous"; attendeeSessionId: string}
 *        | {kind: "user"; userId: ObjectId}
 * // resolves the granted consent in force, or throws
 * // appError("consent_required", {details: {purpose, requiredPolicyVersion, policyUrl}})
 * // returns {consentId: ObjectId}
 * ```
 *
 * ## Assumptions (ADR-0789 §Assumptions)
 *
 * - **Deletion is scoped by `profileId`.** `selfies` and `faceMatches` both
 *   carry `profileId` and the design document indexes it
 *   (`{profileId:1, isActive:1}`, `{profileId:1, imageId:1, faceIndex:1}`), so
 *   the withdraw counts are the rows of *this* profile — never a tenant-wide
 *   sweep and never a selfie of the caller's other event.
 * - **`embeddings` counts the selfies that carried a vector.** The vector is
 *   embedded in the `selfies` row (schema §16.4), so a selfie still queued has
 *   no `embedding` key and must not inflate the count.
 * - **The profile a grant creates starts `selfie_pending`** — the documented
 *   value of schema §15.3's closed `status` union. The green card's prose says
 *   `no_selfie`, which is not a member of that union; the schema wins
 *   (CONVENTIONS §10) and the conflict is routed in the handoff.
 * - **`policyDocumentHash` is deterministic per policy version.** Two attendees
 *   granting the same version store the same digest; a hash minted per row (a
 *   random salt, an ObjectId) would make the evidence unverifiable.
 * - **The receipt is not sent to an anonymous attendee** — §6.2 says so and the
 *   body's `receiptSent: false` + `receiptNote` are the observable facts. The
 *   `attendee.consent.receipt` notification fan-out is deliberately **not**
 *   pinned here (it needs an identified user, whose claim flow OP-132 owns).
 * - `consents` and `selfies` are read by their schema §15.4/§16.4 names, which
 *   `COLLECTIONS` does not declare yet (a `selfie` is a single word, so the
 *   snake_case convention of `media_assets`/`face_matches` cannot change it).
 * - The DSR `executionLog` append (§6.2) is out of scope: `dataSubjectRequests`
 *   does not exist until OP-138.
 */

let app: TestApp;

/* ───────────────────────────── contract constants ────────────────────────── */

/** The current biometric policy version the settings default to (contract §6.1). */
const POLICY_VERSION = "biometric-2026-03";

/** The current policy URL the settings default to (contract §6.1/A.7). */
const POLICY_URL = "https://openpic.in/legal/biometric/2026-03";

/** A policy version the platform no longer serves, for the `422` pin. */
const STALE_POLICY_VERSION = "biometric-2025-01";

/** The one consent purpose the attendee surface asks for (contract §6.2). */
const PURPOSE = "biometric_processing";

/** The §6.2 receipt note for an attendee with no verified contact. */
const RECEIPT_NOTE = "A consent receipt is emailed only to signed-in attendees.";

/** The user agent these cases send, so a stored raw copy is detectable. */
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Op131ConsentProbe/1.0";

/** The `Accept-Language` header these cases send. */
const ACCEPT_LANGUAGE = "en-IN,en;q=0.9";

/** The six keys the §6.2 `201` body carries, sorted. */
const GRANT_KEYS = [
  "consentId",
  "grantedAt",
  "policyVersion",
  "purpose",
  "receiptNote",
  "receiptSent",
];

/** A `policyDocumentHash` as schema §15.4 spells it. */
const DOCUMENT_HASH = /^sha256:[0-9a-f]{64}$/;

/** A SHA-256 digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The `consents` collection name (schema §15.4; `COLLECTIONS` has no entry yet). */
const CONSENTS = "consents";

/** The `selfies` collection name (schema §16.4). */
const SELFIES = "selfies";

/** The §6.2 withdrawal header name, lowercase as a header map stores it. */
const DELETED_COUNTS_HEADER = "x-deleted-counts";

/** One event status, as schema §15.1 spells them. */
type SeededStatus = "draft" | "published" | "live" | "ended" | "archived" | "deleting";

/** A stored `consents` row, as these cases read it (schema §15.4). */
interface ConsentRow {
  readonly _id: ObjectId;
  readonly tenantId: unknown;
  readonly eventId: unknown;
  readonly subject: Record<string, unknown>;
  readonly purpose: string;
  readonly policyVersion: string;
  readonly policyDocumentHash: string;
  readonly grantedAt: Date;
  readonly withdrawnAt: Date | null;
  readonly evidence: {
    readonly ipHash: string;
    readonly uaHash: string;
    readonly method: string;
    readonly locale: string;
  };
  readonly createdAt: Date;
}

/** A stored `attendee_event_profiles` row, as these cases read it (§15.3). */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly subject: Record<string, unknown>;
  readonly consentId?: unknown;
}

/* ───────────────────────────────── harness ───────────────────────────────── */

beforeAll(async () => {
  app = await startTestApp({ prefix: "op131-consent" });
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
    CONSENTS,
    SELFIES,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read a route export off a route namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST" | "DELETE",
  path: string
): (request: Request) => Promise<Response> {
  const handler: unknown = Reflect.get(module, name);
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const createAttendeeSessionHandler = requireHandler(
  attendeeSessionsRouteModule,
  "POST",
  "/api/v1/p/attendee-sessions"
);
const postConsentHandler = requireHandler(
  consentRouteModule,
  "POST",
  "/api/v1/p/events/:slug/consent"
);
const deleteConsentHandler = requireHandler(
  consentRouteModule,
  "DELETE",
  "/api/v1/p/events/:slug/consent"
);

/** A monotonically-increasing client address, so no two cases share a bucket. */
let ipSeq = 0;

/**
 * A client address no other case has used.
 *
 * The `attendee.session` class is fail-closed and capped at 60/hour/IP, so a
 * suite that reused one address would eventually be throttled instead of
 * exercising the route.
 *
 * @returns A fresh RFC 5737 TEST-NET-2 address.
 */
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${String(ipSeq)}`;
}

/** The sorted own keys of a JSON object, or `[]` for a non-object. */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/** The single element of a one-element list, naming the expectation on failure. */
function only<T>(rows: readonly T[], what: string): T {
  const [first] = rows;
  if (rows.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${what}, received ${String(rows.length)}`);
  }
  return first;
}

/** Parse a success body, failing loudly on an unexpected status. */
async function bodyOf(
  response: Response,
  expectedStatus: number,
  label: string
): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status !== expectedStatus) {
    throw new Error(
      `expected ${String(expectedStatus)} from ${label}, received ${String(response.status)}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed;
}

/** The `error` block of a refusal body. */
async function errorBody(
  response: Response
): Promise<{ code: string; message?: string; details?: Record<string, unknown> }> {
  const parsed = (await response.json()) as Record<string, unknown>;
  const envelope = parsed.error;
  if (envelope === null || typeof envelope !== "object") {
    throw new Error("expected the refusal body to carry an `error` object");
  }
  return envelope as { code: string; message?: string; details?: Record<string, unknown> };
}

/** Await a promise that must reject with an `AppError`, and return it. */
async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (!isAppError(caught)) {
    throw new Error(`expected an AppError, received ${String(caught)}`);
  }
  return caught;
}

/** A signed-in user who owns a fresh active tenant. */
async function seedOwner(prefix: string): Promise<{ user: SignedInUser; tenantId: ObjectId }> {
  const user = await app.signIn(makeIdentity(prefix));
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId: user.userId },
      { $set: { accountCompletedAt: new Date(), displayName: "Organizer", updatedAt: new Date() } }
    );
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op131-${prefix}`,
    name: "Rahul Studio",
    status: "active",
    ownerUserId: user.userId,
    billingContactUserId: user.userId,
    dataRegion: "in",
    counters: {
      eventCount: 1,
      activeEventCount: 1,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return { user, tenantId };
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

/** A seeded event: its id, the active link's slug and its name. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
  readonly name: string;
}

/**
 * Insert a stored `events` row (schema §15.1) with one active access link.
 *
 * @param tenantKey - The owning tenant (hex, as the create route stores it).
 * @param ownerUserId - The organizer's user id (hex).
 * @returns The event id and its active slug.
 */
async function seedEvent(tenantKey: string, ownerUserId: string): Promise<SeededEvent> {
  const _id = new ObjectId();
  const now = new Date("2026-01-02T00:00:00.000Z");
  const slug = `op131${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  const name = "Rahul & Priya's Wedding";

  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name,
    description: "",
    status: "published" satisfies SeededStatus,
    startAt: new Date("2026-11-14T12:00:00.000Z"),
    endAt: new Date("2026-11-15T04:00:00.000Z"),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date("2026-11-22T04:00:00.000Z"),
    retentionExpiresAt: new Date("2027-02-14T18:00:00.000Z"),
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null, scanCount: 0 }],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: ownerUserId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: ownerUserId,
    role: "organizer",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });

  return { id: _id, slug, name };
}

/** One tenant and one published event — the shape every case needs. */
async function seedPublishedEvent(
  prefix: string
): Promise<{ tenantKey: string; event: SeededEvent }> {
  const { user, tenantId } = await seedOwner(prefix);
  const tenantKey = tenantId.toHexString();
  const event = await seedEvent(tenantKey, user.userId.toHexString());
  return { tenantKey, event };
}

/** The cookie and stored session id of a real anonymous attendee session. */
interface AttendeeSession {
  readonly cookie: string;
  readonly sessionId: string;
}

/**
 * Create a real anonymous attendee session bound to `slug`.
 *
 * The request carries an address because `POST /p/attendee-sessions` mounts the
 * fail-closed `attendee.session` class, which refuses an unattributable caller
 * with `503` before the handler runs.
 *
 * @param slug - The event slug to bind the session to.
 * @param ip - The client address to attribute the call to.
 * @returns The `op_att` cookie to replay and the stored session id.
 */
async function createAttendeeSession(slug: string, ip: string): Promise<AttendeeSession> {
  const response = await createAttendeeSessionHandler(
    new Request(new URL("/api/v1/p/attendee-sessions", APP_ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ eventSlug: slug }),
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
  const token = cookie.slice(`${ATTENDEE_COOKIE_NAME}=`.length);
  const row = await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) });
  if (row === null) {
    throw new Error("expected the attendee session row to exist");
  }
  return { cookie, sessionId: String(row._id) };
}

/** The §6.2 grant body, with the age confirmation the green card requires. */
function grantBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purpose: PURPOSE,
    policyVersion: POLICY_VERSION,
    granted: true,
    ageConfirmed: true,
    ...overrides,
  };
}

/** The §6.2 grant body with the age confirmation deliberately absent (§4). */
function grantBodyWithoutAge(): Record<string, unknown> {
  return { purpose: PURPOSE, policyVersion: POLICY_VERSION, granted: true };
}

/**
 * A consent request against `slug`.
 *
 * @param method - `POST` (grant) or `DELETE` (withdraw).
 * @param slug - The event's active access-link slug.
 * @param options - The credential, the client address and an optional body.
 * @returns The request a route handler is invoked with.
 */
function consentRequest(
  method: "POST" | "DELETE",
  slug: string,
  options: { cookie?: string; ip: string; body?: Record<string, unknown> }
): Request {
  return new Request(new URL(`/api/v1/p/events/${slug}/consent`, APP_ORIGIN), {
    method,
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "accept-language": ACCEPT_LANGUAGE,
      "x-forwarded-for": options.ip,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** A granted consent, with every handle the follow-up calls need. */
interface ConsentFlow {
  readonly tenantKey: string;
  readonly event: SeededEvent;
  readonly session: AttendeeSession;
  readonly ip: string;
  readonly body: Record<string, unknown>;
}

/**
 * Seed an event, mint an attendee session on it and grant consent through the
 * real route, so every stored shape below is the implementation's own.
 *
 * @param prefix - The suite-local prefix for the seeded organizer identity.
 * @returns The flow's handles.
 */
async function grantConsent(prefix: string): Promise<ConsentFlow> {
  const { tenantKey, event } = await seedPublishedEvent(prefix);
  const ip = nextIp();
  const session = await createAttendeeSession(event.slug, ip);
  const response = await postConsentHandler(
    consentRequest("POST", event.slug, { cookie: session.cookie, ip, body: grantBody() })
  );
  const body = await bodyOf(response, 201, "POST consent");
  return { tenantKey, event, session, ip, body };
}

/** The stored `consents` rows, newest last. */
async function consentRows(): Promise<ConsentRow[]> {
  return (await app.db.collection(CONSENTS).find({}).toArray()) as unknown as ConsentRow[];
}

/** The stored `attendee_event_profiles` rows. */
async function profileRows(): Promise<ProfileRow[]> {
  return (await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({})
    .toArray()) as unknown as ProfileRow[];
}

/** The facts one seeded biometric footprint varies (schema §16.1/§16.4/§17.5). */
interface BiometricSeed {
  readonly selfies: number;
  readonly embedded: number;
  readonly matches: number;
  readonly assetRefCount: number | null;
}

/** The ids the seeded footprint is reachable by. */
interface SeededBiometrics {
  readonly profileId: ObjectId;
  readonly assetId: ObjectId | null;
}

/**
 * Seed the selfie / embedding / match / media-asset footprint a withdrawal must
 * destroy, scoped by the profile the grant created.
 *
 * A selfie still queued has **no** `embedding` key at all (schema §16.4 stores
 * the vector on the row), which is what separates `embeddings` from `selfies`
 * in the counts.
 *
 * @param flow - The granted flow whose profile owns the rows.
 * @param seed - How many of each row to insert.
 * @returns The profile id and the seeded media asset id, when one was seeded.
 */
async function seedBiometrics(flow: ConsentFlow, seed: BiometricSeed): Promise<SeededBiometrics> {
  const profile = only(await profileRows(), "attendee profile");

  const assetId = seed.assetRefCount === null ? null : new ObjectId();
  if (assetId !== null) {
    await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
      _id: assetId,
      tenantId: flow.tenantKey,
      contentHash: createHash("sha256").update(assetId.toHexString()).digest("hex"),
      kind: "selfie",
      refCount: seed.assetRefCount,
      status: "derivatives_ready",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
  }

  const subject = { kind: "anonymous", attendeeSessionId: flow.session.sessionId };
  for (let index = 0; index < seed.selfies; index += 1) {
    await app.db.collection(SELFIES).insertOne({
      tenantId: flow.tenantKey,
      eventId: flow.event.id.toHexString(),
      profileId: profile._id,
      subject,
      assetId: index === 0 ? assetId : null,
      isActive: index === 0,
      ...(index < seed.embedded ? { embedding: new Binary(Buffer.alloc(16), 9) } : {}),
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
  }

  for (let index = 0; index < seed.matches; index += 1) {
    await app.db.collection(COLLECTIONS.faceMatches).insertOne({
      tenantId: flow.tenantKey,
      eventId: flow.event.id.toHexString(),
      profileId: profile._id,
      subject,
      imageId: new ObjectId(),
      faceIndex: index,
      selfieId: profile._id,
      similarity: 0.512,
      confidence: "normal",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
  }

  return { profileId: profile._id, assetId };
}

/* ───────────────────────── I2 — grant (contract §6.2) ─────────────────────── */

describe("POST /api/v1/p/events/{slug}/consent — the grant (contract §6.2)", () => {
  it("I2: answers 201 with exactly the six documented keys", async () => {
    const flow = await grantConsent("op131-grant-shape");

    expect(keysOf(flow.body)).toEqual(GRANT_KEYS);
    expect(flow.body.purpose).toBe(PURPOSE);
    expect(flow.body.policyVersion).toBe(POLICY_VERSION);
  });

  it("I2: reports the receipt as unsent for an anonymous attendee, with the contract's note", async () => {
    const flow = await grantConsent("op131-grant-receipt");

    expect(flow.body.receiptSent).toBe(false);
    expect(flow.body.receiptNote).toBe(RECEIPT_NOTE);
  });

  it("I2: writes one consents row carrying the policy version, the document hash and the evidence", async () => {
    const flow = await grantConsent("op131-grant-row");

    const row = only(await consentRows(), "consents row");

    expect(String(row._id)).toBe(flow.body.consentId);
    expect(row.purpose).toBe(PURPOSE);
    expect(row.policyVersion).toBe(POLICY_VERSION);
    // A version string alone is worthless if the document behind it was edited
    // (schema §15.4) — the digest is what makes the consent demonstrable.
    expect(row.policyDocumentHash).toMatch(DOCUMENT_HASH);
    expect(row.grantedAt).toBeInstanceOf(Date);
    expect(row.withdrawnAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    // `tenantId`/`eventId` are hex either way the route stores them.
    expect(String(row.tenantId)).toBe(flow.tenantKey);
    expect(String(row.eventId)).toBe(flow.event.id.toHexString());
    expect(row.subject).toMatchObject({
      kind: "anonymous",
      attendeeSessionId: flow.session.sessionId,
    });
    expect(row.evidence).toMatchObject({ method: "checkbox", locale: "en-IN" });
    expect(row.evidence.ipHash).toMatch(SHA256_HEX);
    expect(row.evidence.uaHash).toMatch(SHA256_HEX);
  });

  it("I2: hashes the caller's address and user agent, so the row stores neither raw", async () => {
    const flow = await grantConsent("op131-grant-hashed");

    const row = only(await consentRows(), "consents row");
    const stored = JSON.stringify(row);

    expect(stored).not.toContain(flow.ip);
    expect(stored).not.toContain(USER_AGENT);
    expect(JSON.stringify(flow.body)).not.toContain(flow.ip);
    expect(JSON.stringify(flow.body)).not.toContain(USER_AGENT);
  });

  it("I2: links the grant to an attendee profile that starts selfie_pending", async () => {
    const flow = await grantConsent("op131-grant-profile");

    const profile = only(await profileRows(), "attendee profile");

    // Schema §15.3 is the closed `status` union; the green card's prose says
    // `no_selfie`, which is not a member of it (ADR-0789 §Assumptions).
    expect(profile.status).toBe("selfie_pending");
    expect(profile.subject).toMatchObject({
      kind: "anonymous",
      attendeeSessionId: flow.session.sessionId,
    });
    expect(String(profile.consentId)).toBe(flow.body.consentId);
  });

  it("I2: hashes the same policy document to the same digest for two attendees", async () => {
    const first = await grantConsent("op131-grant-digest-one");
    const second = await grantConsent("op131-grant-digest-two");

    const rows = await consentRows();

    expect(rows).toHaveLength(2);
    // A digest minted per row (a salt, an ObjectId) would make the evidence
    // unverifiable, so the same version must always hash the same way.
    expect(new Set(rows.map((row) => row.policyDocumentHash)).size).toBe(1);
    expect(rows.map((row) => String(row._id))).toEqual(
      expect.arrayContaining([first.body.consentId, second.body.consentId])
    );
  });

  it("I2: answers 401 authentication_required without an attendee credential and writes nothing", async () => {
    const { event } = await seedPublishedEvent("op131-grant-anonymous");

    const response = await postConsentHandler(
      consentRequest("POST", event.slug, { ip: nextIp(), body: grantBody() })
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
    expect(await consentRows()).toEqual([]);
    expect(await profileRows()).toEqual([]);
  });
});

/* ───────────────────── I1 / I5 — the grant refusals (§6.2, A.7) ───────────── */

describe("POST /api/v1/p/events/{slug}/consent — the refusals (contract §6.2, A.7)", () => {
  it("I1: a stale policy version answers 422 policy_version_stale with the current version and URL", async () => {
    const { event } = await seedPublishedEvent("op131-stale-version");
    const ip = nextIp();
    const session = await createAttendeeSession(event.slug, ip);

    const response = await postConsentHandler(
      consentRequest("POST", event.slug, {
        cookie: session.cookie,
        ip,
        body: grantBody({ policyVersion: STALE_POLICY_VERSION }),
      })
    );

    expect(response.status).toBe(422);
    const error = await errorBody(response);
    expect(error.code).toBe("policy_version_stale");
    // Appendix A.7 fixes both details, so the client can re-render and retry.
    expect(error.details).toEqual({
      currentPolicyVersion: POLICY_VERSION,
      policyUrl: POLICY_URL,
    });
  });

  it("I1: a stale grant writes no consents row and creates no profile", async () => {
    const { event } = await seedPublishedEvent("op131-stale-writes");
    const ip = nextIp();
    const session = await createAttendeeSession(event.slug, ip);

    const response = await postConsentHandler(
      consentRequest("POST", event.slug, {
        cookie: session.cookie,
        ip,
        body: grantBody({ policyVersion: STALE_POLICY_VERSION }),
      })
    );

    expect(response.status).toBe(422);
    expect(await consentRows()).toEqual([]);
    expect(await profileRows()).toEqual([]);
  });

  it("I5: a grant without the age confirmation answers 422 age_confirmation_required", async () => {
    const { event } = await seedPublishedEvent("op131-no-age");
    const ip = nextIp();
    const session = await createAttendeeSession(event.slug, ip);

    const response = await postConsentHandler(
      consentRequest("POST", event.slug, {
        cookie: session.cookie,
        ip,
        body: grantBodyWithoutAge(),
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("age_confirmation_required");
    expect(await consentRows()).toEqual([]);
  });

  it("I5: a false age confirmation answers 422 age_confirmation_required and writes nothing", async () => {
    const { event } = await seedPublishedEvent("op131-false-age");
    const ip = nextIp();
    const session = await createAttendeeSession(event.slug, ip);

    const response = await postConsentHandler(
      consentRequest("POST", event.slug, {
        cookie: session.cookie,
        ip,
        body: grantBody({ ageConfirmed: false }),
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("age_confirmation_required");
    expect(await consentRows()).toEqual([]);
    expect(await profileRows()).toEqual([]);
  });
});

/* ─────────────────── I3 — withdrawal (contract §6.2, schema §16.4) ────────── */

describe("DELETE /api/v1/p/events/{slug}/consent — withdrawal (contract §6.2)", () => {
  it("I3: answers 204 with X-Deleted-Counts selfies=1;embeddings=1;matches=3 and no body", async () => {
    const flow = await grantConsent("op131-withdraw-counts");
    await seedBiometrics(flow, { selfies: 1, embedded: 1, matches: 3, assetRefCount: null });

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, {
        cookie: flow.session.cookie,
        ip: flow.ip,
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get(DELETED_COUNTS_HEADER)).toBe("selfies=1;embeddings=1;matches=3");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("I3: deletes the selfie, its embedding and every face match of the profile", async () => {
    const flow = await grantConsent("op131-withdraw-deletes");
    const seeded = await seedBiometrics(flow, {
      selfies: 1,
      embedded: 1,
      matches: 3,
      assetRefCount: null,
    });

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );

    expect(response.status).toBe(204);
    // The data-subject-initiated deletion is bounded by the profile (§6.2): no
    // selfie and no match of this profile may survive it.
    expect(await app.db.collection(SELFIES).countDocuments({ profileId: seeded.profileId })).toBe(
      0
    );
    expect(
      await app.db
        .collection(COLLECTIONS.faceMatches)
        .countDocuments({ profileId: seeded.profileId })
    ).toBe(0);
  });

  it("I3: marks the consent and the profile withdrawn", async () => {
    const flow = await grantConsent("op131-withdraw-marks");
    await seedBiometrics(flow, { selfies: 1, embedded: 1, matches: 3, assetRefCount: null });

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );

    expect(response.status).toBe(204);
    const consent = only(await consentRows(), "consents row");
    expect(String(consent._id)).toBe(flow.body.consentId);
    expect(consent.withdrawnAt).toBeInstanceOf(Date);
    const profile = only(await profileRows(), "attendee profile");
    expect(profile.status).toBe("withdrawn");
  });

  it("I3: counts only the selfies that carried an embedding", async () => {
    const flow = await grantConsent("op131-withdraw-pending");
    await seedBiometrics(flow, { selfies: 2, embedded: 1, matches: 3, assetRefCount: null });

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );

    expect(response.status).toBe(204);
    // The second selfie was still queued and held no face vector, so the
    // embedding count must stay at one (schema §16.4).
    expect(response.headers.get(DELETED_COUNTS_HEADER)).toBe("selfies=2;embeddings=1;matches=3");
    expect(await app.db.collection(SELFIES).countDocuments({})).toBe(0);
  });

  it("I3: reports zeros when the attendee has no biometric data yet", async () => {
    const flow = await grantConsent("op131-withdraw-empty");

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get(DELETED_COUNTS_HEADER)).toBe("selfies=0;embeddings=0;matches=0");
  });

  it("I3: releases the deleted selfie's media asset reference", async () => {
    const flow = await grantConsent("op131-withdraw-asset");
    const seeded = await seedBiometrics(flow, {
      selfies: 1,
      embedded: 1,
      matches: 0,
      assetRefCount: 1,
    });
    if (seeded.assetId === null) {
      throw new Error("expected the seeded media asset id");
    }

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );

    expect(response.status).toBe(204);
    const asset = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: seeded.assetId });
    // The blob is purged only once nothing references it (schema §16.1), so the
    // withdrawal drops the reference the deleted selfie held.
    expect(asset?.refCount).toBe(0);
  });

  it("I3: answers 401 authentication_required without an attendee credential and deletes nothing", async () => {
    const flow = await grantConsent("op131-withdraw-anonymous");
    await seedBiometrics(flow, { selfies: 1, embedded: 1, matches: 3, assetRefCount: null });

    const response = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { ip: nextIp() })
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("authentication_required");
    expect(await app.db.collection(SELFIES).countDocuments({})).toBe(1);
    expect(await app.db.collection(COLLECTIONS.faceMatches).countDocuments({})).toBe(3);
  });
});

/* ─────────────── I4 — requireConsent, the gate OP-132's routes call ───────── */

describe("requireConsent — the biometric gate (green card §3, contract §6.2/A.7)", () => {
  it("I4: refuses 412 consent_required when the attendee has not granted consent", async () => {
    const { tenantKey, event } = await seedPublishedEvent("op131-guard-missing");
    const ip = nextIp();
    const session = await createAttendeeSession(event.slug, ip);

    const error = await appErrorOf(
      requireConsent({
        db: app.db,
        tenantKey,
        eventId: event.id,
        subject: { kind: "anonymous", attendeeSessionId: session.sessionId },
      })
    );

    expect(error.status).toBe(412);
    expect(error.code).toBe("consent_required");
    // Appendix A.7: the client needs the purpose and the policy to re-render.
    expect(error.details).toEqual({
      purpose: PURPOSE,
      requiredPolicyVersion: POLICY_VERSION,
      policyUrl: POLICY_URL,
    });
  });

  it("I4: resolves the consent id of a granted consent", async () => {
    const flow = await grantConsent("op131-guard-granted");

    const result = await requireConsent({
      db: app.db,
      tenantKey: flow.tenantKey,
      eventId: flow.event.id,
      subject: { kind: "anonymous", attendeeSessionId: flow.session.sessionId },
    });

    expect(String(result.consentId)).toBe(flow.body.consentId);
  });

  it("I4: refuses 412 consent_required again once the consent is withdrawn", async () => {
    const flow = await grantConsent("op131-guard-withdrawn");
    const deleted = await deleteConsentHandler(
      consentRequest("DELETE", flow.event.slug, { cookie: flow.session.cookie, ip: flow.ip })
    );
    expect(deleted.status).toBe(204);

    const error = await appErrorOf(
      requireConsent({
        db: app.db,
        tenantKey: flow.tenantKey,
        eventId: flow.event.id,
        subject: { kind: "anonymous", attendeeSessionId: flow.session.sessionId },
      })
    );

    expect(error.status).toBe(412);
    expect(error.code).toBe("consent_required");
  });

  it("I4: refuses 412 consent_required when the granted consent names a stale policy version", async () => {
    const flow = await grantConsent("op131-guard-stale");
    const consent = only(await consentRows(), "consents row");
    await app.db
      .collection(CONSENTS)
      .updateOne({ _id: consent._id }, { $set: { policyVersion: STALE_POLICY_VERSION } });

    const error = await appErrorOf(
      requireConsent({
        db: app.db,
        tenantKey: flow.tenantKey,
        eventId: flow.event.id,
        subject: { kind: "anonymous", attendeeSessionId: flow.session.sessionId },
      })
    );

    expect(error.status).toBe(412);
    expect(error.code).toBe("consent_required");
    expect(error.details).toMatchObject({ requiredPolicyVersion: POLICY_VERSION });
  });
});
