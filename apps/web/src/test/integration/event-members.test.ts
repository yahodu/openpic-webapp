import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import { GET as listEventMembers } from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/members/route";
import { COLLECTIONS } from "@/server/db/collections";

import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the event member list (OP-119 I3, contract §4.3,
 * schema §15.2).
 *
 * The user story: *as an organizer I see who works on my event, so I can
 * attribute the uploads.* The listing answers, per member, a display name, a
 * §0.13 **masked** contact, the event role, the lifecycle status, when they
 * joined and how many images they uploaded — never another user's raw email
 * (§0.15), which is the scanner assertion `I3` names.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/members/route` exports
 *   `GET`, declared with
 *   `defineRoute({ route: "/api/v1/tenants/:tenantId/events/:eventId/members", … })`
 *   and `auth: userAuth()`.
 * - Body (§4.3): `{ data: EventMember[] }` where
 *   `EventMember = { userId, displayName, role, status, emailMasked, addedAt,
 *   uploadedImageCount }` (`invitationId` appears on a co-organizer row and is
 *   deliberately **not** pinned — see A12).
 * - `role` is the stored `event_organizers.role` (`organizer` |
 *   `co_organizer`); `status` is `active` | `removed`; `addedAt` is an RFC 3339
 *   `Z` instant; `emailMasked` is `@openpic/contracts` `maskEmail` of the Better
 *   Auth `user.email`; `displayName` is `userProfiles.displayName`.
 * - `uploadedImageCount` is the **cached counter** the GREEN card chooses over a
 *   request-time aggregation, stored on the member row as
 *   `event_organizers.uploadedImageCount` (this spec seeds that field; the
 *   `$inc` on upload-complete is out of scope, A13).
 * - Admission is "`user` + event member" (§4.3): an `event_organizers` row with
 *   role `organizer` **or** `co_organizer` (`revokedAt: null`) is enough, even
 *   for a co-organizer who is **not** a tenant member — the `resolveEventActorRole`
 *   admission OP-117 established (`@/server/events/access`). A caller with no
 *   relationship to the event is `404 not_found` (never `403`, §0.4), a
 *   non-member of the workspace addressed in the path is the same `404`, and a
 *   request without a session is `401 authentication_required`.
 * - The tenant segment is echoed as `X-Tenant-Id` (§0.4).
 *
 * ## Assumptions (ADR-0640 §Assumptions)
 *
 * - A10 — the list is the event's **workers** only: a tenant member with no
 *   `event_organizers` row is not listed (the story is attribution of the
 *   people who upload), even though such a member is admitted to *read* the
 *   list. Both halves are pinned below.
 * - A11 — `addedAt` is the member row's join instant; the spec only pins that
 *   it is an ISO `Z` instant, not which stored field it comes from.
 * - A12 — the optional `invitationId` of a co-organizer row is not pinned, so
 *   the GREEN may include it or omit it.
 * - A13 — a `removed` member is not pinned: §4.3 carries a `status` field but
 *   does not say whether a removed row is served, so either behaviour passes.
 */

/** The list route the spec drives. */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op119-members" });
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** Overwrite a caller's auto-provisioned `userProfiles` row. */
async function setDisplayName(userId: ObjectId, displayName: string): Promise<void> {
  const result = await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne({ userId }, { $set: { displayName, updatedAt: new Date() } });
  expect(result.matchedCount).toBe(1);
}

/** Insert a tenant (schema §13.3) and return its id. */
async function insertTenant(slug: string, ownerUserId: ObjectId): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP119 Studio",
    status: "active",
    ownerUserId,
    billingContactUserId: ownerUserId,
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
  return _id;
}

/** Insert an active `tenantMembers` row (schema §13.4). */
async function addTenantMember(
  tenantId: ObjectId,
  user: SignedInUser,
  role: "owner" | "admin" | "member"
): Promise<void> {
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: user.userId,
    role,
    status: "active",
    joinedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

/** Insert a stored `events` row (schema §15.1) and return its id. */
async function seedEvent(tenantKey: string): Promise<ObjectId> {
  const _id = new ObjectId();
  const slug = `op${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "Rahul & Priya's Wedding",
    description: "",
    status: "published",
    startAt: new Date("2026-09-20T10:00:00.000Z"),
    endAt: new Date("2026-09-25T12:00:00.000Z"),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date("2026-09-30T12:00:00.000Z"),
    retentionExpiresAt: new Date("2026-12-24T12:00:00.000Z"),
    accessLinks: [{ slug, active: true, createdAt: new Date(), revokedAt: null }],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    createdByUserId: new ObjectId().toHexString(),
    schemaVersion: 1,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  return _id;
}

