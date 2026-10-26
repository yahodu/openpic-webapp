import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as eventArchiveRoute from "@/app/api/v1/events/[eventId]/archive/route";
import * as eventRoute from "@/app/api/v1/events/[eventId]/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { eventETag } from "@/server/http/etag";
import type { Entitlement } from "@/server/plans/plans";

import { makeEntitlement, makePlan } from "../factories/plan";
import { makeSubscription } from "../factories/entitlements";
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
 * Integration / contract — update, archive and delete an event (OP-117
 * I1–I8, contract §4.1, schema §15.1/§15.2/§18.3, ADR-0580).
 *
 * The organizer edits their event safely (If-Match guarded, date edits
 * recompute both windows and re-validate the plan's duration), archives it
 * (organizer only), or deletes it deliberately (exact `confirmName`, the only
 * content-destroying path): `202 {status, purgeScheduledAt, irreversible}`
 * with the ordered-purge domain event enqueued for the OP-132 purge job.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/events/[eventId]/route` (the OP-116 global detail file)
 *   additionally exports `PATCH` and `DELETE` (`route:
 *   "/api/v1/events/:eventId"`).
 *   - **PATCH** — `userAuth` + If-Match enforced (missing → `428
 *     precondition_required`, stale → `412 etag_mismatch` with
 *     `details.currentETag`); editable fields per §4.1 (anything else →
 *     `422 forbidden_field` with `details.fields`); `startAt`/`endAt` changes
 *     recompute `uploadWindowEndsAt`/`retentionExpiresAt` and re-validate
 *     the `events.duration_days` entitlement; a `startAt` change once
 *     `now >= startAt` → `409 event_already_started`; a `status`
 *     `deleting` row → `409 event_deleting`; `200` with the full Event DTO
 *     and the **new** quoted `ETag`, and emits `event.details.updated`.
 *     Access: an `event_organizers` row with role `organizer` **or**
 *     `co_organizer` (the global path so a co-organizer who is not a tenant
 *     member can write, mirroring the OP-116 detail admission).
 *   - **DELETE** — `userAuth`, role `organizer`; body `{ confirmName }`
 *     exact-name match else `422 confirmation_mismatch`; store
 *     `status: "deleting"` + `deletedAt`, emit the purge domain event
 *     (`event.purge.scheduled`, consumed by the OP-132 purge job) and the
 *     user-facing `event.deleted`; `202 { status: "deleting",
 *     purgeScheduledAt, irreversible: true }`. A later write answers
 *     `409 event_deleting` carrying `details.purgeScheduledAt`.
 * - `@/app/api/v1/events/[eventId]/archive/route` exports `POST` (`route:
 *   "/api/v1/events/:eventId/archive"`) — role `organizer` only (`403
 *   forbidden` for a co-organizer), `200` + emits `event.archived`.
 * - New error codes owed: `event_deleting` and `event_already_started`
 *   (both `409`) in the established append-only error-catalogue shape.
 * - The purge event key `event.purge.scheduled` must be registered with the
 *   outbox gate (an analytics-only/queue key; the row is asserted after the
 *   `202`, so the emit is synchronous — the OP-115 in-transaction shape).
 *
 * ## Assumptions (ADR-0580 §Assumptions)
 *
 * - All route handlers are invoked directly; the path segment is read off
 *   `request.url` (the pipeline exposes only the request, never Next
 *   `params`).
 * - **I3b** (the organizer archive happy path) is an added counterpart of
 *   the card's I3 — the GREEN scope §2 ("POST /archive (organizer) -> emit
 *   event.archived") is the lane's own authority for it.
 * - The **co-organizer** is a signed-in user with an `event_organizers`
 *   row (`role: "co_organizer"`) who is **not** a tenant member — the same
 *   fixture the OP-116 lane used.
 * - The `412`/`428` refusals come from the `defineRoute` ETag stage with
 *   `required: true` (only PATCH is pinned; DELETE may enforce it too — the
 *   spec sends an `If-Match` on every delete either way).
 */

type TenantKey = string;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op117-events" });
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
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    COLLECTIONS.idempotencyKeys,
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** Read a route export off a route namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: "GET" | "POST" | "PATCH" | "DELETE",
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const patchEvent = requireHandler(eventRoute, "PATCH", "/api/v1/events/:eventId");
const deleteEvent = requireHandler(eventRoute, "DELETE", "/api/v1/events/:eventId");
const archiveEvent = requireHandler(eventArchiveRoute, "POST", "/api/v1/events/:eventId/archive");

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
    slug: `op117-${prefix}`,
    name: "OP117 Studio",
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

/** The OP-117 starter-plan entitlements (contract §3.1 worked values). */
function starterEntitlements(): Record<string, Entitlement> {
  return {
    "events.active": makeEntitlement({
      limit: 7,
      resetPeriod: "monthly",
      scope: "tenant",
      enforcement: "hard",
    }),
    "events.duration_days": makeEntitlement({
      limit: 7,
      resetPeriod: "none",
      scope: "event",
      enforcement: "hard",
    }),
    "events.post_upload_days": makeEntitlement({
      limit: 7,
      resetPeriod: "none",
      scope: "event",
      enforcement: "hard",
    }),
    "gallery.retention_days": makeEntitlement({
      limit: 90,
      resetPeriod: "none",
      scope: "event",
      enforcement: "policy",
    }),
  };
}

/** Insert a plan row (platform scope). */
async function seedPlan(key: string, entitlements: Record<string, Entitlement>): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key, entitlements }));
}

/** Insert the live subscription that makes `planKey` the tenant's active plan. */
async function seedSubscription(tenantKey: TenantKey, planKey: string): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: planKey,
      activePlanKey: planKey,
      status: "active",
    })
  );
}

/** The starter plan + live subscription, the common happy-path base. */
async function seedStarterWorkspace(tenantKey: TenantKey): Promise<void> {
  await seedPlan("op117-starter", starterEntitlements());
  await seedSubscription(tenantKey, "op117-starter");
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let seededSlugSeq = 0;

/**
 * Insert a stored `events` row plus the single organizer `event_organizers`
 * row (schema §15.1/§15.2), overriding any stored field.
 */
async function seedOwnedEvent(
  tenantKey: TenantKey,
  ownerUserId: SignedInUser["userId"],
  overrides: Record<string, unknown> = {}
): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  const slug = `op${String(seededSlugSeq).padStart(6, "0")}`;
  seededSlugSeq += 1;
  const defaults = {
    tenantId: tenantKey,
    name: "Rahul & Priya's Wedding",
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
    createdByUserId: ownerUserId.toHexString(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await app.db.collection(COLLECTIONS.events).insertOne({ _id, ...defaults, ...overrides });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: ownerUserId.toHexString(),
    role: "organizer",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  return _id;
}

/** Record an `event_organizers` row for an additional user (the co-organizer). */
async function seedCoOrganizer(
  tenantKey: TenantKey,
  eventId: ObjectId,
  user: SignedInUser
): Promise<void> {
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId,
    userId: user.userId.toHexString(),
    role: "co_organizer",
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: 1,
  });
}

/** The event's current quoted ETag (`eventETag(updatedAt, schemaVersion)`). */
async function currentETagOf(eventId: ObjectId): Promise<string> {
  const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
  if (row === null) {
    throw new Error("expected the event row to exist");
  }
  const updatedAt = row.updatedAt;
  const schemaVersion = row.schemaVersion;
  return eventETag(
    updatedAt instanceof Date ? updatedAt : new Date(),
    typeof schemaVersion === "number" ? schemaVersion : 1
  );
}

/** An ISO instant `days` after the given ISO instant, in UTC. */
function isoPlusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/** A `PATCH /events/{eventId}` request carrying the session cookie. */
function patchRequest(
  cookie: string,
  eventId: string,
  payload: Record<string, unknown>,
  ifMatch?: string
): Request {
  return new Request(new URL(`/api/v1/events/${eventId}`, APP_ORIGIN), {
    method: "PATCH",
    headers: {
      cookie,
      "content-type": "application/json",
      ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
    },
    body: JSON.stringify(payload),
  });
}

/** A `POST /events/{eventId}/archive` request carrying the session cookie. */
function archiveRequest(cookie: string, eventId: string): Request {
  return new Request(new URL(`/api/v1/events/${eventId}/archive`, APP_ORIGIN), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
}

/** A `DELETE /events/{eventId}` request carrying the session cookie. */
function deleteRequest(
  cookie: string,
  eventId: string,
  confirmName: string,
  ifMatch?: string
): Request {
  return new Request(new URL(`/api/v1/events/${eventId}`, APP_ORIGIN), {
    method: "DELETE",
    headers: {
      cookie,
      "content-type": "application/json",
      ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
    },
    body: JSON.stringify({ confirmName }),
  });
}

describe("PATCH /api/v1/events/{eventId} — update an event (contract §4.1, §0.10)", () => {
  it("I1: rejects a PATCH without If-Match with 428 precondition_required and writes nothing", async () => {
    const { user, tenantId } = await seedOwner("op117-noetag");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);

    const response = await patchEvent(
      patchRequest(user.cookie, eventId.toHexString(), { description: "Nope" })
    );

    expect(response.status).toBe(428);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("precondition_required");
    expect(parsed.error.details).toMatchObject({ header: "If-Match" });

    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    // The seeded description ("") is untouched — the refusal happens before
    // any write.
    expect(row?.description).toBe("");
  });

  it("I1: rejects a stale If-Match with 412 etag_mismatch carrying the currentETag", async () => {
    const { user, tenantId } = await seedOwner("op117-stale");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const currentETag = await currentETagOf(eventId);

    const response = await patchEvent(
      patchRequest(user.cookie, eventId.toHexString(), { description: "Nope" }, '"stale-tag"')
    );

    expect(response.status).toBe(412);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("etag_mismatch");
    expect(parsed.error.details?.currentETag).toBe(currentETag);
  });

  it("I2: moving endAt returns both recomputed windows in the response and stores them", async () => {
    const { user, tenantId } = await seedOwner("op117-move-end");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();
    const etagBefore = await currentETagOf(eventId);

    const newEndAt = fixtureInstant("12:00:00.000Z", 12);
    const response = await patchEvent(
      patchRequest(user.cookie, id, { endAt: newEndAt }, etagBefore)
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    // The moved end instant with both windows recomputed from the plan
    // entitlements (post_upload_days 7, retention_days 90).
    expect(payload.endAt).toBe(newEndAt);
    expect(payload.uploadWindowEndsAt).toBe(isoPlusDays(newEndAt, 7));
    expect(payload.retentionExpiresAt).toBe(isoPlusDays(newEndAt, 90));
    // The start instant is untouched by an endAt-only edit.
    expect(payload.startAt).toBe(fixtureInstant("10:00:00.000Z", 10));

    // The stored row agrees with the wire.
    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    if (row === null) {
      throw new Error("expected the event row to exist after the PATCH");
    }
    expect((row.endAt as Date).toISOString()).toBe(newEndAt);
    expect((row.uploadWindowEndsAt as Date).toISOString()).toBe(isoPlusDays(newEndAt, 7));
    expect((row.retentionExpiresAt as Date).toISOString()).toBe(isoPlusDays(newEndAt, 90));

    // The conditional-write loop: the response carries the NEW ETag, derived
    // from the stored row's updatedAt, not the pre-write value.
    const etagAfter = response.headers.get("etag");
    expect(etagAfter).toMatch(/^"[^"]+"$/);
    expect(etagAfter).not.toBe(etagBefore);
    expect(etagAfter).toBe(
      eventETag(
        row.updatedAt instanceof Date ? row.updatedAt : new Date(),
        typeof row.schemaVersion === "number" ? row.schemaVersion : 1
      )
    );

    // The edit is announced (contract §4.1: emits event.details.updated; the
    // API does not coalesce — the notification resolver does).
    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.details.updated", tenantId: tenantKey });
    expect(emitted).not.toBeNull();
    if (emitted === null) {
      throw new Error("expected the event.details.updated domain event to be emitted");
    }
    expect(emitted).toMatchObject({
      eventKey: "event.details.updated",
      actorRef: { kind: "user", id: user.userId.toHexString() },
      subjectRef: { kind: "event", id },
    });
  });

  it("I6: a co-organizer can PATCH the description", async () => {
    const owner = await seedOwner("op117-coowner");
    const tenantKey = owner.tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = eventId.toHexString();

    // The co-organizer is signed in but NOT a tenant member of the tenant.
    const coOrg = await app.signIn(makeIdentity("op117-coorg-patch"));
    await seedCoOrganizer(tenantKey, eventId, coOrg);

    const etag = await currentETagOf(eventId);
    const response = await patchEvent(
      patchRequest(coOrg.cookie, id, { description: "Reception photos — updated" }, etag)
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.description).toBe("Reception photos — updated");

    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect(row?.description).toBe("Reception photos — updated");
  });

  it("I7: PATCHing startAt after the event has started answers 409 event_already_started", async () => {
    const { user, tenantId } = await seedOwner("op117-started");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    // The event started two calendar days ago (10:00 UTC) and is still
    // running (endAt four days out) — every date check passes, only the
    // start-lock can refuse the edit.
    const eventId = await seedOwnedEvent(tenantKey, user.userId, {
      startAt: new Date(fixtureInstant("10:00:00.000Z", -2)),
      endAt: new Date(fixtureInstant("12:00:00.000Z", 4)),
    });
    const id = eventId.toHexString();
    const etag = await currentETagOf(eventId);

    const response = await patchEvent(
      patchRequest(user.cookie, id, { startAt: fixtureInstant("10:00:00.000Z", 1) }, etag)
    );

    expect(response.status).toBe(409);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("event_already_started");

    // Nothing moved: the stored start instant is the seeded past one.
    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect((row?.startAt as Date).toISOString()).toBe(fixtureInstant("10:00:00.000Z", -2));
  });

  it("I8: moving endAt beyond the plan's duration answers 403 with requestedDays", async () => {
    const { user, tenantId } = await seedOwner("op117-duration");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();
    const etag = await currentETagOf(eventId);

    // startAt day+10 10:00Z → day+20 10:00Z is exactly 10 whole days, past
    // the starter plan's events.duration_days of 7.
    const tooFarEnd = fixtureInstant("10:00:00.000Z", 20);
    const response = await patchEvent(patchRequest(user.cookie, id, { endAt: tooFarEnd }, etag));

    expect(response.status).toBe(403);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("plan_limit_exceeded");
    expect(parsed.error.details).toMatchObject({
      entitlementKey: "events.duration_days",
      requestedDays: 10,
    });

    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect((row?.endAt as Date).toISOString()).toBe(fixtureInstant("12:00:00.000Z", 10));
  });

  it("U2: a PATCH carrying a field outside the editable whitelist answers 422 forbidden_field", async () => {
    const { user, tenantId } = await seedOwner("op117-forbidden");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();
    const etag = await currentETagOf(eventId);

    const response = await patchEvent(
      patchRequest(user.cookie, id, { name: "Wedding v2", createdByUserId: "hacked" }, etag)
    );

    expect(response.status).toBe(422);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("forbidden_field");
    expect(parsed.error.details).toMatchObject({ fields: ["createdByUserId"] });
  });
});

describe("POST /api/v1/events/{eventId}/archive — archive an event (contract §4.1)", () => {
  it("I3: a co-organizer archiving answers 403 and nothing is emitted", async () => {
    const owner = await seedOwner("op117-archiver-co");
    const tenantKey = owner.tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, owner.user.userId);
    const id = eventId.toHexString();

    const coOrg = await app.signIn(makeIdentity("op117-archiver-cob"));
    await seedCoOrganizer(tenantKey, eventId, coOrg);

    const response = await archiveEvent(archiveRequest(coOrg.cookie, id));

    expect(response.status).toBe(403);
    const parsed = (await body(response)) as { error: { code: string } };
    expect(parsed.error.code).toBe("forbidden");

    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.archived", tenantId: tenantKey });
    expect(emitted).toBeNull();
  });

  it("I3b: the organizer archiving answers 200 and emits event.archived", async () => {
    const { user, tenantId } = await seedOwner("op117-archiver-ok");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();

    const response = await archiveEvent(archiveRequest(user.cookie, id));

    expect(response.status).toBe(200);
    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.archived", tenantId: tenantKey });
    expect(emitted).not.toBeNull();
    if (emitted === null) {
      throw new Error("expected the event.archived domain event to be emitted");
    }
    expect(emitted).toMatchObject({
      eventKey: "event.archived",
      actorRef: { kind: "user", id: user.userId.toHexString() },
      subjectRef: { kind: "event", id },
    });
  });
});

describe("DELETE /api/v1/events/{eventId} — delete an event (contract §4.1, §22)", () => {
  it("I4: deleting with a wrong confirmName answers 422 confirmation_mismatch and changes nothing", async () => {
    const { user, tenantId } = await seedOwner("op117-wrong-name");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();
    const etag = await currentETagOf(eventId);

    const response = await deleteEvent(deleteRequest(user.cookie, id, "Not the event name", etag));

    expect(response.status).toBe(422);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("confirmation_mismatch");
    expect(parsed.error.details).toMatchObject({ field: "confirmName" });

    // The row is untouched and nothing was announced.
    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect(row?.status).toBe("published");
    expect(row?.deletedAt).toBeUndefined();
    expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(0);
  });

  it("I5: deleting with the exact confirmName answers 202, stores status deleting and enqueues the purge domain event", async () => {
    const { user, tenantId } = await seedOwner("op117-delete-ok");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();
    const etag = await currentETagOf(eventId);

    const response = await deleteEvent(
      deleteRequest(user.cookie, id, "Rahul & Priya's Wedding", etag)
    );

    expect(response.status).toBe(202);
    const payload = await body(response);
    expect(Object.keys(payload).sort()).toEqual(["irreversible", "purgeScheduledAt", "status"]);
    expect(payload.status).toBe("deleting");
    expect(payload.irreversible).toBe(true);
    const purgeScheduledAt = payload.purgeScheduledAt as string;
    expect(typeof purgeScheduledAt).toBe("string");
    expect(new Date(purgeScheduledAt).toISOString()).toBe(purgeScheduledAt);

    // The stored row flips to deleting with a deletedAt stamp.
    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    if (row === null) {
      throw new Error("expected the event row to exist after the delete");
    }
    expect(row.status).toBe("deleting");
    expect(row.deletedAt).toBeInstanceOf(Date);

    // The ordered purge is enqueued as a domain event for the OP-132 job,
    // carrying the same scheduled instant the 202 announced.
    const purgeEvent = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.purge.scheduled", tenantId: tenantKey });
    expect(purgeEvent).not.toBeNull();
    if (purgeEvent === null) {
      throw new Error("expected the event.purge.scheduled domain event to be emitted");
    }
    expect(purgeEvent).toMatchObject({
      eventKey: "event.purge.scheduled",
      actorRef: { kind: "user", id: user.userId.toHexString() },
      subjectRef: { kind: "event", id },
    });
    const purgePayload = purgeEvent.payload as Record<string, unknown>;
    expect(purgePayload.eventId).toBe(id);
    expect(purgePayload.purgeScheduledAt).toBe(purgeScheduledAt);

    // The user-facing deletion announcement (contract §4.1: emits
    // event.deleted, in-app + email + mobile).
    const deletedEvent = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.deleted", tenantId: tenantKey });
    expect(deletedEvent).not.toBeNull();
  });

  it("I5b: a later PATCH answers 409 event_deleting carrying the purgeScheduledAt", async () => {
    const { user, tenantId } = await seedOwner("op117-delete-409");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);
    const eventId = await seedOwnedEvent(tenantKey, user.userId);
    const id = eventId.toHexString();

    const deleteResponse = await deleteEvent(
      deleteRequest(user.cookie, id, "Rahul & Priya's Wedding", await currentETagOf(eventId))
    );
    expect(deleteResponse.status).toBe(202);
    const deletePayload = await body(deleteResponse);
    const purgeScheduledAt = deletePayload.purgeScheduledAt as string;

    // The conditional write against the CURRENT (post-delete) ETag reaches
    // the handler, which refuses any edit to a deleting event.
    const response = await patchEvent(
      patchRequest(user.cookie, id, { description: "Too late" }, await currentETagOf(eventId))
    );

    expect(response.status).toBe(409);
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("event_deleting");
    expect(parsed.error.details?.purgeScheduledAt).toBe(purgeScheduledAt);
  });
});
