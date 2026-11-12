import { createHash, randomUUID } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import * as completeRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/[uploadSessionId]/complete/route";
import * as linkRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route";
import * as paramsRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import type { Entitlement } from "@/server/plans/plans";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import {
  PLATFORM_SETTINGS_DEFAULTS,
  invalidatePlatformSettings,
} from "@/server/settings/platform-settings";

import { makeEntitlement, makePlan } from "../factories/plan";
import { makeSubscription } from "../factories/entitlements";
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
 * Integration / contract — the single-PUT upload, its completion transaction
 * and the link-only attachment (OP-124 I1–I11, contract §5.3, schema §16.1–§16.3;
 * ADR-0720).
 *
 * The user story: *as an uploader, I want small files uploaded directly to
 * storage and registered atomically so that storage billing and gallery state
 * are always consistent.* Three endpoints deliver it:
 *
 * - `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/params` — the
 *   single-PUT presign (§5.3). Idempotency required; `201` with
 *   `{ uploadSessionId, method: "PUT", url, headers, expiresAt, completeUrl }`
 *   and **no bucket / object key / location field** (§0.15); it upserts one
 *   `upload_sessions` row (`mode: "single"`, `status: "pending"`, the 5-day
 *   `expireAt`).
 * - `POST …/uploads/{uploadSessionId}/complete` — `{ etag, bytes }`,
 *   idempotency required: `HeadObject` the presigned object, refuse a stored
 *   size that differs by more than 1 % (`409 size_mismatch`), sniff the stored
 *   bytes and refuse a file whose content contradicts its claim (`415
 *   unsupported_media_type`, object deleted, nothing written), then in **one
 *   transaction** consume `storage.bytes` + `images.per_event`, upsert
 *   `media_assets` (`refCount + 1`), insert `event_images` (the event's next
 *   `sequence`) and `$inc` the event counters, leaving the session `completed`.
 *   `201` returns the `EventImage` DTO with `processing.status: "queued"`; the
 *   duplicate `{eventId, assetId}` insert is **not** an error — the unique
 *   index collision answers `200` with the existing image. After the commit the
 *   work item is enqueued (`q:image`), and a failed enqueue is a `warn`, never
 *   a failed upload (§18.1).
 * - `POST …/uploads:link` — `{ batchId, assetIds }` attaches assets the tenant
 *   already stores, without any byte transfer: same transaction pattern,
 *   `images.per_event` consumed, **no** `storage.bytes`. `201` with
 *   `{ linked: [{ assetId, eventImageId }], skipped: [] }`; an asset already
 *   attached to this event (or one this tenant does not hold) lands in
 *   `skipped` instead of failing the batch.
 *
 * ## Contract expected of the implementation
 *
 * - The three route modules above export `POST`, declared through `defineRoute`
 *   with the contract's tenant-scoped templates. The event id sits **three**
 *   segments from the end on `…/events/{eventId}/uploads/params`, **four** on
 *   `…/events/{eventId}/uploads/{uploadSessionId}/complete`, and **two** on
 *   `…/events/{eventId}/uploads:link`, so the shared admission is
 *   `eventActorAdmission(3)` / `eventActorAdmission(4)` / the default `2` (a
 *   hard-coded `2` reads the wrong segment on the first two).
 * - `params` and both `complete` endpoints run the **required** idempotency
 *   stage: the same `Idempotency-Key` with the same body replays the first
 *   answer instead of writing a second session.
 * - A session started **before** the upload window closed may finish (the
 *   `settings.upload.inflightGraceMinutes` grace); a session whose window was
 *   already closed when it *would have* started is `409 upload_window_closed`
 *   with `details.uploadWindowEndsAt` and `details.canExtend`.
 * - Counters are consumed against the **event's** tenant (the `{tenantId}`
 *   path segment), never the uploader's own workspace: a co-organizer who owns
 *   another tenant moves only the event tenant's `storage.bytes` /
 *   `images.per_event`, and is refused with the **event tenant's** limit.
 * - The completion enqueues the pipeline work item through the memoized
 *   `getWorkQueue()` composition root (`@/server/queue/get-work-queue`) so the
 *   broker stays swappable and the item's `processing.queueRef` is the only
 *   place a broker id appears.
 *
 * ## Storage is the object's source of truth (I1, I2, I8, I9)
 *
 * The suite boots `STORAGE_PROVIDER=s3` pointed at MSW, so the completion can
 * only learn the stored size and the stored bytes from a real `HeadObject` /
 * object read. The mock answers `HEAD`, `GET` (whole object or `Range`) and
 * `DELETE` over `bkt-a1/images/<hash>.<ext>`, and records every deletion.
 *
 * ## Assumptions (ADR-0720 §Assumptions)
 *
 * - A1 — `images.per_event` is `scope: "event"`, so its usage is the event's
 *   own `counters.imageCount` (the entitlement service never writes a
 *   `usageCounters` row for a non-tenant scope). `storage.bytes` is
 *   `scope: "tenant"` and does write one.
 * - A2 — `events.sequence` is the **next** sequence to issue (creation seeds
 *   `1` with zero images, contract §4.1), so the first image is `sequence: 1`
 *   and the counter is left at `2` — the same rule U2 pins.
 * - A3 — a `batchId` fixture is a 24-hex id, so `String(row.uploadBatchId)`
 *   matches it whether the implementation stores an `ObjectId` (schema §16.3)
 *   or the client's string.
 * - A4 — `409 size_mismatch` is a **new** media error code the GREEN owes the
 *   catalogue and the contracts union, in the append-only per-domain shape
 *   ADR-0540/ADR-0701 established.
 * - A5 — the object-key extension is derived from the session's declared MIME
 *   (`image/heic` → `.heic`), the same rule ADR-0701 A5 uses for resume.
 * - A6 — ownership of a session is **not** an authorization gate: any admitted
 *   event actor may complete it (the object is content-addressed, so the hash
 *   is the identity). Out of scope here, recorded for the review.
 */

