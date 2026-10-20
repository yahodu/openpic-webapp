import { describe, expect, it } from "vitest";

import type { FanOutSummary } from "@/server/notifications/fan-out";
import { toCronRunOutcome } from "@/server/notifications/fan-out-cron";

/**
 * Unit contract — the fan-out run summary onto the §10.2 `CronResult` fields
 * (OP-94 §1 follow-up, contract §10.2, ADR-0028, ADR-0095).
 *
 * `runNotificationFanOut` resolves a {@link FanOutSummary}
 * (`{ claimed, processed, failed }`); the cron job that drains it must project
 * that summary onto the bounded-framework `CronRunOutcome`
 * (`{ scanned, affected, skipped, errors, hasMore }`) before `defineCronJob`
 * wraps it in the §10.2 envelope. The projection is the only behaviour this
 * module owns, so it is pinned pure and without a database.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // @/server/notifications/fan-out-cron
 * import type { FanOutSummary } from "@/server/notifications/fan-out";
 * import type { CronRunOutcome } from "@/server/jobs/cron-job";
 *
 * export function toCronRunOutcome(
 *   summary: FanOutSummary,
 *   batch: number
 * ): CronRunOutcome;
 * ```
 *
 * The mapping is total and lossless:
 *   - `scanned`   = `summary.claimed`
 *   - `affected`  = `summary.processed`
 *   - `skipped`   = `0` (a claimed event is always processed or failed)
 *   - `errors`    = `summary.failed`
 *   - `hasMore`   = `summary.claimed === batch` (a full batch may hide a backlog)
 *
 * `batch` is the resolved, clamped per-invocation limit the job passed to
 * `runNotificationFanOut`, so a run that claimed exactly its budget asks the
 * scheduler to invoke again while a run that drained the outbox does not.
 */
describe("toCronRunOutcome — FanOutSummary onto the §10.2 CronRunOutcome", () => {
  it("maps claimed→scanned, processed→affected and failed→errors, skipping none", () => {
    const summary: FanOutSummary = { claimed: 3, processed: 2, failed: 1 };

    expect(toCronRunOutcome(summary, 10)).toEqual({
      scanned: 3,
      affected: 2,
      skipped: 0,
      errors: 1,
      hasMore: false,
    });
  });

  it("reports hasMore when the run claimed its entire batch", () => {
    const summary: FanOutSummary = { claimed: 50, processed: 50, failed: 0 };

    expect(toCronRunOutcome(summary, 50).hasMore).toBe(true);
  });

  it("does not report hasMore when the outbox was drained short of the batch", () => {
    const summary: FanOutSummary = { claimed: 49, processed: 49, failed: 0 };

    expect(toCronRunOutcome(summary, 50).hasMore).toBe(false);
  });

  it.each([
    [500, 500, 0],
    [500, 497, 3],
    [2000, 1999, 1],
  ] as const)(
    "keeps hasMore true for a full batch of %i with processed=%i and failed=%i",
    (claimed, processed, failed) => {
      const summary: FanOutSummary = { claimed, processed, failed };

      expect(toCronRunOutcome(summary, claimed)).toMatchObject({
        scanned: claimed,
        affected: processed,
        skipped: 0,
        errors: failed,
        hasMore: true,
      });
    }
  );

  it("is all-zero and hasMore false for an idle run", () => {
    const summary: FanOutSummary = { claimed: 0, processed: 0, failed: 0 };

    expect(toCronRunOutcome(summary, 500)).toEqual({
      scanned: 0,
      affected: 0,
      skipped: 0,
      errors: 0,
      hasMore: false,
    });
  });
});
