import { createHash } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import * as imagesRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images/route";
import * as imageRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/route";
import * as reprocessRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/reprocess/route";
import * as reprocessFailedRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images:reprocess-failed/route";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createMediaSigner } from "@/server/media/signer";
import type { Entitlement } from "@/server/plans/plans";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { periodKey } from "@/server/services/entitlements";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
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

/**
 * Integration / contract — event image management (OP-127 I1–I7, contract §4.4,
 * schema §16.1–§16.3 and §18.2).
 *
 * The user story: *as an organizer, I want to browse, hide, delete and reprocess
 * event images so that I can curate the gallery and fix failures.* Five
 * endpoints deliver it, all under
 * `/api/v1/tenants/{tenantId}/events/{eventId}/images`:
 *
 * - `GET …/images?cursor=&limit=&status=&visibility=&uploadedBy=&batchId=&sort=`
 *   — the organizer's grid. Newest-first by `sequence` (the monotonic ordering
 *   key a batch upload cannot tie), a **signed** thumbnail URL per item with a
 *   24 h life, the asset's `imageMeta` dimensions so the grid reserves aspect
 *   ratio before load, and an approximate `summary` from the event's counters.
 *   Soft-deleted images are never listed; hidden images are listed unless the
 *   caller filters them out (hide is not delete).
 * - `PATCH …/images/{imageId}` `{ visibility: "visible" | "hidden" }` —
 *   organizer/co-organizer. `200` with the updated image.
 * - `DELETE …/images/{imageId}` — organizer/co-organizer, user-initiated. `204`.
 *   One transaction: soft-delete the join row (`deletedAt`), remove the image's
 *   `faceMatches` rows and decrement each affected profile's `matchCount`,
 *   decrement the asset's `refCount` (the object is purged only at `0`, by a
 *   job), decrement the event's `imageCount`/`storageBytes` and release the
 *   tenant's `storage.bytes` meter.
 * - `POST …/images/{imageId}/reprocess` — event member. `202` with the image
 *   reset to `queued` and re-enqueued; `409 not_failed` for anything that is not
 *   `failed` (a done image is not re-processed).
 * - `POST …/images:reprocess-failed` — event member. `202` `{ requeuedCount }`,
 *   the whole event's failed images only.
 *
 * ## Contract expected of the implementation
 *
 * - The four route modules above export the handlers named below. The event id
 *   sits **two** segments from the end on `…/images` and `…/images:reprocess-failed`,
 *   **three** on `…/images/{imageId}`, and **four** on
 *   `…/images/{imageId}/reprocess`, so the nested tenant routes hand
 *   `tenantStage` the matching `eventActorAdmission(2|3|4)`.
 * - `409 not_failed` is a **new** media error code the GREEN owes the
 *   append-only `MEDIA_ERROR_CODES` union and `MEDIA_ERROR_TRANSPORT`
 *   (`409`, non-retryable), exactly as OP-123/OP-124/OP-125 appended theirs.
 * - The list item is the §4.4 shape and **only** that shape: `id`, `sequence`,
 *   `thumbnailUrl`, `thumbnailUrlExpiresAt`, `width`, `height`, `orientation`,
 *   `bytes`, `contentType`, `faceCount`, `visibility`, `processing`
 *   (`{status, attempts, finishedAt, durationMs, lastError}`),
 *   `uploadedByUserId`, `uploadBatchId`, `createdAt`. No `assetId`, no
 *   `objectKey`/`locationKey`/`bucket`/`_id` (§0.15).
 * - `processing` is the durable pipeline state (§18.2): a reprocess resets
 *   `status: "queued"`, `attempts: 0`, clears `lastError`/`finishedAt`/`durationMs`
 *   and re-enqueues the work item, which writes the new `processing.queueRef`.
 * - Thumbnails are signed with the §5.6 scheme on the `thumbnail` derivative
 *   (`/t/<contentHash>.<ext>`), never a bare storage URL.
 *
 * ## Assumptions (ADR-0762)
 *
 * - A1 — `summary` mixes the event's cached counters (`total`, `done`, `failed`,
 *   `approximate: true`) with a status tally for the two in-flight buckets; the
 *   only invariant pinned is `total === done + failed + queued + processing`.
 * - A2 — the organizer-only gate is `organizer`/`co_organizer` (§4.4), so an
 *   active workspace member who is not an event organizer reads the grid (`200`)
 *   but is refused the two mutations (`403`).
 * - A3 — the delete releases `storage.bytes` through the shared entitlement
 *   service (§0.14 C6), so the tenant's `usageCounters` row must already exist
 *   (`releaseCounter` never upserts) and is clamped at zero.
 * - A4 — deleting an image removes its `faceMatches` rows (the gallery reads
 *   matches, so this is what "removed from matched attendees' galleries" means)
 *   and decrements each profile's cached `matchCount` by the number of rows
 *   removed. The event's `counters.matchCount` is left to the nightly
 *   reconcile and is **not** pinned here.
 * - A5 — hiding writes **only** `event_images.visibility` (no `faceMatches`
 *   write), because hide is reversible and the attendee gallery joins the image
 *   and filters on `visibility` (OP-133 §2). The signed-URL gate (§5.6, OP-128)
 *   must apply the same predicate; that endpoint does not exist yet, so this
 *   suite pins the **state** it must read — `visibility: "hidden"`,
 *   `deletedAt: null`.
 * - A6 — `POST …/images/{imageId}/reprocess` answers `202` with the updated
 *   image DTO (`id` + the reset `processing`); the bulk route answers the
 *   contract's exact `{ requeuedCount }`.
 */

/** The plan keys a delete/reprocess case seeds. */
const STORAGE_KEY = "storage.bytes";
const IMAGES_KEY = "images.per_event";

/** A storage limit that no case reaches, so a refusal never masks a counter pin. */
const ROOMY_STORAGE_LIMIT = 10_000_000_000;

/** The plan key and period the delete case's counter row lives under. */
const PLAN_KEY = "op127-roomy";
const MONTHLY_PERIOD_KEY = periodKey("monthly", new Date());

/** Deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op127-${name}`).digest("hex");
}

const HASH_LIST_ONE = hashFor("list-one");
const HASH_LIST_TWO = hashFor("list-two");
const HASH_LIST_THREE = hashFor("list-three");
const HASH_SCAN = hashFor("scan");
const HASH_HIDDEN = hashFor("hidden");
const HASH_DELETE = hashFor("delete");
const HASH_GALLERY = hashFor("gallery");
const HASH_OTHER_IMAGE = hashFor("other-image");
const HASH_REPROCESS_DONE = hashFor("reprocess-done");
const HASH_REPROCESS_FAILED = hashFor("reprocess-failed");
const HASH_BULK_FAILED_ONE = hashFor("bulk-failed-one");
const HASH_BULK_FAILED_TWO = hashFor("bulk-failed-two");
const HASH_BULK_DONE = hashFor("bulk-done");
const HASH_BULK_QUEUED = hashFor("bulk-queued");
const HASH_BULK_OTHER_EVENT = hashFor("bulk-other-event");
const HASH_UPLOADER_ONE = hashFor("uploader-one");
const HASH_UPLOADER_TWO = hashFor("uploader-two");
const HASH_SHARED_ASSET = hashFor("shared-asset");
const HASH_REPEAT_DELETE = hashFor("repeat-delete");
const HASH_FILTER_DONE = hashFor("filter-done");
const HASH_FILTER_FAILED = hashFor("filter-failed");
const HASH_FILTER_HIDDEN = hashFor("filter-hidden");

/** The stored originals' byte count and the thumbnail derivative's. */
const ORIGINAL_BYTES = 8_421_310;
const THUMBNAIL_BYTES = 41_200;

