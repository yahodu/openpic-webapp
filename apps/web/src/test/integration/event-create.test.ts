import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createEvent } from "@/app/api/v1/tenants/[tenantId]/events/route";
import { POST as validateEvent } from "@/app/api/v1/tenants/[tenantId]/events:validate/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { Entitlement } from "@/server/plans/plans";

import { makeEntitlement, makePlan } from "../factories/plan";
import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureDay } from "../helpers/fixture-clock";

/**
 * Integration / contract — create an event with materialised windows
 * (OP-115 I1–I13, contract §4.1, schema §15.1/§15.2/§14.2, ADR-0520).
 *
 * The journey: an organizer (owner|admin|member of the tenant) POSTs
 * `/tenants/{t}/events` with dates and a timezone and gets back the full Event
 * DTO, a `Location` and an `ETag`, while one transaction writes the event row
 * (windows materialised), the single organizer `event_organizers` row and the
 * `events.active` usage counter together.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/events/route` exports `POST` declared
 *   `defineRoute({ route: "/api/v1/tenants/:tenantId/events", … })` with the
 *   reusable tenant stage, `userAuth()` and a **required** idempotency stage.
 *   `201` via `created(body, location)` with the full Event DTO plus an
 *   `ETag` header; `403 plan_limit_exceeded` / `402 payment_required` from
 *   `consumeEntitlement`; `422 invalid_date_range` for `endAt <= startAt`;
 *   `422 validation_failed` for a >2000-char description and for a
 *   `logoAssetId` that is not an `event_logo` branding asset **of this
 *   tenant**; the description is stored **plain text** (tags stripped; tilted
 *   content text remains, inert — I9).
 * - `@/app/api/v1/tenants/[tenantId]/events:validate/route` exports `POST`
 *   (same auth + tenant stage, no idempotency) that validates a **partial**
 *   body and consumes nothing; `200 { checks: [{ field, ok, code, limit,
 *   upgradePath }] }`.
 * - `@/server/events/windows`, `@/server/events/slug` and
 *   `@/server/events/dates` hold the pure units (U1–U4).
 * - The event row is written to `events` with embedded `accessLinks`, the
 *   organizer row to `event_organizers` (both tenant-scoped, so `tenantId` is
 *   the string hex), and the counter to `usageCounters` — the
 *   `events.active`/`events.duration_days`/`events.post_upload_days` /
 *   `gallery.retention_days` entitlement keys come from the seeded `plans`
 *   catalogue. An `event.created` domain event is emitted.
 * - New contract codes owed: `invalid_date_range` (422, details
 *   `{ startAt, endAt }`) and `start_too_far_past` (422) in the
 *   `cannot_demote_owner` append-only shape — only `invalid_date_range` is
 *   pinned below.
 *
 * ## Assumptions (ADR-0520 §Assumptions)
 *
 * - The **duration denial** is `403 plan_limit_exceeded` with
 *   `details.entitlementKey === "events.duration_days"` and the Appendix A.4
 *   `requestedDays` field (the shipped `denialError` does not carry it, so
 *   the route must add it).
 * - The **null-post-upload denial** (I12) is `403 plan_limit_exceeded` naming
 *   `events.post_upload_days`; the card only fixes the status.
 * - The **logo refusal** is the standard field error shape
 *   (`422 validation_failed`, `details.fields[].path === "logoAssetId"`).
 * - The validate endpoint needs **no** idempotency key; the spec sends one
 *   anyway so the request is valid either way.
 */

/** The string tenant id every tenant-scoped fixture carries. */
type TenantKey = string;

/** The plan entitement map a case seeds (`events.*`/`gallery.*` keys). */
type Entitlements = Record<string, Entitlement>;

/** The unambiguous access-link alphabet (ADR-0520, mirrors U3). */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * The hoisted slug-module facade the route's `generateAccessLinkSlug` import
 * resolves to. I5 forces a collision by seeding the first draw; every other
 * case draws the real-shape random slug from {@link SLUG_ALPHABET}.
 */
const slugMock = vi.hoisted(() => ({
  ACCESS_LINK_ALPHABET: "abcdefghjkmnpqrstuvwxyz23456789",
  generateAccessLinkSlug: vi.fn<() => string>(),
}));

vi.mock("@/server/events/slug", () => ({
  ACCESS_LINK_ALPHABET: slugMock.ACCESS_LINK_ALPHABET,
  generateAccessLinkSlug: slugMock.generateAccessLinkSlug,
}));

