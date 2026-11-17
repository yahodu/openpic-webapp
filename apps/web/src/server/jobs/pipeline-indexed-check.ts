import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `pipeline-indexed-check` — the every-5-minutes indexing notice (OP-136,
 * contract §10.2 `pipeline-indexed-check`; ADR-0849).
 *
 * An event is indexed once every image it holds has reached a terminal state
 * (processed or failed). The dedupe key carries a six-hour bucket, so a repeat
 * run inside the window cannot announce the same completion twice; the first
 * completion is the one that carries the email flag (the fan-out reads it from
 * the payload).
 */

/** The §10.2 announcement cadence of one event's index completion. */
const INDEXED_DEDUPE_WINDOW_MS = 6 * 3_600_000;

/** The stored fields of an event row this job reads. */
interface IndexedEventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly counters: {
    readonly imageCount?: number;
    readonly processedImageCount?: number;
    readonly failedImageCount?: number;
  };
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
  return {
    _id: row._id,
    tenantId: row.tenantId,
    counters: typeof counters === "object" && counters !== null ? counters : {},
  };
}

/**
 * Announce every event whose queued images are all terminal.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ indexed }`.
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

  const bucket = Math.floor(now.getTime() / INDEXED_DEDUPE_WINDOW_MS);
  let indexed = 0;
  let skipped = 0;

  for (const row of candidates) {
    const imageCount = row.counters.imageCount ?? 0;
    const terminal = (row.counters.processedImageCount ?? 0) + (row.counters.failedImageCount ?? 0);
    if (terminal < imageCount) {
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
        payload: { eventId, images: imageCount },
        dedupeKey: `pipeline.event.indexed:${eventId}:${String(bucket)}`,
      },
      { db, clock }
    );
    if (result.deduped) {
      skipped += 1;
      continue;
    }
    indexed += 1;
  }

  const scanned = candidates.length;
  logger.info("pipeline indexed check completed", { event: "pipeline.indexed_check", indexed });
  return {
    scanned,
    affected: indexed,
    skipped,
    errors: 0,
    hasMore: scanned >= limit,
    details: { indexed },
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
