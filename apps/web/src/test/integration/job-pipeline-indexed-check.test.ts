import { Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { derivePipelineStatus, type ProcessingCounts } from "@/server/events/pipeline";
import { pipelineIndexedCheckJob } from "@/server/jobs/pipeline-indexed-check";
import { createLogger, type LogEntry, type LogTransport } from "@/server/logging";
import { fixedClock } from "@/server/runtime/clock";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger, type RecordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `pipeline-indexed-check`, the every-5-minutes
 * indexing notice (contract §10.2, §4.1; notification design §4.7 line
 * `pipeline.event.indexed`; ADR-0849, ADR-0850, ADR-0852).
 *
 * The user story: *as an organizer I am told once, and only when the event is
 * really searchable, that the indexing of my photos finished.*
 *
 * ## The contract this file pins
 *
 * 1. **Only the `indexed` state is announced.** §4.1's status table is a shipped
 *    decision table in `@/server/events/pipeline` (`derivePipelineStatus`), and
 *    the job must agree with it instead of re-deriving "every image is terminal"
 *    locally: `delayed` (every photo failed) and `partial_failure` (some failed)
 *    are **not** "fully searchable", and an event that is `indexing` has not
 *    finished. This file uses `derivePipelineStatus` as the oracle, never the
 *    arithmetic, so a future change to the table moves the pin with it.
 * 2. **One announcement per event, latched.** §10.2 reads "→ mark indexed"; the
 *    per-event marker (or an equivalent latch) is the observable: a second run
 *    over the same event adds no second `pipeline.event.indexed` row, however far
 *    apart the two runs are (the pin uses 7 h, i.e. a different 6-hour bucket).
 * 3. **The payload marks the first completion.** The row's fan-out needs to know
 *    whether this completion is the event's first, because §4.7 sends the email
 *    "on first completion per event only". The payload key is agreed with the
 *    GREEN card as `notifyByEmail` (a boolean `true` on the first completion; a
 *    later completion must never carry `true`). The name cannot be `email` —
 *    `FORBIDDEN_PAYLOAD_KEYS` in `@/server/domain/domain-events` refuses it.
 * 4. **The OP-126 batch arm runs here.** The OP-126 record's §A1 names this cron
 *    as the caller of `checkUploadBatchTransition`, so a batch whose
 *    `event_images` reached a terminal state **in the worker** (no completion
 *    route ran) still emits exactly one §4.7 summary, and a re-run emits none.
 *
 * ## Why each case is RED at this head
 *
 * - `I1`/`I2`/`I3` — the job's criterion is `processed + failed >= imageCount`,
 *   which collapses `indexed`, `delayed` and `partial_failure` into one state, so
 *   the all-failed and partial events are announced too.
 * - `I4` — the dedupe key carries an absolute 6-hour bucket and no marker is
 *   written, so the second-run event is announced again in the next bucket.
 * - `I5`/`I6` — the payload is `{ eventId, images }`; no first-completion
 *   discriminator exists at all.
 * - `I7`/`I8` — the job never calls `checkUploadBatchTransition`, so a worker-settled
 *   batch emits zero summaries.
 *
 * ## Fixtures
 *
 * Rows are seeded with raw driver calls on `app.db` (the tables' own shape), so
 * the job is the only code that runs between the seed and the assertion. The
 * batch arm's rows deliberately never pass through the completion route: the
 * sessions are already `completed` and the images already `done`, which is the
 * "the worker finished it" state `checkUploadBatchTransition` reads.
 */

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/** The instant every run in the matrix/latch cases is timed at. */
const NOW = new Date("2026-11-17T09:00:00.000Z");

/** The second run's offset — a full 6-hour dedupe bucket later than the first. */
const NEXT_BUCKET_MS = 7 * 3_600_000;

/** The §4.7 upload-session TTL (five days). */
const SESSION_TTL_MS = 5 * DAY_MS;

/** The batch's first session is this old when the run happens (12 minutes). */
const BATCH_AGE_MS = 12 * 60_000;

/** The event key §10.2 announces one event's index completion under. */
const INDEXED_EVENT = "pipeline.event.indexed";

/** The §4.7 batch summary key for a batch with no failure. */
const BATCH_COMPLETED_EVENT = "upload.batch.completed";

let app: TestApp;

/** The event a case's rows hang off. */
interface SeededEvent {
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/**
 * The outbox payload keys a case reads.
 *
 * `notifyByEmail` is the first-completion discriminator agreed with the GREEN
 * card: a boolean `true` on the event's **first** completion only. The name is
 * not `email`, which `FORBIDDEN_PAYLOAD_KEYS` refuses.
 */
interface OutboxPayload extends Record<string, unknown> {
  readonly notifyByEmail?: unknown;
  readonly eventId?: string;
  readonly images?: number;
  readonly batchId?: string;
  readonly fileCount?: number;
}

/** The outbox row fields a case reads. */
interface OutboxRow {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly subjectRef: { readonly kind: string; readonly id: string };
  readonly payload: OutboxPayload;
  readonly dedupeKey?: string;
}

/**
 * Seed one event (contract §4.1, schema §15.1) with the given pipeline counters.
 *
 * @param counters - The three §4.1 counters, which is the whole input of the
 *   status table.
 * @returns The tenant key and the event id.
 */
async function seedEvent(counters: ProcessingCounts): Promise<SeededEvent> {
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
    counters: {
      imageCount: counters.imageCount,
      processedImageCount: counters.processedImageCount,
      failedImageCount: counters.failedImageCount,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    updatedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  });
  return { tenantKey, eventId };
}

/**
 * Replace an event's counters, the way a later upload batch would (§15.1's cache).
 *
 * @param event - The event to grow.
 * @param counters - The counters after the new photos finished.
 */
async function growCounters(event: SeededEvent, counters: ProcessingCounts): Promise<void> {
  await app.db.collection(COLLECTIONS.events).updateOne(
    { _id: event.eventId },
    {
      $set: {
        "counters.imageCount": counters.imageCount,
        "counters.processedImageCount": counters.processedImageCount,
        "counters.failedImageCount": counters.failedImageCount,
      },
    }
  );
}

/**
 * Seed one `event_images` row that belongs to a batch (§16.3).
 *
 * @param event - The owning event.
 * @param input - The batch id and the pipeline status the worker left.
 * @returns The image id.
 */
async function seedBatchImage(
  event: SeededEvent,
  input: { readonly batchId: string; readonly status: string; readonly sequence: number }
): Promise<ObjectId> {
  const imageId = new ObjectId();
  await app.db.collection(COLLECTIONS.eventImages).insertOne({
    _id: imageId,
    tenantId: event.tenantKey,
    eventId: event.eventId,
    assetId: new ObjectId(),
    uploadedByUserId: null,
    uploadBatchId: new ObjectId(input.batchId),
    sequence: input.sequence,
    processing: {
      status: input.status,
      priority: "normal",
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: null,
      workerId: null,
      queuedAt: new Date(NOW.getTime() - BATCH_AGE_MS),
      startedAt: new Date(NOW.getTime() - BATCH_AGE_MS),
      finishedAt: new Date(NOW.getTime() - 60_000),
      durationMs: 60_000,
      lastError: null,
      queueRef: null,
    },
    faceCount: 0,
    visibility: "visible",
    createdAt: new Date(NOW.getTime() - BATCH_AGE_MS),
    deletedAt: null,
  });
  return imageId;
}

/**
 * Seed one `upload_sessions` row of a batch that already finished transferring
 * (§16.2). The completion route is never called: this is the "the worker moved
 * the phase" state the OP-126 record's §A1 routes to the indexed check.
 *
 * @param event - The owning event.
 * @param input - The batch, the uploader and the file the session carried.
 */
async function seedCompletedSession(
  event: SeededEvent,
  input: {
    readonly batchId: string;
    readonly createdByUserId: ObjectId;
    readonly contentHash: string;
    readonly fileName: string;
  }
): Promise<void> {
  const createdAt = new Date(Date.now() - BATCH_AGE_MS);
  await app.db.collection(COLLECTIONS.uploadSessions).insertOne({
    _id: new ObjectId(),
    tenantId: event.tenantKey,
    eventId: event.eventId,
    createdByUserId: input.createdByUserId,
    contentHash: input.contentHash,
    batchId: new ObjectId(input.batchId),
    mode: "single",
    status: "completed",
    fileName: input.fileName,
    declaredSize: 4_096,
    declaredMimeType: "image/jpeg",
    externalRefs: [],
    assetId: null,
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 60_000),
    expireAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
  });
}

/**
 * Run the job once at one instant.
 *
 * @param at - The instant the run's windows are evaluated at.
 * @returns The §10.2 run envelope.
 */
async function runJob(at: Date): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
  return pipelineIndexedCheckJob.run({
    requestedLimit: null,
    clock: fixedClock(at),
    logger: recordingLogger(),
  });
}

/**
 * Read the outbox rows of one event key, oldest first.
 *
 * @param eventKey - The §7 event key to read.
 * @returns The matching outbox rows.
 */
async function outboxFor(eventKey: string): Promise<readonly OutboxRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey })
    .sort({ occurredAt: 1 })
    .toArray();
  return rows as unknown as readonly OutboxRow[];
}

/**
 * Read every `pipeline.event.indexed` row that names one event.
 *
 * @param eventId - The event the row's `subjectRef.id` carries.
 * @returns The matching outbox rows.
 */
async function indexedRowsFor(eventId: ObjectId): Promise<readonly OutboxRow[]> {
  const rows = await app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: INDEXED_EVENT, "subjectRef.id": eventId.toHexString() })
    .toArray();
  return rows as unknown as readonly OutboxRow[];
}

/** A deterministic lowercase hex SHA-256 for a named file. */
function hashFor(name: string): string {
  return name.padEnd(64, "0").slice(0, 64);
}

/**
 * The four shapes of one event's pipeline (§4.1), as the counters a case seeds.
 *
 * The expected status is **not** written here: `derivePipelineStatus` is the
 * oracle, so the matrix and the code under test can never drift apart silently.
 */
const MATRIX_SHAPES: readonly {
  readonly name: string;
  readonly counters: ProcessingCounts;
}[] = [
  {
    name: "allProcessed",
    counters: { imageCount: 4, processedImageCount: 4, failedImageCount: 0 },
  },
  { name: "allFailed", counters: { imageCount: 3, processedImageCount: 0, failedImageCount: 3 } },
  { name: "partial", counters: { imageCount: 3, processedImageCount: 1, failedImageCount: 2 } },
  {
    name: "stillRunning",
    counters: { imageCount: 5, processedImageCount: 2, failedImageCount: 0 },
  },
];

/** The counters of an event every one of whose photos indexed cleanly. */
const ALL_PROCESSED: ProcessingCounts = {
  imageCount: 3,
  processedImageCount: 3,
  failedImageCount: 0,
};

/** The counters of an event every one of whose photos failed. */
const ALL_FAILED: ProcessingCounts = {
  imageCount: 3,
  processedImageCount: 0,
  failedImageCount: 3,
};

/** The counters of an event whose photos partly failed. */
const PARTIAL: ProcessingCounts = {
  imageCount: 4,
  processedImageCount: 1,
  failedImageCount: 3,
};

