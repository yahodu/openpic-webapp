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

/**
 * How many candidate rows one run drives at once (ADR-0862 §3: the arm's
 * round-trip chains were serialised). Kept small — a row is three reads per
 * batch against one database.
 */
const ROW_CHECK_CONCURRENCY = 8;

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
 * The batches the candidate page names, at most one run's limit of them.
 *
 * One grouped read **per tenant in the page**, not one read per event: the
 * aggregation returns distinct `(eventId, uploadBatchId)` pairs, so the join
 * documents never leave the database (ADR-0862 §1: the per-event read moved up
 * to `limit` documents to learn a handful of ids).
 *
 * The discovery reads `event_images.uploadBatchId`: a batch whose images the
 * worker settled always has those join rows. A batch that was entirely
 * duplicates has only its sessions and settles from the completion route.
 *
 * @param candidates - The run's candidate page.
 * @param db - The database handle.
 * @param limit - The run's cap; collection stops at it.
 * @returns The distinct `(event, batch)` pairs, in sorted order.
 */
async function pendingBatches(
  candidates: readonly IndexedEventRow[],
  db: Db,
  limit: number
): Promise<EventBatch[]> {
  const idsByTenant = new Map<string, ObjectId[]>();
  for (const row of candidates) {
    const ids = idsByTenant.get(row.tenantId);
    if (ids === undefined) {
      idsByTenant.set(row.tenantId, [row._id]);
    } else {
      ids.push(row._id);
    }
  }

  const pending: EventBatch[] = [];
  for (const [tenantKey, eventIds] of idsByTenant) {
    if (pending.length >= limit) {
      break;
    }
    // `$limit` after the `$group` caps the run's work, not its reads: the
    // distinct pairs are the whole result set.
    const groups = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.eventImages)
      .aggregate([
        { $match: { eventId: { $in: eventIds }, uploadBatchId: { $ne: null } } },
        { $group: { _id: { eventId: "$eventId", batchId: "$uploadBatchId" } } },
        { $sort: { "_id.eventId": 1, "_id.batchId": 1 } },
        { $limit: limit - pending.length },
      ])
      .toArray()) as unknown as readonly {
      readonly _id: { readonly eventId: ObjectId; readonly batchId: unknown };
    }[];
    for (const group of groups) {
      pending.push({
        tenantKey,
        eventId: group._id.eventId,
        // §16.3 stores an `ObjectId` for a 24-hex batch id and the raw string
        // otherwise (`batchIdValue`); `String` is the one form both agree on.
        batchId: String(group._id.batchId),
      });
    }
  }
  return pending;
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

  // The candidate window is keyed on the pipeline INPUT: a row stays a candidate
  // only until its counters move (ADR-0861 §1). The latch cannot be the filter —
  // a `delayed` / `partial_failure` row never latches and would hold its slot for
  // ever — so every evaluated row leaves the page through the checked triple.
  const raw: unknown = await events
    .find({
      "counters.imageCount": { $gt: 0 },
      $expr: {
        $or: [
          { $eq: [{ $type: "$pipeline.indexedCheckedCounters" }, "missing"] },
          {
            $ne: [
              { $ifNull: ["$counters.imageCount", 0] },
              "$pipeline.indexedCheckedCounters.imageCount",
            ],
          },
          {
            $ne: [
              { $ifNull: ["$counters.processedImageCount", 0] },
              "$pipeline.indexedCheckedCounters.processedImageCount",
            ],
          },
          {
            $ne: [
              { $ifNull: ["$counters.failedImageCount", 0] },
              "$pipeline.indexedCheckedCounters.failedImageCount",
            ],
          },
        ],
      },
    })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asIndexedEventRow).filter((row): row is IndexedEventRow => row !== null)
    : [];

  const pending = await pendingBatches(candidates, db, limit);
  /** The page's batches, grouped by the event that owns them. */
  const batchesByEvent = new Map<string, EventBatch[]>();
  for (const batch of pending) {
    const eventKey = batch.eventId.toHexString();
    const owned = batchesByEvent.get(eventKey);
    if (owned === undefined) {
      batchesByEvent.set(eventKey, [batch]);
    } else {
      owned.push(batch);
    }
  }

  let indexed = 0;
  let skipped = 0;

  /**
   * Announce one candidate, run its batch arm, then stamp its checked triple.
   *
   * The triple goes last (ADR-0867 §1): a row leaves the candidate page when
   * that stamp lands, so a run that aborts inside the arm leaves the row a
   * candidate and the next tick retries the arm's work instead of losing the
   * batch's §4.7 summary with the counters it was owed for.
   *
   * @param row - One candidate of the run's page.
   */
  async function checkRow(row: IndexedEventRow): Promise<void> {
    const counts = pipelineCounts(row);
    const checked = {
      imageCount: counts.imageCount,
      processedImageCount: counts.processedImageCount,
      failedImageCount: counts.failedImageCount,
    };
    // The shipped §4.1 table is the oracle: only `indexed` is fully searchable,
    // and a latched event was announced already.
    const announce =
      derivePipelineStatus(counts) === "indexed" && row.pipeline?.indexedNotifiedAt == null;
    let deduped = false;
    if (announce) {
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
      deduped = result.deduped;
      // Emit first, marker second (ADR-0861 §2) — and the latch only: the triple
      // waits for this row's arm work below.
      await events.updateOne({ _id: row._id }, { $set: { "pipeline.indexedNotifiedAt": now } });
    }
    for (const batch of batchesByEvent.get(row._id.toHexString()) ?? []) {
      await checkUploadBatchTransition({ db, ...batch });
    }
    await events.updateOne(
      { _id: row._id },
      { $set: { "pipeline.indexedCheckedCounters": checked } }
    );
    if (!announce || deduped) {
      skipped += 1;
      return;
    }
    indexed += 1;
  }

  // A batch already summarised on an earlier run is re-checked when its event's
  // counters move again — the outbox's (batch, uploader) dedupe key makes the
  // repeat a no-op. The rows run a chunk at a time so a full page is one wave of
  // round trips, not `limit` serialised ones.
  let errors = 0;
  for (let start = 0; start < candidates.length; start += ROW_CHECK_CONCURRENCY) {
    const chunk = candidates.slice(start, start + ROW_CHECK_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((row) => checkRow(row)));
    // A row's own check is contained (ADR-0872 §1): one failing event must not
    // cost the page its remaining rows, so it is counted and named, and the
    // next chunk still runs.
    for (const [index, row] of chunk.entries()) {
      const outcome = settled.at(index);
      if (outcome?.status !== "rejected") {
        continue;
      }
      errors += 1;
      logger.warn("pipeline indexed row check failed", {
        event: "pipeline.indexed_check.row_failed",
        eventId: row._id.toHexString(),
        error: outcome.reason,
      });
    }
  }

  const scanned = candidates.length;
  logger.info("pipeline indexed check completed", {
    event: "pipeline.indexed_check",
    indexed,
    batches: pending.length,
  });
  return {
    scanned,
    affected: indexed,
    skipped,
    errors,
    hasMore: scanned >= limit,
    details: { indexed, batches: pending.length },
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
