import { describe, expect, it } from "vitest";

import { reduceReportItem } from "@/server/internal/worker-report";

/**
 * Unit — the worker-report outcome reducer (OP-135 U1/U3; contract §10.3.2,
 * §10.3.3; schema §18.2).
 *
 * `POST /api/v1/internal/worker/report` does not translate a worker's verdict
 * into `processing` state inline: the sweep, the queue publisher and the
 * attempt budget all read that state, so the mapping is one pure function and
 * this file is its contract. Three facts are being pinned.
 *
 * - **`done` is terminal, and zero faces is still `done`.** §10.3.3 is explicit
 *   that `no_faces_detected` is `outcome: "done"` with `faceCount: 0` — zero
 *   faces is a valid result, not an error — so a reducer that reacts to the
 *   count would fail a real photograph of an empty room.
 * - **A retryable failure is only a failure once the budget is spent.** The
 *   documented retry accounting (§18.2 `attempts` / `maxAttempts`) lives on the
 *   work item, so the report must return the item to `queued` while attempts
 *   remain and land on `failed` at the budget — never `failed` on the first
 *   transient `download_failed`.
 * - **`retryable: false` jumps straight to `failed`**, regardless of remaining
 *   attempts, and `liveness_failed` is terminal on the same footing (U3): a
 *   liveness verdict cannot be improved by re-running inference, and a retry
 *   would spend the attendee's own attempt budget (§6.3/§14.1).
 *
 * The reducer never reads the clock: the caller passes `now`, so `finishedAt`
 * and `lastError.at` are exact in these cases (ADR-0007).
 */

/** The single instant every decision in this file is stamped with. */
const NOW = new Date("2026-09-25T09:18:00.000Z");

/** The `maxAttempts` a fresh work item carries (§18.2). */
const MAX_ATTEMPTS = 5;

describe("the worker-report outcome reducer", () => {
  it("U1: marks a done item done and stamps its finish, with no error", () => {
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "done",
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision).toEqual({
      status: "done",
      retry: false,
      finishedAt: NOW,
      lastError: null,
    });
  });

  it("U1: treats a done item with zero faces as a success, not a failure", () => {
    // §10.3.3: `no_faces_detected` is `outcome: "done"` with `faceCount: 0`.
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "done",
      faceCount: 0,
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.status).toBe("done");
    expect(decision.lastError).toBeNull();
  });

  it("U1: requeues a retryable failure while attempts remain", () => {
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "failed",
      error: { code: "download_failed", message: "upstream 503", retryable: true },
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.status).toBe("queued");
    expect(decision.retry).toBe(true);
    // A retried item is not finished, so it carries no finish instant.
    expect(decision.finishedAt).toBeNull();
    expect(decision.lastError).toEqual({
      code: "download_failed",
      message: "upstream 503",
      at: NOW,
      retryable: true,
    });
  });

  it("U1: fails a retryable failure once the attempt budget is spent", () => {
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "failed",
      error: { code: "inference_timeout", message: "no answer in 30s", retryable: true },
      attempts: MAX_ATTEMPTS,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.status).toBe("failed");
    expect(decision.retry).toBe(false);
    expect(decision.finishedAt).toBe(NOW);
    expect(decision.lastError).toEqual({
      code: "inference_timeout",
      message: "no answer in 30s",
      at: NOW,
      retryable: true,
    });
  });

  it("U1: fails a non-retryable failure immediately, with attempts still left", () => {
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "failed",
      error: { code: "corrupt_image", message: "truncated JPEG", retryable: false },
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.status).toBe("failed");
    expect(decision.retry).toBe(false);
    expect(decision.finishedAt).toBe(NOW);
    expect(decision.lastError).toEqual({
      code: "corrupt_image",
      message: "truncated JPEG",
      at: NOW,
      retryable: false,
    });
  });

  it("U1: marks a skipped item skipped and keeps an empty error slot", () => {
    const decision = reduceReportItem({
      kind: "event_image",
      outcome: "skipped",
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision).toEqual({
      status: "skipped",
      retry: false,
      finishedAt: NOW,
      lastError: null,
    });
  });

  it("U3: treats a liveness failure as terminal even when the worker calls it retryable", () => {
    const decision = reduceReportItem({
      kind: "selfie",
      outcome: "failed",
      error: { code: "liveness_failed", message: "screen replay detected", retryable: true },
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.status).toBe("failed");
    expect(decision.retry).toBe(false);
    expect(decision.finishedAt).toBe(NOW);
  });

  it("U3: keeps the liveness failure code so the poll can render its detail", () => {
    // `GET …/me` maps `processing.lastError.code === "liveness_failed"` onto the
    // §6.4 `liveness_failed` statusDetail, so the code must survive the reducer.
    const decision = reduceReportItem({
      kind: "selfie",
      outcome: "failed",
      error: { code: "liveness_failed", message: "screen replay detected", retryable: false },
      attempts: 1,
      maxAttempts: MAX_ATTEMPTS,
      now: NOW,
    });

    expect(decision.lastError).toEqual({
      code: "liveness_failed",
      message: "screen replay detected",
      at: NOW,
      retryable: false,
    });
  });
});
