/**
 * Event pipeline-status derivation (OP-116, contract §4.1 "pipeline summary").
 *
 * The event detail response carries a `pipelineSummary.status` derived from
 * the event's processing counters — never a stored flag. `derivePipelineStatus`
 * is the pure decision table over the three counters, decided in priority
 * order:
 *
 * 1. `imageCount === 0` → `idle` (nothing uploaded to process);
 * 2. `processed + failed < imageCount` → `indexing` (work still queued);
 * 3. `failed === 0` → `indexed` (all photos indexed, none failed);
 * 4. `processed === 0` → `delayed` (nothing indexed yet — every result so far
 *    is a failure; retries pending);
 * 5. otherwise → `partial_failure` (some indexed, some failed).
 */

/** The processing counters a photo pipeline tracks per event. */
export interface ProcessingCounts {
  /** Photos uploaded to the event. */
  readonly imageCount: number;
  /** Photos successfully indexed. */
  readonly processedImageCount: number;
  /** Photos whose indexing failed. */
  readonly failedImageCount: number;
}

/** The derived pipeline summary status. */
export type PipelineStatus = "idle" | "indexing" | "indexed" | "delayed" | "partial_failure";

/**
 * Derive the pipeline status from the event's processing counters.
 *
 * The priority order makes the state unambiguous: a drained queue with
 * failures reports `delayed` (nothing indexed, retries pending) which is kept
 * distinct from `partial_failure` (some indexed, some failed).
 *
 * @param counts - The event's processing counters.
 * @returns The derived pipeline status.
 */
export function derivePipelineStatus(counts: ProcessingCounts): PipelineStatus {
  const { imageCount, processedImageCount, failedImageCount } = counts;
  if (imageCount === 0) {
    return "idle";
  }
  if (processedImageCount + failedImageCount < imageCount) {
    return "indexing";
  }
  if (failedImageCount === 0) {
    return "indexed";
  }
  if (processedImageCount === 0) {
    return "delayed";
  }
  return "partial_failure";
}
