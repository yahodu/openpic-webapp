import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { isTransactionRetryLimitError, withTransaction } from "@/server/db/transaction";
import { eventActorAdmission, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { getLogger } from "@/server/logging";
import { enqueueWork } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { SNIFF_BYTES, guardUploadType } from "@/server/settings/upload-guards";
import { consumeEntitlement } from "@/server/services/entitlements";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import {
  eventImageSchema,
  toEventImage,
  type EventImageAsset,
} from "@/server/uploads/event-image-dto";
import { attachImage, type AttachedImageRow } from "@/server/uploads/registration";
import { batchIdValue, extensionForMime } from "@/server/uploads/single-put";
import { sizeWithinTolerance } from "@/server/uploads/size-tolerance";
import { uploadWindowClosed } from "@/server/uploads/upload-window";

/**
 * `POST …/uploads/{uploadSessionId}/complete` — the registration transaction
 * (OP-124 I1–I4/I6/I8/I9, contract §5.3; ADR-0721 D2).
 *
 * The bytes are already in storage, put there by the client's own `PUT` to the
 * presigned URL — they never transit this server. All the server does is
 * **verify** and then **register**:
 *
 * 1. `HeadObject` the object it presigned, and refuse a stored size that
 *    differs from the client's `bytes` by more than 1 % (`409 size_mismatch`,
 *    U1's rule);
 * 2. sniff the stored object's first bytes and refuse a file whose content
 *    contradicts its extension and declared type (`415 unsupported_media_type`,
 *    the object deleted and nothing written);
 * 3. in **one transaction**: consume `storage.bytes` + `images.per_event`,
 *    upsert the asset (`refCount` + 1), insert the join row with the event's
 *    next `sequence`, advance the event counters and close the session;
 * 4. after the commit, enqueue the pipeline work item through the memoized
 *    `getWorkQueue()` — a broker failure is a `warn`, never a failed upload
 *    (§18.1, I6).
 *
 * A duplicate — the event already holds this asset — is not an error: the
 * unique `{eventId, assetId}` index is the arbiter, the transaction writes
 * nothing, and the answer is `200` with the existing image (§5.3, I4).
 *
 * Counters always follow the **event's** tenant, never the caller's own
 * workspace: a co-organizer from another tenant moves only `{tenantId}`'s usage
 * and is refused with that tenant's limit (I10/I11).
 */

/** The §5.3 completion body. */
const completeBodySchema = z.object({
  etag: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

/** The `events` fields this route reads outside the transaction. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
}

/** The `upload_sessions` fields this route reads (§16.2). */
interface SessionRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly batchId: ObjectId | string;
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly createdAt: Date;
}

/** The `media_assets` fields this route reads (§16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly storage: EventImageAsset;
}

/** What one completion produced: the row, its asset and whether it was new. */
interface CompletionOutcome {
  readonly row: AttachedImageRow;
  readonly asset: EventImageAsset;
  readonly duplicate: boolean;
}

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/:uploadSessionId/complete",
  body: completeBodySchema,
  response: eventImageSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits four segments from the end here (ADR-0721 D2).
  tenant: tenantStage({ admission: eventActorAdmission(4) }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal, requestId } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 4 });
    const eventIdHex = eventId.toHexString();
    const sessionId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const { bytes } = ctx.body;

    const event = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventRow | null;
    if (event === null) {
      throw appError("not_found");
    }

    const session = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.uploadSessions)
      .findOne({ _id: sessionId, eventId })) as SessionRow | null;
    if (session === null) {
      throw appError("not_found");
    }

    const settings = await getPlatformSettings({ db });
    const now = systemClock.now();

    const role = await resolveEventActorRole(db, eventId, tenantKey, principal);
    const windowClosed = uploadWindowClosed({
      windowEndsAt: event.uploadWindowEndsAt,
      now,
      canExtend: role === "organizer",
      startedAt: session.createdAt,
      graceMinutes: settings.upload.inflightGraceMinutes,
    });
    if (windowClosed !== null) {
      throw appError("upload_window_closed", { details: { ...windowClosed } });
    }

    // Storage is the source of truth for what was actually uploaded (§5.3).
    const storage = getObjectStorage();
    const objectKey = buildObjectKey(
      session.contentHash,
      extensionForMime(session.declaredMimeType)
    );
    const head = await storage.headObject("originals", objectKey);
    if (!sizeWithinTolerance({ declaredBytes: bytes, storedBytes: head.bytes })) {
      throw appError("size_mismatch", {
        details: { declaredBytes: bytes, storedBytes: head.bytes },
      });
    }

    const prefix = await storage.getObjectRange("originals", objectKey, {
      start: 0,
      end: SNIFF_BYTES - 1,
    });
    const guard = guardUploadType({
      bytes: prefix,
      fileName: session.fileName,
      declaredMimeType: session.declaredMimeType,
    });
    if (!guard.ok) {
      await storage.deleteObject("originals", objectKey);
      throw appError("unsupported_media_type", { details: { ...guard.details } });
    }

    const assets = tenantRepo(tenantKey, db).collection(COLLECTIONS.mediaAssets);
    const images = tenantRepo(tenantKey, db).collection(COLLECTIONS.eventImages);
    const sessions = tenantRepo(tenantKey, db).collection(COLLECTIONS.uploadSessions);
    const uploadBatchId = batchIdValue(String(session.batchId));

    /** The completion the event already holds for this hash, or `null`. */
    const settledCompletion = async (
      txn: Parameters<typeof attachImage>[0]["session"] | undefined
    ): Promise<CompletionOutcome | null> => {
      const options = txn === undefined ? {} : { session: txn };
      const asset = (await assets.findOne(
        { contentHash: session.contentHash },
        options
      )) as AssetRow | null;
      if (asset === null) {
        return null;
      }
      const row = (await images.findOne(
        { eventId, assetId: asset._id },
        options
      )) as AttachedImageRow | null;
      return row === null ? null : { row, asset: asset.storage, duplicate: true };
    };

    let outcome: CompletionOutcome;
    try {
      outcome = await withTransaction(async (txn) => {
        // The event may already hold this asset (a co-organizer's duplicate
        // upload): the unique `{eventId, assetId}` pair is the arbiter.
        const existing = await settledCompletion(txn);
        if (existing !== null) {
          await sessions.updateOne(
            { _id: sessionId },
            { $set: { status: "completed", assetId: existing.row.assetId, updatedAt: now } },
            { session: txn }
          );
          return existing;
        }

        await consumeEntitlement(
          txn,
          tenantKey,
          "storage.bytes",
          bytes,
          {
            subjectRef: { kind: "event", id: eventIdHex },
            actorRef: { kind: "user", id: principal },
          },
          { db }
        );

        const existingAsset = (await assets.findOne(
          { contentHash: session.contentHash },
          { session: txn }
        )) as AssetRow | null;
        let assetId: ObjectId;
        let asset: EventImageAsset;
        if (existingAsset === null) {
          assetId = new ObjectId();
          asset = { bytes, contentType: session.declaredMimeType };
          await assets.insertOne(
            {
              _id: assetId,
              tenantId: tenantKey,
              contentHash: session.contentHash,
              kind: "event_image",
              storage: {
                locationKey: "originals",
                objectKey,
                bytes,
                contentType: session.declaredMimeType,
                checksum: session.contentHash,
                storedAt: now,
              },
              derivatives: {},
              imageMeta: {},
              status: "stored",
              refCount: 1,
              createdAt: now,
            },
            { session: txn }
          );
        } else {
          assetId = existingAsset._id;
          asset = existingAsset.storage;
          await assets.updateOne({ _id: assetId }, { $inc: { refCount: 1 } }, { session: txn });
        }

        const row = await attachImage({
          session: txn,
          db,
          tenantKey,
          eventId,
          assetId,
          actorUserId: principal,
          uploadBatchId,
          storageBytes: bytes,
          now,
        });
        await sessions.updateOne(
          { _id: sessionId },
          { $set: { status: "completed", assetId, updatedAt: now } },
          { session: txn }
        );
        return { row, asset, duplicate: false };
      });
    } catch (error) {
      // A write race surfaced as a duplicate row or an exhausted retry budget:
      // the committed winner is the answer, exactly as a retried attempt sees
      // it, so the duplicate is never an error (§16.3, I4).
      if (!isDuplicateKeyError(error) && !isTransactionRetryLimitError(error)) {
        throw error;
      }
      const settled = await settledCompletion(undefined);
      if (settled === null) {
        throw error;
      }
      outcome = settled;
    }

    if (!outcome.duplicate) {
      await enqueueWork({
        db,
        queue: getWorkQueue(),
        collection: COLLECTIONS.eventImages,
        work: {
          kind: "event_image",
          id: outcome.row._id.toHexString(),
          tenantId: tenantKey,
          eventId: eventIdHex,
          spaceKey: settings.face.activeSpaceKey,
          traceId: requestId,
          priority: "normal",
        },
        logger: getLogger(),
      });
    }

    getLogger().info("upload completed", {
      event: "upload.completed",
      tenantId: tenantKey,
      eventId: eventIdHex,
      uploadSessionId: sessionId.toHexString(),
      bytes,
      duplicate: outcome.duplicate,
    });

    return {
      status: outcome.duplicate ? 200 : 201,
      body: toEventImage(outcome.row, outcome.asset),
    };
  },
});
