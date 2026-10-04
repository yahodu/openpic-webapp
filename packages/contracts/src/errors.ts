import { z } from "zod";

/**
 * The shared HTTP error contract (API contract §0.15 / Appendix A).
 *
 * Every endpoint answers a failure with the same envelope, so a client can
 * branch on `error.code` alone and never parse a human message. The codes are
 * the closed set the server may emit; the transport-level status and retry
 * policy are decided server-side (see the server error catalogue).
 */

/** The closed set of error codes a response may carry. */
export const ERROR_CODES = [
  "bad_request",
  "malformed_json",
  "unauthenticated",
  "invalid_credentials",
  "payment_required",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "conflict",
  "idempotency_conflict",
  "gone",
  "precondition_failed",
  "payload_too_large",
  "unsupported_media_type",
  "validation_failed",
  "locked",
  "failed_dependency",
  "rate_limited",
  "internal_error",
  "not_implemented",
  "bad_gateway",
  "service_unavailable",
  "gateway_timeout",
] as const;

/** A member of the closed {@link ERROR_CODES} set. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes a shared pipeline stage emits whose HTTP transport is defined by the
 * stage's own story (API contract §0.9) rather than by Appendix A.
 *
 * They are part of the client-facing code enum so `error.code` is a closed set,
 * but they carry no Appendix A row; the server transports them from the stage
 * that owns them (the idempotency stage).
 */
export const PIPELINE_ERROR_CODES = [
  "idempotency_in_progress",
  "idempotency_key_reuse",
  "idempotency_key_required",
] as const;

/** A member of the {@link PIPELINE_ERROR_CODES} set. */
export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];

/**
 * Codes the edge gate (middleware) emits before the request reaches the
 * application pipeline.
 *
 * They share the client envelope but are not built through the server
 * `AppError` catalogue, which only maps the application pipeline's business
 * errors to a status/retry policy; the middleware serializes its own minimal
 * `403` response. Kept separate so the business catalogue can stay an exact,
 * exhaustively-typed table.
 */
export const EDGE_ERROR_CODES = ["csrf_failed"] as const;

/** A member of the {@link EDGE_ERROR_CODES} set. */
export type EdgeErrorCode = (typeof EDGE_ERROR_CODES)[number];

/** Every code a client-facing error envelope may carry (business + edge + pipeline). */
export const API_ERROR_CODES = [
  ...ERROR_CODES,
  ...EDGE_ERROR_CODES,
  ...PIPELINE_ERROR_CODES,
] as const;

/** A member of the {@link API_ERROR_CODES} set. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Codes the server `AppError` may carry: the business catalogue plus the
 * pipeline codes. Edge codes (`csrf_failed`) are emitted by middleware before
 * the pipeline and are never raised as `AppError`s.
 */
export type AppErrorCode = ErrorCode | PipelineErrorCode;

/** Zod enum mirroring {@link API_ERROR_CODES}, for validating `error.code`. */
export const errorCodeSchema = z.enum(API_ERROR_CODES);

/** One offending field of a rejected request. */
export interface FieldError {
  /** Dot path to the field, e.g. `items.0.hash` (empty for a root-level issue). */
  readonly path: string;
  /** The raw Zod issue code, so a client can localise without parsing `message`. */
  readonly code: string;
  /** The human-readable issue message. */
  readonly message: string;
}

/** Zod schema for {@link FieldError}. */
export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

/**
 * The machine-readable error body.
 *
 * `requestId` correlates the client's failure with the server log line and
 * `retryable` tells the client whether a retry can succeed, so neither needs
 * to be inferred from the status code.
 */
export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Correlation id echoed from the `x-request-id` response header. */
  readonly requestId: string;
  /** Whether the client may retry the same request. */
  readonly retryable: boolean;
  /** Structured, non-sensitive context (e.g. `fields`, `loginUrl`). */
  readonly details?: Record<string, unknown>;
}

/** The top-level JSON envelope for every failure response. */
export interface ApiErrorEnvelope {
  readonly error: ApiError;
}

/** Zod schema for {@link ApiError}. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Inferred DTO for {@link ApiErrorEnvelope}. */
export type ApiErrorEnvelopeDto = z.infer<typeof apiErrorSchema>;
