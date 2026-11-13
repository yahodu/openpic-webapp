import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import {
  createBoundAttendeeSession,
  myEvents,
  myEventsBodyOf,
  seedProfile,
  seedUnseenMatches,
} from "../helpers/attendee-claim-flow";
import { makeIdentity, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { nextIp, seedTenant, type SeededEvent } from "../helpers/selfie-flow";

/**
 * Integration / contract — `GET /api/v1/me/events` (OP-134 I3; contract §6.7,
 * §0.4, Appendix C; schema §10.3, §15.3; ADR-0811).
 *
 * **Why this exists.** This is **the single whitelisted cross-tenant read** in
 * the whole product (§6.7, §0.4). Every other query is confined by
 * `tenantRepo`; this one deliberately crosses tenant boundaries to answer "all
 * my events", which makes the filter the entire security boundary: the only
 * predicate allowed to decide which rows come back is
 * `subject.userId === <caller>`, through the index
 * `{"subject.userId":1, updatedAt:-1}`.
 *
 * The failure this spec exists to catch is not "the endpoint is missing" (that
 * is the honest load failure) but **"the endpoint works and also returns
 * somebody else's event"** — a filter that dropped a clause, a join that keyed on
 * the event instead of the subject, or a `find()` whose `tenantId` came from the
 * first row. One seeded profile belonging to another user is therefore the
 * loudest assertion in the file.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // apps/web/src/app/api/v1/me/events/route.ts
 * export const GET: (request: Request) => Promise<Response>;
 * ```
 *
 * - Auth `user` (§6.7). An anonymous `op_att` session is `401
 *   authentication_required`: Appendix D gives "claim" to identified attendees
 *   and this read is the account's own list.
 * - `200 { data: [...], page: {nextCursor, hasMore, limit} }`; `limit` defaults
 *   to 40 (§6.7 `?limit=`, §0.8).
 * - Each item carries exactly the thirteen keys §6.7 documents, sorted:
 *   `coverThumbnailUrl, displayTimeZone, eventId, eventName, expiringSoon,
 *   galleryExpiresAt, galleryUrl, matchCount, newMatchCount,
 *   organizerDisplayName, slug, startAt, status`.
 * - `matchCount` is the profile's cached counter (§15.3), never a count query;
 *   `newMatchCount` counts the matches the attendee has not seen.
 * - `galleryUrl` is `/e/{slug}/gallery` — the same path the poll's `galleryUrl`
 *   and the claim's `claimed[].galleryUrl` carry.
 * - `expiringSoon` is `computeExpiringSoon({galleryExpiresAt, now})` (U1).
 *
 * ## Assumptions (recorded in ADR-0811)
 *
 * - `coverThumbnailUrl` is `null` for an event with no uploaded images; §6.7
 *   shows a signed URL but names no cover-asset pointer on `events`, so a
 *   fixture with no media can only answer `null`.
 * - Ordering is `updatedAt` descending (§Appendix C's index), so the
 *   most-recently-touched participation comes first — and it is what the cursor
 *   pages on, because the index is `{"subject.userId":1, updatedAt:-1}`.
 * - The cursor is §0.8's opaque `base64url(JSON.stringify({c, i}))`; a case
 *   never constructs one, it only echoes the server's `nextCursor` and asserts
 *   that a hand-made value is `400 invalid_cursor`.
 */

let app: TestApp;

/** The thirteen keys §6.7 gives an item, sorted. */
const ITEM_KEYS = [
  "coverThumbnailUrl",
  "displayTimeZone",
  "eventId",
  "eventName",
  "expiringSoon",
  "galleryExpiresAt",
  "galleryUrl",
  "matchCount",
  "newMatchCount",
  "organizerDisplayName",
  "slug",
  "startAt",
  "status",
];

/** §0.8/§6.7's default page size. */
const DEFAULT_LIMIT = 40;

/** One day, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op134-me-events" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.attendeeSessions,
    COLLECTIONS.attendeeEventProfiles,
    COLLECTIONS.faceMatches,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
    "consents",
    "selfies",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** One seeded tenant with one event, asserting the fixture built what a case needs. */
async function tenantEvent(prefix: string): Promise<{
  readonly tenantKey: string;
  readonly event: SeededEvent;
}> {
  const seeded = await seedTenant(app, prefix);
  const event = seeded.events[0];
  if (event === undefined) {
    throw new Error("expected one seeded event");
  }
  return { tenantKey: seeded.tenantKey, event };
}

describe("when a user reads their own events", () => {
  it("I3: returns only the caller's profiles across two tenants, with the documented item shape", async () => {
    // Arrange — two tenants. The caller attends one event in each; a third
    // event belongs to somebody else.
    const alpha = await tenantEvent("op134-i3-alpha");
    const beta = await tenantEvent("op134-i3-beta");
    const user = await app.signIn(makeIdentity("op134-i3-user"));
    const stranger = await app.signIn(makeIdentity("op134-i3-stranger"));
    const now = Date.now();
    const soon = new Date(now + 3 * DAY_MS);

    // The first tenant's gallery is three days from retention, so this row is
    // the `expiringSoon: true` arm at the route level.
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: alpha.event.id }, { $set: { retentionExpiresAt: soon } });

    // The rows are inserted in an order **opposite** to the sort, so an
    // implementation that orders by `_id` cannot pass: §15.3's index is
    // `{"subject.userId":1, updatedAt:-1}`, so the newest **touch** comes first.
    await seedProfile(app, {
      tenantKey: beta.tenantKey,
      eventId: beta.event.id,
      subject: { kind: "user", userId: user.userId },
      matchCount: 0,
      updatedAt: new Date(now),
    });
    // The other user's event — the assertion this whole spec exists for, and the
    // newest touch of all, so a read that forgot the subject clause would put it
    // first.
    await seedProfile(app, {
      tenantKey: beta.tenantKey,
      eventId: beta.event.id,
      subject: { kind: "user", userId: stranger.userId },
      matchCount: 9,
      updatedAt: new Date(now + 2_000),
    });
    const alphaProfileId = await seedProfile(app, {
      tenantKey: alpha.tenantKey,
      eventId: alpha.event.id,
      subject: { kind: "user", userId: user.userId },
      matchCount: 2,
      updatedAt: new Date(now + 1_000),
    });
    await seedUnseenMatches(app, {
      tenantKey: alpha.tenantKey,
      eventId: alpha.event.id,
      profileId: alphaProfileId,
      subject: { kind: "user", userId: user.userId },
      count: 2,
    });

    // Act
    const response = await myEvents({ cookie: user.cookie, ip: nextIp() });
    const body = await myEventsBodyOf(response);

    // Assert — exactly the caller's two events, newest touch first.
    expect(Object.keys(body).sort()).toEqual(["data", "page"]);
    expect(body.data.map((item) => item.eventId)).toEqual([
      alpha.event.id.toHexString(),
      beta.event.id.toHexString(),
    ]);
    expect(body.data.some((item) => item.matchCount === 9)).toBe(false);

    // Assert — the documented item shape, not a superset.
    expect(body.data.map((item) => Object.keys(item).sort())).toEqual([ITEM_KEYS, ITEM_KEYS]);

    // Assert — the populated item.
    const [alphaItem] = body.data;
    if (alphaItem === undefined) {
      throw new Error("expected the caller's first event in the list");
    }
    expect(alphaItem).toEqual({
      eventId: alpha.event.id.toHexString(),
      eventName: alpha.event.name,
      organizerDisplayName: "Rahul Studio",
      startAt: "2026-11-14T12:00:00.000Z",
      displayTimeZone: "Asia/Kolkata",
      slug: alpha.event.slug,
      galleryUrl: `/e/${alpha.event.slug}/gallery`,
      coverThumbnailUrl: null,
      matchCount: 2,
      newMatchCount: 2,
      status: "ready",
      galleryExpiresAt: soon.toISOString(),
      expiringSoon: true,
    });

    // Assert — the second tenant is in the answer, and its date is far enough
    // away that the badge must stay off.
    const [betaItem] = body.data.slice(1);
    if (betaItem === undefined) {
      throw new Error("expected the caller's second event in the list");
    }
    expect(betaItem.eventId).toBe(beta.event.id.toHexString());
    expect(betaItem.slug).toBe(beta.event.slug);
    expect(betaItem.galleryUrl).toBe(`/e/${beta.event.slug}/gallery`);
    expect(betaItem.expiringSoon).toBe(false);

    // Assert — §0.8's page envelope for a list shorter than one page.
    expect(body.page).toEqual({ nextCursor: null, hasMore: false, limit: DEFAULT_LIMIT });
  });

  it("I3: a user with no attendee profiles gets an empty page, not an error", async () => {
    // Arrange — the tenant exists, but the caller never attended anything.
    await tenantEvent("op134-i3-empty");
    const user = await app.signIn(makeIdentity("op134-i3-empty-user"));

    // Act
    const response = await myEvents({ cookie: user.cookie, ip: nextIp() });

    // Assert
    expect(response.status).toBe(200);
    const body = await myEventsBodyOf(response);
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false, limit: DEFAULT_LIMIT });
  });

  it("I3: pages with the opaque cursor across tenants without repeating or skipping a row", async () => {
    // Arrange — three participations across two tenants, touched in a known
    // order, so the newest-touch-first sort is observable.
    const alpha = await seedTenant(app, "op134-i3-page", 2);
    const beta = await seedTenant(app, "op134-i3-page-beta");
    const [alphaFirst, alphaSecond] = alpha.events;
    const [betaFirst] = beta.events;
    if (alphaFirst === undefined || alphaSecond === undefined || betaFirst === undefined) {
      throw new Error("expected three seeded events");
    }
    const user = await app.signIn(makeIdentity("op134-i3-page-user"));
    const now = Date.now();
    // Inserted oldest-touch first, so the expected answer is the **reverse** of
    // the insertion order — an `_id`-ordered read cannot pass.
    const insertOrder = [
      { tenantKey: beta.tenantKey, event: betaFirst, updatedAt: new Date(now + 1_000) },
      { tenantKey: alpha.tenantKey, event: alphaSecond, updatedAt: new Date(now + 2_000) },
      { tenantKey: alpha.tenantKey, event: alphaFirst, updatedAt: new Date(now + 3_000) },
    ];
    for (const item of insertOrder) {
      await seedProfile(app, {
        tenantKey: item.tenantKey,
        eventId: item.event.id,
        subject: { kind: "user", userId: user.userId },
        updatedAt: item.updatedAt,
      });
    }
    const expectedOrder = [alphaFirst, alphaSecond, betaFirst].map((event) =>
      event.id.toHexString()
    );

    // Act — the first page of two.
    const firstPage = await myEventsBodyOf(
      await myEvents({ cookie: user.cookie, ip: nextIp(), query: "limit=2" })
    );

    // Assert — §0.8's envelope, and the newest-touch-first order.
    expect(firstPage.page.limit).toBe(2);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.data.map((item) => item.eventId)).toEqual(expectedOrder.slice(0, 2));
    const cursor = firstPage.page.nextCursor;
    if (cursor === null) {
      throw new Error("expected a nextCursor when hasMore is true");
    }

    // Act — the second page, read through the cursor the first page issued.
    const secondPage = await myEventsBodyOf(
      await myEvents({
        cookie: user.cookie,
        ip: nextIp(),
        query: `cursor=${encodeURIComponent(cursor)}&limit=2`,
      })
    );

    // Assert — the remaining row, and the walk is complete.
    expect(secondPage.data.map((item) => item.eventId)).toEqual([expectedOrder[2]]);
    expect(secondPage.page.hasMore).toBe(false);
    expect(secondPage.page.nextCursor).toBeNull();

    // Assert — the two pages partition the list: no duplicate, no skip.
    const walked = [...firstPage.data, ...secondPage.data].map((item) => item.eventId);
    expect(walked).toEqual(expectedOrder);
    expect(new Set(walked).size).toBe(3);
  });

  it("I3: a cursor the caller did not receive is refused with 400 invalid_cursor", async () => {
    // Arrange — a caller with one event, and a cursor that is not one of ours.
    const { tenantKey, event } = await tenantEvent("op134-i3-cursor");
    const user = await app.signIn(makeIdentity("op134-i3-cursor-user"));
    await seedProfile(app, {
      tenantKey,
      eventId: event.id,
      subject: { kind: "user", userId: user.userId },
    });

    // Act — §0.8: the cursor is opaque, so a client-constructed one is a `400`.
    const response = await myEvents({
      cookie: user.cookie,
      ip: nextIp(),
      query: "cursor=bm90LWEtY3Vyc29y",
    });

    // Assert
    expect(response.status).toBe(400);
    const refused = (await response.json()) as { readonly error: { readonly code: string } };
    expect(refused.error.code).toBe("invalid_cursor");
  });

  it("I3: an anonymous attendee session cannot read the list", async () => {
    // Arrange — a valid `op_att` credential, but no account behind it.
    const { event } = await tenantEvent("op134-i3-anon");
    const session = await createBoundAttendeeSession(app, event.slug);

    // Act
    const response = await myEvents({ cookie: session.cookie, ip: nextIp() });

    // Assert — §6.7 says Auth `user`; the anonymous surface is §6.4, not §6.7.
    expect(response.status).toBe(401);
    const refused = (await response.json()) as { readonly error: { readonly code: string } };
    expect(refused.error.code).toBe("authentication_required");
  });
});
