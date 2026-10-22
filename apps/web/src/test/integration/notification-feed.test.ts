import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as listNotifications } from "@/app/api/v1/me/notifications/route";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { insertFeedRow } from "../helpers/notification-rows";

/**
 * Integration / contract — `GET /api/v1/me/notifications` (OP-97, contract
 * §7.1; design §19.4, §21).
 *
 * The feed is the read surface for the in-app notification panel: one cursor
 * page of the caller's rows, filtered by a `createdAt` band, by category or by
 * event, plus a `summary` the shell renders without a second call.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/me/notifications/route` exports `GET`, guarded with the `user`
 * label, reading `notifications` (schema §19.4) and answering
 * `{ data, page: { nextCursor, hasMore, limit }, summary: { unreadCount,
 * unreadByCategory } }`.
 *
 * - `filter` ∈ `active` (default, last 30 days) | `unread` | `all` (last 90
 *   days) | `archived` (the 30–90 day band);
 * - `category` is repeatable; `eventId` scopes to one event; `limit` defaults
 *   to 20 and is clamped to 50; `cursor` continues on `createdAt` + `_id`;
 * - rows are sorted `createdAt` desc with `_id` descending as the tie-break,
 *   and projected to **exactly** the §7.1 projection list:
 *   `id`, `typeKey`, `category`, `severity`, `title`, `body`, `data`, `groupKey`,
 *   `groupCount`, `actionTarget`, `actions`, `actionResolvedVia`,
 *   `actionResolvedAt`, `readAt`, `eventId`, `tenantId`, `createdAt`,
 *   `updatedAt`. The two unresolved-action audit fields are always present and
 *   `null` when the row has no resolution. `title`/`body` are the stored
 *   pre-rendered strings; `category` is denormalised from the catalogue (the
 *   stored feed row does not carry it, and `severity` is denormalised the same
 *   way);
 * - the response never carries an `_id` or any other never-return field
 *   (§0.15), and never an `auth.otp.*` row — defence in depth, since the fan-out
 *   already refuses to write one (design rule 6).
 *
 * ## Assumptions recorded in the handoff
 *
 * - `unreadCount` in `summary` is the caller's whole unread count (the same
 *   number the `unread-count` endpoint returns), not the count of the page.
 * - An explicitly supplied `window` narrows the lookback only (see the unit
 *   spec's `resolveFeedWindow` contract).
 * - An unknown `filter` value falls back to the default `active` band (never a
 *   `400`); a non-positive or non-numeric `limit` falls back to the default of
 *   `20` (contract §7.1). Both choices are recorded in ADR-0131.
 */

