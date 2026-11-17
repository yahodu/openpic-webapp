import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { derivePipelineStatus, type ProcessingCounts } from "@/server/events/pipeline";
import { pipelineIndexedCheckJob } from "@/server/jobs/pipeline-indexed-check";
import { fixedClock } from "@/server/runtime/clock";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

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
 * `I12`, `I13` and `I14` are the pins: at the RED head the third event is never
 * reached, so its announcement (and its batch summary) never exists. `I15` is a
 * **characterization arm**, green on arrival: it is the discriminator against a
 * "finish" that completes an un-indexed event by marking it done — a shape whose
 * windows all latched — which is why it asserts the `delayed` → `indexed`
 * transition rather than the window's tail.
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
});
