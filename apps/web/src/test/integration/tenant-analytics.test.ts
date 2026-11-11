import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getAnalytics } from "@/app/api/v1/tenants/[tenantId]/analytics/route";
import { COLLECTIONS } from "@/server/db/collections";

import { ANALYTICS_SERIES_KEYS, makeAnalyticsDailyRow } from "../factories/analytics";
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
 * Integration / contract — tenant analytics (OP-119 I1/I2, contract §4.5,
 * schema §20.1).
 *
 * The user story: *as an organizer I see my tenant's daily rollups so I can
 * track performance.* The endpoint is a **read of `analyticsDaily` only** — it
 * never aggregates a transactional collection at request time (the GREEN card's
 * acceptance criterion), which is why every spec here seeds rollup rows and,
 * where the criterion needs proof, a transactional collection whose numbers
 * disagree with them.
 *
 *   I1  seeded `analyticsDaily` → the `series` (one flat element per day) and
 *       the `totals` (the U2 reducer's output) are exactly right;
 *   I2  a 400-day range → `422 range_too_large` with `details.maxDays = 366`.
 *
 * Around those the suite pins what the contract states in the same breath: the
 * `owner`|`admin` role gate, the uniform non-oracle `404` for a non-member, the
 * `401` without a session, the `event` scope, and that a day outside `from..to`
 * or belonging to another workspace never reaches the answer.
 *
 * ## Contract expected of the implementation
 *
 * - `@/app/api/v1/tenants/[tenantId]/analytics/route` exports `GET`, declared
 *   with `defineRoute({ route: "/api/v1/tenants/:tenantId/analytics", … })`,
 *   `auth: userAuth()` and the reusable `tenantStage()` plus an
 *   `owner`|`admin` role gate (`403 forbidden` for a `member`).
 * - Query: `from` and `to` are **required** `YYYY-MM-DD` day keys, `scope` is
 *   `tenant` (default) or `event`, and `eventId` is required when
 *   `scope=event`. Validation refuses through the U1 validator, so
 *   `range_too_large` is `422` with `details: { maxDays: 366 }`.
 * - Body (§4.5): `{ scope: { kind, id }, from, to, series: [{ dateKey, …the
 *   twelve §20.1 metrics, flat }], totals: { …the twelve metrics… },
 *   computedAt, note }`. `series` is ordered by `dateKey` **ascending**; only
 *   days inside `from..to` are served; `totals` is `reduceAnalyticsTotals` over
 *   the served days (`@/server/analytics/totals`); `note` is a non-empty
 *   string; `computedAt` is a `Z` RFC 3339 instant.
 * - The collection is `analyticsDaily` (schema §20.1) with
 *   `scope: { kind: "tenant" | "event", id: ObjectId }`, so the GREEN owes it a
 *   `COLLECTIONS.analyticsDaily` entry. This spec uses the literal name so the
 *   RED compiles before that entry exists.
 *
 * ## Assumptions (ADR-0640 §Assumptions)
 *
 * - A6 — `from`/`to` are echoed as requested (a `YYYY-MM-DD` string, not an
 *   instant), matching §4.5's worked body.
 * - A7 — a missing `from` or `to` is `422 validation_failed`: the range is the
 *   whole point of the read and §4.5 names no default. A missing `eventId`
 *   with `scope=event` is the same refusal.
 * - A8 — `scope=event` is checked against the *tenant in the path*, so an
 *   event of another workspace is `404 not_found` (contract §0.4: no
 *   cross-tenant existence oracle). This is not spelled out in §4.5; it is the
 *   only reading that keeps the tenant segment meaningful.
 * - A9 — a day with no rollup row contributes nothing and is **not**
 *   materialised as a zero element: `series` carries stored days only.
 * - `note` is prose, so only its presence and non-emptiness are pinned.
 */

/** The tenant path segment the specs address; `current` is the other form. */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op119-analytics" });
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
    COLLECTIONS.eventImages,
    COLLECTIONS.domainEvents,
    "analyticsDaily",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
});

