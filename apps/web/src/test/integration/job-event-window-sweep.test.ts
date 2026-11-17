import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { eventWindowSweepJob } from "@/server/jobs/event-window-sweep";
import { fixedClock } from "@/server/runtime/clock";

import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `event-window-sweep`, the hourly deadline sweep
 * (OP-136, contract §10.2 `event-window-sweep`; ADR-0849).
 *
 * The user story: *as an organizer I want exactly one warning per deadline, so
 * the upload window closes without a last-minute surprise and the event's
 * lifecycle reflects its clock.*
 *
 * ## The contract this file pins
 *
 * - `@/server/jobs/event-window-sweep` exports `eventWindowSweepJob` (a
 *   `defineCronJob` declaration).
 * - At `uploadWindowEndsAt - 24h` the run emits **one**
 *   `event.upload_window.closing` carrying `{ hoursRemaining: 24, mobile: true }`;
 *   at `-72h` the same key carries `{ hoursRemaining: 72, mobile: false }`
 *   (§10.2: "mobile only at T-24h").
 * - At `startAt - 24h` it emits `event.starting_soon` and moves a `published`
 *   event to `live`; past `endAt` it emits `event.ended` and moves it to
 *   `ended`.
 * - A second run over the same rows emits nothing again — every message is
 *   keyed per event **and per schedule point**, so a duplicate is impossible
 *   even if the dedupeKey write is the only latch.
 * - `CronResult.details` carries `{ closing, closed, startingSoon, ended }`.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The instant every run in this file is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

let app: TestApp;

/** Seed one event whose windows are at the given offsets from {@link NOW}. */
async function seedEvent(offsets: {
  readonly uploadWindowEndsAt: number | null;
  readonly startAt: number;
  readonly endAt: number;
  readonly status?: string;
}): Promise<ObjectId> {
  const eventId = new ObjectId();
  const tenantKey = new ObjectId().toHexString();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id: eventId,
    tenantId: tenantKey,
    name: `event-${eventId.toHexString()}`,
    status: offsets.status ?? "published",
    startAt: new Date(NOW.getTime() + offsets.startAt),
    endAt: new Date(NOW.getTime() + offsets.endAt),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt:
      offsets.uploadWindowEndsAt === null
        ? null
        : new Date(NOW.getTime() + offsets.uploadWindowEndsAt),
    retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    accessLinks: [],
    counters: { imageCount: 0, processedImageCount: 0, failedImageCount: 0 },
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  return eventId;
}

/** The outbox rows for one event key and subject. */
async function messages(eventKey: string, eventId: ObjectId): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey, "subjectRef.id": eventId.toHexString() })
    .toArray();
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-event-window" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [COLLECTIONS.events, COLLECTIONS.domainEvents].map((name) =>
      app.db.collection(name).deleteMany({})
    )
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("event-window-sweep: the upload window", () => {
  it("I4: announces T-24h with the mobile hint once across two runs, and T-72h without it", async () => {
    const atT24h = await seedEvent({
      uploadWindowEndsAt: DAY_MS,
      startAt: 3 * DAY_MS,
      endAt: 4 * DAY_MS,
    });
    const atT72h = await seedEvent({
      uploadWindowEndsAt: 3 * DAY_MS,
      startAt: 4 * DAY_MS,
      endAt: 5 * DAY_MS,
    });

    // ── Act: two consecutive hourly ticks at the same instant ──
    const first = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const second = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: one per event and point, mobile only at T-24h ──
    const closing24 = await messages("event.upload_window.closing", atT24h);
    expect(closing24).toHaveLength(1);
    expect(closing24[0]?.payload).toMatchObject({ hoursRemaining: 24, mobile: true });

    const closing72 = await messages("event.upload_window.closing", atT72h);
    expect(closing72).toHaveLength(1);
    expect(closing72[0]?.payload).toMatchObject({ hoursRemaining: 72, mobile: false });

    expect(first.details?.closing).toBe(2);
    expect(second.details?.closing).toBe(0);
  });

  it("emits event.upload_window.closed once the deadline has passed", async () => {
    const eventId = await seedEvent({
      uploadWindowEndsAt: -HOUR_MS,
      startAt: -3 * DAY_MS,
      endAt: 2 * DAY_MS,
    });

    const first = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const second = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect(await messages("event.upload_window.closed", eventId)).toHaveLength(1);
    expect(first.details?.closed).toBe(1);
    expect(second.details?.closed).toBe(0);
  });
});

describe("event-window-sweep: the event lifecycle", () => {
  it("moves published to live at startAt-24h and announces event.starting_soon once", async () => {
    const eventId = await seedEvent({
      uploadWindowEndsAt: null,
      startAt: DAY_MS,
      endAt: 2 * DAY_MS,
    });

    const first = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const second = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect(row?.status).toBe("live");
    expect(await messages("event.starting_soon", eventId)).toHaveLength(1);
    expect(first.details?.startingSoon).toBe(1);
    expect(second.details?.startingSoon).toBe(0);
  });

  it("moves a published event past its endAt to ended and announces event.ended once", async () => {
    const eventId = await seedEvent({
      uploadWindowEndsAt: -2 * HOUR_MS,
      startAt: -2 * DAY_MS,
      endAt: -HOUR_MS,
    });

    await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });
    const second = await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    const row = await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId });
    expect(row?.status).toBe("ended");
    expect(await messages("event.ended", eventId)).toHaveLength(1);
    expect(second.details?.ended).toBe(0);
  });

  it("leaves a draft and an archived event's status alone", async () => {
    const draft = await seedEvent({
      uploadWindowEndsAt: null,
      startAt: DAY_MS,
      endAt: 2 * DAY_MS,
      status: "draft",
    });
    const archived = await seedEvent({
      uploadWindowEndsAt: null,
      startAt: -2 * DAY_MS,
      endAt: -DAY_MS,
      status: "archived",
    });

    await eventWindowSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    expect((await app.db.collection(COLLECTIONS.events).findOne({ _id: draft }))?.status).toBe(
      "draft"
    );
    expect((await app.db.collection(COLLECTIONS.events).findOne({ _id: archived }))?.status).toBe(
      "archived"
    );
    expect(await messages("event.starting_soon", draft)).toHaveLength(0);
    expect(await messages("event.ended", archived)).toHaveLength(0);
  });
});
