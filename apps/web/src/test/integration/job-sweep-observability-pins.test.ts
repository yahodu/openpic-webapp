import { Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryWorkQueue } from "@/server/adapters/memory-queue";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import type { CronResult } from "@/server/jobs/cron-job";
import { pipelineSweepJob } from "@/server/jobs/pipeline-sweep";
import { usageThresholdCheckJob } from "@/server/jobs/usage-threshold-check";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { fixedClock } from "@/server/runtime/clock";
import { periodKey } from "@/server/services/entitlements";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — the two observability halves of the OP-136 jobs lane
 * that shipped without a pin (OP-136 follow-up **F1**, ADR-0864; contract §10.2,
 * §18.1; schema §18.1/§18.2).
 *
 * These are **characterization** pins: every case is green on the trunk at the
 * moment it was written (`7b97a584`), and each one is red when the behaviour it
 * names is removed. The two OP-136 job specs (`job-pipeline-sweep.test.ts`,
 * `job-usage-and-invitations.test.ts`) stay `11 passed (11)` either way — that
 * is why this file exists.
 *
 * ## The contract this file pins
 *
 * - **P1** — a **refused** step-2 re-enqueue (a `queued` item past the ack
 *   grace) prints exactly one `queue.enqueue_failed` at `warn`, carrying
 *   `kind: "event_image"` and `queueKey: "q:image"`, and leaves the row
 *   `queued` with no `queueRef`: the durable §18.1 state, not a failed request.
 * - **P2** — a **refused** step-4 `match_incremental` enqueue prints exactly one
 *   `queue.enqueue_failed` carrying `kind: "match_incremental"` and hands
 *   `lastMatchRunAt` back to its pre-run value, because no broker pointer exists
 *   for the run and the next tick must retry it.
 * - **P3** — the control: a **healthy** broker on P1's own seed prints no
 *   `queue.enqueue_failed` at all. Without this arm the two positive pins would
 *   also pass on an implementation that warns on every run.
 * - **P4** — `usage-threshold-check` resolves the entitlement verdict **once per
 *   `(tenantId, entitlementKey)` per run**: three `usageCounters` rows of one key
 *   (two elapsed periods and the live one) read `plans` once, not once per row.
 *
 * ## Measured numbers (throwaway probes, production files restored byte-identically)
 *
 * - P1/P2/P3 on the trunk: `warns: 1` (step-2 refusal, row still `queued`),
 *   `warns: 1` (step-4 refusal, watermark restored) and `warns: 0` (healthy).
 *   With `logger,` dropped from **both** `enqueueWork` call sites in
 *   `pipeline-sweep.ts`, P1 and P2 read `warns: 0` while P3 stays green.
 * - P4 on the trunk: `planReads: 1` with `scanned: 3`. Calling
 *   `checkEntitlement` directly per row (the pre-cache shape) reads `plans`
 *   **3** times for the same three rows. The assertion encodes the number
 *   measured on the trunk (1), not the pre-cache number.
 *
 * ## Fixtures
 *
 * Rows are seeded with raw driver calls on `app.db` (the tables' own shape), so
 * the jobs are the only code between the seed and the assertion. The broker is
 * the memoised memory adapter `getWorkQueue()` returns under the test
 * environment: a case replaces its `enqueue` to make it refuse and restores it
 * in a `finally`, so no case depends on which ran first.
 */

/** The instant every run in this file is timed at (`2026-11` for monthly keys). */
const NOW = new Date("2026-11-17T09:00:00.000Z");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The tenant the usage fixtures are scoped to (a **string**, §14.2). */
const TENANT = "t_op136_observability";

/** The plan key the seeded plan and subscription agree on. */
const PLAN_KEY = "op136-observability-plan";

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
 * @returns The image id.
 */
async function seedEventImage(
  event: SeededEvent,
  processing: Record<string, unknown>
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
  });
  return imageId;
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

/**
 * Seed one `imageFaces` row, the freshness signal step 4 reads.
 *
 * @param event - The owning event.
 * @param createdAt - The instant the face was detected.
 * @returns The face id.
 */
async function seedImageFace(event: SeededEvent, createdAt: Date): Promise<ObjectId> {
  const faceId = new ObjectId();
  await app.db.collection("imageFaces").insertOne({
    _id: faceId,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    imageId: new ObjectId(),
    faceIndex: 0,
    spaceKey: "arcface_r100_512",
    createdAt,
  });
  return faceId;
}

