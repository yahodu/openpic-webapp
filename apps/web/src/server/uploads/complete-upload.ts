import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { isTransactionRetryLimitError, withTransaction } from "@/server/db/transaction";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { enqueueWork } from "@/server/queue/enqueue-work";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { tenantRepo } from "@/server/repos";
import { SNIFF_BYTES, guardUploadType } from "@/server/settings/upload-guards";
import { consumeEntitlement } from "@/server/services/entitlements";
import { getObjectStorage } from "@/server/storage/get-object-storage";

import {
  checkUploadBatchTransition,
  emitUploadQuotaBlocked,
  isQuotaRefusal,
} from "./batch-notifications";
import { toEventImage, type EventImageAsset, type EventImageDto } from "./event-image-dto";
import { attachImage, type AttachedImageRow } from "./registration";
import { batchIdValue } from "./single-put";
import { sizeWithinTolerance } from "./size-tolerance";

/**
 * Verifying and registering one uploaded object (OP-124 §5.3; OP-125 §5.4).
 *
 * Both completion paths — a single `PUT` and a `CompleteMultipartUpload` — end
 * the same way: the object is in storage, so the server only **verifies** it and
 * then **registers** it in one transaction. The halves are identical, so they
 * live here and each route supplies the two facts only it knows: the object's
 * key (single-PUT derives it from the hash, multipart resolves it from the
 * handle) and how many bytes the client declared (`null` trusts the assembled
 * object, which is what a multipart completion has).
 *
 * The bytes never transit the server at any point.
 */

/** The `upload_sessions` fields a completion reads (§16.2). */
export interface CompletionSession {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly batchId: ObjectId | string;
  readonly fileName: string;
  readonly declaredMimeType: string;
}

/** Everything one completion needs. */
export interface CompleteStoredUploadInput {
  readonly db: Db;
  /** The **event's** tenant — never the caller's own workspace (ADR-0721 D3). */
  readonly tenantKey: string;
  /** The authenticated actor registering the upload. */
  readonly principal: string;
  readonly eventId: ObjectId;
  /** The upload session, already loaded and bound to the caller. */
  readonly session: CompletionSession;
  /** The object key the session's upload wrote to. */
  readonly objectKey: string;
  /** The client's declared byte count, or `null` to trust the stored object. */
  readonly declaredBytes: number | null;
  /** The request id the pipeline assigned (traced into the pipeline work item). */
  readonly requestId: string;
  /** The request instant (`systemClock.now()`), used for every stored timestamp. */
  readonly now: Date;
  /** The face space the pipeline work item runs in (`platformSettings.face.activeSpaceKey`). */
  readonly spaceKey: string;
}

/** A completion's answer: the `EventImage` and the status it is served with. */
export interface CompletedUpload {
  readonly status: number;
  readonly body: EventImageDto;
}

/** The `media_assets` fields this path reads (§16.1). */
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

/**
 * `HeadObject`/sniff the uploaded object, then register it on the event.
 *
 * A stored size more than 1 % off the client's declaration is `409
 * size_mismatch` (skipped when the caller has no declaration); a stored object
 * whose first bytes contradict its extension and type is `415
 * unsupported_media_type`, with the object deleted and nothing written. Then, in
 * one transaction: consume `storage.bytes` + `images.per_event`, upsert the
 * asset (`refCount` + 1), insert the join row with the event's next `sequence`,
 * advance the event counters and close the session. The pipeline work item is
 * enqueued after the commit — a broker failure is a `warn`, never a failed
 * upload (§18.1).
 *
 * A duplicate — the event already holds this asset — is not an error: the unique
 * `{eventId, assetId}` index is the arbiter and the answer is `200` with the
 * existing image.
 *
 * @param input - The event, the session, the object's key and the declaration.
 * @returns The `EventImage` DTO and the status to serve it with.
 */
export async function completeStoredUpload(
  input: CompleteStoredUploadInput
): Promise<CompletedUpload> {
  const { db, tenantKey, principal, eventId, session, objectKey, requestId } = input;
  const eventIdHex = eventId.toHexString();

  // Storage is the source of truth for what was actually uploaded (§5.3).
  const storage = getObjectStorage();
  const head = await storage.headObject("originals", objectKey);
  const bytes = input.declaredBytes ?? head.bytes;
  if (
    input.declaredBytes !== null &&
    !sizeWithinTolerance({ declaredBytes: bytes, storedBytes: head.bytes })
  ) {
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

  const now = input.now;
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
      { contentHash: session.contentHash, kind: "event_image" },
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
          { _id: session._id },
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

      // Dedupe is kind-aware: a selfie's row for the same bytes carries no
      // `storage` descriptor and is not this upload's asset (ADR-0801).
      const existingAsset = (await assets.findOne(
        { contentHash: session.contentHash, kind: "event_image" },
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
        { _id: session._id },
        { $set: { status: "completed", assetId, updatedAt: now } },
        { session: txn }
      );
      return { row, asset, duplicate: false };
    });
  } catch (error) {
    // A plan refusal is the one completion failure the humans can act on: the
    // uploader is stuck and only the organizer can buy storage (§4.7), so the
    // pair is told once per event per six hours — never per file.
    if (isQuotaRefusal(error)) {
      await emitUploadQuotaBlocked({
        db,
        tenantKey,
        eventId,
        batchId: String(session.batchId),
        uploaderUserId: principal,
      });
    }
    // A write race surfaced as a duplicate row or an exhausted retry budget:
    // the committed winner is the answer, exactly as a retried attempt sees it,
    // so the duplicate is never an error (§16.3).
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
        spaceKey: input.spaceKey,
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
    uploadSessionId: session._id.toHexString(),
    bytes,
    duplicate: outcome.duplicate,
  });

  // This completion may have settled the batch's last file (a replayed or
  // duplicate completion can), so the terminal transition is checked here as
  // well as by the pipeline-indexed cron (ADR-0760 A1). A failed check must not
  // fail an upload that already committed.
  try {
    await checkUploadBatchTransition({ db, tenantKey, eventId, batchId: String(session.batchId) });
  } catch (error) {
    getLogger().warn("upload.batch.transition_check_failed", {
      event: "upload.batch.transition_check_failed",
      tenantId: tenantKey,
      eventId: eventIdHex,
      err: error,
    });
  }

  return {
    status: outcome.duplicate ? 200 : 201,
    body: toEventImage(outcome.row, outcome.asset),
  };
}
