import type { ApiErrorEnvelope, AppErrorCode } from "@openpic/contracts";

import { catalogEntryFor } from "./catalog";

/**
 * `AppError` — the single error type the HTTP pipeline understands.
 *
 * Any throw that is not an `AppError` is treated as an internal failure, so a
 * driver fragment or thrown string can never reach a client. The transport
 * status and retry policy default from the error catalogue and may be
 * overridden per throw; `expose` controls whether the message (and details) are
 * safe to hand to the caller.
 */
export interface AppErrorOptions {
  /** Client-safe message. Defaults to the catalogue message for the code. */
  readonly message?: string;
  /** Structured, non-sensitive context. Only sent when the error is exposed. */
  readonly details?: Record<string, unknown>;
  /** Overrides the catalogue status. */
  readonly status?: number;
  /** Overrides the catalogue retry policy. */
  readonly retryable?: boolean;
  /** Whether message/details may be sent. Defaults to `status < 500`. */
  readonly expose?: boolean;
  /**
   * Extra response headers to attach when this error becomes a response.
   *
   * The rate-limit stage uses this to carry `Retry-After` and the
   * `RateLimit-*` headers on a `429`; `errorResponse` merges them over its
   * defaults.
   */
  readonly headers?: Record<string, string>;
}

/** A typed application error with an HTTP status and retry policy. */
export class AppError extends Error {
  /** The machine-readable code (Appendix A business or pipeline code). */
  readonly code: AppErrorCode;
  /** The HTTP status this error is served with. */
  readonly status: number;
  /** Whether the client may retry the request. */
  readonly retryable: boolean;
  /** Whether the message/details are safe to expose to the client. */
  readonly expose: boolean;
  /** Structured, non-sensitive context; only sent when exposed. */
  readonly details?: Record<string, unknown>;
  /** Extra response headers to attach when this error becomes a response. */
  readonly headers?: Record<string, string>;
  /** The catalogue's generic message for this code (used when hidden). */
  readonly catalogMessage: string;

  /**
   * @param code - A member of the client-facing error catalogue.
   * @param options - Message/details and transport overrides.
   */
  constructor(code: AppErrorCode, options: AppErrorOptions = {}) {
    const entry = catalogEntryFor(code);
    const status = options.status ?? entry.status;
    super(options.message ?? entry.message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? entry.retryable;
    this.expose = options.expose ?? status < 500;
    this.catalogMessage = entry.message;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.headers !== undefined) {
      this.headers = options.headers;
    }
  }
}

/**
 * Project any thrown value onto the response envelope.
 *
 * A known, exposed `AppError` keeps its message and details; every other value
 * (an unexposed `AppError`, a thrown string/object, a driver error) becomes a
 * generic `500 internal_error` with no details, so the thrown text, a stack
 * frame or a Mongo fragment can never reach the caller.
 *
 * @param error - The caught value.
 * @param requestId - The correlation id to echo in the envelope.
 * @returns A schema-valid `ApiError` envelope.
 */
export function toErrorEnvelope(error: unknown, requestId: string): ApiErrorEnvelope {
  if (error instanceof AppError) {
    const message = error.expose ? error.message : error.catalogMessage;
    const envelope: ApiErrorEnvelope = {
      error: {
        code: error.code,
        message,
        requestId,
        retryable: error.retryable,
        ...(error.expose && error.details !== undefined ? { details: error.details } : {}),
      },
    };
    return envelope;
  }

  return {
    error: {
      code: "internal_error",
      message: catalogEntryFor("internal_error").message,
      requestId,
      retryable: catalogEntryFor("internal_error").retryable,
    },
  };
}
