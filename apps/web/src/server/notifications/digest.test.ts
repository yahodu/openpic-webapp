import { describe, expect, it } from "vitest";

import { computeDigestFlushAt, withinDigestDailyCap } from "@/server/notifications/digest";

/**
 * Unit — digest flush scheduling and the daily cap (OP-96, design §6, §19.6;
 * contract §9.10 `platformSettings.notifications`, §10.2
 * `notification-digest-flush`; ADR-0100).
 *
 * A digest type's occurrences accumulate in one open `notificationDigests`
 * bucket; the bucket carries a single `flushAt` instant that the flush cron
 * polls (`status: "open"` && `flushAt <= now`). Design §19.6 expresses "flush
 * 15 min after the burst ends, but never later than 6 h" as one field:
 *
 *   - each arrival **pushes `flushAt` forward** to `lastItemAt + quietMinutes`;
 *   - but it is **capped** at `firstItemAt + hardFlushHours`, so a burst that
 *     never goes quiet still flushes on schedule.
 *
 * The two tunables come from `platformSettings.notifications`
 * (`digestQuietMinutes`, `digestHardFlushHours`) — never a hard-coded constant.
 *
 * The daily cap (`maxDigestEmailsPerDay`, default 3) bounds how many digest
 * emails one recipient may receive in a day; a due bucket beyond the cap is
 * **deferred**, not dropped (design §6; contract §10.2 "Respects
 * `maxDigestEmailsPerDay` (3)").
 *
 * ## Contract expected of the implementation (module `@/server/notifications/digest`)
 *
 * ```ts
 * interface DigestFlushAtInput {
 *   firstItemAt: Date;      // bucket creation instant
 *   lastItemAt: Date;       // most recent arrival instant
 *   quietMinutes: number;   // platformSettings.notifications.digestQuietMinutes
 *   hardFlushHours: number; // platformSettings.notifications.digestHardFlushHours
 * }
 * computeDigestFlushAt(input: DigestFlushAtInput): Date
 *
 * withinDigestDailyCap(sentToday: number, maxPerDay: number): boolean
 * ```
 *
 * Also exported from the same module (exercised by
 * `test/integration/notification-digest.test.ts`):
 *
 * ```ts
 * flushDueDigests(options: {
 *   db?: Db; clock?: Clock; transport: MessageTransport; limit?: number;
 * }): Promise<{ scanned: number; affected: number; skipped: number;
 *               errors: number; hasMore: boolean }>
 * ```
 */

/** A fixed burst origin so nothing here depends on the wall clock. */
const FIRST = new Date("2026-03-01T00:00:00.000Z");

/** Push `base` forward by `ms` milliseconds. */
function plus(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("computeDigestFlushAt — push-forward and cap (U1)", () => {
  it("pushes flushAt to the last arrival plus the quiet period", () => {
    const lastItemAt = plus(FIRST, 10 * MINUTE);

    const flushAt = computeDigestFlushAt({
      firstItemAt: FIRST,
      lastItemAt,
      quietMinutes: 15,
      hardFlushHours: 6,
    });

    expect(flushAt.toISOString()).toBe("2026-03-01T00:25:00.000Z");
  });

  it("a single arrival flushes one quiet period after it", () => {
    const flushAt = computeDigestFlushAt({
      firstItemAt: FIRST,
      lastItemAt: FIRST,
      quietMinutes: 15,
      hardFlushHours: 6,
    });

    expect(flushAt.toISOString()).toBe("2026-03-01T00:15:00.000Z");
  });

  it("caps flushAt at firstItemAt + hardFlushHours when the burst outlives the cap", () => {
    const lastItemAt = plus(FIRST, 7 * HOUR);

    const flushAt = computeDigestFlushAt({
      firstItemAt: FIRST,
      lastItemAt,
      quietMinutes: 15,
      hardFlushHours: 6,
    });

    expect(flushAt.toISOString()).toBe("2026-03-01T06:00:00.000Z");
  });

  it("uses the cap when last + quiet lands exactly on the hard flush", () => {
    // 5h45m after the first item, +15m quiet = exactly 6h after the first item.
    const lastItemAt = plus(FIRST, 5 * HOUR + 45 * MINUTE);

    const flushAt = computeDigestFlushAt({
      firstItemAt: FIRST,
      lastItemAt,
      quietMinutes: 15,
      hardFlushHours: 6,
    });

    expect(flushAt.toISOString()).toBe("2026-03-01T06:00:00.000Z");
  });

  it("does not cap a flush that lands just before the hard flush", () => {
    const lastItemAt = plus(FIRST, 5 * HOUR);

    const flushAt = computeDigestFlushAt({
      firstItemAt: FIRST,
      lastItemAt,
      quietMinutes: 15,
      hardFlushHours: 6,
    });

    expect(flushAt.toISOString()).toBe("2026-03-01T05:15:00.000Z");
  });
});

describe("withinDigestDailyCap — the daily cap decision (U2)", () => {
  it.each<readonly [sentToday: number, maxPerDay: number, expected: boolean]>([
    [0, 3, true],
    [2, 3, true],
    [3, 3, false],
    [4, 3, false],
  ])("withinDigestDailyCap(%i, %i) is %s", (sentToday, maxPerDay, expected) => {
    expect(withinDigestDailyCap(sentToday, maxPerDay)).toBe(expected);
  });

  it("treats a non-positive cap as exhausted", () => {
    expect(withinDigestDailyCap(0, 0)).toBe(false);
  });
});
