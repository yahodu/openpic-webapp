import { describe, expect, it } from "vitest";

import {
  deriveUploadBatchPhase,
  describeUploadFailure,
  type BatchFileCounts,
  type BatchPipelineCounts,
  type UploadBatchPhase,
} from "@/server/uploads/batch-status";

/**
 * Unit — the batch-phase derivation and the user-safe failure view (OP-126 U1,
 * U2; contract §5.5, notification design §4.7; ADR-0760).
 *
 * The user story: *as an organizer, I want batch progress and a single summary
 * notification so that I know how many photos landed, failed or were skipped.*
 * Two pure decisions carry it, and both live in
 * `@/server/uploads/batch-status` so the status route and the transition check
 * cannot drift apart:
 *
 * - {@link deriveUploadBatchPhase} folds the two count blocks the status answer
 *   already carries into exactly one `phase`. The route never decides a phase
 *   itself, and the transition check uses the same function to know whether the
 *   batch has become terminal.
 * - {@link describeUploadFailure} maps one `event_images.processing.lastError`
 *   onto the `{ code, message, retryable }` triple §5.5 serves in `failures[]`.
 *   A stored internal error is **never** echoed: the message is furniture from
 *   the pinned table, and an unrecognised code collapses to the generic view.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // @/server/uploads/batch-status
 * export type UploadBatchPhase =
 *   "uploading" | "processing" | "complete" | "complete_with_errors";
 *
 * export interface BatchFileCounts {
 *   readonly total: number;
 *   readonly uploaded: number;
 *   readonly duplicatesSkipped: number;
 *   readonly rejected: number;
 *   readonly failedUpload: number;
 * }
 *
 * export interface BatchPipelineCounts {
 *   readonly queued: number;
 *   readonly processing: number;
 *   readonly done: number;
 *   readonly failed: number;
 * }
 *
 * export function deriveUploadBatchPhase(input: {
 *   readonly files: BatchFileCounts;
 *   readonly pipeline: BatchPipelineCounts;
 * }): UploadBatchPhase;
 *
 * export interface UploadFailureView {
 *   readonly code: string;
 *   readonly message: string;
 *   readonly retryable: boolean;
 * }
 *
 * export function describeUploadFailure(input: {
 *   readonly code: string;
 *   readonly message?: string;
 * }): UploadFailureView;
 * ```
 *
 * ## The derivation rules (ADR-0760 D1)
 *
 * 1. A file whose transfer has not settled — `total` is greater than
 *    `uploaded + duplicatesSkipped + rejected + failedUpload` — means
 *    `uploading`, even when the pipeline is already complaining about another
 *    file: the editor may still be on the network.
 * 2. Otherwise, any pipeline work that is not terminal (`queued + processing`)
 *    means `processing`.
 * 3. Otherwise a failure — a refused upload (`failedUpload`) or a permanently
 *    failed image (`pipeline.failed`) — means `complete_with_errors`.
 * 4. Otherwise, and for an empty batch, `complete`.
 *
 * A **rejection** never makes the phase `complete_with_errors`: §5.5 counts
 * `rejected` beside `failedUpload` and §4.7 folds rejections into the summary,
 * while `completed` is defined as "zero failures" (notification §4.7).
 *
 * ## The failure copy table (ADR-0760 D2)
 *
 * `retryable` is a property of the **code**, never of the stored error: the
 * `processing.lastError` a worker writes is diagnostic data and carries no
 * user-facing meaning. The `code` a `failures[]` entry carries is the mapped
 * code — an internal code the table does not know becomes
 * `processing_failed` — so a worker that starts reporting a new internal
 * failure never leaks its name to an organizer.
 */

/** One row of the phase table: the two count blocks and the phase they imply. */
interface PhaseCase {
  readonly name: string;
  readonly files: BatchFileCounts;
  readonly pipeline: BatchPipelineCounts;
  readonly phase: UploadBatchPhase;
}

/** A pipeline block with no work in it. */
const IDLE_PIPELINE: BatchPipelineCounts = { queued: 0, processing: 0, done: 0, failed: 0 };

/** A file block with nothing landed yet. */
const NOTHING_TRANSFERRED: BatchFileCounts = {
  total: 3,
  uploaded: 0,
  duplicatesSkipped: 0,
  rejected: 0,
  failedUpload: 0,
};

/**
 * The phase table (§5.5 + ADR-0760 D1), one row per decision branch.
 *
 * Every row is a whole count pair, so a wrong branch reports the counts that
 * produced it rather than a bare string comparison.
 */
