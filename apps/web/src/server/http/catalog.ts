import type {
  AccountErrorCode,
  AppErrorCode,
  AuthErrorCode,
  BillingErrorCode,
  EntitlementErrorCode,
  ErrorCode,
  InternalErrorCode,
  NotificationErrorCode,
  PipelineErrorCode,
  RequestShapeErrorCode,
  TenancyErrorCode,
} from "@openpic/contracts";

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

/**
 * Transport for the auth-guard codes (contract Appendix A.1).
 *
 * Kept out of {@link ERROR_CATALOG} so that table stays the exact base Appendix
 * A copy the HTTP-pipeline story pinned; the auth story owns these rows and
 * feeds them into the same dispatch table.
 */
export const AUTH_ERROR_TRANSPORT: Readonly<Record<AuthErrorCode, ErrorCatalogEntry>> = {
  authentication_required: {
    status: 401,
    retryable: false,
    message: "Authentication is required.",
  },
  session_expired: {
    status: 401,
    retryable: false,
    message: "Your session has expired. Please sign in again.",
  },
  account_incomplete: {
    status: 403,
    retryable: false,
    message: "Your account setup is incomplete.",
  },
  admin_2fa_required: {
    status: 403,
    retryable: false,
    message: "Two-factor authentication is required for administrator access.",
  },
  account_banned: {
    status: 423,
    retryable: false,
    message: "This account has been suspended for violating the terms of service.",
  },
  account_suspended: {
    status: 423,
    retryable: false,
    message: "This account is currently suspended.",
  },
};

/**
 * Transport for the request-shape codes (contract Appendix A.2).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the auth codes: the
 * HTTP-pipeline story pinned that table to exactly the base Appendix A rows.
 * The identity story owns these rows and feeds them into the same dispatch
 * table. Both are `422`, non-retryable.
 */
export const REQUEST_SHAPE_ERROR_TRANSPORT: Readonly<
  Record<RequestShapeErrorCode, ErrorCatalogEntry>
> = {
  unknown_timezone: {
    status: 422,
    retryable: false,
    message: "Must be a known IANA time zone.",
  },
  forbidden_field: {
    status: 422,
    retryable: false,
    message: "The request contains a field that may not be changed here.",
  },
};

/**
 * Transport for the account-lifecycle codes (contract §1.3–§1.4, Appendix
 * A.2).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the request-shape
 * codes: that table stays the exact base Appendix A copy. The identity story
 * owns these rows and feeds them into the same dispatch table.
 */
export const ACCOUNT_ERROR_TRANSPORT: Readonly<Record<AccountErrorCode, ErrorCatalogEntry>> = {
  confirmation_mismatch: {
    status: 422,
    retryable: false,
    message: "The confirmation value does not match the account.",
  },
  deletion_already_executed: {
    status: 409,
    retryable: false,
    message: "The account deletion can no longer be cancelled.",
  },
};

/**
 * Transport for the machine-to-machine internal-auth codes (contract §0.3,
 * ADR-0028 §3).
 *
 * Like the auth codes, they are kept out of {@link ERROR_CATALOG} so that table
 * stays the exact base Appendix A copy; the HMAC story owns these rows and
 * feeds them into the same dispatch table. All three are `401`, non-retryable.
 */
export const INTERNAL_ERROR_TRANSPORT: Readonly<Record<InternalErrorCode, ErrorCatalogEntry>> = {
  internal_auth_failed: {
    status: 401,
    retryable: false,
    message: "Internal authentication failed.",
  },
  invalid_signature: {
    status: 401,
    retryable: false,
    message: "The request signature is invalid.",
  },
  stale_signature: {
    status: 401,
    retryable: false,
    message: "The request timestamp is outside the allowed window.",
  },
};

/**
 * Transport for the notification-surface codes (contract §7.4, Appendix A.8).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the request-shape and
 * account codes: that table stays the exact base Appendix A copy. The
 * notification-preferences story owns these rows and feeds them into the same
 * dispatch table. Both are `422`, non-retryable.
 */
export const NOTIFICATION_ERROR_TRANSPORT: Readonly<
  Record<NotificationErrorCode, ErrorCatalogEntry>
> = {
  unknown_type_key: {
    status: 422,
    retryable: false,
    message: "The notification type key is not recognised.",
  },
  opt_out_not_allowed: {
    status: 422,
    retryable: false,
    message: "This notification channel cannot be opted out of.",
  },
};

/**
 * Transport for the tenancy codes (contract §2.1, Appendix A.1/A.4).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the auth and
 * request-shape codes: that table stays the exact base Appendix A copy the
 * HTTP-pipeline story pinned. `tenant_suspended` is the A.1 row for a suspended
 * workspace (`423`, no retry, `{ reason, supportUrl }`) and
 * `invalid_billing_contact` the A.4 row for a billing contact that is not an
 * active member (`422`, no retry). The tenancy story owns both rows and feeds
 * them into the same dispatch table (ADR-0261).
 */