const FEED_PATH = "/api/v1/me/notifications";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op97-feed" });
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** The instant `days` ago, so seeded rows land in (or outside) a filter band. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** One feed item as the §7.1 example projects it. */
interface FeedItem {
  readonly id: string;
  readonly typeKey: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly actionTarget: Record<string, unknown> | null;
  readonly actions: readonly Record<string, unknown>[];
  readonly actionResolvedVia: string | null;
  readonly actionResolvedAt: string | null;
  readonly readAt: string | null;
  readonly eventId: string | null;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The exact §7.1 projection of one feed item (contract §7.1; ADR-0131
 * §Feed projection), in the sorted order `Object.keys(...).sort()` produces.
 *
 * An item carrying **any** extra key — `titleKey` or `expireAt`, which the
 * stored row deliberately holds, `_id`, or a field added by accident — fails
 * this pin. `findForbiddenFields` cannot catch `titleKey`/`expireAt` because
 * they are not in its shared forbidden-key set, so the exact key set is the
 * assertion that makes the "must not reach the wire" claim real.
 */
const FEED_ITEM_KEYS = [
  "actionResolvedAt",
  "actionResolvedVia",
  "actionTarget",
  "actions",
  "body",
  "category",
  "createdAt",
  "data",
  "eventId",
  "groupCount",
  "groupKey",
  "id",
  "readAt",
  "severity",
  "tenantId",
  "title",
  "typeKey",
  "updatedAt",
];

interface FeedBody {
  readonly data: readonly FeedItem[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly limit: number;
  };
  readonly summary: {
    readonly unreadCount: number;
    readonly unreadByCategory: Record<string, number>;
  };
}

/** A GET with the session cookie and any query string appended. */
function feedRequest(session: SignedInUser, query = ""): Request {
  return new Request(new URL(`${FEED_PATH}${query}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie: session.cookie },
  });
}

/** GET the feed and parse the body. */
async function fetchFeed(session: SignedInUser, query = ""): Promise<FeedBody> {
  const response = await listNotifications(feedRequest(session, query));
  expect(response.status).toBe(200);
  return (await response.json()) as FeedBody;
}

/** The `data[].id` of a feed page, in the order the server returned them. */
function idsOf(body: FeedBody): string[] {
  return body.data.map((item) => item.id);
}

describe("GET /api/v1/me/notifications — filter bands (I1)", () => {
  it("I1: each filter returns exactly its own createdAt band, newest first", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-bands"));
    const active = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    const readInWindow = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      readAt: daysAgo(2),
      createdAt: daysAgo(2),
    });
    const archivedBand = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      createdAt: daysAgo(45),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "event.details.updated",
      readAt: daysAgo(99),
      createdAt: daysAgo(100),
    });
    const stranger = await app.signIn(makeIdentity("op97-feed-stranger"));
    await insertFeedRow(app.db, {
      userId: stranger.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const activeBand = await fetchFeed(session);
    const unreadBand = await fetchFeed(session, "?filter=unread");
    const allBand = await fetchFeed(session, "?filter=all");
    const archived = await fetchFeed(session, "?filter=archived");

    expect(idsOf(activeBand)).toEqual([active.toString(), readInWindow.toString()]);
    expect(idsOf(unreadBand)).toEqual([active.toString(), archivedBand.toString()]);
    expect(idsOf(allBand)).toEqual([
      active.toString(),
      readInWindow.toString(),
      archivedBand.toString(),
    ]);
    expect(idsOf(archived)).toEqual([archivedBand.toString()]);

    expect(activeBand.summary).toEqual({
      unreadCount: 2,
      unreadByCategory: { account: 1, collaboration: 1 },
    });
  });

  it("I1: filters by category, repeatable, and by eventId", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-scope"));
    const scopedEvent = new ObjectId();
    const otherEvent = new ObjectId();
    const matching = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "attendee.matches.new",
      eventId: scopedEvent,
      createdAt: daysAgo(1),
    });
    const invited = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      eventId: scopedEvent,
      createdAt: daysAgo(2),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "event.details.updated",
      eventId: otherEvent,
      createdAt: daysAgo(3),
    });

    const byCategory = await fetchFeed(session, "?category=matching");
    const eitherCategory = await fetchFeed(session, "?category=matching&category=collaboration");
    const byEvent = await fetchFeed(session, `?eventId=${scopedEvent.toHexString()}`);

    expect(idsOf(byCategory)).toEqual([matching.toString()]);
    expect(idsOf(eitherCategory)).toEqual([matching.toString(), invited.toString()]);
    expect(idsOf(byEvent)).toEqual([matching.toString(), invited.toString()]);
  });

  it("I1: returns the secondary data and appends the next cursor", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-page"));
    const first = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    const second = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(2),
    });
    const third = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(3),
    });

    const page = await fetchFeed(session, "?limit=2");
    expect(idsOf(page)).toEqual([first.toString(), second.toString()]);
    expect(page.page.limit).toBe(2);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).not.toBeNull();

    const next = await fetchFeed(
      session,
      `?limit=2&cursor=${encodeURIComponent(String(page.page.nextCursor))}`
    );
    expect(idsOf(next)).toEqual([third.toString()]);
    expect(next.page.hasMore).toBe(false);
  });

  it("I1: defaults the limit to 20 and clamps a larger limit to 50", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-limit"));

    const defaulted = await fetchFeed(session);
    const clamped = await fetchFeed(session, "?limit=100");

    expect(defaulted.page.limit).toBe(20);
    expect(clamped.page.limit).toBe(50);
  });
});

describe("GET /api/v1/me/notifications — limit and filter boundaries", () => {
  it.each(["?limit=0", "?limit=-5", "?limit=abc", "?limit="])(
    "I1: falls back to the default limit of 20 for %s",
    async (query) => {
      const session = await app.signIn(makeIdentity("op97-feed-limit-bound"));

      const body = await fetchFeed(session, query);

      expect(body.page.limit).toBe(20);
    }
  );

  it("I1: falls back to the default `active` band for an unknown filter", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-filter-unknown"));
    const inActive = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "event.details.updated",
      createdAt: daysAgo(45),
    });

    const unknown = await fetchFeed(session, "?filter=bogus");
    const fallback = await fetchFeed(session);

    expect(idsOf(unknown)).toEqual([inActive.toString()]);
    expect(idsOf(unknown)).toEqual(idsOf(fallback));
  });
});

describe("GET /api/v1/me/notifications — cursor pagination", () => {
  it("I1: breaks a `createdAt` tie on `_id` descending with no row skipped or repeated", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-tie"));
    const sharedCreatedAt = daysAgo(1);
    const first = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: sharedCreatedAt,
    });
    const second = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: sharedCreatedAt,
    });
    const third = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: sharedCreatedAt,
    });

    // All three rows share one `createdAt`, so only the `_id` tie-break can
    // order them: newest `_id` first, deterministically.
    const expected = [first.toString(), second.toString(), third.toString()].sort((a, b) =>
      a < b ? 1 : a > b ? -1 : 0
    );

    const pageOne = await fetchFeed(session, "?limit=2");
    expect(idsOf(pageOne)).toEqual(expected.slice(0, 2));
    expect(pageOne.page.hasMore).toBe(true);
    expect(pageOne.page.nextCursor).not.toBeNull();

    const pageTwo = await fetchFeed(
      session,
      `?limit=2&cursor=${encodeURIComponent(String(pageOne.page.nextCursor))}`
    );

    expect(idsOf(pageTwo)).toEqual(expected.slice(2));
    expect(pageTwo.page.hasMore).toBe(false);
    expect(new Set([...idsOf(pageOne), ...idsOf(pageTwo)]).size).toBe(3);
  });
});

describe("GET /api/v1/me/notifications — projection", () => {
  it("returns the stored, pre-rendered row projected to the §7.1 shape", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-projection"));
    const createdAt = daysAgo(1);
    const id = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "collab.invite.sent",
      severity: "important",
      title: "Rahul invited you to co-organize",
      body: "Rahul & Priya's Wedding · expires in 13 days",
      data: { eventId: "6702ffffffffffffffffffff", link: "/invitations/6703bb" },
      groupKey: "6702ffffffffffffffffffff",
      groupCount: 1,
      actionTarget: { kind: "invitation", id: "6703bbbbbbbbbbbbbbbbbbbb", state: "open" },
      actions: [
        { key: "accept", label: "Accept", style: "primary", state: "available" },
        { key: "reject", label: "Decline", style: "secondary", state: "available" },
      ],
      createdAt,
      updatedAt: createdAt,
    });

    const body = await fetchFeed(session, "?filter=all");
    const item = body.data[0];

    expect(item).toMatchObject({
      id: id.toString(),
      typeKey: "collab.invite.sent",
      category: "collaboration",
      severity: "important",
      title: "Rahul invited you to co-organize",
      body: "Rahul & Priya's Wedding · expires in 13 days",
      data: { eventId: "6702ffffffffffffffffffff", link: "/invitations/6703bb" },
      groupKey: "6702ffffffffffffffffffff",
      groupCount: 1,
      actionTarget: { kind: "invitation", id: "6703bbbbbbbbbbbbbbbbbbbb", state: "open" },
      readAt: null,
      eventId: null,
      tenantId: null,
    });
    expect(item?.createdAt).toBe(createdAt.toISOString());
    expect(item?.updatedAt).toBe(createdAt.toISOString());
    expect(item?.actions).toEqual([
      { key: "accept", label: "Accept", style: "primary", state: "available" },
      { key: "reject", label: "Decline", style: "secondary", state: "available" },
    ]);

    // F1: the projection is exhaustive. `titleKey`, `expireAt`, `_id` or any
    // other extra key must not reach the wire — and since `findForbiddenFields`
    // does not know `titleKey`/`expireAt`, the exact key set is what makes that
    // claim real.
    if (item === undefined) {
      throw new Error("the projection response carried no feed item");
    }
    expect(Object.keys(item).sort()).toEqual(FEED_ITEM_KEYS);
  });

  it("I6: the response body carries no never-return field", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-never-return"));
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });

    const response = await listNotifications(feedRequest(session));
    const body: unknown = await response.json();

    expect(findForbiddenFields(body, "default")).toEqual([]);

    // F1: the shared scanner does not know `titleKey`/`expireAt`, so also pin
    // the exact projection key set — any extra key is a leak.
    const parsed = body as FeedBody;
    expect(parsed.data).toHaveLength(1);
    const item = parsed.data[0];
    if (item === undefined) {
      throw new Error("the never-return response carried no feed item");
    }
    expect(Object.keys(item).sort()).toEqual(FEED_ITEM_KEYS);
  });
});

describe("GET /api/v1/me/notifications — OTP defence in depth (I7)", () => {
  it("I7: never returns an OTP-type row even when one is stored", async () => {
    const session = await app.signIn(makeIdentity("op97-feed-otp"));
    const welcome = await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "account.welcome",
      createdAt: daysAgo(1),
    });
    await insertFeedRow(app.db, {
      userId: session.userId,
      typeKey: "auth.otp.email.requested",
      severity: "critical",
      title: "Your OpenPic code",
      body: "123456",
      createdAt: daysAgo(1),
    });

    const all = await fetchFeed(session, "?filter=all");
    const unread = await fetchFeed(session, "?filter=unread");
    const filtered = await fetchFeed(session, "?category=authentication");

    expect(idsOf(all)).toEqual([welcome.toString()]);
    expect(idsOf(unread)).toEqual([welcome.toString()]);
    expect(idsOf(filtered)).toEqual([]);
  });
});
