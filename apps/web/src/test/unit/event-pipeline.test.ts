import { describe, expect, it } from "vitest";

import {
  derivePipelineStatus,
  type PipelineStatus,
  type ProcessingCounts,
} from "@/server/events/pipeline";

/**
 * Unit — the event pipeline-status derivation table (OP-116 U2, §3 "pipeline
 * summary").
 *
 * The event detail response carries a `pipelineSummary.status` derived from
 * the event's processing counters — never a stored flag. The derivation is a
 * pure function of three counters:
 *
 * - `imageCount` — photos uploaded to the event.
 * - `processedImageCount` — photos successfully indexed.
 * - `failedImageCount` — photos whose indexing failed.
 *
 * The derived status is one of `idle | indexing | indexed | delayed |
 * partial_failure`, decided in priority order:
 *
 * 1. `imageCount === 0` → `idle` (nothing uploaded to process).
 * 2. `processed + failed < imageCount` → `indexing` (work still queued).
 * 3. `failed === 0` → `indexed` (all photos indexed, none failed).
 * 4. `processed === 0` → `delayed` (nothing indexed yet — every result so far
 *    is a failure; retries pending).
 * 5. otherwise → `partial_failure` (some indexed, some failed).
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/pipeline
 *   type ProcessingCounts = {
 *     imageCount: number; processedImageCount: number; failedImageCount: number;
 *   }
 *   type PipelineStatus = "idle" | "indexing" | "indexed" | "delayed" | "partial_failure"
 *   derivePipelineStatus(counts: ProcessingCounts): PipelineStatus
 * ```
 */

/** The full derivation table (every reachable combination). */
interface PipelineCase {
  readonly counts: ProcessingCounts;
  readonly expected: PipelineStatus;
  readonly description: string;
}

const CASES: ReadonlyArray<PipelineCase> = [
  {
    counts: { imageCount: 0, processedImageCount: 0, failedImageCount: 0 },
    expected: "idle",
    description: "nothing has been uploaded",
  },
  {
    counts: { imageCount: 5, processedImageCount: 0, failedImageCount: 0 },
    expected: "indexing",
    description: "every photo is still queued",
  },
  {
    counts: { imageCount: 5, processedImageCount: 3, failedImageCount: 0 },
    expected: "indexing",
    description: "some photos are still queued",
  },
  {
    counts: { imageCount: 5, processedImageCount: 3, failedImageCount: 1 },
    expected: "indexing",
    description: "a failure has not drained the queue yet",
  },
  {
    counts: { imageCount: 5, processedImageCount: 5, failedImageCount: 0 },
    expected: "indexed",
    description: "every photo indexed with no failures",
  },
  {
    counts: { imageCount: 5, processedImageCount: 0, failedImageCount: 5 },
    expected: "delayed",
    description: "every photo failed and none were indexed",
  },
  {
    counts: { imageCount: 5, processedImageCount: 3, failedImageCount: 2 },
    expected: "partial_failure",
    description: "some photos indexed and some failed",
  },
  {
    counts: { imageCount: 5, processedImageCount: 4, failedImageCount: 1 },
    expected: "partial_failure",
    description: "mostly indexed but one failure remains",
  },
];

describe("derivePipelineStatus (U2 — derivation table)", () => {
  it.each(CASES)("derives $expected when $description", ({ counts, expected }) => {
    expect(derivePipelineStatus(counts)).toBe(expected);
  });

  it("reports delayed when every photo has failed and none were indexed", () => {
    expect(
      derivePipelineStatus({ imageCount: 8, processedImageCount: 0, failedImageCount: 8 })
    ).toBe("delayed");
  });
});