/** The state a `queued` item is stored in when the broker never took it. */
const QUEUED_PROCESSING = {
  status: "queued",
  priority: "normal",
  attempts: 0,
  maxAttempts: 5,
  leaseExpiresAt: null,
  workerId: null,
  queuedAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  lastError: null,
  queueRef: null,
};

/** The memoised memory queue the jobs enqueue through. */
function queue(): MemoryWorkQueue {
  return getWorkQueue() as MemoryWorkQueue;
}

/** How many messages the outbox holds for one work item id. */
function queuedFor(id: string): number {
  return queue().outbox.filter((message) => message.envelope.id === id).length;
}

/**
 * Make the memoised broker refuse every enqueue until the returned undo runs.
 *
 * `enqueueWork` never throws: it catches the refusal, prints the §18.1 warn and
 * answers `{ enqueued: false }`. Replacing the adapter's own method is the only
 * seam needed to reach that arm without mocking a module.
 *
 * @returns The undo, which restores the adapter's own `enqueue`.
 */
function refuseEnqueue(): () => void {
  const broker = queue();
  const original = broker.enqueue.bind(broker);
  broker.enqueue = () => Promise.reject(new Error("broker refused"));
  return () => {
    broker.enqueue = original;
  };
}

/**
 * Count the driver reads of one collection while `body` runs.
 *
 * The wrapper sits on `Collection.prototype.findOne`, so it sees every read the
 * job performs through a repository handle (the handles are thin adapters over
 * the driver's own collection) and attributes each one by its collection name.
 * The original is restored in a `finally`, so a failing body cannot leak the
 * counter into the next case.
 *
 * @param name - The collection whose reads are counted.
 * @param body - The work to run under the counter.
 * @returns The body's result and the number of reads of `name`.
 */
async function countCollectionReads(
  name: string,
  body: () => Promise<CronResult>
): Promise<{ readonly result: CronResult; readonly reads: number }> {
  const prototype = Collection.prototype as unknown as {
    findOne: (this: { readonly collectionName: string }, ...args: unknown[]) => Promise<unknown>;
  };
  const original = prototype.findOne;
  let reads = 0;
  prototype.findOne = function countingFindOne(
    this: { readonly collectionName: string },
    ...args: unknown[]
  ): Promise<unknown> {
    if (this.collectionName === name) {
      reads += 1;
    }
    return original.call(this, ...args);
  };
  try {
    const result = await body();
    return { result, reads };
  } finally {
    prototype.findOne = original;
  }
}

/** Seed the active plan: `events.active` is a monthly, tenant-scoped allowance. */
async function seedPlan(): Promise<void> {
  await app.db.collection(COLLECTIONS.plans).insertOne(
    makePlan({
      key: PLAN_KEY,
      entitlements: {
        "events.active": makeEntitlement({
          limit: 10,
          resetPeriod: "monthly",
          scope: "tenant",
          enforcement: "hard",
        }),
      },
    })
  );
}

/** Seed the live subscription that makes {@link PLAN_KEY} the active plan. */
async function seedActiveSubscription(): Promise<void> {
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: TENANT,
      subscribedPlanKey: PLAN_KEY,
      activePlanKey: PLAN_KEY,
      status: "active",
    })
  );
}

/**
 * Seed one `usageCounters` row (§14.2).
 *
 * @param input - The key, the period, the value and an optional latch.
 * @returns The counter row's id.
 */
