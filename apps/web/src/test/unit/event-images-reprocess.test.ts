import { describe, expect, it } from "vitest";

import { resetProcessingForReprocess } from "@/server/images/reprocess";

/**
 * U2 — the reprocess state reset (OP-127 U2, contract §4.4, schema §18.2).
 *
 * A reprocess is a **pipeline** retry, not a new upload: the row keeps its
 * identity, its asset, its sequence and its counters, and only its durable job
 * state goes back to the start of the queue. The reset is one pure function so
 * the three things a reviewer must be able to read in one place — what is
 * cleared, what is preserved and what is re-stamped — are the function's whole
 * contract.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/images/reprocess` must export:
 *
 * ```ts
 * interface ProcessingState {
 *   readonly status?: string;
 *   readonly priority?: string;
 *   readonly attempts?: number;
 *   readonly maxAttempts?: number;
 *   readonly leaseExpiresAt?: Date | null;
 *   readonly workerId?: string | null;
 *   readonly queuedAt?: Date;
 *   readonly startedAt?: Date | null;
 *   readonly finishedAt?: Date | null;
 *   readonly durationMs?: number | null;
 *   readonly lastError?: { code: string; message: string; at: Date; retryable: boolean } | null;
 *   readonly queueRef?: { queueKey: string; provider: string; messageId: string } | null;
 *   readonly modelKeys?: Readonly<Record<string, string>>;
 * }
 * function resetProcessingForReprocess(
 *   current: ProcessingState | undefined,
 *   now: Date
 * ): ProcessingState;
 * ```
 *
 * ## Assumptions (ADR-0762)
 *
 * - A1 — `attempts` resets to `0` (contract §4.4, "zeroes attempts") while the
 *   item's `maxAttempts` budget is **preserved**: a failed file gets a fresh
 *   retry budget, not a wider one.
 * - A2 — every field that records a *previous* run is cleared, so a stale
 *   `lastError` or `durationMs` cannot be read as the new attempt's outcome.
 * - A3 — `queueRef` is cleared: the enqueue that follows writes the new broker
 *   id, and a stale pointer would make the sweep believe a message exists.
 * - A4 — `priority` and `modelKeys` are preserved (they are policy and
 *   reproducibility, not run state), and `queuedAt` is re-stamped to `now`.
 */

/** The stored instant the reset is stamped with. */
const NOW = new Date("2026-11-12T09:30:00.000Z");

/** The previous run's instant, so a cleared value is distinguishable from a kept one. */
const LAST_RUN = new Date("2026-11-12T09:00:00.000Z");

describe("resetProcessingForReprocess", () => {
  it("U2: a failed row goes back to queued with a zeroed attempt count and no error", () => {
    // Arrange — a third attempt that failed after running for 3.4 s.
    const failed = {
      status: "failed",
      priority: "normal",
      attempts: 3,
      maxAttempts: 5,
      leaseExpiresAt: LAST_RUN,
      workerId: "worker-7",
      queuedAt: LAST_RUN,
      startedAt: LAST_RUN,
      finishedAt: LAST_RUN,
      durationMs: 3400,
      lastError: {
        code: "no_face_detected",
        message: "No face found in the image.",
        at: LAST_RUN,
        retryable: true,
      },
      queueRef: { queueKey: "q:image", provider: "memory", messageId: "msg-1" },
      modelKeys: { detection: "antelopev2", recognition: "arcface_r100_512" },
    };

    // Act
    const reset = resetProcessingForReprocess(failed, NOW);

    // Assert — the new run's state, exactly.
    expect(reset).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
      leaseExpiresAt: null,
      workerId: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      queueRef: null,
      queuedAt: NOW,
    });
  });

  it("U2: the item keeps its retry budget, its priority and its model keys", () => {
    // Arrange
    const failed = {
      status: "failed",
      priority: "high",
      attempts: 5,
      maxAttempts: 5,
      modelKeys: { detection: "antelopev2", recognition: "arcface_r100_512" },
    };

    // Act
    const reset = resetProcessingForReprocess(failed, NOW);

    // Assert — a reprocess buys no extra attempts and no model change.
    expect(reset.maxAttempts).toBe(5);
    expect(reset.priority).toBe("high");
    expect(reset.modelKeys).toEqual({
      detection: "antelopev2",
      recognition: "arcface_r100_512",
    });
  });

  it("U2: a row with no pipeline state at all still resets to a clean queued state", () => {
    // Act — a row the pipeline never touched carries no `processing` at all.
    const reset = resetProcessingForReprocess(undefined, NOW);

    // Assert
    expect(reset).toMatchObject({
      status: "queued",
      attempts: 0,
      lastError: null,
      queueRef: null,
      queuedAt: NOW,
    });
  });

  it("U2: a skipped row is reset the same way as a failed one", () => {
    // Arrange — `skipped` reaches the same retry (the contract's only gate is
    // `failed` on the single-image route, so the shared reset stays status-agnostic).
    const skipped = { status: "skipped", attempts: 0, maxAttempts: 5 };

    // Act
    const reset = resetProcessingForReprocess(skipped, NOW);

    // Assert
    expect(reset).toMatchObject({ status: "queued", attempts: 0, queuedAt: NOW });
  });
});