/** A signed-in user who is an active member of a fresh active tenant. */
async function seedWorkspace(
  prefix: string,
  role: "owner" | "admin" | "member"
): Promise<{ user: SignedInUser; tenantId: ObjectId }> {
  const user = await app.signIn(makeIdentity(prefix));
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op119-${prefix}`,
    name: "OP119 Studio",
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
    role,
    status: "active",
    joinedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  return { user, tenantId };
}

/** Insert a stored `events` row belonging to `tenantKey` and return its id. */
async function seedEvent(tenantKey: string): Promise<ObjectId> {
  const _id = new ObjectId();
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
    accessLinks: [{ slug: "k7m2xq9p", active: true, createdAt: new Date(), revokedAt: null }],
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

/** Insert one `analyticsDaily` row. */
async function seedRollup(
  scope: { readonly kind: "tenant" | "event"; readonly id: ObjectId },
  dateKey: string,
  metrics: Parameters<typeof makeAnalyticsDailyRow>[0]["metrics"] = {}
): Promise<void> {
  await app.db
    .collection("analyticsDaily")
    .insertOne(makeAnalyticsDailyRow({ scope, dateKey, metrics }));
}

/** A `GET /tenants/{tenant}/analytics` request carrying the session cookie. */
function analyticsRequest(
  cookie: string,
  tenantSegment: string,
  query: Record<string, string>
): Request {
  const url = new URL(`/api/v1/tenants/${tenantSegment}/analytics`, APP_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Request(url, { method: "GET", headers: { cookie } });
}

/** An unauthenticated `GET /tenants/{tenant}/analytics` request. */
function anonymousAnalyticsRequest(tenantSegment: string, query: Record<string, string>): Request {
  const url = new URL(`/api/v1/tenants/${tenantSegment}/analytics`, APP_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Request(url, { method: "GET" });
}

/** The error envelope of a failed response. */
async function errorEnvelope(
  response: Response
): Promise<{ code: string; details?: Record<string, unknown> }> {
  const parsed = await body(response);
  return parsed.error as { code: string; details?: Record<string, unknown> };
}

/** The `series` of a `200` analytics answer. */
function seriesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return payload.series as Record<string, unknown>[];
}

describe("GET /api/v1/tenants/{tenantId}/analytics — the tenant series (I1)", () => {
  it("I1: returns the seeded days as an ascending flat series with the reduced totals", async () => {
    const { user, tenantId } = await seedWorkspace("op119-owner", "owner");
    const scope = { kind: "tenant", id: tenantId } as const;
    await seedRollup(scope, "2026-09-02", {
      eventsCreated: 1,
      imagesUploaded: 900,
      imagesProcessed: 899,
      imagesFailed: 1,
      selfiesUploaded: 13,
      matchesCreated: 400,
      uniqueAttendees: 12,
      storageBytesAdded: 1_073_741_824,
      downloads: 88,
      notificationsSent: 40,
      revenueMinor: 1000,
      p95ProcessingMs: 1200,
    });
    await seedRollup(scope, "2026-09-24", {
      eventsCreated: 3,
      imagesUploaded: 4120,
      imagesProcessed: 4118,
      imagesFailed: 2,
      selfiesUploaded: 87,
      matchesCreated: 1904,
      uniqueAttendees: 84,
      storageBytesAdded: 12_884_901_888,
      downloads: 412,
      notificationsSent: 260,
      revenueMinor: 49_900,
      p95ProcessingMs: 3400,
    });
    await seedRollup(scope, "2026-09-25", { imagesUploaded: 10, p95ProcessingMs: 9100 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-25",
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);

    expect(payload.scope).toEqual({ kind: "tenant", id: tenantId.toHexString() });
    expect(payload.from).toBe("2026-09-01");
    expect(payload.to).toBe("2026-09-25");

    const series = seriesOf(payload);
    expect(series.map((day) => day.dateKey)).toEqual(["2026-09-02", "2026-09-24", "2026-09-25"]);
    // §4.5 flattens §20.1's `metrics` block onto the series element.
    expect(Object.keys(series[0] ?? {}).sort()).toEqual(ANALYTICS_SERIES_KEYS);
    expect(series[1]).toMatchObject({
      dateKey: "2026-09-24",
      imagesUploaded: 4120,
      downloads: 412,
    });

    expect(payload.totals).toMatchObject({
      eventsCreated: 4,
      imagesUploaded: 5030,
      imagesProcessed: 5017,
      imagesFailed: 3,
      selfiesUploaded: 100,
      matchesCreated: 2304,
      uniqueAttendees: 96,
      storageBytesAdded: 13_958_643_712,
      downloads: 500,
      notificationsSent: 300,
      revenueMinor: 50_900,
      // The percentile is the maximum of the days, never the sum.
      p95ProcessingMs: 9100,
    });

    const computedAt = payload.computedAt as string;
    expect(new Date(computedAt).toISOString()).toBe(computedAt);
    expect(typeof payload.note).toBe("string");
    expect((payload.note as string).length).toBeGreaterThan(0);
  });

  it("I1: serves only the days inside from..to, both ends inclusive", async () => {
    const { user, tenantId } = await seedWorkspace("op119-window", "owner");
    const scope = { kind: "tenant", id: tenantId } as const;
    await seedRollup(scope, "2026-08-31", { imagesUploaded: 5000 });
    await seedRollup(scope, "2026-09-01", { imagesUploaded: 1 });
    await seedRollup(scope, "2026-09-25", { imagesUploaded: 2 });
    await seedRollup(scope, "2026-09-26", { imagesUploaded: 6000 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-25",
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(seriesOf(payload).map((day) => day.dateKey)).toEqual(["2026-09-01", "2026-09-25"]);
    expect(payload.totals).toMatchObject({ imagesUploaded: 3 });
  });

  it("I1: never serves another workspace's rollups", async () => {
    const { user, tenantId } = await seedWorkspace("op119-mine", "owner");
    const other = await seedWorkspace("op119-theirs", "owner");
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { imagesUploaded: 7 });
    await seedRollup({ kind: "tenant", id: other.tenantId }, "2026-09-24", { imagesUploaded: 999 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(seriesOf(payload)).toHaveLength(1);
    expect(payload.totals).toMatchObject({ imagesUploaded: 7 });
  });

  it("I1: reports the rollups even when the transactional collections disagree", async () => {
    const { user, tenantId } = await seedWorkspace("op119-rollup", "owner");
    const tenantKey = tenantId.toHexString();
    const eventId = await seedEvent(tenantKey);
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { imagesUploaded: 4120 });

    // Transactional rows the request must NOT aggregate (the card's acceptance
    // criterion): 5 uploads inside the range against a rollup of 4120.
    for (let index = 0; index < 5; index += 1) {
      await app.db.collection(COLLECTIONS.eventImages).insertOne({
        tenantId: tenantKey,
        eventId,
        assetId: new ObjectId(),
        uploadedByUserId: user.userId.toHexString(),
        createdAt: new Date("2026-09-24T10:00:00.000Z"),
      });
    }
    await app.db.collection(COLLECTIONS.domainEvents).insertOne({
      tenantId: tenantKey,
      eventKey: `event:${eventId.toHexString()}`,
      type: "media.image.uploaded",
      occurredAt: new Date("2026-09-24T10:00:00.000Z"),
      createdAt: new Date("2026-09-24T10:00:00.000Z"),
    });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantKey, { from: "2026-09-01", to: "2026-09-30" })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.totals).toMatchObject({ imagesUploaded: 4120 });
    expect(seriesOf(payload)[0]).toMatchObject({ dateKey: "2026-09-24", imagesUploaded: 4120 });
  });

  it("I1: serves an event-scoped series and echoes the event scope", async () => {
    const { user, tenantId } = await seedWorkspace("op119-event", "owner");
    const tenantKey = tenantId.toHexString();
    const eventId = await seedEvent(tenantKey);
    await seedRollup({ kind: "event", id: eventId }, "2026-09-24", { selfiesUploaded: 87 });
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { selfiesUploaded: 500 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantKey, {
        from: "2026-09-01",
        to: "2026-09-30",
        scope: "event",
        eventId: eventId.toHexString(),
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.scope).toEqual({ kind: "event", id: eventId.toHexString() });
    expect(payload.totals).toMatchObject({ selfiesUploaded: 87 });
  });

  it("I1: answers 404 for an event that belongs to another workspace", async () => {
    const { user, tenantId } = await seedWorkspace("op119-foreign", "owner");
    const other = await seedWorkspace("op119-other-owner", "owner");
    const foreignEventId = await seedEvent(other.tenantId.toHexString());
    await seedRollup({ kind: "event", id: foreignEventId }, "2026-09-24", { selfiesUploaded: 87 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
        scope: "event",
        eventId: foreignEventId.toHexString(),
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });
});

describe("GET /api/v1/tenants/{tenantId}/analytics — the range guard (I2)", () => {
  it("I2: refuses a 400-day range with 422 range_too_large naming the 366-day maximum", async () => {
    const { user, tenantId } = await seedWorkspace("op119-400", "owner");
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { imagesUploaded: 7 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-01-01",
        to: "2027-02-04",
      })
    );

    expect(response.status).toBe(422);
    const payload = await body(response);
    expect(payload.error).toMatchObject({ code: "range_too_large", details: { maxDays: 366 } });
    expect(payload).not.toHaveProperty("series");
  });

  it("I2: accepts the boundary — exactly 366 inclusive days", async () => {
    const { user, tenantId } = await seedWorkspace("op119-366", "owner");
    await seedRollup({ kind: "tenant", id: tenantId }, "2024-12-31", { imagesUploaded: 4 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2024-01-01",
        to: "2024-12-31",
      })
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(seriesOf(payload).map((day) => day.dateKey)).toEqual(["2024-12-31"]);
  });

  it("I2: refuses a missing `to` with 422 validation_failed", async () => {
    const { user, tenantId } = await seedWorkspace("op119-missing", "owner");

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), { from: "2026-09-01" })
    );

    expect(response.status).toBe(422);
    expect((await errorEnvelope(response)).code).toBe("validation_failed");
  });

  it("I2: refuses a reversed range with 422 invalid_date_range", async () => {
    const { user, tenantId } = await seedWorkspace("op119-reversed", "owner");

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-30",
        to: "2026-09-01",
      })
    );

    expect(response.status).toBe(422);
    expect((await errorEnvelope(response)).code).toBe("invalid_date_range");
  });
});

describe("GET /api/v1/tenants/{tenantId}/analytics — authorization", () => {
  it("answers 401 without a session", async () => {
    const { tenantId } = await seedWorkspace("op119-anon", "owner");

    const response = await getAnalytics(
      anonymousAnalyticsRequest(tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
      })
    );

    expect(response.status).toBe(401);
    expect((await errorEnvelope(response)).code).toBe("authentication_required");
  });

  it("answers 403 forbidden to a `member` (only owner|admin may read analytics)", async () => {
    const { user, tenantId } = await seedWorkspace("op119-member", "member");
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { imagesUploaded: 7 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
      })
    );

    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload.error).toMatchObject({ code: "forbidden" });
    expect(payload).not.toHaveProperty("series");
  });

  it("admits an `admin`, who is not the owner", async () => {
    const { user, tenantId } = await seedWorkspace("op119-admin", "admin");
    await seedRollup({ kind: "tenant", id: tenantId }, "2026-09-24", { imagesUploaded: 7 });

    const response = await getAnalytics(
      analyticsRequest(user.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
      })
    );

    expect(response.status).toBe(200);
  });

  it("answers 404 (never 403) to a caller who is not a member of the workspace", async () => {
    const { tenantId } = await seedWorkspace("op119-stranger-target", "owner");
    const stranger = await app.signIn(makeIdentity("op119-stranger"));

    const response = await getAnalytics(
      analyticsRequest(stranger.cookie, tenantId.toHexString(), {
        from: "2026-09-01",
        to: "2026-09-30",
      })
    );

    expect(response.status).toBe(404);
    expect((await errorEnvelope(response)).code).toBe("not_found");
  });
});
