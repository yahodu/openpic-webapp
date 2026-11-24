import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryWorkQueue } from "@/server/adapters/memory-queue";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { isAppError } from "@/server/http/errors";
import {
  retryFailedEventImages,
  type RetryFailedEventImagesInput,
} from "@/server/images/retry-failed";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeIdentity, startTestApp, type SignedInUser, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — `retryFailedEventImages`, the event-images bulk
 * retry as a **service** (OP-140 precondition, ADR-0777; contract §7.3 row
 * `upload_batch × retry_failed`, §4.4).
 *
 * ## Why a service, and why the admission must move with it
 *
 * `POST …/events/{eventId}/images:reprocess-failed` already answers the
 * contract's `202 { requeuedCount }`, but everything it takes to answer lives in
 * the route handler: the `eventActorAdmission(2)` **middleware** on line 37 and
 * the `find` → `getPlatformSettings` → `requeueImages` handler on lines 38–63.
 * `@/server/images/requeue` is the per-row write only (`requeue.ts:42`): it
 * takes rows a caller already loaded and admitted.
 *
 * The §7.3 delegate for a `upload_batch × retry_failed` feed action has no HTTP
 * request to run a middleware against, so the admission rule has to be
 * reachable from a plain function call — and it must be the **same** rule, not
 * a second copy of it. §0.4 is a non-oracle rule: a caller with no relationship
 * to the event gets the uniform `404 not_found` whether the request came
 * through the route or through the delegate. A service that skipped the
 * re-check would hand every caller who can reach the delegation their own bulk
 * reset over another organizer's event; a service that re-implemented the role
 * test would drift away from `admitEventActor` the first time that ladder
 * changes.
 *
 * This file therefore pins the whole service contract with **no HTTP layer**:
 * it calls the function with the ids it would receive from a delegate and
 * asserts on the database, the broker and the thrown error.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // @/server/images/retry-failed  (new; the GREEN adds it)
 * export interface RetryFailedEventImagesInput {
 *   readonly db: Db;
 *   readonly tenantId: ObjectId;      // the event's workspace, as the route holds it
 *   readonly eventId: ObjectId;
 *   readonly actorUserId: string;     // the caller Better Auth id (hex)
 *   readonly spaceKey: string;        // platformSettings.face.activeSpaceKey
 *   readonly requestId: string;
 *   readonly now: Date;
 *   readonly logger?: Logger;
 * }
 * export function retryFailedEventImages(
 *   input: RetryFailedEventImagesInput
 * ): Promise<{ readonly requeuedCount: number }>;
 * ```
 *
 * - **Admission.** The service re-checks the caller with the rule
 *   `eventActorAdmission(2)` applies (`@/server/events/access`: the
 *   tenant-scoped `events` read, then `resolveEventActorRole` — `organizer` or
 *   `co_organizer` on an unrevoked `event_organizers` row, or an active
 *   `tenantMembers` row of the event's workspace). A refusal is the same
 *   `AppError` the middleware produces: **`404 not_found`**, for a caller with
 *   no relationship, a revoked organizer, a member of another workspace, an
 *   event of another workspace, and an event that does not exist. A refusal
 *   writes nothing and enqueues nothing.
 * - **The work.** Exactly the rows `{eventId, deletedAt: null,
 *   "processing.status": "failed"}` of this event and this workspace, reset and
 *   re-enqueued through `requeueImages` — the service must not duplicate the
 *   `updateOne`/`enqueueWork` pair, so the reset keeps that module's contract
 *   (`resetProcessingForReprocess`: `attempts` zeroed, `maxAttempts`/
 *   `priority`/`modelKeys` kept, run state cleared, `queuedAt = now`).
 * - **The answer.** `{ requeuedCount }`, the count of rows it requeued — the
 *   route's answer today, so the route can become a thin delegate without its
 *   wire contract moving.
 *
 * ## RED on arrival
 *
 * The module does not exist on the trunk, so every case here dies on the
 * import. That alone proves nothing about the admission, which is why the
 * refusal cases are measured against a throwaway near-fix that implements the
 * requeue and **drops the re-check**: those cases then fail on their own
 * assertion (`expected { requeuedCount: 2 } to deeply equal 404 …`, rows
 * moved), not on a missing import.
 *
 * Out of scope: the route's own wire answer and its `202` are already pinned by
 * `event-images-management.test.ts` (I4 and the X1–X3 ladder, unchanged by this
 * file), and the `upload_batch × retry_failed` delegate arm plus the catalogue
 * flip belong to a later OP-140 card — this file asserts no feed row and no
 * action.
 */

/** The instant every seeded row is timed at; the service must use it, not the clock. */
const NOW = new Date("2026-11-23T09:00:00.000Z");

const DAY_MS = 86_400_000;

/** The face space the pipeline runs in (`platformSettings.face.activeSpaceKey`). */
const SPACE_KEY = "arcface_r100_512";

/** The correlation id the delegate would carry. */
const REQUEST_ID = "req_op140_retry_service";

/** The memoised memory queue every enqueue in this file goes through. */
function queue(): MemoryWorkQueue {
  return getWorkQueue() as MemoryWorkQueue;
}

/** The `event_images.processing` fields these cases read. */
interface StoredProcessing {
  readonly status?: string;
  readonly priority?: string;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly modelKeys?: Readonly<Record<string, string>>;
  readonly queuedAt?: Date;
  readonly lastError?: unknown;
  readonly queueRef?: { readonly messageId?: string } | null;
}

/** A signed-in caller's workspace with one event. */
interface Workspace {
  readonly owner: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** The instant the reset stamps, and the row it stamped. */
interface StoredRow {
  readonly processing?: StoredProcessing;
  readonly deletedAt?: Date | null;
}

/** A refusal the service threw, reduced to what §0.4 promises. */
interface Refusal {
  readonly status: number;
  readonly code: string;
}

/** Deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op140-image-retry-${name}`).digest("hex");
}

