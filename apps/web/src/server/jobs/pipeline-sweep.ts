import { randomUUID } from "node:crypto";

import type { ObjectId } from "mongodb";

import { COLLECTIONS, type CollectionName } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { enqueueWork } from "@/server/queue/enqueue-work";
import type { QueueKind, QueuePriority } from "@/server/queue/envelope";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { platformRepo } from "@/server/repos";
import { addMilliseconds } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `pipeline-sweep` — the 2-minute recovery sweep (OP-136, contract §10.2
 * `pipeline-sweep`, §10.3.3; ADR-0849 §5).
 *
 * Four steps, in this order: an expired lease goes back to `queued` and is
 * re-enqueued; a `queued` item older than five minutes with no broker ack is
 * re-enqueued; an item whose attempt budget is spent becomes `failed` and emits
 * one `pipeline.image.failed`; and a profile whose event gained faces after its
 * last run gets a `match_incremental` run. Every transition carries the expected
 * prior state in its filter, so a second run over the same rows is a no-op.
 *
 * The attempt budget counts **worker claims**: §18.2 increments
 * `processing.attempts` on the claim itself, so step 2 — the broker never
 * accepted the message, no worker ever saw it — deliberately leaves the budget
 * untouched and the ack grace is unbounded (ADR-0863). Such an item is
 * re-enqueued every tick until the broker takes it, and each refusal is the
 * `queue.enqueue_failed` warn §18.1 makes the operator's signal. Step 2's
 * `attempts < maxAttempts` filter only keeps an item that already spent its
 * budget out of the re-enqueue path, where step 3 owns it.
 *
 * The sweep is also the only producer of `match_incremental` (§10.2 step 4). It
 * enqueues the run and advances `lastMatchRunAt`; it never announces the run's
 * matches — the worker's report owns that (ADR-0808 §3).
 */

/** How long a `queued` item may wait for a broker ack before it is re-enqueued. */
const QUEUE_ACK_GRACE_MS = 5 * 60_000;

/** The two work-bearing collections, and the §10.4 kind each one carries. */
const WORK_COLLECTIONS: readonly {
  readonly collection: CollectionName;
  readonly kind: QueueKind;
}[] = [
  { collection: COLLECTIONS.eventImages, kind: "event_image" },
  { collection: COLLECTIONS.selfies, kind: "selfie" },
];

/** The `processing` fields the sweep reads. */
interface WorkProcessing {
  readonly status?: string;
  readonly priority?: string;
  readonly attempts?: number;
  readonly queueRef?: { readonly messageId?: string } | null;
}

/** One work row as the sweep reads it. */
interface WorkRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly processing: WorkProcessing;
}

/** Narrow a stored work row, or `null` when it is not shaped like one. */
function asWorkRow(value: unknown): WorkRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<WorkRow>;
  const processing = (value as { readonly processing?: unknown }).processing;
  if (
    row._id === undefined ||
    typeof row.tenantId !== "string" ||
    row.eventId === undefined ||
    typeof processing !== "object" ||
    processing === null
  ) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: row.tenantId,
    eventId: row.eventId,
    processing,
  };
}

/** The one profile row the incremental step reads. */
interface ProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly activeSelfieId?: ObjectId | null;
  readonly lastMatchRunAt?: Date | null;
}

/** Narrow a stored profile row, or `null`. */
function asProfileRow(value: unknown): ProfileRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<ProfileRow>;
  if (row._id === undefined || typeof row.tenantId !== "string" || row.eventId === undefined) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: row.tenantId,
    eventId: row.eventId,
    activeSelfieId: row.activeSelfieId ?? null,
    lastMatchRunAt: row.lastMatchRunAt instanceof Date ? row.lastMatchRunAt : null,
  };
}

/** The priority a stored row drains at, defaulting to the kind's own step. */
function priorityOf(row: WorkRow): QueuePriority {
  return row.processing.priority === "high" ? "high" : "normal";
}

/**
 * Run the four recovery steps once, bounded by `limit`.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ requeued, failed, incremental }`.
 */
