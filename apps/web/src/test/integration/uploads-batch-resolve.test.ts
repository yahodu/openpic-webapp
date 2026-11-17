import { createHash } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import * as uploadConfigRoute from "@/app/api/v1/uploads/config/route";
import * as batchResolveRoute from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/batch-resolve/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import type { Entitlement } from "@/server/plans/plans";
import {
  PLATFORM_SETTINGS_DEFAULTS,
  invalidatePlatformSettings,
  type PlatformSettingsValues,
} from "@/server/settings/platform-settings";

import { makeEntitlement, makePlan } from "../factories/plan";
import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { TEST_STORAGE_BUCKETS, TEST_STORAGE_ENDPOINT } from "../factories/storage";
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
import { server } from "./setup";

/**
 * Integration / contract — the upload pre-check (OP-123 I1–I6, contract §5.1 /
 * §5.2, schema §16.1–§16.3, upload doc §5; ADR-0700).
 *
 * The user story: *as an uploader, I want one pre-check call for up to 500
 * files so that duplicates are skipped and interrupted uploads resume.* Two
 * endpoints deliver it:
 *
 * - `GET /api/v1/uploads/config` — the fixed parameters the client must not
 *   hard-code (`multipartThresholdBytes`, `maxFileBytes`, the MIME allow-list,
 *   the 500-hash ceiling, the presign TTL), read from `platformSettings.upload`
 *   and answered `private, max-age=300`.
 * - `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batch-resolve` —
 *   one round trip for the whole drag-and-drop, answering per hash,
 *   `completed` (skip: tenant-wide dedupe, `linked` says whether the asset is
 *   already attached to *this* event), `in_progress` (resume: parts come from
 *   the storage provider's own `ListParts`), `not_found` (fresh) or `rejected`
 *   (never attempt), plus an **advisory** `quota` block.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/uploads/config/route` exports `GET`, declared with
 *   `defineRoute({ route: "/api/v1/uploads/config", … })` and `auth: userAuth()`.
 *   The body is the contract's §5.1.1 object — exactly
 *   `multipartThresholdBytes`, `partSizeBytes`, `maxFileBytes`, `maxBatchSize`,
 *   `supportedMimeTypes`, `presignTtlSeconds`, `maxConcurrentParts`,
 *   `hashAlgorithm` — with the first three (and the MIME list) read from the
 *   `platformSettings` singleton, the rest from the contract's fixed values.
 *   `Cache-Control: private, max-age=300`.
 * - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/batch-resolve/route`
 *   exports `POST`, declared with the contract's tenant-scoped template, and
 *   admits `user` + **event member** through the lane's `admitEventActor` seam.
 *   The event id sits **three** segments from the end of the path
 *   (`…/events/{eventId}/uploads/batch-resolve`), so the shared admission needs
 *   `eventIdFromRequest(request, { segmentFromEnd: 3 })` — its current default
 *   of `2` would read the literal `uploads` segment (ADR-0700 D3).
 * - Request `{ batchId, files: [{ hash, size, fileName?, mimeType }] }`; the
 *   response is the contract's bare object (§5.2): `{ batchId, uploadWindowOpen,
 *   resolutions, quota }` keyed by hash — **not** wrapped in `data`.
 * - The **completed** lookup is tenant-wide (`{tenantId, contentHash}`); the
 *   **in_progress** lookup is additionally per user
 *   (`{tenantId, createdByUserId, contentHash}`). Dedupe is never global across
 *   tenants.
 * - `uploadWindowEndsAt === null` is an **unlimited** window (never closed); a
 *   window in the past is `409 upload_window_closed` carrying
 *   `details.uploadWindowEndsAt` and `details.canExtend` — a **new** error code
 *   the GREEN owes the catalogue and the contracts union (§Appendix A row
 *   `upload_window_closed`).
 * - 501 hashes → `413 payload_too_large` with
 *   `details { maxItems: 500, actualItems: 501 }`; a malformed `batchId` →
 *   `422 validation_failed` naming `batchId`.
 * - The pre-check is **read-only**: it creates no `upload_sessions` row, emits
 *   no domain event, and so can never produce a per-file notification
 *   (`upload.batch.files_rejected` folds rejections into the batch summary).
 * - Counts per state are logged at `info`; a file **name** never is.
 *
 * ## Storage is the parts source of truth (I3)
 *
 * The suite boots the app with `STORAGE_PROVIDER=s3` pointed at MSW, so the
 * resumable answer can only come from a real `ListParts` call: the parts exist
 * nowhere in Mongo (schema §16.2 dropped the part collection).
 *
 * ## Assumptions (ADR-0700 §Assumptions)
 *
 * - A6 — the session lookup accepts `status` `pending` **or** `in_progress`
 *   (both are "not done yet" for the client) and ignores `completed`/`aborted`.
 * - A7 — `quota.storage.requestedBytes` is the sum of the declared sizes of the
 *   files that still need bytes (`not_found` + `in_progress`); a `completed`
 *   duplicate needs none and a `rejected` file will never be sent, so neither is
 *   counted. `quota.images.requested` is the same set counted per file.
 * - A8 — the `upload_sessions` collection is the schema's `uploadSessions`
 *   (§16.2), registered as `COLLECTIONS.uploadSessions = "upload_sessions"`; the
 *   unused `COLLECTIONS.uploads` literal is left alone.
 * - A9 — a `ListParts` upstream failure is a `502 bad_gateway` for the whole
 *   call, not a per-file guess: reporting `not_found` would make the client
 *   re-send bytes that may already be stored.
 */