/** Insert one `tenants` row and make the caller its owner. */
async function seedTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP140 Studio",
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
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId: _id,
    userId: owner.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  return _id;
}

/** Insert one `events` row plus its organizer's `event_organizers` row. */
async function seedEvent(
  tenantKey: string,
  organizerUserId: ObjectId,
  role: "organizer" | "co_organizer" = "organizer"
): Promise<ObjectId> {
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
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: organizerUserId.toHexString(),
    role,
    status: "active",
    revokedAt: null,
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
    schemaVersion: 1,
  });
  return _id;
}

/** Sign a caller in and give them a workspace with one event they organize. */
async function seedWorkspace(prefix: string): Promise<Workspace> {
  const owner = await app.signIn(makeIdentity(prefix));
  const tenantId = await seedTenant(`op140-${prefix}`, owner);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, owner.userId);
  return { owner, tenantId, tenantKey, eventId };
}

/** Insert one stored `media_assets` row for an image. */
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
      bytes: 4_210_310,
      contentType: "image/jpeg",
      checksum: contentHash,
      storedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    },
    derivatives: {},
    status: "derivatives_ready",
    refCount: 1,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  return _id;
}

/** The §18.2 `failed` state a requeue has to reset. */
const FAILED_PROCESSING = {
  status: "failed",
  priority: "normal",
  attempts: 2,
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
} as const;

/** Insert one `event_images` join row. */
async function seedImage(fields: {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly name: string;
  readonly status: string;
  readonly attempts?: number;
  readonly deletedAt?: Date | null;
  readonly processing?: Record<string, unknown>;
}): Promise<ObjectId> {
  const _id = new ObjectId();
  const assetId = await seedAsset(fields.tenantKey, hashFor(fields.name));
  const processing = fields.processing ?? {
    ...FAILED_PROCESSING,
    status: fields.status,
    attempts: fields.attempts ?? FAILED_PROCESSING.attempts,
  };
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id,
    tenantId: fields.tenantKey,
    eventId: fields.eventId,
    assetId,
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing,
    faceCount: 0,
    visibility: "visible",
    deletedAt: fields.deletedAt ?? null,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  return _id;
}

/** Read one `event_images` row through the driver, unscoped. */
async function readRow(imageId: ObjectId): Promise<StoredRow | null> {
  const row = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
  return row as StoredRow | null;
}

