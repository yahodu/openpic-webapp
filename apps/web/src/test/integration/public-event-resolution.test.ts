import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import * as rotateRouteModule from "@/app/api/v1/events/[eventId]/access-links:rotate/route";
import * as attendeeSessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import * as publicEventRouteModule from "@/app/api/v1/p/events/[slug]/route";
import { ATTENDEE_COOKIE_NAME } from "@/server/attendee/session-cookie";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createMediaSigner } from "@/server/media/signer";

import { makeEnv } from "../factories/env";
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
 * Integration / contract — public event resolution, `GET /api/v1/p/events/{slug}`
 * (OP-130 I1–I5, contract §6.1, schema §15.1/§15.3, §0.15; ADR-0784).
 *
 * **Why this exists.** An attendee who scanned a QR must be able to start from a
 * single unauthenticated call: no session, no account, no second round trip for
 * the logo. The route is therefore the platform's widest public read — it
 * resolves a slug to an event across tenants — and its whole risk lives in the
 * refusals and in what the body must *not* carry:
 *
 *   - an unpublished event must be indistinguishable from a slug that never
 *     existed (contract §6.1 "do not leak unpublished events");
 *   - a rotated-away slug is `410 access_link_revoked`, never `404` — the two
 *     are different screens for the attendee (get the current link vs. wrong
 *     QR) and §6.1 keeps them apart;
 *   - the body is the §6.1 envelope and nothing else: no `_id`, no tenant id,
 *     no asset ids, no raw session token (§0.15).
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/p/events/[slug]/route` exports `GET`, declared on
 * `defineRoute({ route: "/api/v1/p/events/:slug" })` with **no** auth stage (the
 * §6.1 `public` label), reading the slug off `request.url`:
 *
 *   - `200` with exactly the six §6.1 sections
 *     (`slug`, `event`, `gallery`, `selfie`, `consent`, `session`) and
 *     `cache-control: private, max-age=30`;
 *   - unknown slug and `draft` → `404 not_found`; `deleting` → `410 event_gone`;
 *     a slug whose link is inactive → `410 access_link_revoked` with
 *     `details.message`;
 *   - the slug is resolved through the **active** link of the event, never
 *     through `accessLinks[0]`;
 *   - `event.description` is the stored description (the landing page renders
 *     it) and `event.logoUrl` is the `thumbnail` derivative signed by
 *     `@/server/media/signer`, or `null` when the event has no logo;
 *   - `session.hasProfile` reports whether the caller already has an
 *     `attendee_event_profiles` row for **this** event.
 *
 * ## Assumptions (ADR-0784 §Assumptions)
 *
 * - `event.description` is part of the body even though the `PublicEvent`
 *   interface in contract §6.1's appendix omits it: this card (I4) requires it
 *   and the landing page renders it.
 * - `gallery.expiresAt` stays the configured retention instant in **both**
 *   states; `gallery.expiredAt` is added only once retention has elapsed
 *   (the appendix types `expiresAt` as required and `expiredAt` as optional).
 * - `gallery.indexingComplete` is `processedImageCount + failedImageCount >=
 *   imageCount` on the event's cached counters — "nothing is still waiting".
 * - The profile fixture's ids (`eventId`, `subject.attendeeSessionId`) are hex
 *   strings, matching the one stored-shape type in the repo
 *   (`AttendeeProfileDocument`) and the `AttendeePrincipal.sessionId` contract.
 * - A lapsed `op_att` cookie still renders the page: §6.1 declares the route
 *   `public` and its error table is a closed list that has no `401`
 *   (handoff §Open questions).
 * - Whether a GET stamps `accessLinks[].scanCount` is **not** pinned: the card
 *   is a read contract and §6.1 does not say the landing call is a scan.
 */

let app: TestApp;

/** The configured signing secret, as the route reads it (`makeEnv` default). */
const SIGNING_SECRET = makeEnv().MEDIA_SIGNING_SECRET_CURRENT ?? "";

/** The stored logo `mediaAssets` content hash the I4 pin signs. */
const LOGO_CONTENT_HASH = "a".repeat(64);

/** The §6.1 refusal message for a rotated link, quoted verbatim by the contract. */
const REVOKED_MESSAGE = "This QR code is no longer valid. Ask the organizer for the current link.";

/** The `cache-control` value §6.1 fixes for the landing call. */
const CACHE_CONTROL = "private, max-age=30";

/** The six top-level sections of the §6.1 body, sorted. */
const BODY_KEYS = ["consent", "event", "gallery", "selfie", "session", "slug"];

/** The `event` object's keys, sorted (§6.1 + `description`, ADR-0784 §1). */
const EVENT_KEYS = [
  "description",
  "displayTimeZone",
  "endAt",
  "id",
  "logoUrl",
  "name",
  "organizerDisplayName",
  "startAt",
  "startAtLocal",
  "status",
];

/** The `gallery` keys while the gallery is open, sorted. */
const GALLERY_OPEN_KEYS = ["expiresAt", "imageCount", "indexingComplete", "open"];

/** The `gallery` keys once retention has elapsed, sorted. */
const GALLERY_EXPIRED_KEYS = ["expiredAt", "expiresAt", "imageCount", "indexingComplete", "open"];

/** The `selfie` keys, sorted (§6.1). */
const SELFIE_KEYS = [
  "acceptedMimeTypes",
  "attemptsAllowed",
  "attemptsUsed",
  "livenessRequired",
  "maxBytes",
];

/** The `consent` keys, sorted (§6.1). */
const CONSENT_KEYS = ["granted", "policyUrl", "policyVersion", "purpose", "required"];

/** The `session` keys, sorted (§6.1). */
const SESSION_KEYS = ["canClaimByLogin", "hasProfile", "kind"];

/** One event status, as schema §15.1 spells them. */
type SeededStatus = "draft" | "published" | "live" | "ended" | "archived" | "deleting";

beforeAll(async () => {
  app = await startTestApp({ prefix: "op130-public-event" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** Read a route export off a route namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST",
  path: string
): (request: Request) => Promise<Response> {
  const handler: unknown =
    name === "GET" ? Reflect.get(module, "GET") : Reflect.get(module, "POST");
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const getPublicEvent = requireHandler(publicEventRouteModule, "GET", "/api/v1/p/events/:slug");
const createAttendeeSession = requireHandler(
  attendeeSessionsRouteModule,
  "POST",
  "/api/v1/p/attendee-sessions"
);
const rotateAccessLink = requireHandler(
  rotateRouteModule,
  "POST",
  "/api/v1/events/:eventId/access-links:rotate"
);

/** The sorted own keys of a JSON object, or `[]` for a non-object. */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/** Narrow one value of a parsed body to an object, naming it on failure. */
function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value === null || typeof value !== "object") {
    throw new Error(`expected the response body to carry an object at "${key}"`);
  }
  return value as Record<string, unknown>;
}

/** The `error` block of a refusal body. */
async function errorBody(
  response: Response
): Promise<{ code: string; message?: string; details?: Record<string, unknown> }> {
  const parsed = await response.json();
  const envelope = objectAt(parsed as Record<string, unknown>, "error");
  return envelope as { code: string; message?: string; details?: Record<string, unknown> };
}

/**
 * A public landing request for `slug`, with an optional attendee cookie and an
 * optional client address.
 *
 * The address is needed only by the §0.11 class pin: `public.gallery` declares an
 * `ip` rule, and the stage skips every rule it cannot key — a request with no
 * address is `unavailable` and (for a fail-open class) unlimited, so the mount
 * can only be observed from a request that carries one.
 */
function publicEventRequest(slug: string, cookie?: string, clientIp?: string): Request {
  return new Request(new URL(`/api/v1/p/events/${slug}`, APP_ORIGIN), {
    method: "GET",
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(clientIp === undefined ? {} : { "x-forwarded-for": clientIp }),
    },
  });
}

/** Fetch the landing body for `slug`, failing loudly on a non-200. */
async function fetchPublicEvent(slug: string, cookie?: string): Promise<Record<string, unknown>> {
  const response = await getPublicEvent(publicEventRequest(slug, cookie));
  const parsed = await response.json();
  if (response.status !== 200) {
    throw new Error(
      `expected 200 for slug ${slug}, received ${String(response.status)}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed as Record<string, unknown>;
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
    slug: `op130-${prefix}`,
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

