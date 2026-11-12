import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent, type DomainEventInput } from "@/server/domain/domain-events";
import { getLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

import {
  describeUploadFailure,
  deriveUploadBatchPhase,
  type BatchFileCounts,
  type BatchPipelineCounts,
  type UploadBatchPhase,
} from "./batch-status";
import { batchIdValue } from "./single-put";

/**
 * The batch read and the upload lifecycle notifications (OP-126, contract §5.5,
 * notification §4.7; ADR-0760).
 *
 * One read answers §5.5's status body, and one check folds the same counts into
 * a phase and emits the batch's summary. Both call
 * {@link deriveUploadBatchPhase}, so a 3-second poll and the indexed cron tick
 * can never disagree about one batch.
 *
 * The summary is emitted **once per (batch, uploader)** — the dedupe key names
 * both, so a batch two organizers uploaded together tells each of them once
 * (ADR-0760 D4) and a re-check emits nothing. A rejection or a skipped duplicate
 * is folded into the same summary and never becomes a per-file notification.
 */

/** The `upload_sessions` fields the batch read needs (§16.2). */
interface SessionRow {
  readonly _id: ObjectId;
  readonly batchId: ObjectId | string;
  readonly contentHash: string;
  readonly fileName: string;
  readonly status: string;
  readonly createdByUserId: ObjectId | string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expireAt?: Date;
}

/** The `event_images` fields the batch read needs (§16.3). */
interface ImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly processing?: {
    readonly status?: string;
    readonly lastError?: { readonly code?: string; readonly message?: string };
  };
}

/** The §5.5 status body, exactly the eight keys the contract lists. */
export interface UploadBatchStatus {
  readonly batchId: string;
  readonly phase: UploadBatchPhase;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly files: BatchFileCounts;
  readonly pipeline: BatchPipelineCounts;
  readonly failures: readonly {
    readonly eventImageId: string;
    readonly fileName: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }[];
  readonly stalledSessions: readonly {
    readonly uploadSessionId: string;
    readonly fileName: string;
    readonly uploadedBytes: number;
    readonly totalBytes: number;
    readonly abortDeadline: string;
  }[];
}

/** What one batch read produced: the answer plus the facts the check needs. */
interface BatchSnapshot {
  readonly status: UploadBatchStatus;
  /** The distinct uploaders of the batch (`upload_sessions.createdByUserId`). */
  readonly uploaders: readonly string[];
  /** The batch's earliest session instant, or `null` for an unseen batch. */
  readonly startedAt: Date | null;
}

/** Seams shared by the read and the check. */
export interface UploadBatchInput {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The **event's** tenant, never the caller's own workspace. */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  /** The client-generated `batchId` (§5.2). */
  readonly batchId: string;
}

/** The hex form of a stored id (`ObjectId` or string). */
function idHex(value: ObjectId | string): string {
  return typeof value === "string" ? value : value.toHexString();
}

/** A filter matching the stored `batchId` in either of its two shapes. */
function batchMatch(batchId: string): { readonly $in: readonly (ObjectId | string)[] } {
  return { $in: [batchIdValue(batchId), batchId] };
}

/** Tally the batch's images by their pipeline state. */
function countPipeline(images: readonly ImageRow[]): BatchPipelineCounts {
  const counts = { queued: 0, processing: 0, done: 0, failed: 0 };
  for (const image of images) {
    const status = image.processing?.status ?? "queued";
    if (status in counts) {
      counts[status as keyof typeof counts] += 1;
    }
  }
  return counts;
}

