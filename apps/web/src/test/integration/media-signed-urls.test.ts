/**
 * Integration / contract — the batch signed-media-URL refresh (OP-128 I1–I6,
 * contract §5.6, §0.11, §0.14, §0.15; schema §16.1, §16.3, §17.5).
 *
 * The user story: *as a gallery viewer, I want to refresh expired
 * thumbnail/original URLs in batches so that long-lived pages keep working.*
 * One endpoint delivers it:
 *
 * `POST /api/v1/media/signed-urls` — `{ scope: { kind: "event", id }, items:
 * [{ kind: "thumbnail" | "original", imageId }] }` → `200 { urls, denied }`,
 * where `urls[]` is `{ imageId, kind, url, expiresAt }` and `denied[]` is
 * `{ imageId, kind, code }`. Authorization is **per item** (§5.6): a denied
 * item never fails the batch, and only an **all-denied** batch is a `403`.
 * Thumbnails live 24 h and originals 15 min — never inverted.
 *
 * ## Contract expected of the implementation
 *
 * - `apps/web/src/app/api/v1/media/signed-urls/route.ts` exports `POST`, built
 *   on `defineRoute` with the `media.sign` rate-limit class (§0.11), a `scope`
 *   enum of `"event"`, and an `items` array of 1..200 entries.
 * - More than 200 items is a `413 payload_too_large` (the card's I4), an empty
 *   list and an unknown `scope.kind` are `422 validation_failed` (§0.6 — the
 *   pipeline's validation status; the `413` cap is the route's own check, so
 *   the body schema must not fail a 201-item list before the handler sees it).
 * - The endpoint is **`public`-labelled**: §5.6 says "auth `user` or
 *   `attendee`", but its authorization is per item, and I6 requires an
 *   anonymous caller to receive `200` with `denied[]` entries
 *   `authentication_required` rather than a gateway `401`. A resolved user
 *   principal is still what makes a member or an attendee succeed.
 * - Denial codes: `not_found` (not a live image of the scope event — missing,
 *   soft-deleted, another event's), `forbidden` (no relationship granting that
 *   kind), `feature_not_available` (the tenant plan's `originals.download`
 *   gate is off — `@/server/services/entitlements`' own reason, §0.14),
 *   `authentication_required` (no credential).
 * - The image gate is the §5.6/ADR-0762 predicate: a matched attendee only ever
 *   receives a URL for an image that is `visibility: "visible"` **and**
 *   `deletedAt: null` — hiding writes only `visibility`, so this endpoint is
 *   where a hidden-but-matched image must stop being deliverable.
 * - URLs are §5.6-signed on the `thumbnail`/`original` derivatives
 *   (`https://pic.openpic.in/t/<contentHash>.<format>` and `/o/<contentHash>.<ext>`)
 *   with a `GET` signature that `createMediaSigner().verify` accepts.
 * - The response is exactly two keys, `urls` and `denied` (§0.15 — no
 *   `objectKey`, no `contentHash`, no bucket).
 * - Batched reads only: one `$in` per collection, so a 200-item request costs
 *   the same number of queries as a 2-item one (I5).
 *
 * ## Assumptions (ADR-0766)
 *
 * - **A1 — "an attendee" is a caller identified by a `face_matches` row.**
 *   OP-129 owns the anonymous `op_att` session resolver and does not exist yet,
 *   so the attendee cases drive a signed-in user who is neither a tenant member
 *   nor an event organizer, with an `attendee_event_profiles` row and
 *   `face_matches` rows bound to their `subject.userId`. §0.3 says a user
 *   session satisfies the `attendee` label, so this is the same code path an
 *   `op_att` session will take once OP-129 lands.
 * - **A2 — "anonymous" is a request that resolves no principal at all.** The
 *   `op_att`-cookie variant of the same denial is out of scope until OP-129.
 * - **A3 — `authentication_required` never escalates to `403`** (U2's rule):
 *   the anonymous cases stay `200` with a populated `denied[]`.
 * - **A4 — a hidden image is still signable for an event member.** The §4.4
 *   grid lists hidden images and signs their thumbnails (hide is not delete),
 *   so the `visibility` predicate is pinned on the attendee branch only; the
 *   member branch is left unpinned (ADR-0766 open item O1).
 * - **A5 — `denied[]` and `urls[]` order is not part of the contract**, so
 *   every assertion compares sets keyed by `(imageId, kind)`.
 */
import { createHash } from "node:crypto";

import { Collection, ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as signedUrlsRouteModule from "@/app/api/v1/media/signed-urls/route";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createMediaSigner } from "@/server/media/signer";
import type { Entitlement } from "@/server/plans/plans";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";

/** The path under test (§5.6). */
const SIGNED_URLS_PATH = "/api/v1/media/signed-urls";

/** The two documented lives (§5.6, media doc §8) — never inverted. */
const THUMBNAIL_TTL_SECONDS = 24 * 60 * 60;
const ORIGINAL_TTL_SECONDS = 15 * 60;

/** The recorded thumbnail derivative's format (§16.1). */
const THUMBNAIL_FORMAT = "webp";

/** The stored original's byte count, so an asset row is schema-shaped. */
const ORIGINAL_BYTES = 8_421_310;
const THUMBNAIL_BYTES = 41_200;

/** The plan key whose `originals.download` gate each case states. */
const ORIGINALS_KEY = "originals.download";
const PLAN_KEY_ENABLED = "op128-originals-on";
const PLAN_KEY_DISABLED = "op128-originals-off";

/** The §5.6 maximum batch (§5.6 "Max 200 items"), and its first illegal size. */
const MAX_ITEMS = 200;
const OVER_MAX_ITEMS = 201;

/** Deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op128-${name}`).digest("hex");
}

const HASH_A = hashFor("image-a");
const HASH_B = hashFor("image-b");
const HASH_HIDDEN = hashFor("image-hidden");
const HASH_DELETED = hashFor("image-deleted");
const HASH_OTHER_EVENT = hashFor("image-other-event");
const HASH_FOREIGN_TENANT = hashFor("image-foreign-tenant");
const HASH_MASS_PREFIX = "op128-mass";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op128-signed-urls", env: { QUEUE_PROVIDER: "memory" } });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.eventImages,
    COLLECTIONS.faceMatches,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read the route's `POST` export, failing with a message that names it. */
function requireHandler(module: object, name: "POST"): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${SIGNED_URLS_PATH} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const postSignedUrls = requireHandler(signedUrlsRouteModule, "POST");

/** The error envelope of a failed response (Appendix A.1). */
interface ErrorBody {
  readonly code: string;
  /**
   * The per-code detail block A.1 assigns the code — `account_suspended` carries
   * `{ reason, supportUrl }`, `account_banned` carries `{ banReason, banExpires }`
   * — and is absent for a code that carries none (`forbidden`).
   */
  readonly details?: Record<string, unknown>;
}

/** Parse an error envelope without reading the body twice. */
async function errorOf(response: Response): Promise<ErrorBody> {
  const parsed = await body(response);
  return parsed.error as ErrorBody;
}

