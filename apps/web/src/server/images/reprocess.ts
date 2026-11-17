/**
 * The reprocess state reset (OP-127 U2, contract §4.4, schema §18.2).
 *
 * A reprocess is a **pipeline** retry, not a new upload: the row keeps its
 * identity, its asset, its sequence and its counters, and only its durable job
 * state returns to the start of the queue. What is cleared, what is preserved
 * and what is re-stamped is the whole contract of this function.
 */

/** The `event_images.processing` pipeline state (schema §18.2). */
export interface ProcessingState {
  readonly status?: string;
  readonly priority?: string;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly leaseExpiresAt?: Date | null;
  readonly workerId?: string | null;
  readonly queuedAt?: Date;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
  readonly durationMs?: number | null;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
    readonly at: Date;
    readonly retryable: boolean;
  } | null;
  readonly queueRef?: {
    readonly queueKey: string;
    readonly provider: string;
    readonly messageId: string;
  } | null;
  readonly modelKeys?: Readonly<Record<string, string>>;
}

/**
 * Reset a row's pipeline state for a fresh attempt.
 *
 * `attempts` is zeroed but `maxAttempts` is preserved (a reprocess buys a fresh
 * attempt budget, not a wider one); `priority` and `modelKeys` are policy and
 * reproducibility, not run state, so they survive. `queueRef` is cleared because
 * the enqueue that follows writes the new broker id — a stale pointer would make
 * the sweep believe a message exists (§18.1).
 *
 * @param current - The row's stored pipeline state, if it has one.
 * @param now - The instant the reset is stamped with.
 * @returns The queued state to store.
 */
export function resetProcessingForReprocess(
  current: ProcessingState | undefined,
  now: Date
): ProcessingState {
  return {
    ...current,
    status: "queued",
    attempts: 0,
    leaseExpiresAt: null,
    workerId: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    lastError: null,
    queueRef: null,
  };
}
