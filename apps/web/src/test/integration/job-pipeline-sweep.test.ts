import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { pipelineSweepJob } from "@/server/jobs/pipeline-sweep";
import { getLogger } from "@/server/logging";
import type { MemoryWorkQueue } from "@/server/adapters/memory-queue";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { fixedClock } from "@/server/runtime/clock";

import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `pipeline-sweep`, the 2-minute recovery sweep
 * (OP-136, contract §10.2 step table, §10.3.3; schema §18.2; ADR-0849).
 *
 * The user story: *as the platform I want bounded, idempotent sweeps so that
 * stuck work recovers and a result that lands after the confirm becomes
 * visible.*
 *
 * ## The contract this file pins
 *
 * - `@/server/jobs/pipeline-sweep` exports `pipelineSweepJob`, a
 *   `defineCronJob` declaration whose `run` closes over `getDb()`; the worker
 *   key is the profile's id for `match_incremental` (§10.4).
 * - The four steps run **in order**: expired leases → `queued` + re-enqueue;
 *   `queued` older than 5 min with no broker ack → re-enqueue; `attempts >=
 *   maxAttempts` → `failed` + one `pipeline.image.failed`; then the
 *   incremental-match enqueue.
 * - The job is idempotent: a second run over the *same* rows enqueues nothing,
 *   fails nothing and emits nothing again.
 * - `CronResult.details` carries `{ requeued, failed, incremental }`, so the
 *   run is observable per step.
 * - A selfie is drained from `q:selfie` with `priority: "high"`; an
 *   incremental run is a `match_incremental` envelope whose `id` is the
 *   **profile** id. Neither ever lands on `q:image`.
 *
 * ## Fixtures
 *
 * Rows are seeded with raw driver calls on `app.db` (the tables' own shape), so
 * the sweep is the only code that runs between the seed and the assertion. The
 * queue is the memoised memory adapter `getWorkQueue()` returns under the test
 * environment; its `outbox` is the observable, read by envelope `id`, which the
 * specs mint per case.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The instant every run in this file is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

let app: TestApp;

/** The event a case's rows hang off. */
interface SeededEvent {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/**
 * Seed one event (contract §4.1, schema §15.1).
 *
 * @param overrides - Fields to replace on the baseline document.
 * @returns The tenant key and the event id.
 */
async function seedEvent(overrides: Record<string, unknown> = {}): Promise<SeededEvent> {
  const eventId = new ObjectId();
  const tenantKey = new ObjectId().toHexString();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id: eventId,
    tenantId: tenantKey,
    name: `event-${eventId.toHexString()}`,
    status: "published",
    startAt: new Date(NOW.getTime() + DAY_MS),
    endAt: new Date(NOW.getTime() + 2 * DAY_MS),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(NOW.getTime() + 7 * DAY_MS),
    retentionExpiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    accessLinks: [],
    counters: { imageCount: 0, processedImageCount: 0, failedImageCount: 0 },
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    ...overrides,
  });
  return { tenantKey, eventId };
}

/**
 * Seed one `event_images` row in the given pipeline state.
 *
 * @param event - The owning event.
 * @param processing - The `processing` sub-document.
 * @param extra - Further top-level fields (e.g. `faceCount`).
 * @returns The image id.
 */
async function seedEventImage(
  event: SeededEvent,
  processing: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<ObjectId> {
  const imageId = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id: imageId,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    assetId: new ObjectId(),
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing,
    faceCount: 0,
    visibility: "visible",
    createdAt: new Date(NOW.getTime() - DAY_MS),
    deletedAt: null,
    ...extra,
  });
  return imageId;
}

/**
 * Seed one `selfies` row (§16.4).
 *
 * @param event - The owning event.
 * @param profileId - The owning profile.
 * @param processing - The `processing` sub-document.
 * @param extra - Further top-level fields.
 * @returns The selfie id.
 */
