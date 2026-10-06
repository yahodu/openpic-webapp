/**
 * Dispatch retry cron (OP-96, contract §10.2 `notification-dispatch-retry`,
 * ADR-0100).
 *
 * The fan-out records a transport failure on the `notificationDispatches` row
 * with a classified `lastError.retryable`. This job re-attempts **only** the
 * retryable rows, after their backoff delay, and marks the row `sent` on
 * success. A non-retryable failure (a provider contract violation) is never
 * selected — retrying it would only delay the inevitable. A retry is not
 * immediate: {@link retryBackoffMs} grows the delay `×2` per attempt up to a
 * 5-minute ceiling, so a provider outage is not hammered.
 */
import type { Db, ObjectId as ObjectIdValue } from "mongodb";

import { getAppEnv } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { buildRedeliveryMessage, resolveDestination, sendRedelivery } from "./dispatch-redelivery";
import type { MessageTransport } from "./message-transport";
import type { ResolvedChannel } from "./resolve-channel";

/** The backoff base: 60 s (ADR-0100 assumption 1). */
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
interface RetryRow {
  readonly _id: ObjectIdValue;
  readonly userId: ObjectIdValue | null;
  readonly typeKey: string;
  readonly channel: string;
  readonly attempts: number;
  readonly failedAt: Date | null;
  readonly subject: string | null;
  readonly body: string | null;
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
    _id: _id as ObjectIdValue,
    userId: (userId ?? null) as ObjectIdValue | null,
    typeKey,
    channel,
    attempts,
    failedAt: failedAt instanceof Date ? failedAt : null,
    subject: typeof subject === "string" ? subject : null,
    body: typeof body === "string" ? body : null,
  };
}

/** Re-attempt one due row and persist its transition. */
async function retryOneRow(
  db: Db,
  row: RetryRow,
  now: Date,
  transport: MessageTransport
): Promise<"sent" | "error"> {
  const attempts = row.attempts + 1;

  const channel = row.channel as ResolvedChannel;
  const destination = await resolveDestination(db, row.userId, channel);
  if (destination === null) {
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: row._id },
        {
          $set: {
            status: "failed",
            attempts,
            failedAt: now,
            lastError: { retryable: false, code: "no_destination" },
          },
        }
      );
    return "error";
  }

  const message = buildRedeliveryMessage(
    { userId: row.userId, channel, subject: row.subject, body: row.body },
    destination
  );
  if (message === null) return "error";

  const outcome = await sendRedelivery(transport, message);
  if (!outcome.ok) {
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: row._id },
        { $set: { status: "failed", attempts, failedAt: now, lastError: outcome.failure } }
      );
    return "error";
  }

  await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .updateOne(
      { _id: row._id },
      {
        $set: {
          status: "sent",
          attempts,
          sentAt: now,
          lastError: null,
          providerRef: {
            provider: "transport",
            env: getAppEnv(),
            messageId: outcome.receipt.providerMessageId,
          },
        },
      }
    );
  return "sent";
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

  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .find({ status: "failed", "lastError.retryable": true })
    .sort({ failedAt: 1 })
    .toArray();
  const rows = Array.isArray(raw)
    ? raw.map(asRetryRow).filter((row): row is RetryRow => row !== null)
    : [];

  let scanned = 0;
  let affected = 0;
  let skipped = 0;
  let errors = 0;
  let hasMore = false;

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

    const result = await retryOneRow(db, row, now, options.transport);
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