/** The collection the schema calls `uploadSessions` (§16.2). */
const UPLOAD_SESSIONS = "upload_sessions";

/** The bucket `originals` resolves to in the storage runtime wiring. */
const ORIGINALS_BUCKET = TEST_STORAGE_BUCKETS.originals ?? "bkt-a1";

/** The multipart upload id the mocked R2 issues for the resumable fixture. */
const MULTIPART_ID = "2~op123-resume";

/** One uploaded part at the 8 MB part size, plus a short trailing part. */
const LISTED_PART_NUMBERS = [1, 3];
const LISTED_BYTES = 8_388_608 + 1_048_576;

/** The transfer ceiling from contract §5.1. */
const MAX_BATCH_FILES = 500;

/** A deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op123-${name}`).digest("hex");
}

/** The hash of an asset this tenant already stores and has attached. */
const HASH_LINKED = hashFor("linked");

/** The hash of a tenant asset that is not attached to the event yet. */
const HASH_UNLINKED = hashFor("unlinked");

/** The hash of a multipart upload interrupted part-way. */
const HASH_RESUMING = hashFor("resuming");

/** The hash of a file nobody has uploaded anywhere. */
const HASH_FRESH = hashFor("fresh");

/** The hash tenant A owns and tenant B must never see. */
const HASH_FOREIGN = hashFor("foreign");

/** The hash of the in-flight session user A owns (I1). */
const HASH_OWNED_BY_A = hashFor("owned-by-a");

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({
    prefix: "op123-batch",
    env: {
      STORAGE_PROVIDER: "s3",
      R2_ENDPOINT: TEST_STORAGE_ENDPOINT,
      R2_REGION: "auto",
      R2_ACCESS_KEY_ID: "op123-test-access-key",
      R2_SECRET_ACCESS_KEY: "op123-test-secret-key",
      R2_BUCKET_ORIGINALS: TEST_STORAGE_BUCKETS.originals,
      R2_BUCKET_THUMBNAILS: TEST_STORAGE_BUCKETS.thumbnails,
      R2_BUCKET_EXPORTS: TEST_STORAGE_BUCKETS.exports,
      R2_BUCKET_BRANDING: TEST_STORAGE_BUCKETS.branding,
    },
  });
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
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    UPLOAD_SESSIONS,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  await app.db.collection("platformSettings").deleteMany({});
  invalidatePlatformSettings();
});