async function seedSelfie(
  event: SeededEvent,
  profileId: ObjectId,
  processing: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<ObjectId> {
  const selfieId = new ObjectId();
  await app.db.collection(COLLECTIONS.selfies).insertOne({
    _id: selfieId,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    profileId,
    subject: { kind: "anonymous", attendeeSessionId: new ObjectId().toHexString() },
    contentHash: selfieId.toHexString().padEnd(64, "0"),
    assetId: new ObjectId(),
    liveness: { required: true, challengeKind: "gesture" },
    processing,
    isActive: true,
    embedding: [0.1, 0.2, 0.3],
    createdAt: new Date(NOW.getTime() - DAY_MS),
    expireAt: new Date(NOW.getTime() + 89 * DAY_MS),
    ...extra,
  });
  return selfieId;
}

/**
 * Seed one `attendeeEventProfiles` row (§15.3).
 *
 * @param event - The owning event.
 * @param extra - Further top-level fields.
 * @returns The profile id.
 */
async function seedProfile(
  event: SeededEvent,
  extra: Record<string, unknown> = {}
): Promise<ObjectId> {
  const profileId = new ObjectId();
  await app.db.collection(COLLECTIONS.attendeeEventProfiles).insertOne({
    _id: profileId,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    subject: { kind: "anonymous", attendeeSessionId: new ObjectId().toHexString() },
    status: "processing",
    activeSelfieId: null,
    matchCount: 0,
    lastMatchRunAt: null,
    createdAt: new Date(NOW.getTime() - DAY_MS),
    ...extra,
  });
  return profileId;
}

/** The memoised memory queue the app enqueues through. */
function queue(): MemoryWorkQueue {
  return getWorkQueue() as MemoryWorkQueue;
}

/** How many messages the outbox holds for one work item id. */
function queuedFor(id: string): number {
  return queue().outbox.filter((message) => message.envelope.id === id).length;
}

/** The time every case's freshly seeded lease expired at. */
const EXPIRED_LEASE = new Date(NOW.getTime() - 5 * MINUTE_MS);

/** The state an expired, still-owned lease is stored in. */
const LIVE_PROCESSING = {
  status: "processing",
  priority: "normal",
  attempts: 1,
  maxAttempts: 5,
  leaseExpiresAt: EXPIRED_LEASE,
  workerId: "worker-op136",
  queuedAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
  startedAt: new Date(NOW.getTime() - 9 * MINUTE_MS),
  finishedAt: null,
  durationMs: null,
  lastError: null,
  queueRef: null,
};

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-pipeline-sweep" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.selfies,
      COLLECTIONS.attendeeEventProfiles,
      COLLECTIONS.domainEvents,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("pipeline-sweep: expired leases", () => {
  it("I1: requeues one expired lease onto q:image and does not enqueue it a second time", async () => {
    const event = await seedEvent();
    const imageId = await seedEventImage(event, LIVE_PROCESSING);
    const imageHex = imageId.toHexString();
    const logger = recordingLogger();

    // ── Act: first run ──
    const first = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: the row is queued again and the broker saw it once ──
    const row = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
    const processing = row?.processing as Record<string, unknown>;
    expect(processing.status).toBe("queued");
    expect(processing.leaseExpiresAt).toBeNull();
    expect(processing.workerId).toBeNull();
    expect(queuedFor(imageHex)).toBe(1);
    expect(first.job).toBe("pipeline-sweep");
    expect(first.details?.requeued).toBe(1);

    // ── Act: a second run over the same rows ──
    const second = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: idempotent — nothing new was enqueued ──
    expect(queuedFor(imageHex)).toBe(1);
    expect(second.details?.requeued).toBe(0);
  });

  it("I14: puts an expired selfie lease back on q:selfie at high priority, never q:image", async () => {
    const event = await seedEvent();
    const profileId = await seedProfile(event);
    const selfieId = await seedSelfie(event, profileId, {
      ...LIVE_PROCESSING,
      priority: "high",
    });
    const selfieHex = selfieId.toHexString();

    // ── Act ──
    await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: getLogger(),
    });

    // ── Assert: one message, on the selfie queue, kind and priority intact ──
    const messages = queue().outbox.filter((message) => message.envelope.id === selfieHex);
    expect(messages).toHaveLength(1);
    const message = messages.at(0);
    expect(message?.queueKey).toBe("q:selfie");
    expect(message?.envelope.kind).toBe("selfie");
    expect(message?.envelope.priority).toBe("high");
    expect(
      queue().outbox.filter((m) => m.envelope.id === selfieHex && m.queueKey === "q:image")
    ).toHaveLength(0);
  });
});

