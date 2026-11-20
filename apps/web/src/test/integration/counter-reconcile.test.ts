import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { counterReconcileJob } from "@/server/jobs/counter-reconcile";
import { fixedClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import {
  ACTIVITY_AT,
  makeAttendeeProfileRow,
  makeEventImageRow,
  makeEventRow,
  makeFaceMatchRow,
  makePlatformSettingsDocument,
  makeTenantRow,
} from "../factories/rollup-jobs";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger, type RecordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `counter-reconcile` (OP-139 I2, contract §10.2,
 * §9.10; schema §13.3, §16.1; ADR-0918).
 *
 * The user story: *as an operator I want the cached dashboard counters corrected
 * from their sources nightly, so a drifted cache does not become the number the
 * customer is billed or shown.* `tenants.counters` advertises itself as
 * `approximate: true` (schema §2.1) **because** this job reconciles it: the
 * cached counters are never the truth, and a correction must be visible (a log
 * delta) rather than silent.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/counter-reconcile` exports `counterReconcileJob: CronJob`
 * (`defineCronJob({ name: "counter-reconcile", … })`), registered in
 * `apps/web/vercel.json` at `02:30` IST daily, plus the pure
 * `isDriftSignificant` (pinned by U2).
 *
 * - **Scope.** One invocation examines up to its clamped `limit` tenants (the
 *   `?limit=` bound, default 200) in `_id` order, so a tenant population larger
 *   than the limit is drained across runs and `hasMore` says so.
 * - **Sources.** Every recomputation reads a **source collection**, never
 *   another cached counter:
 *   - `tenants.counters.eventCount` = the tenant's `events` rows;
 *   - `tenants.counters.activeEventCount` = those with `status: "published"`
 *     (`draft` and `archived` events are not active);
 *   - `tenants.counters.imageCount` = the tenant's `event_images` rows;
 *   - `tenants.counters.attendeeCount` = the tenant's `attendee_event_profiles`
 *     rows (one row per attendee per event; the fixture keeps one row per
 *     attendee so both readings agree);
 *   - `events.counters.imageCount` / `processedImageCount` / `failedImageCount`
 *     = that event's `event_images` rows, counted by `processing.status`
 *     (`processed` and `failed`; `queued`/`processing` count only toward the
 *     total);
 *   - `attendee_event_profiles.matchCount` = that profile's `face_matches` rows.
 * - **Write.** A drifted field is corrected in place, and the tenant row's
 *   `counters.reconciledAt` is stamped from the injected `Clock` (an RFC 3339
 *   `Z` string, the field's stored type) on **every** run that examines the
 *   tenant — including one that finds no drift, which is what "reconciled"
 *   means.
 * - **Log.** Each corrected field writes one line whose `fields.event` is
 *   `"counter.reconcile.corrected"` carrying `{ collection, field, cached,
 *   actual }`. A field that already agrees writes no line (there is no delta to
 *   report).
 * - **Alert.** A drift **above** `platformSettings.jobs.counterReconcile.
 *   driftThresholdPercent` (default `5`) additionally emits one
 *   `admin.abuse.flagged` domain event under the tenant the drift belongs to,
 *   carrying `{ reason: "counter_drift", collection, field, cached, actual }`.
 *   A drift at or below the threshold is corrected and logged, and raises
 *   nothing: the admin channel is digest-throttled (§7.6), so a routine
 *   correction round must not become an alert stream.
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A3/A4 — drift and its threshold are pinned by U2.
 * - A8 — `tenants.counters.storageBytes` is **not** pinned here: the byte
 *   lineage (an `event_images` row to its `media_assets` size) is not stated by
 *   the card and the field is left to the GREEN; this spec asserts the four
 *   counters whose sources are unambiguous, field by field, so it cannot pass by
 *   accident on a whole-object compare.
 * - A9 — the settings section is `jobs.counterReconcile.driftThresholdPercent`
 *   (schema §20.4 extension). The shipped singleton carries no `jobs` section,
 *   so the GREEN must add it to `platformSettingsSchema` with a `.default(…)` of
 *   `5`; this spec seeds it explicitly and also pins the default arm.
 * - A18 — `scanned` is the number of **tenants** examined, and `hasMore` is
 *   `true` while a tenant examined in an earlier run has still not been
 *   reconciled. The drain order itself is not pinned (any fair order passes):
 *   the case only requires that a two-tenant budget over three tenants stamps
 *   two, and that the next run reaches the third.
 */

let app: TestApp;

/** Run the job at one fixed instant with a fresh recording logger. */
async function runReconcile(
  at: Date = ACTIVITY_AT,
  requestedLimit: number | null = null
): Promise<{
  readonly result: Awaited<ReturnType<typeof counterReconcileJob.run>>;
  readonly logger: RecordingLogger;
}> {
  const logger = recordingLogger();
  const result = await counterReconcileJob.run({
    requestedLimit,
    clock: fixedClock(at),
    logger,
  });
  return { result, logger };
}

/** How many of the named tenants the job has stamped `counters.reconciledAt` on. */
async function reconciledTenantCount(tenantObjectIds: readonly ObjectId[]): Promise<number> {
  const rows = await app.db
    .collection(COLLECTIONS.tenants)
    .find({ _id: { $in: [...tenantObjectIds] }, "counters.reconciledAt": { $ne: null } })
    .toArray();
  return rows.length;
}

/** The stored counters block of one tenant. */
async function tenantCounters(tenantObjectId: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db
    .collection(COLLECTIONS.tenants)
    .findOne({ _id: tenantObjectId }, { projection: { counters: 1 } });
  return (row?.counters ?? {}) as Record<string, unknown>;
}

/** The stored counters block of one event. */
async function eventCounters(eventId: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId }, { projection: { counters: 1 } });
  return (row?.counters ?? {}) as Record<string, unknown>;
}

/** Every `admin.abuse.flagged` outbox row. */
async function abuseEvents(): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: "admin.abuse.flagged" })
    .sort({ _id: 1 })
    .toArray();
}

/** Seed the settings singleton the job reads its drift threshold from. */
async function seedDriftThreshold(driftThresholdPercent: number): Promise<void> {
  await app.db
    .collection("platformSettings")
    .insertOne(makePlatformSettingsDocument(driftThresholdPercent));
  invalidatePlatformSettings();
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op139-reconcile" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.tenants,
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.attendeeEventProfiles,
      COLLECTIONS.faceMatches,
      COLLECTIONS.mediaAssets,
      COLLECTIONS.domainEvents,
      "platformSettings",
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
  invalidatePlatformSettings();
});

afterEach(() => {
  invalidatePlatformSettings();
});

afterAll(async () => {
  await app.cleanup();
});

describe("counter-reconcile I2: the seeded drift is corrected", () => {
  it("I2: corrects every drifted tenant, event and profile counter and stamps reconciledAt", async () => {
    // ── Arrange: a tenant whose cached counters have all drifted low ──
    const tenantObjectId = new ObjectId();
    const tenantId = tenantObjectId.toHexString();
    await app.db.collection(COLLECTIONS.tenants).insertOne(
      makeTenantRow({
        _id: tenantObjectId,
        slug: "op139-drift",
        counters: {
          eventCount: 1,
          activeEventCount: 1,
          imageCount: 1,
          attendeeCount: 1,
          reconciledAt: null,
        },
      })
    );

    const firstEvent = new ObjectId();
    const secondEvent = new ObjectId();
    const archivedEvent = new ObjectId();
    await app.db.collection(COLLECTIONS.events).insertMany([
      makeEventRow({
        _id: firstEvent,
        tenantId,
        status: "published",
        counters: { imageCount: 9, processedImageCount: 0, failedImageCount: 0 },
      }),
      makeEventRow({ _id: secondEvent, tenantId, status: "published" }),
      makeEventRow({ _id: archivedEvent, tenantId, status: "archived" }),
    ]);

    // The first event's four images: two processed, one failed, one still queued.
    const imageIds = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()] as const;
    await app.db.collection(COLLECTIONS.eventImages).insertMany([
      makeEventImageRow({
        _id: imageIds[0],
        tenantId,
        eventId: firstEvent,
        processingStatus: "processed",
      }),
      makeEventImageRow({
        _id: imageIds[1],
        tenantId,
        eventId: firstEvent,
        processingStatus: "processed",
      }),
      makeEventImageRow({
        _id: imageIds[2],
        tenantId,
        eventId: firstEvent,
        processingStatus: "failed",
      }),
      makeEventImageRow({
        _id: imageIds[3],
        tenantId,
        eventId: firstEvent,
        processingStatus: "queued",
      }),
    ]);

    // Five attendees across the two live events; the first profile has three
    // published matches, which the cached `matchCount` of 0 denies.
    const matchedProfile = new ObjectId();
    await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertMany([
      makeAttendeeProfileRow({
        _id: matchedProfile,
        tenantId,
        eventId: firstEvent,
        matchCount: 0,
      }),
      makeAttendeeProfileRow({ tenantId, eventId: firstEvent }),
      makeAttendeeProfileRow({ tenantId, eventId: firstEvent }),
      makeAttendeeProfileRow({ tenantId, eventId: secondEvent }),
      makeAttendeeProfileRow({ tenantId, eventId: secondEvent }),
    ]);
    await app.db
      .collection(COLLECTIONS.faceMatches)
      .insertMany([
        makeFaceMatchRow({ profileId: matchedProfile, imageId: imageIds[0], faceIndex: 0 }),
        makeFaceMatchRow({ profileId: matchedProfile, imageId: imageIds[1], faceIndex: 0 }),
        makeFaceMatchRow({ profileId: matchedProfile, imageId: imageIds[2], faceIndex: 0 }),
      ]);

    // ── Act ──
    const { result, logger } = await runReconcile();

    // ── Assert: the tenant's four source-backed counters ──
    const tenant = await tenantCounters(tenantObjectId);
    expect(tenant.eventCount).toBe(3);
    expect(tenant.activeEventCount).toBe(2);
    expect(tenant.imageCount).toBe(4);
    expect(tenant.attendeeCount).toBe(5);
    expect(tenant.reconciledAt).toBe(ACTIVITY_AT.toISOString());
    expect(tenant.approximate).toBe(true);

    // ── Assert: the event's processing counters ──
    const event = await eventCounters(firstEvent);
    expect(event.imageCount).toBe(4);
    expect(event.processedImageCount).toBe(2);
    expect(event.failedImageCount).toBe(1);

    // ── Assert: the profile's match count ──
    const profile = await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: matchedProfile }, { projection: { matchCount: 1 } });
    expect(profile?.matchCount).toBe(3);

    // ── Assert: every correction is logged with its delta ──
    expect(result.errors).toBe(0);
    const corrections = logger.entriesForEvent("counter.reconcile.corrected");
    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections.map((entry) => entry.fields)).toContainEqual(
      expect.objectContaining({ collection: "tenants", field: "eventCount", cached: 1, actual: 3 })
    );
    expect(corrections.map((entry) => entry.fields)).toContainEqual(
      expect.objectContaining({
        collection: "attendee_event_profiles",
        field: "matchCount",
        cached: 0,
        actual: 3,
      })
    );
  });

  it("I2: leaves an agreeing counter alone, logs no delta and still stamps reconciledAt", async () => {
    // ── Arrange: a tenant whose cache already agrees with its sources ──
    const tenantObjectId = new ObjectId();
    const tenantId = tenantObjectId.toHexString();
    await app.db.collection(COLLECTIONS.tenants).insertOne(
      makeTenantRow({
        _id: tenantObjectId,
        slug: "op139-steady",
        counters: {
          eventCount: 1,
          activeEventCount: 1,
          imageCount: 2,
          attendeeCount: 1,
          reconciledAt: null,
        },
      })
    );
    const eventId = new ObjectId();
    await app.db.collection(COLLECTIONS.events).insertOne(
      makeEventRow({
        _id: eventId,
        tenantId,
        status: "published",
        counters: { imageCount: 2, processedImageCount: 2, failedImageCount: 0 },
      })
    );
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertMany([
        makeEventImageRow({ tenantId, eventId, processingStatus: "processed" }),
        makeEventImageRow({ tenantId, eventId, processingStatus: "processed" }),
      ]);
    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .insertOne(makeAttendeeProfileRow({ tenantId, eventId, matchCount: 0 }));

    // ── Act ──
    const { result, logger } = await runReconcile();

    // ── Assert: nothing to report, but the run is still evidenced ──
    expect(logger.entriesForEvent("counter.reconcile.corrected")).toEqual([]);
    expect((await tenantCounters(tenantObjectId)).reconciledAt).toBe(ACTIVITY_AT.toISOString());
    expect(result.errors).toBe(0);
    expect(await abuseEvents()).toEqual([]);
  });
});

describe("counter-reconcile I2: the bounded tenant drain", () => {
  it("I2: drains the tenant population across runs instead of starving the tail", async () => {
    // ── Arrange: three tenants, each one event short of its cached count ──
    const tenantIds = [new ObjectId(), new ObjectId(), new ObjectId()] as const;
    await app.db
      .collection(COLLECTIONS.tenants)
      .insertMany([
        makeTenantRow({ _id: tenantIds[0], slug: "op139-drain-a", counters: { eventCount: 0 } }),
        makeTenantRow({ _id: tenantIds[1], slug: "op139-drain-b", counters: { eventCount: 0 } }),
        makeTenantRow({ _id: tenantIds[2], slug: "op139-drain-c", counters: { eventCount: 0 } }),
      ]);
    await app.db
      .collection(COLLECTIONS.events)
      .insertMany([
        makeEventRow({ tenantId: tenantIds[0].toHexString() }),
        makeEventRow({ tenantId: tenantIds[1].toHexString() }),
        makeEventRow({ tenantId: tenantIds[2].toHexString() }),
      ]);

    // ── Act: a two-tenant budget, the card's `200 tenants per run` in miniature ──
    const first = await runReconcile(ACTIVITY_AT, 2);

    // ── Assert: exactly two examined, and the run says there is more ──
    expect(first.result.scanned).toBe(2);
    expect(first.result.hasMore).toBe(true);
    expect(await reconciledTenantCount(tenantIds)).toBe(2);

    // ── Act: the next night's run, with the same budget ──
    const second = await runReconcile(new Date(ACTIVITY_AT.getTime() + 86_400_000), 2);

    // ── Assert: the tail is reached and the backlog is drained ──
    expect(await reconciledTenantCount(tenantIds)).toBe(3);
    expect(second.result.hasMore).toBe(false);
  });
});

describe("counter-reconcile I2: the drift threshold", () => {
  it("I2: a drift above the configured threshold raises one admin.abuse.flagged", async () => {
    // ── Arrange: 5 % threshold; the cache over-states eventCount alone, so
    // exactly one field can alert (a second drifted field would be a second
    // alert under a per-field rule).
    await seedDriftThreshold(5);
    const tenantObjectId = new ObjectId();
    const tenantId = tenantObjectId.toHexString();
    await app.db.collection(COLLECTIONS.tenants).insertOne(
      makeTenantRow({
        _id: tenantObjectId,
        slug: "op139-loud",
        counters: { eventCount: 1, activeEventCount: 3 },
      })
    );
    await app.db
      .collection(COLLECTIONS.events)
      .insertMany([
        makeEventRow({ tenantId, status: "published" }),
        makeEventRow({ tenantId, status: "published" }),
        makeEventRow({ tenantId, status: "published" }),
      ]);

    // ── Act ──
    await runReconcile();

    // ── Assert: one alert, under the tenant the drift belongs to ──
    const events = await abuseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(tenantId);
    expect(events[0]?.payload).toMatchObject({
      reason: "counter_drift",
      collection: "tenants",
      field: "eventCount",
      cached: 1,
      actual: 3,
    });
    // The correction itself still happens on an alerting run.
    expect((await tenantCounters(tenantObjectId)).eventCount).toBe(3);
  });

  it("I2: a drift at or below the configured threshold is corrected silently", async () => {
    // ── Arrange: 21 cached events against 20 real ones is 5.0 % of the truth —
    // exactly at the 5 % threshold, so not *above* it. `activeEventCount` is
    // seeded consistent (19 published) so no other field can alert.
    await seedDriftThreshold(5);
    const tenantObjectId = new ObjectId();
    const tenantId = tenantObjectId.toHexString();
    await app.db.collection(COLLECTIONS.tenants).insertOne(
      makeTenantRow({
        _id: tenantObjectId,
        slug: "op139-quiet",
        counters: { eventCount: 21, activeEventCount: 19 },
      })
    );
    await app.db
      .collection(COLLECTIONS.events)
      .insertMany(
        Array.from({ length: 20 }, (_, index) =>
          makeEventRow({ tenantId, status: index === 0 ? "draft" : "published" })
        )
      );

    // ── Act ──
    const { logger } = await runReconcile();

    // ── Assert: corrected and logged, but never escalated ──
    const tenant = await tenantCounters(tenantObjectId);
    expect(tenant.eventCount).toBe(20);
    expect(tenant.activeEventCount).toBe(19);
    expect(logger.entriesForEvent("counter.reconcile.corrected").length).toBeGreaterThan(0);
    expect(await abuseEvents()).toEqual([]);
  });

  it("I2: uses the documented 5 % default when the settings singleton carries no jobs section", async () => {
    // ── Arrange: no singleton at all, so `getPlatformSettings` answers the
    // documented defaults; the drift is 66 %, far above the 5 % default.
    const tenantObjectId = new ObjectId();
    const tenantId = tenantObjectId.toHexString();
    await app.db.collection(COLLECTIONS.tenants).insertOne(
      makeTenantRow({
        _id: tenantObjectId,
        slug: "op139-default-threshold",
        counters: { eventCount: 1, activeEventCount: 3 },
      })
    );
    await app.db
      .collection(COLLECTIONS.events)
      .insertMany([
        makeEventRow({ tenantId, status: "published" }),
        makeEventRow({ tenantId, status: "published" }),
        makeEventRow({ tenantId, status: "published" }),
      ]);

    // ── Act ──
    await runReconcile();

    // ── Assert ──
    expect(await abuseEvents()).toHaveLength(1);
  });
});
