import { MongoError } from "mongodb";
import { describe, expect, it } from "vitest";

import { classifyMongoError, type MongoRetryAction } from "./retry";

/**
 * Contract under test — `src/server/db/retry.ts`.
 *
 * MongoDB signals *how* a failed operation should be retried through error
 * labels, not through error codes. The driver sets exactly two retry labels:
 *
 *   - `TransientTransactionError`        -> the WHOLE transaction must be re-run
 *   - `UnknownTransactionCommitResult`   -> only the COMMIT must be re-sent
 *
 * The retry policy classifies an arbitrary thrown value onto one of three
 * actions so callers never have to reach into the driver's error internals:
 *
 *   classifyMongoError(error): "retry-transaction" | "retry-commit" | "no-retry"
 *
 * Rules encoded below:
 *   - A value carrying `TransientTransactionError` is `"retry-transaction"`.
 *   - A value carrying only `UnknownTransactionCommitResult` is `"retry-commit"`.
 *   - When BOTH labels are present, re-running the transaction wins
 *     (`"retry-transaction"`), because a commit retry alone could miss work
 *     that never committed.
 *   - Anything without a recognised retry label — including non-errors, missing
 *     `errorLabels` and unknown labels — is `"no-retry"`.
 *
 * The classification must read both a plain object's `errorLabels` array and a
 * real driver `MongoError` (`hasErrorLabel`), so both shapes are exercised.
 */
describe("classifyMongoError", () => {
  it.each<[string, unknown, MongoRetryAction]>([
    [
      "a TransientTransactionError retries the whole transaction",
      { errorLabels: ["TransientTransactionError"] },
      "retry-transaction",
    ],
    [
      "an UnknownTransactionCommitResult retries the commit only",
      { errorLabels: ["UnknownTransactionCommitResult"] },
      "retry-commit",
    ],
    [
      "a TransientTransactionError wins when both labels are present",
      { errorLabels: ["UnknownTransactionCommitResult", "TransientTransactionError"] },
      "retry-transaction",
    ],
    [
      "a transient label mixed with an unrelated label still retries the transaction",
      { errorLabels: ["NotWritablePrimary", "TransientTransactionError"] },
      "retry-transaction",
    ],
    ["an error with no labels is not retried", { errorLabels: [] }, "no-retry"],
    ["an error without an errorLabels field is not retried", {}, "no-retry"],
    [
      "an unrecognised label is not retried",
      { errorLabels: ["SomethingElseEntirely"] },
      "no-retry",
    ],
    ["a plain string is not retried", "boom", "no-retry"],
    ["null is not retried", null, "no-retry"],
    ["undefined is not retried", undefined, "no-retry"],
  ])("%s", (_name, error, expected) => {
    expect(classifyMongoError(error)).toBe(expected);
  });

  it("classifies a real driver MongoError by its label", () => {
    const error = new MongoError("transaction aborted");
    error.addErrorLabel("TransientTransactionError");

    expect(classifyMongoError(error)).toBe("retry-transaction");
  });

  it("does not retry a real driver error without a retry label", () => {
    const error = new MongoError("duplicate key");

    expect(classifyMongoError(error)).toBe("no-retry");
  });
});