describe("pipeline-sweep: the attempt budget", () => {
  it("I2: fails an item at maxAttempts and emits exactly one pipeline.image.failed", async () => {
    const event = await seedEvent();
    const imageId = await seedEventImage(event, {
      ...LIVE_PROCESSING,
      status: "queued",
      attempts: 5,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: NOW,
    });
    const imageHex = imageId.toHexString();

    // ── Act ──
    const result = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: terminal state + the event the digest needs ──
    const row = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
    const processing = row?.processing as Record<string, unknown>;
    expect(processing.status).toBe("failed");
    expect((processing.lastError as Record<string, unknown>).code).toBe("max_attempts_exceeded");
    expect(result.details?.failed).toBe(1);

    const events = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: "pipeline.image.failed", "subjectRef.id": imageHex })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(event.tenantKey);
    expect(events[0]?.payload).toMatchObject({ imageId: imageHex });
    expect(queuedFor(imageHex)).toBe(0);

    // ── Act: the very next run ──
    const second = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: no second event, no second write ──
    expect(second.details?.failed).toBe(0);
    expect(
      await app.db
        .collection(COLLECTIONS.domainEvents)
        .countDocuments({ eventKey: "pipeline.image.failed", "subjectRef.id": imageHex })
    ).toBe(1);
  });
});

describe("pipeline-sweep: the incremental match run", () => {
  it("I3: enqueues one match_incremental for a profile whose event has newer faces, once per run window", async () => {
    const event = await seedEvent();
    const selfieId = new ObjectId();
    const profileId = await seedProfile(event, {
      status: "ready",
      activeSelfieId: selfieId,
      lastMatchRunAt: new Date(NOW.getTime() - 2 * 3_600_000),
      matchCount: 4,
    });
    const imageId = await seedEventImage(
      event,
      {
        ...LIVE_PROCESSING,
        status: "done",
        attempts: 1,
        leaseExpiresAt: null,
        finishedAt: new Date(NOW.getTime() - 3_600_000),
      },
      { faceCount: 1 }
    );
    await app.db.collection("imageFaces").insertOne({
      _id: new ObjectId(),
      tenantId: event.tenantKey,
      eventId: event.eventId,
      imageId,
      faceIndex: 0,
      spaceKey: "arcface_r100_512",
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });

    // A profile already searched at this instant: nothing newer, so no run.
    const settledProfileId = await seedProfile(event, {
      status: "ready",
      activeSelfieId: new ObjectId(),
      lastMatchRunAt: NOW,
      matchCount: 2,
    });
    const profileHex = profileId.toHexString();
    const settledHex = settledProfileId.toHexString();

    // ── Act ──
    const first = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: one run, addressed at the profile, on the selfie queue ──
    expect(queuedFor(profileHex)).toBe(1);
    expect(first.details?.incremental).toBe(1);
    expect(queuedFor(settledHex)).toBe(0);

    const messages = queue().outbox.filter((message) => message.envelope.id === profileHex);
    expect(messages).toHaveLength(1);
    const message = messages.at(0);
    expect(message?.envelope.kind).toBe("match_incremental");
    expect(message?.envelope.priority).toBe("high");
    expect(message?.queueKey).toBe("q:selfie");

    // ── Assert: the watermark advanced to this run, so the next tick is silent ──
    const profile = await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: profileId });
    expect((profile?.lastMatchRunAt as Date).toISOString()).toBe(NOW.toISOString());

    // ── Act: the next 2-minute tick ──
    const second = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger: recordingLogger(),
    });

    // ── Assert: exactly one per run window ──
    expect(queuedFor(profileHex)).toBe(1);
    expect(second.details?.incremental).toBe(0);
  });
});
