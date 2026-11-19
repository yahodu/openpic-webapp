import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import { addDays } from "@/server/runtime/time";

import type { SweepJobRunOptions } from "./run-options";

/**
 * `upload-session-sweep` — the hourly stalled-upload notice (OP-136, contract
 * §10.2 `upload-session-sweep`, §5.5; ADR-0849).
 *
 * An `in_progress` session that has not been touched for a day is stalled: the
 * client stopped mid-transfer and the window is burning. The message is keyed by
 * the session id, so the outbox's unique index is the "once per session" latch.
 *
 * The page drains: `stallNotifiedAt` is stamped after the emit and the filter
 * admits only an unstamped row, so an announced session leaves the page. The
 * latch is terminal on purpose — the dedupe key is session-terminal, so
 * re-admitting a resumed-then-restalled session could only re-take a slot
 * (ADR-0880 §2). The rows are TTL-reaped within five days.
 *
 * shortcut: parts are never stored (the live `ListParts` answer is the only part
 * truth, §16.2), so the stored proxy for "has parts" is the multipart upload the
 * session's `externalRefs` carry; upgrade when a part counter is persisted.
 */

/** How long an `in_progress` session may sit untouched before it is stalled. */
const IDLE_LIMIT_DAYS = 1;

/** The stored fields of an upload session this job reads. */
interface StalledSessionRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly status: string;
  readonly declaredSize?: number;
}

/** Narrow a stored upload session, or `null`. */
function asStalledSessionRow(value: unknown): StalledSessionRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Partial<StalledSessionRow>;
  if (!(row._id instanceof ObjectId) || !(row.eventId instanceof ObjectId)) {
    return null;
  }
  return {
    _id: row._id,
    tenantId: typeof row.tenantId === "string" ? row.tenantId : "",
    eventId: row.eventId,
    status: row.status ?? "in_progress",
    ...(typeof row.declaredSize === "number" ? { declaredSize: row.declaredSize } : {}),
  };
}

/**
 * Announce every stalled upload session once.
 *
 * @param options - Database/clock/logger seam and the per-run limit.
 * @returns The §10.2 run outcome with `{ stalled }`.
 */
export async function uploadSessionSweep(options: SweepJobRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const sessions = platformRepo(db).collection(COLLECTIONS.uploadSessions);

  const raw: unknown = await sessions
    .find({
      status: "in_progress",
      updatedAt: { $lt: addDays(now, -IDLE_LIMIT_DAYS) },
      "externalRefs.kind": "multipart_upload",
      stallNotifiedAt: null,
    })
    .sort({ _id: 1 })
    .limit(limit)
    .toArray();
  const candidates = Array.isArray(raw)
    ? raw.map(asStalledSessionRow).filter((row): row is StalledSessionRow => row !== null)
    : [];

  let stalled = 0;
  let skipped = 0;

  for (const row of candidates) {
    const sessionId = row._id.toHexString();
    if (row.tenantId === "") {
      skipped += 1;
      continue;
    }
    const result = await emitDomainEvent(
      {
        eventKey: "upload.session.stalled",
        tenantId: row.tenantId,
        actorRef: { kind: "system", id: "upload-session-sweep" },
        subjectRef: { kind: "uploadSession", id: sessionId },
        payload: {
          sessionId,
          eventId: row.eventId.toHexString(),
          declaredSize: row.declaredSize ?? 0,
        },
        dedupeKey: `upload.session.stalled:${sessionId}`,
      },
      { db, clock }
    );
    // Emit first, marker second (ADR-0880 §2) — for every emitted candidate,
    // deduped or not, or the row re-takes its slot on every run.
    await sessions.updateOne({ _id: row._id }, { $set: { stallNotifiedAt: now } });
    stalled += result.deduped ? 0 : 1;
  }

  const scanned = candidates.length;
  logger.info("upload session sweep completed", { event: "upload.session_sweep", stalled });
  return {
    scanned,
    affected: stalled,
    skipped,
    errors: 0,
    hasMore: scanned >= limit,
    details: { stalled },
  };
}

/**
 * `upload-session-sweep` — hourly (contract §10.2; ADR-0849).
 *
 * Registered in `apps/web/vercel.json`; the run closes over the shared database
 * handle and forwards the framework's clamped limit and injected clock.
 */
export const uploadSessionSweepJob: CronJob = defineCronJob({
  name: "upload-session-sweep",
  defaultLimit: 1000,
  maxLimit: 2000,
  run: ({ limit, clock, logger }) => uploadSessionSweep({ db: getDb(), clock, logger, limit }),
});
