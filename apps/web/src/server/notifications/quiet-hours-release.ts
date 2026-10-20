/**
 * Quiet-hours release cron (OP-96, design §5, contract §10.2
 * `quiet-hours-release`, ADR-0119/ADR-0093).
 *
 * A quiet-hours deferral is a durable, selectable intent: the fan-out persists
 * a `notificationDispatches` row with `status: "deferred"` and `until` = the
 * window end (never a terminal `skipped` row). This job releases the deferred
 * rows whose window has ended — `status: "deferred" && until <= now` — sends
 * them through the injected transport and marks each row `sent`/`failed`,
 * bounded by `limit` with `hasMore`.
 */
import type { Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { redeliverDispatchRow, type RedeliveryRow } from "./dispatch-redelivery";
import type { MessageTransport } from "./message-transport";

/** Options accepted by {@link releaseDeferredDispatches}. */
export interface QuietHoursReleaseOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock; defaults to the system clock. */
  readonly clock?: Clock;
  /** The outbound transport the released messages are handed to. */
  readonly transport: MessageTransport;
  /** Maximum rows released per run; defaults to 1000. */
  readonly limit?: number;
}

/** The deferred-row narrowings (schema §19.5 + ADR-0119). */
type DeferredRow = RedeliveryRow;

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown stored value to a deferred dispatch row. */
function asDeferredRow(value: unknown): DeferredRow | null {
  if (!isRecord(value)) return null;
  const { _id, userId, typeKey, channel, attempts, subject, body } = value;
  if (_id === undefined || typeof typeKey !== "string" || typeof channel !== "string") {
    return null;
  }
  return {
    _id: _id as DeferredRow["_id"],
    userId: (userId ?? null) as DeferredRow["userId"],
    channel: channel as DeferredRow["channel"],
    attempts: typeof attempts === "number" ? attempts : 0,
    subject: typeof subject === "string" ? subject : null,
    body: typeof body === "string" ? body : null,
  };
}

/**
 * Release deferred dispatches whose quiet-hours window has ended, bounded by
 * `limit` (I5, I11, I12).
 *
 * @param options - Database/clock/transport seams and the per-run limit.
 * @returns The §10.2 run outcome.
 */
export async function releaseDeferredDispatches(
  options: QuietHoursReleaseOptions
): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const limit = options.limit ?? 1000;
  const now = clock.now();

  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .find({ status: "deferred", until: { $lte: now } })
    .sort({ until: 1 })
    .toArray();
  const rows = Array.isArray(raw)
    ? raw.map(asDeferredRow).filter((row): row is DeferredRow => row !== null)
    : [];

  let scanned = 0;
  let affected = 0;
  const skipped = 0;
  let errors = 0;
  let hasMore = false;

  for (const row of rows) {
    scanned += 1;

    if (affected >= limit) {
      hasMore = true;
      break;
    }

    const result = await redeliverDispatchRow(db, row, now, options.transport);
    if (result === "sent") {
      affected += 1;
    } else {
      errors += 1;
    }
  }

  getLogger().info("quiet-hours release completed", {
    event: "notification.quiet_hours_release",
    scanned,
    affected,
    skipped,
    errors,
    hasMore,
    limit,
  });

  return { scanned, affected, skipped, errors, hasMore };
}
