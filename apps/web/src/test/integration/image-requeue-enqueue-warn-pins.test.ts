import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as reprocessFailedRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images:reprocess-failed/route";
import * as reprocessImageRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/images/[imageId]/reprocess/route";
import type { MemoryWorkQueue } from "@/server/adapters/memory-queue";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { requeueImages, type RequeueImagesInput } from "@/server/images/requeue";
import { getLogger, setLogger } from "@/server/logging";
import { ENQUEUE_FAILED_EVENT } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { REQUEST_ID_HEADER } from "@/server/runtime/request-context";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { APP_ORIGIN, makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — the requeue path's §18.1 enqueue warn and its
 * request correlation (OP-136 follow-up; findings **F2** and the RED half of
 * **F1** of the review of PR #667).
 *
 * ## The contract this file pins
 *
 * `apps/web/src/server/images/requeue.ts` resets each admitted row to `queued`,
 * writes it, and then re-enqueues it. `enqueueWork` never throws: a refused
 * enqueue leaves the item `queued` with no `queueRef` (the sweep's job), answers
 * `{ enqueued: false }` and prints `queue.enqueue_failed` at `warn` — §18.1's
 * only operator signal. PR #667 forwarded a caller logger, so that warn now
 * reaches the process log at all. Two things were left unpinned; this file adds
 * one case per observable:
 *
 * - **A (characterization, green on arrival).** A **refused** broker driven
 *   through `requeueImages` prints **exactly one** `queue.enqueue_failed` with
 *   `level: "warn"`, `fields.kind: "event_image"` and `fields.queueKey:
 *   "q:image"`, and leaves §18.1's durable state — `processing.status:
 *   "queued"`, `processing.queueRef: null` — because the reset write precedes
 *   the enqueue. A **healthy** broker on the same seed prints **zero** and
 *   stores the accepted pointer (`{ queueKey: "q:image", provider: "memory",
 *   messageId }`). Without the healthy arm the refused arm would also pass on a
 *   `requeueImages` that warns on every call.
 * - **B (RED on arrival).** Both reprocess routes — `…/images:reprocess-failed`
 *   and `…/images/{imageId}/reprocess` — must hand the warn the **request's**
 *   logger, so the entry carries `requestId` equal to the request's
 *   `x-request-id` and `route` equal to the matched template. Both routes pass
 *   `getLogger()` — the *process* logger — so today the entry carries neither
 *   and an operator cannot say which request lost the enqueue. The sibling seam
 *   does it right: `…/p/events/[slug]/selfies/route.ts` passes
 *   `requestLogger(ctx.request, { route: ctx.route })` into `enqueueSelfie`.
 *
 * Each route is its own case, so a single case cannot redden only on its first
 * failing arm. Case B asserts the **missing field** (`expected undefined to be
 * 'req_pin_0001'`), never a status: a refused enqueue is not a failed request
 * (§18.1), so `202` and the contract's body are asserted **after** the logger
 * field and stay as they are.
 *
 * ## Fixtures
 *
 * Pin A seeds the `event_images` row directly and reads it back through the
 * same filter the bulk route uses, so `requeueImages` is the only code between
 * the seed and the assertion; the logger it is handed is `recordingLogger()`.
 * Pin B boots the app once (`startTestApp`), signs an organizer in through the
 * real OTP flow, seeds the tenant/event/asset/image rows the two routes read,
 * and swaps the **process** logger for a recording one through `setLogger`
 * (restored in the same case's `finally`, because `@/server/logging` has no
 * reset and a leaked recorder would silence every later case), so what it
 * observes is exactly what a deployed process would print. The broker is the
 * memoised memory adapter `getWorkQueue()` returns under `QUEUE_PROVIDER=memory`:
 * a case replaces its `enqueue` to make it refuse and restores it in a
 * `finally`, so no case depends on which one ran first.
 *
 * ## Decision record
 *
 * ADR-0868 records this pin set. Pin A is characterization — green on the trunk
 * at `5790a785` — and Pin B is **RED on arrival by design**: both routes pass the
 * process logger today, so the PR that carries this file is a draft until the
 * GREEN card switches both call sites to `requestLogger(ctx.request, { route:
 * ctx.route })` and carries this file unchanged.
 */

/** The instant every seeded row is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

const DAY_MS = 86_400_000;

/** The face space the pipeline runs in (`platformSettings.face.activeSpaceKey`). */
const SPACE_KEY = "arcface_r100_512";

/**
 * The correlation ids the two route cases send.
 *
 * Both satisfy `/^[A-Za-z0-9_-]{8,64}$/`, so `resolveRequestId` trusts them
 * verbatim and the log field must echo them unchanged; an invalid value is
 * replaced by a minted `req_<ulid>`, so the pin cannot pass on the wrong token.
 */
const REQUEST_ID_BULK = "req_pin_0001";
const REQUEST_ID_SINGLE = "req_pin_0002";

/** The route templates `ctx.route` matches, i.e. the values `route` must echo. */
const ROUTE_TEMPLATE_BULK = "/api/v1/tenants/:tenantId/events/:eventId/images:reprocess-failed";
const ROUTE_TEMPLATE_SINGLE = "/api/v1/tenants/:tenantId/events/:eventId/images/:imageId/reprocess";

let app: TestApp;

/** The §18.2 state a `failed` image is stored in before a reprocess. */
const FAILED_PROCESSING = {
  status: "failed",
  priority: "normal",
  attempts: 3,
  maxAttempts: 5,
  leaseExpiresAt: null,
  workerId: null,
  queuedAt: new Date(NOW.getTime() - 2 * DAY_MS),
  startedAt: new Date(NOW.getTime() - 2 * DAY_MS),
  finishedAt: new Date(NOW.getTime() - 2 * DAY_MS),
  durationMs: 3_400,
  lastError: {
    code: "no_face_detected",
    message: "No face found in the image.",
    at: new Date(NOW.getTime() - 2 * DAY_MS),
    retryable: true,
  },
  queueRef: null,
};

/** The memoised memory queue every enqueue in this file goes through. */
function queue(): MemoryWorkQueue {
  return getWorkQueue() as MemoryWorkQueue;
}

/**
 * Make the memoised broker refuse every enqueue until the returned undo runs.
 *
 * `enqueueWork` catches the refusal itself, so replacing the adapter's own
 * method is the only seam needed to reach §18.1's refused arm without mocking a
 * module. `onRefusal` runs **inside** the refusal, which is the one instant that
 * can observe what the caller had already written.
 *
 * @param onRefusal - A probe run at the moment the broker refuses.
 * @returns The undo, which restores the adapter's own `enqueue`.
 */
function refuseEnqueue(onRefusal?: () => Promise<void>): () => void {
  const broker = queue();
  const original = broker.enqueue.bind(broker);
  broker.enqueue = async () => {
    if (onRefusal !== undefined) {
      await onRefusal();
    }
    throw new Error("broker refused");
  };
  return () => {
    broker.enqueue = original;
  };
}

/** The `event_images.processing` fields these cases read. */
interface StoredProcessing {
  readonly status?: string;
  readonly attempts?: number;
  readonly lastError?: unknown;
  readonly queueRef?: {
    readonly queueKey?: string;
    readonly provider?: string;
    readonly messageId?: string;
  } | null;
}

/** An event a seeded image hangs off. */
interface SeededEvent {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** A signed-in organizer's workspace with one published event. */
interface Workspace {
  readonly organizerCookie: string;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** Deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op136-requeue-${name}`).digest("hex");
}

/**
 * Insert one `events` row plus the organizer's `event_organizers` row.
 *
 * @param tenantKey - The owning tenant.
 * @param organizerUserId - The user who organizes the event.
 * @returns The event id.
 */
async function seedEvent(tenantKey: string, organizerUserId: ObjectId): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: `event-${_id.toHexString()}`,
    description: "",
    status: "published",
    startAt: new Date(NOW.getTime() + DAY_MS),
    endAt: new Date(NOW.getTime() + 2 * DAY_MS),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(NOW.getTime() + 7 * DAY_MS),
    retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    accessLinks: [],
    counters: {
      imageCount: 1,
      processedImageCount: 0,
      failedImageCount: 1,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: organizerUserId.toHexString(),
    schemaVersion: 1,
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: organizerUserId.toHexString(),
    role: "organizer",
    status: "active",
    revokedAt: null,
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
    schemaVersion: 1,
  });
  return _id;
}

