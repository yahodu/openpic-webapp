import { describe, expect, it } from "vitest";

import { resolveFeedWindow, type FeedFilter } from "@/server/notifications/feed";

/**
 * Unit — the feed's `filter` → date-window mapping (OP-97, contract §7.1;
 * design §19.4, §22).
 *
 * The feed exposes four filters whose only difference is the `createdAt` band
 * they read: `active` (last 30 days), `unread` (everything still unread inside
 * the 90-day TTL horizon), `all` (last 90 days) and `archived` (the 30–90 day
 * band). The `window` query parameter may narrow the lookback but must never
 * exceed the 90-day TTL horizon, because nothing older than that exists.
 *
 * ## Contract expected of the implementation (module `@/server/notifications/feed`)
 *
 * ```ts
 * type FeedFilter = "active" | "unread" | "all" | "archived";
 *
 * resolveFeedWindow(input: {
 *   filter: FeedFilter;
 *   now: Date;
 *   windowDays?: number | null;
 * }): { from: Date; to: Date | null }
 * ```
 *
 * - `active`   → `{ from: now - 30d, to: null }`
 * - `unread`   → `{ from: now - 90d, to: null }`
 * - `all`      → `{ from: now - 90d, to: null }`
 * - `archived` → `{ from: now - 90d, to: now - 30d }`
 * - a supplied positive `windowDays` replaces the filter-derived `from`
 *   (`now - min(windowDays, 90) days`) and leaves `to` untouched — it is the
 *   `window` query parameter, capped at the TTL horizon (assumption: the cap
 *   applies to the lookback only).
 */

/** A fixed "now" so every computed boundary is exact, never run-dependent. */
const NOW = new Date("2026-03-31T12:00:00.000Z");

/** The instant exactly `days` before {@link NOW}. */
function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("resolveFeedWindow — the filter → createdAt band mapping", () => {
  it.each<[FeedFilter, Date | null]>([
    ["active", null],
    ["unread", null],
    ["all", null],
    ["archived", daysBefore(30)],
  ])("maps filter=%s to the documented band", (filter, to) => {
    const window = resolveFeedWindow({ filter, now: NOW });

    const expectedFrom = filter === "active" ? daysBefore(30) : daysBefore(90);
    expect(window.from).toEqual(expectedFrom);
    expect(window.to).toEqual(to);
  });

  it("never reaches past the 90-day TTL horizon", () => {
    const filterWindows = (["active", "unread", "all", "archived"] as const).map((filter) =>
      resolveFeedWindow({ filter, now: NOW })
    );

    for (const window of filterWindows) {
      expect(window.from.getTime()).toBeGreaterThanOrEqual(daysBefore(90).getTime());
    }
  });

  it("narrows the lookback when windowDays is supplied", () => {
    const window = resolveFeedWindow({ filter: "all", now: NOW, windowDays: 7 });

    expect(window.from).toEqual(daysBefore(7));
    expect(window.to).toBeNull();
  });

  it("clamps a windowDays larger than the TTL horizon to 90 days", () => {
    const window = resolveFeedWindow({ filter: "active", now: NOW, windowDays: 400 });

    expect(window.from).toEqual(daysBefore(90));
  });

  it("leaves the archived band untouched when windowDays is supplied", () => {
    const window = resolveFeedWindow({ filter: "archived", now: NOW, windowDays: 7 });

    expect(window.from).toEqual(daysBefore(90));
    expect(window.to).toEqual(daysBefore(30));
  });

  it("ignores a non-positive windowDays and falls back to the filter band", () => {
    const window = resolveFeedWindow({ filter: "active", now: NOW, windowDays: 0 });

    expect(window.from).toEqual(daysBefore(30));
  });
});