const PHASE_TABLE: readonly PhaseCase[] = [
  {
    name: "no file has transferred yet",
    files: NOTHING_TRANSFERRED,
    pipeline: IDLE_PIPELINE,
    phase: "uploading",
  },
  {
    name: "one of three files is still transferring while the pipeline works",
    files: { total: 3, uploaded: 2, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 2, processing: 0, done: 0, failed: 0 },
    phase: "uploading",
  },
  {
    name: "a pipeline failure does not end a batch whose third file is still on the wire",
    files: { total: 3, uploaded: 2, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 0, processing: 0, done: 1, failed: 1 },
    phase: "uploading",
  },
  {
    name: "every file settled but work is queued",
    files: { total: 3, uploaded: 3, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 1, processing: 0, done: 2, failed: 0 },
    phase: "processing",
  },
  {
    name: "every file settled and one image is still being processed",
    files: { total: 3, uploaded: 3, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 0, processing: 1, done: 2, failed: 0 },
    phase: "processing",
  },
  {
    name: "every file landed and the pipeline finished clean",
    files: { total: 3, uploaded: 3, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 0, processing: 0, done: 3, failed: 0 },
    phase: "complete",
  },
  {
    name: "duplicates and rejections settle a file without failing the batch",
    files: { total: 3, uploaded: 1, duplicatesSkipped: 1, rejected: 1, failedUpload: 0 },
    pipeline: { queued: 0, processing: 0, done: 1, failed: 0 },
    phase: "complete",
  },
  {
    name: "a permanently failed image ends the batch with errors",
    files: { total: 3, uploaded: 3, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: { queued: 0, processing: 0, done: 2, failed: 1 },
    phase: "complete_with_errors",
  },
  {
    name: "an upload refused before it stored bytes ends the batch with errors",
    files: { total: 3, uploaded: 2, duplicatesSkipped: 0, rejected: 0, failedUpload: 1 },
    pipeline: { queued: 0, processing: 0, done: 2, failed: 0 },
    phase: "complete_with_errors",
  },
  {
    name: "an empty batch has nothing outstanding",
    files: { total: 0, uploaded: 0, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
    pipeline: IDLE_PIPELINE,
    phase: "complete",
  },
];

/** One row of the failure table: the stored code and the view it must produce. */
interface FailureCase {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The failure copy table (ADR-0760 D2).
 *
 * `no_faces_detected` is the copy §5.5 itself prints ("No faces were detected
 * in this image."); the rest are the same voice — one sentence, no jargon, and
 * a retry hint only where retrying can actually help.
 */
const FAILURE_TABLE: readonly FailureCase[] = [
  { code: "no_faces_detected", message: "No faces were detected in this image.", retryable: false },
  {
    code: "unsupported_media_type",
    message: "This image's format could not be processed.",
    retryable: false,
  },
  { code: "corrupt_image", message: "This image file appears to be damaged.", retryable: false },
  {
    code: "timeout",
    message: "Processing timed out. This image will be retried.",
    retryable: true,
  },
  {
    code: "provider_unavailable",
    message: "Processing is temporarily unavailable. This image will be retried.",
    retryable: true,
  },
];

/** The generic view an unrecognised internal code collapses to. */
const GENERIC_FAILURE = {
  code: "processing_failed",
  message: "This photo could not be processed.",
  retryable: false,
} as const;

/** An internal message a worker might store — nothing of it may reach a user. */
const INTERNAL_MESSAGE =
  "opencv error: (-215:Assertion failed) !empty() in function detectMultiScale at /srv/app/dist/worker.js:42";

describe("deriveUploadBatchPhase — the §5.5 phase derivation (U1)", () => {
  it.each(PHASE_TABLE)("U1: $name → $phase", ({ files, pipeline, phase }) => {
    expect(deriveUploadBatchPhase({ files, pipeline })).toBe(phase);
  });

  it("U1: the derivation reads nothing but the two blocks it is given", () => {
    // Arrange — a batch whose transfer is settled but whose pipeline is not.
    const input = {
      files: { total: 2, uploaded: 2, duplicatesSkipped: 0, rejected: 0, failedUpload: 0 },
      pipeline: { queued: 1, processing: 0, done: 1, failed: 0 },
    };

    // Act
    const phase = deriveUploadBatchPhase(input);

    // Assert — the same input answers the same phase, so the route and the
    // transition check can never disagree about one batch.
    expect(deriveUploadBatchPhase(input)).toBe(phase);
    expect(phase).toBe("processing");
  });
});

describe("describeUploadFailure — the user-safe failure view (U2)", () => {
  it.each(FAILURE_TABLE)("U2: $code maps to the pinned copy", ({ code, message, retryable }) => {
    // The stored message is internal detail; the view must ignore it.
    expect(describeUploadFailure({ code, message: INTERNAL_MESSAGE })).toEqual({
      code,
      message,
      retryable,
    });
  });

  it.each(FAILURE_TABLE)(
    "U2: $code keeps its copy when the worker stored no message",
    ({ code, message, retryable }) => {
      expect(describeUploadFailure({ code })).toEqual({ code, message, retryable });
    }
  );

  it("U2: an internal message never reaches the view", () => {
    // Arrange / Act
    const view = describeUploadFailure({ code: "no_faces_detected", message: INTERNAL_MESSAGE });

    // Assert
    expect(view.message).not.toContain("opencv");
    expect(view.message).not.toContain("/srv/app");
    expect(view.message).not.toContain("worker.js");
    expect(view.message).not.toContain("detectMultiScale");
  });

  it("U2: an unrecognised internal code collapses to the generic view", () => {
    // Arrange — a code no table row knows.
    const internal = { code: "worker_panic_segv", message: INTERNAL_MESSAGE };

    // Act
    const view = describeUploadFailure(internal);

    // Assert — neither the internal code nor its message survives.
    expect(view).toEqual(GENERIC_FAILURE);
    expect(view.code).not.toBe(internal.code);
    expect(view.message).not.toContain("panic");
  });
});
