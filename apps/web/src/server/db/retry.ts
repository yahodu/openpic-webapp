/**
 * MongoDB retry classification (OP-75, §2).
 *
 * MongoDB signals *how* a failed operation should be retried through error
 * labels, not through error codes. The driver sets exactly two retry labels:
 *
 *   - `TransientTransactionError`      -> the WHOLE transaction must be re-run
 *   - `UnknownTransactionCommitResult` -> only the COMMIT must be re-sent
 *
 * `classifyMongoError` projects an arbitrary thrown value onto one of three
 * actions so callers never have to reach into the driver's error internals.
 */

/** How a failed Mongo operation should be retried. */
export type MongoRetryAction = "retry-transaction" | "retry-commit" | "no-retry";

/** Label the driver attaches when the whole transaction must be re-run. */
const TRANSIENT_TRANSACTION_LABEL = "TransientTransactionError";

/** Label the driver attaches when only the commit must be re-sent. */
const UNKNOWN_COMMIT_LABEL = "UnknownTransactionCommitResult";

/**
 * True when `error` carries `label`.
 *
 * Reads both a real driver `MongoError` (which exposes `hasErrorLabel`) and a
 * plain object carrying an `errorLabels` array, so callers can be tested with
 * either shape.
 */
function hasRetryLabel(error: unknown, label: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    hasErrorLabel?: (value: string) => boolean;
    errorLabels?: unknown;
  };

  if (typeof candidate.hasErrorLabel === "function") {
    // Call as a method so the driver's prototype getter sees its `this`.
    return candidate.hasErrorLabel(label);
  }

  return Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label);
}

/**
 * Classify a thrown value into the retry action its labels demand.
 *
 * A `TransientTransactionError` always wins over an `UnknownTransactionCommitResult`
 * because a commit retry alone could miss work that never committed. Anything
 * without a recognised retry label — including non-errors, a missing
 * `errorLabels` field and unknown labels — is `"no-retry"`.
 *
 * @param error - The value thrown by a Mongo operation.
 * @returns The retry action encoded by the error's labels.
 */
export function classifyMongoError(error: unknown): MongoRetryAction {
  if (hasRetryLabel(error, TRANSIENT_TRANSACTION_LABEL)) {
    return "retry-transaction";
  }

  if (hasRetryLabel(error, UNKNOWN_COMMIT_LABEL)) {
    return "retry-commit";
  }

  return "no-retry";
}
