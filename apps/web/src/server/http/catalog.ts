import type { AppErrorCode, ErrorCode, PipelineErrorCode } from "@openpic/contracts";

/**
 * The server error catalogue — the executable copy of contract Appendix A.
 *
 * One transport status, one retry policy and one safe default message per code,
 * so the mapping from `error.code` to HTTP behaviour lives in a single place and
 * a client can branch on the code without guessing. The default messages are
 * deliberately generic: they are what a client sees when the underlying error is
 * not safe to expose (never-return rules, CONVENTIONS §8.1).
 */
export interface ErrorCatalogEntry {
  /** The HTTP status this code is served with by default. */
  readonly status: number;
  /** Whether the client may retry the same request. */
  readonly retryable: boolean;
  /** The generic, non-sensitive message used when nothing exposes more. */
  readonly message: string;
}

/** The full code -> {status, retryable, message} table (contract Appendix A). */
export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  bad_request: { status: 400, retryable: false, message: "The request is invalid." },
  malformed_json: { status: 400, retryable: false, message: "The request body is not valid JSON." },
  unauthenticated: { status: 401, retryable: false, message: "Authentication is required." },
  invalid_credentials: { status: 401, retryable: false, message: "The credentials are invalid." },
  payment_required: { status: 402, retryable: false, message: "Payment is required." },
  forbidden: { status: 403, retryable: false, message: "You do not have access to this resource." },
  not_found: { status: 404, retryable: false, message: "The resource was not found." },
  method_not_allowed: {
    status: 405,
    retryable: false,
    message: "The method is not allowed for this resource.",
  },
  conflict: {
    status: 409,
    retryable: false,
    message: "The request conflicts with the current state.",
  },
  idempotency_conflict: {
    status: 409,
    retryable: false,
    message: "This idempotency key was reused with a different request.",
  },
  gone: { status: 410, retryable: false, message: "The resource is no longer available." },
  precondition_failed: {
    status: 412,
    retryable: false,
    message: "A precondition for the request failed.",
  },
  payload_too_large: { status: 413, retryable: false, message: "The request body is too large." },
  unsupported_media_type: {
    status: 415,
    retryable: false,
    message: "The request Content-Type must be application/json.",
  },
  validation_failed: { status: 422, retryable: false, message: "The request body is invalid." },
  locked: { status: 423, retryable: false, message: "The resource is locked." },
  failed_dependency: {
    status: 424,
    retryable: true,
    message: "A dependency of the request failed.",
  },
  rate_limited: { status: 429, retryable: true, message: "Too many requests, slow down." },
  internal_error: { status: 500, retryable: false, message: "An unexpected error occurred." },
  not_implemented: { status: 501, retryable: false, message: "This endpoint is not implemented." },
  bad_gateway: { status: 502, retryable: true, message: "An upstream service returned an error." },
  service_unavailable: {
    status: 503,
    retryable: true,
    message: "The service is temporarily unavailable.",
  },
  gateway_timeout: { status: 504, retryable: true, message: "An upstream service timed out." },
};

/**
 * Transport for pipeline codes that carry no Appendix A row (contract §0.9).
 *
 * A shared pipeline stage owns the status/retry policy of its own error codes;
 * keeping them out of {@link ERROR_CATALOG} preserves that table as the exact,
 * exhaustive copy of Appendix A while still giving `appError` a default
 * transport for every member of the client code enum.
 */
export const PIPELINE_ERROR_TRANSPORT: Readonly<Record<PipelineErrorCode, ErrorCatalogEntry>> = {
  idempotency_in_progress: {
    status: 409,
    retryable: true,
    message: "A request with this idempotency key is still in progress.",
  },
  idempotency_key_reuse: {
    status: 422,
    retryable: false,
    message: "This idempotency key was reused with a different request.",
  },
  idempotency_key_required: {
    status: 400,
    retryable: false,
    message: "This endpoint requires an Idempotency-Key header.",
  },
  invalid_cursor: {
    status: 400,
    retryable: false,
    message: "The pagination cursor is invalid.",
  },
  precondition_required: {
    status: 428,
    retryable: false,
    message: "This request requires an If-Match precondition.",
  },
  etag_mismatch: {
    status: 412,
    retryable: false,
    message: "The resource changed since the supplied entity tag.",
  },
};

/** Every client-facing code's transport: Appendix A first, then pipeline codes. */
const TRANSPORT: Readonly<Record<AppErrorCode, ErrorCatalogEntry>> = {
  ...ERROR_CATALOG,
  ...PIPELINE_ERROR_TRANSPORT,
};

/**
 * Resolve the catalogue entry (status, retry policy, safe message) for a code.
 *
 * @param code - Any code an `AppError` may carry.
 * @returns The code's transport entry.
 */
export function catalogEntryFor(code: AppErrorCode): ErrorCatalogEntry {
  return TRANSPORT[code];
}