/** One signed entry of the §5.6 answer. */
interface SignedUrlEntry {
  readonly imageId: string;
  readonly kind: string;
  readonly url: string;
  readonly expiresAt: string;
}

/** One denial of the §5.6 answer. */
interface DenialEntry {
  readonly imageId: string;
  readonly kind: string;
  readonly code: string;
}

/** The whole §5.6 answer. */
interface SignedUrlsAnswer {
  readonly urls: readonly SignedUrlEntry[];
  readonly denied: readonly DenialEntry[];
}

/** Parse the §5.6 answer. */
async function answerOf(response: Response): Promise<SignedUrlsAnswer> {
  const parsed = (await body(response)) as unknown as SignedUrlsAnswer;
  return parsed;
}

/** The key set every signed entry must carry and no other (§0.15). */
const URL_KEYS = ["expiresAt", "imageId", "kind", "url"];
/** The key set every denial must carry and no other. */
const DENIED_KEYS = ["code", "imageId", "kind"];

/** A request item as the wire carries it. */
interface RequestItem {
  readonly kind: "thumbnail" | "original";
  readonly imageId: string;
}

/**
 * POST to the signed-URL refresh endpoint.
 *
 * @param items - The batch items.
 * @param cookie - The caller's session cookie pair, or `undefined` for an
 *   anonymous caller.
 * @param scopeId - The scope event id; defaults to the caller's own event.
 * @returns The handler's response.
 */
function requestSignedUrls(
  items: readonly RequestItem[],
  cookie: string | undefined,
  scopeId: string,
  scopeKind = "event"
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return postSignedUrls(
    new Request(new URL(SIGNED_URLS_PATH, APP_ORIGIN), {
      method: "POST",
      headers,
      body: JSON.stringify({ scope: { kind: scopeKind, id: scopeId }, items }),
    })
  );
}

/** The `(imageId, kind)` pairs the answer signed. */
function signedPairs(answer: SignedUrlsAnswer): string[] {
  return answer.urls.map((entry) => `${entry.imageId}:${entry.kind}`).sort();
}

/** The `(imageId, kind, code)` triples the answer denied. */
function deniedTriples(answer: SignedUrlsAnswer): string[] {
  return answer.denied.map((entry) => `${entry.imageId}:${entry.kind}:${entry.code}`).sort();
}

/** Look one signed entry up by `(imageId, kind)`, failing loudly when absent. */
function signedEntry(
  answer: SignedUrlsAnswer,
  imageId: ObjectId,
  kind: "thumbnail" | "original"
): SignedUrlEntry {
  const key = imageId.toHexString();
  const entry = answer.urls.find(
    (candidate) => candidate.imageId === key && candidate.kind === kind
  );
  if (entry === undefined) {
    throw new Error(`expected a signed ${kind} URL for image ${key}`);
  }
  return entry;
}

/** The §5.6 signer the minted URLs must verify against. */
function mediaSigner(): ReturnType<typeof createMediaSigner> {
  return createMediaSigner({ currentSecret: getConfig().media.signingSecretCurrent });
}

/**
 * Assert one entry's signature, life and origin.
 *
 * @param entry - The signed entry.
 * @param ttlSeconds - The documented life for this kind.
 * @param before - The wall clock before the request, in ms.
 * @param after - The wall clock after the request, in ms.
 */
function expectSignedLifetime(
  entry: SignedUrlEntry,
  ttlSeconds: number,
  before: number,
  after: number
): void {
  expect(new URL(entry.url).origin).toBe("https://pic.openpic.in");
  expect(mediaSigner().verify(entry.url)).toBe(true);
  expect(entry.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // The signer floors `exp` to whole seconds, so the lower bound sits one
  // second inside the requested life rather than exactly at it.
  const expiresAtMs = Date.parse(entry.expiresAt);
  expect(expiresAtMs).toBeGreaterThanOrEqual(before + (ttlSeconds - 1) * 1_000);
  expect(expiresAtMs).toBeLessThanOrEqual(after + ttlSeconds * 1_000);
}

/**
 * Assert that one entry is a §5.6 signature on the named thumbnail derivative.
 *
 * @param entry - The signed entry.
 * @param contentHash - The asset's content hash, which addresses the object.
 * @param ttlSeconds - The documented life for this kind.
 * @param before - The wall clock before the request, in ms.
 * @param after - The wall clock after the request, in ms.
 */
function expectSignedThumbnail(
  entry: SignedUrlEntry,
  contentHash: string,
  ttlSeconds: number,
  before: number,
  after: number
): void {
  expect(new URL(entry.url).pathname).toBe(`/t/${contentHash}.${THUMBNAIL_FORMAT}`);
  expectSignedLifetime(entry, ttlSeconds, before, after);
}

/**
 * Assert that one entry is a §5.6 signature on the named asset's original.
 *
 * The extension is the stored content type's business (`image/jpeg` → `.jpg` or
 * `.jpeg`), so only the `/o/<contentHash>.` address and the signature are
 * pinned here.
 *
 * @param entry - The signed entry.
 * @param contentHash - The asset's content hash, which addresses the object.
 * @param ttlSeconds - The documented life for this kind.
 * @param before - The wall clock before the request, in ms.
 * @param after - The wall clock after the request, in ms.
 */
function expectSignedOriginal(
  entry: SignedUrlEntry,
  contentHash: string,
  ttlSeconds: number,
  before: number,
  after: number
): void {
  const { pathname } = new URL(entry.url);
  expect(pathname).toMatch(/^\/o\/[0-9a-f]{64}\.[a-z0-9]+$/);
  expect(pathname.startsWith(`/o/${contentHash}.`)).toBe(true);
  expectSignedLifetime(entry, ttlSeconds, before, after);
}

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP128 Studio",
    status: "active",
    ownerUserId: owner.userId,
    billingContactUserId: owner.userId,
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
    tenantId: _id,
    userId: owner.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return _id;
}

/** Insert an `events` row plus the organizer's `event_organizers` row. */
async function seedEvent(
  tenantKey: string,
  organizerUserId: ObjectId,
  overrides: Record<string, unknown> = {}
): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "Rahul & Priya's Wedding",
    description: "",
    status: "published",
    startAt: new Date(fixtureInstant("10:00:00.000Z", 10)),
    endAt: new Date(fixtureInstant("12:00:00.000Z", 10)),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(fixtureInstant("12:00:00.000Z", 17)),
    retentionExpiresAt: new Date(fixtureInstant("12:00:00.000Z", 100)),
    accessLinks: [
      {
        slug: `op128${_id.toHexString().slice(-8)}`,
        active: true,
        createdAt: now,
        revokedAt: null,
      },
    ],
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
    createdByUserId: organizerUserId.toHexString(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: organizerUserId.toHexString(),
    role: "organizer",
    status: "active",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  return _id;
}