/** The collection the schema calls `uploadSessions` (§16.2). */
const UPLOAD_SESSIONS = COLLECTIONS.uploadSessions;

/** The bucket `originals` resolves to in the storage runtime wiring. */
const ORIGINALS_BUCKET = TEST_STORAGE_BUCKETS.originals ?? "bkt-a1";

/** The ETag the mocked storage answers for every object it holds. */
const STORED_ETAG = '"op124-etag"';

/** The transfer ceiling from contract §5.1, used by the settings bound case. */
const MAX_FILE_BYTES = 104_857_600;

/** The single-PUT presign TTL from contract §5.1 (seconds). */
const PRESIGN_TTL_SECONDS = 900;

/** The session TTL the schema fixes at five days. */
const SESSION_TTL_MS = 5 * 86_400_000;

/** A deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op124-${name}`).digest("hex");
}

const HASH_HAPPY = hashFor("happy");
const HASH_MISMATCH = hashFor("mismatch");
const HASH_OVER_LIMIT = hashFor("over-limit");
const HASH_CONCURRENT = hashFor("concurrent");
const HASH_LINKED = hashFor("linked");
const HASH_ENQUEUE_FAILS = hashFor("enqueue-fails");
const HASH_GRACE = hashFor("grace");
const HASH_LATE = hashFor("late");
const HASH_ZIP = hashFor("zip-as-jpeg");
const HASH_HEIC = hashFor("heic");
const HASH_CO_ORGANIZER = hashFor("co-organizer");
const HASH_CO_ORGANIZER_LIMIT = hashFor("co-organizer-limit");
const HASH_AUTH = hashFor("auth");

/** The happy path's declared/stored size. */
const HAPPY_BYTES = 8_192;

/** A declared size whose 1 % tolerance is exactly one hundred bytes. */
const DECLARED_BYTES = 10_000;

/** A stored size 4 % above the declaration — well past the 1 % tolerance. */
const STORED_TOO_LARGE = 10_400;

/** A storage tenant limit, and a file one byte larger than it. */
const SMALL_STORAGE_LIMIT = 1_000_000;
const OVER_LIMIT_BYTES = 1_000_001;

/** A roomy storage limit for the cases that must not hit the ceiling. */
const ROOMY_STORAGE_LIMIT = 10_000_000_000;

/** Small incompressible body sizes for the remaining cases. */
const SMALL_BYTES = 4_096;
const ZIP_BYTES = 512;
const HEIC_BYTES = 640;

/** A JPEG magic prefix — `FF D8 FF`. */
const JPEG_PREFIX = [0xff, 0xd8, 0xff] as const;

/** A ZIP magic prefix — `PK\x03\x04`, i.e. a JPEG claim that is really an archive. */
const ZIP_PREFIX = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * Build deterministic bytes that start with `prefix`.
 *
 * The guard reads only the leading bytes; the tail exists so the mocked
 * `HeadObject` can answer a realistic `Content-Length`.
 */
function makeBytes(size: number, prefix: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix, 0);
  for (let index = prefix.length; index < size; index += 1) {
    bytes[index] = (index * 31) % 251;
  }
  return bytes;
}

/** A HEIC header: an ISO-BMFF `ftyp` box with the `heic` major brand. */
function makeHeicBytes(size: number): Uint8Array {
  const bytes = makeBytes(size, [0x00, 0x00, 0x00, 0x18]);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  bytes.set([0x68, 0x65, 0x69, 0x63], 8); // "heic"
  return bytes;
}

/** One object the mocked storage holds. */
interface MockObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** The objects the mocked storage holds, keyed by content hash. */
const storedObjects = new Map<string, MockObject>();

/** The content hashes whose object the API deleted, in call order. */
const deletedHashes: string[] = [];

/** The URL every content-addressed original is addressed by. */
const OBJECT_URL = new RegExp(`/${ORIGINALS_BUCKET}/images/[0-9a-f]{64}\\.[a-z]+`);

/** The hash inside an object URL, or `null` when the path holds none. */
function hashOfUrl(url: string): string | null {
  const match = /\/images\/([0-9a-f]{64})\./.exec(new URL(url).pathname);
  return match === null ? null : (match[1] ?? null);
}

/** Store an object the mocked storage answers for. */
function storeObject(hash: string, bytes: Uint8Array, contentType: string): void {
  storedObjects.set(hash, { bytes, contentType });
}

/** The `Range` header split into inclusive bounds over an object of `length`. */
function rangeOf(
  range: string | null,
  length: number
): { start: number; end: number; partial: boolean } {
  const parsed = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
  if (parsed === null) {
    return { start: 0, end: length - 1, partial: false };
  }
  return {
    start: Number(parsed[1] ?? "0"),
    end: Math.min(Number(parsed[2] ?? String(length - 1)), length - 1),
    partial: true,
  };
}

