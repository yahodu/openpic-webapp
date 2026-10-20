/**
 * Dispatch retry cron (OP-96, contract §10.2 `notification-dispatch-retry`,
 * ADR-0120).
 *
 * The fan-out records a transport failure on the `notificationDispatches` row
 * with a classified `lastError.retryable`. This job re-attempts **only** the
 * retryable rows, after their backoff delay, and marks the row `sent` on
 * success. A non-retryable failure (a provider contract violation) is never
 * selected — retrying it would only delay the inevitable. A retry is not
 * immediate: {@link retryBackoffMs} grows the delay `×2` per attempt up to a
 * 5-minute ceiling, so a provider outage is not hammered.
 */
import type { Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import { redeliverDispatchRow, type RedeliveryRow } from "./dispatch-redelivery";
import type { MessageTransport } from "./message-transport";

/** The backoff base: 60 s (ADR-0120 assumption 1). */
const BASE_MS = 60_000;
/** The backoff ceiling: 5 minutes. */
const CAP_MS = 300_000;

/** Options accepted by {@link retryDueDispatches}. */
export interface DispatchRetryOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock; defaults to the system clock. */
  readonly clock?: Clock;
  /** The outbound transport the re-attempts are handed to. */
  readonly transport: MessageTransport;
  /** Maximum rows retried per run; defaults to 500. */
  readonly limit?: number;
}

/**
 * The delay in milliseconds before attempt `attempts + 1` is eligible.
 *
 * Base 60 s, `×2` per attempt, capped at 5 minutes; `attempts <= 1` is the
 * base delay (U3).
 *
 * @param attempts - The number of attempts already recorded on the row.
 * @returns The backoff delay in milliseconds.
 */
export function retryBackoffMs(attempts: number): number {
  const normalized = Number.isFinite(attempts) && attempts > 1 ? Math.trunc(attempts) : 1;
  return Math.min(BASE_MS * 2 ** (normalized - 1), CAP_MS);
}

/** A retryable stored dispatch row (schema §19.5). */
interface RetryRow extends RedeliveryRow {
  readonly failedAt: Date | null;
}

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown stored value to a retryable dispatch row. */
function asRetryRow(value: unknown): RetryRow | null {
  if (!isRecord(value)) return null;
  const { _id, userId, typeKey, channel, attempts, failedAt, subject, body } = value;
  if (
    _id === undefined ||
    typeof typeKey !== "string" ||
    typeof channel !== "string" ||
    typeof attempts !== "number"
  ) {
    return null;
  }
  return {
    _id: _id as RetryRow["_id"],
    userId: (userId ?? null) as RetryRow["userId"],
    channel: channel as RetryRow["channel"],
    attempts,
    failedAt: failedAt instanceof Date ? failedAt : null,
    subject: typeof subject === "string" ? subject : null,
    body: typeof body === "string" ? body : null,
  };
}

/**
 * Re-attempt failed-retryable dispatches whose backoff has elapsed, bounded by
 * `limit` (I4, I9, I10).
 *
 * @param options - Database/clock/transport seams and the per-run limit.
 * @returns The §10.2 run outcome.
 */
export async function retryDueDispatches(options: DispatchRetryOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const limit = options.limit ?? 500;
  const now = clock.now();

  // Retries are bounded by the settings seam (F2, ADR-0130): a row that has
  // reached `pipeline.maxAttempts` is no longer selectable, so a permanently
  // retryable failure leaves the sweep instead of being re-attempted forever.
  // The cap is read through the existing settings seam, never a constant.
  const settings = await getPlatformSettings({ db, clock });
  const maxAttempts = settings.pipeline.maxAttempts;

  // The read is bounded too (F3, ADR-0130): fetch one more than the run will
  // process so `hasMore` reports a remaining backlog without materialising it.
  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .find({ status: "failed", "lastError.retryable": true, attempts: { $lt: maxAttempts } })
    .sort({ failedAt: 1 })
    .limit(limit + 1)
    .toArray();
  const rows = Array.isArray(raw)
    ? raw.map(asRetryRow).filter((row): row is RetryRow => row !== null)
    : [];

  let scanned = 0;
  let affected = 0;
  let skipped = 0;
  let errors = 0;
  let hasMore = rows.length > limit;

  for (const row of rows) {
    scanned += 1;

    const due =
      row.failedAt !== null &&
      row.failedAt.getTime() + retryBackoffMs(row.attempts) <= now.getTime();
    if (!due) {
      skipped += 1;
      continue;
    }

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

  getLogger().info("dispatch retry completed", {
    event: "notification.dispatch_retry",
    scanned,
    affected,
    skipped,
    errors,
    hasMore,
    limit,
  });

  return { scanned, affected, skipped, errors, hasMore };
}
