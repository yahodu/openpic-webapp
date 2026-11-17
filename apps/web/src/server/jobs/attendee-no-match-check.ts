import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `attendee-no-match-check` — the hourly empty-gallery notice (OP-136, contract
 * §10.2 `attendee-no-match-check`, §6.4; ADR-0849).
 *
 * An attendee whose profile has completed a match run and still holds no match
 * is told once, so an empty gallery is a message and not a silent page. The
 * dedupe key is the profile id alone: one attendee is told at most once per
 * profile, however long the event runs.
 */

/** The stored fields of an `attendeeEventProfiles` row this job reads. */
interface NoMatchProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
}

/** Narrow a stored profile row, or `null`. */
function asNoMatchProfileRow(value: unknown): NoMatchProfileRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<NoMatchProfileRow>;
  if (
    !(row._id instanceof ObjectId) ||
    typeof row.tenantId !== "string" ||
    !(row.eventId instanceof ObjectId)
  ) {
    return null;
  }
  return { _id: row._id, tenantId: row.tenantId, eventId: row.eventId };
}

/**
 * Announce every attendee whose finished run found nothing.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ noneFound }`.
 */
export async function attendeeNoMatchCheck(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const platform = platformRepo(db);

  const raw: unknown = await platform
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({ status: "ready", matchCount: 0, lastMatchRunAt: { $ne: null } })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asNoMatchProfileRow).filter((row): row is NoMatchProfileRow => row !== null)
    : [];

  let noneFound = 0;

  for (const row of candidates) {
    const profileId = row._id.toHexString();
    const result = await emitDomainEvent(
      {
        eventKey: "attendee.matches.none_found",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "attendee-no-match-check" },
        subjectRef: { kind: "attendeeEventProfile", id: profileId },
        payload: { profileId, eventId: row.eventId.toHexString() },
        dedupeKey: `attendee.matches.none_found:${profileId}`,
      },
      { db, clock }
    );
    noneFound += result.deduped ? 0 : 1;
  }

  const scanned = candidates.length;
  logger.info("attendee no match check completed", { event: "attendee.no_match_check", noneFound });
  return {
    scanned,
    affected: noneFound,
    skipped: scanned - noneFound,
    errors: 0,
    hasMore: scanned >= limit,
    details: { noneFound },
  };
}

/**
 * `attendee-no-match-check` — hourly (contract §10.2; ADR-0849).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const attendeeNoMatchCheckJob: CronJob = defineCronJob({
  name: "attendee-no-match-check",
  defaultLimit: 1000,
  maxLimit: 2000,
  run: ({ limit, clock, logger }) => attendeeNoMatchCheck({ db: getDb(), clock, logger, limit }),
});
