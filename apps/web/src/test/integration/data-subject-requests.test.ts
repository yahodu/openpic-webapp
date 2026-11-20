import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as attendeeSessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import * as dataRequestIdRouteModule from "@/app/api/v1/me/data-requests/[id]/route";
import * as dataRequestsRouteModule from "@/app/api/v1/me/data-requests/route";
import * as consentAcknowledgeRouteModule from "@/app/api/v1/me/consents/acknowledge/route";
import * as consentsRouteModule from "@/app/api/v1/me/consents/route";
import * as legalPoliciesRouteModule from "@/app/api/v1/legal/policies/current/route";
import { ATTENDEE_COOKIE_NAME } from "@/server/attendee/session-cookie";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  getPlatformSettings,
  invalidatePlatformSettings,
  type PlatformSettings,
} from "@/server/settings/platform-settings";

import { makePlatformSettingsDocument } from "../factories/domain-event";
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
 * Integration / contract — data-subject requests, consent history and policy
 * acknowledgement (OP-138 I1–I15, contract §8.1/§8.2, schema §20.3/§20.4;
 * ADR-0898).
 *
 * **Why this exists.** A DSR is the one request a user cannot be refused, and
 * the one they must be able to prove was honoured:
 *
 *   - filing it answers `202` with a **statutory deadline** and one outbox event
 *     (the acknowledgement is the evidence, not the row);
 *   - the deadline comes from `platformSettings.compliance.slaDays`, so an
 *     operator changing the window changes every new request;
 *   - a banned account may still file (§0.3 exempts exactly this route, next to
 *     `GET /me`), and an anonymous attendee may file about **their own
 *     session's events only**;
 *   - the row is the data subject's alone: another user's request answers `404`,
 *     and the owning user reads their own `executionLog` counts — "we deleted
 *     412 embeddings and 1,904 matches" is the whole point (§8.1, §20.3);
 *   - consent records are verifiable years later, so the acknowledgement writes a
 *     `consents` row carrying `policyDocumentHash`, and a stale policy version is
 *     refused rather than silently recorded.
 *
 * ## Contract expected of the implementation
 *
 * - `POST /api/v1/me/data-requests` (user **or** attendee, `Idempotency-Key`
 *   required, 5 / day / principal) → `202` with exactly
 *   `{id, requestType, status, slaDueAt, acknowledgement, pollUrl}`, one
 *   `domain_events` row per accepted create (`eventKey: "privacy.dsr.received"`,
 *   `payload.requestType` and `payload.slaDueAt` naming the request) and one
 *   `dataSubjectRequests` row (§20.3). `acknowledgement` is §8.1's sentence
 *   verbatim, rendered from `slaDueAt` as `25 October 2026`.
 * - A scope naming an event outside the caller's session → `422 invalid_scope`
 *   with `details.eventIds` carrying the offending ids, and **no** row.
 * - A banned user → `202` (§0.3's exemption), never `423`.
 * - `GET /api/v1/me/data-requests/{id}` → the owner's row, `404 not_found` for
 *   anybody else's; `GET /api/v1/me/data-requests` → `{data, page}` with only
 *   the caller's rows (§0.8's envelope, as `/me/events` uses it).
 * - `GET /api/v1/legal/policies/current` (public) → `200`, `cache-control:
 *   public, max-age=3600`, one entry per purpose with `version`, `url`,
 *   `effectiveFrom` and a `sha256:` `documentHash`.
 * - `POST /api/v1/me/consents/acknowledge` → `201` and a `consents` row; a
 *   version the platform no longer serves → `422 policy_version_stale` with
 *   `details.currentPolicyVersion`, and **no** row.
 * - `GET /api/v1/me/consents?purpose=` → the caller's rows, each carrying
 *   `policyDocumentHash`.
 *
 * ## Assumptions (ADR-0898 §Assumptions)
 *
 * - **Every case files through a tenant.** `emitDomainEvent` requires a
 *   `tenantId`, so a request that resolves no tenant at all is deliberately not
 *   exercised here (routed as an open question in the handoff): a scoped request
 *   derives its `scope.tenantIds` from the events it names.
 * - **An attendee's DSR is not gated on biometric consent.** §6.2's gate covers
 *   the selfie surface; a data-subject request is the right itself.
 * - **`dataSubjectRequests` stores `subject.userId` as the caller's `ObjectId`**
 *   (schema §20.3, the representation `consents` already uses) and
 *   `scope.eventIds` either as `ObjectId`s or as hex strings — these cases
 *   compare the string form, so both are accepted.
 * - **The DSR list uses §0.8's `{data, page}` envelope**, the shape
 *   `GET /me/events` and `GET /me/notifications` already answer, because §8.1
 *   documents only the single-request body.
 */

/* ───────────────────────────── contract constants ────────────────────────── */

/** The still-unregistered `dataSubjectRequests` collection (schema §20.3). */
const DATA_SUBJECT_REQUESTS = "dataSubjectRequests";

/** The `consents` collection (schema §15.4). */
const CONSENTS = "consents";

/** The platform-settings singleton's collection name (schema §20.4). */
const PLATFORM_SETTINGS = "platformSettings";

/** The outbox event key a filed request announces (contract §7.6). */
const DSR_EVENT_KEY = "privacy.dsr.received";

/** The document purpose the acknowledgement writes (§8.2). */
const TERMS_PURPOSE = "terms_of_service";

/** The document purpose the consent record also covers (§8.2). */
const BIOMETRIC_PURPOSE = "biometric_processing";

