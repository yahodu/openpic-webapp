import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { weakETag } from "@/server/http/etag";
import {
  buildUnreadCountFilter,
  composeUnreadEtag,
  highestSeverity,
} from "@/server/notifications/unread-count";

/**
 * Unit — the unread-count hot path's pure pieces (OP-97, contract §7.2;
 * design §19.4, §21).
 *
 * Three decisions can be pinned without a database, and all three are what make
 * the polled badge cheap and cacheable:
 *
 *   U3 `highestSeverity` ranks `critical > important > informational` and
 *      returns `null` when nothing is unread, so the bell can render a red vs.
 *      a grey dot without fetching the list;
 *   U2 `composeUnreadEtag` builds the weak `ETag` `"<count>-<severity>-<epoch>"`
 *      so an unchanged count, severity and version is a `304`;
 *   `buildUnreadCountFilter` is the exact `{ userId, readAt: null, expireAt }`
 *      predicate the route counts with — the one the partial index
 *      `idx_user_unread` supports (its `explain` plan is pinned by the
 *      integration suite, I4).
 *
 * ## Contract expected of the implementation (module `@/server/notifications/unread-count`)
 *
 * ```ts
 * highestSeverity(severities: readonly string[]): NotificationSeverity | null
 * composeUnreadEtag(input: {
 *   unreadCount: number;
 *   highestSeverity: string | null;
 *   epochSeconds: number;
 * }): string
 * buildUnreadCountFilter(input: { userId: ObjectId; now: Date }): Document
 * ```
 *
 * `composeUnreadEtag` returns {@link weakETag} of
 * `` `${unreadCount}-${highestSeverity ?? "none"}-${epochSeconds}` `` — the
 * exact string the contract §7.2 example (`"3-important-1790086920"`) shows.
 *
 * `buildUnreadCountFilter` returns exactly
 * `{ userId, readAt: null, expireAt: { $gt: now } }`: `readAt: null` is what
 * makes the query use the partial index, and `expireAt` excludes rows the TTL
 * monitor has not swept yet (I8).
 */

describe("highestSeverity — severity ranking for the bell", () => {
  it("U3: ranks critical above important above informational", () => {
    expect(highestSeverity(["informational", "critical", "important"])).toBe("critical");
    expect(highestSeverity(["informational", "important"])).toBe("important");
    expect(highestSeverity(["informational"])).toBe("informational");
  });

  it("U3: returns null when nothing is unread", () => {
    expect(highestSeverity([])).toBeNull();
  });

  it("U3: ignores unknown severity values", () => {
    expect(highestSeverity(["bogus", "informational"])).toBe("informational");
    expect(highestSeverity(["bogus"])).toBeNull();
  });
});

describe("composeUnreadEtag — the conditional-request token", () => {
  it("U2: composes count, severity and epoch into a weak ETag", () => {
    expect(
      composeUnreadEtag({
        unreadCount: 3,
        highestSeverity: "important",
        epochSeconds: 1790086920,
      })
    ).toBe(weakETag("3-important-1790086920"));
  });

  it("U2: renders the no-unread case with a `none` severity", () => {
    expect(composeUnreadEtag({ unreadCount: 0, highestSeverity: null, epochSeconds: 0 })).toBe(
      weakETag("0-none-0")
    );
  });

  it("U2: changes when only the severity changes", () => {
    const before = composeUnreadEtag({
      unreadCount: 1,
      highestSeverity: "informational",
      epochSeconds: 10,
    });
    const after = composeUnreadEtag({
      unreadCount: 1,
      highestSeverity: "critical",
      epochSeconds: 10,
    });

    expect(after).not.toBe(before);
  });
});

describe("buildUnreadCountFilter — the indexed count predicate", () => {
  it("filters on the caller, unread rows and unexpired rows only", () => {
    const userId = new ObjectId();
    const now = new Date("2026-03-31T12:00:00.000Z");

    expect(buildUnreadCountFilter({ userId, now })).toEqual({
      userId,
      readAt: null,
      expireAt: { $gt: now },
    });
  });
});