/** A workspace with a signed-in organizer and one published event. */
interface Workspace {
  readonly organizer: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** Sign an organizer in, provision their workspace and seed one event. */
async function seedWorkspace(prefix: string): Promise<Workspace> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = await insertTenant(`op128-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Insert a stored `media_assets` row with its thumbnail derivative (§16.1). */
async function seedAsset(tenantKey: string, contentHash: string): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id,
    tenantId: tenantKey,
    contentHash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey: `images/${contentHash}.jpg`,
      bytes: ORIGINAL_BYTES,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date("2026-09-25T08:00:00.000Z"),
    },
    derivatives: {
      thumbnail: {
        locationKey: "thumbnails",
        objectKey: `thumbnails/${contentHash}.${THUMBNAIL_FORMAT}`,
        bytes: THUMBNAIL_BYTES,
        width: 400,
        height: 600,
        format: THUMBNAIL_FORMAT,
        processorVersion: 1,
        watermarkVersion: null,
        generatedAt: new Date("2026-09-25T08:05:00.000Z"),
      },
    },
    imageMeta: {
      width: 4000,
      height: 6000,
      orientation: 6,
      exifCaptureAt: new Date("2026-09-20T11:00:00.000Z"),
      cameraMake: "SONY",
      cameraModel: "ILCE-7M4",
    },
    status: "derivatives_ready",
    refCount: 1,
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
  });
  return _id;
}

/** The `event_images` fields these pins state per case. */
interface SeedImageOptions {
  readonly sequence: number;
  readonly visibility?: string;
  readonly deletedAt?: Date | null;
}

/** Insert one `event_images` join row. */
async function seedImage(
  tenantKey: string,
  eventId: ObjectId,
  assetId: ObjectId,
  options: SeedImageOptions
): Promise<ObjectId> {
  const _id = new ObjectId();
  const createdAt = new Date("2026-09-25T09:18:00.000Z");
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: tenantKey,
    eventId,
    assetId,
    uploadedByUserId: new ObjectId(),
    uploadBatchId: new ObjectId(),
    sequence: options.sequence,
    processing: {
      status: "done",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      durationMs: 3400,
      lastError: null,
      queueRef: null,
    },
    faceCount: 1,
    visibility: options.visibility ?? "visible",
    deletedAt: options.deletedAt ?? null,
    createdAt,
  });
  return _id;
}

/** Seed one asset plus the image row that points at it. */
async function seedImageWithAsset(
  tenantKey: string,
  eventId: ObjectId,
  contentHash: string,
  options: SeedImageOptions
): Promise<{ readonly assetId: ObjectId; readonly imageId: ObjectId }> {
  const assetId = await seedAsset(tenantKey, contentHash);
  const imageId = await seedImage(tenantKey, eventId, assetId, options);
  return { assetId, imageId };
}

/** Insert an `attendee_event_profiles` row bound to the caller (schema §15.3). */
async function seedProfile(
  tenantKey: string,
  eventId: ObjectId,
  subjectUserId: ObjectId,
  matchCount: number
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id,
    tenantId: tenantKey,
    eventId,
    subject: { kind: "user", userId: subjectUserId },
    status: "ready",
    matchCount,
    lastMatchRunAt: new Date("2026-09-25T09:10:00.000Z"),
    lastSeenGalleryAt: null,
    createdAt: new Date("2026-09-25T08:30:00.000Z"),
    updatedAt: new Date("2026-09-25T09:10:00.000Z"),
  });
  return _id;
}

/** Insert one `face_matches` row for the caller's profile and an image (§17.5). */
async function seedMatch(
  tenantKey: string,
  eventId: ObjectId,
  profileId: ObjectId,
  subjectUserId: ObjectId,
  imageId: ObjectId,
  faceIndex: number
): Promise<void> {
  await app.db.collection(COLLECTIONS.faceMatches).insertOne({
    tenantId: tenantKey,
    eventId,
    profileId,
    subject: { kind: "user", userId: subjectUserId },
    imageId,
    faceIndex,
    selfieId: new ObjectId(),
    similarity: 0.74,
    confidence: "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-09-25T09:18:00.000Z"),
  });
}

/** The `originals.download` feature entitlement with the stated gate. */
function originalsEntitlement(enabled: boolean): Entitlement {
  return makeEntitlement({
    limit: null,
    resetPeriod: "none",
    scope: "event",
    enforcement: "feature",
    enabled,
  });
}

/** Insert the plan catalogue row for a key (once) and activate it for a tenant. */
async function seedPlanFor(
  tenantKey: string,
  key: string,
  entitlements: Record<string, Entitlement>
): Promise<void> {
  const existing = await app.db.collection(COLLECTIONS.plans).findOne({ key });
  if (existing === null) {
    await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key, entitlements }));
  }
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: key,
      activePlanKey: key,
      status: "active",
    })
  );
}

/** Activate a plan whose `originals.download` gate is the stated value. */
async function seedOriginalsPlan(tenantKey: string, enabled: boolean): Promise<void> {
  await seedPlanFor(tenantKey, enabled ? PLAN_KEY_ENABLED : PLAN_KEY_DISABLED, {
    [ORIGINALS_KEY]: originalsEntitlement(enabled),
  });
}

/** A signed-in caller who is neither a tenant member nor an event organizer. */
interface Attendee {
  readonly user: SignedInUser;
  readonly profileId: ObjectId;
}

/**
 * Sign an attendee in and give them a ready profile on the event with a match
 * for each id in `imageIds`.
 */
async function seedAttendee(
  workspace: Workspace,
  prefix: string,
  imageIds: readonly ObjectId[]
): Promise<Attendee> {
  const user = await app.signIn(makeIdentity(prefix));
  const profileId = await seedProfile(
    workspace.tenantKey,
    workspace.eventId,
    user.userId,
    imageIds.length
  );
  let faceIndex = 0;
  for (const imageId of imageIds) {
    faceIndex += 1;
    await seedMatch(
      workspace.tenantKey,
      workspace.eventId,
      profileId,
      user.userId,
      imageId,
      faceIndex
    );
  }
  return { user, profileId };
}

/**
 * The query commands a request issues, counted at the driver's `Collection`
 * prototype.
 *
 * `find`, `findOne`, `aggregate`, `countDocuments` and `distinct` are the
 * collection-level reads a route can use; an N+1 implementation calls one per
 * item, a batched one calls them a constant number of times. `vi.spyOn`
 * forwards to the real method, so the request behaves exactly as it would
 * unspied.
 *
 * @param run - The request to measure.
 * @returns The number of collection reads the request issued.
 */
async function countQueries(run: () => Promise<void>): Promise<number> {
  const spies = [
    vi.spyOn(Collection.prototype, "find"),
    vi.spyOn(Collection.prototype, "findOne"),
    vi.spyOn(Collection.prototype, "aggregate"),
    vi.spyOn(Collection.prototype, "countDocuments"),
    vi.spyOn(Collection.prototype, "distinct"),
  ];
  try {
    await run();
    return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/** The §5.6 answer of a batch that must succeed, read once. */
async function successfulAnswer(response: Response): Promise<SignedUrlsAnswer> {
  expect(response.status).toBe(200);
  return answerOf(response);
}

describe("I1: a member gets thumbnails + originals when the feature is enabled", () => {
  it("signs both kinds for the event's organizer with the documented lives", async () => {
    // Arrange — the tenant's plan enables `originals.download`.
    const workspace = await seedWorkspace("i1-member");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const imageA = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const imageB = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_B, {
      sequence: 2,
    });

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: imageA.imageId.toHexString() },
        { kind: "original", imageId: imageA.imageId.toHexString() },
        { kind: "thumbnail", imageId: imageB.imageId.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert — three URLs, nothing denied, and only the two documented keys.
    expect(Object.keys(answer).sort()).toEqual(["denied", "urls"]);
    expect(answer.denied).toEqual([]);
    expect(signedPairs(answer)).toEqual([
      `${imageA.imageId.toHexString()}:original`,
      `${imageA.imageId.toHexString()}:thumbnail`,
      `${imageB.imageId.toHexString()}:thumbnail`,
    ]);

    const thumbnail = signedEntry(answer, imageA.imageId, "thumbnail");
    const original = signedEntry(answer, imageA.imageId, "original");
    expect(Object.keys(thumbnail).sort()).toEqual(URL_KEYS);
    expect(Object.keys(original).sort()).toEqual(URL_KEYS);
    expectSignedThumbnail(thumbnail, HASH_A, THUMBNAIL_TTL_SECONDS, before, after);
    expectSignedOriginal(original, HASH_A, ORIGINAL_TTL_SECONDS, before, after);
    // The second image's thumbnail is signed from its own content hash, so the
    // per-item signature is real and not one reused URL.
    expect(new URL(signedEntry(answer, imageB.imageId, "thumbnail").url).pathname).toBe(
      `/t/${HASH_B}.${THUMBNAIL_FORMAT}`
    );
  });

  it("keeps the thumbnail working and denies the original as feature_not_available when the plan disables it", async () => {
    // Arrange
    const workspace = await seedWorkspace("i1-no-feature");
    await seedOriginalsPlan(workspace.tenantKey, false);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "original", imageId: image.imageId.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert — a partial refresh, never a failed batch (§5.6).
    expect(signedPairs(answer)).toEqual([`${image.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([
      `${image.imageId.toHexString()}:original:feature_not_available`,
    ]);
  });
});