async function seedCounter(input: {
  readonly periodKey: string;
  readonly value: number;
  readonly thresholdsNotified?: readonly number[];
}): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.usageCounters).insertOne({
    _id,
    tenantId: TENANT,
    entitlementKey: "events.active",
    periodKey: input.periodKey,
    value: input.value,
    updatedAt: NOW,
    ...(input.thresholdsNotified === undefined
      ? {}
      : { thresholdsNotified: [...input.thresholdsNotified] }),
  });
  return _id;
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-observability" });
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
      COLLECTIONS.plans,
      COLLECTIONS.subscriptions,
      COLLECTIONS.usageCounters,
      COLLECTIONS.entitlementGrants,
      "imageFaces",
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("pipeline-sweep: the §18.1 enqueue warn", () => {
  it("P1: a refused step-2 re-enqueue warns once and leaves the row queued", async () => {
    const event = await seedEvent();
    const imageId = await seedEventImage(event, QUEUED_PROCESSING);
    const imageHex = imageId.toHexString();
    const logger = recordingLogger();

    // ── Act: the broker refuses the re-enqueue ──
    const restore = refuseEnqueue();
    const result = await pipelineSweepJob
      .run({ requestedLimit: null, clock: fixedClock(NOW), logger })
      .finally(restore);

    // ── Assert: exactly one warn, naming the work kind and its queue ──
    const warns = logger.entriesForEvent("queue.enqueue_failed");
    expect(warns).toHaveLength(1);
    const warn = warns.at(0);
    if (warn === undefined) {
      throw new Error("a refused step-2 enqueue printed no queue.enqueue_failed warn");
    }
    expect(warn.level).toBe("warn");
    expect(warn.fields.kind).toBe("event_image");
    expect(warn.fields.queueKey).toBe("q:image");

    // ── Assert: the durable state is unchanged — still queued, no pointer ──
    const row = await app.db.collection(COLLECTIONS.eventImages).findOne({ _id: imageId });
    const processing = row?.processing as Record<string, unknown>;
    expect(processing.status).toBe("queued");
    expect(processing.queueRef).toBeNull();
    expect(queuedFor(imageHex)).toBe(0);
    expect(result.details?.requeued).toBe(0);
  });

  it("P2: a refused step-4 enqueue warns once and restores the match watermark", async () => {
    const event = await seedEvent();
    const since = new Date(NOW.getTime() - 2 * HOUR_MS);
    const profileId = await seedProfile(event, {
      status: "ready",
      activeSelfieId: new ObjectId(),
      lastMatchRunAt: since,
      matchCount: 3,
    });
    const profileHex = profileId.toHexString();
    await seedImageFace(event, new Date(NOW.getTime() - HOUR_MS));
    const logger = recordingLogger();

    // ── Act: the broker refuses the match_incremental enqueue ──
    const restore = refuseEnqueue();
    const result = await pipelineSweepJob
      .run({ requestedLimit: null, clock: fixedClock(NOW), logger })
      .finally(restore);

    // ── Assert: exactly one warn, for the incremental arm ──
    const warns = logger.entriesForEvent("queue.enqueue_failed");
    expect(warns).toHaveLength(1);
    const warn = warns.at(0);
    if (warn === undefined) {
      throw new Error("a refused step-4 enqueue printed no queue.enqueue_failed warn");
    }
    expect(warn.level).toBe("warn");
    expect(warn.fields.kind).toBe("match_incremental");

    // ── Assert: the watermark is handed back, so the next tick retries ──
    const profile = await app.db
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne({ _id: profileId });
    expect((profile?.lastMatchRunAt as Date).toISOString()).toBe(since.toISOString());
    expect(queuedFor(profileHex)).toBe(0);
    expect(result.details?.incremental).toBe(0);
  });

  it("P3: a healthy broker prints no enqueue warn for the same seed as P1", async () => {
    const event = await seedEvent();
    const imageId = await seedEventImage(event, QUEUED_PROCESSING);
    const logger = recordingLogger();

    // ── Act: the broker accepts ──
    const result = await pipelineSweepJob.run({
      requestedLimit: null,
      clock: fixedClock(NOW),
      logger,
    });

    // ── Assert: nothing warned — the warn is a failure signal, not a heartbeat ──
    expect(logger.entriesForEvent("queue.enqueue_failed")).toHaveLength(0);

    // ── Assert: the seed WAS a step-2 candidate, or the arm above is vacuous ──
    expect(result.details?.requeued).toBe(1);
    expect(queuedFor(imageId.toHexString())).toBe(1);
  });
});

describe("usage-threshold-check: one entitlement read per key per run", () => {
  it("P4: three counter rows of one key read the plan once, not once per row", async () => {
    await seedPlan();
    await seedActiveSubscription();
    const livePeriod = periodKey("monthly", NOW);
    // Two elapsed periods and the live one, all one `(tenantId, entitlementKey)`.
    await seedCounter({ periodKey: "2026-09", value: 9 });
    await seedCounter({ periodKey: "2026-10", value: 10, thresholdsNotified: [80, 95, 100] });
    await seedCounter({ periodKey: livePeriod, value: 9 });

    // ── Act: count the driver's `plans` findOne calls for one run ──
    const { result, reads } = await countCollectionReads(COLLECTIONS.plans, async () =>
      usageThresholdCheckJob.run({
        requestedLimit: null,
        clock: fixedClock(NOW),
        logger: recordingLogger(),
      })
    );

    // ── Assert: one resolution for the key, over all three rows ──
    expect(result.scanned).toBe(3);
    expect(reads).toBe(1);

    // ── Assert: the run still did its work (the live row is the only warned one) ──
    expect(result.details?.notified).toBe(1);
    const events = await app.db
      .collection(COLLECTIONS.domainEvents)
      .find({ eventKey: "usage.events.threshold" })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ threshold: 80, percent: 90 });
  });
});