/** A random 8-char slug from the alphabet, for non-collision cases. */
function randomSlug(): string {
  let slug = "";
  for (let index = 0; index < 8; index += 1) {
    slug += SLUG_ALPHABET.charAt(Math.floor(Math.random() * SLUG_ALPHABET.length));
  }
  return slug;
}

const STARTER = "op115-starter";
const ACTIVE_LIMIT_1 = "op115-active-limit-1";
const PRO_30 = "op115-pro-30d";
const POST7 = "op115-post7";
const UNLIMITED = "op115-unlimited";

/** The `events.active` counter period key (schema §14.2, UTC `YYYY-MM`). */
const MONTH_KEY = new Date().toISOString().slice(0, 7);

/** endAt + post_upload_days (7) / retention (90) — the contract §4.1 example. */
const POST_UPLOAD_DAYS = 7;
const RETENTION_DAYS = 90;

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op115-events" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  // The app boots once for the whole file, so every case must seed against a
  // clean database. The shared collections were the OP-115 D1 defect: fixed
  // plan keys (op115-starter, …) collided on `plans_key_unique` from the second
  // case on (E11000 before the route ran). The OP-103 precedent
  // (entitlements.test.ts) clears plans, subscriptions, counters, grants and
  // the outbox; OP-115 additionally clears `events` / `event_organizers` /
  // `media_assets` so the "persists nothing" cases (I2/I3/I8/I11/I12) assert
  // against a clean state and I5/I8b seed their fixtures fresh.
  await app.db.collection(COLLECTIONS.plans).deleteMany({});
  await app.db.collection(COLLECTIONS.subscriptions).deleteMany({});
  await app.db.collection(COLLECTIONS.usageCounters).deleteMany({});
  await app.db.collection(COLLECTIONS.entitlementGrants).deleteMany({});
  await app.db.collection(COLLECTIONS.domainEvents).deleteMany({});
  await app.db.collection(COLLECTIONS.events).deleteMany({});
  await app.db.collection(COLLECTIONS.eventOrganizers).deleteMany({});
  await app.db.collection(COLLECTIONS.mediaAssets).deleteMany({});
  slugMock.generateAccessLinkSlug.mockReset();
  slugMock.generateAccessLinkSlug.mockImplementation(randomSlug);
});

/** The starter-plan entitlements (contract §3.1 worked values). */
function starterEntitlements(): Entitlements {
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
async function seedPlan(key: string, entitlements: Entitlements): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key, entitlements }));
}

/** Insert the live subscription that makes `planKey` the tenant's active plan. */
async function seedSubscription(
  tenantKey: TenantKey,
  planKey: string,
  status: "active" | "downgraded"
): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: planKey,
      activePlanKey: planKey,
      status,
      ...(status === "downgraded" ? { pendingDueMinor: 49_900, currency: "INR" } : {}),
    })
  );
}

/** The starter plan + live subscription, the common happy-path base. */
async function seedStarterWorkspace(tenantKey: TenantKey): Promise<void> {
  await seedPlan(STARTER, starterEntitlements());
  await seedSubscription(tenantKey, STARTER, "active");
}

/** A complete user (both contacts verified) who owns the workspace. */
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
    slug: `op115-${prefix}`,
    name: "OP115 Studio",
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

/** A `POST /tenants/{t}/events` request carrying the session and an idempotency key. */
function createRequest(
  cookie: string,
  tenantKey: TenantKey,
  payload: Record<string, unknown>,
  idempotencyKey = randomUUID()
): Request {
  return new Request(new URL(`/api/v1/tenants/${tenantKey}/events`, APP_ORIGIN), {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(payload),
  });
}

/** A `POST /tenants/{t}/events:validate` request (partial body, consumes nothing). */
function validateRequest(
  cookie: string,
  tenantKey: TenantKey,
  payload: Record<string, unknown>
): Request {
  return new Request(new URL(`/api/v1/tenants/${tenantKey}/events:validate`, APP_ORIGIN), {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(payload),
  });
}

/** The contract §4.1 body, clock-anchored (startAt with a +05:30 offset). */
function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Rahul & Priya's Wedding",
    description: "",
    startAt: `${fixtureDay(14)}T17:30:00+05:30`,
    endAt: `${fixtureDay(16)}T18:00:00.000Z`,
    displayTimeZone: "Asia/Kolkata",
    logoAssetId: null,
    watermarkAssetId: null,
    publish: true,
    ...overrides,
  };
}

