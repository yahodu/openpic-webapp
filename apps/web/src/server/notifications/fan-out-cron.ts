import type { CronRunOutcome } from "@/server/jobs/cron-job";
import type { FanOutSummary } from "@/server/notifications/fan-out";

/**
 * Project a notification fan-out run summary onto the bounded cron
 * `CronRunOutcome` (OP-94 §1 follow-up, contract §10.2, ADR-0028, ADR-0095).
 *
 * `runNotificationFanOut` resolves a {@link FanOutSummary}
 * (`{ claimed, processed, failed }`); the cron job that drains it must project
 * that summary onto the framework's {@link CronRunOutcome}
 * (`{ scanned, affected, skipped, errors, hasMore }`) before `defineCronJob`
 * wraps it in the §10.2 envelope.
 *
 * The mapping is total and lossless:
 *
 *   - `scanned`  = `summary.claimed`
 *   - `affected` = `summary.processed`
 *   - `skipped`  = `0` (a claimed event is always processed or failed)
 *   - `errors`   = `summary.failed`
 *   - `hasMore`  = `summary.claimed === batch`
 *
 * `batch` is the resolved, clamped per-invocation limit the job passed to
 * `runNotificationFanOut`, so a run that claimed exactly its budget asks the
 * scheduler to invoke again while a run that drained the outbox does not.
 *
 * @param summary - The fan-out run summary.
 * @param batch - The resolved, clamped batch the run claimed against.
 * @returns The §10.2 run outcome.
 */
export function toCronRunOutcome(summary: FanOutSummary, batch: number): CronRunOutcome {
  return {
    scanned: summary.claimed,
    affected: summary.processed,
    skipped: 0,
    errors: summary.failed,
    hasMore: summary.claimed === batch,
  };
}
