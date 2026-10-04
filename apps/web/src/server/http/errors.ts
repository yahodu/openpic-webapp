import type { AppErrorCode } from "@openpic/contracts";

import { AppError, type AppErrorOptions } from "./app-error";

export { ERROR_CATALOG, PIPELINE_ERROR_TRANSPORT, type ErrorCatalogEntry } from "./catalog";

/**
 * The error catalogue facade: a factory plus a type guard.
 *
 * The catalogue itself ({@link ERROR_CATALOG}) is the single source of truth for
 * `code -> {status, retryable}`. Business code builds errors through
 * {@link appError} so it never hand-writes a status, and the pipeline branches
 * with {@link isAppError} to tell an expected failure from an unknown throw.
 */

/**
 * Build an `AppError` with the catalogue defaults for `code`.
 *
 * @param code - A member of the client-facing error catalogue.
 * @param options - Message/details and transport overrides.
 * @returns An `AppError` carrying the catalogue status and retry policy.
 * @example
 * throw appError("not_found", { details: { resource: "photo" } });
 */
export function appError(code: AppErrorCode, options: AppErrorOptions = {}): AppError {
  return new AppError(code, options);
}

/**
 * Narrow an unknown caught value to an `AppError`.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is an `AppError`.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