/** Read one route export off a namespace, failing with a naming message. */
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

const uploadConfig = requireHandler(uploadConfigRoute, "GET", "/api/v1/uploads/config");
const batchResolve = requireHandler(
  batchResolveRoute,
  "POST",
  "/api/v1/tenants/:tenantId/events/:eventId/uploads/batch-resolve"
);

/** The contract's §5.2 request body for one file. */
interface FileClaim {
  readonly hash: string;
  readonly size: number;
  readonly mimeType: string;
  readonly fileName?: string;
}

/** The wire shape the batch-resolve assertions read. */
interface QuotaBlock {
  readonly sufficient: boolean;
  readonly requested: number;
  readonly remaining?: number | null;
  readonly remainingBytes?: number | null;
  readonly requestedBytes?: number;
}

interface ResolveBody {
  readonly batchId: string;
  readonly uploadWindowOpen: boolean;
  readonly resolutions: Record<string, Record<string, unknown>>;
  readonly quota: {
    readonly storage: QuotaBlock;
    readonly images: QuotaBlock;
  };
}

/** A claim whose extension and MIME agree (the happy-path file). */
function claimFor(hash: string, overrides: Partial<FileClaim> = {}): FileClaim {
  return { hash, size: 2_140_000, fileName: "DSC_0421.JPG", mimeType: "image/jpeg", ...overrides };
}

/** A batch id in the ObjectId shape the contract accepts. */
function batchId(): string {
  return new ObjectId().toHexString();
}

/** A `POST …/uploads/batch-resolve` request carrying the session cookie. */
function batchRequest(
  cookie: string,
  tenantSegment: string,
  eventId: string,
  payload: { readonly batchId: string; readonly files: readonly FileClaim[] }
): Request {
  return new Request(
    new URL(`/api/v1/tenants/${tenantSegment}/events/${eventId}/uploads/batch-resolve`, APP_ORIGIN),
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}

/** An unauthenticated `POST …/uploads/batch-resolve`. */
function anonymousBatchRequest(tenantSegment: string, eventId: string): Request {
  return new Request(
    new URL(`/api/v1/tenants/${tenantSegment}/events/${eventId}/uploads/batch-resolve`, APP_ORIGIN),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchId: batchId(), files: [claimFor(HASH_FRESH)] }),
    }
  );
}

/** The parsed body of a batch-resolve response. */
async function resolveBody(response: Response): Promise<ResolveBody> {
  return (await body(response)) as unknown as ResolveBody;
}

/** One hash's resolution, failing loudly when the map omits it. */
function resolutionOf(payload: ResolveBody, hash: string): Record<string, unknown> {
  const entry = Object.entries(payload.resolutions).find(([key]) => key === hash);
  if (entry === undefined) {
    throw new Error(`expected a resolution for ${hash}`);
  }
  return entry[1];
}