/** Read the batch's sessions and images and compose the §5.5 answer. */
async function readBatchSnapshot(input: UploadBatchInput): Promise<BatchSnapshot> {
  const db = input.db ?? getDb();
  const { tenantKey, eventId, batchId } = input;
  const repo = () => tenantRepo(tenantKey, db);
  const now = systemClock.now();

  const [sessionRows, imageRows] = await Promise.all([
    repo()
      .collection(COLLECTIONS.uploadSessions)
      .find({ eventId, batchId: batchMatch(batchId) })
      .toArray(),
    repo()
      .collection(COLLECTIONS.eventImages)
      .find({ eventId, uploadBatchId: batchMatch(batchId) })
      .toArray(),
  ]);
  const sessions = sessionRows as unknown as readonly SessionRow[];
  const images = imageRows as unknown as readonly ImageRow[];

  const fileNameByHash = new Map(
    sessions.map((session) => [session.contentHash, session.fileName])
  );

  const failedImages = images.filter((image) => image.processing?.status === "failed");
  const failedAssetIds = failedImages.map((image) => image.assetId);
  const assets =
    failedAssetIds.length === 0
      ? []
      : ((await repo()
          .collection(COLLECTIONS.mediaAssets)
          .find({ _id: { $in: failedAssetIds } })
          .toArray()) as unknown as readonly {
          readonly _id: ObjectId;
          readonly contentHash: string;
        }[]);
  const hashByAssetId = new Map(
    assets.map((asset) => [asset._id.toHexString(), asset.contentHash])
  );

  const files: BatchFileCounts = {
    total: sessions.length,
    uploaded: images.length,
    // Neither a skipped duplicate nor a `batch-resolve` rejection is persisted
    // as a batch fact yet (ADR-0760 D3), so both read 0 rather than being
    // reconstructed from session state that does not record them.
    duplicatesSkipped: 0,
    rejected: 0,
    // A session that never completed is one that was aborted or whose five-day
    // window expired; a pending session is still on the wire, so it keeps the
    // batch `uploading` rather than failing it.
    failedUpload: sessions.filter(
      (session) =>
        session.status === "aborted" ||
        session.status === "failed" ||
        (session.status !== "completed" &&
          session.expireAt !== undefined &&
          session.expireAt.getTime() <= now.getTime())
    ).length,
  };
  const pipeline = countPipeline(images);
  const phase = deriveUploadBatchPhase({ files, pipeline });

  const startedAt =
    sessions.length === 0
      ? null
      : sessions
          .map((session) => session.createdAt)
          .reduce((earliest, instant) => (instant < earliest ? instant : earliest));
  const settledAt =
    sessions.length === 0
      ? null
      : sessions
          .map((session) => session.updatedAt)
          .reduce((latest, instant) => (instant > latest ? instant : latest));

  const failures = failedImages.map((image) => {
    const failure = describeUploadFailure({
      code: image.processing?.lastError?.code ?? "",
    });
    const hash = hashByAssetId.get(image.assetId.toHexString());
    return {
      eventImageId: image._id.toHexString(),
      fileName: (hash === undefined ? undefined : fileNameByHash.get(hash)) ?? "",
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    };
  });

  return {
    status: {
      batchId,
      phase,
      // An unseen batch has no session to date it; the poll itself is the
      // earliest instant it could be said to exist. Not pinned, never terminal.
      createdAt: (startedAt ?? systemClock.now()).toISOString(),
      completedAt:
        phase === "complete" || phase === "complete_with_errors"
          ? (settledAt?.toISOString() ?? null)
          : null,
      files,
      pipeline,
      failures,
      // The 24-hour idle sweep needs a live `ListParts` and belongs to OP-136;
      // this read never calls the provider.
      stalledSessions: [],
    },
    uploaders: [...new Set(sessions.map((session) => idHex(session.createdByUserId)))],
    startedAt,
  };
}

/**
 * Compose §5.5's status body for one batch of one event.
 *
 * @param input - The event, the batch id and the database seam.
 * @returns The eight-key §5.5 answer.
 */
export async function readUploadBatch(input: UploadBatchInput): Promise<UploadBatchStatus> {
  return (await readBatchSnapshot(input)).status;
}

