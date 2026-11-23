import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postRollupRoute } from "@/app/api/v1/internal/cron/analytics-rollup/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { analyticsRollupJob } from "@/server/jobs/analytics-rollup";
import type { CronRunOptions } from "@/server/jobs/cron-job";
import { fixedClock } from "@/server/runtime/clock";

import { ANALYTICS_METRIC_KEYS } from "../factories/analytics";
import {
  ACTIVITY_AT,
  ACTIVITY_DATE_KEY,
  makeAttendeeProfileRow,
  makeDispatchRow,
  makeEventCreatedRow,
  makeEventImageRow,
  makeEventRow,
  makeFaceMatchRow,
  makeSelfieRow,
  makeTenantRow,
} from "../factories/rollup-jobs";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `analytics-rollup` (OP-139 I1/I6/I7/I8/I9, contract
 * §10.2, §4.5; schema §20.1; ADR-0918).
 *
 * The user story: *as an operator I want a nightly rollup so the dashboards are
 * cheap and the platform has one day's totals for every metric it reports.*
 * `GET /tenants/{tenantId}/analytics` already reads **only** `analyticsDaily`
 * (OP-119, ADR-0642), so this job is the whole writer of that collection: if it
 * writes nothing, every dashboard is empty, and if it writes a different number
 * on a second run for the same day, the dashboards are not reproducible.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/analytics-rollup` exports `analyticsRollupJob: CronJob`
 * (`defineCronJob({ name: "analytics-rollup", … })`), registered in
 * `apps/web/vercel.json` at `02:00` IST daily, and
 * `apps/web/src/app/api/v1/internal/cron/analytics-rollup/route.ts` exports
 * `POST`, guarded by the internal HMAC stage like every other cron route.
 *
 * - **Target day.** `?date=YYYY-MM-DD` names the day to roll up. Absent, the job
 *   rolls up the **Asia/Kolkata day that just closed** (`dateKeyInTimeZone` at
 *   the run instant, minus one day): a `02:00` IST run must not roll up the two
 *   hours of the day it is standing in.
 * - **Scope rows.** One `analyticsDaily` document per `{ scope, dateKey }`,
 *   upserted on `{ "scope.kind", "scope.id", dateKey }`, for `scope.kind`
 *   `tenant`, `event` and `platform`; a `platform` row carries `scope.id: null`
 *   (the shape the shipped `makeAnalyticsDailyRow` fixture already uses). The
 *   `metrics` block is the twelve §20.1 counters, written **in full** on every
 *   row so the read model's `toCount` never has to guess.
 * - **Idempotency.** A second run for the same day leaves every document
 *   identical (same `_id`, same values), because the write is an upsert, not an
 *   insert-then-delete. `computedAt` comes from the injected `Clock`, never the
 *   wall clock (CONVENTIONS §6, ADR-0028).
 * - **Counters.** `eventsCreated` is the day's `event.created` count (the
 *   `domainEvents` roll); the collection counts (`eventImages`, `faceMatches`,
 *   `selfies`, `notificationDispatches`, `billingTransactions`) feed the rest,
 *   and a metric whose source has no rows for the day is `0` — never absent and
 *   never `null`.
 * - **Rerun affordance.** `?date=` reaches the job through the cron framework's
 *   run options (`CronRunOptions.date`, forwarded to `CronJobContext.date`), so
 *   an operator can re-run any day. An invalid `?date=` is refused `422
 *   validation_failed` **before** the job writes anything.
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A5 — "nightly" at `02:00` IST rolls up the **previous** IST day; the card
 *   names the schedule and the rerun affordance but not the anchor, and rolling
 *   up a two-hour-old day every night would leave "yesterday" permanently empty.
 * - A6 — the platform row exists only when the day has activity: the spec never
 *   asks for a synthetic all-zero platform row, because a zero row is
 *   indistinguishable from "the job did not run".
 * - A7 — `OP-152`'s metric list is not in the repository; I6 pins the twelve
 *   §20.1 counters the read model already enforces as the closed set.
 * - A16 — of those twelve, the six with a single unambiguous source are pinned
 *   **by value** (`eventsCreated` ← the day's `event.created` rows,
 *   `imagesUploaded` / `imagesProcessed` / `imagesFailed` ← the day's
 *   `event_images` rows counted all / by `processing.status`, `selfiesUploaded`
 *   ← `selfies`, `matchesCreated` ← `face_matches`, `notificationsSent` ←
 *   `notification_dispatches` in the `sent` state). `uniqueAttendees`,
 *   `storageBytesAdded`, `downloads`, `revenueMinor` and `p95ProcessingMs` are
 *   pinned by **presence and integrality only**: their lineage (a byte total
 *   across `media_assets`, a percentile over processing durations, a
 *   per-subject distinct count) is not stated by the card, so pinning a value
 *   would invent a contract the GREEN would then have to guess.
 * - A17 — a metric counts rows whose own day field falls in the window:
 *   `occurredAt` for `domainEvents`, `createdAt` for the collections. The
 *   fixtures place a row on the previous IST day in the I6 case so a rollup
 *   that ignores the window cannot pass by counting a whole collection.
 */

let app: TestApp;

/** One stored `analyticsDaily` document, as this file reads it (schema §20.1). */
interface StoredRollup {
  readonly _id: unknown;
  readonly scope: { readonly kind: string; readonly id: unknown };
  readonly dateKey: string;
  readonly metrics: Record<string, number>;
  readonly computedAt?: unknown;
  readonly [key: string]: unknown;
}

/** The canonical text of a scope id: hex for an `ObjectId`, the string as stored, `"null"` for the platform scope. */
function scopeIdText(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : "";
}

/** Compare a stored scope id with a fixture one, `null` included. */
function sameId(stored: unknown, expected: unknown): boolean {
  return scopeIdText(stored) === scopeIdText(expected);
}

/**
 * The run options `analytics-rollup` accepts: the bounded framework's own
 * options plus this lane's `?date=` extension (`CronRunOptions.date`,
 * forwarded to `CronJobContext.date`; contract §10.2 plus the GREEN card's
 * "re-runnable for any date via `?date=`").
 *
 * Declared against the framework's own interface rather than derived from the
 * job, so the spec type-checks before the module exists; the intersection stays
 * assignable once the GREEN adds the field — no cast, no production edit.
 */
type RollupRunOptions = CronRunOptions & { readonly date?: string };

/** Run the job at `at`, optionally for an explicit `YYYY-MM-DD` day. */
function runJob(at: Date, date?: string): ReturnType<typeof analyticsRollupJob.run> {
  const options: RollupRunOptions = {
    requestedLimit: null,
    clock: fixedClock(at),
    logger: recordingLogger(),
    ...(date === undefined ? {} : { date }),
  };
  return analyticsRollupJob.run(options);
}

/** Every stored rollup row for one day, ordered by scope. */
async function rowsFor(dateKey: string): Promise<StoredRollup[]> {
  const rows = await app.db
    .collection(COLLECTIONS.analyticsDaily)
    .find({ dateKey })
    .sort({ "scope.kind": 1, "scope.id": 1 })
    .toArray();
  return rows as unknown as StoredRollup[];
}

/** The stored rollup row of one scope on one day, or `undefined`. */
async function rowFor(
  dateKey: string,
  kind: string,
  id: unknown
): Promise<StoredRollup | undefined> {
  return (await rowsFor(dateKey)).find(
    (row) => row.scope.kind === kind && sameId(row.scope.id, id)
  );
}

/** Every stored rollup row, canonicalised so two reads compare as documents. */
async function canonicalRows(): Promise<string[]> {
  const rows = await app.db
    .collection(COLLECTIONS.analyticsDaily)
    .find({})
    .sort({ dateKey: 1, "scope.kind": 1, "scope.id": 1 })
    .toArray();
  return rows.map((row) => JSON.stringify(row));
}

/** Seed one tenant plus one published event inside it, and return both ids. */
async function seedTenantWithEvent(slug: string): Promise<{
  readonly tenantId: string;
  readonly tenantObjectId: ObjectId;
  readonly eventId: ObjectId;
}> {
  const tenantObjectId = new ObjectId();
  const tenantId = tenantObjectId.toHexString();
  const eventId = new ObjectId();
  await app.db
    .collection(COLLECTIONS.tenants)
    .insertOne(makeTenantRow({ _id: tenantObjectId, slug }));
  await app.db
    .collection(COLLECTIONS.events)
    .insertOne(makeEventRow({ _id: eventId, tenantId, status: "published" }));
  return { tenantId, tenantObjectId, eventId };
}

/** The bearer the internal guard accepts in this harness (`CRON_SECRET`). */
function cronAuthorization(): string {
  return `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