/** The optional facts one seeded event varies (schema §15.1). */
interface EventSeed {
  readonly tenantKey: string;
  readonly ownerUserId: string;
  readonly name?: string;
  readonly description?: string;
  readonly status?: SeededStatus;
  readonly startAt?: Date;
  readonly displayTimeZone?: string;
  readonly retentionExpiresAt?: Date | null;
  readonly logoAssetId?: ObjectId | null;
  readonly counters?: {
    readonly imageCount: number;
    readonly processedImageCount: number;
    readonly failedImageCount: number;
  };
}

/** A seeded event: its id and the active link's slug. */
interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
  readonly name: string;
}

/**
 * Insert a stored `events` row (schema §15.1) with one active access link.
 *
 * The row is the shape the create route writes (OP-115), so the public route
 * reads exactly what a real event looks like.
 *
 * @param seed - The facts this case varies; every other field is a default.
 * @returns The event id, its active slug and its name.
 */
async function seedEvent(seed: EventSeed): Promise<SeededEvent> {
  const _id = new ObjectId();
  const now = new Date("2026-01-02T00:00:00.000Z");
  const slug = `op130${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  const name = seed.name ?? "Rahul & Priya's Wedding";
  const counters = seed.counters ?? {
    imageCount: 0,
    processedImageCount: 0,
    failedImageCount: 0,
  };

  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: seed.tenantKey,
    name,
    description: seed.description ?? "",
    status: seed.status ?? "published",
    startAt: seed.startAt ?? new Date("2026-11-14T12:00:00.000Z"),
    endAt: new Date("2026-11-15T04:00:00.000Z"),
    displayTimeZone: seed.displayTimeZone ?? "Asia/Kolkata",
    uploadWindowEndsAt: new Date("2026-11-22T04:00:00.000Z"),
    retentionExpiresAt:
      seed.retentionExpiresAt === undefined
        ? new Date("2027-02-14T18:00:00.000Z")
        : seed.retentionExpiresAt,
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null, scanCount: 0 }],
    counters: {
      imageCount: counters.imageCount,
      processedImageCount: counters.processedImageCount,
      failedImageCount: counters.failedImageCount,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: seed.logoAssetId ?? null,
    watermarkAssetId: null,
    createdByUserId: seed.ownerUserId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: seed.tenantKey,
    eventId: _id,
    userId: seed.ownerUserId,
    role: "organizer",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });

  return { id: _id, slug, name };
}

/** A `thumbnail`-derivative `media_assets` row for an event logo (schema §16.1). */
async function seedLogoAsset(tenantKey: string): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id,
    tenantId: tenantKey,
    contentHash: LOGO_CONTENT_HASH,
    kind: "event_logo",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  return _id;
}

/** One seeded tenant, one seeded event outright — the shape most cases need. */
async function seedPublishedEvent(
  prefix: string,
  overrides: Omit<EventSeed, "tenantKey" | "ownerUserId"> = {}
): Promise<{ tenantId: ObjectId; event: SeededEvent }> {
  const { user, tenantId } = await seedOwner(prefix);
  const event = await seedEvent({
    tenantKey: tenantId.toHexString(),
    ownerUserId: user.userId.toHexString(),
    ...overrides,
  });
  return { tenantId, event };
}

/** Create a real anonymous attendee session bound to `slug`, returning its cookie. */
async function createSessionCookie(slug: string): Promise<string> {
  const response = await createAttendeeSession(
    new Request(new URL("/api/v1/p/attendee-sessions", APP_ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  return cookiePair(header);
}

/** The `Subscribe`-shaped profile row an attendee gets after a selfie (§15.3). */
interface ProfileSeed {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly sessionId: string;
}

/**
 * Insert the `attendee_event_profiles` row for an anonymous session (schema
 * §15.3) — the row the selfie route creates, so `hasProfile` has a cause.
 */
async function seedProfile(seed: ProfileSeed): Promise<void> {
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    tenantId: seed.tenantKey,
    eventId: seed.eventId.toHexString(),
    subject: { kind: "anonymous", attendeeSessionId: seed.sessionId },
    status: "ready",
    matchCount: 0,
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  });
}

/** The stored session id behind a raw `op_att` token (the resolver's own lookup). */
async function sessionIdForToken(token: string): Promise<string> {
  const row = await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) });
  if (row === null) {
    throw new Error("expected the attendee session row to exist");
  }
  return String(row._id);
}

/* ───────────────────────── I1 — the refusal states ───────────────────────── */

describe("GET /api/v1/p/events/{slug} — the refusal states (contract §6.1)", () => {
  it("I1: an unknown slug answers 404 not_found", async () => {
    await seedPublishedEvent("op130-unknown");

    const response = await getPublicEvent(publicEventRequest("nosuchslug"));

    expect(response.status).toBe(404);
    const error = await errorBody(response);
    expect(error.code).toBe("not_found");
  });

  it("I1: a draft event answers 404 not_found, so an unpublished event never leaks", async () => {
    const { event } = await seedPublishedEvent("op130-draft", { status: "draft" });

    const response = await getPublicEvent(publicEventRequest(event.slug));

    expect(response.status).toBe(404);
    const error = await errorBody(response);
    expect(error.code).toBe("not_found");
  });

  it("I1: an event whose purge has started answers 410 event_gone", async () => {
    const { event } = await seedPublishedEvent("op130-deleting", { status: "deleting" });

    const response = await getPublicEvent(publicEventRequest(event.slug));

    expect(response.status).toBe(410);
    const error = await errorBody(response);
    expect(error.code).toBe("event_gone");
  });

  it("I1: a draft answers exactly like an unknown slug, so the two are indistinguishable", async () => {
    const { event } = await seedPublishedEvent("op130-draft-oracle", { status: "draft" });

    const draft = await errorBody(await getPublicEvent(publicEventRequest(event.slug)));
    const unknown = await errorBody(await getPublicEvent(publicEventRequest("nosuchslug")));

    expect(draft.code).toBe(unknown.code);
    expect(draft.message).toBe(unknown.message);
  });

  it("I1: no refusal body carries any event content", async () => {
    const { event } = await seedPublishedEvent("op130-refusal-content", {
      status: "draft",
      name: "Secret Society Gala",
    });

    const response = await getPublicEvent(publicEventRequest(event.slug));
    const parsed = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(JSON.stringify(parsed)).not.toContain("Secret Society Gala");
    expect(JSON.stringify(parsed)).not.toContain(event.id.toHexString());
  });
});

/* ──────────────────────── the rendered §6.1 envelope ─────────────────────── */

describe("GET /api/v1/p/events/{slug} — the rendered page (contract §6.1)", () => {
  it("I3: answers exactly the six documented sections with the contract's keys", async () => {
    const { event } = await seedPublishedEvent("op130-shape");

    const parsed = await fetchPublicEvent(event.slug);

    expect(keysOf(parsed)).toEqual(BODY_KEYS);
    expect(keysOf(parsed.event)).toEqual(EVENT_KEYS);
    expect(keysOf(parsed.gallery)).toEqual(GALLERY_OPEN_KEYS);
    expect(keysOf(parsed.selfie)).toEqual(SELFIE_KEYS);
    expect(keysOf(parsed.consent)).toEqual(CONSENT_KEYS);
    expect(keysOf(parsed.session)).toEqual(SESSION_KEYS);
  });

  it("I3: the body passes the attendee never-return profile (§0.15)", async () => {
    const { tenantId, event } = await seedPublishedEvent("op130-scanner");
    const logoAssetId = await seedLogoAsset(tenantId.toHexString());
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: event.id }, { $set: { logoAssetId } });

    const parsed = await fetchPublicEvent(event.slug);
    const serialized = JSON.stringify(parsed);

    expect(findForbiddenFields(parsed, "attendee")).toEqual([]);
    // Internal identifiers the landing page has no use for, asserted by value
    // because a leak of one of these is invisible to a key-name scan.
    expect(serialized).not.toContain(tenantId.toHexString());
    expect(serialized).not.toContain(logoAssetId.toHexString());
  });

  it("I4: returns the stored description", async () => {
    const { event } = await seedPublishedEvent("op130-description", {
      description: "Reception on the lawn, dinner at 8",
    });

    const parsed = await fetchPublicEvent(event.slug);

    expect(parsed.event).toMatchObject({ description: "Reception on the lawn, dinner at 8" });
  });

  it("I4: returns an empty description for an event created without one", async () => {
    const { event } = await seedPublishedEvent("op130-description-empty");

    const parsed = await fetchPublicEvent(event.slug);

    // The create route stores `""` (never null), so the page renders `""`.
    expect(parsed.event).toMatchObject({ description: "" });
  });

  it("I4: returns a signed thumbnail URL for the event's logo", async () => {
    const { tenantId, event } = await seedPublishedEvent("op130-logo");
    const logoAssetId = await seedLogoAsset(tenantId.toHexString());
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: event.id }, { $set: { logoAssetId } });

    const parsed = await fetchPublicEvent(event.slug);
    const eventObject = objectAt(parsed, "event");
    const logoUrl = eventObject.logoUrl;
    expect(typeof logoUrl).toBe("string");
    if (typeof logoUrl !== "string") {
      throw new Error("expected event.logoUrl to be a string");
    }

    // `https://pic.openpic.in/t/<contentHash>.<ext>?exp=…&sig=…` — the
    // `thumbnail` derivative of the logo asset (§5.6/§5.7).
    const signed =
      /^https:\/\/pic\.openpic\.in\/t\/([0-9a-f]{64})\.(webp|png|jpe?g|svg)\?exp=\d+&sig=[\w-]+$/;
    const match = signed.exec(logoUrl);
    expect(match?.[1]).toBe(LOGO_CONTENT_HASH);
    expect(createMediaSigner({ currentSecret: SIGNING_SECRET }).verify(logoUrl)).toBe(true);
  });

  it("I4: answers logoUrl null when the event has no logo", async () => {
    const { event } = await seedPublishedEvent("op130-logo-absent");

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "event").logoUrl).toBeNull();
  });

  it("renders startAtLocal in the event's displayTimeZone", async () => {
    const { event } = await seedPublishedEvent("op130-start-local", {
      startAt: new Date("2026-11-14T12:00:00.000Z"),
      displayTimeZone: "America/New_York",
    });

    const parsed = await fetchPublicEvent(event.slug);
    const eventObject = objectAt(parsed, "event");

    // EST (-05:00) on that instant; the UTC clock is 12:00.
    expect(eventObject.startAtLocal).toBe("2026-11-14T07:00:00-05:00");
    expect(eventObject.startAt).toBe("2026-11-14T12:00:00.000Z");
    expect(eventObject.displayTimeZone).toBe("America/New_York");
  });

  it.each(["published", "live", "ended", "archived"] as const)(
    "renders a %s event",
    async (status) => {
      const { event } = await seedPublishedEvent(`op130-status-${status}`, { status });

      const parsed = await fetchPublicEvent(event.slug);

      expect(objectAt(parsed, "event").status).toBe(status);
    }
  );

  it("echoes the requested slug and the event's own identity", async () => {
    const { event } = await seedPublishedEvent("op130-slug-echo");

    const parsed = await fetchPublicEvent(event.slug);

    expect(parsed.slug).toBe(event.slug);
    expect(objectAt(parsed, "event")).toMatchObject({
      id: event.id.toHexString(),
      name: event.name,
      organizerDisplayName: "Rahul Studio",
    });
  });

  it("answers Cache-Control: private, max-age=30 (contract §6.1)", async () => {
    const { event } = await seedPublishedEvent("op130-cache");

    const response = await getPublicEvent(publicEventRequest(event.slug));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(CACHE_CONTROL);
  });

  it("reports the cached image count and whether indexing finished", async () => {
    const { event } = await seedPublishedEvent("op130-gallery-counts", {
      counters: { imageCount: 12, processedImageCount: 12, failedImageCount: 1 },
    });

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "gallery")).toMatchObject({
      open: true,
      expiresAt: "2027-02-14T18:00:00.000Z",
      imageCount: 12,
      indexingComplete: true,
    });
  });

  it("reports indexingComplete false while images are still awaiting processing", async () => {
    const { event } = await seedPublishedEvent("op130-gallery-indexing", {
      counters: { imageCount: 12, processedImageCount: 6, failedImageCount: 0 },
    });

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "gallery")).toMatchObject({
      open: true,
      imageCount: 12,
      indexingComplete: false,
    });
  });

  it("closes the gallery once retention has elapsed and stamps expiredAt", async () => {
    const elapsed = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { event } = await seedPublishedEvent("op130-retention-elapsed", {
      retentionExpiresAt: elapsed,
    });

    const parsed = await fetchPublicEvent(event.slug);
    const gallery = objectAt(parsed, "gallery");

    expect(gallery).toMatchObject({
      open: false,
      expiresAt: elapsed.toISOString(),
    });
    expect(gallery.expiredAt).toBe(elapsed.toISOString());
    expect(keysOf(gallery)).toEqual(GALLERY_EXPIRED_KEYS);
  });

  it("keeps an unbounded-retention gallery open with a null expiresAt", async () => {
    const { event } = await seedPublishedEvent("op130-retention-unbounded", {
      retentionExpiresAt: null,
    });

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "gallery")).toMatchObject({ open: true, expiresAt: null });
    expect(keysOf(parsed.gallery)).toEqual(GALLERY_OPEN_KEYS);
  });

  it("describes the selfie rules the attendee must satisfy", async () => {
    const { event } = await seedPublishedEvent("op130-selfie-rules");

    const parsed = await fetchPublicEvent(event.slug);
    const selfie = objectAt(parsed, "selfie");

    expect(selfie.acceptedMimeTypes).toEqual(
      expect.arrayContaining(["image/jpeg", "image/png", "image/webp", "image/heic"])
    );
    expect(selfie.maxBytes).toBeGreaterThan(0);
    expect(selfie.livenessRequired).toBe(true);
    expect(selfie.attemptsAllowed).toBeGreaterThan(0);
    // A fresh session has used none of its attempts.
    expect(selfie.attemptsUsed).toBe(0);
  });

  it("carries the biometric consent spec, ungranted for a fresh caller", async () => {
    const { event } = await seedPublishedEvent("op130-consent");

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "consent")).toMatchObject({
      purpose: "biometric_processing",
      granted: false,
    });
    const consent = objectAt(parsed, "consent");
    expect(typeof consent.policyVersion).toBe("string");
    expect(consent.policyVersion).not.toBe("");
    expect(consent.policyUrl).toMatch(/^https:\/\//);
  });
});

