import { describe, expect, it } from "vitest";

import { UpstreamContractError, classifyTransportFailure } from "@/server/adapters/transport-error";

/**
 * U1 — the transport error classifier.
 *
 * The classifier is the single mapping from an upstream outcome to the retry
 * policy the dispatch ledger records (`notificationDispatches.lastError.retryable`)
 * and the retry worker branches on. Getting this table wrong means either a
 * permanent failure is retried forever or a transient one is dropped.
 *
 *   - 4xx (except 408/429): the request itself is wrong — never retry.
 *   - 408 / 429 / 5xx: transient — retry.
 *   - a network failure or an aborted (timed-out) request: retry.
 *   - an upstream contract violation: the shape changed, a retry cannot fix it.
 */
describe("classifyTransportFailure", () => {
  it.each([[400], [401], [403], [404], [409], [422]])(
    "marks HTTP %i as non-retryable",
    (status) => {
      // Arrange / Act
      const failure = classifyTransportFailure({ status });

      // Assert
      expect(failure.retryable).toBe(false);
      expect(failure.status).toBe(status);
    }
  );

  it.each([[408], [429], [500], [502], [503], [504]])("marks HTTP %i as retryable", (status) => {
    // Arrange / Act
    const failure = classifyTransportFailure({ status });

    // Assert
    expect(failure.retryable).toBe(true);
    expect(failure.status).toBe(status);
  });

  it("marks an aborted (timed-out) request as a retryable timeout", () => {
    // Arrange
    const abort = new DOMException("The operation was aborted.", "AbortError");

    // Act
    const failure = classifyTransportFailure({ error: abort });

    // Assert
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("timeout");
  });

  it("marks a network failure as retryable", () => {
    // Arrange
    const error = new TypeError("fetch failed");

    // Act
    const failure = classifyTransportFailure({ error });

    // Assert
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("network");
  });

  it("marks an upstream contract violation as non-retryable", () => {
    // Arrange
    const error = new UpstreamContractError("Novu returned an unexpected payload shape.");

    // Act
    const failure = classifyTransportFailure({ error });

    // Assert
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe("upstream_contract_violation");
  });
});