/** A `POST` to the rollup cron route, with the harness's own cron secret. */
function rollupRequest(query: string, authorization: string | null = cronAuthorization()): Request {
  return new Request(new URL(`/api/v1/internal/cron/analytics-rollup${query}`, APP_ORIGIN), {
    method: "POST",
    headers: authorization === null ? {} : { authorization },
  });
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op139-rollup" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // `platformSettings` is the singleton's literal name (it is not a COLLECTIONS
  // entry); the rest are the rollup's sources and its own output.
  await Promise.all(
    [
      COLLECTIONS.tenants,
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.attendeeEventProfiles,
      COLLECTIONS.faceMatches,
      COLLECTIONS.selfies,
      COLLECTIONS.dispatches,
      COLLECTIONS.billingTransactions,
      COLLECTIONS.domainEvents,
      COLLECTIONS.analyticsDaily,
      "platformSettings",
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("analytics-rollup I1: the same day rolled twice", () => {
  it("I1: rolling the same date twice leaves every analyticsDaily document identical", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-twice");
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertMany([
        makeEventImageRow({ tenantId, eventId, processingStatus: "processed" }),
        makeEventImageRow({ tenantId, eventId, processingStatus: "queued" }),
      ]);
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertOne(makeEventCreatedRow({ tenantId, eventId }));

    // ── Act: the nightly run for 2026-11-17 ──
    await runJob(ACTIVITY_AT, ACTIVITY_DATE_KEY);
    const first = await canonicalRows();

    // ── Assert: the day produced the tenant's row and the platform row ──
    expect(await rowFor(ACTIVITY_DATE_KEY, "platform", null)).toBeDefined();
    expect(await rowFor(ACTIVITY_DATE_KEY, "tenant", new ObjectId(tenantId))).toBeDefined();
    expect(first.length).toBeGreaterThanOrEqual(2);

    // ── Act: an operator re-runs the same day ──
    await runJob(ACTIVITY_AT, ACTIVITY_DATE_KEY);
    const second = await canonicalRows();

    // ── Assert: identical documents, and no duplicate scope/day pair ──
    expect(second).toEqual(first);
    const keys = (await rowsFor(ACTIVITY_DATE_KEY)).map(
      (row) => `${row.scope.kind}:${scopeIdText(row.scope.id)}:${row.dateKey}`
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("analytics-rollup I6/I7: the written metrics", () => {
  it("I6: the platform row carries every §20.1 metric key, as a whole count", async () => {
    const first = await seedTenantWithEvent("op139-metrics-a");
    const second = await seedTenantWithEvent("op139-metrics-b");
    const third = await seedTenantWithEvent("op139-metrics-c");
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertMany([
        makeEventCreatedRow({ tenantId: first.tenantId, eventId: first.eventId }),
        makeEventCreatedRow({ tenantId: second.tenantId, eventId: second.eventId }),
        makeEventCreatedRow({ tenantId: third.tenantId, eventId: third.eventId }),
      ]);

    // ── Act ──
    await runJob(ACTIVITY_AT, ACTIVITY_DATE_KEY);

    // ── Assert: one platform row, every metric present, all whole counts ──
    const platformRows = (await rowsFor(ACTIVITY_DATE_KEY)).filter(
      (row) => row.scope.kind === "platform"
    );
    expect(platformRows).toHaveLength(1);
    const platform = platformRows.at(0);
    expect(platform).toBeDefined();
    expect(Object.keys(platform?.metrics ?? {}).sort()).toEqual([...ANALYTICS_METRIC_KEYS].sort());
    // Every metric is a whole, non-negative count — never `null`, never a float.
    expect(
      Object.values(platform?.metrics ?? {}).every((value) => Number.isInteger(value) && value >= 0)
    ).toBe(true);
    // The platform aggregate is the day's own total: three `event.created`
    // rows, one per tenant.
    expect(platform?.metrics.eventsCreated).toBe(3);
  });

  it("I6: each collection-backed metric counts its own source rows on the rolled-up day", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-metric-sources");
    const previousDay = new Date("2026-11-16T05:00:00.000Z");
    const profileId = new ObjectId();
    const imageIds = [new ObjectId(), new ObjectId(), new ObjectId()] as const;

    // The day's `event.created` rows: two on the requested day, one the day
    // before, which must not bleed in.
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertMany([
        makeEventCreatedRow({ tenantId, eventId }),
        makeEventCreatedRow({ tenantId, eventId }),
        makeEventCreatedRow({ tenantId, eventId, occurredAt: previousDay }),
      ]);

    await app.db.collection(COLLECTIONS.eventImages).insertMany([
      makeEventImageRow({
        _id: imageIds[0],
        tenantId,
        eventId,
        processingStatus: "processed",
      }),
      makeEventImageRow({
        _id: imageIds[1],
        tenantId,
        eventId,
        processingStatus: "processed",
      }),
      makeEventImageRow({
        _id: imageIds[2],
        tenantId,
        eventId,
        processingStatus: "failed",
      }),
      // An image from the previous day, so a rollup that ignores the day
      // window cannot pass by counting the collection.
      makeEventImageRow({ tenantId, eventId, createdAt: previousDay }),
    ]);

    await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .insertOne(makeAttendeeProfileRow({ _id: profileId, tenantId, eventId }));
    await app.db
      .collection(COLLECTIONS.faceMatches)
      .insertMany([
        makeFaceMatchRow({ profileId, imageId: imageIds[0] }),
        makeFaceMatchRow({ profileId, imageId: imageIds[1] }),
      ]);
    await app.db.collection(COLLECTIONS.selfies).insertOne(makeSelfieRow({ tenantId, eventId }));
    await app.db
      .collection(COLLECTIONS.dispatches)
      .insertMany([makeDispatchRow({ tenantId, eventId }), makeDispatchRow({ tenantId, eventId })]);

    // ── Act ──
    await runJob(ACTIVITY_AT, ACTIVITY_DATE_KEY);

    // ── Assert: every metric with an unambiguous source names its own rows ──
    const platform = await rowFor(ACTIVITY_DATE_KEY, "platform", null);
    expect(platform?.metrics).toMatchObject({
      eventsCreated: 2,
      imagesUploaded: 3,
      imagesProcessed: 2,
      imagesFailed: 1,
      selfiesUploaded: 1,
      matchesCreated: 2,
      notificationsSent: 2,
    });
  });

  it("I7: each tenant and each event gets its own row, and the platform row is their sum", async () => {
    const alpha = await seedTenantWithEvent("op139-alpha");
    const beta = await seedTenantWithEvent("op139-beta");
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertMany([
        makeEventCreatedRow({ tenantId: alpha.tenantId, eventId: alpha.eventId }),
        makeEventCreatedRow({ tenantId: alpha.tenantId, eventId: alpha.eventId }),
        makeEventCreatedRow({ tenantId: beta.tenantId, eventId: beta.eventId }),
      ]);
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertMany([
        makeEventImageRow({ tenantId: alpha.tenantId, eventId: alpha.eventId }),
        makeEventImageRow({ tenantId: alpha.tenantId, eventId: alpha.eventId }),
        makeEventImageRow({ tenantId: alpha.tenantId, eventId: alpha.eventId }),
      ]);

    // ── Act ──
    await runJob(ACTIVITY_AT, ACTIVITY_DATE_KEY);

    // ── Assert: the per-tenant split ──
    const alphaRow = await rowFor(ACTIVITY_DATE_KEY, "tenant", new ObjectId(alpha.tenantId));
    const betaRow = await rowFor(ACTIVITY_DATE_KEY, "tenant", new ObjectId(beta.tenantId));
    expect(alphaRow?.metrics.eventsCreated).toBe(2);
    expect(betaRow?.metrics.eventsCreated).toBe(1);

    // ── Assert: the event's own row carries the event's own uploads ──
    const alphaEventRow = await rowFor(ACTIVITY_DATE_KEY, "event", alpha.eventId);
    expect(alphaEventRow?.metrics.imagesUploaded).toBe(3);

    // ── Assert: the platform row is the tenants' sum, not one tenant's ──
    const platform = await rowFor(ACTIVITY_DATE_KEY, "platform", null);
    expect(platform?.metrics.eventsCreated).toBe(3);
    expect(platform?.metrics.imagesUploaded).toBe(3);
  });
});

describe("analytics-rollup I9: which day a run rolls up", () => {
  it("I9: an explicit date rolls that day, not the day the run happens on", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-explicit-date");
    await app.db.collection(COLLECTIONS.domainEvents).insertMany([
      // Activity on the requested day…
      makeEventCreatedRow({
        tenantId,
        eventId,
        occurredAt: new Date("2026-11-10T06:00:00.000Z"),
      }),
      // …and activity on the day the run itself happens, which must not bleed in.
      makeEventCreatedRow({ tenantId, eventId }),
    ]);

    // ── Act: three days after the day being rolled up ──
    await runJob(new Date("2026-11-20T09:00:00.000Z"), "2026-11-10");

    // ── Assert: the requested day, and only it ──
    const requested = await rowFor("2026-11-10", "platform", null);
    expect(requested?.metrics.eventsCreated).toBe(1);
    expect(await rowsFor(ACTIVITY_DATE_KEY)).toEqual([]);
    expect(await rowsFor("2026-11-20")).toEqual([]);
  });

  it("I9: without a date the run rolls up the Asia/Kolkata day that just closed", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-default-date");
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertOne(makeEventCreatedRow({ tenantId, eventId }));

    // 2026-11-18T02:00 IST — the configured nightly schedule, two hours into the
    // 18th, so the day that just closed is the 17th.
    await runJob(new Date("2026-11-17T20:30:00.000Z"));

    // ── Assert ──
    const closed = await rowFor(ACTIVITY_DATE_KEY, "platform", null);
    expect(closed?.metrics.eventsCreated).toBe(1);
    expect(await rowsFor("2026-11-18")).toEqual([]);
  });
});

describe("analytics-rollup I8: the cron route", () => {
  it("I8: POST with the cron secret and a date rolls that day and answers the CronResult", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-route-date");
    await app.db.collection(COLLECTIONS.domainEvents).insertOne(
      makeEventCreatedRow({
        tenantId,
        eventId,
        occurredAt: new Date("2026-11-10T06:00:00.000Z"),
      })
    );

    // ── Act ──
    const response = await postRollupRoute(rollupRequest("?date=2026-11-10"));

    // ── Assert: the §10.2 envelope, and the day the query named ──
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { job: string; scanned: number };
    expect(payload.job).toBe("analytics-rollup");
    expect(payload.scanned).toBeGreaterThan(0);
    expect(await rowFor("2026-11-10", "platform", null)).toBeDefined();
    expect(await rowsFor(ACTIVITY_DATE_KEY)).toEqual([]);
  });

  it("I8: POST with an invalid date answers 422 validation_failed and writes nothing", async () => {
    const { tenantId, eventId } = await seedTenantWithEvent("op139-route-invalid");
    await app.db
      .collection(COLLECTIONS.domainEvents)
      .insertOne(makeEventCreatedRow({ tenantId, eventId }));

    // ── Act ──
    const response = await postRollupRoute(rollupRequest("?date=2026-13-01"));

    // ── Assert ──
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("validation_failed");
    expect(await canonicalRows()).toEqual([]);
  });

  it("I8: POST without a credential answers 401 internal_auth_failed", async () => {
    // ── Act ──
    const response = await postRollupRoute(rollupRequest("", null));

    // ── Assert ──
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("internal_auth_failed");
  });
});