describe("I2: an attendee gets only matched images; others denied", () => {
  it("signs the matched image and denies the unmatched one without leaking a URL", async () => {
    // Arrange — the attendee has a match for A only.
    const workspace = await seedWorkspace("i2-attendee");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const imageA = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const imageB = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_B, {
      sequence: 2,
    });
    const attendee = await seedAttendee(workspace, "i2-attendee-user", [imageA.imageId]);

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: imageA.imageId.toHexString() },
        { kind: "thumbnail", imageId: imageB.imageId.toHexString() },
      ],
      attendee.user.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert
    expect(signedPairs(answer)).toEqual([`${imageA.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([`${imageB.imageId.toHexString()}:thumbnail:forbidden`]);
    expect(answer.denied.map((entry) => Object.keys(entry).sort())).toEqual([DENIED_KEYS]);
    expectSignedThumbnail(
      signedEntry(answer, imageA.imageId, "thumbnail"),
      HASH_A,
      THUMBNAIL_TTL_SECONDS,
      before,
      after
    );
  });

  it("denies an organizer-hidden image that carries a match for the caller, while a visible matched image still succeeds", async () => {
    // Arrange — hiding writes only `visibility` (ADR-0762 D5/A5), so the
    // match row is still there; the §5.6 gate is what must refuse it.
    const workspace = await seedWorkspace("i2-hidden");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const visible = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const hidden = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_HIDDEN, {
      sequence: 2,
      visibility: "hidden",
      deletedAt: null,
    });
    const attendee = await seedAttendee(workspace, "i2-hidden-user", [
      visible.imageId,
      hidden.imageId,
    ]);

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: visible.imageId.toHexString() },
        { kind: "thumbnail", imageId: hidden.imageId.toHexString() },
        { kind: "original", imageId: hidden.imageId.toHexString() },
      ],
      attendee.user.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert — the hidden image is denied for both kinds, the visible one is
    // signed, and the denial carries no URL for the hidden id at all.
    expect(signedPairs(answer)).toEqual([`${visible.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([
      `${hidden.imageId.toHexString()}:original:forbidden`,
      `${hidden.imageId.toHexString()}:thumbnail:forbidden`,
    ]);
    expect(answer.urls.filter((entry) => entry.imageId === hidden.imageId.toHexString())).toEqual(
      []
    );
  });

  it("signs the matched attendee's original while the plan permits attendee originals", async () => {
    // Arrange
    const workspace = await seedWorkspace("i2-original-on");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const attendee = await seedAttendee(workspace, "i2-original-on-user", [image.imageId]);

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [{ kind: "original", imageId: image.imageId.toHexString() }],
      attendee.user.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert
    expect(answer.denied).toEqual([]);
    expectSignedOriginal(
      signedEntry(answer, image.imageId, "original"),
      HASH_A,
      ORIGINAL_TTL_SECONDS,
      before,
      after
    );
  });

  it("denies the matched attendee's original as feature_not_available when the plan disables it", async () => {
    // Arrange
    const workspace = await seedWorkspace("i2-original-off");
    await seedOriginalsPlan(workspace.tenantKey, false);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const attendee = await seedAttendee(workspace, "i2-original-off-user", [image.imageId]);

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "original", imageId: image.imageId.toHexString() },
      ],
      attendee.user.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert
    expect(signedPairs(answer)).toEqual([`${image.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([
      `${image.imageId.toHexString()}:original:feature_not_available`,
    ]);
  });
});

describe("I3: an image from another event in scope is denied", () => {
  it("denies another event's image, a foreign tenant's image, a soft-deleted image and an unknown id as not_found", async () => {
    // Arrange — same tenant, second event; a second tenant; a soft-deleted
    // image of the scope event; and an id nothing carries.
    const workspace = await seedWorkspace("i3-scope");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const inside = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const secondEvent = await seedEvent(workspace.tenantKey, workspace.organizer.userId);
    const otherEvent = await seedImageWithAsset(
      workspace.tenantKey,
      secondEvent,
      HASH_OTHER_EVENT,
      {
        sequence: 1,
      }
    );
    const foreignTenant = await seedWorkspace("i3-foreign");
    const foreignEvent = await seedImageWithAsset(
      foreignTenant.tenantKey,
      foreignTenant.eventId,
      HASH_FOREIGN_TENANT,
      { sequence: 1 }
    );
    const deleted = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_DELETED, {
      sequence: 2,
      deletedAt: new Date("2026-09-26T00:00:00.000Z"),
    });
    const unknown = new ObjectId();

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: inside.imageId.toHexString() },
        { kind: "thumbnail", imageId: otherEvent.imageId.toHexString() },
        { kind: "thumbnail", imageId: foreignEvent.imageId.toHexString() },
        { kind: "thumbnail", imageId: deleted.imageId.toHexString() },
        { kind: "thumbnail", imageId: unknown.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert — only the in-scope live image is signed.
    expect(signedPairs(answer)).toEqual([`${inside.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual(
      [
        otherEvent.imageId.toHexString(),
        foreignEvent.imageId.toHexString(),
        deleted.imageId.toHexString(),
        unknown.toHexString(),
      ]
        .map((id) => `${id}:thumbnail:not_found`)
        .sort()
    );
  });

  it("answers 403 when every requested image is out of scope", async () => {
    // Arrange
    const workspace = await seedWorkspace("i3-all-denied");
    const secondEvent = await seedEvent(workspace.tenantKey, workspace.organizer.userId);
    const otherEvent = await seedImageWithAsset(
      workspace.tenantKey,
      secondEvent,
      HASH_OTHER_EVENT,
      {
        sequence: 1,
      }
    );

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: otherEvent.imageId.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — §5.6's "if every item is denied → 403".
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("forbidden");
  });
});

describe("I4: the batch limits", () => {
  it("refuses 201 items with 413 payload_too_large", async () => {
    // Arrange — the batch ceiling is stated on the wire, before any lookup.
    const workspace = await seedWorkspace("i4-over-max");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const items = Array.from({ length: OVER_MAX_ITEMS }, (_unused, index) => ({
      kind: index % 2 === 0 ? ("thumbnail" as const) : ("original" as const),
      imageId: image.imageId.toHexString(),
    }));

    // Act
    const response = await requestSignedUrls(
      items,
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("payload_too_large");
  });

  it("accepts exactly 200 items", async () => {
    // Arrange — 200 images, one thumbnail each: the documented maximum.
    const workspace = await seedWorkspace("i4-max");
    const images = await seedMassImages(workspace, MAX_ITEMS);
    const items = images.map((imageId) => ({
      kind: "thumbnail" as const,
      imageId: imageId.toHexString(),
    }));

    // Act
    const response = await requestSignedUrls(
      items,
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert
    expect(answer.denied).toEqual([]);
    expect(answer.urls).toHaveLength(MAX_ITEMS);
  });

  it("refuses an empty item list with 422 validation_failed", async () => {
    // Arrange
    const workspace = await seedWorkspace("i4-empty");

    // Act
    const response = await requestSignedUrls(
      [],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — a refresh of nothing is a client bug, not a 200.
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
  });

  it("refuses an unknown scope kind with 422 validation_failed", async () => {
    // Arrange — §5.6 documents `scope.kind: "event"` and nothing else.
    const workspace = await seedWorkspace("i4-scope-kind");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString(),
      "batch"
    );

    // Assert
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
  });
});

describe("I5: the query count stays constant as the batch grows", () => {
  it("issues the same number of reads for 200 items as for 2", async () => {
    // Arrange — one event with 200 images, and a member allowed on all of them.
    const workspace = await seedWorkspace("i5-queries");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const images = await seedMassImages(workspace, MAX_ITEMS);
    const scopeId = workspace.eventId.toHexString();

    const small = images.slice(0, 2).map((imageId) => ({
      kind: "thumbnail" as const,
      imageId: imageId.toHexString(),
    }));
    const large = images.map((imageId) => ({
      kind: "thumbnail" as const,
      imageId: imageId.toHexString(),
    }));

    // Warm the caches (platform settings, plan resolution) so both measured
    // requests run against the same state.
    await successfulAnswer(await requestSignedUrls(small, workspace.organizer.cookie, scopeId));

    // Act
    let smallAnswer: SignedUrlsAnswer | undefined;
    const smallQueries = await countQueries(async () => {
      smallAnswer = await successfulAnswer(
        await requestSignedUrls(small, workspace.organizer.cookie, scopeId)
      );
    });
    let largeAnswer: SignedUrlsAnswer | undefined;
    const largeQueries = await countQueries(async () => {
      largeAnswer = await successfulAnswer(
        await requestSignedUrls(large, workspace.organizer.cookie, scopeId)
      );
    });

    // Assert — both requests really refreshed their whole batch…
    expect(smallAnswer?.urls).toHaveLength(2);
    expect(largeAnswer?.urls).toHaveLength(MAX_ITEMS);
    // …and the 200-item one cost exactly the same number of reads.
    expect(largeQueries).toBe(smallQueries);
    expect(largeQueries).toBeLessThan(MAX_ITEMS);
  });
});

describe("I6: an anonymous session asking for an original", () => {
  it("answers 200 with the item denied as authentication_required", async () => {
    // Arrange
    const workspace = await seedWorkspace("i6-anonymous");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "original", imageId: image.imageId.toHexString() }],
      undefined,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert
    expect(answer.urls).toEqual([]);
    expect(deniedTriples(answer)).toEqual([
      `${image.imageId.toHexString()}:original:authentication_required`,
    ]);
  });

  it("denies both kinds for an anonymous caller and still answers 200", async () => {
    // Arrange — the `authentication_required` denial never escalates to 403.
    const workspace = await seedWorkspace("i6-anonymous-both");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "original", imageId: image.imageId.toHexString() },
      ],
      undefined,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert
    expect(answer.urls).toEqual([]);
    expect(deniedTriples(answer)).toEqual([
      `${image.imageId.toHexString()}:original:authentication_required`,
      `${image.imageId.toHexString()}:thumbnail:authentication_required`,
    ]);
  });
});