export const TENANCY_ERROR_TRANSPORT: Readonly<Record<TenancyErrorCode, ErrorCatalogEntry>> = {
  tenant_suspended: {
    status: 423,
    retryable: false,
    message: "This workspace is suspended.",
  },
  invalid_billing_contact: {
    status: 422,
    retryable: false,
    message: "The billing contact must be an active member of this workspace.",
  },
  cannot_demote_owner: {
    status: 409,
    retryable: false,
    message: "The workspace owner cannot be demoted or removed.",
  },
};

/**
 * Transport for the entitlement-enforcement codes (contract §0.14, Appendix
 * A.5).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the tenancy codes:
 * that table stays the exact base Appendix A copy. Both rows are `403`,
 * non-retryable — `plan_limit_exceeded` for a hard limit and
 * `feature_not_available` for a disabled feature gate; the `402`
 * (`payment_required`) is already a base {@link ERROR_CATALOG} member. The
 * entitlement story owns these rows and feeds them into the same dispatch table
 * (ADR-0341).
 */
export const ENTITLEMENT_ERROR_TRANSPORT: Readonly<
  Record<EntitlementErrorCode, ErrorCatalogEntry>
> = {
  plan_limit_exceeded: {
    status: 403,
    retryable: false,
    message: "This action exceeds the limit for your current plan.",
  },
  feature_not_available: {
    status: 403,
    retryable: false,
    message: "This feature is not available on your current plan.",
  },
};

/**
 * Transport for the billing-checkout codes (contract §3.3, Appendix A.2/A.4).
 *
 * Kept out of {@link ERROR_CATALOG} for the same reason as the tenancy and
 * entitlement codes: that table stays the exact base Appendix A copy.
 * `invalid_return_url` (`422`, `{ allowedOrigins }`) and `plan_not_self_serve`
 * (`422`, `{ contactSalesUrl }`) are request-shaped refusals;
 * `subscription_already_active` (`409`) reports the live row that blocks the
 * checkout; `upstream_unavailable` (`502`, **retryable**,
 * `{ provider, retryAfterSeconds }`) is the payment-provider failure the client
 * may retry, and the OP-109 plan-change refusals `not_an_upgrade` (`422`,
 * `{ currentTierRank, targetTierRank, downgradeUrl }`) and
 * `acknowledgement_required` (`422`, `{ consequences }`) are appended here in
 * the same shape (ADR-0421, ADR-0460/ADR-0461). The OP-109 follow-up adds
 * `not_a_downgrade` (`422`, `{ currentTierRank, targetTierRank, upgradeUrl }`)
 * — the mirror of `not_an_upgrade` for the downgrade endpoint (ADR-0465).
 */
export const BILLING_ERROR_TRANSPORT: Readonly<Record<BillingErrorCode, ErrorCatalogEntry>> = {
  invalid_return_url: {
    status: 422,
    retryable: false,
    message: "The return URL is not on an allowed origin.",
  },
  plan_not_self_serve: {
    status: 422,
    retryable: false,
    message: "This plan is not available for self-serve checkout.",
  },
  subscription_already_active: {
    status: 409,
    retryable: false,
    message: "This workspace already has a subscription.",
  },
  upstream_unavailable: {
    status: 502,
    retryable: true,
    message: "The payment provider is temporarily unavailable.",
  },
  not_an_upgrade: {
    status: 422,
    retryable: false,
    message: "This plan change is not an upgrade.",
  },
  not_a_downgrade: {
    status: 422,
    retryable: false,
    message: "This plan change is not a downgrade.",
  },
  acknowledgement_required: {
    status: 422,
    retryable: false,
    message: "The consequences of this plan change must be acknowledged first.",
  },
};

/**
 * Every client-facing code's transport: Appendix A first, then the pipeline,
 * auth, request-shape, internal, account, notification and tenancy tables.
 */
const TRANSPORT: Readonly<Record<AppErrorCode, ErrorCatalogEntry>> = {
  ...ERROR_CATALOG,
  ...PIPELINE_ERROR_TRANSPORT,
  ...AUTH_ERROR_TRANSPORT,
  ...REQUEST_SHAPE_ERROR_TRANSPORT,
  ...INTERNAL_ERROR_TRANSPORT,
  ...ACCOUNT_ERROR_TRANSPORT,
  ...NOTIFICATION_ERROR_TRANSPORT,
  ...TENANCY_ERROR_TRANSPORT,
  ...ENTITLEMENT_ERROR_TRANSPORT,
  ...BILLING_ERROR_TRANSPORT,
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