/** The error envelope of a failed response. */
interface ErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** Parse an error envelope without reading the body twice. */
async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const parsed = await body(response);
  return parsed.error as ErrorEnvelope;
}

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP123 Studio",
    status: "active",
    ownerUserId: owner.userId,
    billingContactUserId: owner.userId,
    dataRegion: "in",
    counters: {
      eventCount: 0,
      activeEventCount: 0,
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
        slug: `op123${_id.toHexString().slice(-8)}`,
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

/** A workspace with a signed-in organizer and an open upload window. */
interface Workspace {
  readonly organizer: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** Sign an organizer in, provision their workspace and seed one open event. */
async function seedWorkspace(prefix: string): Promise<Workspace> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = await insertTenant(`op123-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Record an `event_organizers` row for a co-organizer with no workspace membership. */
async function addCoOrganizer(
  tenantKey: string,
  eventId: ObjectId,
  user: SignedInUser
): Promise<void> {
  const now = new Date();
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId,
    userId: user.userId.toHexString(),
    role: "co_organizer",
    status: "active",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
}

/** Insert a `media_assets` row for a completed hash (schema §16.1). */
async function seedAsset(
  tenantKey: string,
  contentHash: string,
  bytes: number,
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
      bytes,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date(),
    },
    derivatives: {},
    imageMeta: { width: 4032, height: 3024, orientation: 1 },
    status: "stored",
    refCount: 1,
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

/** Insert the `event_images` join row that makes an asset `linked` (schema §16.3). */
async function seedEventImage(
  tenantKey: string,
  eventId: ObjectId,
  assetId: ObjectId,
  uploadedByUserId: ObjectId
): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: tenantKey,
    eventId,
    assetId,
    uploadedByUserId,
    sequence: 1,
    processing: { status: "queued", attempts: 0 },
    faceCount: 0,
    visibility: "visible",
    createdAt: new Date(),
  });
  return _id;
}

/** Insert a resumable `upload_sessions` row whose multipart id lives in `externalRefs` (§16.2). */
async function seedMultipartSession(fields: {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly contentHash: string;
  readonly createdByUserId: ObjectId;
  readonly uploadId?: string | null;
  readonly status?: string;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  const uploadId = fields.uploadId === undefined ? MULTIPART_ID : fields.uploadId;
  await app.db.collection(UPLOAD_SESSIONS).insertOne({
    _id,
    tenantId: fields.tenantKey,
    eventId: fields.eventId,
    createdByUserId: fields.createdByUserId,
    contentHash: fields.contentHash,
    mode: "multipart",
    status: fields.status ?? "in_progress",
    fileName: "DSC_0422.JPG",
    declaredSize: 41_943_040,
    declaredMimeType: "image/jpeg",
    externalRefs:
      uploadId === null ? [] : [{ provider: "r2", kind: "multipart_upload", id: uploadId }],
    assetId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expireAt: new Date(Date.now() + 5 * 86_400_000),
  });
  return _id;
}

/** Seed the plan catalogue entry and the live subscription that activates it. */
async function seedPlan(
  tenantKey: string,
  key: string,
  entitlements: Record<string, Entitlement>
): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key, entitlements }));
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: key,
      activePlanKey: key,
      status: "active",
    })
  );
}

/** Overwrite the `platformSettings` singleton's `upload` block. */
async function seedUploadSettings(
  overrides: Partial<PlatformSettingsValues["upload"]>
): Promise<void> {
  await app.db.collection<Document & { readonly _id: string }>("platformSettings").insertOne({
    _id: "singleton",
    ...PLATFORM_SETTINGS_DEFAULTS,
    upload: { ...PLATFORM_SETTINGS_DEFAULTS.upload, ...overrides },
    updatedAt: new Date().toISOString(),
    updatedByUserId: null,
  });
  invalidatePlatformSettings();
}

/** The XML an S3-compatible `ListParts` answers with, two parts landed. */
function listPartsXml(
  parts: readonly { readonly number: number; readonly size: number }[]
): string {
  const body = parts
    .map(
      (part) =>
        `<Part><PartNumber>${String(part.number)}</PartNumber><LastModified>2026-10-25T10:00:00.000Z</LastModified><ETag>"p${String(part.number)}-etag"</ETag><Size>${String(part.size)}</Size></Part>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>images/${HASH_RESUMING}.jpg</Key><UploadId>${MULTIPART_ID}</UploadId><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>4</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${body}</ListPartsResult>`;
}

/** The URL path every `ListParts` call for a content-addressed original addresses. */
const LIST_PARTS_URL = new RegExp(`/bkt-a1/images/[0-9a-f]{64}\\.[a-z]+`);

/** The XML response headers a mocked S3 answer carries. */
const XML_HEADERS = { "content-type": "application/xml" };

describe("GET /api/v1/uploads/config — the client's fixed parameters (contract §5.1.1)", () => {
  it("answers 401 without a session", async () => {
    const response = await uploadConfig(
      new Request(new URL("/api/v1/uploads/config", APP_ORIGIN), { method: "GET" })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });

  it("serves the contract's eight parameters privately cached for five minutes", async () => {
    const workspace = await seedWorkspace("op123-config");

    const response = await uploadConfig(
      new Request(new URL("/api/v1/uploads/config", APP_ORIGIN), {
        method: "GET",
        headers: { cookie: workspace.organizer.cookie },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const parsed = await body(response);
    expect(parsed).toEqual({
      multipartThresholdBytes: 8_388_608,
      partSizeBytes: 8_388_608,
      maxFileBytes: 104_857_600,
      maxBatchSize: MAX_BATCH_FILES,
      supportedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
        "image/avif",
        "image/tiff",
      ],
      presignTtlSeconds: 900,
      maxConcurrentParts: 4,
      hashAlgorithm: "sha256",
    });
    // §0.15 — the parameter list never names a bucket, a key or a location.
    expect(findForbiddenFields(parsed)).toEqual([]);
  });

  it("reads the tunables from platformSettings.upload rather than from constants", async () => {
    const workspace = await seedWorkspace("op123-config-settings");
    await seedUploadSettings({
      multipartThresholdBytes: 4_194_304,
      maxFileBytes: 52_428_800,
      supportedMimeTypes: ["image/jpeg", "image/png"],
    });

    const response = await uploadConfig(
      new Request(new URL("/api/v1/uploads/config", APP_ORIGIN), {
        method: "GET",
        headers: { cookie: workspace.organizer.cookie },
      })
    );

    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed).toMatchObject({
      multipartThresholdBytes: 4_194_304,
      maxFileBytes: 52_428_800,
      supportedMimeTypes: ["image/jpeg", "image/png"],
    });
  });
});

describe("POST …/uploads/batch-resolve — dedupe (contract §5.2)", () => {
  it("I2: a completed hash already attached to this event answers linked true with both ids", async () => {
    const workspace = await seedWorkspace("op123-linked");
    const assetId = await seedAsset(workspace.tenantKey, HASH_LINKED, 8_421_310);
    const eventImageId = await seedEventImage(
      workspace.tenantKey,
      workspace.eventId,
      assetId,
      workspace.organizer.userId
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_LINKED, { size: 8_421_310 })],
        }
      )
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(parsed.uploadWindowOpen).toBe(true);
    expect(resolutionOf(parsed, HASH_LINKED)).toEqual({
      state: "completed",
      assetId: assetId.toHexString(),
      eventImageId: eventImageId.toHexString(),
      linked: true,
      bytes: 8_421_310,
    });
    // §0.15 — no object key, bucket, location key, `_id` or upstream reference.
    expect(findForbiddenFields(parsed)).toEqual([]);
  });

  it("I2: a completed hash stored in the tenant but not attached answers linked false and no eventImageId", async () => {
    const workspace = await seedWorkspace("op123-unlinked");
    const assetId = await seedAsset(workspace.tenantKey, HASH_UNLINKED, 2_140_000);

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_UNLINKED)],
        }
      )
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(resolutionOf(parsed, HASH_UNLINKED)).toEqual({
      state: "completed",
      assetId: assetId.toHexString(),
      eventImageId: null,
      linked: false,
      bytes: 2_140_000,
    });
    expect(parsed.quota.storage.requestedBytes).toBe(0);
  });

  it("I6: another tenant's identical hash is not_found, because dedupe is never global", async () => {
    const owner = await seedWorkspace("op123-tenant-a");
    const foreignAssetId = await seedAsset(owner.tenantKey, HASH_FOREIGN, 2_140_000);

    const other = await seedWorkspace("op123-tenant-b");

    const response = await batchResolve(
      batchRequest(other.organizer.cookie, other.tenantKey, other.eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_FOREIGN)],
      })
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(resolutionOf(parsed, HASH_FOREIGN)).toEqual({ state: "not_found", mode: "single" });
    // The other tenant's asset is invisible — not even its id leaks.
    expect(JSON.stringify(parsed)).not.toContain(foreignAssetId.toHexString());
  });
});

describe("POST …/uploads/batch-resolve — resume (I1, I3)", () => {
  it("I3: an interrupted multipart upload reports the parts the storage provider still holds", async () => {
    const workspace = await seedWorkspace("op123-resume");
    await seedMultipartSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_RESUMING,
      createdByUserId: workspace.organizer.userId,
    });
    const listedUploadIds: (string | null)[] = [];
    server.use(
      http.get(LIST_PARTS_URL, ({ request }) => {
        listedUploadIds.push(new URL(request.url).searchParams.get("uploadId"));
        return new HttpResponse(
          listPartsXml([
            { number: 1, size: 8_388_608 },
            { number: 3, size: 1_048_576 },
          ]),
          { status: 200, headers: XML_HEADERS }
        );
      })
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_RESUMING, { size: 41_943_040 })],
        }
      )
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(resolutionOf(parsed, HASH_RESUMING)).toEqual({
      state: "in_progress",
      uploadId: MULTIPART_ID,
      mode: "multipart",
      uploadedPartNumbers: LISTED_PART_NUMBERS,
      uploadedBytes: LISTED_BYTES,
    });
    // The provider id can only have come from the session's `externalRefs`.
    expect(listedUploadIds).toEqual([MULTIPART_ID]);
  });

  it("I1: a co-organizer does not see another user's in-progress session for the same hash", async () => {
    const workspace = await seedWorkspace("op123-per-user");
    const coOrganizer = await app.signIn(makeIdentity("op123-per-user-co"));
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);
    await seedMultipartSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_OWNED_BY_A,
      createdByUserId: workspace.organizer.userId,
    });
    server.use(
      http.get(
        LIST_PARTS_URL,
        () => new HttpResponse(listPartsXml([]), { status: 200, headers: XML_HEADERS })
      )
    );

    const response = await batchResolve(
      batchRequest(coOrganizer.cookie, workspace.tenantKey, workspace.eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_OWNED_BY_A, { size: 41_943_040 })],
      })
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    // The owner's in-flight session is invisible: a fresh upload, never a resume.
    expect(resolutionOf(parsed, HASH_OWNED_BY_A)).toEqual({
      state: "not_found",
      mode: "multipart",
    });
    expect(JSON.stringify(parsed)).not.toContain(MULTIPART_ID);
  });

  it("I3: a storage failure while listing parts answers 502 rather than guessing a fresh upload", async () => {
    const workspace = await seedWorkspace("op123-list-parts-down");
    await seedMultipartSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_RESUMING,
      createdByUserId: workspace.organizer.userId,
    });
    server.use(
      http.get(
        LIST_PARTS_URL,
        () => new HttpResponse("<Error/>", { status: 500, headers: XML_HEADERS })
      )
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_RESUMING, { size: 41_943_040 })],
        }
      )
    );

    expect(response.status).toBe(502);
    expect((await errorEnvelope(response)).code).toBe("bad_gateway");
  });
});

describe("POST …/uploads/batch-resolve — limits", () => {
  it("I4: 501 hashes is refused with 413 payload_too_large naming both counts", async () => {
    const workspace = await seedWorkspace("op123-too-many");
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, index) =>
      claimFor(hashFor(`bulk-${String(index)}`), { size: 1_000 })
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files,
        }
      )
    );

    expect(response.status).toBe(413);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("payload_too_large");
    expect(envelope.details).toMatchObject({ maxItems: MAX_BATCH_FILES, actualItems: 501 });
  });

  it("I4: exactly 500 hashes is accepted and answers one resolution per hash", async () => {
    const workspace = await seedWorkspace("op123-at-limit");
    const files = Array.from({ length: MAX_BATCH_FILES }, (_, index) =>
      claimFor(hashFor(`bulk-${String(index)}`), { size: 1_000 })
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files,
        }
      )
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(Object.keys(parsed.resolutions)).toHaveLength(MAX_BATCH_FILES);
    expect(parsed.quota.storage.requestedBytes).toBe(MAX_BATCH_FILES * 1_000);
  });

  it("I5: a closed upload window answers 409 upload_window_closed and writes nothing", async () => {
    const organizer = await app.signIn(makeIdentity("op123-closed"));
    const tenantId = await insertTenant("op123-closed", organizer);
    const tenantKey = tenantId.toHexString();
    const closedAt = new Date(fixtureInstant("12:00:00.000Z", -1));
    const eventId = await seedEvent(tenantKey, organizer.userId, { uploadWindowEndsAt: closedAt });

    const response = await batchResolve(
      batchRequest(organizer.cookie, tenantKey, eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_FRESH)],
      })
    );

    expect(response.status).toBe(409);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("upload_window_closed");
    expect(envelope.details?.uploadWindowEndsAt).toBe(closedAt.toISOString());
    expect(typeof envelope.details?.canExtend).toBe("boolean");
    // A refused pre-check records no session, so nothing is left half-started.
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(0);
  });

  it("I5: an unlimited upload window (null) is open, not closed", async () => {
    const organizer = await app.signIn(makeIdentity("op123-unlimited"));
    const tenantId = await insertTenant("op123-unlimited", organizer);
    const tenantKey = tenantId.toHexString();
    const eventId = await seedEvent(tenantKey, organizer.userId, { uploadWindowEndsAt: null });

    const response = await batchResolve(
      batchRequest(organizer.cookie, tenantKey, eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_FRESH)],
      })
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(parsed.uploadWindowOpen).toBe(true);
    expect(resolutionOf(parsed, HASH_FRESH)).toEqual({ state: "not_found", mode: "single" });
  });

  it("I5: a window closing in an hour is still open", async () => {
    const organizer = await app.signIn(makeIdentity("op123-still-open"));
    const tenantId = await insertTenant("op123-still-open", organizer);
    const tenantKey = tenantId.toHexString();
    const eventId = await seedEvent(tenantKey, organizer.userId, {
      uploadWindowEndsAt: new Date(Date.now() + 3_600_000),
    });

    const response = await batchResolve(
      batchRequest(organizer.cookie, tenantKey, eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_FRESH)],
      })
    );

    expect(response.status).toBe(200);
    expect((await resolveBody(response)).uploadWindowOpen).toBe(true);
  });

  it("rejects a batchId that is neither a UUIDv4 nor a 24-hex id with a field-level 422", async () => {
    const workspace = await seedWorkspace("op123-bad-batch-id");

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: "not-a-batch-id",
          files: [claimFor(HASH_FRESH)],
        }
      )
    );

    expect(response.status).toBe(422);
    const envelope = await errorEnvelope(response);
    expect(envelope.code).toBe("validation_failed");
    expect(envelope.details).toMatchObject({ fields: [{ path: "batchId" }] });
  });
});

describe("POST …/uploads/batch-resolve — admission", () => {
  it("answers 401 without a session", async () => {
    const workspace = await seedWorkspace("op123-anon");

    const response = await batchResolve(
      anonymousBatchRequest(workspace.tenantKey, workspace.eventId.toHexString())
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });

  it("answers the uniform 404 to a signed-in user with no relationship to the event", async () => {
    const workspace = await seedWorkspace("op123-stranger");
    await seedAsset(workspace.tenantKey, HASH_LINKED, 8_421_310);
    const stranger = await app.signIn(makeIdentity("op123-stranger-caller"));

    const response = await batchResolve(
      batchRequest(stranger.cookie, workspace.tenantKey, workspace.eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_LINKED)],
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 404 when the event is addressed through another tenant's path", async () => {
    const owner = await seedWorkspace("op123-path-owner");
    const other = await seedWorkspace("op123-path-other");

    const response = await batchResolve(
      batchRequest(other.organizer.cookie, other.tenantKey, owner.eventId.toHexString(), {
        batchId: batchId(),
        files: [claimFor(HASH_FRESH)],
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });
});

describe("POST …/uploads/batch-resolve — rejections, quota and side effects", () => {
  it("rejects an unsupported type and a mismatched extension per file, and counts only the file that will upload", async () => {
    const workspace = await seedWorkspace("op123-rejected");

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [
            claimFor(hashFor("bitmap"), { fileName: "scan.BMP", mimeType: "image/bmp" }),
            claimFor(hashFor("mismatch"), { fileName: "DSC_0426.PNG", mimeType: "image/jpeg" }),
            claimFor(HASH_FRESH, { size: 2_140_000 }),
          ],
        }
      )
    );

    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(resolutionOf(parsed, hashFor("bitmap"))).toMatchObject({
      state: "rejected",
      reason: "unsupported_mime_type",
    });
    expect(resolutionOf(parsed, hashFor("mismatch"))).toMatchObject({
      state: "rejected",
      reason: "extension_mime_mismatch",
    });
    expect(resolutionOf(parsed, HASH_FRESH)).toEqual({ state: "not_found", mode: "single" });
    // Only the uploadable file is counted against the allowance (A7).
    expect(parsed.quota.storage.requestedBytes).toBe(2_140_000);
    expect(parsed.quota.images.requested).toBe(1);
  });

  it("advises the client which allowance the batch exceeds without refusing the call", async () => {
    const workspace = await seedWorkspace("op123-quota");
    await seedPlan(workspace.tenantKey, "op123-plan", {
      "storage.bytes": makeEntitlement({
        limit: 3_000_000,
        resetPeriod: "lifetime",
        scope: "tenant",
        enforcement: "hard",
      }),
      "images.per_event": makeEntitlement({
        limit: 500,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
    });
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      ...makeUsageCounter({
        tenantId: workspace.tenantKey,
        entitlementKey: "storage.bytes",
        periodKey: "lifetime",
        value: 2_500_000,
      }),
    });
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: workspace.eventId }, { $set: { "counters.imageCount": 498 } });

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_FRESH, { size: 2_140_000 })],
        }
      )
    );

    // The pre-check is advisory: an over-quota batch is still answered 200.
    expect(response.status).toBe(200);
    const parsed = await resolveBody(response);
    expect(parsed.quota.storage).toEqual({
      remainingBytes: 500_000,
      requestedBytes: 2_140_000,
      sufficient: false,
    });
    expect(parsed.quota.images).toEqual({ remaining: 2, requested: 1, sufficient: true });
    // Nothing was consumed: enforcement lives in the completion transaction.
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: workspace.tenantKey, entitlementKey: "storage.bytes" });
    expect(counter).toMatchObject({ value: 2_500_000 });
  });

  it("writes nothing and emits no per-file notification for rejected files", async () => {
    const workspace = await seedWorkspace("op123-read-only");
    // Sign-in itself emits `account.welcome` / `auth.signin.new_device`, so the
    // pre-check is measured against the count it inherits, not against zero.
    const eventsBefore = await app.db.collection(COLLECTIONS.domainEvents).countDocuments({});
    const sessionsBefore = await app.db.collection(UPLOAD_SESSIONS).countDocuments({});

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [
            claimFor(hashFor("bitmap-2"), { fileName: "scan.BMP", mimeType: "image/bmp" }),
            claimFor(HASH_FRESH),
          ],
        }
      )
    );

    expect(response.status).toBe(200);
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(sessionsBefore);
    expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(eventsBefore);
  });

  it("logs counts per state at info and never a file name", async () => {
    const workspace = await seedWorkspace("op123-log");
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({
        level: "debug",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );

    const response = await batchResolve(
      batchRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId.toHexString(),
        {
          batchId: batchId(),
          files: [claimFor(HASH_FRESH, { fileName: "PRIVATE-WEDDING-PHOTO.jpg" })],
        }
      )
    );

    expect(response.status).toBe(200);
    // Prove the capture is armed before trusting the negative.
    expect(sink.entries.some((entry) => entry.level === "info")).toBe(true);
    expect(JSON.stringify(sink.entries)).not.toContain("PRIVATE-WEDDING-PHOTO");
  });
});
