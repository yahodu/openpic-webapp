import { createHash, randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as batchStatusRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/batches/[batchId]/route";
import * as completeRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/[uploadSessionId]/complete/route";
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { runNotificationFanOut } from "@/server/notifications/fan-out";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { mongoRecipientRepository } from "@/server/repos/notification-recipients";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";
import { checkUploadBatchTransition } from "@/server/uploads/batch-notifications";
import type { Entitlement } from "@/server/plans/plans";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
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
 * Integration / contract — batch status and the upload lifecycle notifications
 * (OP-126 I1–I4, contract §5.5, notification design §4.7; ADR-0760).
 *
 * The user story: *as an organizer, I want batch progress and a single summary
 * notification so that I know how many photos landed, failed or were skipped.*
 * The batch is the client-generated `batchId` of §5.2, so one drag-and-drop of
 * 500 files is one batch, whichever organizers contributed to it.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // GET /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batches/{batchId}
 * // auth `user` + event member, rate `read.normal`, event id FOUR segments
 * // from the end, 200 with §5.5's body and nothing else:
 * {
 *   batchId, phase, createdAt, completedAt,
 *   files:   { total, uploaded, duplicatesSkipped, rejected, failedUpload },
 *   pipeline:{ queued, processing, done, failed },
 *   failures:[{ eventImageId, fileName, code, message, retryable }],
 *   stalledSessions:[{ uploadSessionId, fileName, uploadedBytes, totalBytes, abortDeadline }]
 * }
 *
 * // @/server/uploads/batch-notifications
 * export function checkUploadBatchTransition(input: {
 *   readonly db?: Db;
 *   readonly tenantKey: string;
 *   readonly eventId: ObjectId;
 *   readonly batchId: string;
 * }): Promise<{ readonly phase: UploadBatchPhase }>;
 * ```
 *
 * ## Where each fact comes from (ADR-0760 D3)
 *
 * - `files.total` is the batch's `upload_sessions` count (one session per file a
 *   client asked to transfer); `files.uploaded` is the `event_images` rows the
 *   batch landed; `failedUpload` is a session that never completed;
 *   `duplicatesSkipped` is a completion that found the event already holding the
 *   asset; `rejected` is a claim `batch-resolve` refused. **A rejection is not a
 *   failure** — §5.5 prints `rejected` beside `failedUpload`, and §4.7 defines
 *   `completed` as "zero failures" while rejections are folded into the same
 *   summary.
 * - `pipeline` is the batch's `event_images[].processing.status` tally:
 *   `queued`, `processing`, `done`, `failed`.
 * - `createdAt` is the batch's earliest session `createdAt`; `completedAt` is
 *   the instant the phase became terminal, `null` while it is not.
 * - `failures[]` is one entry per `failed` image: `code` and `message` come from
 *   `@/server/uploads/batch-status`'s mapper (never from the stored
 *   `processing.lastError.message`), `fileName` from the session of that
 *   content hash (§16.2's display field).
 * - `stalledSessions[]` is empty for a batch whose sessions all finished; the
 *   24-hour idle sweep is OP-136's, so no live `ListParts` runs on this read.
 *
 * ## The three notification couplings §5.5 enforces server-side
 *
 * - `upload.batch.completed` / `upload.batch.completed_with_errors` are emitted
 *   **once per batch per uploader** — the dedupe key is batch-scoped **and**
 *   uploader-scoped, so a batch two organizers uploaded together produces one
 *   summary for each of them (I4) and never a second one for the same pair (I1).
 * - The payload carries the batch's `fileCount` and `durationMs` (measured from
 *   the earliest session to the check), because the fan-out applies §4.7's
 *   "email only if ≥100 files or >10 min" rule from those two facts, and the
 *   `files` block itself, so the one summary is the whole story.
 * - `upload.blocked.quota` goes to the **uploader and the organizer** in one
 *   emission: the uploader is the event's subject (a subject always hears its
 *   own outcome) and the organizer is resolved from the event's ORGANIZERS
 *   audience, because only the organizer can buy storage (I3). It is throttled
 *   to one per event per six hours (X5).
 *
 * ## Assumptions (ADR-0760 §Assumptions)
 *
 * - A1 — a completion leaves its own image `queued`, so the complete endpoints
 *   can never observe a terminal batch on their own; the terminal transition is
 *   observed where §5.5's coupling says it also runs, the indexed check. This
 *   suite drives that check directly (the seam OP-136's cron calls) and never
 *   asserts *where* else it is invoked.
 * - A2 — the fan-out's recipient port reads the `eventMembers` collection (the
 *   membership read is not in `COLLECTIONS` yet, ADR-0090's known gap), so the
 *   organizer audience is seeded there; admission still reads
 *   `event_organizers`, and both are seeded.
 * - A3 — `durationMs` is measured against the wall clock at the check, so the
 *   12-minute-old batch is pinned as a window rather than a millisecond.
 * - A4 — an empty batch (no session yet) is `complete` with no summary: a
 *   client polling a `batchId` it has not used must not produce a notification.
 */

/** The collection the schema calls `uploadSessions` (§16.2). */
const UPLOAD_SESSIONS = COLLECTIONS.uploadSessions;

/** The bucket `originals` resolves to in the storage runtime wiring. */
const ORIGINALS_BUCKET = TEST_STORAGE_BUCKETS.originals ?? "bkt-a1";

/** The ETag the mocked storage answers for every object it holds. */
const STORED_ETAG = '"op126-etag"';

/** The declared/stored size of every fixture file. */
const FILE_BYTES = 4_096;

/** A roomy storage allowance, so the happy paths never hit the ceiling. */
const ROOMY_STORAGE_LIMIT = 10_000_000_000;

/** A per-event image allowance that cannot be the reason a case refuses. */
const ROOMY_IMAGE_LIMIT = 5_000;

/** A storage allowance smaller than one fixture file — the quota-block case. */
const TINY_STORAGE_LIMIT = 1_000;

/** The session TTL the schema fixes at five days. */
const SESSION_TTL_MS = 5 * 86_400_000;

/** How old the batch's first session is when the check runs (12 minutes). */
const BATCH_AGE_MS = 12 * 60_000;

/** A JPEG magic prefix — `FF D8 FF`. */
const JPEG_PREFIX = [0xff, 0xd8, 0xff] as const;

/** A deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op126-${name}`).digest("hex");
}