export async function pipelineSweep(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const settings = await getPlatformSettings({ db, clock });
  const queue = getWorkQueue();
  const platform = platformRepo(db);

  let scanned = 0;
  let requeued = 0;
  let failed = 0;
  let incremental = 0;

  /** Re-enqueue one row and stamp its fresh queue position. */
  const reenqueue = async (
    collection: CollectionName,
    kind: QueueKind,
    row: WorkRow
  ): Promise<boolean> => {
    const { enqueued } = await enqueueWork({
      db,
      queue,
      collection,
      work: {
        kind,
        id: row._id.toHexString(),
        tenantId: row.tenantId,
        eventId: row.eventId.toHexString(),
        spaceKey: settings.face.activeSpaceKey,
        traceId: randomUUID(),
        priority: priorityOf(row),
        attempt: row.processing.attempts ?? 0,
      },
      logger,
    });
    return enqueued;
  };

  for (const { collection, kind } of WORK_COLLECTIONS) {
    const rows = platform.collection(collection);

    // ── Step 1: an expired lease goes back to `queued` and is re-enqueued ──
    const expired: unknown = await rows
      .find({ "processing.status": "processing", "processing.leaseExpiresAt": { $lt: now } })
      .limit(limit)
      .toArray();
    for (const value of Array.isArray(expired) ? expired : []) {
      const row = asWorkRow(value);
      if (row === null) {
        continue;
      }
      scanned += 1;
      const claimed = await rows.findOneAndUpdate(
        { _id: row._id, "processing.status": "processing" },
        {
          $set: {
            "processing.status": "queued",
            "processing.leaseExpiresAt": null,
            "processing.workerId": null,
            "processing.startedAt": null,
            "processing.queuedAt": now,
          },
        }
      );
      if (claimed === null) {
        continue;
      }
      requeued += (await reenqueue(collection, kind, row)) ? 1 : 0;
    }

    // ── Step 2: `queued` past the ack grace with no broker ack ──
    const stale: unknown = await rows
      .find({
        "processing.status": "queued",
        "processing.queuedAt": { $lt: addMilliseconds(now, -QUEUE_ACK_GRACE_MS) },
        "processing.queueRef.messageId": null,
        "processing.attempts": { $lt: settings.pipeline.maxAttempts },
      })
      .limit(limit)
      .toArray();
    for (const value of Array.isArray(stale) ? stale : []) {
      const row = asWorkRow(value);
      if (row === null) {
        continue;
      }
      scanned += 1;
      const claimed = await rows.findOneAndUpdate(
        { _id: row._id, "processing.status": "queued", "processing.queueRef.messageId": null },
        { $set: { "processing.queuedAt": now } }
      );
      if (claimed === null) {
        continue;
      }
      requeued += (await reenqueue(collection, kind, row)) ? 1 : 0;
    }

    // ── Step 3: the attempt budget is spent ──
    const exhausted: unknown = await rows
      .find({
        "processing.status": { $in: ["queued", "processing"] },
        "processing.attempts": { $gte: settings.pipeline.maxAttempts },
      })
      .limit(limit)
      .toArray();
    for (const value of Array.isArray(exhausted) ? exhausted : []) {
      const row = asWorkRow(value);
      if (row === null) {
        continue;
      }
      scanned += 1;
      const claimed = await rows.findOneAndUpdate(
        { _id: row._id, "processing.status": { $in: ["queued", "processing"] } },
        {
          $set: {
            "processing.status": "failed",
            "processing.leaseExpiresAt": null,
            "processing.workerId": null,
            "processing.finishedAt": now,
            "processing.lastError": {
              code: "max_attempts_exceeded",
              message: `the worker spent the ${String(settings.pipeline.maxAttempts)}-attempt budget`,
              at: now,
              retryable: false,
            },
          },
        }
      );
      if (claimed === null) {
        continue;
      }
      failed += 1;
      if (kind === "event_image") {
        await emitDomainEvent(
          {
            eventKey: "pipeline.image.failed",
            tenantId: row.tenantId,
            actorRef: { kind: "system", id: "pipeline-sweep" },
            subjectRef: { kind: "event_image", id: row._id.toHexString() },
            payload: { imageId: row._id.toHexString(), eventId: row.eventId.toHexString() },
            dedupeKey: `pipeline.image.failed:${row._id.toHexString()}`,
          },
          { db, clock }
        );
      }
    }
  }

  // ── Step 4: the incremental match run ──
  const rawProfiles: unknown = await platform
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({ status: { $in: ["ready", "processing"] }, activeSelfieId: { $ne: null } })
    .limit(limit)
    .toArray();
  for (const value of Array.isArray(rawProfiles) ? rawProfiles : []) {
    const profile = asProfileRow(value);
    if (profile === null) {
      continue;
    }
    scanned += 1;
    const since = profile.lastMatchRunAt ?? new Date(0);
    const newerFaces = await platform
      .collection("imageFaces")
      .countDocuments({ eventId: profile.eventId, createdAt: { $gt: since } }, { limit: 1 });
    if (newerFaces === 0) {
      continue;
    }
    // The watermark write is the claim: two concurrent sweeps cannot both run
    // the profile, and the next tick sees no newer face.
    const claimed = await platform
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOneAndUpdate(
        { _id: profile._id, lastMatchRunAt: profile.lastMatchRunAt },
        { $set: { lastMatchRunAt: now } }
      );
    if (claimed === null) {
      continue;
    }
    const { enqueued } = await enqueueWork({
      db,
      queue,
      collection: COLLECTIONS.attendeeEventProfiles,
      work: {
        kind: "match_incremental",
        id: profile._id.toHexString(),
        tenantId: profile.tenantId,
        eventId: profile.eventId.toHexString(),
        spaceKey: settings.face.activeSpaceKey,
        traceId: randomUUID(),
        priority: "high",
      },
      logger,
    });
    if (!enqueued) {
      // No broker pointer exists, so the run would be lost: hand the watermark
      // back and let the next tick retry it.
      await platform
        .collection(COLLECTIONS.attendeeEventProfiles)
        .updateOne(
          { _id: profile._id, lastMatchRunAt: now },
          { $set: { lastMatchRunAt: profile.lastMatchRunAt } }
        );
      continue;
    }
    incremental += 1;
  }

  logger.info("pipeline sweep completed", {
    event: "pipeline.sweep",
    requeued,
    failed,
    incremental,
  });
  return {
    scanned,
    affected: requeued + failed + incremental,
    skipped: 0,
    errors: 0,
    hasMore: scanned >= limit,
    details: { requeued, failed, incremental },
  };
}

/**
 * `pipeline-sweep` — every 2 minutes (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const pipelineSweepJob: CronJob = defineCronJob({
  name: "pipeline-sweep",
  defaultLimit: 2000,
  maxLimit: 4000,
  run: ({ limit, clock, logger }) => pipelineSweep({ db: getDb(), clock, logger, limit }),
});
