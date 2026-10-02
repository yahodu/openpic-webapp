import type { ClientSession } from "mongodb";

import { getLogger } from "../logging";
import type { LogFields } from "../logging";
import { getMongoClient } from "./mongo";

/**
 * Multi-document transaction helper (OP-75, §2).
 *
 * Runs a callback inside a single MongoDB transaction against the pooled client
 * singleton, committing when the callback resolves and aborting when it rejects.
 * Majority read/write concerns are the default so a committed write is durable
 * across the replica set.
 *
 * Retry semantics are bounded: the driver's `session.withTransaction` re-runs
 * the callback on `TransientTransactionError` and re-sends the commit on
 * `UnknownTransactionCommitResult`, while this wrapper caps the total number of
 * callback attempts and emits a `db.transaction.retry` warn line per retry.
 */

/** The default retry budget for a transaction (attempts, not retries). */
export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3;

/** Caller-tunable transaction behaviour. */
export interface WithTransactionOptions {
  /** Total attempts allowed, including the first. Defaults to 3. */
  readonly maxAttempts?: number;
}

/**
 * Raised from inside the transaction callback once the attempt budget is spent.
 *
 * It is deliberately not a `MongoError`, so the driver aborts and rethrows it
 * rather than retrying again — that is what bounds the retry loop.
 */
class TransactionRetryLimitError extends Error {
  constructor(maxAttempts: number) {
    super(`transaction retry limit reached after ${String(maxAttempts)} attempts`);
    this.name = "TransactionRetryLimitError";
  }
}

/**
 * Run `fn` inside a single MongoDB transaction.
 *
 * @param fn - The transaction body; every operation must pass `{ session }`.
 * @param options - Optional attempt budget.
 * @returns Whatever `fn` resolved to once the transaction committed.
 * @throws Whatever `fn` threw (after the transaction is aborted).
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: WithTransactionOptions = {}
): Promise<T> {
  const client = getMongoClient();
  const session = client.startSession();
  const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS;
  let attempt = 0;

  try {
    return await session.withTransaction(
      async () => {
        attempt += 1;
        if (attempt > maxAttempts) {
          throw new TransactionRetryLimitError(maxAttempts);
        }
        if (attempt > 1) {
          const fields: LogFields = {
            event: "db.transaction.retry",
            attempt,
            maxAttempts,
          };
          getLogger().warn("db.transaction.retry", fields);
        }
        return fn(session);
      },
      { readConcern: { level: "majority" }, writeConcern: { w: "majority" } }
    );
  } finally {
    await session.endSession();
  }
}
