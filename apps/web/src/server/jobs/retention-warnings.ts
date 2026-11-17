import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { addDays } from "@/server/runtime/time";

import type { SweepJobRunOptions } from "./run-options";
import { retentionWarningPoint } from "./sweep-decisions";

/**
 * `retention-warnings` — the daily pre-erase warnings (OP-136, contract §10.2
 * `retention-warnings`, §4.5; ADR-0849 §2).
 *
 * The organizer is warned at T-14d and T-3d, the attendee at T-7d and T-1d, so
 * the last chance to download originals lands before the purge. Each point is
 * keyed per event **and per schedule point**, so no warning is ever sent twice
 * for the same point. Mobile is enabled on the final rung of each audience only.
 */

/** The horizon a candidate's retention deadline must fall inside. */
const WARNING_HORIZON_DAYS = 14;

/** The stored fields of an event row this job reads. */
interface RetentionWarningRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly retentionExpiresAt: Date;
}

/** Narrow a stored event row, or `null`. */
function asRetentionWarningRow(value: unknown): RetentionWarningRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<RetentionWarningRow>;
  if (!(row._id instanceof ObjectId) || typeof row.tenantId !== "string") {
    return null;
  }
  if (!(row.retentionExpiresAt instanceof Date)) {
    return null;
  }
  return { _id: row._id, tenantId: row.tenantId, retentionExpiresAt: row.retentionExpiresAt };
}

/**
 * Warn both audiences at every due schedule point.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ organizer, attendee }`.
 */
export async function retentionWarnings(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const events = platformRepo(db).collection(COLLECTIONS.events);

  const raw: unknown = await events
    .find({
      status: { $ne: "deleting" },
      retentionExpiresAt: { $gt: now, $lte: addDays(now, WARNING_HORIZON_DAYS) },
    })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asRetentionWarningRow).filter((row): row is RetentionWarningRow => row !== null)
    : [];

  let organizer = 0;
  let attendee = 0;

  for (const row of candidates) {
    const eventId = row._id.toHexString();
    const organizerPoint = retentionWarningPoint({
      retentionExpiresAt: row.retentionExpiresAt,
      now,
      audience: "organizer",
    });
    if (organizerPoint !== null) {
      const result = await emitDomainEvent(
        {
          eventKey: "event.retention.expiring",
          tenantId: row.tenantId,
          actorRef: { kind: "system", id: "retention-warnings" },
          subjectRef: { kind: "event", id: eventId },
          payload: {
            point: organizerPoint,
            mobile: organizerPoint === "t-3d",
            retentionExpiresAt: row.retentionExpiresAt.toISOString(),
          },
          dedupeKey: `event.retention.expiring:${eventId}:${organizerPoint}`,
        },
        { db, clock }
      );
      organizer += result.deduped ? 0 : 1;
    }

    const attendeePoint = retentionWarningPoint({
      retentionExpiresAt: row.retentionExpiresAt,
      now,
      audience: "attendee",
    });
    if (attendeePoint !== null) {
      const result = await emitDomainEvent(
        {
          eventKey: "attendee.gallery.expiring",
          tenantId: row.tenantId,
          actorRef: { kind: "system", id: "retention-warnings" },
          subjectRef: { kind: "event", id: eventId },
          payload: {
            point: attendeePoint,
            mobile: attendeePoint === "t-1d",
            retentionExpiresAt: row.retentionExpiresAt.toISOString(),
          },
          dedupeKey: `attendee.gallery.expiring:${eventId}:${attendeePoint}`,
        },
        { db, clock }
      );
      attendee += result.deduped ? 0 : 1;
    }
  }

  const scanned = candidates.length;
  logger.info("retention warnings completed", {
    event: "event.retention_warnings",
    organizer,
    attendee,
  });
  return {
    scanned,
    affected: organizer + attendee,
    skipped: 0,
    errors: 0,
    hasMore: scanned >= limit,
    details: { organizer, attendee },
  };
}

/**
 * `retention-warnings` — daily (contract §10.2; ADR-0849).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const retentionWarningsJob: CronJob = defineCronJob({
  name: "retention-warnings",
  defaultLimit: 2000,
  maxLimit: 4000,
  run: ({ limit, clock, logger }) => retentionWarnings({ db: getDb(), clock, logger, limit }),
});
