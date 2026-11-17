import type { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";

import { resolveEventStatus, uploadWindowPoint } from "./sweep-decisions";
import type { SweepJobRunOptions } from "./run-options";

/**
 * `event-window-sweep` — the hourly deadline sweep (OP-136, contract §10.2
 * `event-window-sweep`, §4.5; ADR-0849 §5).
 *
 * Two rules shape it. Every message is keyed per event **and per schedule
 * point**, so the outbox's unique index is the only latch a repeat run needs.
 * And the status write is `resolveEventStatus`'s alone: the T-24h run announces
 * `event.starting_soon` and moves nothing, so the warning and the transition
 * stay two separate instants.
 */

/** The event fields this sweep reads. */
interface WindowEventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly status: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly uploadWindowEndsAt: Date | null;
}

/** Hourly cadence: the fire window of every point this job announces. */
const RUN_INTERVAL_MS = 3_600_000;

/** Narrow a stored event to the fields the sweep reads, or `null`. */
function asWindowEventRow(value: unknown): WindowEventRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<WindowEventRow>;
  if (
    row._id === undefined ||
    typeof row.tenantId !== "string" ||
    typeof row.status !== "string" ||
    !(row.startAt instanceof Date) ||
    !(row.endAt instanceof Date)
  ) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: row.tenantId,
    status: row.status,
    startAt: row.startAt,
    endAt: row.endAt,
    uploadWindowEndsAt: row.uploadWindowEndsAt instanceof Date ? row.uploadWindowEndsAt : null,
  };
}

/**
 * Announce the deadlines and follow the clock for every live event.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ closing, closed, startingSoon, ended }`.
 */
export async function eventWindowSweep(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const events = platformRepo(db).collection(COLLECTIONS.events);

  const raw: unknown = await events
    .find({ status: { $in: ["published", "live"] } })
    .sort({ uploadWindowEndsAt: 1, startAt: 1 })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asWindowEventRow).filter((row): row is WindowEventRow => row !== null)
    : [];

  let closing = 0;
  let closed = 0;
  let startingSoon = 0;
  let ended = 0;

  for (const row of candidates) {
    const eventId = row._id.toHexString();
    const emit = async (eventKey: string, payload: Record<string, unknown>, dedupeKey: string) => {
      const result = await emitDomainEvent(
        {
          eventKey,
          tenantId: row.tenantId,
          actorRef: { kind: "system", id: "event-window-sweep" },
          subjectRef: { kind: "event", id: eventId },
          payload,
          dedupeKey,
        },
        { db, clock }
      );
      return !result.deduped;
    };

    const windowPoint = uploadWindowPoint({ uploadWindowEndsAt: row.uploadWindowEndsAt, now });
    if (windowPoint === "t-72h" || windowPoint === "t-24h") {
      const hoursRemaining = windowPoint === "t-72h" ? 72 : 24;
      const delivered = await emit(
        "event.upload_window.closing",
        { hoursRemaining, mobile: hoursRemaining === 24 },
        `event.upload_window.closing:${eventId}:${windowPoint}`
      );
      closing += delivered ? 1 : 0;
    } else if (windowPoint === "closed") {
      const delivered = await emit(
        "event.upload_window.closed",
        { closedAt: now.toISOString() },
        `event.upload_window.closed:${eventId}`
      );
      closed += delivered ? 1 : 0;
    }

    const startPointAt = row.startAt.getTime() - 24 * RUN_INTERVAL_MS;
    if (now.getTime() >= startPointAt && now.getTime() < startPointAt + RUN_INTERVAL_MS) {
      const delivered = await emit(
        "event.starting_soon",
        { startAt: row.startAt.toISOString() },
        `event.starting_soon:${eventId}`
      );
      startingSoon += delivered ? 1 : 0;
    }

    const nextStatus = resolveEventStatus({
      status: row.status,
      startAt: row.startAt,
      endAt: row.endAt,
      now,
    });
    if (nextStatus === null) {
      continue;
    }
    // The prior status is in the filter, so a concurrent run that already moved
    // the event matches nothing and announces nothing twice.
    const moved = await events.findOneAndUpdate(
      { _id: row._id, status: row.status },
      { $set: { status: nextStatus, updatedAt: now } }
    );
    if (moved === null || nextStatus !== "ended") {
      continue;
    }
    const delivered = await emit(
      "event.ended",
      { endedAt: row.endAt.toISOString() },
      `event.ended:${eventId}`
    );
    ended += delivered ? 1 : 0;
  }

  const scanned = candidates.length;
  logger.info("event window sweep completed", {
    event: "event.window_sweep",
    closing,
    closed,
    startingSoon,
    ended,
  });
  return {
    scanned,
    affected: closing + closed + startingSoon + ended,
    skipped: 0,
    errors: 0,
    hasMore: scanned === limit,
    details: { closing, closed, startingSoon, ended },
  };
}

/**
 * `event-window-sweep` — hourly (contract §10.2; ADR-0849 §1).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const eventWindowSweepJob: CronJob = defineCronJob({
  name: "event-window-sweep",
  defaultLimit: 1000,
  maxLimit: 2000,
  run: ({ limit, clock, logger }) => eventWindowSweep({ db: getDb(), clock, logger, limit }),
});
