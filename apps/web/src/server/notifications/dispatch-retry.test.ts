import { describe, expect, it } from "vitest";

import { retryBackoffMs } from "@/server/notifications/dispatch-retry";

/**
 * Unit — the dispatch retry backoff schedule (OP-96, contract §10.2
 * `notification-dispatch-retry`, §9.10 platform settings; ADR-0100).
 *
 * The `notification-dispatch-retry` cron re-attempts a `notificationDispatches`
 * row that failed **retryably** (`lastError.retryable: true`). A retry must not
 * be immediate: the delay before the next attempt grows exponentially and is
 * capped, so a provider outage is not hammered while a blip is still retried
 * promptly (the contract's "×2, capped" retry rule; §10.2).
 *
 * ## Contract expected of the implementation
 * (module `@/server/notifications/dispatch-retry`)
 *
 * ```ts
 * // `attempts` is the number of attempts already recorded on the row
 * // (1 => the first attempt just failed). The returned value is the delay
 * // in milliseconds before attempt `attempts + 1` becomes eligible.
 * retryBackoffMs(attempts: number): number
 * ```
 *
 * The schedule is base **60 s**, **×2** per attempt, capped at **5 min**:
 *
 * | attempts | delay  |
 * | -------- | ------ |
 * | 0 or 1   | 60 s   |
 * | 2        | 120 s  |
 * | 3        | 240 s  |
 * | 4+       | 300 s  |
 *
 * Also exported from the same module (exercised by
 * `test/integration/notification-dispatch-retry.test.ts`):
 *
 * ```ts
 * retryDueDispatches(options: {
 *   db?: Db; clock?: Clock; transport: MessageTransport; limit?: number;
 * }): Promise<{ scanned: number; affected: number; skipped: number;
 *               errors: number; hasMore: boolean }>
 * ```
 *
 * ## Assumption
 *
 * The design fixes the growth (`×2`) and the ceiling (5 minutes) but not the
 * base; **60 s** is chosen so that a transient failure is retried by the
 * 5-minute cron cadence without an immediate hammer. Pinned here so the
 * schedule cannot drift silently.
 */
describe("retryBackoffMs — the backoff schedule (U3)", () => {
  it.each<readonly [attempts: number, expectedMs: number]>([
    [0, 60_000],
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
    [4, 300_000],
    [5, 300_000],
    [8, 300_000],
  ])("retryBackoffMs(%i) is %i ms", (attempts, expectedMs) => {
    expect(retryBackoffMs(attempts)).toBe(expectedMs);
  });
});