/** Install the mocked S3 surface: `HeadObject`, object reads and `DeleteObject`. */
function installStorageMock(): void {
  server.use(
    http.head(OBJECT_URL, ({ request }) => {
      const hash = hashOfUrl(request.url);
      const object = hash === null ? undefined : storedObjects.get(hash);
      if (object === undefined) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(null, {
        status: 200,
        headers: {
          "content-length": String(object.bytes.byteLength),
          "content-type": object.contentType,
          etag: STORED_ETAG,
        },
      });
    }),
    http.get(OBJECT_URL, ({ request }) => {
      const hash = hashOfUrl(request.url);
      const object = hash === null ? undefined : storedObjects.get(hash);
      if (object === undefined) {
        return new HttpResponse(null, { status: 404 });
      }
      const { start, end, partial } = rangeOf(
        request.headers.get("range"),
        object.bytes.byteLength
      );
      const slice = object.bytes.slice(start, end + 1);
      return new HttpResponse(slice, {
        status: partial ? 206 : 200,
        headers: {
          "content-length": String(slice.byteLength),
          "content-type": object.contentType,
          etag: STORED_ETAG,
        },
      });
    }),
    http.delete(OBJECT_URL, ({ request }) => {
      const hash = hashOfUrl(request.url);
      if (hash !== null) {
        deletedHashes.push(hash);
        storedObjects.delete(hash);
      }
      return new HttpResponse(null, { status: 204 });
    })
  );
}

let app: TestApp;

/** The log sink the file reads, so a pin can assert what was and was not logged. */
let logSink: MemoryTransport;

beforeAll(async () => {
  app = await startTestApp({
    prefix: "op124-single-put",
    env: {
      STORAGE_PROVIDER: "s3",
      QUEUE_PROVIDER: "memory",
      R2_ENDPOINT: TEST_STORAGE_ENDPOINT,
      R2_REGION: "auto",
      R2_ACCESS_KEY_ID: "op124-test-access-key",
      R2_SECRET_ACCESS_KEY: "op124-test-secret-key",
      R2_BUCKET_ORIGINALS: TEST_STORAGE_BUCKETS.originals,
      R2_BUCKET_THUMBNAILS: TEST_STORAGE_BUCKETS.thumbnails,
      R2_BUCKET_EXPORTS: TEST_STORAGE_BUCKETS.exports,
      R2_BUCKET_BRANDING: TEST_STORAGE_BUCKETS.branding,
    },
  });
  await ensureIndexes(app.db);
  logSink = memoryTransport();
  setLogger(
    createLogger({ level: "trace", transports: [logSink], service: "openpic-web", env: "test" })
  );
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
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
  storedObjects.clear();
  deletedHashes.length = 0;
  logSink.clear();
  installStorageMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read one route export off a namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "POST",
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const uploadParams = requireHandler(paramsRouteModule, "POST", "…/events/:eventId/uploads/params");
const uploadComplete = requireHandler(
  completeRouteModule,
  "POST",
  "…/events/:eventId/uploads/:uploadSessionId/complete"
);
const uploadLink = requireHandler(linkRouteModule, "POST", "…/events/:eventId/uploads:link");

/** A fresh UUIDv4 for the idempotency header. */
function idempotencyKey(): string {
  return randomUUID();
}

/** A `batchId` in the 24-hex shape the contract accepts. */
function batchId(): string {
  return new ObjectId().toHexString();
}

/** The §5.3 `params` body for one file. */
interface ParamsBody {
  readonly batchId: string;
  readonly hash: string;
  readonly size: number;
  readonly fileName: string;
  readonly mimeType: string;
}

/** A `params` claim whose extension and MIME agree (the happy-path file). */
function claimFor(hash: string, overrides: Partial<ParamsBody> = {}): ParamsBody {
  return {
    batchId: batchId(),
    hash,
    size: HAPPY_BYTES,
    fileName: "DSC_0421.JPG",
    mimeType: "image/jpeg",
    ...overrides,
  };
}

/** A JSON `POST` carrying the caller's session cookie. */
function jsonPost(path: string, cookie: string, payload: unknown, key?: string): Request {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (key !== undefined) {
    headers["idempotency-key"] = key;
  }
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

/** The `params` path for one event. */
function paramsPath(tenantKey: string, eventId: ObjectId): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads/params`;
}

/** The `complete` path for one session. */
function completePath(tenantKey: string, eventId: ObjectId, sessionId: string): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads/${sessionId}/complete`;
}

/** The `:link` path for one event. */
function linkPath(tenantKey: string, eventId: ObjectId): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads:link`;
}

/** A `POST …/uploads/params` request. */
function paramsRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  claim: ParamsBody,
  key: string = idempotencyKey()
): Request {
  return jsonPost(paramsPath(tenantKey, eventId), cookie, claim, key);
}

/** A `POST …/uploads/{id}/complete` request. */
function completeRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  sessionId: string,
  payload: { readonly etag: string; readonly bytes: number },
  key: string = idempotencyKey()
): Request {
  return jsonPost(completePath(tenantKey, eventId, sessionId), cookie, payload, key);
}

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

/** The §5.3 `params` answer. */
interface ParamsAnswer {
  readonly uploadSessionId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
  readonly completeUrl: string;
}

/** Read a response header from a case-insensitive map. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry === undefined ? undefined : entry[1];
}

/** The `EventImage` DTO the completion answers with. */
interface EventImageAnswer {
  readonly id: string;
  readonly assetId: string;
  readonly sequence: number;
  readonly bytes: number;
  readonly contentType: string;
  readonly visibility: string;
  readonly faceCount: number;
  readonly processing: Record<string, unknown>;
  readonly uploadedByUserId: string;
  readonly uploadBatchId: unknown;
}

/** The `uploads:link` answer. */
interface LinkAnswer {
  readonly linked: readonly { readonly assetId: string; readonly eventImageId: string }[];
  readonly skipped: readonly string[];
}

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP124 Studio",
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
        slug: `op124${_id.toHexString().slice(-8)}`,
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
  const tenantId = await insertTenant(`op124-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Record an `event_organizers` row for a co-organizer of another workspace. */
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
    imageMeta: {},
    status: "stored",
    refCount: 1,
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

/** Insert the `event_images` join row an upload or a link creates (schema §16.3). */
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

/** Insert a pending `upload_sessions` row the route must find and complete (§16.2). */
async function seedSession(fields: {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly contentHash: string;
  readonly createdByUserId: ObjectId;
  readonly createdAt?: Date;
  readonly batchId?: string;
  readonly status?: string;
  readonly declaredSize?: number;
  readonly declaredMimeType?: string;
  readonly fileName?: string;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  const createdAt = fields.createdAt ?? new Date();
  await app.db.collection(UPLOAD_SESSIONS).insertOne({
    _id,
    tenantId: fields.tenantKey,
    eventId: fields.eventId,
    createdByUserId: fields.createdByUserId,
    contentHash: fields.contentHash,
    batchId: fields.batchId ?? batchId(),
    mode: "single",
    status: fields.status ?? "pending",
    fileName: fields.fileName ?? "DSC_0421.JPG",
    declaredSize: fields.declaredSize ?? HAPPY_BYTES,
    declaredMimeType: fields.declaredMimeType ?? "image/jpeg",
    externalRefs: [],
    assetId: null,
    createdAt,
    updatedAt: createdAt,
    expireAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
  });
  return _id;
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

/** Read the event row's counters and sequence. */
async function readEvent(
  eventId: ObjectId
): Promise<{ counters: Record<string, number>; sequence: number }> {
  const row = (await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId })) as
    | (Document & {
        counters?: Record<string, number>;
        sequence?: number;
      })
    | null;
  if (row === null) {
    throw new Error("expected the seeded event to exist");
  }
  return { counters: row.counters ?? {}, sequence: row.sequence ?? 0 };
}

/** The tenant's `storage.bytes` counter value, or `0` when it has no row. */
async function readStorageCounter(tenantKey: string): Promise<number> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: tenantKey, entitlementKey: "storage.bytes" });
  if (row === null) {
    return 0;
  }
  const value: unknown = row.value;
  return typeof value === "number" ? value : 0;
}

