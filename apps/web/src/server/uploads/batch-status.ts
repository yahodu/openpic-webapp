/**
 * The batch-phase derivation and the user-safe failure view (OP-126, contract
 * §5.5, notification §4.7; ADR-0760 D1/D2).
 *
 * Pure: no database, no clock. The status route and the transition check both
 * fold the same two count blocks through {@link deriveUploadBatchPhase}, so a
 * poll and a cron tick can never disagree about one batch.
 *
 * A **rejection is not a failure**: §5.5 prints `rejected` beside `failedUpload`
 * and folds rejections into the same summary, while `completed` means zero
 * failures — so `duplicatesSkipped` and `rejected` settle a file without moving
 * the phase to `complete_with_errors`.
 */

/** The four §5.5 phases. */
export type UploadBatchPhase = "uploading" | "processing" | "complete" | "complete_with_errors";

/** The `files` block of the status answer. */
export interface BatchFileCounts {
  readonly total: number;
  readonly uploaded: number;
  readonly duplicatesSkipped: number;
  readonly rejected: number;
  readonly failedUpload: number;
}

/** The `pipeline` block of the status answer. */
export interface BatchPipelineCounts {
  readonly queued: number;
  readonly processing: number;
  readonly done: number;
  readonly failed: number;
}

/** One `failures[]` entry, in user-facing terms. */
export interface UploadFailureView {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** The user-facing copy for each internal processing code (ADR-0760 D2). */
const FAILURE_COPY: Readonly<
  Record<string, { readonly message: string; readonly retryable: boolean }>
> = {
  no_faces_detected: {
    message: "No faces were detected in this image.",
    retryable: false,
  },
  unsupported_media_type: {
    message: "This image's format could not be processed.",
    retryable: false,
  },
  corrupt_image: { message: "This image file appears to be damaged.", retryable: false },
  timeout: { message: "Processing timed out. This image will be retried.", retryable: true },
  provider_unavailable: {
    message: "Processing is temporarily unavailable. This image will be retried.",
    retryable: true,
  },
};

/** The view an internal code the table does not know collapses to. */
const GENERIC_FAILURE: UploadFailureView = {
  code: "processing_failed",
  message: "This photo could not be processed.",
  retryable: false,
};

/**
 * Fold the two count blocks into one phase.
 *
 * A file still on the wire wins over everything (the editor may still be
 * uploading), then outstanding pipeline work, then a failure, else `complete`.
 * An empty batch is `complete` and emits nothing.
 *
 * @param input - The `files` and `pipeline` blocks of the status answer.
 * @returns The §5.5 phase.
 */
export function deriveUploadBatchPhase(input: {
  readonly files: BatchFileCounts;
  readonly pipeline: BatchPipelineCounts;
}): UploadBatchPhase {
  const { files, pipeline } = input;
  const settled = files.uploaded + files.duplicatesSkipped + files.rejected + files.failedUpload;
  if (files.total > settled) {
    return "uploading";
  }
  if (pipeline.queued + pipeline.processing > 0) {
    return "processing";
  }
  if (files.failedUpload > 0 || pipeline.failed > 0) {
    return "complete_with_errors";
  }
  return "complete";
}

/**
 * Map one `event_images.processing.lastError` onto the `{code, message, retryable}`
 * triple §5.5 serves.
 *
 * The stored message is diagnostic data and is never echoed: the copy and the
 * retry flag come from the table, and an unrecognised code collapses to the
 * generic view so a worker's internal code never reaches an organizer.
 *
 * @param input - The stored error code (and its ignored internal message).
 * @returns The user-safe failure view.
 */
export function describeUploadFailure(input: {
  readonly code: string;
  readonly message?: string;
}): UploadFailureView {
  const copy = FAILURE_COPY[input.code];
  return copy === undefined ? GENERIC_FAILURE : { code: input.code, ...copy };
}