/** Record a `tenantMembers` row for a user in a workspace. */
async function addMember(tenantId: ObjectId, user: SignedInUser): Promise<void> {
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role: "member",
    status: "active",
    joinedAt: new Date(NOW.getTime() - 10 * DAY_MS),
  });
}

/** The service call under test: the delegate's own shape, no HTTP layer. */
function retry(
  workspace: Workspace,
  actorUserId: ObjectId | string,
  overrides: Partial<RetryFailedEventImagesInput> = {}
): Promise<{ readonly requeuedCount: number }> {
  return retryFailedEventImages({
    db: app.db,
    tenantId: workspace.tenantId,
    eventId: workspace.eventId,
    actorUserId: typeof actorUserId === "string" ? actorUserId : actorUserId.toHexString(),
    spaceKey: SPACE_KEY,
    requestId: REQUEST_ID,
    now: NOW,
    ...overrides,
  });
}

/**
 * Run the service and reduce a refusal to its wire facts.
 *
 * The service has no pipeline around it, so the only observable of a refusal is
 * the `AppError` it throws: §0.4 promises the uniform `404 not_found`, exactly
 * what the route's `tenantStage` denial produces. `null` means the call
 * resolved — the failure a service without the re-check produces — so a case
 * reports both "it did not refuse" and "the rows moved".
 */
async function refusalOf(call: Promise<unknown>): Promise<Refusal | null> {
  try {
    await call;
  } catch (error: unknown) {
    if (!isAppError(error)) {
      throw error;
    }
    return { status: error.status, code: error.code };
  }
  return null;
}

/** The work envelopes the broker holds for one image id. */
function envelopesFor(imageId: ObjectId): readonly Record<string, unknown>[] {
  const target = imageId.toHexString();
  return queue()
    .outbox.filter((message) => message.envelope.id === target)
    .map((message) => message.envelope as unknown as Record<string, unknown>);
}

/**
 * How many work items the broker has accepted so far.
 *
 * The memory adapter's `outbox` is an append-only ledger (a `claim` marks an
 * entry in flight, it does not remove it), so "the service enqueued nothing" is
 * a statement about the count before and after the call, never about an empty
 * list.
 */
function outboxLength(): number {
  return queue().outbox.length;
}

/** Read the first row of a non-empty read, failing with a naming message. */
function firstOf<T>(rows: readonly T[], what: string): T {
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`expected ${what}`);
  }
  return first;
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op140-image-retry", env: { QUEUE_PROVIDER: "memory" } });
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
    COLLECTIONS.domainEvents,
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
});

afterAll(async () => {
  await app.cleanup();
});