/** The envelopes currently sitting on the image queue, claimed for inspection. */
async function queuedEnvelopes(): Promise<readonly Record<string, unknown>[]> {
  const claimed = await getWorkQueue().claim("q:image", 500);
  return claimed.map((message) => message.envelope as unknown as Record<string, unknown>);
}

/** The durable pipeline state of an `event_images` row (schema §18.2). */
interface ProcessingState {
  readonly status?: string;
  readonly attempts?: number;
  readonly queueRef?: {
    readonly queueKey?: string;
    readonly provider?: string;
    readonly messageId?: string;
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
  readonly processing: ProcessingState;
  readonly uploadBatchId: unknown;
}

/** The single `event_images` row of an event, or `null`. */
async function readEventImage(eventId: ObjectId): Promise<EventImageRow | null> {
  const rows = await app.db.collection(COLLECTIONS.eventImages).find({ eventId }).toArray();
  return rows.length === 1 ? (rows[0] as unknown as EventImageRow) : null;
}

describe("POST …/uploads/params — the single-PUT presign (I1, contract §5.3)", () => {
  it("I1: answers 201 with an opaque presigned PUT and no bucket, key or location field", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-params");
    const claim = claimFor(HASH_HAPPY);

    // Act
    const before = Date.now();
    const response = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const after = Date.now();

    // Assert — the §5.3 envelope, and nothing else.
    expect(response.status).toBe(201);
    const answer = (await body(response)) as unknown as ParamsAnswer;
    expect(Object.keys(answer).sort()).toEqual([
      "completeUrl",
      "expiresAt",
      "headers",
      "method",
      "uploadSessionId",
      "url",
    ]);
    expect(answer.method).toBe("PUT");
    expect(headerOf(answer.headers, "content-type")).toBe("image/jpeg");
    expect(answer.completeUrl).toBe(
      completePath(workspace.tenantKey, workspace.eventId, answer.uploadSessionId)
    );
    expect(answer.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresAtMs = Date.parse(answer.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + PRESIGN_TTL_SECONDS * 1_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + PRESIGN_TTL_SECONDS * 1_000);
    // §0.15 — no `bucket`, `objectKey`, `locationKey` or upstream `_id` field.
    expect(findForbiddenFields(answer, "default")).toEqual([]);

    // The session the completion will read.
    const session = await app.db
      .collection(UPLOAD_SESSIONS)
      .findOne({ _id: new ObjectId(answer.uploadSessionId) });
    expect(session).toMatchObject({
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId,
      createdByUserId: workspace.organizer.userId,
      contentHash: HASH_HAPPY,
      mode: "single",
      status: "pending",
      declaredSize: HAPPY_BYTES,
      declaredMimeType: "image/jpeg",
    });
    expect(String(session?.batchId)).toBe(claim.batchId);
  });

  it("X1: a repeated params call with the same idempotency key reuses one session", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-params-replay");
    const claim = claimFor(HASH_HAPPY);
    const key = idempotencyKey();

    // Act
    const first = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim, key)
    );
    const second = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim, key)
    );

    // Assert — §0.9: a replay is served as `200`, never the original `201` (a
    // client must not mistake a replay for a resource created by *this* call),
    // with the stored body verbatim, and no second session row.
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstAnswer = (await body(first)) as unknown as ParamsAnswer;
    const secondAnswer = (await body(second)) as unknown as ParamsAnswer;
    expect(secondAnswer.uploadSessionId).toBe(firstAnswer.uploadSessionId);
    const sessions = await app.db
      .collection(UPLOAD_SESSIONS)
      .countDocuments({ contentHash: HASH_HAPPY });
    expect(sessions).toBe(1);
  });

  it("X2: a claim above the configured ceiling is 413 file_too_large and writes no session", async () => {
    // Arrange — the ceiling is a runtime setting, not a constant.
    const workspace = await seedWorkspace("op124-params-too-large");
    await app.db.collection<Document & { readonly _id: string }>("platformSettings").insertOne({
      _id: "singleton",
      ...PLATFORM_SETTINGS_DEFAULTS,
      updatedAt: new Date().toISOString(),
      updatedByUserId: null,
    });
    invalidatePlatformSettings();

    // Act
    const response = await uploadParams(
      paramsRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_AUTH, { size: MAX_FILE_BYTES + 1 })
      )
    );

    // Assert
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("file_too_large");
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(0);
  });

  it("X3: the presigned URL is never logged", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-params-logs");

    // Act
    const response = await uploadParams(
      paramsRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_HAPPY)
      )
    );
    const answer = (await body(response)) as unknown as ParamsAnswer;

    // Assert — the URL is a bearer credential for the object; nothing may record it.
    const logged = JSON.stringify(logSink.entries);
    expect(response.status).toBe(201);
    expect(answer.url).toContain("X-Amz-Signature");
    expect(logged).not.toContain(answer.url);
    expect(logged).not.toContain("X-Amz-Signature");
    expect(logged).not.toContain("X-Amz-Credential");
  });
});