/**
 * Seed `count` images (asset + join row) into one event in two bulk writes.
 *
 * @param workspace - The workspace and event to seed into.
 * @param count - How many images to create.
 * @returns The created image ids, in sequence order.
 */
async function seedMassImages(workspace: Workspace, count: number): Promise<ObjectId[]> {
  const assets = Array.from({ length: count }, (_unused, index) => {
    const contentHash = createHash("sha256")
      .update(`${HASH_MASS_PREFIX}-${String(index)}`)
      .digest("hex");
    return {
      _id: new ObjectId(),
      contentHash,
      tenantId: workspace.tenantKey,
      kind: "event_image",
      storage: {
        locationKey: "originals",
        objectKey: `images/${contentHash}.jpg`,
        bytes: ORIGINAL_BYTES,
        contentType: "image/jpeg",
        checksum: contentHash,
        storedAt: new Date("2026-09-25T08:00:00.000Z"),
      },
      derivatives: {
        thumbnail: {
          locationKey: "thumbnails",
          objectKey: `thumbnails/${contentHash}.${THUMBNAIL_FORMAT}`,
          bytes: THUMBNAIL_BYTES,
          width: 400,
          height: 600,
          format: THUMBNAIL_FORMAT,
          processorVersion: 1,
          watermarkVersion: null,
          generatedAt: new Date("2026-09-25T08:05:00.000Z"),
        },
      },
      imageMeta: { width: 4000, height: 6000, orientation: 6 },
      status: "derivatives_ready",
      refCount: 1,
      createdAt: new Date("2026-09-25T08:00:00.000Z"),
    };
  });
  await app.db.collection(COLLECTIONS.mediaAssets).insertMany(assets);

  const createdAt = new Date("2026-09-25T09:18:00.000Z");
  const images = assets.map((asset, index) => ({
    _id: new ObjectId(),
    tenantId: workspace.tenantKey,
    eventId: workspace.eventId,
    assetId: asset._id,
    uploadedByUserId: workspace.organizer.userId,
    uploadBatchId: new ObjectId(),
    sequence: index + 1,
    processing: {
      status: "done",
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      durationMs: 3400,
      lastError: null,
      queueRef: null,
    },
    faceCount: 0,
    visibility: "visible",
    deletedAt: null,
    createdAt,
  }));
  await app.db.collection(COLLECTIONS.eventImages).insertMany(images);
  return images.map((image) => image._id);
}

