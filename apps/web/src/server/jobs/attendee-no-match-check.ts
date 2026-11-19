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
 *
 * The page drains: `noMatchNotifiedFor` holds a copy of the two inputs the
 * candidate class depends on (`lastMatchRunAt`, `matchCount`), stamped after
 * the emit, and the filter re-admits the row only when that copy is missing or
 * either live input has moved — so an announced row leaves the page, and a
 * re-matched profile re-enters it (ADR-0880 §1).
 */

/** The stored fields of an `attendeeEventProfiles` row this job reads. */
interface NoMatchProfileRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly lastMatchRunAt: Date;
  readonly matchCount: number;
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
    !(row.eventId instanceof ObjectId) ||
    !(row.lastMatchRunAt instanceof Date) ||
    typeof row.matchCount !== "number"
  ) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: row.tenantId,
    eventId: row.eventId,
    lastMatchRunAt: row.lastMatchRunAt,
    matchCount: row.matchCount,
  };
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

  // The window is keyed on the match INPUTS: a row is a candidate until its
  // no-match notice is stamped, and re-opens by itself when either input moves
  // (ADR-0880 §1).
  const raw: unknown = await platform
    .collection(COLLECTIONS.attendeeEventProfiles)
    .find({
      status: "ready",
      matchCount: 0,
      lastMatchRunAt: { $ne: null },
      $expr: {
        $or: [
          { $eq: [{ $type: "$noMatchNotifiedFor" }, "missing"] },
          {
            $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchRunAt", null] }, "$lastMatchRunAt"],
          },
          { $ne: [{ $ifNull: ["$noMatchNotifiedFor.matchCount", null] }, "$matchCount"] },
        ],
      },
    })
    .sort({ _id: 1 })
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
    // Emit first, marker second (ADR-0880 §1) — and for every evaluated row,
    // deduped or not: a re-opened row that is not re-stamped holds its slot
    // for ever.
    await platform.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
      { _id: row._id },
      {
        $set: {
          noMatchNotifiedFor: { matchRunAt: row.lastMatchRunAt, matchCount: row.matchCount },
        },
      }
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