/** Insert an `event_organizers` row (schema §15.2) with a cached upload count. */
async function addEventMember(
  tenantKey: string,
  eventId: ObjectId,
  user: SignedInUser,
  role: "organizer" | "co_organizer",
  uploadedImageCount: number
): Promise<void> {
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId,
    userId: user.userId.toHexString(),
    role,
    status: "active",
    revokedAt: null,
    uploadedImageCount,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    schemaVersion: 1,
  });
}

/** A `GET /tenants/{tenant}/events/{event}/members` request. */
function membersRequest(cookie: string, tenantSegment: string, eventId: string): Request {
  return new Request(
    new URL(`/api/v1/tenants/${tenantSegment}/events/${eventId}/members`, APP_ORIGIN),
    { method: "GET", headers: { cookie } }
  );
}

/** An unauthenticated `GET …/members` request. */
function anonymousMembersRequest(tenantSegment: string, eventId: string): Request {
  return new Request(
    new URL(`/api/v1/tenants/${tenantSegment}/events/${eventId}/members`, APP_ORIGIN),
    { method: "GET" }
  );
}

/** The error envelope of a failed response. */
async function errorEnvelope(response: Response): Promise<{ code: string }> {
  const parsed = await body(response);
  return parsed.error as { code: string };
}

/** A workspace with an organizer, an event, and a co-organizer who is not a tenant member. */
interface MembersFixture {
  readonly tenantId: ObjectId;
  readonly eventId: ObjectId;
  readonly organizer: SignedInUser;
  readonly coOrganizer: SignedInUser;
}

/**
 * Seed the two-worker event the listing spec asserts.
 *
 * @returns The ids and the two signed-in callers.
 */
async function seedTwoWorkerEvent(): Promise<MembersFixture> {
  const organizer = await app.signIn(makeIdentity("rahul-owner"));
  const coOrganizer = await app.signIn(makeIdentity("buck-coorg"));
  const tenantId = await insertTenant("op119-members", organizer.userId);
  await addTenantMember(tenantId, organizer, "owner");
  await setDisplayName(organizer.userId, "Rahul Menon");
  await setDisplayName(coOrganizer.userId, "Buck Sharma");
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey);
  await addEventMember(tenantKey, eventId, organizer, "organizer", 3200);
  await addEventMember(tenantKey, eventId, coOrganizer, "co_organizer", 920);
  return { tenantId, eventId, organizer, coOrganizer };
}