describe("POST …/uploads/{id}/complete — the registration transaction (I1, contract §5.3)", () => {
  it("I1: HeadObject then one transaction writes the asset, the image, the counters and the session", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-complete");
    await seedPlanFor(workspace.tenantKey, "op124-roomy", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
      "images.per_event": makeEntitlement({
        limit: 5_000,
        scope: "event",
        resetPeriod: "none",
      }),
    });
    const claim = claimFor(HASH_HAPPY);
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_HAPPY, makeBytes(HAPPY_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: HAPPY_BYTES,
        }
      )
    );

    // Assert — the DTO the gallery will render.
    expect(response.status).toBe(201);
    const image = (await body(response)) as unknown as EventImageAnswer;
    expect(image.sequence).toBe(1);
    expect(image.bytes).toBe(HAPPY_BYTES);
    expect(image.contentType).toBe("image/jpeg");
    expect(image.visibility).toBe("visible");
    expect(image.faceCount).toBe(0);
    expect(image.processing.status).toBe("queued");
    expect(image.uploadedByUserId).toBe(workspace.organizer.userId.toHexString());
    expect(String(image.uploadBatchId)).toBe(claim.batchId);
    expect(findForbiddenFields(image, "default")).toEqual([]);

    // The asset row (schema §16.1): content-addressed, tenant-scoped, refCount 1.
    const asset = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash: HASH_HAPPY });
    expect(asset).toMatchObject({
      tenantId: workspace.tenantKey,
      kind: "event_image",
      status: "stored",
      refCount: 1,
      storage: {
        locationKey: "originals",
        objectKey: `images/${HASH_HAPPY}.jpg`,
        bytes: HAPPY_BYTES,
        contentType: "image/jpeg",
      },
    });
    expect(asset?._id.toHexString()).toBe(image.assetId);

    // The join row (schema §16.3) and the DTO's id are the same document.
    const eventImage = await readEventImage(workspace.eventId);
    expect(eventImage).toMatchObject({
      tenantId: workspace.tenantKey,
      assetId: asset?._id,
      uploadedByUserId: workspace.organizer.userId,
      sequence: 1,
      visibility: "visible",
      faceCount: 0,
    });
    expect(String(eventImage?.processing.status)).toBe("queued");
    expect(eventImage?._id.toHexString()).toBe(image.id);

    // Counters: the event's own figures, the tenant's metered storage, the
    // sequence counter advanced past the number just issued.
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(event.counters.storageBytes).toBe(HAPPY_BYTES);
    expect(event.sequence).toBe(2);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(HAPPY_BYTES);

    // The session is closed and points at the asset it produced.
    const session = await app.db
      .collection(UPLOAD_SESSIONS)
      .findOne({ _id: new ObjectId(uploadSessionId) });
    expect(session).toMatchObject({ status: "completed", assetId: asset?._id });

    // The pipeline work item is queued as a pointer, and the row records it.
    const envelopes = await queuedEnvelopes();
    const queued = envelopes.filter((envelope) => envelope.id === image.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "event_image",
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId.toHexString(),
      priority: "normal",
    });
    expect(eventImage?.processing.queueRef).toMatchObject({ provider: "memory" });
  });

  it("I2: a stored size past the 1 % tolerance is 409 size_mismatch and nothing is written", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-mismatch");
    const claim = claimFor(HASH_MISMATCH, { size: DECLARED_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_MISMATCH, makeBytes(STORED_TOO_LARGE, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: DECLARED_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("size_mismatch");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(0);
    expect(event.sequence).toBe(1);
    const session = await app.db
      .collection(UPLOAD_SESSIONS)
      .findOne({ _id: new ObjectId(uploadSessionId) });
    expect(session).toMatchObject({ status: "pending", assetId: null });
  });

  it("I3: over the tenant's storage limit is 403 plan_limit_exceeded and nothing is written", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-over-limit");
    await seedPlanFor(workspace.tenantKey, "op124-small-storage", {
      "storage.bytes": makeEntitlement({
        limit: SMALL_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    const claim = claimFor(HASH_OVER_LIMIT, { size: OVER_LIMIT_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_OVER_LIMIT, makeBytes(OVER_LIMIT_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: OVER_LIMIT_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("plan_limit_exceeded");
    expect(error.details?.entitlementKey).toBe("storage.bytes");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    const session = await app.db
      .collection(UPLOAD_SESSIONS)
      .findOne({ _id: new ObjectId(uploadSessionId) });
    expect(session).toMatchObject({ status: "pending" });
  });

  it("I4: a completion for an asset the event already holds is 200 with that image and charges nothing", async () => {
    // Arrange — the same bytes are already in this event (a co-organizer's
    // duplicate upload). The unique `{eventId, assetId}` index is the arbiter:
    // the transaction's writes must roll back and the caller gets the existing
    // image, never `409 duplicate_in_event` and never a second charge.
    const workspace = await seedWorkspace("op124-duplicate");
    await seedPlanFor(workspace.tenantKey, "op124-duplicate-roomy", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    const assetId = await seedAsset(workspace.tenantKey, HASH_CONCURRENT, SMALL_BYTES);
    const existingImageId = await seedEventImage(
      workspace.tenantKey,
      workspace.eventId,
      assetId,
      workspace.organizer.userId
    );
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne(
        { _id: workspace.eventId },
        { $set: { sequence: 2, "counters.imageCount": 1, "counters.storageBytes": SMALL_BYTES } }
      );
    const claim = claimFor(HASH_CONCURRENT, { size: SMALL_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_CONCURRENT, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: SMALL_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(200);
    const image = (await body(response)) as unknown as EventImageAnswer;
    expect(image.id).toBe(existingImageId.toHexString());
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(1);
    const asset = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: assetId });
    expect(asset).toMatchObject({ refCount: 1 });
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(event.sequence).toBe(2);
  });

  it("I4: two concurrent completions of one asset leave exactly one image and one charge", async () => {
    // Arrange — one session, two completion attempts with distinct keys. The
    // loser's status is deliberately not pinned (a retried transaction may see
    // the winner and answer `200`, or the unique index may answer `409`-shaped
    // until it re-reads); what must hold is the committed state and the fact
    // that the duplicate is never an error.
    const workspace = await seedWorkspace("op124-concurrent");
    await seedPlanFor(workspace.tenantKey, "op124-concurrent-roomy", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    const claim = claimFor(HASH_CONCURRENT, { size: SMALL_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_CONCURRENT, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const [first, second] = await Promise.all([
      uploadComplete(
        completeRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          uploadSessionId,
          {
            etag: STORED_ETAG,
            bytes: SMALL_BYTES,
          }
        )
      ),
      uploadComplete(
        completeRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          uploadSessionId,
          {
            etag: STORED_ETAG,
            bytes: SMALL_BYTES,
          }
        )
      ),
    ]);

    // Assert — the duplicate is idempotent by design (§16.3), never a `409`.
    expect([first.status, second.status]).not.toContain(409);
    expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(1);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(1);
    const asset = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash: HASH_CONCURRENT });
    expect(asset).toMatchObject({ refCount: 1 });
    expect(await readStorageCounter(workspace.tenantKey)).toBe(SMALL_BYTES);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(event.sequence).toBe(2);
  });

  it("I6: an enqueue failure after the commit keeps the item queued and the upload successful", async () => {
    // Arrange — the broker refuses, which must never fail the user's upload.
    const workspace = await seedWorkspace("op124-enqueue");
    const claim = claimFor(HASH_ENQUEUE_FAILS, { size: SMALL_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_ENQUEUE_FAILS, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");
    vi.spyOn(getWorkQueue(), "enqueue").mockRejectedValue(new Error("broker down"));

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: SMALL_BYTES,
        }
      )
    );

    // Assert — committed state survives, the item stays claimable work.
    expect(response.status).toBe(201);
    const image = (await body(response)) as unknown as EventImageAnswer;
    const eventImage = await readEventImage(workspace.eventId);
    expect(eventImage?._id.toHexString()).toBe(image.id);
    expect(eventImage?.processing.status).toBe("queued");
    expect(eventImage?.processing.queueRef).toBeUndefined();
    expect(await readStorageCounter(workspace.tenantKey)).toBe(SMALL_BYTES);
    expect(logSink.entries.some((entry) => entry.event === "queue.enqueue_failed")).toBe(true);
  });

  it("I8: a .jpg whose bytes are a ZIP is 415, the object is deleted and the counters are untouched", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-zip");
    const claim = claimFor(HASH_ZIP, { size: ZIP_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_ZIP, makeBytes(ZIP_BYTES, ZIP_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: ZIP_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(415);
    const error = await errorOf(response);
    expect(error.code).toBe("unsupported_media_type");
    expect(Array.isArray(error.details?.supportedMimeTypes)).toBe(true);
    expect(deletedHashes).toContain(HASH_ZIP);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(0);
    expect(event.sequence).toBe(1);
  });

  it("I9: a HEIC upload is accepted and stored under its own extension", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-heic");
    const claim = claimFor(HASH_HEIC, {
      size: HEIC_BYTES,
      fileName: "IMG_0001.HEIC",
      mimeType: "image/heic",
    });
    const paramsResponse = await uploadParams(
      paramsRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_HEIC, makeHeicBytes(HEIC_BYTES), "image/heic");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        uploadSessionId,
        {
          etag: STORED_ETAG,
          bytes: HEIC_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(201);
    const image = (await body(response)) as unknown as EventImageAnswer;
    expect(image.contentType).toBe("image/heic");
    const asset = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash: HASH_HEIC });
    expect(asset).toMatchObject({
      status: "stored",
      refCount: 1,
      storage: { objectKey: `images/${HASH_HEIC}.heic`, contentType: "image/heic" },
    });
  });
});

describe("POST …/uploads:link — attaching without bytes (I5)", () => {
  it("I5: attaches an unstored asset and increments its refCount without touching storage", async () => {
    // Arrange — the bytes already exist; only the event link is missing.
    const workspace = await seedWorkspace("op124-link");
    await seedPlanFor(workspace.tenantKey, "op124-link-roomy", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
      "images.per_event": makeEntitlement({ limit: 5_000, scope: "event", resetPeriod: "none" }),
    });
    const assetId = await seedAsset(workspace.tenantKey, HASH_LINKED, SMALL_BYTES);
    const uploadBatchId = batchId();

    // Act
    const response = await uploadLink(
      jsonPost(linkPath(workspace.tenantKey, workspace.eventId), workspace.organizer.cookie, {
        batchId: uploadBatchId,
        assetIds: [assetId.toHexString()],
      })
    );

    // Assert
    expect(response.status).toBe(201);
    const answer = (await body(response)) as unknown as LinkAnswer;
    expect(answer.skipped).toEqual([]);
    expect(answer.linked).toHaveLength(1);
    const link = answer.linked[0];
    expect(link?.assetId).toBe(assetId.toHexString());
    expect(findForbiddenFields(answer, "default")).toEqual([]);

    const eventImage = await readEventImage(workspace.eventId);
    expect(eventImage).toMatchObject({
      assetId,
      uploadedByUserId: workspace.organizer.userId,
      sequence: 1,
      visibility: "visible",
    });
    expect(eventImage?._id.toHexString()).toBe(link?.eventImageId);
    expect(String(eventImage?.uploadBatchId)).toBe(uploadBatchId);

    const asset = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: assetId });
    expect(asset).toMatchObject({ refCount: 2 });
    // No bytes moved, so the tenant's metered storage must not move either.
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(event.sequence).toBe(2);

    // A second link of the same asset is skipped, never a duplicate row.
    const again = await uploadLink(
      jsonPost(linkPath(workspace.tenantKey, workspace.eventId), workspace.organizer.cookie, {
        batchId: uploadBatchId,
        assetIds: [assetId.toHexString()],
      })
    );
    expect(again.status).toBe(201);
    const repeat = (await body(again)) as unknown as LinkAnswer;
    expect(repeat.linked).toEqual([]);
    expect(repeat.skipped).toEqual([assetId.toHexString()]);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(1);
  });

  it("I5: an asset this tenant does not hold is skipped, never an oracle", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-link-foreign");
    const other = await seedWorkspace("op124-link-other");
    const foreignAssetId = await seedAsset(other.tenantKey, hashFor("foreign-asset"), SMALL_BYTES);

    // Act
    const response = await uploadLink(
      jsonPost(linkPath(workspace.tenantKey, workspace.eventId), workspace.organizer.cookie, {
        batchId: batchId(),
        assetIds: [foreignAssetId.toHexString()],
      })
    );

    // Assert
    expect(response.status).toBe(201);
    const answer = (await body(response)) as unknown as LinkAnswer;
    expect(Object.keys(answer).sort()).toEqual(["linked", "skipped"]);
    expect(answer.linked).toEqual([]);
    expect(answer.skipped).toEqual([foreignAssetId.toHexString()]);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);
  });
});

