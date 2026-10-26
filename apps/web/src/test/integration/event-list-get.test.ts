import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as eventDetailRoute from "@/app/api/v1/events/[eventId]/route";
import * as tenantEventRoute from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/route";
import * as eventsRoute from "@/app/api/v1/tenants/[tenantId]/events/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";

import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";

/**
 * Integration / contract — list and get events (OP-116 I1–I4, contract §4.1,
 * schema §15.1; ADR pending).
 *
 * The organizer (or a co-organizer) browses their events and reads event
 * detail, with tenant-scoped isolation and the event `ETag` presented on
 * reads so a later conditional write is possible.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/events/route` additionally exports `GET`
 *   (`route: "/api/v1/tenants/:tenantId/events"`, tenant members only):
 *   `?status=&cursor=&limit=&q=`, sorted `startAt` desc, envelope
 *   `{ data, page: { nextCursor, hasMore, limit } }`. `status` filters the
 *   rows; an absent status returns every event of the tenant; the cursor
 *   keyset continues on `(startAt, _id)` so a repeat of the same query
 *   returns the same first page and paging never skips or repeats a row.
 * - `@/app/api/v1/events/[eventId]/route` exports `GET` — the global event
 *   detail. It returns the full event detail plus an `ETag` header. Access:
 *   a caller who is a member of the event's tenant **or** a co-organizer
 *   recorded in `event_organizers` for that event may read it; a caller with
 *   no relationship to the event (including an event belonging to another
 *   tenant) receives `404` (never an oracle, contract §0.4).
 * - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/route` (existing OP-115
 *   read) returns `404` for an eventId that belongs to another tenant when
 *   addressed under this tenant's path.
 * - `@/server/events/search`, `@/server/events/pipeline` and the
 *   `uploadClosesInHours` helper in `@/server/events/windows` hold the pure
 *   units (U1–U3).
 *
 * ## Assumptions (recorded in the ADR)
 *
 * - The **list** and **detail** surfaces are the OP-116 additions; the
 *   tenant-scoped read `GET /tenants/{t}/events/{eventId}` already exists
 *   (OP-115) and already isolates cross-tenant by tenantId, so I3 is a
 *   behaviour pin (green on the base), not a red.
 * - **I4 "changes after an update"** is exercised by mutating the stored row
 *   directly (`updatedAt` bump) because OP-116 ships no update endpoint —
 *   that is OP-117. The ETag must be `eventETag(updatedAt, schemaVersion)`,
 *   so a row whose `updatedAt` changes yields a different ETag.
 * - The **co-organizer** is a user recorded in `event_organizers` with
 *   `role: "co_organizer"` who is **not** a tenant member. The detail route
 *   must admit them; the list route stays tenant-members-only.
 */

type TenantKey = string;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op116-events" });
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
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** Read a `GET` export off a route namespace, failing with a naming message. */
function requireGet(module: object, path: string): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>).GET;
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a GET handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const listEvents = requireGet(eventsRoute, "/api/v1/tenants/:tenantId/events");
const getEventDetail = requireGet(eventDetailRoute, "/api/v1/events/:eventId");
const getTenantEvent = requireGet(tenantEventRoute, "/api/v1/tenants/:tenantId/events/:eventId");

/** A signed-in user who owns a fresh active tenant. */
async function seedOwner(prefix: string): Promise<{ user: SignedInUser; tenantId: ObjectId }> {
  const user = await app.signIn(makeIdentity(prefix));
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId: user.userId },
      { $set: { accountCompletedAt: new Date(), displayName: "Organizer", updatedAt: new Date() } }
    );
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op116-${prefix}`,
    name: "OP116 Studio",
    status: "active",
    ownerUserId: user.userId,
    billingContactUserId: user.userId,
    dataRegion: "in",
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return { user, tenantId };
}

/** A monotonically-increasing unique active slug for directly-seeded events. */
let seededSlugSeq = 0;

/** Insert an `events` row with the stored shape, overriding any field. */
async function seedEvent(
  tenantKey: TenantKey,
  overrides: Record<string, unknown> = {}
): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  const slug = `ab${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "OP116 Event",
    description: "",
    status: "published",
    startAt: new Date(fixtureInstant("10:00:00.000Z", 10)),
    endAt: new Date(fixtureInstant("12:00:00.000Z", 10)),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(fixtureInstant("12:00:00.000Z", 17)),
    retentionExpiresAt: new Date(fixtureInstant("12:00:00.000Z", 100)),
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null }],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: "000000000000000000000000",
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return _id;
}

