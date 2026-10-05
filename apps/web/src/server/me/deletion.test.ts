import { describe, expect, it } from "vitest";

import { computeDeletionScheduledAt } from "./deletion";

/**
 * Unit — the account-deletion schedule (OP-91, contract §1.4).
 *
 * `POST /api/v1/me/deletion` sets
 * `userProfiles.deletionScheduledAt = now + graceDays`. The grace window is a
 * runtime tunable, not a hard-coded constant (CONVENTIONS §6): it is read from
 * `platformSettings.account.deletionGraceDays`. This spec pins the pure
 * arithmetic — the calendar day offset the route then feeds through
 * `getPlatformSettings()`.
 *
 * Contract expected of the implementation:
 *
 *   @/server/me/deletion exports
 *     computeDeletionScheduledAt(
 *       now: Date,
 *       settings: { account: { deletionGraceDays: number } }
 *     ): Date
 *
 * The returned value is a **new** `Date` `graceDays` calendar days after `now`;
 * the input is never mutated.
 */

/** Days-to-milliseconds used only to state the expected instants. */
const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeDeletionScheduledAt (§1.4)", () => {
  it("U2: schedules 14 days after now when the setting is 14", () => {
    const now = new Date("2026-10-05T00:00:00.000Z");
    const scheduled = computeDeletionScheduledAt(now, { account: { deletionGraceDays: 14 } });
    expect(scheduled.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("U2: honours a non-default grace window from settings", () => {
    // A different setting must produce a different instant; a hard-coded 14
    // would fail here.
    const now = new Date("2026-10-05T12:30:00.000Z");
    const scheduled = computeDeletionScheduledAt(now, { account: { deletionGraceDays: 7 } });
    expect(scheduled.toISOString()).toBe("2026-10-12T12:30:00.000Z");
  });

  it("U2: returns a new Date and never mutates now", () => {
    const now = new Date("2026-10-05T00:00:00.000Z");
    const before = now.getTime();
    const scheduled = computeDeletionScheduledAt(now, { account: { deletionGraceDays: 3 } });
    expect(scheduled).not.toBe(now);
    expect(now.getTime()).toBe(before);
    expect(scheduled.getTime() - now.getTime()).toBe(3 * DAY_MS);
  });
});