describe("the upload window (I7, contract §5.2 / §5.3)", () => {
  it("I7: a new session after the window closed is 409 upload_window_closed", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-window-closed");
    const closedAt = new Date(Date.now() - 20 * 60_000);
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: workspace.eventId }, { $set: { uploadWindowEndsAt: closedAt } });

    // Act
    const response = await uploadParams(
      paramsRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_LATE)
      )
    );

    // Assert
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("upload_window_closed");
    expect(error.details?.uploadWindowEndsAt).toBe(closedAt.toISOString());
    expect(error.details?.canExtend).toBe(true);
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(0);
  });

  it("I7: a session started before the close still completes inside the grace period", async () => {
    // Arrange — the window closed twenty minutes ago, the session is older.
    const workspace = await seedWorkspace("op124-window-grace");
    const closedAt = new Date(Date.now() - 20 * 60_000);
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: workspace.eventId }, { $set: { uploadWindowEndsAt: closedAt } });
    const sessionId = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_GRACE,
      createdByUserId: workspace.organizer.userId,
      createdAt: new Date(closedAt.getTime() - 60 * 60_000),
      declaredSize: SMALL_BYTES,
    });
    storeObject(HASH_GRACE, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        sessionId.toHexString(),
        {
          etag: STORED_ETAG,
          bytes: SMALL_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(201);
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(1);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
  });

  it("I7: a session created after the close cannot complete", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-window-late");
    const closedAt = new Date(Date.now() - 20 * 60_000);
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: workspace.eventId }, { $set: { uploadWindowEndsAt: closedAt } });
    const sessionId = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_LATE,
      createdByUserId: workspace.organizer.userId,
      createdAt: new Date(closedAt.getTime() + 60_000),
      declaredSize: SMALL_BYTES,
    });
    storeObject(HASH_LATE, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        sessionId.toHexString(),
        {
          etag: STORED_ETAG,
          bytes: SMALL_BYTES,
        }
      )
    );

    // Assert
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("upload_window_closed");
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);
  });
});