describe("retryFailedEventImages — the event's failed images (route contract I4, no HTTP layer)", () => {
  it("requeues only this event's failed images and answers their count", async () => {
    // Arrange — two failed rows of this event, a done one, a queued one, a
    // soft-deleted failure, and a failure of another event of the same tenant.
    const workspace = await seedWorkspace("retry-scope");
    const otherEventId = await seedEvent(workspace.tenantKey, workspace.owner.userId);
    const failedOne = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "scope-failed-one",
      status: "failed",
    });
    const failedTwo = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "scope-failed-two",
      status: "failed",
      attempts: 1,
    });
    const done = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "scope-done",
      status: "done",
      attempts: 1,
    });
    const queued = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "scope-queued",
      status: "queued",
      attempts: 4,
    });
    const deleted = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "scope-deleted",
      status: "failed",
      deletedAt: new Date(NOW.getTime() - DAY_MS),
    });
    const otherEvent = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: otherEventId,
      name: "scope-other-event",
      status: "failed",
      attempts: 3,
    });

    // Act — the service is called the way the §7.3 delegate will call it.
    const answer = await retry(workspace, workspace.owner.userId);

    // Assert — the contract's exact answer.
    expect(answer).toEqual({ requeuedCount: 2 });

    // Both failures were reset…
    expect((await readRow(failedOne))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
    });
    expect((await readRow(failedTwo))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
    });

    // …and nothing else was touched, in this event or the next.
    expect((await readRow(done))?.processing).toMatchObject({ status: "done", attempts: 1 });
    expect((await readRow(queued))?.processing).toMatchObject({
      status: "queued",
      attempts: 4,
    });
    expect((await readRow(deleted))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect((await readRow(otherEvent))?.processing).toMatchObject({
      status: "failed",
      attempts: 3,
    });

    // One work item for each requeued image, and none for anything else.
    expect(envelopesFor(failedOne)).toHaveLength(1);
    expect(envelopesFor(failedTwo)).toHaveLength(1);
    expect(envelopesFor(done)).toEqual([]);
    expect(envelopesFor(queued)).toEqual([]);
    expect(envelopesFor(deleted)).toEqual([]);
    expect(envelopesFor(otherEvent)).toEqual([]);
  });

  it("resets through the requeue contract: budget and policy kept, the caller's instant stamped", async () => {
    // Arrange — a third attempt that failed with its budget half spent.
    const workspace = await seedWorkspace("retry-reset");
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "reset-contract",
      status: "failed",
      attempts: 3,
      processing: {
        ...FAILED_PROCESSING,
        attempts: 3,
        priority: "high",
        maxAttempts: 5,
        modelKeys: { detector: "antelopev2", embedder: "arcface_r100" },
      },
    });

    // Act
    expect(await retry(workspace, workspace.owner.userId)).toEqual({ requeuedCount: 1 });

    // Assert — §18.2's reset: run state cleared, policy and budget preserved.
    const processing = (await readRow(imageId))?.processing;
    expect(processing).toMatchObject({
      status: "queued",
      attempts: 0,
      priority: "high",
      maxAttempts: 5,
      modelKeys: { detector: "antelopev2", embedder: "arcface_r100" },
      lastError: null,
      leaseExpiresAt: null,
      workerId: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    });
    expect(processing?.queuedAt).toEqual(NOW);
    expect(typeof processing?.queueRef?.messageId).toBe("string");

    // The work item carries the caller's correlation and the face space.
    const envelopes = envelopesFor(imageId);
    expect(envelopes).toHaveLength(1);
    expect(firstOf(envelopes, "one work envelope for the requeued image")).toMatchObject({
      kind: "event_image",
      id: imageId.toHexString(),
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId.toHexString(),
      priority: "high",
      spaceKey: SPACE_KEY,
      traceId: REQUEST_ID,
    });
  });

  it("answers zero and enqueues nothing for an event with no failed image", async () => {
    // Arrange — one done image, so the event is admitted but has no work.
    const workspace = await seedWorkspace("retry-empty");
    const done = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "empty-done",
      status: "done",
      attempts: 1,
    });
    const enqueuedBefore = outboxLength();

    // Act
    const answer = await retry(workspace, workspace.owner.userId);

    // Assert
    expect(answer).toEqual({ requeuedCount: 0 });
    expect((await readRow(done))?.processing).toMatchObject({ status: "done", attempts: 1 });
    expect(outboxLength()).toBe(enqueuedBefore);
  });
});