/** The thumbnail derivative's format, and the TTL the contract gives a thumbnail. */
const THUMBNAIL_FORMAT = "webp";
const THUMBNAIL_TTL_SECONDS = 24 * 60 * 60;

/** The asset dimensions the grid uses to reserve aspect ratio (§4.4, schema §25). */
const IMAGE_WIDTH = 4000;
const IMAGE_HEIGHT = 6000;
const IMAGE_ORIENTATION = 6;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op127-images", env: { QUEUE_PROVIDER: "memory" } });
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
    COLLECTIONS.uploadSessions,
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
  // The memory queue is a process-wide singleton: drain anything a prior case
  // left so "nothing was re-queued" is a statement about this case only.
  await getWorkQueue().claim("q:image", 500);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read one route export off a namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "PATCH" | "DELETE" | "POST",
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const listImages = requireHandler(imagesRouteModule, "GET", "…/events/:eventId/images");
const patchImage = requireHandler(imageRouteModule, "PATCH", "…/events/:eventId/images/:imageId");
const deleteImage = requireHandler(imageRouteModule, "DELETE", "…/events/:eventId/images/:imageId");
const reprocessImage = requireHandler(
  reprocessRouteModule,
  "POST",
  "…/events/:eventId/images/:imageId/reprocess"
);
const reprocessFailed = requireHandler(
  reprocessFailedRouteModule,
  "POST",
  "…/events/:eventId/images:reprocess-failed"
);

/** The error envelope of a failed response. */
interface ErrorBody {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** Parse an error envelope without reading the body twice. */
async function errorOf(response: Response): Promise<ErrorBody> {
  const parsed = await body(response);
  return parsed.error as ErrorBody;
}

/** One item of the §4.4 list answer. */
interface ImageListItem {
  readonly id: string;
  readonly sequence: number;
  readonly thumbnailUrl: string | null;
  readonly thumbnailUrlExpiresAt: string | null;
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
  readonly bytes: number;
  readonly contentType: string;
  readonly faceCount: number;
  readonly visibility: string;
  readonly processing: {
    readonly status: string;
    readonly attempts: number;
    readonly finishedAt: string | null;
    readonly durationMs: number | null;
    readonly lastError: unknown;
  };
  readonly uploadedByUserId: string;
  readonly uploadBatchId: string;
  readonly createdAt: string;
}

/** The §4.4 list answer. */
interface ImageListAnswer {
  readonly data: readonly ImageListItem[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly limit: number;
  };
  readonly summary: {
    readonly total: number;
    readonly done: number;
    readonly queued: number;
    readonly processing: number;
    readonly failed: number;
    readonly approximate: boolean;
  };
}

/** The `event_images` fields these pins read (schema §16.3). */
interface EventImageRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly assetId: ObjectId;
  readonly uploadedByUserId: ObjectId;
  readonly sequence: number;
  readonly visibility: string;
  readonly faceCount: number;
  readonly deletedAt?: Date | null;
  readonly processing: {
    readonly status?: string;
    readonly attempts?: number;
    readonly lastError?: unknown;
    readonly finishedAt?: Date | null;
    readonly durationMs?: number | null;
    readonly queueRef?: { readonly messageId?: string } | null;
  };
}

