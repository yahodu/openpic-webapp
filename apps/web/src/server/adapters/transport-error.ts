/**
 * Transport failure classification (OP-92, ADR-0072).
 *
 * The dispatch ledger records `notificationDispatches.lastError.retryable` and
 * the retry worker branches on it, so the mapping from an upstream outcome to
 * the retry policy lives in exactly one place. Getting this table wrong means
 * either retrying a permanent failure forever or dropping a transient one.
 */

/** The classified retry policy for a transport failure. */
export interface TransportFailure {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;
}

/** Construction options for a {@link TransportError}. */
export interface TransportErrorOptions {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;
}

/**
 * A classified transport failure.
 *
 * The retry policy travels on the thrown error itself, so callers (and the
 * dispatch ledger) can branch on `retryable`/`code`/`status` without a second
 * lookup.
 */
export class TransportError extends Error implements TransportFailure {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;

  constructor(message: string, options: TransportErrorOptions) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "TransportError";
    this.retryable = options.retryable;
    this.code = options.code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

/**
 * The provider answered with a payload that no longer matches the pinned wire
 * contract.
 *
 * A shape change is a code/config problem: a retry cannot fix it, so this is
 * always non-retryable.
 */
export class UpstreamContractError extends TransportError {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, {
      retryable: false,
      code: "upstream_contract_violation",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "UpstreamContractError";
  }
}

/** True for a `fetch` abort (a DOMException or Error named `AbortError`). */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

/**
 * Map an upstream outcome to its retry policy.
 *
 * @param input - Either an HTTP `status` or the thrown `error`.
 * @returns The classified failure, carrying `retryable` and `code`.
 */
export function classifyTransportFailure(input: {
  readonly status?: number;
  readonly error?: unknown;
}): TransportError {
  if (input.error !== undefined) {
    if (input.error instanceof UpstreamContractError) {
      return input.error;
    }
    if (isAbortError(input.error)) {
      return new TransportError("Transport request timed out.", {
        retryable: true,
        code: "timeout",
        cause: input.error,
      });
    }
    return new TransportError("Transport request failed.", {
      retryable: true,
      code: "network",
      cause: input.error,
    });
  }

  const status = input.status ?? 0;
  const retryable = status === 408 || status === 429 || status >= 500;

  return new TransportError(`Transport request failed with status ${String(status)}.`, {
    retryable,
    code: "http",
    status,
  });
}
