/**
 * The worker-report outcome reducer (OP-135; contract §10.3.2, §10.3.3; schema
 * §18.2; ADR-0829 §1).
 *
 * `POST /api/v1/internal/worker/report` does not translate a worker's verdict
 * into `processing` state inline: the sweep, the queue publisher and the
 * attempt budget all read that state, so the mapping is one pure function and
 * this module is its contract.
 *
 *   - `done` is terminal and **zero faces is still `done`** — §10.3.3 lists
 *     `no_faces_detected` as `outcome: "done"` with `faceCount: 0`.
 *   - a **retryable** failure returns the item to `queued` while `attempts <
 *     maxAttempts` and lands on `failed` at the budget.
 *   - a **non-retryable** failure is `failed` immediately, and `liveness_failed`
 *     is terminal even when the worker marks it retryable: re-running inference
 *     cannot improve a liveness verdict, and a retry would spend the attendee's
 *     own attempt budget (§6.3, §14.1). The code is kept verbatim because §6.4
 *     renders the `liveness_failed` detail from exactly that field.
 *
 * The reducer never reads the clock: the caller passes `now`, so `finishedAt`
 * and `lastError.at` are exact (ADR-0007).
 */

/** The `processing.status` a report can produce (schema §18.2). */
export type OutcomeStatus = "queued" | "done" | "failed" | "skipped";

/** The worker's own failure descriptor, as the report body carries it. */
export interface ReportItemError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** The failure descriptor as `processing.lastError` stores it (schema §18.2). */
export interface StoredPipelineError {
  readonly code: string;
  readonly message: string;
  readonly at: Date;
  readonly retryable: boolean;
}

/** One item's verdict and the stored facts the decision needs. */
export interface ReportItemOutcomeInput {
  /** The work item's kind; only the liveness rule is kind-independent today. */
  readonly kind: "event_image" | "selfie";
  readonly outcome: "done" | "failed" | "skipped";
  /** `no_faces_detected` is a `done` with zero faces, never a failure. */
  readonly faceCount?: number;
  readonly error?: ReportItemError;
  /** `processing.attempts` as the stored row carries it. */
  readonly attempts: number;
  /** The item's own `processing.maxAttempts` (§18.2). */
  readonly maxAttempts: number;
  /** Injected, so `finishedAt` / `lastError.at` are exact (ADR-0007). */
  readonly now: Date;
}

/** What the report writes onto `processing`. */
export interface ReportOutcomeDecision {
  readonly status: OutcomeStatus;
  readonly retry: boolean;
  readonly finishedAt: Date | null;
  readonly lastError: StoredPipelineError | null;
}

/**
 * The failure codes that are terminal however the worker classifies them.
 *
 * A liveness verdict is a property of the photograph, not of the run, so
 * re-running inference cannot improve it (§10.3.3, §14.1).
 */
const TERMINAL_FAILURE_CODES: ReadonlySet<string> = new Set(["liveness_failed"]);

/**
 * Map one reported item onto its stored `processing` decision.
 *
 * @param input - The kind, verdict, attempt accounting and the report instant.
 * @returns The status to store, whether to retry, the finish instant and error.
 */
export function reduceReportItem(input: ReportItemOutcomeInput): ReportOutcomeDecision {
  if (input.outcome === "done" || input.outcome === "skipped") {
    return { status: input.outcome, retry: false, finishedAt: input.now, lastError: null };
  }

  const error = input.error;
  const lastError: StoredPipelineError | null =
    error === undefined
      ? null
      : { code: error.code, message: error.message, at: input.now, retryable: error.retryable };

  const retry =
    error !== undefined &&
    error.retryable &&
    !TERMINAL_FAILURE_CODES.has(error.code) &&
    input.attempts < input.maxAttempts;

  return {
    status: retry ? "queued" : "failed",
    retry,
    // A retried item is not finished, so it carries no finish instant.
    finishedAt: retry ? null : input.now,
    lastError,
  };
}