/**
 * Insert one stored `media_assets` row with its thumbnail derivative (§16.1).
 *
 * The single-image reprocess route projects the §4.4 item from the asset after
 * the requeue, so the row must exist for that route to answer `202`.
 *
 * @param tenantKey - The owning tenant.
 * @param contentHash - The asset's content hash.
 * @returns The asset id.
 */
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
      bytes: 8_421_310,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    },
    derivatives: {
      thumbnail: {
        locationKey: "thumbnails",
        objectKey: `thumbnails/${contentHash}.webp`,
        bytes: 41_200,
        width: 400,
        height: 600,
        format: "webp",
        processorVersion: 1,
        watermarkVersion: null,
        generatedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      },
    },
    imageMeta: {
      width: 4000,
      height: 6000,
      orientation: 6,
      exifCaptureAt: new Date(NOW.getTime() - 3 * DAY_MS),
      cameraMake: "SONY",
      cameraModel: "ILCE-7M4",
    },
    status: "derivatives_ready",
    refCount: 1,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  return _id;
}

/**
 * Insert one `event_images` join row in the `failed` state (§16.3).
 *
 * @param event - The owning event.
 * @param assetId - The stored asset the row points at.
 * @returns The image id.
 */
async function seedImage(event: SeededEvent, assetId: ObjectId): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    assetId,
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing: FAILED_PROCESSING,
    faceCount: 0,
    visibility: "visible",
    deletedAt: null,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  return _id;
}