describe("retryFailedEventImages — the admission re-checked inside the service", () => {
  it("admits a co-organizer who holds no tenant member row", async () => {
    // Arrange — a co-organizer of the event who was never made a workspace member.
    const workspace = await seedWorkspace("retry-co-organizer");
    const coOrganizer = await app.signIn(makeIdentity("retry-co-organizer-peer"));
    await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId,
      userId: coOrganizer.userId.toHexString(),
      role: "co_organizer",
      status: "active",
      revokedAt: null,
      createdAt: new Date(NOW.getTime() - 10 * DAY_MS),
      updatedAt: new Date(NOW.getTime() - 10 * DAY_MS),
      schemaVersion: 1,
    });
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "co-organizer-failed",
      status: "failed",
    });

    // Act
    const answer = await retry(workspace, coOrganizer.userId);

    // Assert — the same ladder the middleware applies admits them.
    expect(answer).toEqual({ requeuedCount: 1 });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect(envelopesFor(imageId)).toHaveLength(1);
  });

  it("admits an active tenant member who organizes nothing", async () => {
    // Arrange — a member of the workspace with no role on this event.
    const workspace = await seedWorkspace("retry-tenant-member");
    const member = await app.signIn(makeIdentity("retry-tenant-member-peer"));
    await addMember(workspace.tenantId, member);
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "member-failed",
      status: "failed",
    });

    // Act
    const answer = await retry(workspace, member.userId);

    // Assert
    expect(answer).toEqual({ requeuedCount: 1 });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  it("refuses 404 not_found for a caller with no relationship to the event, writing nothing", async () => {
    // Arrange — a signed-in caller who is neither an organizer nor a member.
    const workspace = await seedWorkspace("retry-outsider");
    const outsider = await app.signIn(makeIdentity("retry-outsider-peer"));
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "outsider-failed",
      status: "failed",
    });
    const enqueuedBefore = outboxLength();

    // Act
    const refusal = await refusalOf(retry(workspace, outsider.userId));

    // Assert — the middleware's answer, without a middleware.
    expect(refusal).toEqual({ status: 404, code: "not_found" });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(outboxLength()).toBe(enqueuedBefore);
  });

  it("refuses 404 not_found once the organizer's row is revoked, writing nothing", async () => {
    // Arrange — the caller keeps a relationship, but it was taken away.
    const workspace = await seedWorkspace("retry-revoked");
    const revokedUser = await app.signIn(makeIdentity("retry-revoked-peer"));
    await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId,
      userId: revokedUser.userId.toHexString(),
      role: "organizer",
      status: "revoked",
      revokedAt: new Date(NOW.getTime() - DAY_MS),
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
      updatedAt: new Date(NOW.getTime() - DAY_MS),
      schemaVersion: 1,
    });
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "revoked-failed",
      status: "failed",
    });
    const enqueuedBefore = outboxLength();

    // Act
    const refusal = await refusalOf(retry(workspace, revokedUser.userId));

    // Assert — a revoked row is not a relationship.
    expect(refusal).toEqual({ status: 404, code: "not_found" });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(outboxLength()).toBe(enqueuedBefore);
  });

  it("refuses 404 not_found for a member of another workspace, writing nothing", async () => {
    // Arrange — an active member, but of a different workspace.
    const workspace = await seedWorkspace("retry-foreign-member");
    const foreignWorkspace = await seedWorkspace("retry-foreign-member-home");
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "foreign-member-failed",
      status: "failed",
    });
    const enqueuedBefore = outboxLength();

    // Act — the other workspace's owner is nobody on this event.
    const refusal = await refusalOf(retry(workspace, foreignWorkspace.owner.userId));

    // Assert
    expect(refusal).toEqual({ status: 404, code: "not_found" });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(outboxLength()).toBe(enqueuedBefore);
  });

  it("refuses 404 not_found when the event belongs to another workspace, writing nothing", async () => {
    // Arrange — the caller owns a *different* event; the ids are mixed up.
    const workspace = await seedWorkspace("retry-foreign-event");
    const foreignWorkspace = await seedWorkspace("retry-foreign-event-home");
    const foreignImage = await seedImage({
      tenantKey: foreignWorkspace.tenantKey,
      eventId: foreignWorkspace.eventId,
      name: "foreign-event-failed",
      status: "failed",
    });
    const enqueuedBefore = outboxLength();

    // Act — this workspace's id with the other workspace's event id.
    const refusal = await refusalOf(
      retry(workspace, foreignWorkspace.owner.userId, { eventId: foreignWorkspace.eventId })
    );

    // Assert — the tenant-scoped read is the workspace check (§0.4).
    expect(refusal).toEqual({ status: 404, code: "not_found" });
    expect((await readRow(foreignImage))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(outboxLength()).toBe(enqueuedBefore);
  });

  it("refuses 404 not_found when the event does not exist, writing nothing", async () => {
    // Arrange — an organizer of this workspace, an event id nobody owns.
    const workspace = await seedWorkspace("retry-missing-event");
    const imageId = await seedImage({
      tenantKey: workspace.tenantKey,
      eventId: workspace.eventId,
      name: "missing-event-failed",
      status: "failed",
    });
    const enqueuedBefore = outboxLength();

    // Act
    const refusal = await refusalOf(
      retry(workspace, workspace.owner.userId, { eventId: new ObjectId() })
    );

    // Assert — this event's own failure stayed put: the service refused before
    // it read any image.
    expect(refusal).toEqual({ status: 404, code: "not_found" });
    expect((await readRow(imageId))?.processing).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect(outboxLength()).toBe(enqueuedBefore);
  });
});