/** A `media_assets` row the list reads (§16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly refCount: number;
  readonly status: string;
}

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP127 Studio",
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

/** Add an active workspace member who is not an event organizer. */
async function addTenantMember(tenantId: ObjectId, user: SignedInUser): Promise<void> {
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role: "member",
    status: "active",
    joinedAt: new Date(),
  });
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
        slug: `op127${_id.toHexString().slice(-8)}`,
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
async function seedWorkspace(
  prefix: string,
  eventOverrides: Record<string, unknown> = {}
): Promise<Workspace> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = await insertTenant(`op127-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId, eventOverrides);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Insert a stored `media_assets` row with its thumbnail derivative (§16.1). */
async function seedAsset(
  tenantKey: string,
  contentHash: string,
  overrides: Record<string, unknown> = {}
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
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      orientation: IMAGE_ORIENTATION,
      exifCaptureAt: new Date("2026-09-20T11:00:00.000Z"),
      cameraMake: "SONY",
      cameraModel: "ILCE-7M4",
    },
    status: "derivatives_ready",
    refCount: 1,
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
    ...overrides,
  });
  return _id;
}

/** The `event_images` row one upload or link creates (§16.3). */
interface SeedImageOptions {
  readonly sequence: number;
  readonly status?: string;
  readonly attempts?: number;
  readonly visibility?: string;
  readonly uploadedByUserId?: ObjectId;
  readonly deletedAt?: Date | null;
  readonly lastError?: unknown;
  readonly faceCount?: number;
  readonly uploadBatchId?: ObjectId | string;
  readonly createdAt?: Date;
}

/** Insert one `event_images` join row. */
async function seedImage(
  tenantKey: string,
  eventId: ObjectId,
  assetId: ObjectId,
  options: SeedImageOptions
): Promise<ObjectId> {
  const _id = new ObjectId();
  const createdAt = options.createdAt ?? new Date("2026-09-25T09:18:00.000Z");
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: tenantKey,
    eventId,
    assetId,
    uploadedByUserId: options.uploadedByUserId ?? new ObjectId(),
    uploadBatchId: options.uploadBatchId ?? new ObjectId(),
    sequence: options.sequence,
    processing: {
      status: options.status ?? "done",
      priority: "normal",
      attempts: options.attempts ?? 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
      durationMs: 3400,
      lastError: options.lastError ?? null,
      queueRef: null,
    },
    faceCount: options.faceCount ?? 0,
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
  options: SeedImageOptions,
  assetOverrides: Record<string, unknown> = {}
): Promise<{ readonly assetId: ObjectId; readonly imageId: ObjectId }> {
  const assetId = await seedAsset(tenantKey, contentHash, assetOverrides);
  const imageId = await seedImage(tenantKey, eventId, assetId, options);
  return { assetId, imageId };
}

/** Insert an `attendee_event_profiles` row (schema §15.3). */
async function seedProfile(
  tenantKey: string,
  eventId: ObjectId,
  matchCount: number
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id,
    tenantId: tenantKey,
    eventId,
    subject: { kind: "user", userId: new ObjectId() },
    status: "ready",
    matchCount,
    lastMatchRunAt: new Date("2026-09-25T09:10:00.000Z"),
    lastSeenGalleryAt: null,
    createdAt: new Date("2026-09-25T08:30:00.000Z"),
    updatedAt: new Date("2026-09-25T09:10:00.000Z"),
  });
  return _id;
}

/** Insert one `face_matches` row for a profile and an image (§17.5). */
async function seedMatch(
  tenantKey: string,
  eventId: ObjectId,
  profileId: ObjectId,
  imageId: ObjectId,
  faceIndex: number
): Promise<void> {
  await app.db.collection(COLLECTIONS.faceMatches).insertOne({
    tenantId: tenantKey,
    eventId,
    profileId,
    subject: { kind: "user", userId: new ObjectId() },
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

/** The roomy plan a delete case seeds, so no limit can mask a counter pin. */
async function seedRoomyPlan(tenantKey: string): Promise<void> {
  await seedPlanFor(tenantKey, PLAN_KEY, {
    [STORAGE_KEY]: makeEntitlement({
      limit: ROOMY_STORAGE_LIMIT,
      scope: "tenant",
      resetPeriod: "monthly",
    }),
    [IMAGES_KEY]: makeEntitlement({ limit: 5_000, scope: "event", resetPeriod: "none" }),
  });
}

/** Insert the tenant's `storage.bytes` meter row a release decrements. */
async function seedStorageMeter(tenantKey: string, value: number): Promise<void> {
  await app.db.collection(COLLECTIONS.usageCounters).insertOne(
    makeUsageCounter({
      tenantId: tenantKey,
      entitlementKey: STORAGE_KEY,
      periodKey: MONTHLY_PERIOD_KEY,
      value,
    })
  );
}

/** The tenant's `storage.bytes` meter value, or `0` when it has no row. */
async function readStorageMeter(tenantKey: string): Promise<number> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: tenantKey, entitlementKey: STORAGE_KEY });
  if (row === null) {
    return 0;
  }
  const value: unknown = row.value;
  return typeof value === "number" ? value : 0;
}

/** Read the event row's counters. */
async function readCounters(eventId: ObjectId): Promise<Record<string, number>> {
  const row = (await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId })) as
    (Document & { readonly counters?: Record<string, number> }) | null;
  if (row === null) {
    throw new Error("expected the seeded event to exist");
  }
  return row.counters ?? {};
}

/** Overwrite the event's counters, so a list's summary source is stated per case. */
async function setCounters(eventId: ObjectId, counters: Record<string, number>): Promise<void> {
  await app.db.collection(COLLECTIONS.events).updateOne({ _id: eventId }, { $set: { counters } });
}

/** Read one `event_images` row. */
async function readImage(imageId: ObjectId): Promise<EventImageRow | null> {
  return (await app.db
    .collection(COLLECTIONS.eventImages)
    .findOne({ _id: imageId })) as EventImageRow | null;
}

/** Read one `media_assets` row. */
async function readAsset(assetId: ObjectId): Promise<AssetRow | null> {
  return (await app.db
    .collection(COLLECTIONS.mediaAssets)
    .findOne({ _id: assetId })) as AssetRow | null;
}

/**
 * The whole stored `media_assets` row, for the fields a delete must never touch.
 *
 * `readAsset` reads only what the listing needs; a shared-asset delete has to be
 * proven to leave `storage` and `derivatives` byte-identical (OP-127 R2).
 */
interface StoredAssetRow {
  readonly _id: ObjectId;
  readonly refCount: number;
  readonly status: string;
  readonly storage: Record<string, unknown>;
  readonly derivatives: Record<string, unknown>;
}

/** Read the whole stored asset document (§16.1). */
async function readStoredAsset(assetId: ObjectId): Promise<StoredAssetRow | null> {
  return (await app.db
    .collection(COLLECTIONS.mediaAssets)
    .findOne({ _id: assetId })) as StoredAssetRow | null;
}

/** Read one profile's cached `matchCount`. */
async function readMatchCount(profileId: ObjectId): Promise<number> {
  const row = await app.db
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ _id: profileId });
  if (row === null) {
    throw new Error("expected the seeded profile to exist");
  }
  const value: unknown = row.matchCount;
  return typeof value === "number" ? value : 0;
}

/** The image ids the attendee-facing reads (`visibility` + not deleted) select. */
async function deliverableImageIds(eventId: ObjectId): Promise<string[]> {
  const rows = await app.db
    .collection(COLLECTIONS.eventImages)
    .find({ eventId, visibility: "visible", deletedAt: null })
    .toArray();
  return rows.map((row) => String(row._id)).sort((left, right) => left.localeCompare(right));
}

/** The envelopes currently sitting on the image queue, claimed for inspection. */
async function queuedEnvelopes(): Promise<readonly Record<string, unknown>[]> {
  const claimed = await getWorkQueue().claim("q:image", 500);
  return claimed.map((message) => message.envelope as unknown as Record<string, unknown>);
}

/** The §5.6 signer the list's thumbnail URLs are verified with. */
function mediaSigner(): ReturnType<typeof createMediaSigner> {
  return createMediaSigner({ currentSecret: getConfig().media.signingSecretCurrent });
}

/** The list path for one event. */
function imagesPath(workspace: Workspace): string {
  return `/api/v1/tenants/${workspace.tenantKey}/events/${workspace.eventId.toHexString()}/images`;
}

/** The single-image path for one image. */
function imagePath(workspace: Workspace, imageId: string): string {
  return `${imagesPath(workspace)}/${imageId}`;
}

/** The single-image reprocess path. */
function reprocessPath(workspace: Workspace, imageId: string): string {
  return `${imagePath(workspace, imageId)}/reprocess`;
}

/** The bulk reprocess path. */
function reprocessFailedPath(workspace: Workspace): string {
  return `${imagesPath(workspace)}:reprocess-failed`;
}

/** A `GET` carrying the caller's session cookie. */
function getRequest(path: string, cookie: string): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "GET", headers: { cookie } });
}

/** A JSON `PATCH` carrying the caller's session cookie. */
function patchRequest(path: string, cookie: string, payload: unknown): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** A `DELETE` carrying the caller's session cookie. */
function deleteRequest(path: string, cookie: string): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "DELETE", headers: { cookie } });
}

/** A `POST` with no body, carrying the caller's session cookie. */
function postRequest(path: string, cookie: string): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "POST", headers: { cookie } });
}

/** The §4.4 item's keys, exactly — an extra key is a leaked internal (§0.15). */
const ITEM_KEYS = [
  "bytes",
  "contentType",
  "createdAt",
  "faceCount",
  "height",
  "id",
  "orientation",
  "processing",
  "sequence",
  "thumbnailUrl",
  "thumbnailUrlExpiresAt",
  "uploadBatchId",
  "uploadedByUserId",
  "visibility",
  "width",
];

/** The §4.4 `processing` keys, exactly (§18.2's client-visible subset). */
const PROCESSING_KEYS = ["attempts", "durationMs", "finishedAt", "lastError", "status"];

describe("GET …/images — the organizer's grid (I1, I5)", () => {
  it("I1: pages the event's images newest-first by sequence with signed thumbnails and a summary", async () => {
    // Arrange — three finished images (2 done, 1 failed) whose counters agree.
    const workspace = await seedWorkspace("op127-list");
    const older = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_LIST_ONE, {
      sequence: 1,
      status: "failed",
      faceCount: 0,
      uploadedByUserId: workspace.organizer.userId,
    });
    const middle = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_LIST_TWO, {
      sequence: 2,
      status: "done",
      faceCount: 2,
      uploadedByUserId: workspace.organizer.userId,
    });
    const newest = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_LIST_THREE,
      {
        sequence: 3,
        status: "done",
        faceCount: 3,
        uploadedByUserId: workspace.organizer.userId,
      }
    );
    await setCounters(workspace.eventId, {
      imageCount: 3,
      processedImageCount: 2,
      failedImageCount: 1,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES * 3,
    });

    // Act — the first page, then the page the cursor names.
    const before = Date.now();
    const first = await listImages(
      getRequest(`${imagesPath(workspace)}?limit=2`, workspace.organizer.cookie)
    );
    const after = Date.now();
    const firstAnswer = (await body(first)) as unknown as ImageListAnswer;
    const second = await listImages(
      getRequest(
        `${imagesPath(workspace)}?limit=2&cursor=${encodeURIComponent(String(firstAnswer.page.nextCursor))}`,
        workspace.organizer.cookie
      )
    );
    const secondAnswer = (await body(second)) as unknown as ImageListAnswer;

    // Assert — the §4.4 envelope and ordering.
    expect(first.status).toBe(200);
    expect(Object.keys(firstAnswer).sort()).toEqual(["data", "page", "summary"]);
    expect(firstAnswer.page).toEqual({
      nextCursor: expect.any(String),
      hasMore: true,
      limit: 2,
    });
    expect(firstAnswer.data.map((item) => item.sequence)).toEqual([3, 2]);
    expect(firstAnswer.data.map((item) => item.id)).toEqual([
      newest.imageId.toHexString(),
      middle.imageId.toHexString(),
    ]);
    expect(second.status).toBe(200);
    expect(secondAnswer.data.map((item) => item.sequence)).toEqual([1]);
    expect(secondAnswer.data[0]?.id).toBe(older.imageId.toHexString());
    expect(secondAnswer.page).toEqual({ nextCursor: null, hasMore: false, limit: 2 });

    // The item is the §4.4 projection and nothing else (§0.15).
    const item = firstAnswer.data[0];
    if (item === undefined) {
      throw new Error("expected the first page to carry one item");
    }
    expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(Object.keys(item.processing).sort()).toEqual(PROCESSING_KEYS);
    expect(item.bytes).toBe(ORIGINAL_BYTES);
    expect(item.contentType).toBe("image/jpeg");
    expect(item.faceCount).toBe(3);
    expect(item.visibility).toBe("visible");
    expect(item.width).toBe(IMAGE_WIDTH);
    expect(item.height).toBe(IMAGE_HEIGHT);
    expect(item.orientation).toBe(IMAGE_ORIENTATION);
    expect(item.processing.status).toBe("done");
    expect(item.processing.attempts).toBe(1);
    expect(item.uploadedByUserId).toBe(workspace.organizer.userId.toHexString());

    // The thumbnail is a §5.6-signed `t` derivative with a 24 h life.
    if (item.thumbnailUrl === null || item.thumbnailUrlExpiresAt === null) {
      throw new Error("expected a signed thumbnail for a derivatives_ready asset");
    }
    const thumbnail = new URL(item.thumbnailUrl);
    expect(thumbnail.origin).toBe("https://pic.openpic.in");
    expect(thumbnail.pathname).toBe(`/t/${HASH_LIST_THREE}.${THUMBNAIL_FORMAT}`);
    expect(mediaSigner().verify(item.thumbnailUrl)).toBe(true);
    expect(item.thumbnailUrlExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The signer floors `exp` to whole seconds, so the lower bound is one
    // second inside the requested TTL rather than exactly at it.
    const expiresAtMs = Date.parse(item.thumbnailUrlExpiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + (THUMBNAIL_TTL_SECONDS - 1) * 1_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + THUMBNAIL_TTL_SECONDS * 1_000);

    // The summary is the documented §4.4 shape: cached counters, marked approximate.
    expect(Object.keys(firstAnswer.summary).sort()).toEqual([
      "approximate",
      "done",
      "failed",
      "processing",
      "queued",
      "total",
    ]);
    expect(firstAnswer.summary).toMatchObject({ total: 3, done: 2, failed: 1, approximate: true });
    expect(firstAnswer.summary.total).toBe(
      firstAnswer.summary.done +
        firstAnswer.summary.failed +
        firstAnswer.summary.queued +
        firstAnswer.summary.processing
    );
  });

  it("I1: an image whose thumbnail has not been generated yet is listed with null thumbnail fields", async () => {
    // Arrange — a queued upload: the asset exists, the derivative does not.
    const workspace = await seedWorkspace("op127-no-derivative");
    const pending = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_LIST_ONE,
      { sequence: 1, status: "queued", attempts: 0, uploadedByUserId: workspace.organizer.userId },
      { derivatives: {}, imageMeta: {}, status: "stored" }
    );
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });

    // Act — the grid must still reserve the grid cell for a just-uploaded file.
    const response = await listImages(
      getRequest(imagesPath(workspace), workspace.organizer.cookie)
    );
    const answer = (await body(response)) as unknown as ImageListAnswer;

    // Assert
    expect(response.status).toBe(200);
    expect(answer.data.map((item) => item.id)).toEqual([pending.imageId.toHexString()]);
    const item = answer.data[0];
    if (item === undefined) {
      throw new Error("expected the pending image to be listed");
    }
    expect(item.thumbnailUrl).toBeNull();
    expect(item.thumbnailUrlExpiresAt).toBeNull();
    expect(item.processing.status).toBe("queued");
  });

  it("I5: the list body passes the never-return scanner and names no storage coordinate", async () => {
    // Arrange — the seeded object key and location must not reach the wire.
    const workspace = await seedWorkspace("op127-scan");
    await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_SCAN, {
      sequence: 1,
      status: "done",
      faceCount: 1,
      uploadedByUserId: workspace.organizer.userId,
    });
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });

    // Act
    const response = await listImages(
      getRequest(imagesPath(workspace), workspace.organizer.cookie)
    );
    const answer = (await body(response)) as unknown as ImageListAnswer;
    const serialized = JSON.stringify(answer);
    const item = answer.data[0];

    // Assert — CONVENTIONS §8.1 / contract §0.15.
    expect(response.status).toBe(200);
    if (item === undefined) {
      throw new Error("expected the seeded image to be listed");
    }
    expect(findForbiddenFields(answer, "default")).toEqual([]);
    // The only delivery coordinate a client receives is a signed data-plane URL.
    expect(item.thumbnailUrl).toMatch(
      /^https:\/\/pic\.openpic\.in\/t\/[0-9a-f]{64}\.webp\?exp=\d+&sig=[A-Za-z0-9_-]+$/
    );
    expect(serialized).not.toContain(`images/${HASH_SCAN}.jpg`);
    expect(serialized).not.toContain("thumbnails/");
    expect(serialized).not.toContain("contentHash");
    expect(serialized).not.toContain("refCount");
  });
});

describe("PATCH …/images/{imageId} — hiding is not deletion (I7)", () => {
  it("I7: a hidden image leaves the attendee gallery and the signed-URL set without losing its matches", async () => {
    // Arrange — one visible image matched to one attendee twice.
    const workspace = await seedWorkspace("op127-hidden");
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_HIDDEN, {
      sequence: 1,
      status: "done",
      faceCount: 2,
      uploadedByUserId: workspace.organizer.userId,
    });
    const profileId = await seedProfile(workspace.tenantKey, workspace.eventId, 2);
    await seedMatch(workspace.tenantKey, workspace.eventId, profileId, image.imageId, 0);
    await seedMatch(workspace.tenantKey, workspace.eventId, profileId, image.imageId, 1);
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 1,
      matchCount: 2,
      storageBytes: ORIGINAL_BYTES,
    });

    // Act
    const response = await patchImage(
      patchRequest(imagePath(workspace, image.imageId.toHexString()), workspace.organizer.cookie, {
        visibility: "hidden",
      })
    );
    const answer = (await body(response)) as unknown as ImageListItem;

    // Assert — the organizer's answer still names the image, now hidden.
    expect(response.status).toBe(200);
    expect(answer.id).toBe(image.imageId.toHexString());
    expect(answer.visibility).toBe("hidden");
    expect(findForbiddenFields(answer, "default")).toEqual([]);

    // The row survives: hide is a visibility flag, never a delete.
    const row = await readImage(image.imageId);
    expect(row?.visibility).toBe("hidden");
    expect(row?.deletedAt ?? null).toBeNull();
    expect(row?.sequence).toBe(1);

    // The attendee-facing set (gallery join and signed-URL gate) excludes it…
    expect(await deliverableImageIds(workspace.eventId)).toEqual([]);
    // …while the organizer can still find it by asking for hidden images.
    const hiddenPage = await listImages(
      getRequest(`${imagesPath(workspace)}?visibility=hidden`, workspace.organizer.cookie)
    );
    const hiddenAnswer = (await body(hiddenPage)) as unknown as ImageListAnswer;
    expect(hiddenAnswer.data.map((item) => item.id)).toEqual([image.imageId.toHexString()]);

    // Hiding writes no match state and moves no cached count.
    const matches = await app.db
      .collection(COLLECTIONS.faceMatches)
      .find({ imageId: image.imageId })
      .toArray();
    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.hiddenAt ?? null)).toEqual([null, null]);
    expect(await readMatchCount(profileId)).toBe(2);

    // Unhiding restores delivery without a re-match.
    const restored = await patchImage(
      patchRequest(imagePath(workspace, image.imageId.toHexString()), workspace.organizer.cookie, {
        visibility: "visible",
      })
    );
    expect(restored.status).toBe(200);
    expect(await deliverableImageIds(workspace.eventId)).toEqual([image.imageId.toHexString()]);
  });
});

describe("DELETE …/images/{imageId} (I3, I6)", () => {
  it("I3: delete soft-deletes the image, drops refCount to zero and returns the storage it held", async () => {
    // Arrange — a tenant at one stored image, with the meter a release decrements.
    const workspace = await seedWorkspace("op127-delete");
    await seedRoomyPlan(workspace.tenantKey);
    await seedStorageMeter(workspace.tenantKey, ORIGINAL_BYTES);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_DELETE, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });

    // Act
    const response = await deleteImage(
      deleteRequest(imagePath(workspace, image.imageId.toHexString()), workspace.organizer.cookie)
    );

    // Assert — `204` and no body.
    expect(response.status).toBe(204);
    expect((await response.arrayBuffer()).byteLength).toBe(0);

    // The join row is soft-deleted, not removed.
    const row = await readImage(image.imageId);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(
      await app.db.collection(COLLECTIONS.eventImages).countDocuments({ _id: image.imageId })
    ).toBe(1);

    // The asset stays for the purge job, with no live reference left.
    const asset = await readAsset(image.assetId);
    expect(asset?.refCount).toBe(0);
    expect(asset?.status).toBe("derivatives_ready");

    // Both documented counters follow the image out (`processedImageCount` and
    // `failedImageCount` are the nightly counter-reconcile's, ADR-0762 A4).
    const counters = await readCounters(workspace.eventId);
    expect(counters.imageCount).toBe(0);
    expect(counters.storageBytes).toBe(0);
    expect(await readStorageMeter(workspace.tenantKey)).toBe(0);

    // The grid no longer lists it.
    const page = await listImages(getRequest(imagesPath(workspace), workspace.organizer.cookie));
    const answer = (await body(page)) as unknown as ImageListAnswer;
    expect(answer.data).toEqual([]);
  });

  it("I6: delete removes the image from matched attendees' galleries and decrements matchCount", async () => {
    // Arrange — two profiles match this image (2 faces and 1 face); the first
    // also matched a second, surviving image, so only its delta is observable.
    const workspace = await seedWorkspace("op127-gallery");
    const doomed = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_GALLERY, {
      sequence: 1,
      status: "done",
      faceCount: 2,
      uploadedByUserId: workspace.organizer.userId,
    });
    const surviving = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_OTHER_IMAGE,
      { sequence: 2, status: "done", faceCount: 1, uploadedByUserId: workspace.organizer.userId }
    );
    const twiceMatched = await seedProfile(workspace.tenantKey, workspace.eventId, 3);
    const onceMatched = await seedProfile(workspace.tenantKey, workspace.eventId, 1);
    await seedMatch(workspace.tenantKey, workspace.eventId, twiceMatched, doomed.imageId, 0);
    await seedMatch(workspace.tenantKey, workspace.eventId, twiceMatched, doomed.imageId, 1);
    await seedMatch(workspace.tenantKey, workspace.eventId, twiceMatched, surviving.imageId, 0);
    await seedMatch(workspace.tenantKey, workspace.eventId, onceMatched, doomed.imageId, 0);
    await setCounters(workspace.eventId, {
      imageCount: 2,
      processedImageCount: 2,
      failedImageCount: 0,
      attendeeCount: 2,
      matchCount: 4,
      storageBytes: ORIGINAL_BYTES * 2,
    });

    // Act
    const response = await deleteImage(
      deleteRequest(imagePath(workspace, doomed.imageId.toHexString()), workspace.organizer.cookie)
    );

    // Assert
    expect(response.status).toBe(204);
    expect(
      await app.db.collection(COLLECTIONS.faceMatches).countDocuments({ imageId: doomed.imageId })
    ).toBe(0);
    expect(
      await app.db
        .collection(COLLECTIONS.faceMatches)
        .countDocuments({ imageId: surviving.imageId })
    ).toBe(1);

    // The cached totals follow the rows that left, per profile.
    expect(await readMatchCount(twiceMatched)).toBe(1);
    expect(await readMatchCount(onceMatched)).toBe(0);
  });
});

describe("POST …/images/{imageId}/reprocess (I2)", () => {
  it("I2: a done image is refused 409 not_failed and nothing is re-queued", async () => {
    // Arrange
    const workspace = await seedWorkspace("op127-reprocess-done");
    const image = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_REPROCESS_DONE,
      { sequence: 1, status: "done", attempts: 1, uploadedByUserId: workspace.organizer.userId }
    );

    // Act
    const response = await reprocessImage(
      postRequest(reprocessPath(workspace, image.imageId.toHexString()), workspace.organizer.cookie)
    );

    // Assert — only a failed image is reprocessable, so a done one is a conflict.
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("not_failed");
    const row = await readImage(image.imageId);
    expect(row?.processing.status).toBe("done");
    expect(row?.processing.attempts).toBe(1);
    expect(await queuedEnvelopes()).toEqual([]);
  });

  it("I2: a failed image goes back to queued with a zeroed attempt count and is re-enqueued", async () => {
    // Arrange — a third attempt that failed after a partial run.
    const workspace = await seedWorkspace("op127-reprocess-failed");
    const image = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_REPROCESS_FAILED,
      {
        sequence: 1,
        status: "failed",
        attempts: 3,
        uploadedByUserId: workspace.organizer.userId,
        lastError: {
          code: "no_face_detected",
          message: "No face found in the image.",
          at: new Date("2026-09-25T09:20:00.000Z"),
          retryable: true,
        },
      }
    );

    // Act
    const response = await reprocessImage(
      postRequest(reprocessPath(workspace, image.imageId.toHexString()), workspace.organizer.cookie)
    );
    const answer = (await body(response)) as unknown as ImageListItem;

    // Assert — `202` with the reset image, scanner clean.
    expect(response.status).toBe(202);
    expect(findForbiddenFields(answer, "default")).toEqual([]);
    expect(answer.id).toBe(image.imageId.toHexString());
    expect(answer.processing.status).toBe("queued");
    expect(answer.processing.attempts).toBe(0);
    expect(answer.processing.lastError).toBeNull();

    // The durable state is reset and the enqueue wrote its pointer back.
    const row = await readImage(image.imageId);
    expect(row?.processing.status).toBe("queued");
    expect(row?.processing.attempts).toBe(0);
    expect(row?.processing.lastError).toBeNull();
    expect(row?.processing.finishedAt ?? null).toBeNull();
    expect(row?.processing.durationMs ?? null).toBeNull();
    expect(typeof row?.processing.queueRef?.messageId).toBe("string");

    // Exactly one work item for exactly this image.
    const envelopes = await queuedEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      kind: "event_image",
      id: image.imageId.toHexString(),
      eventId: workspace.eventId.toHexString(),
    });
  });
});

describe("POST …/images:reprocess-failed (I4)", () => {
  it("I4: only the event's failed images are re-queued", async () => {
    // Arrange — two failed, one done (with its attempts spent) and one queued
    // in this event, plus a failed image of another event of the same tenant.
    const workspace = await seedWorkspace("op127-bulk");
    const otherEventId = await seedEvent(workspace.tenantKey, workspace.organizer.userId, {
      name: "Another Wedding",
    });
    const failedOne = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_BULK_FAILED_ONE,
      { sequence: 1, status: "failed", attempts: 2, uploadedByUserId: workspace.organizer.userId }
    );
    const failedTwo = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_BULK_FAILED_TWO,
      { sequence: 2, status: "failed", attempts: 1, uploadedByUserId: workspace.organizer.userId }
    );
    const done = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_BULK_DONE, {
      sequence: 3,
      status: "done",
      attempts: 1,
      uploadedByUserId: workspace.organizer.userId,
    });
    const queued = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_BULK_QUEUED,
      { sequence: 4, status: "queued", attempts: 4, uploadedByUserId: workspace.organizer.userId }
    );
    const foreign = await seedImageWithAsset(
      workspace.tenantKey,
      otherEventId,
      HASH_BULK_OTHER_EVENT,
      { sequence: 1, status: "failed", attempts: 2, uploadedByUserId: workspace.organizer.userId }
    );

    // Act
    const response = await reprocessFailed(
      postRequest(reprocessFailedPath(workspace), workspace.organizer.cookie)
    );
    const answer = (await body(response)) as unknown as { readonly requeuedCount: number };

    // Assert — the contract's exact answer.
    expect(response.status).toBe(202);
    expect(answer).toEqual({ requeuedCount: 2 });

    // Both failures were reset…
    expect((await readImage(failedOne.imageId))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
    });
    expect((await readImage(failedTwo.imageId))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
    });

    // …and nothing else was touched, in this event or the next.
    expect((await readImage(done.imageId))?.processing).toMatchObject({
      status: "done",
      attempts: 1,
    });
    expect((await readImage(queued.imageId))?.processing).toMatchObject({
      status: "queued",
      attempts: 4,
    });
    expect((await readImage(foreign.imageId))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });

    // One work item per requeued image, and no third.
    const envelopes = await queuedEnvelopes();
    expect(envelopes.map((envelope) => envelope.id).sort()).toEqual(
      [failedOne.imageId.toHexString(), failedTwo.imageId.toHexString()].sort()
    );
  });
});

describe("the image surface's admission ladder (X1–X3)", () => {
  /** The five handlers with a request builder, so one table pins the whole surface. */
  const ROUTES: readonly {
    readonly name: string;
    readonly handler: (request: Request) => Promise<Response>;
    readonly request: (workspace: Workspace) => Request;
    readonly organizerOnly: boolean;
  }[] = [
    {
      name: "list",
      handler: listImages,
      request: (workspace) => getRequest(imagesPath(workspace), workspace.organizer.cookie),
      organizerOnly: false,
    },
    {
      name: "patch visibility",
      handler: patchImage,
      request: (workspace) =>
        patchRequest(
          imagePath(workspace, new ObjectId().toHexString()),
          workspace.organizer.cookie,
          {
            visibility: "hidden",
          }
        ),
      organizerOnly: true,
    },
    {
      name: "delete",
      handler: deleteImage,
      request: (workspace) =>
        deleteRequest(
          imagePath(workspace, new ObjectId().toHexString()),
          workspace.organizer.cookie
        ),
      organizerOnly: true,
    },
    {
      name: "reprocess",
      handler: reprocessImage,
      request: (workspace) =>
        postRequest(
          reprocessPath(workspace, new ObjectId().toHexString()),
          workspace.organizer.cookie
        ),
      organizerOnly: false,
    },
    {
      name: "reprocess failed",
      handler: reprocessFailed,
      request: (workspace) =>
        postRequest(reprocessFailedPath(workspace), workspace.organizer.cookie),
      organizerOnly: false,
    },
  ];

  it.each(ROUTES)("$name answers 401 authentication_required without a session", async (route) => {
    // Arrange — ids need not exist: the auth stage denies before tenancy.
    const anonymous: Workspace = {
      organizer: { cookie: "", userId: new ObjectId(), identity: makeIdentity("op127-anon") },
      tenantId: new ObjectId(),
      tenantKey: new ObjectId().toHexString(),
      eventId: new ObjectId(),
    };

    // Act
    const response = await route.handler(route.request(anonymous));

    // Assert
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });

  it.each(ROUTES)("$name answers 404 to a caller with no relationship", async (route) => {
    // Arrange — the event exists in a workspace the caller does not belong to.
    const workspace = await seedWorkspace(`op127-outsider-${route.name.replace(" ", "-")}`);
    const outsider = await app.signIn(makeIdentity("op127-outsider"));

    // Act
    const response = await route.handler(route.request({ ...workspace, organizer: outsider }));

    // Assert — never an existence oracle (§0.4).
    expect(response.status).toBe(404);
  });

  it("X3: an active workspace member reads the grid but cannot hide or delete an image", async () => {
    // Arrange — a member of the workspace who holds no `event_organizers` row.
    const workspace = await seedWorkspace("op127-member");
    const member = await app.signIn(makeIdentity("op127-member"));
    await addTenantMember(workspace.tenantId, member);
    const image = await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_SCAN, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });

    // Act
    const read = await listImages(getRequest(imagesPath(workspace), member.cookie));
    const hide = await patchImage(
      patchRequest(imagePath(workspace, image.imageId.toHexString()), member.cookie, {
        visibility: "hidden",
      })
    );
    const remove = await deleteImage(
      deleteRequest(imagePath(workspace, image.imageId.toHexString()), member.cookie)
    );

    // Assert — §4.4: the mutations are organizer/co-organizer only.
    expect(read.status).toBe(200);
    expect(hide.status).toBe(403);
    expect((await errorOf(hide)).code).toBe("forbidden");
    expect(remove.status).toBe(403);
    expect((await errorOf(remove)).code).toBe("forbidden");
    expect((await readImage(image.imageId))?.visibility).toBe("visible");
    expect((await readImage(image.imageId))?.deletedAt ?? null).toBeNull();
  });
});

describe("GET …/images?uploadedBy= — the filter is validated before its id is cast (R1)", () => {
  it("R1: a malformed uploadedBy is refused 422 validation_failed, never a 500", async () => {
    // Arrange — one image, so the same route can answer 200 for a valid filter.
    const workspace = await seedWorkspace("op127-uploadedby-malformed");
    await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_UPLOADER_ONE, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });

    // Act — a value no `new ObjectId(...)` accepts.
    const response = await listImages(
      getRequest(`${imagesPath(workspace)}?uploadedBy=not-a-hex-id`, workspace.organizer.cookie)
    );
    const error = await errorOf(response);

    // Assert — client-controlled garbage is a validation failure (ADR-0762 F7),
    // not a driver error surfaced as `500`.
    expect(response.status).toBe(422);
    expect(error.code).toBe("validation_failed");
  });

  it("R1: a well-formed 24-hex uploadedBy still narrows the page to that uploader", async () => {
    // Arrange — two uploaders, one image each.
    const workspace = await seedWorkspace("op127-uploadedby-hex");
    const otherUploader = new ObjectId();
    const mine = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_UPLOADER_ONE,
      {
        sequence: 1,
        status: "done",
        uploadedByUserId: workspace.organizer.userId,
      }
    );
    await seedImageWithAsset(workspace.tenantKey, workspace.eventId, HASH_UPLOADER_TWO, {
      sequence: 2,
      status: "done",
      uploadedByUserId: otherUploader,
    });

    // Act
    const response = await listImages(
      getRequest(
        `${imagesPath(workspace)}?uploadedBy=${workspace.organizer.userId.toHexString()}`,
        workspace.organizer.cookie
      )
    );
    const answer = (await body(response)) as unknown as ImageListAnswer;

    // Assert — the guard narrows, it does not refuse everything.
    expect(response.status).toBe(200);
    expect(answer.data.map((item) => item.id)).toEqual([mine.imageId.toHexString()]);
    expect(answer.data.map((item) => item.uploadedByUserId)).toEqual([
      workspace.organizer.userId.toHexString(),
    ]);
  });
});

describe("DELETE …/images/{imageId} — one reference of a shared asset (R2)", () => {
  it("R2: deleting one event's reference leaves refCount 1 and keeps the asset for the other event", async () => {
    // Arrange — one stored asset (refCount 2) referenced by two events of one
    // tenant, with the plan and meter I3 seeds so the release is not vacuous.
    const workspace = await seedWorkspace("op127-shared-asset");
    const otherEventId = await seedEvent(workspace.tenantKey, workspace.organizer.userId, {
      name: "Another Wedding",
    });
    await seedRoomyPlan(workspace.tenantKey);
    await seedStorageMeter(workspace.tenantKey, ORIGINAL_BYTES * 2);
    const assetId = await seedAsset(workspace.tenantKey, HASH_SHARED_ASSET, { refCount: 2 });
    const here = await seedImage(workspace.tenantKey, workspace.eventId, assetId, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });
    const there = await seedImage(workspace.tenantKey, otherEventId, assetId, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });
    await setCounters(otherEventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });
    const before = await readStoredAsset(assetId);
    if (before === null) {
      throw new Error("expected the seeded shared asset to exist");
    }
    const otherEvent: Workspace = { ...workspace, eventId: otherEventId };

    // Act — remove the first event's reference only.
    const response = await deleteImage(
      deleteRequest(imagePath(workspace, here.toHexString()), workspace.organizer.cookie)
    );

    // Assert — the count follows the reference that left, never a blind zero.
    expect(response.status).toBe(204);
    const afterFirst = await readStoredAsset(assetId);
    if (afterFirst === null) {
      throw new Error("expected the shared asset to outlive one of its two references");
    }
    expect(afterFirst.refCount).toBe(1);

    // The row survives with everything the other event still needs.
    expect(afterFirst.storage).toEqual(before.storage);
    expect(afterFirst.derivatives).toEqual(before.derivatives);
    expect(afterFirst.status).toBe(before.status);

    // The other event's grid still serves the image that points at it.
    const stillServed = await listImages(
      getRequest(imagesPath(otherEvent), workspace.organizer.cookie)
    );
    const stillServedAnswer = (await body(stillServed)) as unknown as ImageListAnswer;
    expect(stillServed.status).toBe(200);
    expect(stillServedAnswer.data.map((item) => item.id)).toEqual([there.toHexString()]);

    // One of the two held bytes left the tenant's meter.
    expect(await readStorageMeter(workspace.tenantKey)).toBe(ORIGINAL_BYTES);

    // Act — the last reference goes too.
    const lastReference = await deleteImage(
      deleteRequest(imagePath(otherEvent, there.toHexString()), workspace.organizer.cookie)
    );

    // Assert — zero references, but the purge is a job (ADR-0762 D5), so the row stays.
    expect(lastReference.status).toBe(204);
    const afterSecond = await readStoredAsset(assetId);
    if (afterSecond === null) {
      throw new Error("expected the asset row to outlive its last reference");
    }
    expect(afterSecond.refCount).toBe(0);
    expect(afterSecond.storage).toEqual(before.storage);
    expect(afterSecond.derivatives).toEqual(before.derivatives);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ _id: assetId })).toBe(
      1
    );
    expect(await readStorageMeter(workspace.tenantKey)).toBe(0);
  });
});

describe("DELETE …/images/{imageId} — a repeat call changes nothing (F1)", () => {
  it("a second DELETE of the same image is 404 not_found and moves neither the asset, the counters nor the meter", async () => {
    // Arrange — R2's fixture: one stored asset (refCount 2) referenced by two
    // events of one tenant, with the plan and meter I3 seeds so a second
    // release would be observable rather than vacuous.
    const workspace = await seedWorkspace("op127-delete-again");
    const otherEventId = await seedEvent(workspace.tenantKey, workspace.organizer.userId, {
      name: "Another Wedding",
    });
    await seedRoomyPlan(workspace.tenantKey);
    await seedStorageMeter(workspace.tenantKey, ORIGINAL_BYTES * 2);
    const assetId = await seedAsset(workspace.tenantKey, HASH_REPEAT_DELETE, { refCount: 2 });
    const here = await seedImage(workspace.tenantKey, workspace.eventId, assetId, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });
    const there = await seedImage(workspace.tenantKey, otherEventId, assetId, {
      sequence: 1,
      status: "done",
      uploadedByUserId: workspace.organizer.userId,
    });
    await setCounters(workspace.eventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });
    await setCounters(otherEventId, {
      imageCount: 1,
      processedImageCount: 1,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES,
    });
    const otherEvent: Workspace = { ...workspace, eventId: otherEventId };

    // Act — the first call removes event A's reference to the shared asset.
    const first = await deleteImage(
      deleteRequest(imagePath(workspace, here.toHexString()), workspace.organizer.cookie)
    );

    // Assert — one reference left, so the baseline the repeat must preserve is
    // stated here rather than inferred.
    expect(first.status).toBe(204);
    const afterFirst = await readStoredAsset(assetId);
    if (afterFirst === null) {
      throw new Error("expected the shared asset to outlive one of its two references");
    }
    expect(afterFirst.refCount).toBe(1);
    const softDeletedAt = (await readImage(here))?.deletedAt;
    if (!(softDeletedAt instanceof Date)) {
      throw new Error("expected the first delete to soft-delete the join row");
    }
    expect(await readCounters(workspace.eventId)).toMatchObject({
      imageCount: 0,
      storageBytes: 0,
    });
    expect(await readStorageMeter(workspace.tenantKey)).toBe(ORIGINAL_BYTES);

    // Act — the double-submit: the very same image, deleted a second time.
    const second = await deleteImage(
      deleteRequest(imagePath(workspace, here.toHexString()), workspace.organizer.cookie)
    );

    // Assert — the uniform not-found (§0.4), never a second release.
    expect(second.status).toBe(404);
    expect((await errorOf(second)).code).toBe("not_found");

    // The shared asset keeps the one live reference the first call left.
    const afterSecond = await readStoredAsset(assetId);
    if (afterSecond === null) {
      throw new Error("expected the shared asset to survive the repeat delete");
    }
    expect(afterSecond.refCount).toBe(1);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ _id: assetId })).toBe(
      1
    );
    expect(afterSecond.storage).toEqual(afterFirst.storage);
    expect(afterSecond.derivatives).toEqual(afterFirst.derivatives);

    // The soft-delete stamp is the first call's: the repeat does not rewrite it.
    expect((await readImage(here))?.deletedAt).toEqual(softDeletedAt);

    // Event A's counters are exactly what the first call left, not one lower.
    expect(await readCounters(workspace.eventId)).toMatchObject({
      imageCount: 0,
      storageBytes: 0,
    });

    // The tenant's meter still holds one image's bytes, not zero.
    expect(await readStorageMeter(workspace.tenantKey)).toBe(ORIGINAL_BYTES);

    // The other event still lists the image that points at the shared asset.
    const stillServed = await listImages(
      getRequest(imagesPath(otherEvent), workspace.organizer.cookie)
    );
    const stillServedAnswer = (await body(stillServed)) as unknown as ImageListAnswer;
    expect(stillServed.status).toBe(200);
    expect(stillServedAnswer.data.map((item) => item.id)).toEqual([there.toHexString()]);

    // And event A's grid stays empty, so the repeat resurrected nothing.
    const hereAgain = await listImages(
      getRequest(imagesPath(workspace), workspace.organizer.cookie)
    );
    expect(((await body(hereAgain)) as unknown as ImageListAnswer).data).toEqual([]);
  });
});

describe("GET …/images — the query string narrows the page (R3)", () => {
  /** Two visible images of different status, plus one hidden queued original. */
  interface FilterFixture {
    readonly workspace: Workspace;
    readonly done: ObjectId;
    readonly failed: ObjectId;
    readonly hidden: ObjectId;
  }

  /** Seed the three images each R3 case reads, with counters that agree. */
  async function seedFilterFixture(prefix: string): Promise<FilterFixture> {
    const workspace = await seedWorkspace(prefix);
    const done = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_FILTER_DONE,
      {
        sequence: 1,
        status: "done",
        visibility: "visible",
        uploadedByUserId: workspace.organizer.userId,
      }
    );
    const failed = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_FILTER_FAILED,
      {
        sequence: 2,
        status: "failed",
        visibility: "visible",
        uploadedByUserId: workspace.organizer.userId,
      }
    );
    const hidden = await seedImageWithAsset(
      workspace.tenantKey,
      workspace.eventId,
      HASH_FILTER_HIDDEN,
      {
        sequence: 3,
        status: "queued",
        visibility: "hidden",
        uploadedByUserId: workspace.organizer.userId,
      }
    );
    await setCounters(workspace.eventId, {
      imageCount: 3,
      processedImageCount: 1,
      failedImageCount: 1,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: ORIGINAL_BYTES * 3,
    });
    return { workspace, done: done.imageId, failed: failed.imageId, hidden: hidden.imageId };
  }

  it("R3: ?visibility=hidden lists exactly the hidden image, while no filter lists all three", async () => {
    // Arrange
    const fixture = await seedFilterFixture("op127-filter-visibility");

    // Act
    const unfiltered = await listImages(
      getRequest(imagesPath(fixture.workspace), fixture.workspace.organizer.cookie)
    );
    const hiddenOnly = await listImages(
      getRequest(
        `${imagesPath(fixture.workspace)}?visibility=hidden`,
        fixture.workspace.organizer.cookie
      )
    );
    const unfilteredAnswer = (await body(unfiltered)) as unknown as ImageListAnswer;
    const hiddenAnswer = (await body(hiddenOnly)) as unknown as ImageListAnswer;

    // Assert — hide is not delete, so the unfiltered grid still carries all three…
    expect(unfiltered.status).toBe(200);
    expect(unfilteredAnswer.data.map((item) => item.id)).toEqual([
      fixture.hidden.toHexString(),
      fixture.failed.toHexString(),
      fixture.done.toHexString(),
    ]);
    // …and the filter is applied at the route, not merely baked into the builder.
    expect(hiddenOnly.status).toBe(200);
    expect(hiddenAnswer.data.map((item) => item.id)).toEqual([fixture.hidden.toHexString()]);
  });

  it("R3: ?status=failed lists exactly the failed image", async () => {
    // Arrange
    const fixture = await seedFilterFixture("op127-filter-status");

    // Act
    const response = await listImages(
      getRequest(
        `${imagesPath(fixture.workspace)}?status=failed`,
        fixture.workspace.organizer.cookie
      )
    );
    const answer = (await body(response)) as unknown as ImageListAnswer;

    // Assert
    expect(response.status).toBe(200);
    expect(answer.data.map((item) => item.id)).toEqual([fixture.failed.toHexString()]);
  });

  it("R3: two filters narrow the page together rather than last-one-wins", async () => {
    // Arrange
    const fixture = await seedFilterFixture("op127-filter-composed");

    // Act — `hidden` is queued and `done` is visible, so each clause alone
    // selects a different image while their conjunction selects one and none.
    const matching = await listImages(
      getRequest(
        `${imagesPath(fixture.workspace)}?status=queued&visibility=hidden`,
        fixture.workspace.organizer.cookie
      )
    );
    const disjoint = await listImages(
      getRequest(
        `${imagesPath(fixture.workspace)}?status=done&visibility=hidden`,
        fixture.workspace.organizer.cookie
      )
    );
    const matchingAnswer = (await body(matching)) as unknown as ImageListAnswer;
    const disjointAnswer = (await body(disjoint)) as unknown as ImageListAnswer;

    // Assert — both clauses are applied at once (§4.4).
    expect(matching.status).toBe(200);
    expect(matchingAnswer.data.map((item) => item.id)).toEqual([fixture.hidden.toHexString()]);
    expect(disjoint.status).toBe(200);
    expect(disjointAnswer.data).toEqual([]);
  });
});