/** Emit one outbox row, logging rather than throwing on a broken outbox. */
async function safeEmit(input: DomainEventInput, db: Db): Promise<void> {
  try {
    await emitDomainEvent(input, { db });
  } catch (error) {
    getLogger().warn("upload.batch.emit_failed", {
      event: "upload.batch.emit_failed",
      tenantId: input.tenantId,
      eventKey: input.eventKey,
      err: error,
    });
  }
}

/**
 * Detect a batch's terminal phase and emit its summary once per uploader.
 *
 * This is the seam OP-136's pipeline-indexed cron calls (and the completion
 * endpoints call after their commit). It emits nothing while the batch is still
 * uploading or processing, and nothing for a batch whose id no client has used,
 * so an idle poll can never manufacture a notification.
 *
 * @param input - The event, the batch id and the database seam.
 * @returns The phase the batch is in at the check.
 */
export async function checkUploadBatchTransition(
  input: UploadBatchInput
): Promise<{ readonly phase: UploadBatchPhase }> {
  const snapshot = await readBatchSnapshot(input);
  const { status } = snapshot;
  if (status.phase !== "complete" && status.phase !== "complete_with_errors") {
    return { phase: status.phase };
  }

  const db = input.db ?? getDb();
  const eventKey =
    status.phase === "complete" ? "upload.batch.completed" : "upload.batch.completed_with_errors";
  const durationMs =
    snapshot.startedAt === null ? 0 : systemClock.now().getTime() - snapshot.startedAt.getTime();

  for (const uploader of snapshot.uploaders) {
    await safeEmit(
      {
        eventKey,
        tenantId: input.tenantKey,
        actorRef: { kind: "user", id: uploader },
        subjectRef: { kind: "user", id: uploader },
        // `fileCount` and `durationMs` are what §4.7's email rule reads, so the
        // resolver decides from the payload alone (ADR-0760 D4).
        payload: {
          eventId: input.eventId.toHexString(),
          batchId: input.batchId,
          fileCount: status.files.total,
          durationMs,
          files: status.files,
        },
        dedupeKey: `${eventKey}:${input.tenantKey}:${input.batchId}:${uploader}`,
      },
      db
    );
  }

  return { phase: status.phase };
}

/** The plan refusals that mean "the workspace cannot afford this upload". */
const QUOTA_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "plan_limit_exceeded",
  "payment_required",
  "feature_not_available",
]);

/** True when a completion error is a plan refusal worth telling the humans about. */
export function isQuotaRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && QUOTA_REFUSAL_CODES.has(code);
}

/** Six hours in milliseconds — the §4.7 quota-block throttle window. */
const QUOTA_ALERT_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Emit `upload.blocked.quota` for a completion the plan refused.
 *
 * The uploader is both actor and subject: the fan-out drops the actor from the
 * ORGANIZERS audience and always re-adds the subject, so the uploader and the
 * organizer each hear it once (ADR-0760 D4). The dedupe key is the event plus a
 * six-hour bucket, so a burst of refused files is one alert (§4.7).
 *
 * Never throws: a broken outbox must not replace the refusal the caller throws.
 *
 * @param input - The event, the batch, the uploader and the database seam.
 */
export async function emitUploadQuotaBlocked(input: {
  readonly db?: Db;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly batchId: string;
  readonly uploaderUserId: string;
}): Promise<void> {
  const bucket = Math.floor(systemClock.now().getTime() / QUOTA_ALERT_WINDOW_MS);
  await safeEmit(
    {
      eventKey: "upload.blocked.quota",
      tenantId: input.tenantKey,
      actorRef: { kind: "user", id: input.uploaderUserId },
      subjectRef: { kind: "user", id: input.uploaderUserId },
      payload: { eventId: input.eventId.toHexString(), batchId: input.batchId },
      dedupeKey: `upload.blocked.quota:${input.tenantKey}:${input.eventId.toHexString()}:${bucket.toString()}`,
    },
    input.db ?? getDb()
  );
}
