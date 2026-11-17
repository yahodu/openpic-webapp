import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { derivePipelineStatus, type ProcessingCounts } from "@/server/events/pipeline";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo, tenantRepo } from "@/server/repos";
import { checkUploadBatchTransition } from "@/server/uploads/batch-notifications";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `pipeline-indexed-check` — the every-5-minutes indexing notice (OP-136,
 * contract §10.2 `pipeline-indexed-check`, §4.1; ADR-0849).
 *
 * An event is announced once the shipped status table derives `indexed` for it
 * — never for `delayed` or `partial_failure`, whose photos are not all
 * searchable. The announcement latches on the event (`pipeline.indexedNotifiedAt`),
 * so an event is announced once, however many runs or six-hour buckets pass;
 * the first (only) completion is the one that carries the email flag the
 * fan-out reads. The run also drives the OP-126 batch arm
 * ({@link checkUploadBatchTransition}) so a batch the worker settled without a
 * completion route still emits its §4.7 summary once.
 */

/** The per-event latch the job writes (§10.2 "mark indexed"). */
interface IndexedLatch {
  readonly indexedNotifiedAt?: Date | null;
}

/** The stored fields of an event row this job reads. */
interface IndexedEventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly counters: {
    readonly imageCount?: number;
    readonly processedImageCount?: number;
    readonly failedImageCount?: number;
  };
  /** The latch: set when this job announced the event's index completion. */
  readonly pipeline?: IndexedLatch | null;
}

/** One batch the arm checks, addressed to the event it belongs to. */
interface EventBatch {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  readonly batchId: string;
}

/** Narrow a stored event row, or `null`. */
function asIndexedEventRow(value: unknown): IndexedEventRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<IndexedEventRow>;
  if (!(row._id instanceof ObjectId) || typeof row.tenantId !== "string") {
    return null;
  }
  const counters = (value as { readonly counters?: unknown }).counters;
  const pipeline = (value as { readonly pipeline?: unknown }).pipeline;
  return {
    _id: row._id,
    tenantId: row.tenantId,
    counters: typeof counters === "object" && counters !== null ? counters : {},
    ...(typeof pipeline === "object" && pipeline !== null ? { pipeline } : {}),
  };
}

/** The event's §4.1 counters, defaulted the way the status table reads them. */
function pipelineCounts(row: IndexedEventRow): ProcessingCounts {
  return {
    imageCount: row.counters.imageCount ?? 0,
    processedImageCount: row.counters.processedImageCount ?? 0,
    failedImageCount: row.counters.failedImageCount ?? 0,
  };
}

/**
 * The batches one event's rows name, at most one run's limit of them.
 *
 * The discovery reads `event_images.uploadBatchId`: a batch whose images the
 * worker settled always has those join rows. A batch that was entirely
 * duplicates has only its sessions and settles from the completion route.
 *
 * @param row - The event whose batches to find.
 * @param db - The database handle.
 * @param limit - The run's cap.
 * @returns The distinct batch ids, in stored order.
 */
async function batchesOfEvent(
  row: IndexedEventRow,
  db: Db,
  limit: number
): Promise<readonly string[]> {
  const rows = await tenantRepo(row.tenantId, db)
    .collection(COLLECTIONS.eventImages)
    .find({ eventId: row._id, uploadBatchId: { $ne: null } })
    .project({ uploadBatchId: 1 })
    .limit(limit)
    .toArray();
  // §16.3 stores an `ObjectId` for a 24-hex batch id and the raw string
  // otherwise (`batchIdValue`); `String` is the one form both agree on.
  const ids = new Set<string>();
  for (const value of rows as readonly { readonly uploadBatchId?: unknown }[]) {
    ids.add(String(value.uploadBatchId));
  }
  return [...ids];
}

/**
 * Announce every event the status table derives as indexed, once, and drive the
 * OP-126 batch arm for every scanned event's batches.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ indexed, batches }`.
 */
export async function pipelineIndexedCheck(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const events = platformRepo(db).collection(COLLECTIONS.events);

  const raw: unknown = await events
    .find({ "counters.imageCount": { $gt: 0 } })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asIndexedEventRow).filter((row): row is IndexedEventRow => row !== null)
    : [];

  let indexed = 0;
  let skipped = 0;

  for (const row of candidates) {
    const counts = pipelineCounts(row);
    // The shipped §4.1 table is the oracle: only `indexed` is fully searchable,
    // and a latched event was announced already.
    if (derivePipelineStatus(counts) !== "indexed" || row.pipeline?.indexedNotifiedAt != null) {
      skipped += 1;
      continue;
    }
    const eventId = row._id.toHexString();
    const result = await emitDomainEvent(
      {
        eventKey: "pipeline.event.indexed",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "pipeline-indexed-check" },
        subjectRef: { kind: "event", id: eventId },
        // The latch below makes this the event's first completion, which is the
        // one §4.7 sends the email for (`email` itself is a forbidden key).
        payload: { eventId, images: counts.imageCount, notifyByEmail: true },
        dedupeKey: `pipeline.event.indexed:${eventId}`,
      },
      { db, clock }
    );
    await events.updateOne({ _id: row._id }, { $set: { "pipeline.indexedNotifiedAt": now } });
    if (result.deduped) {
      skipped += 1;
      continue;
    }
    indexed += 1;
  }

  // shortcut: a batch already summarised is re-checked on every run — the
  // outbox's (batch, uploader) dedupe key makes the repeat a no-op; add a
  // per-batch marker if the per-run batch count outgrows the limit.
  const pending: EventBatch[] = [];
  for (const row of candidates) {
    for (const batchId of await batchesOfEvent(row, db, limit)) {
      pending.push({ tenantKey: row.tenantId, eventId: row._id, batchId });
    }
  }
  const batches = pending.slice(0, limit);
  for (const batch of batches) {
    await checkUploadBatchTransition({ db, ...batch });
  }

  const scanned = candidates.length;
  logger.info("pipeline indexed check completed", {
    event: "pipeline.indexed_check",
    indexed,
    batches: batches.length,
  });
  return {
    scanned,
    affected: indexed,
    skipped,
    errors: 0,
    hasMore: scanned >= limit,
    details: { indexed, batches: batches.length },
  };
}

/**
 * `pipeline-indexed-check` — every 5 minutes (contract §10.2; ADR-0849).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const pipelineIndexedCheckJob: CronJob = defineCronJob({
  name: "pipeline-indexed-check",
  defaultLimit: 500,
  maxLimit: 1000,
  run: ({ limit, clock, logger }) => pipelineIndexedCheck({ db: getDb(), clock, logger, limit }),
});