/* ────────────────────────── I2 — the session hint ────────────────────────── */

describe("GET /api/v1/p/events/{slug} — the session hint (contract §6.1)", () => {
  it("I2: renders for a caller with no credential, as an anonymous session", async () => {
    const { event } = await seedPublishedEvent("op130-no-credential");

    const parsed = await fetchPublicEvent(event.slug);

    expect(objectAt(parsed, "session")).toEqual({
      kind: "anonymous",
      hasProfile: false,
      canClaimByLogin: true,
    });
  });

  it("I2: an anonymous session shows hasProfile false", async () => {
    const { event } = await seedPublishedEvent("op130-anon-session");
    const cookie = await createSessionCookie(event.slug);

    const parsed = await fetchPublicEvent(event.slug, cookie);

    expect(objectAt(parsed, "session")).toEqual({
      kind: "anonymous",
      hasProfile: false,
      canClaimByLogin: true,
    });
  });

  it("I2: an anonymous session that already has a profile shows hasProfile true", async () => {
    const { tenantId, event } = await seedPublishedEvent("op130-anon-profile");
    const cookie = await createSessionCookie(event.slug);
    const token = cookie.slice(cookie.indexOf("=") + 1);
    await seedProfile({
      tenantKey: tenantId.toHexString(),
      eventId: event.id,
      sessionId: await sessionIdForToken(token),
    });

    const parsed = await fetchPublicEvent(event.slug, cookie);

    expect(objectAt(parsed, "session")).toMatchObject({
      kind: "anonymous",
      hasProfile: true,
    });
  });

  it("I2: a lapsed session cookie still renders the page (§6.1 has no 401)", async () => {
    const { event } = await seedPublishedEvent("op130-lapsed-session");
    const token = "opat_expired-session-token-for-op130";
    await app.db.collection(COLLECTIONS.attendeeSessions).insertOne({
      tokenHash: hashAttendeeSessionToken(token),
      claimedByUserId: null,
      claimedAt: null,
      eventIds: [event.id],
      deviceFingerprint: {
        uaHash: "b".repeat(64),
        ipHash: "c".repeat(64),
        acceptLangHash: "d".repeat(64),
      },
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      expireAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const response = await getPublicEvent(
      publicEventRequest(event.slug, `${ATTENDEE_COOKIE_NAME}=${token}`)
    );

    expect(response.status).toBe(200);
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(objectAt(parsed, "session")).toMatchObject({ kind: "anonymous", hasProfile: false });
  });
});

/* ──────────────── the §0.11 rate-limit class (contract §6.1) ─────────────── */

describe("GET /api/v1/p/events/{slug} — the §0.11 class it mounts (contract §6.1)", () => {
  it("enforces public.gallery: an anonymous landing call carries RateLimit-Limit 600", async () => {
    const { event } = await seedPublishedEvent("op130-rate-class");

    const response = await getPublicEvent(
      publicEventRequest(event.slug, undefined, "198.51.100.42")
    );

    expect(response.status).toBe(200);
    // `public.gallery` is the only §0.11 class whose `ip` rule is 600/min, and
    // an unauthenticated landing call has no attendee identity to key the 120/min
    // `attendee` rule on — so the numbers below name the class the route
    // mounted. A route on `read.hot`/`write.normal` (60), `read.normal` (300),
    // `internal` (600 but `user`-scoped, so unreachable here) or no stage at all
    // (no headers) fails.
    expect(response.headers.get("ratelimit-limit")).toBe("600");
    expect(response.headers.get("ratelimit-remaining")).toBe("599");
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

/* ─────────────────────── I5 — rotation: revoked vs unknown ───────────────── */

describe("GET /api/v1/p/events/{slug} — a rotated link (contract §6.1)", () => {
  /** Rotate the organizer's link once per case and hand back both slugs. */
  async function rotateOnce(
    prefix: string
  ): Promise<{ oldSlug: string; newSlug: string; eventId: string }> {
    const { user, tenantId } = await seedOwner(prefix);
    const event = await seedEvent({
      tenantKey: tenantId.toHexString(),
      ownerUserId: user.userId.toHexString(),
    });

    const rotated = await rotateAccessLink(
      new Request(
        new URL(`/api/v1/events/${event.id.toHexString()}/access-links:rotate`, APP_ORIGIN),
        {
          method: "POST",
          headers: { cookie: user.cookie, "content-type": "application/json" },
          body: JSON.stringify({ confirmUnderstood: true }),
        }
      )
    );
    expect(rotated.status).toBe(200);
    const answer = (await rotated.json()) as {
      accessLinks: readonly { slug: string; active: boolean }[];
    };
    const newLink = answer.accessLinks.find((link) => link.active);
    if (newLink === undefined) {
      throw new Error("expected the rotation to answer exactly one active link");
    }
    return { oldSlug: event.slug, newSlug: newLink.slug, eventId: event.id.toHexString() };
  }

  it("I5: the rotated-away slug answers 410 access_link_revoked with the message", async () => {
    const { oldSlug } = await rotateOnce("op130-rotate-old");

    const response = await getPublicEvent(publicEventRequest(oldSlug));

    expect(response.status).toBe(410);
    const error = await errorBody(response);
    expect(error.code).toBe("access_link_revoked");
    expect(error.details?.message).toBe(REVOKED_MESSAGE);
  });

  it("I5: the new slug answers 200 and resolves the same event", async () => {
    const { newSlug, eventId } = await rotateOnce("op130-rotate-new");

    const parsed = await fetchPublicEvent(newSlug);

    expect(parsed.slug).toBe(newSlug);
    expect(objectAt(parsed, "event").id).toBe(eventId);
  });

  it("resolves the slug through the active link, never through accessLinks[0]", async () => {
    const { event } = await seedPublishedEvent("op130-link-order");
    const revokedSlug = `${event.slug}old`;
    // The revoked link sits **first**, so a route that reads `accessLinks[0]`
    // (or resolves the slug against the first element) answers the dead link and
    // a route that trusts `accessLinks[0].active` refuses the live one.
    await app.db.collection(COLLECTIONS.events).updateOne(
      { _id: event.id },
      {
        $set: {
          accessLinks: [
            {
              slug: revokedSlug,
              active: false,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              revokedAt: new Date("2026-01-02T00:00:00.000Z"),
              scanCount: 0,
            },
            {
              slug: event.slug,
              active: true,
              createdAt: new Date("2026-01-02T00:00:00.000Z"),
              revokedAt: null,
              scanCount: 0,
            },
          ],
        },
      }
    );

    const live = await fetchPublicEvent(event.slug);
    expect(live.slug).toBe(event.slug);
    expect(objectAt(live, "event").id).toBe(event.id.toHexString());

    const dead = await getPublicEvent(publicEventRequest(revokedSlug));
    expect(dead.status).toBe(410);
    expect((await errorBody(dead)).code).toBe("access_link_revoked");
  });
});