describe("billing follows the event's tenant (I10, I11)", () => {
  it("I10: a co-organizer from another tenant moves only the event tenant's counters", async () => {
    // Arrange — the co-organizer owns their own workspace with its own plan.
    const workspace = await seedWorkspace("op124-host");
    await seedPlanFor(workspace.tenantKey, "op124-host-plan", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
      "images.per_event": makeEntitlement({ limit: 5_000, scope: "event", resetPeriod: "none" }),
    });
    const coOrganizer = await app.signIn(makeIdentity("op124-co"));
    const ownTenantId = await insertTenant("op124-co-own", coOrganizer);
    const ownTenantKey = ownTenantId.toHexString();
    await seedPlanFor(ownTenantKey, "op124-co-plan", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);

    const claim = claimFor(HASH_CO_ORGANIZER, { size: SMALL_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(coOrganizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_CO_ORGANIZER, makeBytes(SMALL_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(coOrganizer.cookie, workspace.tenantKey, workspace.eventId, uploadSessionId, {
        etag: STORED_ETAG,
        bytes: SMALL_BYTES,
      })
    );

    // Assert — the event tenant pays; the uploader's own workspace does not.
    expect(response.status).toBe(201);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(SMALL_BYTES);
    expect(await readStorageCounter(ownTenantKey)).toBe(0);
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(
      await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({ tenantId: ownTenantKey })
    ).toBe(0);
    const asset = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash: HASH_CO_ORGANIZER });
    expect(asset).toMatchObject({ tenantId: workspace.tenantKey });
  });

  it("I11: the event tenant's exhausted limit refuses a co-organizer whose own plan has room", async () => {
    // Arrange
    const workspace = await seedWorkspace("op124-host-full");
    await seedPlanFor(workspace.tenantKey, "op124-host-full-plan", {
      "storage.bytes": makeEntitlement({
        limit: SMALL_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    const coOrganizer = await app.signIn(makeIdentity("op124-co-full"));
    const ownTenantId = await insertTenant("op124-co-full-own", coOrganizer);
    const ownTenantKey = ownTenantId.toHexString();
    await seedPlanFor(ownTenantKey, "op124-co-full-plan", {
      "storage.bytes": makeEntitlement({
        limit: ROOMY_STORAGE_LIMIT,
        scope: "tenant",
        resetPeriod: "monthly",
      }),
    });
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);

    const claim = claimFor(HASH_CO_ORGANIZER_LIMIT, { size: OVER_LIMIT_BYTES });
    const paramsResponse = await uploadParams(
      paramsRequest(coOrganizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const { uploadSessionId } = (await body(paramsResponse)) as unknown as ParamsAnswer;
    storeObject(HASH_CO_ORGANIZER_LIMIT, makeBytes(OVER_LIMIT_BYTES, JPEG_PREFIX), "image/jpeg");

    // Act
    const response = await uploadComplete(
      completeRequest(coOrganizer.cookie, workspace.tenantKey, workspace.eventId, uploadSessionId, {
        etag: STORED_ETAG,
        bytes: OVER_LIMIT_BYTES,
      })
    );

    // Assert
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("plan_limit_exceeded");
    expect(error.details?.entitlementKey).toBe("storage.bytes");
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
    expect(await readStorageCounter(ownTenantKey)).toBe(0);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
  });
});

/** The tenant-scoped path of one upload mutation, for the authorization ladder. */
interface LadderRoute {
  readonly name: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly path: (workspace: Workspace) => string;
}

/** The three mutation surfaces, each addressed with a real workspace. */
const LADDER_ROUTES: readonly LadderRoute[] = [
  {
    name: "params",
    handler: uploadParams,
    path: (workspace) => paramsPath(workspace.tenantKey, workspace.eventId),
  },
  {
    name: "complete",
    handler: uploadComplete,
    path: (workspace) =>
      completePath(workspace.tenantKey, workspace.eventId, new ObjectId().toHexString()),
  },
  {
    name: "link",
    handler: uploadLink,
    path: (workspace) => linkPath(workspace.tenantKey, workspace.eventId),
  },
];

/** A `POST` a ladder case sends: a valid-shaped body, so only auth decides. */
function ladderRequest(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey(),
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers,
    body: JSON.stringify({ batchId: batchId(), hash: HASH_AUTH, size: SMALL_BYTES, assetIds: [] }),
  });
}

describe("authorization on the three upload mutations (contract §0.4)", () => {
  it.each(LADDER_ROUTES)("$name answers 401 without a session", async ({ name, handler, path }) => {
    // Arrange
    const workspace = await seedWorkspace(`op124-anon-${name}`);

    // Act
    const response = await handler(ladderRequest(path(workspace)));

    // Assert
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });

  it.each(LADDER_ROUTES)(
    "$name answers 404 for a signed-in stranger",
    async ({ name, handler, path }) => {
      // Arrange — a real session with no relationship to the event. §0.4 says a
      // stranger must never learn that the event exists, so `404`, not `403`.
      const workspace = await seedWorkspace(`op124-stranger-host-${name}`);
      const stranger = await app.signIn(makeIdentity(`op124-stranger-${name}`));

      // Act
      const response = await handler(ladderRequest(path(workspace), stranger.cookie));

      // Assert
      expect(response.status).toBe(404);
    }
  );
});