beforeAll(async () => {
  app = await startTestApp({ prefix: "op136-indexed-check" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.uploadSessions,
      COLLECTIONS.mediaAssets,
      COLLECTIONS.domainEvents,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("pipeline-indexed-check: the §4.1 status matrix", () => {
  it("I1: announces only the event the status table derives as indexed, once, in a four-shape run", async () => {
    // Arrange — the four shapes the contract distinguishes, one run.
    const seeded: { readonly name: string; readonly event: SeededEvent }[] = [];
    for (const shape of MATRIX_SHAPES) {
      seeded.push({ name: shape.name, event: await seedEvent(shape.counters) });
    }
    const eventOf = (name: string): SeededEvent => {
      const found = seeded.find((entry) => entry.name === name);
      if (found === undefined) {
        throw new Error(`the matrix seeded no ${name} event`);
      }
      return found.event;
    };

    // Sanity — the oracle sees the four distinct §4.1 states this case relies on.
    expect(MATRIX_SHAPES.map((shape) => derivePipelineStatus(shape.counters))).toEqual([
      "indexed",
      "delayed",
      "partial_failure",
      "indexing",
    ]);

    // Act — one run over all four events.
    const result = await runJob(NOW);

    // Assert — the clean event is announced exactly once…
    expect(await indexedRowsFor(eventOf("allProcessed").eventId)).toHaveLength(1);

    // …and neither a fully-failed nor a partly-failed event claims to be searchable.
    expect(await indexedRowsFor(eventOf("allFailed").eventId)).toHaveLength(0);
    expect(await indexedRowsFor(eventOf("partial").eventId)).toHaveLength(0);

    // …and an event still indexing is not announced either.
    expect(await indexedRowsFor(eventOf("stillRunning").eventId)).toHaveLength(0);
    expect(await outboxFor(INDEXED_EVENT)).toHaveLength(1);
    expect(result.details?.indexed).toBe(1);
  });

  it("I2: does not announce an event whose derived status is delayed", async () => {
    // Arrange — every photo failed: nothing is indexed, so nothing is searchable.
    const event = await seedEvent(ALL_FAILED);
    expect(derivePipelineStatus(ALL_FAILED)).toBe("delayed");

    // Act
    const result = await runJob(NOW);

    // Assert
    expect(await indexedRowsFor(event.eventId)).toHaveLength(0);
    expect(result.details?.indexed).toBe(0);
  });

  it("I3: does not announce an event whose derived status is partial_failure", async () => {
    // Arrange — some photos indexed, some failed.
    const event = await seedEvent(PARTIAL);
    expect(derivePipelineStatus(PARTIAL)).toBe("partial_failure");

    // Act
    const result = await runJob(NOW);

    // Assert
    expect(await indexedRowsFor(event.eventId)).toHaveLength(0);
    expect(result.details?.indexed).toBe(0);
  });
});

describe("pipeline-indexed-check: the per-event latch", () => {
  it("I4: a second run seven hours later adds no second announcement for the same event", async () => {
    // Arrange — one event that is indexed on the first run.
    const event = await seedEvent(ALL_PROCESSED);
    const first = await runJob(NOW);
    expect(await indexedRowsFor(event.eventId)).toHaveLength(1);
    expect(first.details?.indexed).toBe(1);

    // Act — the next bucket's tick, 7 h later.
    const second = await runJob(new Date(NOW.getTime() + NEXT_BUCKET_MS));

    // Assert — one event, one announcement, however many buckets pass.
    expect(await indexedRowsFor(event.eventId)).toHaveLength(1);
    expect(second.details?.indexed).toBe(0);
  });

  it("I5: the first announcement's payload marks it as the first completion", async () => {
    // Arrange
    const event = await seedEvent(ALL_PROCESSED);

    // Act
    await runJob(NOW);

    // Assert — the row the fan-out reads carries the §4.7 email gate's input.
    const rows = await indexedRowsFor(event.eventId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.payload).toMatchObject({
      notifyByEmail: true,
      eventId: event.eventId.toHexString(),
      images: 3,
    });
    expect(row?.tenantId).toBe(event.tenantKey);
  });

  it("I6: a completion after more photos arrive does not carry the first-completion mark again", async () => {
    // Arrange — the event completes once.
    const event = await seedEvent(ALL_PROCESSED);
    await runJob(NOW);
    expect(await indexedRowsFor(event.eventId)).toHaveLength(1);

    // Act — two more photos are uploaded and the worker finishes them, then the
    // next bucket's tick runs.
    await growCounters(event, { imageCount: 5, processedImageCount: 5, failedImageCount: 0 });
    await runJob(new Date(NOW.getTime() + NEXT_BUCKET_MS));

    // Assert — at most one row carries the mark, and it is the first one: a
    // later completion may be announced, but it must not send the email again.
    const rows = await indexedRowsFor(event.eventId);
    expect(rows.filter((row) => row.payload.notifyByEmail === true)).toHaveLength(1);
  });
});

describe("pipeline-indexed-check: the OP-126 batch arm", () => {
  /**
   * Seed one batch of two files whose images the worker already finished, and
   * return the facts a summary must name.
   *
   * @returns The event, the batch id and the uploader.
   */
  async function seedSettledBatch(): Promise<{
    readonly event: SeededEvent;
    readonly batchId: string;
    readonly uploader: ObjectId;
  }> {
    const event = await seedEvent({ imageCount: 2, processedImageCount: 2, failedImageCount: 0 });
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    await seedCompletedSession(event, {
      batchId,
      createdByUserId: uploader,
      contentHash: hashFor("op136-indexed-check-one"),
      fileName: "DSC_0001.JPG",
    });
    await seedCompletedSession(event, {
      batchId,
      createdByUserId: uploader,
      contentHash: hashFor("op136-indexed-check-two"),
      fileName: "DSC_0002.JPG",
    });
    await seedBatchImage(event, { batchId, status: "done", sequence: 1 });
    await seedBatchImage(event, { batchId, status: "done", sequence: 2 });
    return { event, batchId, uploader };
  }

  it("I7: a batch the worker settled emits exactly one summary on the indexed run", async () => {
    // Arrange — the completion route never ran; only the worker moved the rows.
    const { event, batchId, uploader } = await seedSettledBatch();

    // Act
    await runJob(NOW);

    // Assert — one §4.7 summary, addressed to the batch's uploader.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(event.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(event.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(2);
    expect(
      await outboxFor("upload.batch.completed_with_errors"),
      "a batch with no failure is not an errors summary"
    ).toHaveLength(0);
  });

  it("I8: a second indexed run adds no second batch summary", async () => {
    // Arrange — the batch is settled and already summarised once.
    const { batchId } = await seedSettledBatch();
    await runJob(NOW);
    expect(await outboxFor(BATCH_COMPLETED_EVENT)).toHaveLength(1);

    // Act — the next bucket's tick runs over the same rows.
    await runJob(new Date(NOW.getTime() + NEXT_BUCKET_MS));

    // Assert — one batch is one summary, whichever run observes it.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload.batchId).toBe(batchId);
  });
});

/** The §4.7 summary key for a batch that settled with at least one failed file. */
const BATCH_COMPLETED_WITH_ERRORS_EVENT = "upload.batch.completed_with_errors";

/** The counters of an event the §4.1 table derives as `partial_failure`. */
const PARTIAL_FAILURE_COUNTERS: ProcessingCounts = {
  imageCount: 3,
  processedImageCount: 1,
  failedImageCount: 2,
};

/** The counters of an event the §4.1 table derives as `delayed`. */
const ALL_FAILED_COUNTERS: ProcessingCounts = {
  imageCount: 2,
  processedImageCount: 0,
  failedImageCount: 2,
};

/**
 * Integration / contract — the OP-126 batch arm for the **non-indexed terminal**
 * states (ADR-0859; follow-up to case I7/I8 of ADR-0852).
 *
 * ## Why this block exists
 *
 * I7/I8 pin the arm only for an event whose derived status is `indexed`. The
 * job card scopes the arm to "the batches of **each candidate** event", and
 * `delayed` (every photo failed) and `partial_failure` (some failed) are the
 * other all-terminal states §4.1 names. A batch that settles as
 * `complete_with_errors` inside a partly-failed event must still tell its
 * uploader its batch finished with errors — that is exactly the summary the
 * uploader would otherwise never receive, because the event is deliberately not
 * announced as searchable.
 *
 * So the pins here are the negative control's complement: the same run that must
 * stay silent about `pipeline.event.indexed` must still emit the batch summary,
 * and a re-run must still add none.
 *
 * ## How to read them
 *
 * `derivePipelineStatus` is the oracle for the event status, so a case first
 * proves the seeded shape derives the state it claims, and only then asserts
 * anything about the outbox. Rows are seeded with the raw driver (the worker's
 * own end state); neither the completion route nor `emitDomainEvent` runs
 * between the seed and the assertion.
 */
describe("pipeline-indexed-check: the batch arm for the non-indexed terminal events", () => {
  /**
   * Seed one event whose single batch the worker already settled, with the
   * given per-image pipeline statuses and one completed session per image.
   *
   * @param counters - The event counters, which are the §4.1 table's whole input.
   * @param statuses - Each image's `processing.status`, in sequence order.
   * @returns The event, the batch id and the batch's uploader.
   */
  async function seedSettledFailingBatch(
    counters: ProcessingCounts,
    statuses: readonly string[]
  ): Promise<{
    readonly event: SeededEvent;
    readonly batchId: string;
    readonly uploader: ObjectId;
  }> {
    const event = await seedEvent(counters);
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    let sequence = 0;
    for (const status of statuses) {
      sequence += 1;
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(`op136-batch-arm-${String(sequence)}`),
        fileName: `DSC_1${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status, sequence });
    }
    return { event, batchId, uploader };
  }

  it("I9: a settled batch with a failed file inside a partial_failure event emits one errors summary", async () => {
    // Arrange — one image indexed, two failed: the §4.1 table says partial_failure.
    const { event, batchId, uploader } = await seedSettledFailingBatch(PARTIAL_FAILURE_COUNTERS, [
      "done",
      "failed",
      "failed",
    ]);
    expect(derivePipelineStatus(PARTIAL_FAILURE_COUNTERS)).toBe("partial_failure");

    // Act — the every-5-minutes tick, one run.
    await runJob(NOW);

    // Assert — the uploader is told its batch finished with errors, exactly once…
    const summaries = await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(event.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(event.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(3);

    // …and the same batch is never summarised as a clean completion…
    expect(
      await outboxFor(BATCH_COMPLETED_EVENT),
      "a batch with a failed file is not a clean completion"
    ).toHaveLength(0);

    // …while the event itself is still not announced as searchable (§4.1).
    expect(await indexedRowsFor(event.eventId)).toHaveLength(0);
  });

  it("I10: a settled batch whose every photo failed inside a delayed event emits one errors summary", async () => {
    // Arrange — every photo failed: the §4.1 table says delayed.
    const { event, batchId, uploader } = await seedSettledFailingBatch(ALL_FAILED_COUNTERS, [
      "failed",
      "failed",
    ]);
    expect(derivePipelineStatus(ALL_FAILED_COUNTERS)).toBe("delayed");

    // Act
    await runJob(NOW);

    // Assert — one errors summary for the batch, addressed to its uploader.
    const summaries = await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(event.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(event.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(2);

    // …no clean completion for the same batch…
    expect(
      await outboxFor(BATCH_COMPLETED_EVENT),
      "a batch every photo of which failed is not a clean completion"
    ).toHaveLength(0);

    // …and no index announcement for the event.
    expect(await indexedRowsFor(event.eventId)).toHaveLength(0);
  });

  it("I11: a second run seven hours later adds no second summary for either event", async () => {
    // Arrange — one partial_failure batch and one delayed batch, both settled.
    const partial = await seedSettledFailingBatch(PARTIAL_FAILURE_COUNTERS, [
      "done",
      "failed",
      "failed",
    ]);
    const delayed = await seedSettledFailingBatch(ALL_FAILED_COUNTERS, ["failed", "failed"]);
    await runJob(NOW);
    const firstRun = await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT);
    expect(firstRun).toHaveLength(2);
    expect(firstRun.map((row) => row.payload.batchId).sort()).toEqual(
      [partial.batchId, delayed.batchId].sort()
    );

    // Act — the next bucket's tick, 7 h later, over the same rows.
    await runJob(new Date(NOW.getTime() + NEXT_BUCKET_MS));

    // Assert — one batch is one summary, whichever run observes it.
    const summaries = await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT);
    expect(summaries).toHaveLength(2);
    expect(summaries.filter((row) => row.payload.batchId === partial.batchId)).toHaveLength(1);
    expect(summaries.filter((row) => row.payload.batchId === delayed.batchId)).toHaveLength(1);
    expect(await outboxFor(BATCH_COMPLETED_EVENT)).toHaveLength(0);
  });
});

/**
 * Integration / contract — the scan window advances past the first page
 * (ADR-0860; finding **H1** of the review of the OP-136 GREEN `t_16239628`).
 *
 * ## Why this block exists
 *
 * One run reads at most `limit` events. The shipped page is a fixed slice —
 * `find({ "counters.imageCount": { $gt: 0 } }).limit(limit)`, no sort and no
 * predicate the job's own work clears — and the per-event latch is applied only
 * *inside* the loop, so the same first `limit` rows hold their slots for ever.
 * An event that sits behind them is never announced and its batches are never
 * summarised, however many ticks pass. These cases seed exactly **three**
 * eligible events against a page of **two**, the smallest shape that exposes it.
 *
 * ## How to read them
 *
 * Every assertion is an observable: the `pipeline.event.indexed` outbox rows
 * that name an event, the run's own `details.indexed`, and the
 * `upload.batch.completed` summary of a batch the worker settled. No case names
 * the marker, the sort key, the query, `scanned` or `skipped`, so any
 * implementation that drains the window satisfies them — an ordered cursor, a
 * change-scoped marker or anything else that stops starving the tail.
 *
 * ## Which cases are RED at the RED head
 *
 * `I12`, `I13`, `I14` and `I16` are the pins: at the RED head the third event is
 * never reached, so its announcement (and, for `I14`, its batch summary) never
 * exists. `I16` is the sharpest of them: it puts the starved event behind two
 * `delayed` rows, which never latch, so a window scoped to the latch holds its
 * page for ever. `I15` is a **characterization arm**, green on arrival: it
 * asserts the `delayed` → `indexed` transition, which reddens a "finish" that
 * completes an un-indexed event by marking every evaluated row done.
 */
describe("pipeline-indexed-check: the scan window advances past the first page", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  /**
   * Give one event a batch of two files whose images the worker already
   * finished (§16.2, §16.3).
   *
   * The completion route is never called: the sessions are already `completed`
   * and the images already `done`, which is the state the OP-126 arm reads.
   *
   * @param event - The event that owns the batch.
   * @returns The batch id and the batch's uploader.
   */
  async function seedSettledBatchOf(event: SeededEvent): Promise<{
    readonly batchId: string;
    readonly uploader: ObjectId;
  }> {
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    let sequence = 0;
    for (const name of ["op136-scan-window-one", "op136-scan-window-two"]) {
      sequence += 1;
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(name),
        fileName: `DSC_2${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return { batchId, uploader };
  }

  it("I12: a second run announces the event the first page could not hold", async () => {
    // Arrange — three events that all derive `indexed`, against a page of two.
    const one = await seedEvent(ALL_PROCESSED);
    const two = await seedEvent(ALL_PROCESSED);
    const three = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");

    // Act — two ticks of the every-5-minutes job, each bounded to two events.
    const first = await runJobWithLimit(NOW, 2);
    const second = await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);

    // Assert — the first page announced its two events…
    expect(first.details?.indexed).toBe(2);

    // …and the next tick announces the one that was behind them, not a repeat.
    expect(second.details?.indexed).toBe(1);

    // …so every event, the third included, is announced exactly once.
    expect(await indexedRowsFor(one.eventId)).toHaveLength(1);
    expect(await indexedRowsFor(two.eventId)).toHaveLength(1);
    expect(await indexedRowsFor(three.eventId)).toHaveLength(1);
    expect(await outboxFor(INDEXED_EVENT)).toHaveLength(3);
  });

  it("I13: a third run announces nothing for the page the drain already passed", async () => {
    // Arrange — three indexed events over a page of two, drained by two runs.
    const one = await seedEvent(ALL_PROCESSED);
    const two = await seedEvent(ALL_PROCESSED);
    const three = await seedEvent(ALL_PROCESSED);
    await runJobWithLimit(NOW, 2);
    await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);
    expect(
      await outboxFor(INDEXED_EVENT),
      "two runs must have announced all three events"
    ).toHaveLength(3);

    // Act — the tick after the drain.
    const thirdRun = await runJobWithLimit(new Date(NOW.getTime() + 2 * NEXT_BUCKET_MS), 2);

    // Assert — nothing is announced again, and the window does not wrap onto
    // the page it already passed.
    expect(thirdRun.details?.indexed).toBe(0);
    expect(await outboxFor(INDEXED_EVENT)).toHaveLength(3);
    expect(await indexedRowsFor(one.eventId)).toHaveLength(1);
    expect(await indexedRowsFor(two.eventId)).toHaveLength(1);
    expect(await indexedRowsFor(three.eventId)).toHaveLength(1);
  });

  it("I14: the batch arm summarises a settled batch on an event behind the first page", async () => {
    // Arrange — two plain indexed events and one whose batch the worker settled.
    await seedEvent(ALL_PROCESSED);
    await seedEvent(ALL_PROCESSED);
    const batched = await seedEvent(ALL_PROCESSED);
    const { batchId, uploader } = await seedSettledBatchOf(batched);

    // Act — two ticks, each bounded to two events.
    await runJobWithLimit(NOW, 2);
    await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);

    // Assert — one §4.7 summary for the batch, addressed to its uploader.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(batched.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(batched.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(2);

    // …and a batch with no failure is never an errors summary.
    expect(
      await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT),
      "a batch with no failure is not an errors summary"
    ).toHaveLength(0);
  });

  it("I15: an event that passes through delayed is announced once it reaches indexed", async () => {
    // Arrange — every photo failed, so the event derives `delayed`: nothing is searchable.
    const event = await seedEvent(ALL_FAILED);
    expect(derivePipelineStatus(ALL_FAILED)).toBe("delayed");
    const first = await runJobWithLimit(NOW, 2);
    expect(first.details?.indexed).toBe(0);
    expect(await indexedRowsFor(event.eventId)).toHaveLength(0);

    // Act — the photos are processed again and now all index.
    await growCounters(event, ALL_PROCESSED);
    const second = await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);

    // Assert — the transition to `indexed` is announced once, as a first completion.
    expect(second.details?.indexed).toBe(1);
    const rows = await indexedRowsFor(event.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.notifyByEmail).toBe(true);
  });

  it("I16: an event behind two never-latching rows is still announced", async () => {
    // Arrange — two `delayed` events ahead of the only indexable one. A `delayed`
    // row never latches, so a window whose filter is the latch holds these two
    // slots for ever and the third event is never reached.
    const failedOne = await seedEvent(ALL_FAILED);
    const failedTwo = await seedEvent(ALL_FAILED);
    const indexable = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_FAILED)).toBe("delayed");
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");

    // Act — three ticks of the every-5-minutes job, each bounded to two events.
    await runJobWithLimit(NOW, 2);
    await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);
    await runJobWithLimit(new Date(NOW.getTime() + 2 * NEXT_BUCKET_MS), 2);

    // Assert — the event behind them is announced, exactly once…
    expect(await indexedRowsFor(indexable.eventId)).toHaveLength(1);

    // …the two `delayed` events are never announced at all…
    expect(await indexedRowsFor(failedOne.eventId)).toHaveLength(0);
    expect(await indexedRowsFor(failedTwo.eventId)).toHaveLength(0);

    // …and nothing else was announced in their place.
    expect(await outboxFor(INDEXED_EVENT)).toHaveLength(1);
  });
});