/** The per-regulation SLA windows these cases seed (§8.1's tunable). */
const SLA_DAYS = { gdpr: 30, dpdpa: 90 } as const;

/** The §8.2 `Cache-Control` the public policy document must serve. */
const POLICY_CACHE_CONTROL = "public, max-age=3600";

/** A `policyDocumentHash` as schema §15.4 spells it. */
const DOCUMENT_HASH = /^sha256:[0-9a-f]{64}$/;

/** A policy version the platform never served, for the stale-version pin. */
const STALE_POLICY_VERSION = "tos-1999-01";

/** Milliseconds in one calendar day, used only to state expected instants. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** One event status, as schema §15.1 spells them. */
type SeededStatus = "draft" | "published" | "live" | "ended" | "archived" | "deleting";

/* ───────────────────────────────── harness ───────────────────────────────── */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op138-dsr" });
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
    COLLECTIONS.mediaAssets,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    PLATFORM_SETTINGS,
    DATA_SUBJECT_REQUESTS,
    CONSENTS,
  ]) {
    await app.db.collection(name).deleteMany({});
  }

  // Every case runs against windows it can predict; the read cache is per
  // process, so it must be dropped or a previous case's document answers.
  await app.db
    .collection(PLATFORM_SETTINGS)
    .insertOne(makePlatformSettingsDocument({ compliance: { slaDays: { ...SLA_DAYS } } }));
  invalidatePlatformSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read a route export off a route namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST",
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
const postDataRequestHandler = requireHandler(
  dataRequestsRouteModule,
  "POST",
  "/api/v1/me/data-requests"
);
const listDataRequestsHandler = requireHandler(
  dataRequestsRouteModule,
  "GET",
  "/api/v1/me/data-requests"
);
const getDataRequestHandler = requireHandler(
  dataRequestIdRouteModule,
  "GET",
  "/api/v1/me/data-requests/:id"
);
const listConsentsHandler = requireHandler(consentsRouteModule, "GET", "/api/v1/me/consents");
const acknowledgeConsentHandler = requireHandler(
  consentAcknowledgeRouteModule,
  "POST",
  "/api/v1/me/consents/acknowledge"
);
const legalPoliciesHandler = requireHandler(
  legalPoliciesRouteModule,
  "GET",
  "/api/v1/legal/policies/current"
);

/** A monotonically-increasing client address, so no two cases share a bucket. */
let ipSeq = 0;

/**
 * A client address no other case has used.
 *
 * `attendee.session` is fail-closed and capped at 60 / hour / IP, so a suite
 * that reused one address would eventually be throttled instead of exercising
 * the route.
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

/** An identifier in its canonical hex string form, whatever the row stores. */
function asId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return String(value);
}

/** The §8.1 acknowledgement date rendering, in UTC. */
function formatSlaDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(instant);
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

/** Parse any JSON success body, failing loudly on an unexpected status. */
async function jsonOf(response: Response, expectedStatus: number, label: string): Promise<unknown> {
  const parsed: unknown = await response.json();
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

/* ───────────────────────────── tenant fixtures ───────────────────────────── */

/** A seeded tenant and the signed-in owner who holds it. */
interface SeededTenant {
  readonly user: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
}

/** A seeded event: its id, its active link slug and its name. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
  readonly name: string;
}

/** A signed-in owner with one active `in` tenant (the default data region). */
async function seedOwner(prefix: string): Promise<SeededTenant> {
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
    slug: `op138-${prefix}`,
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
  return { user, tenantId, tenantKey: tenantId.toHexString() };
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

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
  seededSlugSeq += 1;
  const slug = `op138${String(seededSlugSeq).padStart(6, "0")}`;
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

/** An owner with one tenant and one published event in it. */
interface OwnerEvent {
  readonly user: SignedInUser;
  readonly tenantKey: string;
  readonly event: SeededEvent;
}

/** Seed a tenant and one published event — the shape most cases need. */
async function seedOwnerEvent(prefix: string): Promise<OwnerEvent> {
  const tenant = await seedOwner(prefix);
  const event = await seedEvent(tenant.tenantKey, tenant.user.userId.toHexString());
  return { user: tenant.user, tenantKey: tenant.tenantKey, event };
}

/** The cookie and stored session id of a real anonymous attendee session. */
interface AttendeeSession {
  readonly cookie: string;
  readonly sessionId: string;
}

/**
 * Create a real anonymous attendee session bound to `slug`.
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

/* ───────────────────────────── request builders ──────────────────────────── */

/** Options for one `/me/data-requests` call. */
interface DataRequestCall {
  readonly cookie: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly ip?: string;
}

/** Build a `POST /api/v1/me/data-requests` request. */
function postDataRequest(call: DataRequestCall): Request {
  return new Request(new URL("/api/v1/me/data-requests", APP_ORIGIN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": call.idempotencyKey ?? randomUUID(),
      "x-forwarded-for": call.ip ?? nextIp(),
      cookie: call.cookie,
    },
    body: JSON.stringify(call.body),
  });
}

/** Build a `GET` request for an authenticated `/me` or legal path. */
function getRequest(path: string, options: { cookie?: string; ip?: string } = {}): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "GET",
    headers: {
      "x-forwarded-for": options.ip ?? nextIp(),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
  });
}

/** File one request through the real route and return its `202` body. */
async function fileRequest(call: DataRequestCall, label = "POST /me/data-requests") {
  const response = await postDataRequestHandler(postDataRequest(call));
  return bodyOf(response, 202, label);
}