/**
 * Seed one event with one `failed` image and its asset.
 *
 * @param tenantKey - The owning tenant.
 * @param organizerUserId - The event's organizer.
 * @param name - The scenario name, hashed into the asset's content hash.
 * @returns The event and the image id.
 */
async function seedFailedImage(
  tenantKey: string,
  organizerUserId: ObjectId,
  name: string
): Promise<{ readonly event: SeededEvent; readonly imageId: ObjectId }> {
  const eventId = await seedEvent(tenantKey, organizerUserId);
  const assetId = await seedAsset(tenantKey, hashFor(name));
  const imageId = await seedImage({ tenantKey, eventId }, assetId);
  return { event: { tenantKey, eventId }, imageId };
}

/** Read one `event_images` row's `processing` sub-document. */
async function readProcessing(imageId: ObjectId): Promise<StoredProcessing | undefined> {
  const row = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
  return row?.processing as StoredProcessing | undefined;
}

/** The event's `failed` rows, read exactly the way the bulk route reads them. */
async function failedRows(eventId: ObjectId): Promise<RequeueImagesInput["rows"]> {
  return app.db
    .collection(COLLECTIONS.eventImages)
    .find({ eventId, deletedAt: null, "processing.status": "failed" })
    .toArray();
}

/**
 * Sign an organizer in, provision their workspace and seed one failed image.
 *
 * @param prefix - The suite-local identity and tenant-slug prefix.
 * @returns The workspace and the image id.
 */
