import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { defineCronJob, type CronJob, type CronRunOutcome } from "@/server/jobs/cron-job";
import { platformRepo } from "@/server/repos";
import type { Clock } from "@/server/runtime/clock";
import type { Logger } from "@/server/logging";

import { dateKeyInTimeZone, ROLLUP_TIME_ZONE } from "./analytics-rollup";

/**
 * `dsr-sla-check` — the statutory-deadline warning (OP-139, contract §10.2,
 * §8.1; schema §20.3; ADR-0918, ADR-0919).
 *
 * OP-138 stamps every data-subject request with `slaDueAt`, and this job is the
 * only reader of that field: an unwarned request becomes a missed statutory
 * deadline with no second chance. Each open request inside the 48-hour window
 * emits one `admin.dsr.sla_risk` per IST day — the outbox `dedupeKey` carries
 * the request id and the day key, so a same-day rerun is silent and the next day
 * warns again while the request is still at risk.
 */

/** The open statuses a request can still be warned about (schema §20.3). */
const CLOSED_STATUSES: readonly string[] = ["completed", "rejected"];

/** How far ahead of `slaDueAt` the warning fires: 48 hours, inclusive. */
const WARNING_WINDOW_MS = 48 * 3_600_000;

/** One stored `dataSubjectRequests` row, as far as this job reads it. */
interface DsrRow {
  readonly _id?: unknown;
  readonly requestType?: unknown;
  readonly status?: unknown;
  readonly slaDueAt?: unknown;
  readonly scope?: { readonly tenantIds?: readonly unknown[] };
}

/** Options for one SLA-check invocation. */
interface SlaCheckRunOptions {
  /** The database handle. */
  readonly db: Db;
  /** The clock the window and the day key are computed from. */
  readonly clock: Clock;
  /** The logger the run's summary is written through. */
  readonly logger: Logger;
  /** How many at-risk requests this invocation may announce. */
  readonly limit: number;
}

/** The hex form of an id-shaped value, or `null`. */
function hexOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return null;
}

/**
 * Warn once per open request inside the 48-hour window.
 *
 * @param options - The database, clock, logger and per-run budget.
 * @returns The §10.2 run outcome.
 */
export async function dsrSlaCheck(options: SlaCheckRunOptions): Promise<CronRunOutcome> {
  const { db, clock, logger, limit } = options;
  const now = clock.now();
  const cutoff = new Date(now.getTime() + WARNING_WINDOW_MS);
  const dateKey = dateKeyInTimeZone(now, ROLLUP_TIME_ZONE);

  const rows = (await platformRepo(db)
    .collection(COLLECTIONS.dataSubjectRequests)
    .find(
      { status: { $nin: [...CLOSED_STATUSES] }, slaDueAt: { $lte: cutoff } },
      { sort: { slaDueAt: 1 }, limit }
    )
    .toArray()) as unknown as DsrRow[];

  let affected = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const requestId = hexOf(row._id);
    // A request that resolved no tenant has no tenant to be announced under —
    // the same rule the filing's acknowledgement applies.
    const tenantId = hexOf(row.scope?.tenantIds?.[0]);
    const slaDueAt = row.slaDueAt instanceof Date ? row.slaDueAt : null;
    if (requestId === null || tenantId === null || slaDueAt === null) {
      skipped += 1;
      continue;
    }
    try {
      const result = await emitDomainEvent(
        {
          eventKey: "admin.dsr.sla_risk",
          tenantId,
          actorRef: { kind: "system", id: "dsr-sla-check" },
          subjectRef: { kind: "data_subject_request", id: requestId },
          // Exactly the id, the enum and the deadline — no subject, no note.
          payload: { requestId, requestType: row.requestType, slaDueAt: slaDueAt.toISOString() },
          dedupeKey: `dsr.sla_risk:${requestId}:${dateKey}`,
        },
        { db, clock }
      );
      affected += result.deduped ? 0 : 1;
    } catch (error) {
      errors += 1;
      logger.error("dsr sla check failed for one request", {
        event: "dsr.sla_risk.failed",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("dsr sla check completed", {
    event: "dsr.sla_check.completed",
    scanned: rows.length,
    warned: affected,
    dateKey,
  });

  return { scanned: rows.length, affected, skipped, errors, hasMore: rows.length >= limit };
}

/** `dsr-sla-check` — daily, 500 requests per run (contract §10.2; ADR-0918). */
export const dsrSlaCheckJob: CronJob = defineCronJob({
  name: "dsr-sla-check",
  defaultLimit: 500,
  maxLimit: 1000,
  run: ({ limit, clock, logger }) => dsrSlaCheck({ db: getDb(), clock, logger, limit }),
});