const HASH_ONE = hashFor("one");
const HASH_TWO = hashFor("two");
const HASH_THREE = hashFor("three");
const HASH_QUOTA = hashFor("quota");
const HASH_QUOTA_SECOND = hashFor("quota-second");

/** One object the mocked storage holds. */
interface MockObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** The objects the mocked storage holds, keyed by content hash. */
const storedObjects = new Map<string, MockObject>();

/** The URL every content-addressed original is addressed by. */
const OBJECT_URL = new RegExp(`/${ORIGINALS_BUCKET}/images/[0-9a-f]{64}\\.[a-z]+`);

/** The hash inside an object URL, or `null` when the path holds none. */
function hashOfUrl(url: string): string | null {
  const match = /\/images\/([0-9a-f]{64})\./.exec(new URL(url).pathname);
  return match === null ? null : (match[1] ?? null);
}

/** Deterministic JPEG bytes of one fixture file. */
function makeJpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_PREFIX, 0);
  for (let index = JPEG_PREFIX.length; index < size; index += 1) {
    bytes[index] = (index * 31) % 251;
  }
  return bytes;
}

/** Store an object the mocked storage answers for. */
function storeObject(hash: string): void {
  storedObjects.set(hash, { bytes: makeJpegBytes(FILE_BYTES), contentType: "image/jpeg" });
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
    http.delete(OBJECT_URL, () => new HttpResponse(null, { status: 204 }))
  );
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({
    prefix: "op126-batch",
    env: {
      STORAGE_PROVIDER: "s3",
      QUEUE_PROVIDER: "memory",
      R2_ENDPOINT: TEST_STORAGE_ENDPOINT,
      R2_REGION: "auto",
      R2_ACCESS_KEY_ID: "op126-test-access-key",
      R2_SECRET_ACCESS_KEY: "op126-test-secret-key",
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
    COLLECTIONS.notificationPreferences,
    COLLECTIONS.notificationTypes,
    COLLECTIONS.notificationTemplates,
    COLLECTIONS.notifications,
    COLLECTIONS.dispatches,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    "eventMembers",
    COLLECTIONS.invitations,
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
  invalidateNotificationTypeCache();
  storedObjects.clear();
  installStorageMock();
});

afterEach(() => {
  vi.restoreAllMocks();
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

const uploadComplete = requireHandler(
  completeRouteModule,
  "POST",
  "…/events/:eventId/uploads/:uploadSessionId/complete"
);
const readBatchStatus = requireHandler(
  batchStatusRouteModule,
  "GET",
  "…/events/:eventId/uploads/batches/:batchId"
);

/** The §5.5 status answer. */
interface BatchStatusAnswer {
  readonly batchId: string;
  readonly phase: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly files: {
    readonly total: number;
    readonly uploaded: number;
    readonly duplicatesSkipped: number;
    readonly rejected: number;
    readonly failedUpload: number;
  };
  readonly pipeline: {
    readonly queued: number;
    readonly processing: number;
    readonly done: number;
    readonly failed: number;
  };
  readonly failures: readonly {
    readonly eventImageId: string;
    readonly fileName: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }[];
  readonly stalledSessions: readonly Record<string, unknown>[];
}

/** A `domain_events` row, as the outbox stores it (§18.3). */
interface OutboxRow {
  readonly _id: ObjectId;
  readonly eventKey: string;
  readonly tenantId: string;
  readonly actorRef: { readonly kind: string; readonly id: string };
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: Record<string, unknown>;
  readonly dedupeKey?: string;
}

/** A stored in-app feed row (§19.4). */
interface FeedRow {
  readonly userId: ObjectId;
  readonly typeKey: string;
}

/** The error envelope of a failed response. */
interface ErrorBody {
  readonly code: string;
}

/** Parse an error envelope without reading the body twice. */
async function errorOf(response: Response): Promise<ErrorBody> {
  const parsed = await body(response);
  return parsed.error as ErrorBody;
}

/** A `batchId` in the 24-hex shape the contract accepts (§5.2). */
function newBatchId(): string {
  return new ObjectId().toHexString();
}

/** A fresh UUIDv4 for the idempotency header. */
function idempotencyKey(): string {
  return randomUUID();
}

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP126 Studio",
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
async function seedEvent(tenantKey: string, organizerUserId: ObjectId): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "Ananya & Karthik's Wedding",
    description: "",
    status: "published",
    startAt: new Date(fixtureInstant("10:00:00.000Z", 10)),
    endAt: new Date(fixtureInstant("12:00:00.000Z", 10)),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(fixtureInstant("12:00:00.000Z", 17)),
    retentionExpiresAt: new Date(fixtureInstant("12:00:00.000Z", 100)),
    accessLinks: [
      {
        slug: `op126${_id.toHexString().slice(-8)}`,
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

/** A workspace with a signed-in organizer and one open event. */
interface Workspace {
  readonly organizer: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** Sign an organizer in, provision their workspace and seed one open event. */
async function seedWorkspace(prefix: string): Promise<Workspace> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = await insertTenant(`op126-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Record an `event_organizers` row for a co-organizer of the event. */
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

/** Record the membership row the notification recipient port reads (A2). */
async function addEventMember(
  tenantKey: string,
  eventId: ObjectId,
  user: SignedInUser,
  role: "organizer" | "co_organizer"
): Promise<void> {
  await app.db.collection("eventMembers").insertOne({
    tenantId: tenantKey,
    eventId: eventId.toHexString(),
    userId: user.userId.toHexString(),
    role,
    status: "active",
  });
}

/** Insert a pending `upload_sessions` row a completion must find (§16.2). */
async function seedSession(fields: {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly contentHash: string;
  readonly createdByUserId: ObjectId;
  readonly batchId: string;
  readonly fileName: string;
  readonly createdAt: Date;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(UPLOAD_SESSIONS).insertOne({
    _id,
    tenantId: fields.tenantKey,
    eventId: fields.eventId,
    createdByUserId: fields.createdByUserId,
    contentHash: fields.contentHash,
    batchId: fields.batchId,
    mode: "single",
    status: "pending",
    fileName: fields.fileName,
    declaredSize: FILE_BYTES,
    declaredMimeType: "image/jpeg",
    externalRefs: [],
    assetId: null,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    expireAt: new Date(fields.createdAt.getTime() + SESSION_TTL_MS),
  });
  return _id;
}

/** Insert the plan catalogue row for a key (once) and activate it for a tenant. */
async function seedPlanFor(tenantKey: string, key: string, storageLimit: number): Promise<void> {
  const entitlements: Record<string, Entitlement> = {
    "storage.bytes": makeEntitlement({
      limit: storageLimit,
      scope: "tenant",
      resetPeriod: "monthly",
    }),
    "images.per_event": makeEntitlement({
      limit: ROOMY_IMAGE_LIMIT,
      scope: "event",
      resetPeriod: "none",
    }),
  };
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

/** The `complete` path for one session. */
function completePath(tenantKey: string, eventId: ObjectId, sessionId: string): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads/${sessionId}/complete`;
}

/** The §5.5 status path for one batch. */
function batchPath(tenantKey: string, eventId: ObjectId, batchId: string): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads/batches/${batchId}`;
}

/** A JSON `POST …/complete` carrying the caller's session cookie and a replay key. */
function completeRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  sessionId: string
): Request {
  return new Request(new URL(completePath(tenantKey, eventId, sessionId), APP_ORIGIN), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey(),
    },
    body: JSON.stringify({ etag: STORED_ETAG, bytes: FILE_BYTES }),
  });
}

/** A cookie-less (or cookie-bearing) `GET …/batches/{batchId}` request. */
function batchStatusRequest(
  cookie: string | null,
  tenantKey: string,
  eventId: ObjectId,
  batchId: string
): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers.cookie = cookie;
  }
  return new Request(new URL(batchPath(tenantKey, eventId, batchId), APP_ORIGIN), {
    method: "GET",
    headers,
  });
}

/** Complete one seeded session through the real route, storing its object first. */
async function completeOne(
  workspace: Workspace,
  uploader: SignedInUser,
  sessionId: ObjectId,
  hash: string
): Promise<Response> {
  storeObject(hash);
  return uploadComplete(
    completeRequest(
      uploader.cookie,
      workspace.tenantKey,
      workspace.eventId,
      sessionId.toHexString()
    )
  );
}

/** Read the §5.5 status answer for one batch. */
async function statusOf(
  workspace: Workspace,
  cookie: string,
  batchId: string
): Promise<{ readonly response: Response; readonly answer: BatchStatusAnswer }> {
  const response = await readBatchStatus(
    batchStatusRequest(cookie, workspace.tenantKey, workspace.eventId, batchId)
  );
  return { response, answer: (await body(response)) as unknown as BatchStatusAnswer };
}

/** The outbox rows for one event key, oldest first. */
async function outboxFor(eventKey: string): Promise<readonly OutboxRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey })
    .sort({ occurredAt: 1 })
    .toArray();
  return rows as unknown as OutboxRow[];
}

/** The batch's `event_images` rows, with their asset's content hash. */
async function imagesOf(
  eventId: ObjectId
): Promise<readonly { readonly imageId: ObjectId; readonly hash: string }[]> {
  const images = (await app.db
    .collection(COLLECTIONS.eventImages)
    .find({ eventId })
    .toArray()) as unknown as readonly { readonly _id: ObjectId; readonly assetId: ObjectId }[];
  const result: { imageId: ObjectId; hash: string }[] = [];
  for (const image of images) {
    const asset = await app.db.collection(COLLECTIONS.mediaAssets).findOne({ _id: image.assetId });
    if (asset === null || typeof asset.contentHash !== "string") {
      throw new Error("expected the completion to write a media asset for every image");
    }
    result.push({ imageId: image._id, hash: asset.contentHash });
  }
  return result;
}

/** The pipeline state a case assigns to one content hash. */
interface ProcessingState {
  readonly status: "done" | "failed";
  readonly lastError?: Record<string, unknown>;
}

/**
 * Play the pipeline worker: move the batch's images to their terminal state.
 *
 * @param eventId - The event whose images to mark.
 * @param states - One terminal state per content hash.
 */
async function processImages(
  eventId: ObjectId,
  states: Readonly<Record<string, ProcessingState>>
): Promise<void> {
  for (const [hash, state] of Object.entries(states)) {
    const image = (await imagesOf(eventId)).find((candidate) => candidate.hash === hash);
    if (image === undefined) {
      throw new Error(`expected the batch to hold an image for ${hash}`);
    }
    await app.db.collection(COLLECTIONS.eventImages).updateOne(
      { _id: image.imageId },
      {
        $set: {
          processing: {
            status: state.status,
            attempts: 1,
            ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
          },
        },
      }
    );
  }
}

/** Run the terminal transition check, as OP-136's indexed cron will. */
async function checkTransition(
  workspace: Workspace,
  batchId: string
): Promise<{ readonly phase: string }> {
  return await checkUploadBatchTransition({
    db: app.db,
    tenantKey: workspace.tenantKey,
    eventId: workspace.eventId,
    batchId,
  });
}

/** The first element of a non-empty read, or a naming error (no `!` assertion). */
function firstOf<T>(rows: readonly T[], what: string): T {
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`expected ${what}`);
  }
  return first;
}

/** Seed the real routing catalogue plus one in-app template for a type key. */
async function seedCatalogue(typeKey: string): Promise<void> {
  await app.db.collection(COLLECTIONS.notificationTypes).insertMany([...SEED_NOTIFICATION_TYPES]);
  await app.db
    .collection(COLLECTIONS.notificationTemplates)
    .insertMany([...SEED_NOTIFICATION_TEMPLATES]);
  await app.db.collection(COLLECTIONS.notificationTemplates).insertOne({
    typeKey,
    channel: "in_app",
    locale: "en-IN",
    subjectTemplate: "Storage is full",
    bodyTemplate: "Uploads are blocked until your workspace buys more storage.",
    variables: [],
    providerRefs: { whatsappTemplateName: null },
    version: 1,
    active: true,
  });
  invalidateNotificationTypeCache();
}

/** Drain the outbox into the feed through the real fan-out, then read the feed rows. */
async function fanOutAndReadFeed(typeKey: string): Promise<readonly FeedRow[]> {
  await runNotificationFanOut({
    db: app.db,
    transport: memoryMessageTransport(),
    recipients: mongoRecipientRepository(app.db),
    batch: 50,
    claimerId: "op126-fanout",
  });
  const rows = await app.db.collection(COLLECTIONS.notifications).find({ typeKey }).toArray();
  return rows as unknown as FeedRow[];
}

describe("GET …/uploads/batches/{batchId} — batch status and the one summary (I1)", () => {
  it("I1: a batch of three that lands and processes cleanly is complete, emits one summary, and a re-check emits none", async () => {
    // Arrange — one organizer, one batch, three files, all seeded before the run.
    const workspace = await seedWorkspace("op126-i1");
    await seedPlanFor(workspace.tenantKey, "op126-roomy", ROOMY_STORAGE_LIMIT);
    const batchId = newBatchId();
    const startedAt = new Date(Date.now() - BATCH_AGE_MS);
    const sessionOne = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_ONE,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0421.JPG",
      createdAt: startedAt,
    });
    const sessionTwo = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_TWO,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0422.JPG",
      createdAt: startedAt,
    });
    const sessionThree = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_THREE,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0423.JPG",
      createdAt: startedAt,
    });

    // Act — two of the three files land.
    const first = await completeOne(workspace, workspace.organizer, sessionOne, HASH_ONE);
    const second = await completeOne(workspace, workspace.organizer, sessionTwo, HASH_TWO);

    // Assert — a half-transferred batch has nothing to summarise.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await outboxFor("upload.batch.completed")).toHaveLength(0);

    // Act — the third file lands; its image is only queued, so the batch is not terminal.
    const third = await completeOne(workspace, workspace.organizer, sessionThree, HASH_THREE);

    // Assert — the transfer is settled but the pipeline is not, so still no summary.
    expect(third.status).toBe(201);
    expect(await outboxFor("upload.batch.completed")).toHaveLength(0);

    // Act — the worker finishes all three images, and the indexed check runs.
    await processImages(workspace.eventId, {
      [HASH_ONE]: { status: "done" },
      [HASH_TWO]: { status: "done" },
      [HASH_THREE]: { status: "done" },
    });
    const transition = await checkTransition(workspace, batchId);

    // Assert — one summary for the batch's one uploader.
    expect(transition.phase).toBe("complete");
    const summaries = await outboxFor("upload.batch.completed");
    expect(summaries).toHaveLength(1);
    const summary = firstOf(summaries, "the batch's completed summary");
    expect(summary.tenantId).toBe(workspace.tenantKey);
    expect(summary.subjectRef).toEqual({
      kind: "user",
      id: workspace.organizer.userId.toHexString(),
    });
    expect(summary.payload.batchId).toBe(batchId);
    expect(summary.payload.eventId).toBe(workspace.eventId.toHexString());
    expect(summary.payload.fileCount).toBe(3);
    expect(typeof summary.payload.durationMs).toBe("number");
    expect(summary.payload.durationMs).toBeGreaterThanOrEqual(BATCH_AGE_MS - 5_000);
    expect(summary.payload.durationMs).toBeLessThanOrEqual(BATCH_AGE_MS + 60_000);

    // Assert — the status endpoint tells the same story.
    const { response, answer } = await statusOf(workspace, workspace.organizer.cookie, batchId);
    expect(response.status).toBe(200);
    expect(Object.keys(answer).sort()).toEqual([
      "batchId",
      "completedAt",
      "createdAt",
      "failures",
      "files",
      "phase",
      "pipeline",
      "stalledSessions",
    ]);
    expect(answer.batchId).toBe(batchId);
    expect(answer.phase).toBe("complete");
    expect(answer.createdAt).toBe(startedAt.toISOString());
    expect(answer.completedAt).not.toBeNull();
    expect(answer.files).toEqual({
      total: 3,
      uploaded: 3,
      duplicatesSkipped: 0,
      rejected: 0,
      failedUpload: 0,
    });
    expect(answer.pipeline).toEqual({ queued: 0, processing: 0, done: 3, failed: 0 });
    expect(answer.failures).toEqual([]);
    expect(answer.stalledSessions).toEqual([]);
    expect(summary.payload.files).toEqual(answer.files);

    // Act — the check runs again, as the next cron tick would, and the page is polled twice.
    await checkTransition(workspace, batchId);
    await statusOf(workspace, workspace.organizer.cookie, batchId);
    await statusOf(workspace, workspace.organizer.cookie, batchId);

    // Assert — one batch is one summary: neither a re-check nor a poll re-notifies.
    expect(await outboxFor("upload.batch.completed")).toHaveLength(1);
  });

  it("I1: the batch status read serves the latest count while the batch is still uploading", async () => {
    // Arrange — one landed file out of a three-file batch, nothing processed yet.
    const workspace = await seedWorkspace("op126-i1-live");
    await seedPlanFor(workspace.tenantKey, "op126-roomy-live", ROOMY_STORAGE_LIMIT);
    const batchId = newBatchId();
    const startedAt = new Date(Date.now() - BATCH_AGE_MS);
    const landed = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_ONE,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0421.JPG",
      createdAt: startedAt,
    });
    await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_TWO,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0422.JPG",
      createdAt: startedAt,
    });
    await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_THREE,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0423.JPG",
      createdAt: startedAt,
    });

    // Act
    const completion = await completeOne(workspace, workspace.organizer, landed, HASH_ONE);
    const { response, answer } = await statusOf(workspace, workspace.organizer.cookie, batchId);

    // Assert — the client's progress bar reads a live "uploading" batch.
    expect(completion.status).toBe(201);
    expect(response.status).toBe(200);
    expect(answer.phase).toBe("uploading");
    expect(answer.completedAt).toBeNull();
    expect(answer.files).toEqual({
      total: 3,
      uploaded: 1,
      duplicatesSkipped: 0,
      rejected: 0,
      failedUpload: 0,
    });
    expect(answer.pipeline).toEqual({ queued: 1, processing: 0, done: 0, failed: 0 });
  });
});

describe("the terminal transition — failures (I2)", () => {
  it("I2: one image that fails processing makes the batch complete_with_errors and its only summary carry the retry", async () => {
    // Arrange — three files land, then the worker fails one of them.
    const workspace = await seedWorkspace("op126-i2");
    await seedPlanFor(workspace.tenantKey, "op126-roomy-i2", ROOMY_STORAGE_LIMIT);
    const batchId = newBatchId();
    const startedAt = new Date(Date.now() - BATCH_AGE_MS);
    const files = [
      {
        hash: HASH_ONE,
        fileName: "DSC_0421.JPG",
        session: await seedSession({
          tenantKey: workspace.tenantKey,
          eventId: workspace.eventId,
          contentHash: HASH_ONE,
          createdByUserId: workspace.organizer.userId,
          batchId,
          fileName: "DSC_0421.JPG",
          createdAt: startedAt,
        }),
      },
      {
        hash: HASH_TWO,
        fileName: "DSC_0422.JPG",
        session: await seedSession({
          tenantKey: workspace.tenantKey,
          eventId: workspace.eventId,
          contentHash: HASH_TWO,
          createdByUserId: workspace.organizer.userId,
          batchId,
          fileName: "DSC_0422.JPG",
          createdAt: startedAt,
        }),
      },
      {
        hash: HASH_THREE,
        fileName: "DSC_0423.JPG",
        session: await seedSession({
          tenantKey: workspace.tenantKey,
          eventId: workspace.eventId,
          contentHash: HASH_THREE,
          createdByUserId: workspace.organizer.userId,
          batchId,
          fileName: "DSC_0423.JPG",
          createdAt: startedAt,
        }),
      },
    ];
    const completionStatuses: number[] = [];
    for (const file of files) {
      const completion = await completeOne(workspace, workspace.organizer, file.session, file.hash);
      completionStatuses.push(completion.status);
    }
    await processImages(workspace.eventId, {
      [HASH_ONE]: { status: "done" },
      [HASH_TWO]: { status: "done" },
      [HASH_THREE]: {
        status: "failed",
        lastError: {
          code: "no_faces_detected",
          message: "opencv error: (-215) !empty() in function detectMultiScale",
          retryable: true,
        },
      },
    });

    // Act
    const transition = await checkTransition(workspace, batchId);
    const { answer } = await statusOf(workspace, workspace.organizer.cookie, batchId);
    const failures = await outboxFor("upload.batch.completed_with_errors");

    // Assert — the phase, the single summary and the user-safe failure row.
    expect(completionStatuses).toEqual([201, 201, 201]);
    expect(transition.phase).toBe("complete_with_errors");
    expect(await outboxFor("upload.batch.completed")).toHaveLength(0);
    expect(failures).toHaveLength(1);
    const failure = firstOf(failures, "the batch's failure summary");
    expect(failure.subjectRef).toEqual({
      kind: "user",
      id: workspace.organizer.userId.toHexString(),
    });
    expect(failure.payload.batchId).toBe(batchId);
    expect(failure.payload.files).toMatchObject({ total: 3, uploaded: 3, failedUpload: 0 });

    expect(answer.phase).toBe("complete_with_errors");
    expect(answer.files).toEqual({
      total: 3,
      uploaded: 3,
      duplicatesSkipped: 0,
      rejected: 0,
      failedUpload: 0,
    });
    expect(answer.pipeline).toEqual({ queued: 0, processing: 0, done: 2, failed: 1 });
    expect(answer.failures).toHaveLength(1);
    const listed = firstOf(answer.failures, "the failed image in the status answer");
    const failedImage = (await imagesOf(workspace.eventId)).find(
      (image) => image.hash === HASH_THREE
    );
    expect(listed.eventImageId).toBe(failedImage?.imageId.toHexString());
    expect(listed.fileName).toBe("DSC_0423.JPG");
    expect(listed.code).toBe("no_faces_detected");
    expect(listed.message).toBe("No faces were detected in this image.");
    expect(listed.retryable).toBe(false);
    expect(listed.message).not.toContain("opencv");

    // Act — the check runs again.
    await checkTransition(workspace, batchId);

    // Assert — still one summary of the failure, never a second.
    expect(await outboxFor("upload.batch.completed_with_errors")).toHaveLength(1);
  });
});

describe("upload.blocked.quota — the uploader and the organizer (I3)", () => {
  it("I3: a completion refused for quota reaches the uploader and the organizer in one feed", async () => {
    // Arrange — a co-organizer whose event tenant cannot afford the file.
    const workspace = await seedWorkspace("op126-i3");
    await seedPlanFor(workspace.tenantKey, "op126-tiny", TINY_STORAGE_LIMIT);
    const coOrganizer = await app.signIn(makeIdentity("op126-i3-co"));
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);
    await addEventMember(workspace.tenantKey, workspace.eventId, workspace.organizer, "organizer");
    await addEventMember(workspace.tenantKey, workspace.eventId, coOrganizer, "co_organizer");
    await seedCatalogue("upload.blocked.quota");
    const batchId = newBatchId();
    const session = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_QUOTA,
      createdByUserId: coOrganizer.userId,
      batchId,
      fileName: "DSC_0500.JPG",
      createdAt: new Date(Date.now() - BATCH_AGE_MS),
    });

    // Act
    const refused = await completeOne(workspace, coOrganizer, session, HASH_QUOTA);

    // Assert — the refusal itself is unchanged (§5.3): nothing was written.
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe("plan_limit_exceeded");
    expect(await app.db.collection(COLLECTIONS.eventImages).countDocuments({})).toBe(0);

    // Assert — one quota block naming the batch, the event and the uploader.
    const blocked = await outboxFor("upload.blocked.quota");
    expect(blocked).toHaveLength(1);
    const row = firstOf(blocked, "the quota-block notification");
    expect(row.tenantId).toBe(workspace.tenantKey);
    expect(row.payload.eventId).toBe(workspace.eventId.toHexString());
    expect(row.payload.batchId).toBe(batchId);
    expect(row.subjectRef).toEqual({ kind: "user", id: coOrganizer.userId.toHexString() });

    // Act — the outbox drains into the feed through the real fan-out.
    const feed = await fanOutAndReadFeed("upload.blocked.quota");

    // Assert — both humans hold one in-app notification each: the uploader is
    // the event's subject (a subject always hears its own outcome) and the
    // organizer is reached by the type's ORGANIZERS audience, because only the
    // organizer can buy storage (§4.7).
    expect(feed).toHaveLength(2);
    expect(new Set(feed.map((notification) => notification.userId.toHexString()))).toEqual(
      new Set([workspace.organizer.userId.toHexString(), coOrganizer.userId.toHexString()])
    );
  });
});

describe("one summary per uploader (I4)", () => {
  it("I4: a batch the organizer and a co-organizer uploaded together produces one summary for each of them", async () => {
    // Arrange — two uploaders, one client-generated batch id.
    const workspace = await seedWorkspace("op126-i4");
    await seedPlanFor(workspace.tenantKey, "op126-roomy-i4", ROOMY_STORAGE_LIMIT);
    const coOrganizer = await app.signIn(makeIdentity("op126-i4-co"));
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);
    const batchId = newBatchId();
    const startedAt = new Date(Date.now() - BATCH_AGE_MS);
    const organizerOne = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_ONE,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0421.JPG",
      createdAt: startedAt,
    });
    const organizerTwo = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_TWO,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0422.JPG",
      createdAt: startedAt,
    });
    const coOrganizerOne = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_THREE,
      createdByUserId: coOrganizer.userId,
      batchId,
      fileName: "DSC_0423.JPG",
      createdAt: startedAt,
    });

    // Act — both organizers complete their own files inside the one batch.
    const completions = [
      await completeOne(workspace, workspace.organizer, organizerOne, HASH_ONE),
      await completeOne(workspace, workspace.organizer, organizerTwo, HASH_TWO),
      await completeOne(workspace, coOrganizer, coOrganizerOne, HASH_THREE),
    ];
    await processImages(workspace.eventId, {
      [HASH_ONE]: { status: "done" },
      [HASH_TWO]: { status: "done" },
      [HASH_THREE]: { status: "done" },
    });
    const transition = await checkTransition(workspace, batchId);

    // Assert — the batch is terminal, and each uploader holds exactly one summary.
    expect(completions.map((completion) => completion.status)).toEqual([201, 201, 201]);
    expect(transition.phase).toBe("complete");
    const summaries = await outboxFor("upload.batch.completed");
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((summary) => summary.subjectRef.id))).toEqual(
      new Set([workspace.organizer.userId.toHexString(), coOrganizer.userId.toHexString()])
    );
    for (const summary of summaries) {
      expect(summary.payload.batchId).toBe(batchId);
      expect(summary.payload.fileCount).toBe(3);
    }

    // Act — every client re-polls and the next cron tick re-checks.
    await checkTransition(workspace, batchId);
    await checkTransition(workspace, batchId);

    // Assert — the pair (batch, uploader) is what dedupes: two summaries, never four.
    expect(await outboxFor("upload.batch.completed")).toHaveLength(2);
  });
});

describe("the batch status read refuses what it cannot answer (X1–X3)", () => {
  it("X1: an unauthenticated caller gets 401", async () => {
    // Arrange
    const workspace = await seedWorkspace("op126-x1");
    const batchId = newBatchId();

    // Act
    const response = await readBatchStatus(
      batchStatusRequest(null, workspace.tenantKey, workspace.eventId, batchId)
    );

    // Assert
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });

  it("X2: a signed-in user who is not an actor on the event gets 404", async () => {
    // Arrange — a stranger with a valid session and their own workspace.
    const workspace = await seedWorkspace("op126-x2");
    const stranger = await app.signIn(makeIdentity("op126-x2-stranger"));
    const batchId = newBatchId();

    // Act
    const response = await readBatchStatus(
      batchStatusRequest(stranger.cookie, workspace.tenantKey, workspace.eventId, batchId)
    );

    // Assert — the route is never an existence oracle (contract §0.4).
    expect(response.status).toBe(404);
  });

  it("X3: a batch id outside §5.2's two shapes is 422 validation_failed", async () => {
    // Arrange
    const workspace = await seedWorkspace("op126-x3");

    // Act
    const response = await readBatchStatus(
      batchStatusRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        "not-a-batch"
      )
    );

    // Assert
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
  });
});

describe("the transition never invents work (X4, X5)", () => {
  it("X4: a batch no client has used yet is complete and emits nothing", async () => {
    // Arrange — a valid batch id with no session behind it.
    const workspace = await seedWorkspace("op126-x4");

    // Act
    const transition = await checkTransition(workspace, newBatchId());

    // Assert
    expect(transition.phase).toBe("complete");
    expect(
      await app.db.collection(COLLECTIONS.domainEvents).countDocuments({
        eventKey: {
          $in: [
            "upload.batch.completed",
            "upload.batch.completed_with_errors",
            "upload.blocked.quota",
          ],
        },
      })
    ).toBe(0);
  });

  it("X5: two quota refusals in the same window produce one notification", async () => {
    // Arrange — one event tenant with no room, two files refused in a row.
    const workspace = await seedWorkspace("op126-x5");
    await seedPlanFor(workspace.tenantKey, "op126-tiny-x5", TINY_STORAGE_LIMIT);
    const batchId = newBatchId();
    const first = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_QUOTA,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0601.JPG",
      createdAt: new Date(Date.now() - BATCH_AGE_MS),
    });
    const second = await seedSession({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      contentHash: HASH_QUOTA_SECOND,
      createdByUserId: workspace.organizer.userId,
      batchId,
      fileName: "DSC_0602.JPG",
      createdAt: new Date(Date.now() - BATCH_AGE_MS),
    });

    // Act
    const firstRefusal = await completeOne(workspace, workspace.organizer, first, HASH_QUOTA);
    const secondRefusal = await completeOne(
      workspace,
      workspace.organizer,
      second,
      HASH_QUOTA_SECOND
    );

    // Assert — two refusals, one alert: §4.7 throttles quota blocks per event.
    expect(firstRefusal.status).toBe(403);
    expect(secondRefusal.status).toBe(403);
    expect(await outboxFor("upload.blocked.quota")).toHaveLength(1);
  });
});