/** The stored `dataSubjectRequests` row for a `202` body's id. */
async function storedRequest(body: Record<string, unknown>) {
  const row = await app.db
    .collection(DATA_SUBJECT_REQUESTS)
    .findOne({ _id: new ObjectId(String(body.id)) });
  if (row === null) {
    throw new Error(`expected a dataSubjectRequests row for ${String(body.id)}`);
  }
  return row as Record<string, unknown>;
}

/** The stored `dataSubjectRequests` rows, oldest first. */
async function storedRequests(): Promise<Record<string, unknown>[]> {
  return await app.db.collection(DATA_SUBJECT_REQUESTS).find({}).sort({ receivedAt: 1 }).toArray();
}

/** The `domain_events` rows this suite's creates produced. */
async function dsrEvents(): Promise<Record<string, unknown>[]> {
  return await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: DSR_EVENT_KEY })
    .toArray();
}

/** The stored `consents` rows. */
async function consentRows(): Promise<Record<string, unknown>[]> {
  return await app.db.collection(CONSENTS).find({}).toArray();
}

/** The current platform settings the routes are served (for cross-checks). */
async function currentSettings(): Promise<PlatformSettings> {
  return getPlatformSettings({ db: app.db });
}

/* ─────────────────────────────── DSR filing ──────────────────────────────── */

describe("I1 — filing a request answers 202 with its SLA and one domain event (§8.1)", () => {
  it("I1: a scoped erasure request answers the six-key 202, stores it and emits one event", async () => {
    const { user, tenantKey, event } = await seedOwnerEvent("i1");
    const before = Date.now();

    const response = await postDataRequestHandler(
      postDataRequest({
        cookie: user.cookie,
        body: {
          requestType: "erasure",
          scope: { eventIds: [event.id.toHexString()] },
          note: "Please remove my face data.",
        },
      })
    );
    const after = Date.now();
    const body = await bodyOf(response, 202, "POST /me/data-requests");

    // §8.1's answer is exactly these six keys — no row internals.
    expect(keysOf(body)).toEqual([
      "acknowledgement",
      "id",
      "pollUrl",
      "requestType",
      "slaDueAt",
      "status",
    ]);
    expect(body.requestType).toBe("erasure");
    expect(body.status).toBe("received");
    expect(body.pollUrl).toBe(`/api/v1/me/data-requests/${String(body.id)}`);

    // The deadline is the seeded `compliance.slaDays.dpdpa` window, and the
    // tenant's `in` data region is what picked dpdpa.
    const dueMs = Date.parse(String(body.slaDueAt));
    expect(Number.isNaN(dueMs)).toBe(false);
    expect(dueMs).toBeGreaterThanOrEqual(before + SLA_DAYS.dpdpa * DAY_MS);
    expect(dueMs).toBeLessThanOrEqual(after + SLA_DAYS.dpdpa * DAY_MS);

    // §8.1's acknowledgement sentence, rendered from that same instant.
    expect(body.acknowledgement).toBe(
      `We've received your request and will complete it by ${formatSlaDay(new Date(dueMs))}.`
    );

    // The row the data subject will later read back.
    const row = await storedRequest(body);
    expect(row.requestType).toBe("erasure");
    expect(row.regulation).toBe("dpdpa");
    expect(row.status).toBe("received");
    expect(asId((row.scope as { eventIds?: unknown[] }).eventIds?.[0])).toBe(
      event.id.toHexString()
    );

    // One statutory acknowledgement, once — the event is the evidence.
    const events = await dsrEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(tenantKey);
    expect(events[0]?.payload).toMatchObject({
      requestType: "erasure",
      slaDueAt: body.slaDueAt,
    });
  });
});