/** An ISO instant `days` after the given ISO instant, in UTC. */
function isoPlusDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

describe("POST /api/v1/tenants/{tenantId}/events", () => {
  it("I1: creates the event with materialised windows, one organizer row and the counter +1 in one transaction", async () => {
    const { user, tenantId } = await seedOwner("op115-happy");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const bodyInput = eventBody();
    const normalizedStartAt = `${fixtureDay(14)}T12:00:00.000Z`;
    const endAt = bodyInput.endAt as string;

    const response = await createEvent(createRequest(user.cookie, tenantKey, bodyInput));

    expect(response.status).toBe(201);
    const payload = await body(response);
    const eventId = payload.id as string;
    expect(eventId).toBeTypeOf("string");
    expect(response.headers.get("location")).toBe(`/api/v1/tenants/${tenantKey}/events/${eventId}`);
    // §4.1: the create response carries an ETag too.
    expect(response.headers.get("etag")).toMatch(/^"[^"]+"$/);

    expect(payload.id).toBe(eventId);
    expect(payload.name).toBe("Rahul & Priya's Wedding");
    expect(payload.status).toBe("published");
    // U4 at the wire: the +05:30 input instant comes back normalised to UTC Z,
    // while the displayTimeZone is stored as its own display preference.
    expect(payload.startAt).toBe(normalizedStartAt);
    expect(payload.endAt).toBe(endAt);
    expect(payload.displayTimeZone).toBe("Asia/Kolkata");
    // The materialised windows (contract §4.1 worked example, delta-for-delta).
    expect(payload.uploadWindowEndsAt).toBe(isoPlusDays(endAt, POST_UPLOAD_DAYS));
    expect(payload.retentionExpiresAt).toBe(isoPlusDays(endAt, RETENTION_DAYS));

    const accessLinks = payload.accessLinks as Array<Record<string, unknown>>;
    expect(accessLinks).toHaveLength(1);
    const link = accessLinks[0];
    expect(link).toBeDefined();
    if (link === undefined) {
      throw new Error("expected one access link on the created event");
    }
    expect(link).toMatchObject({ active: true });
    const slug = link.slug as string;
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
    expect(payload.shareUrl).toContain(`/e/${slug}`);
    expect(payload.createdAt).toBeTypeOf("string");

    // The stored row agrees, with the windows materialised and counters zeroed.
    const row = await app.db.collection("events").findOne({ _id: new ObjectId(eventId) });
    expect(row).not.toBeNull();
    if (row === null) {
      throw new Error("expected the event row to be stored");
    }
    expect(row).toMatchObject({
      tenantId: tenantKey,
      name: "Rahul & Priya's Wedding",
      status: "published",
      displayTimeZone: "Asia/Kolkata",
    });
    expect((row.startAt as Date).toISOString()).toBe(normalizedStartAt);
    expect((row.endAt as Date).toISOString()).toBe(endAt);
    expect((row.uploadWindowEndsAt as Date).toISOString()).toBe(
      isoPlusDays(endAt, POST_UPLOAD_DAYS)
    );
    expect((row.retentionExpiresAt as Date).toISOString()).toBe(isoPlusDays(endAt, RETENTION_DAYS));
    const storedLinks = row.accessLinks as Array<Record<string, unknown>>;
    expect(storedLinks).toHaveLength(1);
    expect(storedLinks[0]).toMatchObject({ slug, active: true, revokedAt: null });
    expect((row.counters as Record<string, unknown>).imageCount).toBe(0);

    // Exactly one organizer (schema §15.2's "exactly one" is a DB guarantee).
    const organizerRows = await app.db
      .collection(COLLECTIONS.eventOrganizers)
      .find({ eventId: new ObjectId(eventId) })
      .toArray();
    expect(organizerRows).toHaveLength(1);
    expect(organizerRows[0]).toMatchObject({
      tenantId: tenantKey,
      userId: user.userId.toHexString(),
      role: "organizer",
      revokedAt: null,
    });

    // The metered counter advanced by exactly 1 (schema §14.2).
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: tenantKey, entitlementKey: "events.active", periodKey: MONTH_KEY });
    expect(counter?.value).toBe(1);

    // The creation is announced (security requirement: info `event.created`).
    const emitted = await app.db
      .collection(COLLECTIONS.domainEvents)
      .findOne({ eventKey: "event.created", tenantId: tenantKey });
    expect(emitted).not.toBeNull();
    if (emitted === null) {
      throw new Error("expected the event.created domain event to be emitted");
    }
    expect((emitted.payload as Record<string, unknown>).eventId).toBe(eventId);
  });

  it("I2: at the events.active limit answers 403 plan_limit_exceeded and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-at-limit");
    const tenantKey = tenantId.toHexString();
    await seedPlan(ACTIVE_LIMIT_1, {
      "events.active": makeEntitlement({
        limit: 1,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedSubscription(tenantKey, ACTIVE_LIMIT_1, "active");
    await app.db
      .collection(COLLECTIONS.usageCounters)
      .insertOne(makeUsageCounter({ tenantId: tenantKey, periodKey: MONTH_KEY, value: 1 }));

    const response = await createEvent(createRequest(user.cookie, tenantKey, eventBody()));

    expect(response.status).toBe(403);
    // One body read (the Response body is one-shot): derive both the code and
    // the details from the same parse (OP-115 D2 — `errorCodeOf` + `body` on
    // the same response threw `Body has already been read`).
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("plan_limit_exceeded");
    expect(parsed.error.details).toMatchObject({
      entitlementKey: "events.active",
      limit: 1,
      used: 1,
      periodKey: MONTH_KEY,
      scope: "tenant",
      reason: "plan_limit",
    });
    expect(parsed.error.details?.upgradePath).toBeTypeOf("string");

    // Nothing persisted: no event, no organizer row, counter untouched.
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
    expect(
      await app.db.collection(COLLECTIONS.eventOrganizers).countDocuments({ tenantId: tenantKey })
    ).toBe(0);
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: tenantKey, entitlementKey: "events.active", periodKey: MONTH_KEY });
    expect(counter?.value).toBe(1);
  });

  it("I3: a downgraded tenant at the limit answers 402 payment_required and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-downgraded");
    const tenantKey = tenantId.toHexString();
    await seedPlan(ACTIVE_LIMIT_1, {
      "events.active": makeEntitlement({
        limit: 1,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedSubscription(tenantKey, ACTIVE_LIMIT_1, "downgraded");
    await app.db
      .collection(COLLECTIONS.usageCounters)
      .insertOne(makeUsageCounter({ tenantId: tenantKey, periodKey: MONTH_KEY, value: 1 }));

    const response = await createEvent(createRequest(user.cookie, tenantKey, eventBody()));

    expect(response.status).toBe(402);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("payment_required");
    expect(parsed.error.details).toMatchObject({
      entitlementKey: "events.active",
      reason: "payment_downgrade",
      pendingDueMinor: 49_900,
      currency: "INR",
    });
    expect(parsed.error.details?.payNowUrl).toBeTypeOf("string");

    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I4: endAt before startAt answers 422 invalid_date_range and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-range");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const startAt = `${fixtureDay(10)}T12:00:00.000Z`;
    const endAt = `${fixtureDay(7)}T12:00:00.000Z`;
    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ startAt, endAt }))
    );

    expect(response.status).toBe(422);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("invalid_date_range");
    expect(parsed.error.details).toMatchObject({ startAt, endAt });

    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I5: a slug collision is retried with a fresh slug and the seeded link is untouched", async () => {
    const { user, tenantId } = await seedOwner("op115-collision");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    // Occupy the unique `accessLinks.slug` slot of the (yet to be added)
    // partial unique index, then force the generator to draw it first.
    const seededSlug = "abcdefgh";
    const retrySlug = "bcdefghj";
    await app.db.collection("events").insertOne({
      tenantId: tenantKey,
      name: "Seeded collision",
      startAt: new Date(`${fixtureDay(1)}T10:00:00.000Z`),
      endAt: new Date(`${fixtureDay(2)}T10:00:00.000Z`),
      status: "draft",
      accessLinks: [{ slug: seededSlug, active: true, createdAt: new Date(), revokedAt: null }],
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    });
    slugMock.generateAccessLinkSlug
      .mockReset()
      .mockReturnValueOnce(seededSlug)
      .mockReturnValueOnce(retrySlug);

    const response = await createEvent(createRequest(user.cookie, tenantKey, eventBody()));

    expect(response.status).toBe(201);
    const payload = await body(response);
    const accessLinks = payload.accessLinks as Array<Record<string, unknown>>;
    expect(accessLinks).toHaveLength(1);
    const link = accessLinks[0];
    expect(link).toBeDefined();
    if (link === undefined) {
      throw new Error("expected one access link on the retried event");
    }
    expect(link.slug).toBe(retrySlug);
    // Both events exist: the seeded row was never mutated, and the retry
    // regenerated the slug instead of overwriting or 500-ing.
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(2);
    const seeded = await app.db.collection("events").findOne({
      tenantId: tenantKey,
      "accessLinks.slug": seededSlug,
    });
    expect(seeded?.name).toBe("Seeded collision");
  });

  it("I6: an idempotent replay under the same Idempotency-Key yields a single event", async () => {
    const { user, tenantId } = await seedOwner("op115-replay");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const key = randomUUID();
    const request = () => createRequest(user.cookie, tenantKey, eventBody(), key);

    const first = await createEvent(request());
    expect(first.status).toBe(201);
    const firstPayload = await body(first);

    const replay = await createEvent(request());
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const replayPayload = await body(replay);
    expect(replayPayload.id).toBe(firstPayload.id);

    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(1);
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: tenantKey, entitlementKey: "events.active", periodKey: MONTH_KEY });
    expect(counter?.value).toBe(1);
  });

  it("I7: a 2001-character description answers 422 validation_failed and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-description");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ description: "x".repeat(2001) }))
    );

    expect(response.status).toBe(422);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: {
        code: string;
        details?: { fields?: Array<{ path: string }> };
      };
    };
    expect(parsed.error.code).toBe("validation_failed");
    expect(parsed.error.details?.fields?.some((field) => field.path === "description")).toBe(true);
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I8: a logo owned by another tenant answers 422 validation_failed and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-foreign-logo");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    // A branding asset that belongs to someone else, of the right kind.
    const foreignTenant = new ObjectId().toHexString();
    const foreignLogo = new ObjectId();
    await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
      _id: foreignLogo,
      tenantId: foreignTenant,
      kind: "event_logo",
      contentHash: "ab".repeat(32),
      bytes: 1024,
      mimeType: "image/png",
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    });

    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ logoAssetId: foreignLogo.toHexString() }))
    );

    expect(response.status).toBe(422);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: {
        code: string;
        details?: { fields?: Array<{ path: string }> };
      };
    };
    expect(parsed.error.code).toBe("validation_failed");
    expect(parsed.error.details?.fields?.some((field) => field.path === "logoAssetId")).toBe(true);
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I8b: a logo owned by the same tenant is accepted", async () => {
    const { user, tenantId } = await seedOwner("op115-own-logo");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const logo = new ObjectId();
    await app.db.collection(COLLECTIONS.mediaAssets).insertOne({
      _id: logo,
      tenantId: tenantKey,
      kind: "event_logo",
      contentHash: "cd".repeat(32),
      bytes: 2048,
      mimeType: "image/png",
      createdAt: new Date(),
      updatedAt: new Date(),
      schemaVersion: 1,
    });

    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ logoAssetId: logo.toHexString() }))
    );

    expect(response.status).toBe(201);
    const row = await app.db.collection("events").findOne({ tenantId: tenantKey });
    expect((row?.logoAssetId as ObjectId).toHexString()).toBe(logo.toHexString());
  });

  it("I9: HTML in the description comes back as inert plain text", async () => {
    const { user, tenantId } = await seedOwner("op115-inert");
    const tenantKey = tenantId.toHexString();
    await seedStarterWorkspace(tenantKey);

    const decorated = await createEvent(
      createRequest(
        user.cookie,
        tenantKey,
        eventBody({ description: "<b>Reception</b> <i>photos</i>" })
      )
    );
    expect(decorated.status).toBe(201);
    const decoratedPayload = await body(decorated);
    expect(decoratedPayload.description).toBe("Reception photos");

    const scripted = await createEvent(
      createRequest(
        user.cookie,
        tenantKey,
        eventBody({ description: "<script>alert('x')</script>" })
      )
    );
    expect(scripted.status).toBe(201);
    const scriptedPayload = await body(scripted);
    const stored = await app.db.collection("events").findOne({
      tenantId: tenantKey,
      _id: new ObjectId(scriptedPayload.id as string),
    });
    expect(stored).not.toBeNull();
    if (stored === null) {
      throw new Error("expected the scripted event row to be stored");
    }
    expect(String(scriptedPayload.description)).not.toMatch(/[<>]/);
    expect(String(stored.description)).not.toMatch(/[<>]/);
  });

  it("I10: the validate endpoint reports a duration over the limit with ok:false and the limit, and usage counters stay unchanged", async () => {
    const { user, tenantId } = await seedOwner("op115-validate");
    const tenantKey = tenantId.toHexString();
    await seedPlan(PRO_30, {
      "events.duration_days": makeEntitlement({
        limit: 30,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
      "events.active": makeEntitlement({
        limit: 28,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedSubscription(tenantKey, PRO_30, "active");
    await app.db
      .collection(COLLECTIONS.usageCounters)
      .insertOne(makeUsageCounter({ tenantId: tenantKey, periodKey: MONTH_KEY, value: 2 }));

    const response = await validateEvent(
      validateRequest(user.cookie, tenantKey, {
        startAt: `${fixtureDay(1)}T00:00:00.000Z`,
        endAt: `${fixtureDay(46)}T00:00:00.000Z`,
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    const checks = payload.checks as Array<Record<string, unknown>>;
    expect(Array.isArray(checks)).toBe(true);
    const duration = checks.find((check) => check.field === "durationDays");
    expect(duration).toMatchObject({ ok: false, code: "plan_limit_exceeded", limit: 30 });
    expect(duration?.upgradePath).toBeTypeOf("string");

    // The validate endpoint consumes nothing: the counter is untouched and no
    // event row exists.
    const counter = await app.db
      .collection(COLLECTIONS.usageCounters)
      .findOne({ tenantId: tenantKey, entitlementKey: "events.active", periodKey: MONTH_KEY });
    expect(counter?.value).toBe(2);
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I11: a 45-day event on a 30-day plan answers 403 with requestedDays and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-45days");
    const tenantKey = tenantId.toHexString();
    await seedPlan(PRO_30, {
      "events.duration_days": makeEntitlement({
        limit: 30,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
      "events.active": makeEntitlement({
        limit: 28,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
    });
    await seedSubscription(tenantKey, PRO_30, "active");

    const response = await createEvent(
      createRequest(
        user.cookie,
        tenantKey,
        eventBody({
          startAt: `${fixtureDay(1)}T00:00:00.000Z`,
          endAt: `${fixtureDay(46)}T00:00:00.000Z`,
        })
      )
    );

    expect(response.status).toBe(403);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("plan_limit_exceeded");
    expect(parsed.error.details).toMatchObject({
      entitlementKey: "events.duration_days",
      limit: 30,
      requestedDays: 45,
    });
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I12: an explicit null postUploadDays on a limited plan answers 403 and persists nothing", async () => {
    const { user, tenantId } = await seedOwner("op115-null-limited");
    const tenantKey = tenantId.toHexString();
    await seedPlan(POST7, {
      "events.post_upload_days": makeEntitlement({
        limit: 7,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
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
    });
    await seedSubscription(tenantKey, POST7, "active");

    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ postUploadDays: null }))
    );

    expect(response.status).toBe(403);
    // One body read (see I2 — the Response body is one-shot).
    const parsed = (await body(response)) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(parsed.error.code).toBe("plan_limit_exceeded");
    expect(parsed.error.details).toMatchObject({ entitlementKey: "events.post_upload_days" });
    expect(await app.db.collection("events").countDocuments({ tenantId: tenantKey })).toBe(0);
  });

  it("I13: an unlimited plan with a null postUploadDays materialises uploadWindowEndsAt as null", async () => {
    const { user, tenantId } = await seedOwner("op115-unlimited");
    const tenantKey = tenantId.toHexString();
    await seedPlan(UNLIMITED, {
      "events.active": makeEntitlement({
        limit: null,
        resetPeriod: "monthly",
        scope: "tenant",
        enforcement: "hard",
      }),
      "events.duration_days": makeEntitlement({
        limit: null,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
      "events.post_upload_days": makeEntitlement({
        limit: null,
        resetPeriod: "none",
        scope: "event",
        enforcement: "hard",
      }),
      "gallery.retention_days": makeEntitlement({
        limit: null,
        resetPeriod: "none",
        scope: "event",
        enforcement: "policy",
      }),
    });
    await seedSubscription(tenantKey, UNLIMITED, "active");

    const response = await createEvent(
      createRequest(user.cookie, tenantKey, eventBody({ postUploadDays: null }))
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(payload.uploadWindowEndsAt).toBeNull();
    const row = await app.db.collection("events").findOne({ tenantId: tenantKey });
    expect((row?.uploadWindowEndsAt as Date | null) ?? null).toBeNull();
  });
});