/**
 * The ban expiry these pins use: far in the future, so the ban is active.
 *
 * Declared above the refusal table because the `banned` row states the ISO form
 * the wire must carry (`guards.ts` serializes `banExpires` with `toISOString()`),
 * which keeps the seeded instant and the expected string one value.
 */
const BAN_EXPIRES_NEVER = new Date("2099-01-01T00:00:00.000Z");

/** The reason `seedBan` writes, and therefore the one the wire must echo. */
const BAN_REASON = "spam";

/**
 * One account state the `user` label refuses, how to seed it, and the whole
 * wire answer Appendix A.1 assigns that state.
 */
interface RefusedAccountState {
  readonly name: string;
  readonly seed: (organizer: SignedInUser) => Promise<void>;
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/**
 * The refusals `evaluateAuth("user", …)` applies before any label rule (§0.3,
 * ADR-0025): two lifecycle statuses carried by `userProfiles`, and the ban
 * carried by the Better Auth `user` row — each with the A.1 answer for it.
 */
const REFUSED_ACCOUNT_STATES: readonly RefusedAccountState[] = [
  {
    name: "suspended",
    seed: (organizer) => seedProfileStatus(organizer.userId, "suspended"),
    status: 423,
    code: "account_suspended",
    details: { reason: "suspended", supportUrl: "/support" },
  },
  {
    name: "deletion_pending",
    seed: (organizer) => seedProfileStatus(organizer.userId, "deletion_pending"),
    status: 403,
    code: "forbidden",
  },
  {
    name: "banned",
    seed: (organizer) => seedBan(organizer.userId),
    status: 423,
    code: "account_banned",
    details: { banReason: BAN_REASON, banExpires: BAN_EXPIRES_NEVER.toISOString() },
  },
];

/**
 * The account-status half of the §0.3 gate (OP-128 follow-up pin, finding F1 of
 * the OP-128 review; re-pinned to the Appendix A.1 envelope by ADR-0772).
 *
 * §5.6 names `user` or `attendee` for this endpoint, and the `user` label
 * refuses a principal whose account is suspended, banned or pending deletion
 * (`evaluateAuth`, `@/server/auth/guards`). The route resolves the principal
 * itself, so that table runs only when the route asks for it — the reviewer
 * measured a suspended organizer receiving `200` with a signed thumbnail
 * **and** a signed original. These pins close that.
 *
 * The wire answer is the **Appendix A.1** envelope, not a §5.6 `denied[]` code:
 * an account-state refusal denies the whole **request**, not one item, and A.1
 * already owns that envelope (§0.3's "banned users → `423 account_banned` with
 * `{ banReason, banExpires }`"; `AUTH_ERROR_TRANSPORT` in
 * `@/server/http/catalog`). So the guards' own answers reach the wire verbatim —
 * `423 account_suspended` with `{ reason: "suspended", supportUrl: "/support" }`
 * and `423 account_banned` with `{ banReason, banExpires }` (`banExpires` an ISO
 * string, or `null` for a permanent ban) — while the deletion states
 * (`deletion_pending`, `deleted`) stay `403 forbidden`, A.1's only other member
 * of this family. §5.6's four per-item codes keep governing `denied[]` for an
 * **allowed** principal; the 403 all-denied collapse is that rule, not this one.
 * ADR-0772 records the decision and supersedes ADR-0768 D1, whose `403
 * forbidden` flattening dropped the `supportUrl` / `banReason` / `banExpires`
 * detail a client needs to explain the refusal.
 *
 * No refusal row may carry a `urls` key or any trace of the image's content
 * hash: nothing is signed for a refused request.
 *
 * Every case seeds the same fixture and changes only the account state, so the
 * `active` control proves the refusal comes from the status and not from a
 * broken fixture.
 */
describe("I7: the account-status gate refuses a suspended, banned or deletion-pending caller", () => {
  it.each(REFUSED_ACCOUNT_STATES)(
    "answers $status $code and mints no URL for a $name event member",
    async ({ name, seed, status, code, details }) => {
      // Arrange — the control's fixture, plus the account state.
      const workspace = await seedWorkspace(`i7-${name}`);
      await seedOriginalsPlan(workspace.tenantKey, true);
      const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
        sequence: 1,
      });
      await seed(workspace.organizer);

      // Act — both kinds, on an image of the event this caller organizes.
      const response = await requestSignedUrls(
        [
          { kind: "thumbnail", imageId: image.imageId.toHexString() },
          { kind: "original", imageId: image.imageId.toHexString() },
        ],
        workspace.organizer.cookie,
        workspace.eventId.toHexString()
      );

      // Assert — the A.1 answer for this state, its details, no `urls[]`, and
      // nothing the signer could have minted (a signed URL addresses the hash).
      const payload = await body(response);
      const error = payload.error as ErrorBody;
      expect(response.status).toBe(status);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
      expect(payload.urls).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain(HASH_A);
    }
  );

  it("answers 423 account_suspended for a suspended attendee that holds a match", async () => {
    // Arrange — a matched attendee would otherwise be signed this image, so the
    // refusal cannot come from the per-item relationship rules.
    const workspace = await seedWorkspace("i7-suspended-attendee");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const attendee = await seedAttendee(workspace, "i7-suspended-attendee-user", [image.imageId]);
    await seedProfileStatus(attendee.user.userId, "suspended");

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      attendee.user.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — the same A.1 envelope the organizer's suspension produces: the
    // account decides, not the relationship.
    const payload = await body(response);
    const error = payload.error as ErrorBody;
    expect(response.status).toBe(423);
    expect(error.code).toBe("account_suspended");
    expect(error.details).toEqual({ reason: "suspended", supportUrl: "/support" });
    expect(payload.urls).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });

  it("signs both kinds for the identical fixture while the profile is active", async () => {
    // Arrange — the control: same workspace shape, same plan, same image, and a
    // profile row written the same way; only the status differs.
    const workspace = await seedWorkspace("i7-control-active");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedProfileStatus(workspace.organizer.userId, "active");

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "original", imageId: image.imageId.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert — an active account is not refused: both kinds are signed.
    expect(answer.denied).toEqual([]);
    expect(signedPairs(answer)).toEqual([
      `${image.imageId.toHexString()}:original`,
      `${image.imageId.toHexString()}:thumbnail`,
    ]);
    expectSignedThumbnail(
      signedEntry(answer, image.imageId, "thumbnail"),
      HASH_A,
      THUMBNAIL_TTL_SECONDS,
      before,
      after
    );
    expectSignedOriginal(
      signedEntry(answer, image.imageId, "original"),
      HASH_A,
      ORIGINAL_TTL_SECONDS,
      before,
      after
    );
  });

  it("keeps an active member's mixed batch at 200 with the unknown item denied", async () => {
    // Arrange — the batch rule must survive the new gate: a partial denial is a
    // `200`, never a refusal of the whole request.
    const workspace = await seedWorkspace("i7-mixed-batch");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedProfileStatus(workspace.organizer.userId, "active");
    const unknown = new ObjectId();

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "thumbnail", imageId: unknown.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert
    expect(signedPairs(answer)).toEqual([`${image.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([`${unknown.toHexString()}:thumbnail:not_found`]);
  });
});

/**
 * Upsert the caller's `userProfiles` row at one lifecycle status (§13.2).
 *
 * `loadProfile` (`@/server/auth/guards`) reads `userProfiles` by
 * `{ userId: ObjectId }` and prefers an explicitly managed row over the
 * `autoProvisioned` default the identity hook writes, so this row says
 * `autoProvisioned: false` instead of relying on that sort.
 *
 * @param userId - The Better Auth user id the profile belongs to.
 * @param status - The lifecycle status (`active`, `suspended`, `deletion_pending`, …).
 */
async function seedProfileStatus(userId: ObjectId, status: string): Promise<void> {
  await app.db.collection(COLLECTIONS.userProfiles).updateOne(
    { userId },
    {
      $set: {
        userId,
        status,
        platformRole: "client",
        accountCompletedAt: null,
        primaryTenantId: null,
        schemaVersion: 1,
        autoProvisioned: false,
      },
    },
    { upsert: true }
  );
}

/**
 * Ban the caller's Better Auth user in place (§13.1).
 *
 * The `user` label reads `banned`/`banReason`/`banExpires` off the session's
 * user, not off `userProfiles`, so the ban is the `user` row's business.
 *
 * @param userId - The user to ban.
 * @param banExpires - The ban's expiry; `null` is a permanent ban, and a past
 *   instant is an expired (therefore over) ban. Defaults to the far future, so
 *   the ban is active.
 */
async function seedBan(
  userId: ObjectId,
  banExpires: Date | null = BAN_EXPIRES_NEVER
): Promise<void> {
  await app.db
    .collection("user")
    .updateOne({ _id: userId }, { $set: { banned: true, banReason: BAN_REASON, banExpires } });
}

/**
 * Insert a stored `media_assets` row that records **no** thumbnail derivative
 * (§16.1) — the legacy row `extensionOf` papers over, and the same state the
 * §4.4 grid projection answers `thumbnailUrl: null` for.
 *
 * @param tenantKey - The owning tenant.
 * @param contentHash - The asset's content hash, which addresses the object.
 * @returns The asset's `_id`.
 */
async function seedAssetWithoutThumbnailDerivative(
  tenantKey: string,
  contentHash: string
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
    _id,
    tenantId: tenantKey,
    contentHash,
    kind: "event_image",
    storage: {
      locationKey: "originals",
      objectKey: `images/${contentHash}.jpg`,
      bytes: ORIGINAL_BYTES,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date("2026-09-25T08:00:00.000Z"),
    },
    derivatives: {},
    imageMeta: { width: 4000, height: 6000, orientation: 6 },
    status: "uploaded",
    refCount: 1,
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
  });
  return _id;
}

/** The content hash of the asset whose thumbnail derivative was never recorded. */
const HASH_NO_DERIVATIVE = hashFor("image-no-derivative");

/** The ban expiry these breadth pins use when the ban must already be over. */
const BAN_EXPIRED = new Date("2020-01-01T00:00:00.000Z");

/**
 * The §5.6 fallbacks the GREEN implemented and left unpinned (OP-128 review F2;
 * ADR-0771 D1).
 *
 * Three states are reachable through the endpoint and none of them was pinned:
 *
 * - an asset row that records **no** `derivatives.thumbnail.format`. The route's
 *   `extensionOf` answers the legacy `webp` default, so the item is signed as
 *   `/t/<contentHash>.webp`. The sibling §4.4 projection
 *   (`toEventImageListItem`, `@/server/images/dto`) answers `thumbnailUrl: null`
 *   for the same row, and that `null` is pinned by
 *   `event-images-management.test.ts` ("I1: an image whose thumbnail has not
 *   been generated yet is listed with null thumbnail fields"). Both surfaces are
 *   therefore pinned, and ADR-0771 D1 records why they stay different: the
 *   refresh answers `urls[]`/`denied[]` and its four denial codes have no
 *   "derivative not ready yet" member, so refusing would report a
 *   still-processing image as absent. Whoever changes either surface must
 *   change this pin and that ADR with it — that is what stops the drift.
 * - an **image row whose `media_assets` row is gone**: nothing can be signed, so
 *   the item is `not_found` (and alone in a batch it collapses to `403`).
 * - a **scope id that resolves no event** (malformed, or well formed and
 *   unknown): `tenantKey` is `null`, so every item is `not_found` with no read.
 */
describe("I8: the fallbacks — a derivative that does not exist, an image whose asset row is gone, a scope that does not resolve", () => {
  it("signs a thumbnail for an asset that records no thumbnail format under the documented .webp fallback", async () => {
    // Arrange — a stored asset with no `derivatives.thumbnail.format`.
    const workspace = await seedWorkspace("i8-no-derivative");
    const assetId = await seedAssetWithoutThumbnailDerivative(
      workspace.tenantKey,
      HASH_NO_DERIVATIVE
    );
    const imageId = await seedImage(workspace.tenantKey, workspace.eventId, assetId, {
      sequence: 1,
    });

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: imageId.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert — the item is signed, never denied, and the path is the fallback
    // `webp` rather than a recorded format (the asset records none).
    expect(answer.denied).toEqual([]);
    const entry = signedEntry(answer, imageId, "thumbnail");
    expectSignedThumbnail(entry, HASH_NO_DERIVATIVE, THUMBNAIL_TTL_SECONDS, before, after);
    expect(new URL(entry.url).pathname).toBe(`/t/${HASH_NO_DERIVATIVE}.webp`);
  });

  it("denies an image whose asset row is gone as not_found while the live image in the same batch is signed", async () => {
    // Arrange — a join row that points at an id no `media_assets` row carries.
    const workspace = await seedWorkspace("i8-asset-gone-pair");
    const live = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    const orphan = await seedImage(workspace.tenantKey, workspace.eventId, new ObjectId(), {
      sequence: 2,
    });

    // Act
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: live.imageId.toHexString() },
        { kind: "thumbnail", imageId: orphan.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const answer = await successfulAnswer(response);

    // Assert — one URL for the live image, one coded refusal for the orphan,
    // and no entry of any kind for the orphan in `urls[]`.
    expect(signedPairs(answer)).toEqual([`${live.imageId.toHexString()}:thumbnail`]);
    expect(deniedTriples(answer)).toEqual([`${orphan.toHexString()}:thumbnail:not_found`]);
    expect(answer.urls.some((entry) => entry.imageId === orphan.toHexString())).toBe(false);
  });

  it("answers 403 when the only requested image has no asset row", async () => {
    // Arrange — the all-denied credentialed batch, reached through a missing
    // asset rather than a missing image.
    const workspace = await seedWorkspace("i8-asset-gone-alone");
    const orphan = await seedImage(workspace.tenantKey, workspace.eventId, new ObjectId(), {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: orphan.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("forbidden");
  });

  it("denies every item as not_found and answers 403 when the scope id is malformed", async () => {
    // Arrange — a scope id that is not a 24-hex ObjectId.
    const workspace = await seedWorkspace("i8-scope-malformed");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      workspace.organizer.cookie,
      "not-an-object-id"
    );

    // Assert — no scope means no tenant, so every item is `not_found` and the
    // credentialed batch collapses; no URL and no content hash reaches the wire.
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload).toMatchObject({ error: { code: "forbidden" } });
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });

  it("denies every item as not_found and answers 403 when the scope id names no event", async () => {
    // Arrange — a well-formed id whose `events` row does not exist.
    const workspace = await seedWorkspace("i8-scope-unknown");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      workspace.organizer.cookie,
      new ObjectId().toHexString()
    );

    // Assert
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload).toMatchObject({ error: { code: "forbidden" } });
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });

  it("answers 403 not_found for an anonymous caller when the scope event does not exist", async () => {
    // Arrange — the F4 consequence pinned where it is observable: on a live
    // scope the same caller and image are `authentication_required` and `200`
    // (I6); an unresolvable scope is `not_found`, which outranks identity.
    const workspace = await seedWorkspace("i8-scope-anonymous");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      undefined,
      new ObjectId().toHexString()
    );

    // Assert
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload).toMatchObject({ error: { code: "forbidden" } });
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });
});

/**
 * The rest of the §0.3 account matrix the gate must not drift through (OP-128
 * review F-G3 breadth; ADR-0771 D4).
 *
 * `I7` pins the three refusal states it was written for. These four rows pin the
 * edges around them: a ban whose expiry has passed is **over** (`isUnbanned`
 * compares against the injected clock), a `banExpires: null` ban is
 * **permanent**, the `deleted` status shares the deletion branch, and the
 * 201-item cap runs **before** the account gate, so a suspended caller's
 * oversized batch is a `413` and never a `423`.
 *
 * The refusal wire format is the Appendix A.1 envelope ADR-0772 pins — `423
 * account_banned` with `{ banReason, banExpires }` for a live ban, `403
 * forbidden` for the deletion states — and the `I7` describe holds the three
 * base states. These rows hold the edges around them and the two answers the
 * decision does not move: an expired ban is over (`200`), and the item cap
 * still answers `413` before the account gate can run.
 */
describe("I7b: the gate's breadth — ban expiry, the deletion states and the item cap", () => {
  it("still signs both kinds for a caller whose ban has already expired", async () => {
    // Arrange — `banExpires` in the past: the ban is over, not a life sentence.
    const workspace = await seedWorkspace("i7b-expired-ban");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedBan(workspace.organizer.userId, BAN_EXPIRED);

    // Act
    const before = Date.now();
    const response = await requestSignedUrls(
      [
        { kind: "thumbnail", imageId: image.imageId.toHexString() },
        { kind: "original", imageId: image.imageId.toHexString() },
      ],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );
    const after = Date.now();
    const answer = await successfulAnswer(response);

    // Assert — the expired ban does not refuse the caller.
    expect(answer.denied).toEqual([]);
    expect(signedPairs(answer)).toEqual([
      `${image.imageId.toHexString()}:original`,
      `${image.imageId.toHexString()}:thumbnail`,
    ]);
    expectSignedThumbnail(
      signedEntry(answer, image.imageId, "thumbnail"),
      HASH_A,
      THUMBNAIL_TTL_SECONDS,
      before,
      after
    );
  });

  it("answers 423 account_banned with the ban details for a permanent ban", async () => {
    // Arrange — `banExpires: null` is a permanent ban (`isUnbanned`).
    const workspace = await seedWorkspace("i7b-permanent-ban");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedBan(workspace.organizer.userId, null);

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — the `user` label's own transport and code, with the details a
    // client needs to explain the ban; no URL reaches the wire.
    expect(response.status).toBe(423);
    const payload = await body(response);
    expect(payload).toMatchObject({
      error: {
        code: "account_banned",
        details: { banReason: BAN_REASON, banExpires: null },
      },
    });
    expect(payload.urls).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });

  it("answers 403 forbidden for a deleted profile", async () => {
    // Arrange — `deleted` shares the deletion branch with `deletion_pending`.
    const workspace = await seedWorkspace("i7b-deleted");
    await seedOriginalsPlan(workspace.tenantKey, true);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedProfileStatus(workspace.organizer.userId, "deleted");

    // Act
    const response = await requestSignedUrls(
      [{ kind: "thumbnail", imageId: image.imageId.toHexString() }],
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — the deletion states stay `403 forbidden`, never `423`.
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload).toMatchObject({ error: { code: "forbidden" } });
    expect(payload.urls).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });

  it("answers 413 payload_too_large for a suspended caller's 201-item batch", async () => {
    // Arrange — the item cap precedes the account gate, so the size wins and
    // no URL is minted either way.
    const workspace = await seedWorkspace("i7b-suspended-over-max");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_A, {
      sequence: 1,
    });
    await seedProfileStatus(workspace.organizer.userId, "suspended");
    const items = Array.from({ length: OVER_MAX_ITEMS }, (_unused, index) => ({
      kind: index % 2 === 0 ? ("thumbnail" as const) : ("original" as const),
      imageId: image.imageId.toHexString(),
    }));

    // Act
    const response = await requestSignedUrls(
      items,
      workspace.organizer.cookie,
      workspace.eventId.toHexString()
    );

    // Assert — the cap refuses the whole request, so this row states the same
    // no-signed-object invariant as every other refusal row: no `urls` key and
    // no content hash anywhere in the body (the cap runs before the account
    // gate, ADR-0772 D3, so no signed object is minted either way).
    expect(response.status).toBe(413);
    const payload = await body(response);
    expect((payload.error as ErrorBody).code).toBe("payload_too_large");
    expect(payload.urls).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
  });
});