describe("I2 — an attendee may not scope an event their session never touched (§8.1)", () => {
  it("I2: a scope naming an event outside the session answers 422 and writes nothing", async () => {
    const { tenantKey, user, event } = await seedOwnerEvent("i2");
    const other = await seedEvent(tenantKey, user.userId.toHexString());
    const session = await createAttendeeSession(event.slug, nextIp());

    const response = await postDataRequestHandler(
      postDataRequest({
        cookie: session.cookie,
        body: { requestType: "erasure", scope: { eventIds: [other.id.toHexString()] } },
      })
    );

    expect(response.status).toBe(422);
    const refusal = await errorBody(response);
    expect(refusal.code).toBe("invalid_scope");
    expect(refusal.details).toEqual({ eventIds: [other.id.toHexString()] });
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

describe("I3 — a banned account may still file a data-subject request (§0.3)", () => {
  it("I3: a banned user files an erasure request and receives 202, not 423", async () => {
    const { user, event } = await seedOwnerEvent("i3");
    await app.db
      .collection("user")
      .updateOne(
        { _id: user.userId },
        { $set: { banned: true, banReason: "spam", banExpires: new Date("2099-01-01T00:00:00Z") } }
      );

    const body = await fileRequest({
      cookie: user.cookie,
      body: { requestType: "erasure", scope: { eventIds: [event.id.toHexString()] } },
    });

    expect(body.status).toBe("received");
    expect(body.requestType).toBe("erasure");
    expect(await storedRequests()).toHaveLength(1);
  });
});

describe("I4 — a request belongs to its own data subject alone (§8.1)", () => {
  it("I4: reading another user's request answers 404", async () => {
    const first = await seedOwnerEvent("i4-a");
    const second = await seedOwnerEvent("i4-b");
    const filed = await fileRequest({
      cookie: first.user.cookie,
      body: { requestType: "access", scope: { eventIds: [first.event.id.toHexString()] } },
    });

    const response = await getDataRequestHandler(
      getRequest(`/api/v1/me/data-requests/${String(filed.id)}`, {
        cookie: second.user.cookie,
      })
    );

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });
});

describe("I5 — the filing budget is 5 per day per principal (§8.1)", () => {
  it("I5: the sixth request inside the window answers 429 rate_limited", async () => {
    const { user, event } = await seedOwnerEvent("i5");
    const body = { requestType: "access", scope: { eventIds: [event.id.toHexString()] } };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postDataRequestHandler(
        postDataRequest({ cookie: user.cookie, body, idempotencyKey: randomUUID() })
      );
      statuses.push(response.status);
    }
    const sixth = await postDataRequestHandler(
      postDataRequest({ cookie: user.cookie, body, idempotencyKey: randomUUID() })
    );

    expect(statuses).toEqual([202, 202, 202, 202, 202]);
    expect(sixth.status).toBe(429);
    expect((await errorBody(sixth)).code).toBe("rate_limited");
    expect(sixth.headers.get("retry-after")).not.toBeNull();
    expect(await storedRequests()).toHaveLength(5);
  });
});

describe("I8 — every documented request type is accepted with its SLA (§8.1)", () => {
  it.each([
    "access",
    "erasure",
    "rectification",
    "portability",
    "consent_withdrawal",
    "correction",
    "restriction",
    "objection",
    "nomination",
    "grievance",
  ])("I8: %s answers 202 with the dpdpa window", async (requestType) => {
    const { user, event } = await seedOwnerEvent(`i8-${requestType}`);
    const before = Date.now();

    const body = await fileRequest({
      cookie: user.cookie,
      body: { requestType, regulation: "dpdpa", scope: { eventIds: [event.id.toHexString()] } },
    });
    const after = Date.now();

    expect(body.requestType).toBe(requestType);
    expect(body.status).toBe("received");
    const dueMs = Date.parse(String(body.slaDueAt));
    expect(dueMs).toBeGreaterThanOrEqual(before + SLA_DAYS.dpdpa * DAY_MS);
    expect(dueMs).toBeLessThanOrEqual(after + SLA_DAYS.dpdpa * DAY_MS);
  });
});

describe("I9 — an anonymous session is limited to its own events (§8.1)", () => {
  it("I9: an unscoped attendee request is stored against the session's event", async () => {
    const { tenantKey, user, event } = await seedOwnerEvent("i9");
    const unrelated = await seedEvent(tenantKey, user.userId.toHexString());
    const session = await createAttendeeSession(event.slug, nextIp());

    const body = await fileRequest({
      cookie: session.cookie,
      body: { requestType: "erasure" },
    });

    const row = await storedRequest(body);
    const scope = row.scope as { eventIds?: unknown[]; tenantIds?: unknown[] };
    expect(scope.eventIds?.map(asId)).toEqual([event.id.toHexString()]);
    // Never the sibling event, even though the same organizer holds both.
    expect(scope.eventIds?.map(asId)).not.toContain(unrelated.id.toHexString());
    expect(scope.tenantIds?.map(asId)).toEqual([tenantKey]);
  });
});

describe("I10 — the data subject reads their own execution log (§8.1/§20.3)", () => {
  it("I10: the owning GET exposes the counted steps and a null export", async () => {
    const { user, event } = await seedOwnerEvent("i10");
    const filed = await fileRequest({
      cookie: user.cookie,
      body: { requestType: "erasure", scope: { eventIds: [event.id.toHexString()] } },
    });

    const completedAt = new Date("2026-10-01T00:00:00.000Z");
    const executionLog = [
      { step: "faceEmbeddings.deleted", count: 412, at: completedAt },
      { step: "faceMatches.deleted", count: 1904, at: completedAt },
      { step: "selfies.deleted", count: 3, at: completedAt },
      { step: "storageObjects.deleted", count: 3, at: completedAt },
    ];
    await app.db
      .collection(DATA_SUBJECT_REQUESTS)
      .updateOne(
        { _id: new ObjectId(String(filed.id)) },
        { $set: { status: "completed", completedAt, executionLog } }
      );

    const response = await getDataRequestHandler(
      getRequest(`/api/v1/me/data-requests/${String(filed.id)}`, { cookie: user.cookie })
    );
    const body = await bodyOf(response, 200, "GET /me/data-requests/:id");

    expect(body.id).toBe(filed.id);
    expect(body.status).toBe("completed");
    expect(body.completedAt).toBe(completedAt.toISOString());
    expect(body.export).toBeNull();
    const log = body.executionLog as { step: string; count: number; at: string }[];
    expect(log.map((entry) => entry.step)).toEqual([
      "faceEmbeddings.deleted",
      "faceMatches.deleted",
      "selfies.deleted",
      "storageObjects.deleted",
    ]);
    expect(log.map((entry) => entry.count)).toEqual([412, 1904, 3, 3]);
  });
});

describe("I11 — the list endpoint answers only the caller's own requests (§8.1/§0.8)", () => {
  it("I11: another user's request never appears in the caller's list", async () => {
    const first = await seedOwnerEvent("i11-a");
    const second = await seedOwnerEvent("i11-b");
    const mine = await fileRequest({
      cookie: first.user.cookie,
      body: { requestType: "access", scope: { eventIds: [first.event.id.toHexString()] } },
    });
    const theirs = await fileRequest({
      cookie: second.user.cookie,
      body: { requestType: "erasure", scope: { eventIds: [second.event.id.toHexString()] } },
    });

    const response = await listDataRequestsHandler(
      getRequest("/api/v1/me/data-requests", { cookie: first.user.cookie })
    );
    const body = await bodyOf(response, 200, "GET /me/data-requests");

    const ids = (body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual([mine.id]);
    expect(ids).not.toContain(theirs.id);
    expect(keysOf(body.page)).toEqual(["hasMore", "limit", "nextCursor"]);
  });
});

/* ──────────────────────── consent history & policies ─────────────────────── */

/** The current policy list, as the public route answers it (§8.2). */
interface PolicyEntry {
  readonly purpose: string;
  readonly version: string;
  readonly url: string;
  readonly effectiveFrom: string;
  readonly documentHash: string;
}

/** Read the public current-policy list, failing loudly on a refusal. */
async function currentPolicies(): Promise<PolicyEntry[]> {
  const response = await legalPoliciesHandler(getRequest("/api/v1/legal/policies/current"));
  const body = await bodyOf(response, 200, "GET /legal/policies/current");
  return body.policies as PolicyEntry[];
}

/**
 * A `terms_of_service` triple no seed in this file ships, so the public route
 * cannot answer it from a literal: it must read `platformSettings.legal`
 * (§8.2, ADR-0898 §4; the pin is ADR-0900).
 */
const SEEDED_TERMS = {
  version: "tos-2099-07",
  url: "https://openpic.in/legal/terms/2099-07",
  effectiveFrom: "2099-07-01T00:00:00.000Z",
} as const;

describe("I7 — the public policy document is cacheable for an hour (§8.2)", () => {
  it("I7: the current-policy answer carries the public one-hour cache header", async () => {
    const response = await legalPoliciesHandler(getRequest("/api/v1/legal/policies/current"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(POLICY_CACHE_CONTROL);
  });

  it("I7: both documented purposes are served with a verifiable document hash", async () => {
    const policies = await currentPolicies();

    expect(policies.map((entry) => entry.purpose)).toEqual([TERMS_PURPOSE, BIOMETRIC_PURPOSE]);
    for (const entry of policies) {
      expect(typeof entry.version).toBe("string");
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(Number.isNaN(Date.parse(entry.effectiveFrom))).toBe(false);
      expect(entry.documentHash).toMatch(DOCUMENT_HASH);
    }

    // The biometric entry names the policy the platform settings serve — a
    // hard-coded document would drift from `platformSettings.legal` (§6.1).
    const settings = await currentSettings();
    const biometric = policies.find((entry) => entry.purpose === BIOMETRIC_PURPOSE);
    expect(biometric?.version).toBe(settings.legal.biometricPolicyVersion);
    expect(biometric?.url).toBe(settings.legal.biometricPolicyUrl);
  });

  it("I7b: the default seed serves the settings' own terms document", async () => {
    const policies = await currentPolicies();
    const settings = await currentSettings();

    // The control half: the terms entry is a real document from the seeded
    // singleton, so the distinctive pin below cannot pass on an empty answer.
    const terms = policies.find((entry) => entry.purpose === TERMS_PURPOSE);
    expect(terms?.version).toBe(settings.legal.termsPolicyVersion);
    expect(terms?.url).toBe(settings.legal.termsPolicyUrl);
    expect(terms?.effectiveFrom).toBe(settings.legal.effectiveFrom);
  });

  it("I7c: the terms document follows a distinctive seeded platformSettings.legal triple", async () => {
    const shipped = await currentSettings();
    // The seed must differ from the document the defaults carry, or a
    // hard-coded answer would satisfy this case by accident.
    expect({
      version: shipped.legal.termsPolicyVersion,
      url: shipped.legal.termsPolicyUrl,
      effectiveFrom: shipped.legal.effectiveFrom,
    }).not.toEqual(SEEDED_TERMS);

    await app.db.collection(PLATFORM_SETTINGS).deleteMany({});
    await app.db.collection(PLATFORM_SETTINGS).insertOne(
      makePlatformSettingsDocument({
        compliance: { slaDays: { ...SLA_DAYS } },
        legal: {
          ...shipped.legal,
          termsPolicyVersion: SEEDED_TERMS.version,
          termsPolicyUrl: SEEDED_TERMS.url,
          effectiveFrom: SEEDED_TERMS.effectiveFrom,
        },
      })
    );
    invalidatePlatformSettings();

    const policies = await currentPolicies();
    const terms = policies.find((entry) => entry.purpose === TERMS_PURPOSE);
    if (terms === undefined) {
      throw new Error("the policies endpoint served no terms_of_service document");
    }

    expect(terms.version).toBe(SEEDED_TERMS.version);
    expect(terms.url).toBe(SEEDED_TERMS.url);
    expect(terms.effectiveFrom).toBe(SEEDED_TERMS.effectiveFrom);
  });
});

describe("I6 — acknowledging a stale policy version is refused (§8.2)", () => {
  it("I6: a version the platform no longer serves answers 422 and writes no row", async () => {
    const { user } = await seedOwnerEvent("i6");

    const response = await acknowledgeConsentHandler(
      new Request(new URL("/api/v1/me/consents/acknowledge", APP_ORIGIN), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": nextIp(),
          cookie: user.cookie,
        },
        body: JSON.stringify({ purpose: TERMS_PURPOSE, policyVersion: STALE_POLICY_VERSION }),
      })
    );

    expect(response.status).toBe(422);
    const refusal = await errorBody(response);
    expect(refusal.code).toBe("policy_version_stale");
    const current = (await currentPolicies()).find((entry) => entry.purpose === TERMS_PURPOSE);
    expect(refusal.details?.currentPolicyVersion).toBe(current?.version);
    expect(refusal.details?.policyUrl).toBe(current?.url);
    expect(await consentRows()).toHaveLength(0);
  });
});

describe("I12 — a consent acknowledgement is recorded and readable (§8.2)", () => {
  it("I12: the acknowledgement writes a hashed row the history returns", async () => {
    const { user } = await seedOwnerEvent("i12");
    const current = (await currentPolicies()).find((entry) => entry.purpose === TERMS_PURPOSE);
    if (current === undefined) {
      throw new Error("the policies endpoint served no terms_of_service document");
    }

    const acknowledged = await acknowledgeConsentHandler(
      new Request(new URL("/api/v1/me/consents/acknowledge", APP_ORIGIN), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": nextIp(),
          cookie: user.cookie,
        },
        body: JSON.stringify({ purpose: TERMS_PURPOSE, policyVersion: current.version }),
      })
    );
    expect(acknowledged.status).toBe(201);

    const rows = await consentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe(TERMS_PURPOSE);
    expect(rows[0]?.policyVersion).toBe(current.version);
    expect(rows[0]?.policyDocumentHash).toMatch(DOCUMENT_HASH);
    expect(rows[0]?.withdrawnAt).toBeNull();
    const subject = rows[0]?.subject as { kind?: unknown; userId?: unknown };
    expect(subject.kind).toBe("user");
    expect(asId(subject.userId)).toBe(user.userId.toHexString());

    const listed = await listConsentsHandler(
      getRequest(`/api/v1/me/consents?purpose=${TERMS_PURPOSE}`, { cookie: user.cookie })
    );
    const parsed = await jsonOf(listed, 200, "GET /me/consents");
    expect(Array.isArray(parsed)).toBe(true);
    const history = parsed as {
      purpose?: unknown;
      policyVersion?: unknown;
      policyDocumentHash?: unknown;
    }[];
    expect(history).toHaveLength(1);
    expect(history[0]?.purpose).toBe(TERMS_PURPOSE);
    expect(history[0]?.policyVersion).toBe(current.version);
    expect(String(history[0]?.policyDocumentHash)).toMatch(DOCUMENT_HASH);
  });
});

/* ─────────────────────────────── refusals ───────────────────────────────── */

describe("I13 — filing a request needs a credential (§0.3/§8.1)", () => {
  it("I13: an unauthenticated create answers 401 and writes nothing", async () => {
    const response = await postDataRequestHandler(
      postDataRequest({ cookie: "", body: { requestType: "access" } })
    );

    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe("unauthenticated");
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

describe("I14 — a create must carry an Idempotency-Key (§0.9/§8.1)", () => {
  it("I14: a create without the header answers 400 and writes nothing", async () => {
    const { user, event } = await seedOwnerEvent("i14");

    const response = await postDataRequestHandler(
      new Request(new URL("/api/v1/me/data-requests", APP_ORIGIN), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": nextIp(),
          cookie: user.cookie,
        },
        body: JSON.stringify({
          requestType: "access",
          scope: { eventIds: [event.id.toHexString()] },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("idempotency_key_required");
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

describe("I15 — an unregistered request type is refused by validation (§8.1)", () => {
  it("I15: an unknown requestType answers 422 validation_failed and writes nothing", async () => {
    const { user, event } = await seedOwnerEvent("i15");

    const response = await postDataRequestHandler(
      postDataRequest({
        cookie: user.cookie,
        body: { requestType: "teleportation", scope: { eventIds: [event.id.toHexString()] } },
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("validation_failed");
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

/* ────────── OP-138 pin pack (ADR-0901) — the round-1 review findings ───────── */

/**
 * These cases are **append-only**: they pin the contract details the shipped
 * OP-138 GREEN (PR #776, ADR-0899) left unenforced, and none of `I1`–`I15`
 * above is edited. Groups 1–3, 5 and 6 of card `t_df46c867` are red on that
 * tree; the two characterization arms (repeat acknowledgement, tenantless
 * filing) are green and stay green, so a later change cannot silently make the
 * first idempotent or start emitting an event for the second.
 */

/** A bare 64-character lowercase hex digest, as `hashFingerprint` returns it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Build a `POST /me/consents/acknowledge` request for `purpose:
 * terms_of_service`, the action target of `legal.terms.updated` (§8.2).
 *
 * @param cookie - The signed-in caller's session cookie.
 * @param policyVersion - The version the client is acknowledging.
 * @param headers - Extra request headers (evidence facts) to send.
 * @returns The request the route handler is invoked with.
 */
function acknowledgeRequest(
  cookie: string,
  policyVersion: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(new URL("/api/v1/me/consents/acknowledge", APP_ORIGIN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      cookie,
      ...headers,
    },
    body: JSON.stringify({ purpose: TERMS_PURPOSE, policyVersion }),
  });
}

/** The current `terms_of_service` document, or a loud failure. */
async function currentTermsPolicy(): Promise<PolicyEntry> {
  const current = (await currentPolicies()).find((entry) => entry.purpose === TERMS_PURPOSE);
  if (current === undefined) {
    throw new Error("the policies endpoint served no terms_of_service document");
  }
  return current;
}

describe("I16 — the stored scope keeps both id arrays as ObjectIds (§20.3)", () => {
  it("I16: a user's filing stores scope.tenantIds and scope.eventIds as ObjectIds", async () => {
    const { user, tenantKey, event } = await seedOwnerEvent("i16");

    const filed = await fileRequest({
      cookie: user.cookie,
      body: { requestType: "erasure", scope: { eventIds: [event.id.toHexString()] } },
    });

    const row = await storedRequest(filed);
    const scope = row.scope as { tenantIds?: unknown[]; eventIds?: unknown[] };

    // Same values as before — the *representation* is what is pinned here, so a
    // reader never has to coerce one array and not the other (§20.3).
    expect(scope.tenantIds?.map(asId)).toEqual([tenantKey]);
    expect(scope.eventIds?.map(asId)).toEqual([event.id.toHexString()]);
    expect(
      scope.tenantIds?.every((tenantId) => tenantId instanceof ObjectId),
      "scope.tenantIds must be stored as ObjectIds, like scope.eventIds"
    ).toBe(true);
    expect(
      scope.eventIds?.every((eventId) => eventId instanceof ObjectId),
      "scope.eventIds must be stored as ObjectIds"
    ).toBe(true);
  });
});

describe("I17 — the acknowledgement records the §15.4 evidence", () => {
  it("I17: the stored row carries hashed evidence, the in-app method and a served locale", async () => {
    const { user } = await seedOwnerEvent("i17");
    const current = await currentTermsPolicy();

    const acknowledged = await acknowledgeConsentHandler(
      acknowledgeRequest(user.cookie, current.version, {
        "accept-language": "fr-FR,fr;q=0.9",
        "user-agent": "OP-138 evidence probe/1.0",
        "x-forwarded-for": "203.0.113.77",
      })
    );
    expect(acknowledged.status).toBe(201);

    const rows = await consentRows();
    expect(rows).toHaveLength(1);
    const evidence = rows[0]?.evidence as
      { ipHash?: unknown; uaHash?: unknown; method?: unknown; locale?: unknown } | undefined;

    // §15.4's "how": this acknowledgement is the `legal.terms.updated` action
    // target, so its method is the in-app one, not the attendee checkbox.
    expect(evidence?.method).toBe("in_app_action");
    expect(String(evidence?.ipHash)).toMatch(SHA256_HEX);
    expect(String(evidence?.uaHash)).toMatch(SHA256_HEX);
    // §0.15: the raw facts are never stored, only salted digests.
    expect(evidence?.ipHash).not.toBe("203.0.113.77");
    expect(evidence?.uaHash).not.toBe("OP-138 evidence probe/1.0");
    // A stored tag is always one the product serves, never the raw header.
    expect(evidence?.locale).toBe("en-IN");
  });
});

describe("I18 — the consent history answers contract §8.2's row shape", () => {
  it("I18: the history row carries policyUrl, eventId and method alongside the documented keys", async () => {
    const { user } = await seedOwnerEvent("i18");
    const current = await currentTermsPolicy();

    const acknowledged = await acknowledgeConsentHandler(
      acknowledgeRequest(user.cookie, current.version)
    );
    expect(acknowledged.status).toBe(201);

    const listed = await listConsentsHandler(
      getRequest(`/api/v1/me/consents?purpose=${TERMS_PURPOSE}`, { cookie: user.cookie })
    );
    const parsed = await jsonOf(listed, 200, "GET /me/consents");
    expect(Array.isArray(parsed)).toBe(true);
    const history = parsed as Record<string, unknown>[];

    expect(history).toHaveLength(1);
    // §8.2's eight keys plus the `policyDocumentHash` its prose keeps.
    expect(keysOf(history[0])).toEqual([
      "eventId",
      "grantedAt",
      "id",
      "method",
      "policyDocumentHash",
      "policyUrl",
      "policyVersion",
      "purpose",
      "withdrawnAt",
    ]);
    // The document the caller acknowledged is addressable, and the in-app
    // acknowledgement is platform-scope: it names no event.
    expect(history[0]?.policyUrl).toBe(current.url);
    expect(history[0]?.eventId).toBeNull();
    expect(history[0]?.method).toBe("in_app_action");
  });
});

describe("I19 — a verifiedEmail that matches the caller is stored (§8.1/§20.3)", () => {
  it("I19: a matching verifiedEmail answers 202 and is stored on the subject", async () => {
    const { user, event } = await seedOwnerEvent("i19");

    const filed = await fileRequest({
      cookie: user.cookie,
      body: {
        requestType: "erasure",
        scope: { eventIds: [event.id.toHexString()] },
        verifiedEmail: user.identity.email,
      },
    });

    const row = await storedRequest(filed);
    const subject = row.subject as { verifiedEmail?: unknown };
    expect(subject.verifiedEmail).toBe(user.identity.email);
  });
});

describe("I20 — a verifiedEmail that differs from the caller is refused (§8.1)", () => {
  it("I20: a mismatched verifiedEmail answers 422 invalid_verified_email and writes nothing", async () => {
    const { user, event } = await seedOwnerEvent("i20");

    const response = await postDataRequestHandler(
      postDataRequest({
        cookie: user.cookie,
        body: {
          requestType: "erasure",
          scope: { eventIds: [event.id.toHexString()] },
          verifiedEmail: "someone-else@example.com",
        },
      })
    );

    expect(response.status).toBe(422);
    const refusal = await errorBody(response);
    expect(refusal.code).toBe("invalid_verified_email");
    expect(refusal.details).toEqual({ field: "verifiedEmail" });
    // A refused filing is not a filing: no row, no outbox event.
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

describe("I21 — an omitted verifiedEmail is not checked (§8.1)", () => {
  it("I21: a filing without verifiedEmail answers 202 and stores no verifiedEmail", async () => {
    const { user, event } = await seedOwnerEvent("i21");

    const filed = await fileRequest({
      cookie: user.cookie,
      body: { requestType: "access", scope: { eventIds: [event.id.toHexString()] } },
    });

    const row = await storedRequest(filed);
    const subject = row.subject as { verifiedEmail?: unknown };
    expect(subject.verifiedEmail).toBeUndefined();
  });
});

describe("I22 — an anonymous session carries no verifiedEmail (§8.1)", () => {
  it("I22: an attendee filing with a verifiedEmail answers 422 invalid_verified_email", async () => {
    const { event } = await seedOwnerEvent("i22");
    const session = await createAttendeeSession(event.slug, nextIp());

    const response = await postDataRequestHandler(
      postDataRequest({
        cookie: session.cookie,
        body: { requestType: "erasure", verifiedEmail: "attendee@example.com" },
      })
    );

    expect(response.status).toBe(422);
    expect((await errorBody(response)).code).toBe("invalid_verified_email");
    expect(await storedRequests()).toHaveLength(0);
    expect(await dsrEvents()).toHaveLength(0);
  });
});

describe("I23 — an anonymous session reads back the request it filed (§8.1)", () => {
  it("I23: the session that filed reads its own row and its execution log", async () => {
    const { event } = await seedOwnerEvent("i23");
    const session = await createAttendeeSession(event.slug, nextIp());

    const filed = await fileRequest({
      cookie: session.cookie,
      body: { requestType: "erasure" },
    });

    const row = await storedRequest(filed);
    const subject = row.subject as { kind?: unknown; attendeeSessionId?: unknown };
    expect(subject.kind).toBe("anonymous");
    expect(asId(subject.attendeeSessionId)).toBe(session.sessionId);

    const completedAt = new Date("2026-09-30T00:00:00.000Z");
    await app.db.collection(DATA_SUBJECT_REQUESTS).updateOne(
      { _id: new ObjectId(String(filed.id)) },
      {
        $set: {
          status: "completed",
          completedAt,
          executionLog: [{ step: "faceMatches.deleted", count: 7, at: completedAt }],
        },
      }
    );

    // The receipt's own `pollUrl`, presented with the credential that filed it.
    const response = await getDataRequestHandler(
      getRequest(String(filed.pollUrl), { cookie: session.cookie })
    );
    const body = await bodyOf(response, 200, "GET /me/data-requests/:id");

    expect(body.id).toBe(filed.id);
    expect(body.status).toBe("completed");
    const log = body.executionLog as { step: string; count: number }[];
    expect(log.map((entry) => entry.step)).toEqual(["faceMatches.deleted"]);
    expect(log.map((entry) => entry.count)).toEqual([7]);
  });
});

describe("I24 — another attendee session never sees the request (§8.1)", () => {
  it("I24: a different attendee session reads the same id as 404, never 403", async () => {
    const { event } = await seedOwnerEvent("i24");
    const filing = await createAttendeeSession(event.slug, nextIp());
    const other = await createAttendeeSession(event.slug, nextIp());

    const filed = await fileRequest({
      cookie: filing.cookie,
      body: { requestType: "access" },
    });

    const response = await getDataRequestHandler(
      getRequest(String(filed.pollUrl), { cookie: other.cookie })
    );

    // 404, not 403: the endpoint must not answer "this exists but is not yours".
    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe("not_found");
  });
});

describe("I25 — a repeated acknowledgement appends history (§8.2, characterization)", () => {
  it("I25: the second POST answers 201 and the history lists both rows", async () => {
    const { user } = await seedOwnerEvent("i25");
    const current = await currentTermsPolicy();

    const first = await acknowledgeConsentHandler(acknowledgeRequest(user.cookie, current.version));
    const firstBody = await bodyOf(first, 201, "POST /me/consents/acknowledge (first)");
    const second = await acknowledgeConsentHandler(
      acknowledgeRequest(user.cookie, current.version)
    );
    const secondBody = await bodyOf(second, 201, "POST /me/consents/acknowledge (second)");

    // History semantics, deliberately: consent records are an append-only
    // record of what was acknowledged when, not a mutable current state.
    expect(firstBody.id).not.toBe(secondBody.id);
    const rows = await consentRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.policyVersion)).toEqual([current.version, current.version]);

    const listed = await listConsentsHandler(
      getRequest(`/api/v1/me/consents?purpose=${TERMS_PURPOSE}`, { cookie: user.cookie })
    );
    const history = await jsonOf(listed, 200, "GET /me/consents");
    expect(history as unknown[]).toHaveLength(2);
  });
});

describe("I26 — a tenantless filing emits no event (§8.1, characterization)", () => {
  it("I26: an unscoped platform-wide filing answers 202 and writes no domain event", async () => {
    const { user } = await seedOwnerEvent("i26");

    const filed = await fileRequest({
      cookie: user.cookie,
      body: { requestType: "portability" },
    });

    const row = await storedRequest(filed);
    const scope = row.scope as { tenantIds?: unknown[]; eventIds?: unknown[] };
    expect(scope.tenantIds).toEqual([]);
    expect(scope.eventIds).toEqual([]);
    // `emitDomainEvent` requires a tenant, so an unresolvable tenant writes no
    // row: §8.1's "emits privacy.dsr.received" is conditional on one existing
    // (ADR-0899 §3 item 3, ADR-0901 §5).
    expect(await dsrEvents()).toHaveLength(0);
  });
});