async function seedWorkspace(prefix: string): Promise<Workspace & { readonly imageId: ObjectId }> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op136-${prefix}`,
    name: "OP136 Studio",
    status: "active",
    ownerUserId: organizer.userId,
    billingContactUserId: organizer.userId,
    dataRegion: "in",
    counters: {
      eventCount: 1,
      activeEventCount: 1,
      imageCount: 1,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: organizer.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  const tenantKey = tenantId.toHexString();
  const { event, imageId } = await seedFailedImage(tenantKey, organizer.userId, prefix);
  return { organizerCookie: organizer.cookie, tenantKey, eventId: event.eventId, imageId };
}

/** Read the `POST` export off a route namespace, failing with a naming message. */
function requirePost(module: object, path: string): (request: Request) => Promise<Response> {
  const candidate = (module as { readonly POST?: unknown }).POST;
  if (typeof candidate !== "function") {
    throw new Error(`expected ${path} to export a POST handler`);
  }
  return candidate as (request: Request) => Promise<Response>;
}

const reprocessFailed = requirePost(
  reprocessFailedRouteModule,
  "…/events/:eventId/images:reprocess-failed"
);
const reprocessImage = requirePost(
  reprocessImageRouteModule,
  "…/events/:eventId/images/:imageId/reprocess"
);

/** The bulk reprocess path for one event. */
function reprocessFailedPath(workspace: Workspace): string {
  return `/api/v1/tenants/${workspace.tenantKey}/events/${workspace.eventId.toHexString()}/images:reprocess-failed`;
}

/** The single-image reprocess path for one image. */
function reprocessPath(workspace: Workspace, imageId: string): string {
  return `/api/v1/tenants/${workspace.tenantKey}/events/${workspace.eventId.toHexString()}/images/${imageId}/reprocess`;
}

/**
 * A `POST` carrying the caller's session and a trusted correlation id.
 *
 * @param path - The request path.
 * @param workspace - The signed-in organizer and its event.
 * @param requestId - The `x-request-id` the emitted entry must echo.
 * @returns The request.
 */
function postRequest(path: string, workspace: Workspace, requestId: string): Request {
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers: { cookie: workspace.organizerCookie, [REQUEST_ID_HEADER]: requestId },
  });
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-requeue-pins", env: { QUEUE_PROVIDER: "memory" } });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

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

afterAll(async () => {
  await app.cleanup();
});

describe("requeueImages: the §18.1 enqueue warn", () => {
  it("A1: a healthy broker stores the accepted pointer and prints no enqueue warn", async () => {
    // Arrange — one failed row, read back the way the bulk route reads it.
    const tenantKey = new ObjectId().toHexString();
    const { event, imageId } = await seedFailedImage(tenantKey, new ObjectId(), "a1");
    const rows = await failedRows(event.eventId);
    const logger = recordingLogger();

    // Act — the broker accepts.
    await requeueImages({
      db: app.db,
      tenantKey,
      eventId: event.eventId,
      rows,
      now: NOW,
      spaceKey: SPACE_KEY,
      requestId: "req_pin_requeue_a1",
      logger,
    });

    // Assert — a healthy enqueue warns about nothing…
    expect(logger.entriesForEvent(ENQUEUE_FAILED_EVENT)).toHaveLength(0);

    // …and the accepted pointer is the adapter's own minted message. This case
    // runs before any other case in this file enqueues, so the memoised memory
    // adapter mints its first id (`memory-1`) here.
    const processing = await readProcessing(imageId);
    expect(processing?.queueRef).toEqual({
      queueKey: "q:image",
      provider: "memory",
      messageId: "memory-1",
    });
    expect(processing?.status).toBe("queued");

    // …and exactly one work item for exactly this image went on the wire.
    const enqueued = queue().outbox.filter(
      (message) => message.envelope.id === imageId.toHexString()
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.envelope).toMatchObject({
      kind: "event_image",
      tenantId: tenantKey,
      eventId: event.eventId.toHexString(),
      spaceKey: SPACE_KEY,
      traceId: "req_pin_requeue_a1",
    });
  });

  it("A2: a refused broker warns once and leaves the row queued with no pointer", async () => {
    // Arrange — one failed row, read back the way the bulk route reads it.
    const tenantKey = new ObjectId().toHexString();
    const { event, imageId } = await seedFailedImage(tenantKey, new ObjectId(), "a2");
    const rows = await failedRows(event.eventId);
    const logger = recordingLogger();

    // The durable write must have landed before the broker was asked, so the
    // state at the refusal instant is captured from inside the refusal itself.
    let atEnqueue: StoredProcessing | undefined;
    const restore = refuseEnqueue(async () => {
      atEnqueue = await readProcessing(imageId);
    });

    // Act — the broker refuses.
    await requeueImages({
      db: app.db,
      tenantKey,
      eventId: event.eventId,
      rows,
      now: NOW,
      spaceKey: SPACE_KEY,
      requestId: "req_pin_requeue_a2",
      logger,
    }).finally(restore);

    // Assert — exactly one warn, naming the work kind (§18.1).
    const warns = logger.entriesForEvent(ENQUEUE_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    const warn = warns[0];
    if (warn === undefined) {
      throw new Error("a refused enqueue printed no queue.enqueue_failed warn");
    }
    expect(warn.level).toBe("warn");
    expect(warn.fields.kind).toBe("event_image");
    expect(warn.fields.queueKey).toBe("q:image");

    // Assert — the reset write preceded the enqueue…
    expect(atEnqueue?.status).toBe("queued");
    expect(atEnqueue?.attempts).toBe(0);
    expect(atEnqueue?.queueRef ?? null).toBeNull();

    // …so the durable outcome is §18.1's "queued, no pointer, the sweep's job":
    // not a failed request, and not a lost image.
    const processing = await readProcessing(imageId);
    expect(processing?.status).toBe("queued");
    expect(processing?.attempts).toBe(0);
    expect(processing?.lastError ?? null).toBeNull();
    expect(processing?.queueRef ?? null).toBeNull();
    expect(
      queue().outbox.filter((message) => message.envelope.id === imageId.toHexString())
    ).toHaveLength(0);
  });
});

describe("the reprocess routes: the enqueue warn carries the request's correlation", () => {
  it("B1: …/images:reprocess-failed logs queue.enqueue_failed with the request's id and route", async () => {
    // Arrange — a signed-in organizer, one failed image, a refusing broker.
    const workspace = await seedWorkspace("op136-bulk");
    const request = postRequest(reprocessFailedPath(workspace), workspace, REQUEST_ID_BULK);

    // Act — the process logger is swapped for a recorder for this request only.
    const previousLogger = getLogger();
    const recorder = recordingLogger();
    setLogger(recorder);
    const restore = refuseEnqueue();
    const response = await reprocessFailed(request).finally(() => {
      restore();
      setLogger(previousLogger);
    });

    // Assert — exactly one warn for the refused enqueue…
    const warns = recorder.entriesForEvent(ENQUEUE_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    const warn = warns[0];
    if (warn === undefined) {
      throw new Error("a refused enqueue printed no queue.enqueue_failed warn");
    }

    // …carrying the request's own correlation id: §18.1's only signal must name
    // the request that lost the enqueue.
    expect(warn.fields.requestId).toBe(REQUEST_ID_BULK);
    expect(warn.fields.route).toBe(ROUTE_TEMPLATE_BULK);

    // …and the request itself still succeeds: a refused enqueue is not a 500.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ requeuedCount: 1 });
  });

  it("B2: …/images/{imageId}/reprocess logs queue.enqueue_failed with the request's id and route", async () => {
    // Arrange — a signed-in organizer, one failed image, a refusing broker.
    const workspace = await seedWorkspace("op136-single");
    const request = postRequest(
      reprocessPath(workspace, workspace.imageId.toHexString()),
      workspace,
      REQUEST_ID_SINGLE
    );

    // Act — the process logger is swapped for a recorder for this request only.
    const previousLogger = getLogger();
    const recorder = recordingLogger();
    setLogger(recorder);
    const restore = refuseEnqueue();
    const response = await reprocessImage(request).finally(() => {
      restore();
      setLogger(previousLogger);
    });

    // Assert — exactly one warn for the refused enqueue…
    const warns = recorder.entriesForEvent(ENQUEUE_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    const warn = warns[0];
    if (warn === undefined) {
      throw new Error("a refused enqueue printed no queue.enqueue_failed warn");
    }

    // …carrying the request's own correlation id.
    expect(warn.fields.requestId).toBe(REQUEST_ID_SINGLE);
    expect(warn.fields.route).toBe(ROUTE_TEMPLATE_SINGLE);

    // …and the request itself still succeeds with the reset §4.4 item.
    expect(response.status).toBe(202);
    const answer = (await response.json()) as {
      readonly id?: string;
      readonly processing?: { readonly status?: string };
    };
    expect(answer.id).toBe(workspace.imageId.toHexString());
    expect(answer.processing?.status).toBe("queued");
  });
});