describe("GET /api/v1/tenants/{tenantId}/events/{eventId}/members — the list (I3)", () => {
  it("I3: lists both workers with masked emails, their role and their upload count", async () => {
    const fixture = await seedTwoWorkerEvent();

    const response = await listEventMembers(
      membersRequest(
        fixture.organizer.cookie,
        fixture.tenantId.toHexString(),
        fixture.eventId.toHexString()
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tenant-id")).toBe(fixture.tenantId.toHexString());

    const payload = await body(response);
    const entries = payload.data as Record<string, unknown>[];
    expect(entries).toHaveLength(2);

    const organizerEntry = entries.find(
      (entry) => entry.userId === fixture.organizer.userId.toHexString()
    );
    expect(organizerEntry).toMatchObject({
      displayName: "Rahul Menon",
      role: "organizer",
      status: "active",
      emailMasked: "r•••@example.com",
      uploadedImageCount: 3200,
    });
    expect(new Date(organizerEntry?.addedAt as string).toISOString()).toBe(organizerEntry?.addedAt);

    const coOrganizerEntry = entries.find(
      (entry) => entry.userId === fixture.coOrganizer.userId.toHexString()
    );
    expect(coOrganizerEntry).toMatchObject({
      displayName: "Buck Sharma",
      role: "co_organizer",
      status: "active",
      emailMasked: "b•••@example.com",
      uploadedImageCount: 920,
    });
  });

  it("I3: never leaks a raw contact — the §0.15 scanner finds nothing", async () => {
    const fixture = await seedTwoWorkerEvent();

    const response = await listEventMembers(
      membersRequest(
        fixture.organizer.cookie,
        fixture.tenantId.toHexString(),
        fixture.eventId.toHexString()
      )
    );

    expect(response.status).toBe(200);
    const payload = await body(response);

    expect(findForbiddenFields(payload, "default")).toEqual([]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(fixture.organizer.identity.email);
    expect(serialized).not.toContain(fixture.coOrganizer.identity.email);
    // The mask hides the local part, so even its prefix-plus-local form is gone.
    expect(serialized).not.toContain("buck-coorg");
  });

  it("I3: lists only the event's workers, not every member of the workspace", async () => {
    const fixture = await seedTwoWorkerEvent();
    const bystander = await app.signIn(makeIdentity("bystander-admin"));
    await addTenantMember(fixture.tenantId, bystander, "admin");
    await setDisplayName(bystander.userId, "Bystander Admin");

    const response = await listEventMembers(
      membersRequest(
        fixture.organizer.cookie,
        fixture.tenantId.toHexString(),
        fixture.eventId.toHexString()
      )
    );

    expect(response.status).toBe(200);
    const entries = (await body(response)).data as Record<string, unknown>[];
    expect(entries.map((entry) => entry.userId).sort()).toEqual(
      [fixture.organizer.userId.toHexString(), fixture.coOrganizer.userId.toHexString()].sort()
    );
  });
});

describe("GET /api/v1/tenants/{tenantId}/events/{eventId}/members — admission", () => {
  it("admits a co-organizer who is not a tenant member", async () => {
    const fixture = await seedTwoWorkerEvent();

    const response = await listEventMembers(
      membersRequest(
        fixture.coOrganizer.cookie,
        fixture.tenantId.toHexString(),
        fixture.eventId.toHexString()
      )
    );

    expect(response.status).toBe(200);
    const entries = (await body(response)).data as Record<string, unknown>[];
    expect(entries).toHaveLength(2);
  });

  it("answers 404 (never 403) to a caller with no relationship to the event", async () => {
    const fixture = await seedTwoWorkerEvent();
    const stranger = await app.signIn(makeIdentity("nosy-stranger"));

    const response = await listEventMembers(
      membersRequest(stranger.cookie, fixture.tenantId.toHexString(), fixture.eventId.toHexString())
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 404 when the event belongs to another workspace", async () => {
    const foreignOrganizer = await app.signIn(makeIdentity("foreign-owner"));
    const foreignTenantId = await insertTenant("op119-foreign", foreignOrganizer.userId);
    await addTenantMember(foreignTenantId, foreignOrganizer, "owner");
    const foreignEventId = await seedEvent(foreignTenantId.toHexString());
    await addEventMember(
      foreignTenantId.toHexString(),
      foreignEventId,
      foreignOrganizer,
      "organizer",
      15
    );

    const caller = await app.signIn(makeIdentity("caller-owner"));
    const callerTenantId = await insertTenant("op119-caller", caller.userId);
    await addTenantMember(callerTenantId, caller, "owner");

    const response = await listEventMembers(
      membersRequest(caller.cookie, callerTenantId.toHexString(), foreignEventId.toHexString())
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 404 for an event id that does not exist", async () => {
    const fixture = await seedTwoWorkerEvent();

    const response = await listEventMembers(
      membersRequest(
        fixture.organizer.cookie,
        fixture.tenantId.toHexString(),
        new ObjectId().toHexString()
      )
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });

  it("answers 401 without a session", async () => {
    const fixture = await seedTwoWorkerEvent();

    const response = await listEventMembers(
      anonymousMembersRequest(fixture.tenantId.toHexString(), fixture.eventId.toHexString())
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });
});