/** The driver's own `Collection#find`, captured before any spy replaces it. */
const driverFind = ((): typeof Collection.prototype.find => {
  const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "find");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("the driver's Collection#find is missing from the prototype");
  }
  return descriptor.value as typeof Collection.prototype.find;
})();

/** The driver's own `find` argument tuple. */
type DriverFindArgs = Parameters<typeof driverFind>;

/** A one-shot driver-read failure, and how to take it back. */
interface InjectedReadFailure {
  /** How many times the injected failure actually fired — the pin is vacuous unless 1. */
  readonly fired: () => number;
  /** Remove the injection. Call it in the same case (a `finally` is best). */
  readonly restore: () => void;
}

/**
 * Arm one transient driver failure on the next `find` of `collectionName`.
 *
 * The error carries `code: 91` (a replica-set election) — the shape of a
 * transient read failure — and it is thrown, never resolved to an empty page:
 * the caller must abort, not silently read a batch that is not there.
 *
 * @param collectionName - The collection whose read fails, matched on `this`.
 * @returns The injection, whose `fired` count proves it was reached.
 */
function failNextFind(collectionName: string): InjectedReadFailure {
  let remaining = 1;
  let fired = 0;
  const spy = vi.spyOn(Collection.prototype, "find").mockImplementation(function (
    this: Collection,
    ...args: DriverFindArgs
  ) {
    if (this.collectionName === collectionName && remaining > 0) {
      remaining -= 1;
      fired += 1;
      throw Object.assign(new Error(`injected failure: find on ${collectionName}`), { code: 91 });
    }
    return driverFind.call(this, ...args);
  } as never);

  return {
    fired: () => fired,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * Arm a driver failure on **every** `find` of `collectionName` whose filter the
 * predicate accepts.
 *
 * `failNextFind` loses its aim after one call, which is the transient read
 * `I17`/`I23` pin. A row that is retried tick after tick needs a failure that is
 * still armed on the next run, and one scoped to the row's own batch: the
 * predicate reads the driver filter, so every other row's arm reads normally and
 * the failure is deterministic for the whole case. The error carries `code: 91`
 * (a replica-set election) like its one-shot sibling, and the counter proves the
 * injection was reached rather than assumed.
 *
 * @param collectionName - The collection whose read fails, matched on `this`.
 * @param accepts - Whether a given driver filter is the read to fail.
 * @returns The injection, whose `fired` count proves every call reached it.
 */
function failFindWhen(
  collectionName: string,
  accepts: (filter: Record<string, unknown>) => boolean
): InjectedReadFailure {
  let fired = 0;
  const spy = vi.spyOn(Collection.prototype, "find").mockImplementation(function (
    this: Collection,
    ...args: DriverFindArgs
  ) {
    const filter: unknown = args[0];
    if (
      this.collectionName === collectionName &&
      typeof filter === "object" &&
      filter !== null &&
      accepts(filter as Record<string, unknown>)
    ) {
      fired += 1;
      throw Object.assign(new Error(`injected failure: find on ${collectionName}`), { code: 91 });
    }
    return driverFind.call(this, ...args);
  } as never);

  return {
    fired: () => fired,
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * Integration / contract — the batch arm's work survives a run that aborts
 * inside it (ADR-0866 §1; finding **M2** of the review of the OP-136 GREEN
 * `t_6a0e3e55`).
 *
 * ## Why this block exists
 *
 * A run evaluates an event (and records that it did) before the OP-126 batch arm
 * runs for the same page. When the arm's own read fails — a transient driver
 * error, or an invocation killed mid-run — the run rejects after the event's row
 * has already been marked as evaluated. If nothing brings that row back into a
 * page, the next tick scans nothing and this batch's §4.7 summary is never
 * emitted for that counter state: the uploader is never told its batch finished,
 * and no later tick can tell them.
 *
 * ## How to read it
 *
 * The case names no marker, no ordering and no query. It seeds one event the
 * status table derives as `indexed` with one worker-settled batch, arms a
 * **one-shot** failure on the arm's own read, and asserts only what the API
 * consumer observes: the first run resolves with `errors: 1` and no summary,
 * and the run after it leaves exactly one `upload.batch.completed` row for that
 * batch, naming its batch, event and file count. Any implementation that keeps
 * the row a candidate until its arm work completes satisfies it — retrying the
 * arm, stamping after the arm, or anything else that stops the row leaving the
 * page early.
 *
 * ## Why it was RED at its own RED head
 *
 * At the ADR-0866 RED head the mark landed in the announcement loop, before the
 * arm: run 1 stamped the row and then aborted, so run 2 reported `scanned: 0,
 * details.batches: 0` and the outbox held no `upload.batch.completed` row for
 * the batch at all. Under ADR-0871 §1 the same run now contains the row failure
 * (`errors: 1`) instead of rejecting, and the retry property below is
 * unchanged.
 */
describe("pipeline-indexed-check: the batch arm's work survives an aborted run", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  /**
   * Give one event a batch of two files whose images the worker already
   * finished (§16.2, §16.3) — the state the OP-126 arm reads.
   *
   * The completion route is never called: the sessions are already `completed`
   * and the images already `done`.
   *
   * @param event - The event that owns the batch.
   * @returns The batch id and the batch's uploader.
   */
  async function seedSettledBatchOf(event: SeededEvent): Promise<{
    readonly batchId: string;
    readonly uploader: ObjectId;
  }> {
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    let sequence = 0;
    for (const name of ["op136-arm-retry-one", "op136-arm-retry-two"]) {
      sequence += 1;
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(name),
        fileName: `DSC_3${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return { batchId, uploader };
  }

  it("I17: the next run still summarises the batch whose run aborted in the arm", async () => {
    // Arrange — one event the status table derives as indexed, one settled batch,
    // and a one-shot read failure armed on the arm's own read.
    const event = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const { batchId, uploader } = await seedSettledBatchOf(event);
    const injection = failNextFind(COLLECTIONS.eventImages);
    try {
      // Act — the first tick fails inside the arm, and the run contains it: the
      // failure is counted in the envelope, not thrown out of the run
      // (ADR-0871 §1). Asserting the resolved envelope, not a bare `catch`, is
      // what a containment that still rejects a one-row chunk cannot pass.
      await expect(
        runJobWithLimit(NOW, 50),
        "a row whose own arm work throws must be counted, not thrown out of the run"
      ).resolves.toMatchObject({ errors: 1 });
    } finally {
      injection.restore();
    }
    expect(injection.fired(), "the injected read failure must have fired exactly once").toBe(1);
    expect(
      await outboxFor(BATCH_COMPLETED_EVENT),
      "the aborted run cannot have summarised the batch it never read"
    ).toHaveLength(0);

    // Act — the next tick, over the same rows and unchanged counters.
    await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 50);

    // Assert — the batch's work is not lost: one §4.7 summary for it, exactly
    // once, naming what the summary's email rule reads.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(
      summaries,
      "a batch whose arm work was cut off must be summarised by a later run"
    ).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(event.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(event.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(2);

    // …and a batch with no failure is never an errors summary.
    expect(
      await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT),
      "a batch with no failure is not an errors summary"
    ).toHaveLength(0);
  });

  /**
   * ADR-0866 §1 — a row does not leave the page until its arm work completes.
   *
   * `I17` pins **one** abort. An implementation that re-stamps a latched row
   * before its arm still passes `I17`, and loses the summary if the next run
   * aborts as well; this is the repeat-abort shape of the same requirement. It
   * names no marker, no ordering and no query (ADR-0866 §3), so any
   * implementation that keeps the row a candidate until its arm completes
   * satisfies it however many runs abort in a row.
   */
  it("I23: two aborts in a row still leave the batch summarised once", async () => {
    // Arrange — one event the status table derives as indexed, one worker-settled
    // batch, and the same transient read failure available to two ticks running.
    const event = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const { batchId, uploader } = await seedSettledBatchOf(event);

    // Act — the first tick fails inside the arm, and the run contains it…
    const firstAbort = failNextFind(COLLECTIONS.eventImages);
    try {
      await expect(
        runJobWithLimit(NOW, 50),
        "the first tick's row failure must be counted, not thrown out of the run"
      ).resolves.toMatchObject({ errors: 1 });
    } finally {
      firstAbort.restore();
    }
    expect(firstAbort.fired(), "the first injected read failure must have fired exactly once").toBe(
      1
    );
    expect(
      await outboxFor(BATCH_COMPLETED_EVENT),
      "an aborted run cannot have summarised the batch it never read"
    ).toHaveLength(0);

    // Act — …and the tick after it fails inside the arm again over the same
    // rows, and is contained too: the row has to still be a candidate, or the
    // repeat failure is never even measured.
    const secondAbort = failNextFind(COLLECTIONS.eventImages);
    try {
      await expect(
        runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 50),
        "the second tick's row failure must be counted too, not thrown out of the run"
      ).resolves.toMatchObject({ errors: 1 });
    } finally {
      secondAbort.restore();
    }
    expect(
      secondAbort.fired(),
      "the second injected read failure must have fired exactly once"
    ).toBe(1);
    expect(
      await outboxFor(BATCH_COMPLETED_EVENT),
      "two aborted runs cannot have summarised the batch either"
    ).toHaveLength(0);

    // Act — the third tick, over the same rows and unchanged counters.
    await runJobWithLimit(new Date(NOW.getTime() + 2 * NEXT_BUCKET_MS), 50);

    // Assert — two aborts in a row lose nothing: one §4.7 summary for the batch,
    // exactly once, naming what the summary's email rule reads.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(
      summaries,
      "a batch whose arm work was cut off twice must still be summarised by a later run"
    ).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.tenantId).toBe(event.tenantKey);
    expect(summary?.subjectRef).toEqual({ kind: "user", id: uploader.toHexString() });
    expect(summary?.payload.batchId).toBe(batchId);
    expect(summary?.payload.eventId).toBe(event.eventId.toHexString());
    expect(summary?.payload.fileCount).toBe(2);

    // …and a batch with no failure is never an errors summary.
    expect(
      await outboxFor(BATCH_COMPLETED_WITH_ERRORS_EVENT),
      "a batch with no failure is not an errors summary"
    ).toHaveLength(0);
  });
});

/**
 * Characterization / contract — the §10.2 backpressure field `hasMore`
 * (ADR-0866 §2).
 *
 * An earlier record of this lane declared `scanned`, `skipped` and `hasMore`
 * deliberately unpinned; these two cases pin the observable half. `hasMore` is
 * what tells the scheduler to invoke again sooner: a run that filled its page
 * must ask for another (or the tail of a backlog waits a whole interval — the
 * starvation H1 pinned), and a run over a drained window must not (or a drained
 * board spins the scheduler for ever).
 *
 * Both cases are **green on arrival**: they exist so a later "optimisation"
 * cannot turn `hasMore` into a constant in either direction. Neither reads
 * `scanned` as a contract — the page size is the case's own input, and only
 * `hasMore` is asserted.
 */
describe("pipeline-indexed-check: the §10.2 backpressure field", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  it("I18: a run that filled its page reports hasMore true", async () => {
    // Arrange — three indexed events behind a page of two: the page fills and an
    // event is left unread.
    await seedEvent(ALL_PROCESSED);
    await seedEvent(ALL_PROCESSED);
    await seedEvent(ALL_PROCESSED);

    // Act
    const run = await runJobWithLimit(NOW, 2);

    // Assert — the scheduler is asked to come back for the work left behind.
    expect(
      run.hasMore,
      "a full page leaves events unread, so the run must ask for another invocation"
    ).toBe(true);
  });

  it("I19: a run over a drained window reports hasMore false", async () => {
    // Arrange — two indexed events behind a page of two; the first tick drains
    // both, which the outbox shows.
    const one = await seedEvent(ALL_PROCESSED);
    const two = await seedEvent(ALL_PROCESSED);
    await runJobWithLimit(NOW, 2);
    expect(
      await outboxFor(INDEXED_EVENT),
      "the draining tick must have announced both events"
    ).toHaveLength(2);

    // Act — the tick after the drain.
    const run = await runJobWithLimit(new Date(NOW.getTime() + NEXT_BUCKET_MS), 2);

    // Assert — nothing is left to read, so the window does not ask to be re-run…
    expect(run.hasMore, "a drained window must not keep asking for another invocation").toBe(false);

    // …and it did not re-announce what it had already drained.
    expect(await indexedRowsFor(one.eventId)).toHaveLength(1);
    expect(await indexedRowsFor(two.eventId)).toHaveLength(1);
  });
});

/**
 * Characterization / contract — the indexed check's **grouped** batch discovery
 * and its `limit` budget (ADR-0869 §1–§2; finding **F1** of the review of the
 * OP-136 GREEN `t_eeb212c2`, PR #661 / squash `d28cddd1`, which shipped
 * ADR-0862's grouped read).
 *
 * ## Why this block exists
 *
 * ADR-0862 replaced the per-event `event_images` read with **one grouped
 * aggregation per tenant in the candidate page** (`$match` on the page's event
 * ids, `$group` on `(eventId, uploadBatchId)`, then `$sort` and a `$limit` of
 * the run's remaining budget), and the arm stops collecting at `limit`. The
 * cases above assert emitted summaries, and every one of their fixtures gives
 * each event its own tenant (`seedEvent` mints a fresh tenant per call), so the
 * two paths that distinguish the grouped read were unpinned: the grouping only
 * ever saw a one-event `$in`, and no case asked the run's `details.batches` to
 * stay inside `limit`.
 *
 * ## How to read them
 *
 * Both cases assert only what the outbox and the run envelope show. Neither
 * names the aggregation, its sort key or a query, so any discovery that finds
 * every candidate event's batches whatever tenant they share, and keeps the
 * page's work inside `limit`, satisfies them.
 *
 * Which *pairs* win a truncated page is deliberately **not** pinned (ADR-0862
 * §Assumptions **A2**): the bounded case asserts the count and that every
 * emitted summary names a seeded batch, never which batch a later page carries.
 */
describe("pipeline-indexed-check: the grouped batch discovery and its limit budget", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  /**
   * Seed one event into a tenant the caller chooses.
   *
   * `seedEvent` mints a fresh tenant per call, which is why no case above can
   * put two events of one workspace on a page. The row is written by `seedEvent`
   * and then re-homed with the raw driver, so the document keeps the one shape
   * the fixture already owns.
   *
   * @param tenantKey - The tenant both events of a case belong to.
   * @param counters - The three §4.1 counters, which is the whole input of the
   *   status table.
   * @returns The tenant key and the event id, addressed to the shared tenant.
   */
  async function seedEventForTenant(
    tenantKey: string,
    counters: ProcessingCounts
  ): Promise<SeededEvent> {
    const seeded = await seedEvent(counters);
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: seeded.eventId }, { $set: { tenantId: tenantKey } });
    return { tenantKey, eventId: seeded.eventId };
  }

  /**
   * Give one event one worker-settled batch of a single file (§16.2, §16.3).
   *
   * The completion route is never called: the session is already `completed`
   * and the image already `done`, which is the "the worker finished it" state
   * the OP-126 arm reads — case `I7`'s shape, one file instead of two.
   *
   * @param event - The event that owns the batch.
   * @param name - A name unique to the batch, which seeds its `contentHash`.
   * @returns The batch id and the batch's uploader.
   */
  async function seedSettledOneFileBatch(
    event: SeededEvent,
    name: string
  ): Promise<{ readonly batchId: string; readonly uploader: ObjectId }> {
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    await seedCompletedSession(event, {
      batchId,
      createdByUserId: uploader,
      contentHash: hashFor(name),
      fileName: "DSC_5001.JPG",
    });
    await seedBatchImage(event, { batchId, status: "done", sequence: 1 });
    return { batchId, uploader };
  }

  it("I20: two changed events of one tenant are both discovered on one page", async () => {
    // Arrange — one workspace, two events, one worker-settled batch each.
    const tenantKey = new ObjectId().toHexString();
    const first = await seedEventForTenant(tenantKey, ALL_PROCESSED);
    const second = await seedEventForTenant(tenantKey, ALL_PROCESSED);
    const firstBatch = await seedSettledOneFileBatch(first, "op136-grouped-first");
    const secondBatch = await seedSettledOneFileBatch(second, "op136-grouped-second");
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");

    // Act — one run, room for both events and both batches.
    const run = await runJobWithLimit(NOW, 50);

    // Assert — the discovery counted both of the tenant's pairs…
    expect(run.details?.batches).toBe(2);

    // …and each batch is summarised on its own, naming its own event, uploader
    // and file count: a discovery whose `$in` narrows to one event id, or that
    // drops a tenant's later event, leaves one of these two missing.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(summaries).toHaveLength(2);
    const byBatch = new Map(summaries.map((row) => [String(row.payload.batchId), row]));
    expect([...byBatch.keys()].sort()).toEqual([firstBatch.batchId, secondBatch.batchId].sort());

    const firstSummary = byBatch.get(firstBatch.batchId);
    expect(firstSummary?.tenantId).toBe(tenantKey);
    expect(firstSummary?.subjectRef).toEqual({
      kind: "user",
      id: firstBatch.uploader.toHexString(),
    });
    expect(firstSummary?.payload.eventId).toBe(first.eventId.toHexString());
    expect(firstSummary?.payload.fileCount).toBe(1);

    const secondSummary = byBatch.get(secondBatch.batchId);
    expect(secondSummary?.tenantId).toBe(tenantKey);
    expect(secondSummary?.subjectRef).toEqual({
      kind: "user",
      id: secondBatch.uploader.toHexString(),
    });
    expect(secondSummary?.payload.eventId).toBe(second.eventId.toHexString());
    expect(secondSummary?.payload.fileCount).toBe(1);
  });

  it("I21: the discovery is bounded at the run's limit", async () => {
    // Arrange — one event with three distinct worker-settled batches.
    const event = await seedEvent(ALL_PROCESSED);
    const batches = [
      await seedSettledOneFileBatch(event, "op136-budgeted-one"),
      await seedSettledOneFileBatch(event, "op136-budgeted-two"),
      await seedSettledOneFileBatch(event, "op136-budgeted-three"),
    ];

    // Act — a run allowed the work of two batches.
    const run = await runJobWithLimit(NOW, 2);

    // Assert — the run's own counter is the bounded one, not all three pairs…
    expect(run.details?.batches).toBe(2);

    // …and the arm did only that much work: two summaries, no repeat, each one
    // naming one of the seeded batches of the event.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(summaries).toHaveLength(2);
    const summarised = summaries.map((row) => String(row.payload.batchId));
    expect(new Set(summarised).size).toBe(2);
    const seeded = batches.map((batch) => batch.batchId);
    expect(seeded.filter((batchId) => summarised.includes(batchId))).toHaveLength(2);
    expect(summaries.map((row) => row.payload.eventId)).toEqual([
      event.eventId.toHexString(),
      event.eventId.toHexString(),
    ]);
  });
});

/**
 * Characterization — the **per-tenant** early stop of the grouped batch
 * discovery (ADR-0876 §1–§2; finding **F2** of the review of the OP-136 pin
 * card `t_b730389c`, PR #673 / squash `7e3f642d`).
 *
 * ## Why this block exists
 *
 * `pendingBatches` reads one aggregate **per tenant in the candidate page**, and
 * each tenant's read is capped at `limit - pending.length`. The block above pins
 * the grouping (`I20`) and that budget (`I21`), but both of their fixtures put a
 * single tenant on the page: `I20`'s two events share one workspace and `I21`'s
 * three batches share one event. So the loop never reached a **second** tenant
 * with the budget already spent, and the guard that keeps the next read legal —
 * the early stop before each tenant's aggregate — was unpinned.
 *
 * The failure that guard prevents is not "one extra batch": without it the
 * second tenant's aggregate is sent with `$limit: 0`, which MongoDB rejects
 * (`the limit must be positive`, code 15958), so the **whole run** rejects and
 * every candidate of the page loses its arm work.
 *
 * ## How to read it
 *
 * The case asserts only what the run envelope and the outbox show: the run
 * settles, `details.batches` is the budget, and the summaries that landed are the
 * first tenant's. Which of that tenant's three batches win is deliberately
 * **not** pinned (ADR-0862 §A2), and neither is the mixed `ObjectId`/24-hex
 * batch-id form (§16.3).
 */
describe("pipeline-indexed-check: the per-tenant early stop of the batch discovery", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  /**
   * Seed one event into a tenant the caller chooses.
   *
   * `seedEvent` mints a fresh tenant per call, so the row is written by the
   * fixture and then re-homed with the raw driver — the shape `I20` uses to put
   * two events of one workspace on a page.
   *
   * @param tenantKey - The tenant the event belongs to.
   * @param counters - The three §4.1 counters, which is the whole input of the
   *   status table.
   * @returns The tenant key and the event id, addressed to the shared tenant.
   */
  async function seedEventForTenant(
    tenantKey: string,
    counters: ProcessingCounts
  ): Promise<SeededEvent> {
    const seeded = await seedEvent(counters);
    await app.db
      .collection(COLLECTIONS.events)
      .updateOne({ _id: seeded.eventId }, { $set: { tenantId: tenantKey } });
    return { tenantKey, eventId: seeded.eventId };
  }

  /**
   * Give one event one worker-settled batch of a single file (§16.2, §16.3).
   *
   * The completion route is never called: the session is already `completed`
   * and the image already `done`, which is the "the worker finished it" state
   * the OP-126 arm reads — case `I7`'s shape, one file instead of two.
   *
   * @param event - The event that owns the batch.
   * @param name - A name unique to the batch, which seeds its `contentHash`.
   * @returns The batch id and the batch's uploader.
   */
  async function seedSettledOneFileBatch(
    event: SeededEvent,
    name: string
  ): Promise<{ readonly batchId: string; readonly uploader: ObjectId }> {
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    await seedCompletedSession(event, {
      batchId,
      createdByUserId: uploader,
      contentHash: hashFor(name),
      fileName: "DSC_5101.JPG",
    });
    await seedBatchImage(event, { batchId, status: "done", sequence: 1 });
    return { batchId, uploader };
  }

  it("I22: a tenant whose read spends the run's budget leaves the next tenant's read unrun", async () => {
    // Arrange — tenant A: one changed event with three worker-settled batches;
    // tenant B: one changed event with one. A's event is seeded first, so it is
    // the page's first candidate (`_id: 1`) and its tenant's read comes first.
    const tenantA = new ObjectId().toHexString();
    const tenantB = new ObjectId().toHexString();
    const eventA = await seedEventForTenant(tenantA, ALL_PROCESSED);
    const eventB = await seedEventForTenant(tenantB, ALL_PROCESSED);
    const batchesA = [
      await seedSettledOneFileBatch(eventA, "op136-early-stop-a1"),
      await seedSettledOneFileBatch(eventA, "op136-early-stop-a2"),
      await seedSettledOneFileBatch(eventA, "op136-early-stop-a3"),
    ];
    const batchB = await seedSettledOneFileBatch(eventB, "op136-early-stop-b1");

    // Sanity — the page is the two events in `_id` order, so tenant A's read is
    // the one that spends the budget. Without this the case would measure the
    // other tenant and pass for the wrong reason.
    expect(
      eventA.eventId.toHexString() < eventB.eventId.toHexString(),
      "tenant A's event must be the page's first candidate"
    ).toBe(true);

    // Act — a run allowed the work of two batches: tenant A alone asks for
    // three, so its read consumes the budget before tenant B is reached. A
    // rejected run here (a zero `$limit` on B's read) is the pinned failure.
    const run = await runJobWithLimit(NOW, 2);

    // Assert — the run settled, and its counter is the budget…
    expect(run.details?.batches, "the page's work stays inside the run's limit").toBe(2);

    // …and the work is tenant A's: two summaries for two of its three batches,
    // none for tenant B's single batch.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(
      summaries,
      "the arm must stop at the budget instead of reading the second tenant"
    ).toHaveLength(2);
    const aBatchIds = batchesA.map((batch) => batch.batchId);
    const summarised = summaries.map((row) => String(row.payload.batchId));
    expect(new Set(summarised).size, "one summary per batch").toBe(2);
    expect(
      summarised.filter((batchId) => aBatchIds.includes(batchId)),
      "both summaries name a batch of the tenant whose read spent the budget"
    ).toHaveLength(2);
    expect(summarised, "tenant B's batch is behind the spent budget").not.toContain(batchB.batchId);
    expect(
      summaries.map((row) => row.tenantId),
      "both rows belong to tenant A"
    ).toEqual([tenantA, tenantA]);
    expect(summaries.map((row) => String(row.payload.eventId))).toEqual([
      eventA.eventId.toHexString(),
      eventA.eventId.toHexString(),
    ]);
  });
});

/**
 * Characterization / contract — an event's own batches are **all** driven, not
 * just the last pair the discovery returns for it (ADR-0867 §1.2; finding
 * **F1** of the review of the OP-136 GREEN `t_bf0ae9ae`, PR #670 / head
 * `1b38307d`).
 *
 * ## Why this block exists
 *
 * The run groups the discovery's `(event, batch)` pairs by the event that owns
 * them, and each candidate row then drives the pairs of **its own** event id.
 *
 * The arm that appends to an event's list (`owned.push(batch)`) is already
 * reached by `I21` and by `I22`: both seed one event with three settled batches
 * and run with a `limit` of two, so the page carries **two** of that event's
 * pairs. Neither of them pins the grouping, though — they pin the budget and
 * the per-tenant early stop, and `I21`'s third batch is deliberately never
 * discovered, so a grouping that keeps one pair per event is caught there only
 * as a side effect of a page that a budget truncated.
 *
 * `I24` is the case that pins the grouping itself: one event, two of its
 * batches, `requestedLimit: 50` so no budget cuts the page, and both ids named
 * in the outbox. `I25` closes the last window a page size can hide: it puts
 * **three** of one event's batches on the page with the same room to spare and
 * names all three, so a grouping bounded to the last two pairs of an event —
 * which every other case of this file still passes — is red there.
 *
 * ## How to read it
 *
 * The case seeds one event the status table derives as `indexed` and gives it
 * two worker-settled batches of two files each, both uploaded by the same user.
 * It asserts only what the outbox shows: exactly two `upload.batch.completed`
 * rows, whose payload `batchId`s are the two seeded ids. Which of the two is
 * written first is **not** pinned — the discovery's sort order is ADR-0862
 * §1's business, not this contract's — so the ids are compared as a sorted
 * array. Any grouping that keeps every pair of the event satisfies it.
 * `I25` repeats the shape with three settled batches, where a last-two grouping reds.
 */
describe("pipeline-indexed-check: an event's settled batches are each summarised, not just its last two", () => {
  /**
   * Run the job once at one instant, over a caller-chosen page size.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @param limit - The per-run cap the run is asked for.
   * @returns The §10.2 run envelope.
   */
  async function runJobWithLimit(
    at: Date,
    limit: number
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: limit,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  /**
   * Give one event one worker-settled batch of two files (§16.2, §16.3), the
   * shape `I17`'s `seedSettledBatchOf` uses.
   *
   * The completion route is never called: the sessions are already `completed`
   * and the images already `done`, which is the "the worker finished it" state
   * the OP-126 arm reads.
   *
   * @param event - The event that owns the batch.
   * @param input - The batch's uploader and a slug unique to the batch, which
   *   seeds its `contentHash` and `fileName`.
   * @returns The batch id.
   */
  async function seedTwoFileBatchOf(
    event: SeededEvent,
    input: { readonly uploader: ObjectId; readonly slug: string }
  ): Promise<string> {
    const batchId = new ObjectId().toHexString();
    for (const sequence of [1, 2]) {
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: input.uploader,
        contentHash: hashFor(`${input.slug}-${String(sequence)}`),
        fileName: `DSC-${input.slug}-${String(sequence)}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return batchId;
  }

  it("I24: an event with two settled batches gets both summaries", async () => {
    // Arrange — one event the status table derives as indexed, two distinct
    // worker-settled batches of two files each, both uploaded by the same user.
    const event = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const uploader = new ObjectId();
    const firstBatchId = await seedTwoFileBatchOf(event, {
      uploader,
      slug: "op136-grouped-batch-one",
    });
    const secondBatchId = await seedTwoFileBatchOf(event, {
      uploader,
      slug: "op136-grouped-batch-two",
    });

    // Act — one run with room for both of the event's batches.
    const run = await runJobWithLimit(NOW, 50);

    // Sanity — the discovery found both pairs, so a missing summary below is the
    // grouping dropping one, not a discovery that never saw it.
    expect(
      run.details?.batches,
      "both of the event's settled batches must be on the run's page"
    ).toBe(2);

    // Assert — each of the event's batches is summarised on its own: a grouping
    // that keeps only the last pair of an event leaves the first one missing.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(
      summaries,
      "an event that owns two settled batches must be summarised for both"
    ).toHaveLength(2);
    expect(
      summaries.map((row) => String(row.payload.batchId)).sort(),
      "the two summaries name the two batches the event owns"
    ).toEqual([firstBatchId, secondBatchId].sort());
  });

  it("I25: an event with three settled batches gets three summaries", async () => {
    // Arrange — one event the status table derives as indexed, three distinct
    // worker-settled batches of two files each, all uploaded by the same user.
    const event = await seedEvent(ALL_PROCESSED);
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const uploader = new ObjectId();
    const batchIds = [
      await seedTwoFileBatchOf(event, { uploader, slug: "op136-triple-batch-one" }),
      await seedTwoFileBatchOf(event, { uploader, slug: "op136-triple-batch-two" }),
      await seedTwoFileBatchOf(event, { uploader, slug: "op136-triple-batch-three" }),
    ];

    // Act — one run with room to spare, so no budget can truncate the event's
    // own pairs: a missing summary below is the grouping dropping it.
    const run = await runJobWithLimit(NOW, 50);

    // Sanity — the discovery found all three pairs, so the grouping saw them.
    expect(
      run.details?.batches,
      "all three of the event's settled batches must be on the run's page"
    ).toBe(3);

    // Assert — each batch of the event is summarised on its own: a grouping
    // bounded to the last two pairs of an event leaves the first one missing.
    const summaries = await outboxFor(BATCH_COMPLETED_EVENT);
    expect(
      summaries,
      "an event that owns three settled batches must be summarised for all three"
    ).toHaveLength(3);
    expect(
      summaries.map((row) => String(row.payload.batchId)).sort(),
      "the three summaries name the three batches the event owns"
    ).toEqual([...batchIds].sort());
  });
});

/** The §10.2 key a contained per-row failure must be named under (ADR-0871 §1). */
const ROW_FAILED_EVENT = "pipeline.indexed_check.row_failed";

/**
 * Integration / contract — a persistently failing row is contained, counted and
 * named (ADR-0871; decision of record: card `t_39d7b19f`, option 1, taken on
 * finding **F2** of the round-1 review of the OP-136 GREEN `t_bf0ae9ae`,
 * PR #670 / head `1b38307d` / squash `40b65309`).
 *
 * ## Why this block exists
 *
 * The shipped run drives its candidate page in chunks of `ROW_CHECK_CONCURRENCY`
 * = 8 and rethrows the first rejection after the chunk settles, and every job
 * hardcodes `errors: 0`. A row whose own OP-126 batch-arm work throws
 * **persistently** — not the transient read `I17`/`I23` pin — therefore rejects
 * every tick for as long as it exists: the cron 500s on each tick, `errors`
 * cannot tell that run from a clean one, the poison row itself is never named,
 * and only the rows of its own chunk that started before it make progress. The
 * reviewer measured that shape at `1b38307d` (one poison row as the lowest
 * `_id`, ten healthy `indexed` events, `requestedLimit: 12`, three ticks):
 * `{"tick":0,"rejected":true,"announcedAfterTick":8}`,
 * `{"tick":1,…11}`, `{"tick":2,…11}`, so the defect is a **permanent run
 * failure plus a throughput cap of `ROW_CHECK_CONCURRENCY - 1` = 7 rows per
 * tick**, not permanent head-of-line blocking.
 *
 * ## The contract these cases pin
 *
 * 1. the failing row cannot abort the run: the run resolves, `scanned` is the
 *    page it read, and `errors` counts the failure;
 * 2. the remaining rows **and later chunks** keep running in the same run, so a
 *    healthy row of the **second** chunk is announced by the run the poison row
 *    failed in;
 * 3. each failing row is named once, at `warn`, under
 *    `pipeline.indexed_check.row_failed`, with its event id and the thrown error
 *    carried alongside;
 * 4. the failing row keeps its `pipeline.indexedCheckedCounters` triple
 *    unstamped, so it stays a candidate and a later tick retries the arm's work
 *    (ADR-0866 §1 / ADR-0867 §1 unchanged: nothing is lost, only deferred).
 *
 * ## How to read them
 *
 * The poison row is the **lowest** `_id` of an `_id`-ascending page and its
 * `event_images` read throws on **every** call — scoped to that event, so no
 * other row's arm sees the failure and the case is deterministic. Every
 * assertion is what an API consumer observes: the run envelope (`scanned`,
 * `errors`), the `pipeline.event.indexed` and `upload.batch.completed` rows the
 * outbox holds, the row's own stored triple, and the run's own log lines. No
 * case names the chunking, the catch, the query or the sort.
 *
 * ## Which cases are RED at this head
 *
 * - `I26` — the run rejects today, so a page of nine candidates with one poison
 *   row never reaches its second chunk.
 * - `I27` — no `pipeline.indexed_check.row_failed` line exists at this head at
 *   all, so it reddens on its own arm even once `I26` is satisfied.
 * - `I28` is a **characterization** pin (green on arrival): it asserts the half
 *   the shipped ordering already gives — the row keeps its triple and stays a
 *   candidate — so a reviewer does not read it as new coverage.
 * - `I29` is the negative control: a clean page of the same size reports no
 *   failure and names no row, so neither `errors` nor the warn can become a
 *   constant in either direction.
 */
describe("pipeline-indexed-check: a persistently failing row is contained, counted and named", () => {
  /**
   * The page every case reads: one candidate more than `ROW_CHECK_CONCURRENCY`
   * (8), so the last candidate is alone in the run's **second** chunk.
   */
  const PAGE_SIZE = 9;

  /** The per-run cap every case asks for — room for the whole page. */
  const PAGE_LIMIT = 12;

  /** One seeded candidate of the page: the event, its settled batch, its uploader. */
  interface PageRow {
    readonly event: SeededEvent;
    readonly batchId: string;
    readonly uploader: ObjectId;
  }

  /** The run envelope plus the logger that recorded the run. */
  interface RecordedRun {
    readonly result: Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>;
    readonly log: RecordingLogger;
  }

  /**
   * Run the job once over the block's page, keeping its log.
   *
   * The contract is that a failing row cannot abort the run, so a rejection is
   * reported as this block's own assertion failure: the message names the shape
   * that was expected instead of leaving a raw driver error behind.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @returns The envelope and the lines the run wrote.
   */
  async function runPage(at: Date): Promise<RecordedRun> {
    const log = recordingLogger();
    try {
      const result = await pipelineIndexedCheckJob.run({
        requestedLimit: PAGE_LIMIT,
        clock: fixedClock(at),
        logger: log,
      });
      return { result, log };
    } catch (error) {
      throw new Error(
        `a row whose own arm work throws must not abort the run; it rejected with: ${String(error)}`
      );
    }
  }

  /**
   * Run one tick whose envelope is **not** the case's subject.
   *
   * `I28` reads the row state two ticks leave behind, and that state is the same
   * whether the tick resolved (containment) or rejected (the shipped head), so
   * the outcome is deliberately not inspected here.
   *
   * @param at - The instant the tick's windows are evaluated at.
   */
  async function tickWithoutReadingTheEnvelope(at: Date): Promise<void> {
    try {
      await pipelineIndexedCheckJob.run({
        requestedLimit: PAGE_LIMIT,
        clock: fixedClock(at),
        logger: recordingLogger(),
      });
    } catch {
      // The row state is the observable; `I26` owns the envelope's shape.
    }
  }

  /**
   * Run one tick and keep its log, whatever the envelope did.
   *
   * `I27` reads the lines the run wrote, and the run that must write them is the
   * one the poison row fails in — so a rejection here is not the case's subject
   * either.
   *
   * @param at - The instant the tick's windows are evaluated at.
   * @returns The logger the run wrote into.
   */
  async function tickKeepingTheLog(at: Date): Promise<RecordingLogger> {
    const log = recordingLogger();
    try {
      await pipelineIndexedCheckJob.run({
        requestedLimit: PAGE_LIMIT,
        clock: fixedClock(at),
        logger: log,
      });
    } catch {
      // As above: the lines, not the envelope, are this tick's output.
    }
    return log;
  }

  /**
   * Seed one `indexed` candidate (contract §4.1) whose two-file batch the worker
   * already settled (§16.2, §16.3) — `I7`'s shape, which the OP-126 arm
   * summarises as a clean `upload.batch.completed`.
   *
   * @param slug - A name unique to the candidate, which seeds its content hashes.
   * @returns The event, its batch id and the batch's uploader.
   */
  async function seedCandidate(slug: string): Promise<PageRow> {
    const event = await seedEvent(ALL_PROCESSED);
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    for (const sequence of [1, 2]) {
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(`${slug}-${String(sequence)}`),
        fileName: `DSC_9${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return { event, batchId, uploader };
  }

  /**
   * Seed the block's page: the poison row **first** — so it is the lowest `_id`
   * of the `_id`-ascending page — then the healthy candidates.
   *
   * @returns The poison row, the healthy rows (in page order) and the one that
   *   lands in the run's second chunk.
   */
  async function seedPage(): Promise<{
    readonly poison: PageRow;
    readonly healthy: readonly PageRow[];
    readonly secondChunk: PageRow;
  }> {
    const poison = await seedCandidate("op136-poison-row-poison");
    const healthy: PageRow[] = [];
    for (let index = 1; index < PAGE_SIZE; index += 1) {
      healthy.push(await seedCandidate(`op136-poison-row-healthy-${String(index)}`));
    }
    const secondChunk = healthy[healthy.length - 1];
    if (secondChunk === undefined) {
      throw new Error("the page must hold a candidate in the run's second chunk");
    }
    return { poison, healthy, secondChunk };
  }

  /**
   * Seed a page of the same size with no row failing.
   *
   * @returns The page's candidates, in `_id` order.
   */
  async function seedCleanPage(): Promise<readonly PageRow[]> {
    const page: PageRow[] = [];
    for (let index = 0; index < PAGE_SIZE; index += 1) {
      page.push(await seedCandidate(`op136-poison-row-clean-${String(index)}`));
    }
    return page;
  }

  /**
   * Arm the poison shape on one event's batch: every `event_images` read of that
   * event throws, for the whole case.
   *
   * @param eventId - The event whose batch reads fail.
   * @returns The injection, whose `fired` count proves every call reached it.
   */
  function poisonBatchReads(eventId: ObjectId): InjectedReadFailure {
    return failFindWhen(
      COLLECTIONS.eventImages,
      (filter) => filter.eventId instanceof ObjectId && filter.eventId.equals(eventId)
    );
  }

  /**
   * The `upload.batch.completed` rows that name one batch.
   *
   * @param batchId - The batch id the summary's payload carries.
   * @returns The matching outbox rows.
   */
  async function completedSummariesFor(batchId: string): Promise<readonly OutboxRow[]> {
    return (await outboxFor(BATCH_COMPLETED_EVENT)).filter(
      (row) => String(row.payload.batchId) === batchId
    );
  }

  it("I26: the run a poison row fails in still reaches its second chunk", async () => {
    // Arrange — nine `_id`-ascending candidates: the first is the poison row, and
    // the ninth is alone in the run's second chunk.
    const { poison, healthy, secondChunk } = await seedPage();
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const pageOrder = [poison, ...healthy].map((row) => row.event.eventId.toHexString());
    expect(
      pageOrder,
      "the page must be `_id`-ascending, or the poison row is not the one the run reaches first"
    ).toEqual([...pageOrder].sort());

    // Act — one run, with the poison row's own batch read failing on every call.
    const injection = poisonBatchReads(poison.event.eventId);
    try {
      const run = await runPage(NOW);

      // Sanity — the armed read was reached, or the case proves nothing.
      expect(
        injection.fired(),
        "the poison row's arm read must have failed, or the seed is not poison"
      ).toBeGreaterThanOrEqual(1);

      // Assert — the failure was contained: the whole page was read and counted.
      expect(run.result.scanned, "a contained failure does not shorten the page").toBe(PAGE_SIZE);
      expect(run.result.errors, "one failing row is one counted error").toBe(1);

      // …the healthy rows of both chunks were announced by this same run…
      const announced = await Promise.all(healthy.map((row) => indexedRowsFor(row.event.eventId)));
      expect(
        announced.map((rows) => rows.length),
        "every healthy row of the page is announced once, in the run the poison row failed in"
      ).toEqual(healthy.map(() => 1));

      // …the second chunk's row included: a run that stops at the failing chunk
      // leaves exactly this one missing.
      expect(
        await indexedRowsFor(secondChunk.event.eventId),
        "the second chunk of the page must run in the same run the poison row failed in"
      ).toHaveLength(1);
    } finally {
      injection.restore();
    }
  });

  it("I27: the failing row is named once, at warn, under its own event id", async () => {
    // Arrange — the same page, the same poison row.
    const { poison } = await seedPage();
    const injection = poisonBatchReads(poison.event.eventId);
    try {
      // Act — one run, keeping the lines it writes.
      const log = await tickKeepingTheLog(NOW);

      // Sanity — the armed read was reached, so a missing line is the missing warn.
      expect(
        injection.fired(),
        "the poison row's arm read must have failed, or the seed is not poison"
      ).toBeGreaterThanOrEqual(1);

      // Assert — one line, at warn, naming the row by its event id.
      const named = log.entriesForEvent(ROW_FAILED_EVENT);
      expect(named, "a row whose own arm work throws must be named exactly once").toHaveLength(1);
      expect(named[0]?.level, "a contained row failure is a warning, not a run failure").toBe(
        "warn"
      );
      expect(named[0]?.fields.eventId, "the line must name the failing event").toBe(
        poison.event.eventId.toHexString()
      );

      // …and the thrown error travels with the line, whichever field carries it.
      const carried = JSON.stringify(named[0]?.fields ?? {}, (_key, value: unknown) =>
        value instanceof Error ? value.message : value
      );
      expect(carried, "the warn must carry the thrown error").toContain(
        `injected failure: find on ${COLLECTIONS.eventImages}`
      );
    } finally {
      injection.restore();
    }
  });

  it("I28 (characterization): a contained row keeps its triple and is retried until its arm reads", async () => {
    // Arrange — the same page, the same poison row.
    const { poison } = await seedPage();
    const injection = poisonBatchReads(poison.event.eventId);
    try {
      // Act — two ticks whose envelopes are not this case's subject.
      await tickWithoutReadingTheEnvelope(NOW);
      await tickWithoutReadingTheEnvelope(new Date(NOW.getTime() + NEXT_BUCKET_MS));

      // Assert — both ticks reached the poison row's arm again: the row stayed a
      // candidate instead of leaving the page with its work undone.
      expect(
        injection.fired(),
        "each tick must reach the poison row's read again, or the retry was never measured"
      ).toBeGreaterThanOrEqual(2);

      const stored = (await app.db
        .collection(COLLECTIONS.events)
        .findOne({ _id: poison.event.eventId })) as unknown as {
        readonly pipeline?: { readonly indexedCheckedCounters?: unknown };
      } | null;
      expect(
        stored?.pipeline?.indexedCheckedCounters,
        "a row whose arm work failed must keep its checked triple unstamped"
      ).toBeUndefined();
      expect(
        await completedSummariesFor(poison.batchId),
        "no summary exists while the row's arm cannot read its batch"
      ).toHaveLength(0);
    } finally {
      injection.restore();
    }

    // Act — the read is cleared: the next tick over the same rows.
    await runPage(new Date(NOW.getTime() + 2 * NEXT_BUCKET_MS));

    // Assert — the deferred work is done once, naming what the summary's email
    // rule reads. Nothing was lost while the row was poisoned.
    const summaries = await completedSummariesFor(poison.batchId);
    expect(
      summaries,
      "the retried row's own batch must be summarised exactly once, by the tick that can read it"
    ).toHaveLength(1);
    expect(summaries[0]?.payload.eventId).toBe(poison.event.eventId.toHexString());
    expect(summaries[0]?.subjectRef).toEqual({ kind: "user", id: poison.uploader.toHexString() });
    expect(summaries[0]?.payload.fileCount).toBe(2);
  });

  it("I29: a clean page of the same size reports no failure and announces every row once", async () => {
    // Arrange — the same page shape, with no row's batch read failing.
    const page = await seedCleanPage();
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");

    // Act
    const run = await runPage(NOW);

    // Assert — nothing failed, so the envelope and the log say so…
    expect(run.result.scanned, "a clean page is read whole").toBe(PAGE_SIZE);
    expect(run.result.errors, "a clean page must not report an error").toBe(0);
    expect(
      run.log.entriesForEvent(ROW_FAILED_EVENT),
      "a clean page has no failing row to name"
    ).toHaveLength(0);

    // …and every row of the page is announced, and its settled batch summarised,
    // exactly once.
    const announced = await Promise.all(page.map((row) => indexedRowsFor(row.event.eventId)));
    expect(
      announced.map((rows) => rows.length),
      "every row of a clean page is announced once"
    ).toEqual(page.map(() => 1));
    expect(
      (await outboxFor(BATCH_COMPLETED_EVENT)).map((row) => String(row.payload.batchId)).sort(),
      "every row's settled batch is summarised once"
    ).toEqual(page.map((row) => row.batchId).sort());
  });

  /**
   * Seed the page `I31` reads: **two** failing rows inside the run's first
   * chunk and a third alone in its second chunk.
   *
   * Two failing rows in **one** chunk is the load-bearing part. A page with one
   * failing row per chunk does **not** discriminate the granularity of the
   * count or of the name: counting once per chunk lands on the same total, and
   * naming the chunk's first failing row names the same rows. Only a chunk that
   * holds two failures separates a per-row containment from a per-chunk one.
   *
   * @returns The first chunk's two poison rows, the healthy rows between them
   *   (in page order), and the second chunk's poison row.
   */
  async function seedMultiPoisonPage(): Promise<{
    readonly firstChunkPoison: readonly PageRow[];
    readonly secondChunkPoison: PageRow;
    readonly healthy: readonly PageRow[];
  }> {
    const firstChunkPoison: PageRow[] = [
      await seedCandidate("op136-multi-row-poison-first"),
      await seedCandidate("op136-multi-row-poison-second"),
    ];
    const healthy: PageRow[] = [];
    for (let index = firstChunkPoison.length; index < PAGE_SIZE - 1; index += 1) {
      healthy.push(await seedCandidate(`op136-multi-row-poison-healthy-${String(index)}`));
    }
    const secondChunkPoison = await seedCandidate("op136-multi-row-poison-ninth");
    return { firstChunkPoison, secondChunkPoison, healthy };
  }

  /**
   * Arm the poison shape on **several** events at once: every `event_images`
   * read of any of them throws, for the whole case.
   *
   * One injection, not one per event: `failFindWhen` installs a spy on the
   * driver's `find`, so a second armed injection would stand in front of the
   * first and only the later event would fail.
   *
   * @param eventIds - The events whose batch reads fail.
   * @returns The injection, whose `fired` count proves every call reached it.
   */
  function poisonBatchReadsFor(eventIds: readonly ObjectId[]): InjectedReadFailure {
    return failFindWhen(
      COLLECTIONS.eventImages,
      (filter) =>
        filter.eventId instanceof ObjectId &&
        eventIds.some((poisoned) => (filter.eventId as ObjectId).equals(poisoned))
    );
  }

  /**
   * `I31` — the granularity of both the count and the name.
   *
   * The decided contract (ADR-0871 §1) counts the failure **per row**
   * (`errors += 1`) and names **each** failing row once. The one-poison-row page
   * of `I26`/`I27` cannot pin that: the chunk-level near-fix answers
   * `29 passed (29)` against it, and a page with **one failing row per chunk**
   * answers `30 passed (30)` too, because a per-chunk count lands on the same
   * total and names the same rows. Only a chunk that holds **two** failing rows
   * separates the two shapes, so this page carries two in the first chunk and a
   * third alone in the second.
   */
  it("I31: every failing row is counted and named, including two in one chunk", async () => {
    // Arrange — nine `_id`-ascending candidates: two poison rows lead the page
    // (chunk 1), the ninth is the third poison row and chunk 2's only candidate.
    const { firstChunkPoison, secondChunkPoison, healthy } = await seedMultiPoisonPage();
    const poisoned = [...firstChunkPoison, secondChunkPoison];
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const pageOrder = [...firstChunkPoison, ...healthy, secondChunkPoison].map((row) =>
      row.event.eventId.toHexString()
    );
    expect(
      pageOrder,
      "the page must be `_id`-ascending, or the poison rows are not the rows the run reaches first and ninth"
    ).toEqual([...pageOrder].sort());
    expect(firstChunkPoison, "two of the first chunk's eight slots must fail").toHaveLength(2);
    expect(
      healthy,
      "the rest of chunk 1 is healthy, so the second chunk holds the ninth row alone"
    ).toHaveLength(PAGE_SIZE - poisoned.length);

    // Act — one run, with every poison row's own batch read failing on every call.
    const injection = poisonBatchReadsFor(poisoned.map((row) => row.event.eventId));
    try {
      const run = await runPage(NOW);

      // Sanity — every armed row was reached, or the case proves nothing.
      expect(
        injection.fired(),
        "every poison row's arm read must have failed, or the seed is not poison"
      ).toBeGreaterThanOrEqual(poisoned.length);

      // Assert — the failure is counted per row: two in one chunk count twice.
      expect(run.result.scanned, "a contained failure does not shorten the page").toBe(PAGE_SIZE);
      expect(
        run.result.errors,
        "three failing rows are three counted errors — the count is per row, not per chunk"
      ).toBe(poisoned.length);

      // …and each failing row is named once, at warn, under its own event id.
      const named = run.log.entriesForEvent(ROW_FAILED_EVENT);
      expect(
        named.map((entry) => entry.level),
        "each failing row is named exactly once, as a warning — two of them in the same chunk"
      ).toEqual(poisoned.map(() => "warn"));
      expect(
        named.map((entry) => String(entry.fields.eventId)).sort(),
        "the warns name exactly the failing rows — every row that failed, and no other"
      ).toEqual(poisoned.map((row) => row.event.eventId.toHexString()).sort());

      // …the healthy rows of both chunks are announced once each…
      const announced = await Promise.all(healthy.map((row) => indexedRowsFor(row.event.eventId)));
      expect(
        announced.map((rows) => rows.length),
        "every healthy row of the page is announced once, in the run the poison rows failed in"
      ).toEqual(healthy.map(() => 1));

      // …and every failing row keeps its checked triple unstamped, in either
      // chunk, so all of them stay candidates for a later tick.
      const stamped = await Promise.all(
        poisoned.map(
          async (row) =>
            (
              (await app.db
                .collection(COLLECTIONS.events)
                .findOne({ _id: row.event.eventId })) as unknown as {
                readonly pipeline?: { readonly indexedCheckedCounters?: unknown };
              } | null
            )?.pipeline?.indexedCheckedCounters
        )
      );
      expect(
        stamped,
        "a row whose arm work failed keeps its checked triple unstamped, in either chunk"
      ).toEqual(poisoned.map(() => undefined));
    } finally {
      injection.restore();
    }
  });
});

/** The stored fields of an event row the discovery-abort case reads. */
interface DiscoveryAbortRow {
  readonly pipeline?: {
    readonly indexedCheckedCounters?: unknown;
    readonly indexedNotifiedAt?: unknown;
  } | null;
}

/**
 * Characterization / contract — a throw from the **grouped batch discovery**
 * aborts the whole indexed-check run and stamps nothing, so the page retries as
 * a whole (ADR-0867 §2; ADR-0872 §Review — round 1, finding **F3** of the review
 * of the OP-136 GREEN `t_05687f95`, PR #741 / squash `b3f63308`; card
 * `t_b13a68d7`, record ADR-0883).
 *
 * ## Why this block exists
 *
 * ADR-0872 §1 contains a **row's** failure: a candidate whose own OP-126 batch
 * arm throws is counted in `errors`, named at `warn` and left unstamped, and the
 * page keeps running (`I26`–`I29`). The other half of ADR-0867 §2 is the
 * opposite: the run's **page-level** read — `pendingBatches`'s grouped
 * `event_images` aggregate — is not contained. When it throws, discovery itself
 * has failed, so no candidate row can be evaluated at all: the run rejects,
 * nothing is stamped and nothing is emitted, and the next tick retries the same
 * page.
 *
 * That half was claimed by ADR-0872 §3 to be pinned by `I22`, and it was not:
 * `I22` is ADR-0876's per-tenant early-stop case, and no case in this file made
 * an `aggregate` throw at all before this one. The property was true at the
 * trunk only because it had been measured out of band, so a change that wrapped
 * the discovery in a `catch` — silently turning a broken page read into a
 * permanent `errors` count and a page that never advances — would have passed
 * every case here.
 *
 * ## How to read it
 *
 * The failure is armed on the **collection**, not on a tenant or an event, and
 * it stays armed for the whole first tick: this case is about the run's page
 * read, not about a transient one-off. Every assertion is an observable — the
 * run's own rejection, the stored `pipeline` fields of the seeded events, the
 * outbox count, and, once the injection is cleared, the envelope of the tick
 * that follows. No assertion names the query, the grouping, the sort or the
 * catch, and nothing pins *when* the abort happens relative to the page read
 * beyond the fact that no row was reached.
 *
 * This is a **characterization** pin (green on arrival): the shipped head
 * already aborts the run, and the case exists so that it cannot stop.
 */
describe("pipeline-indexed-check: a throw from the grouped batch discovery aborts the whole run", () => {
  /** The driver's own `Collection#aggregate`, captured before any spy replaces it. */
  const driverAggregate = ((): typeof Collection.prototype.aggregate => {
    const descriptor = Object.getOwnPropertyDescriptor(Collection.prototype, "aggregate");
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error("the driver's Collection#aggregate is missing from the prototype");
    }
    return descriptor.value as typeof Collection.prototype.aggregate;
  })();

  /** The driver's own `aggregate` argument tuple. */
  type DriverAggregateArgs = Parameters<typeof driverAggregate>;

  /** The page this case reads: three clean candidates, the probe's measured size. */
  const PAGE_SIZE = 3;

  /** One seeded candidate: the event and the batch the worker settled for it. */
  interface Candidate {
    readonly event: SeededEvent;
    readonly batchId: string;
  }

  /**
   * Arm a driver failure on **every** `aggregate` of `collectionName`.
   *
   * The discovery is the only caller that aggregates this collection in the run,
   * so the failure is the page read itself. The error carries `code: 91` (a
   * replica-set election) — the shape of a transient read failure — and it is
   * thrown, never resolved to an empty page: a discovery that answers "no
   * batches" would let the run complete and silently lose every batch's §4.7
   * summary. The counter proves the injection was reached rather than assumed.
   *
   * @param collectionName - The collection whose aggregate fails, matched on `this`.
   * @returns The injection, whose `fired` count proves it was reached.
   */
  function failAggregateOn(collectionName: string): InjectedReadFailure {
    let fired = 0;
    const spy = vi.spyOn(Collection.prototype, "aggregate").mockImplementation(function (
      this: Collection,
      ...args: DriverAggregateArgs
    ) {
      if (this.collectionName === collectionName) {
        fired += 1;
        throw Object.assign(new Error(`injected failure: aggregate on ${collectionName}`), {
          code: 91,
        });
      }
      return driverAggregate.call(this, ...args);
    });

    return {
      fired: () => fired,
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  /**
   * Seed one `indexed` candidate (contract §4.1) whose two-file batch the worker
   * already settled (§16.2, §16.3) — `I26`/`I29`'s fixture shape.
   *
   * @param slug - A name unique to the candidate, which seeds its content hashes.
   * @returns The event and its batch id.
   */
  async function seedCandidate(slug: string): Promise<Candidate> {
    const event = await seedEvent(ALL_PROCESSED);
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    for (const sequence of [1, 2]) {
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(`${slug}-${String(sequence)}`),
        fileName: `DSC_A${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return { event, batchId };
  }

  /**
   * Read the stored `pipeline` fields of one seeded event.
   *
   * @param eventId - The event to read.
   * @returns The row's `pipeline` sub-document, if any.
   */
  async function storedPipelineOf(eventId: ObjectId): Promise<DiscoveryAbortRow | null> {
    return (await app.db
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as unknown as DiscoveryAbortRow | null;
  }

  /**
   * Run the job once over the block's page.
   *
   * @param at - The instant the run's windows are evaluated at.
   * @returns The §10.2 run envelope (a rejection is the caller's to assert).
   */
  async function runPage(
    at: Date
  ): Promise<Awaited<ReturnType<typeof pipelineIndexedCheckJob.run>>> {
    return pipelineIndexedCheckJob.run({
      requestedLimit: PAGE_SIZE,
      clock: fixedClock(at),
      logger: recordingLogger(),
    });
  }

  it("I30: the run rejects, stamps nothing and emits nothing, and the next tick retries the page", async () => {
    // Arrange — three clean `indexed` candidates, each with a worker-settled
    // two-file batch, all of them still on the candidate page.
    const page: Candidate[] = [];
    for (let index = 0; index < PAGE_SIZE; index += 1) {
      page.push(await seedCandidate(`op136-discovery-abort-${String(index)}`));
    }
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");

    // Act — the grouped discovery's own aggregate throws for the whole tick.
    const injection = failAggregateOn(COLLECTIONS.eventImages);
    try {
      const run = runPage(NOW);

      // Assert — a page-level read failure is fatal, unlike a row-level one.
      await expect(
        run,
        "a failing batch-discovery read must abort the run, not be absorbed into its errors"
      ).rejects.toThrow(/injected failure: aggregate/);

      // Sanity — the armed aggregate was reached, or the case proves nothing.
      expect(
        injection.fired(),
        "the discovery's aggregate must have failed, or the seed never reached it"
      ).toBeGreaterThanOrEqual(1);

      // Assert — nothing was stamped: every seeded event keeps both pipeline
      // fields unset, so every one of them is still a candidate…
      const stored = await Promise.all(page.map((row) => storedPipelineOf(row.event.eventId)));
      expect(
        stored.map((row) => row?.pipeline?.indexedCheckedCounters),
        "an aborted run must not stamp the checked triple on any row"
      ).toEqual(page.map(() => undefined));
      expect(
        stored.map((row) => row?.pipeline?.indexedNotifiedAt),
        "an aborted run must not latch any row as notified"
      ).toEqual(page.map(() => undefined));

      // …and nothing was emitted.
      expect(
        await app.db.collection(COLLECTIONS.domainEvents).countDocuments({}),
        "an aborted run must not emit a single domain event"
      ).toBe(0);
    } finally {
      injection.restore();
    }

    // Act — the read is cleared: the next tick over the same page.
    const retried = await runPage(new Date(NOW.getTime() + NEXT_BUCKET_MS));

    // Assert — the page is retried as a whole, with nothing to report…
    expect(retried.scanned, "the retried page is read whole").toBe(PAGE_SIZE);
    expect(retried.errors, "the retried page has no failing row to count").toBe(0);

    // …every row is announced exactly once by that tick…
    const announced = await Promise.all(page.map((row) => indexedRowsFor(row.event.eventId)));
    expect(
      announced.map((rows) => rows.length),
      "the retry announces every row of the page it aborted on, once each"
    ).toEqual(page.map(() => 1));

    // …and every row is stamped, so it leaves the candidate page.
    const stamped = await Promise.all(page.map((row) => storedPipelineOf(row.event.eventId)));
    expect(
      stamped.map((row) => row?.pipeline?.indexedCheckedCounters),
      "the retried tick stamps every row it evaluated with its checked triple"
    ).toEqual(page.map(() => ({ imageCount: 3, processedImageCount: 3, failedImageCount: 0 })));
  });
});

/**
 * Integration / contract — the contained-row warning tells an operator **why**
 * the row failed, in the entry the transport actually receives (ADR-0872 §1;
 * finding **F1** of the landing review of PR #741, card `t_05687f95`, squash
 * `b3f63308`; card `t_3b30fc42`, record ADR-0886).
 *
 * ## Why this block exists
 *
 * ADR-0872 §1 makes a row's own arm failure a contained `warn` that names the
 * row by its event id, and `I27` pins the naming. `I27` reads the **recording**
 * logger, which keeps the call-site fields object exactly as it was written, and
 * it projects a thrown `Error` with a replacer of its own
 * (`(key, value) => value instanceof Error ? value.message : value`) — a
 * projection no transport performs. The real logging port serializes a thrown
 * error for exactly one key, the documented `err`
 * (`apps/web/src/server/logging/index.ts`, which hands `merged.err` to
 * `serializeError`), and passes every other key through `redactEntry`, which
 * leaves a non-plain object such as an `Error` untouched. `JSON.stringify` of
 * such an entry — the shape the stdout and vendor transports write — drops
 * `name`, `message` and `stack` entirely, so the line an operator reads names
 * the event id but not the reason it failed.
 *
 * ## How to read it
 *
 * The pin runs the job through the **real** port: a capturing `LogTransport`
 * and `createLogger({ level: "warn", env: "test" })`, so the entry asserted on is
 * the one a transport was handed, JSON round-tripped to its wire shape. It
 * asserts the level, the event key, the event id and the run's `errors: 1` — the
 * control `I26`/`I27` already carry — and the one thing they cannot see: the
 * thrown error's **message is present in that entry**. It names no field,
 * because the key is the logging port's contract rather than this job's; the
 * property under pin is that the reason survives the port, whichever documented
 * shape carries it (ADR-0886 §1).
 *
 * RED at the trunk: the shipped call site writes `error: outcome.reason`, whose
 * value the port does not serialize, so the wire entry carries `{}` where the
 * error was and the message is absent. The GREEN is one word — `error:` → `err:`
 * (ADR-0886 §2).
 */
describe("pipeline-indexed-check: the contained-row warn carries the failure reason on the wire", () => {
  /**
   * The per-run cap: room for the single candidate, so the page is not what the
   * case is measuring.
   */
  const SINGLE_ROW_LIMIT = 4;

  /**
   * The message the poison row's own arm read throws. `failFindWhen` builds it
   * from the collection name, so the assertion below reads the injection's own
   * text rather than a literal that could drift from it.
   */
  const POISON_READ_MESSAGE = `injected failure: find on ${COLLECTIONS.eventImages}`;

  /**
   * Seed one `indexed` candidate (`I26`'s shape): a clean event whose two-file
   * batch the worker already settled, so the OP-126 arm reads that batch's
   * `event_images` rows — the read this case arms.
   *
   * @returns The seeded event.
   */
  async function seedPoisonCandidate(): Promise<SeededEvent> {
    const event = await seedEvent(ALL_PROCESSED);
    const batchId = new ObjectId().toHexString();
    const uploader = new ObjectId();
    for (const sequence of [1, 2]) {
      await seedCompletedSession(event, {
        batchId,
        createdByUserId: uploader,
        contentHash: hashFor(`op136-row-failed-wire-${String(sequence)}`),
        fileName: `DSC_9${String(sequence).padStart(3, "0")}.JPG`,
      });
      await seedBatchImage(event, { batchId, status: "done", sequence });
    }
    return event;
  }

  /**
   * Arm the poison shape on the candidate's batch: every `event_images` read of
   * that event throws, for the whole case.
   *
   * @param eventId - The event whose batch reads fail.
   * @returns The injection, whose `fired` count proves every call reached it.
   */
  function poisonBatchReads(eventId: ObjectId): InjectedReadFailure {
    return failFindWhen(
      COLLECTIONS.eventImages,
      (filter) => filter.eventId instanceof ObjectId && filter.eventId.equals(eventId)
    );
  }

  /**
   * Build a `LogTransport` that keeps every entry it is handed, and the buffer
   * it keeps them in.
   *
   * @returns The buffer the logger writes into and the transport itself.
   */
  function capturingTransport(): {
    readonly entries: LogEntry[];
    readonly transport: LogTransport;
  } {
    const entries: LogEntry[] = [];
    return {
      entries,
      transport: {
        write(entry: LogEntry): void {
          entries.push(entry);
        },
      },
    };
  }

  it("I32: the warn the transport receives carries the failure reason, not only the event id", async () => {
    // Arrange — one `indexed` candidate whose own batch arm cannot read its
    // `event_images` rows, and a real logger over a capturing transport.
    const poison = await seedPoisonCandidate();
    expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed");
    const captured = capturingTransport();
    const logger = createLogger({
      level: "warn",
      env: "test",
      transports: [captured.transport],
    });
    const injection = poisonBatchReads(poison.eventId);
    try {
      // Act — the job runs through the real logging port, not the recording helper.
      const result = await pipelineIndexedCheckJob.run({
        requestedLimit: SINGLE_ROW_LIMIT,
        clock: fixedClock(NOW),
        logger,
      });

      // Sanity — the armed read was reached, or the case proves nothing.
      expect(
        injection.fired(),
        "the poison row's arm read must have failed, or the seed is not poison"
      ).toBeGreaterThanOrEqual(1);

      // Assert — the control: the row was contained, so the run still resolved.
      expect(result.errors, "one failing row is one counted error").toBe(1);
      expect(result.scanned, "a contained failure does not shorten the page").toBe(1);

      // …and what reached the transport is the entry a vendor would store: the
      // in-memory object is round-tripped so the assertion is the wire shape.
      const wire = JSON.parse(JSON.stringify(captured.entries)) as readonly Record<
        string,
        unknown
      >[];
      const failed = wire.filter((entry) => entry.event === ROW_FAILED_EVENT);
      expect(failed, "a row whose own arm work throws must be named exactly once").toHaveLength(1);
      const named = failed[0];
      expect(named?.level, "a contained row failure is a warning, not a run failure").toBe("warn");
      expect(named?.eventId, "the line must name the failing event").toBe(
        poison.eventId.toHexString()
      );

      // …and the operator's only per-row signal must say *why*: the reason
      // survives the logging port, so the entry a transport stores carries it.
      expect(
        JSON.stringify(named),
        "the row-failed warn must reach the transport carrying the thrown error's message, or an operator cannot tell why the event failed"
      ).toContain(POISON_READ_MESSAGE);
    } finally {
      injection.restore();
    }
  });
});