/** A `GET /tenants/{t}/events?...` request carrying the session cookie. */
function listRequest(cookie: string, tenantKey: TenantKey, params: string): Request {
  return new Request(new URL(`/api/v1/tenants/${tenantKey}/events?${params}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** A `GET /events/{eventId}` request carrying the session cookie. */
function detailRequest(cookie: string, eventId: string): Request {
  return new Request(new URL(`/api/v1/events/${eventId}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** A `GET /tenants/{t}/events/{eventId}` request carrying the session cookie. */
function tenantDetailRequest(cookie: string, tenantKey: TenantKey, eventId: string): Request {
  return new Request(new URL(`/api/v1/tenants/${tenantKey}/events/${eventId}`, APP_ORIGIN), {
    method: "GET",
    headers: { cookie },
  });
}

/** The `id` of the first data item of a list page. */
function firstItemId(page: Record<string, unknown>): string {
  const data = page.data as Array<Record<string, unknown>>;
  const first = data[0];
  if (first === undefined) {
    throw new Error("expected a non-empty list page");
  }
  return first.id as string;
}

describe("GET /api/v1/tenants/{tenantId}/events — list", () => {
  it("I1: filters by status and pages with a cursor, without skips or repeats, repeatably", async () => {
    const { user, tenantId } = await seedOwner("op116-list");
    const tenantKey = tenantId.toHexString();

    // Five published events with distinct startAt (newest first) and two drafts.
    const published = [10, 8, 6, 4, 2].map((day) => ({
      name: `Pub ${String(day)}`,
      status: "published",
      startAt: new Date(fixtureInstant("10:00:00.000Z", day)),
    }));
    for (const ev of published) {
      await seedEvent(tenantKey, { name: ev.name, status: ev.status, startAt: ev.startAt });
    }
    await seedEvent(tenantKey, {
      name: "Draft 9",
      status: "draft",
      startAt: new Date(fixtureInstant("10:00:00.000Z", 9)),
    });
    await seedEvent(tenantKey, {
      name: "Draft 3",
      status: "draft",
      startAt: new Date(fixtureInstant("10:00:00.000Z", 3)),
    });

    const firstResponse = await listEvents(
      listRequest(user.cookie, tenantKey, "status=published&limit=2")
    );
    expect(firstResponse.status).toBe(200);
    const firstPage = await body(firstResponse);
    const page1 = firstPage.page as Record<string, unknown>;
    expect(page1.limit).toBe(2);
    expect(page1.hasMore).toBe(true);
    const nextCursor = page1.nextCursor as string;
    expect(nextCursor).toBeTypeOf("string");
    expect(nextCursor.length).toBeGreaterThan(0);

    // Sorted startAt desc: the newest two published events.
    const data1 = firstPage.data as Array<Record<string, unknown>>;
    expect(data1).toHaveLength(2);
    expect(data1.map((row) => row.name)).toEqual(["Pub 10", "Pub 8"]);

    // Repeatable: the same query yields the same first page and cursor.
    const againResponse = await listEvents(
      listRequest(user.cookie, tenantKey, "status=published&limit=2")
    );
    const againPage = await body(againResponse);
    expect(againResponse.status).toBe(200);
    expect(firstItemId(againPage)).toBe(firstItemId(firstPage));
    expect((againPage.page as Record<string, unknown>).nextCursor).toBe(nextCursor);

    // Follow the cursor through the remaining pages to the terminal page.
    const secondResponse = await listEvents(
      listRequest(
        user.cookie,
        tenantKey,
        `status=published&limit=2&cursor=${encodeURIComponent(nextCursor)}`
      )
    );
    expect(secondResponse.status).toBe(200);
    const secondPage = await body(secondResponse);
    const page2 = secondPage.page as Record<string, unknown>;
    const data2 = page2.data as Array<Record<string, unknown>>;
    expect(data2.map((row) => row.name)).toEqual(["Pub 6", "Pub 4"]);
    const nextCursor2 = page2.nextCursor as string;
    expect(page2.hasMore).toBe(true);

    const thirdResponse = await listEvents(
      listRequest(
        user.cookie,
        tenantKey,
        `status=published&limit=2&cursor=${encodeURIComponent(nextCursor2)}`
      )
    );
    expect(thirdResponse.status).toBe(200);
    const thirdPage = await body(thirdResponse);
    const page3 = thirdPage.page as Record<string, unknown>;
    const data3 = page3.data as Array<Record<string, unknown>>;
    expect(data3.map((row) => row.name)).toEqual(["Pub 2"]);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    // Across all three pages: exactly the five published events, no skips/repeats.
    const allNames = [...data1, ...data2, ...data3].map((row) => row.name as string);
    expect(allNames).toEqual(["Pub 10", "Pub 8", "Pub 6", "Pub 4", "Pub 2"]);
    expect(new Set(allNames).size).toBe(5);
  });
});

describe("GET /api/v1/events/{eventId} — event detail", () => {
  it("I2: a co-organizer can GET the shared event but not another tenant's event (404)", async () => {
    const ownerA = await seedOwner("op116-coorg-a");
    const tenantA = ownerA.tenantId.toHexString();
    const eventA = await seedEvent(tenantA, { name: "Shared Event" });

    // A second tenant's event the co-organizer has no relationship to.
    const ownerB = await seedOwner("op116-coorg-b");
    const tenantB = ownerB.tenantId.toHexString();
    const eventB = await seedEvent(tenantB, { name: "Other Tenant Event" });

    // The co-organizer: signed in but NOT a tenant member of tenant A.
    const coOrg = await app.signIn(makeIdentity("op116-coorg-member"));
    await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
      tenantId: tenantA,
      eventId: eventA,
      userId: coOrg.userId.toHexString(),
      role: "co_organizer",
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    });

    // The co-organizer reads the shared event.
    const sharedResponse = await getEventDetail(detailRequest(coOrg.cookie, eventA.toHexString()));
    expect(sharedResponse.status).toBe(200);
    const sharedPayload = await body(sharedResponse);
    expect(sharedPayload.id).toBe(eventA.toHexString());
    expect(sharedPayload.name).toBe("Shared Event");

    // The co-organizer cannot read another tenant's event.
    const otherResponse = await getEventDetail(detailRequest(coOrg.cookie, eventB.toHexString()));
    expect(otherResponse.status).toBe(404);
  });

  it("I3: another tenant's eventId under my tenant path answers 404", async () => {
    const ownerA = await seedOwner("op116-cross-a");
    const tenantA = ownerA.tenantId.toHexString();
    await seedEvent(tenantA, { name: "My Event" });

    const ownerB = await seedOwner("op116-cross-b");
    const tenantB = ownerB.tenantId.toHexString();
    const foreignEventId = await seedEvent(tenantB, { name: "Foreign Event" });

    // Owner A addresses owner B's event under A's own tenant path.
    const response = await getTenantEvent(
      tenantDetailRequest(ownerA.user.cookie, tenantA, foreignEventId.toHexString())
    );
    expect(response.status).toBe(404);
  });

  it("I4: the detail GET carries an ETag that changes after an update", async () => {
    const owner = await seedOwner("op116-etag");
    const tenantKey = owner.tenantId.toHexString();
    const eventId = await seedEvent(tenantKey, { name: "Etag Event" });
    const id = eventId.toHexString();

    const firstResponse = await getEventDetail(detailRequest(owner.user.cookie, id));
    expect(firstResponse.status).toBe(200);
    const etag1 = firstResponse.headers.get("etag");
    expect(etag1).toMatch(/^"[^"]+"$/);

    // A later write bumps the row's updatedAt; the ETag must change with it.
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne(
        { _id: eventId },
        { $set: { updatedAt: new Date(Date.now() + 60_000), name: "Etag Event v2" } }
      );

    const secondResponse = await getEventDetail(detailRequest(owner.user.cookie, id));
    expect(secondResponse.status).toBe(200);
    const etag2 = secondResponse.headers.get("etag");
    expect(etag2).toMatch(/^"[^"]+"$/);
    expect(etag2).not.toBe(etag1);
  });
});
