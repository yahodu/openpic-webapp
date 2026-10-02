/**
 * Error serialization for the `err` log field.
 *
 * Produces a bounded, JSON-safe projection of a thrown value:
 *   - `name`, `message` and, when present, the stable machine `code`;
 *   - the `cause` chain is walked at most {@link MAX_CAUSE_DEPTH} links deep,
 *     bounding payload size;
 *   - the `stack` is kept outside production, and in production only for
 *     server errors (5xx) — 4xx denial noise is dropped.
 */

import type { SerializedError } from "./types";

/** Maximum number of `cause` links serialized beneath the root error. */
const MAX_CAUSE_DEPTH = 5;

/** The status assumed when an error carries neither `status` nor `statusCode`. */
const DEFAULT_STATUS = 500;

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly stack?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike {
  return typeof value === "object" && value !== null ? value : {};
}

function readStatus(value: unknown): number {
  const error = asErrorLike(value);
  if (typeof error.status === "number") {
    return error.status;
  }
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return DEFAULT_STATUS;
}

function readName(value: unknown): string {
  if (value instanceof Error) {
    return value.name;
  }
  const error = asErrorLike(value);
  return typeof error.name === "string" ? error.name : "Error";
}

function readMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  const error = asErrorLike(value);
  if (typeof error.message === "string") {
    return error.message;
  }
  return String(value);
}

function readCode(value: unknown): string | undefined {
  const error = asErrorLike(value);
  return typeof error.code === "string" ? error.code : undefined;
}

function readStack(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.stack;
  }
  const error = asErrorLike(value);
  return typeof error.stack === "string" ? error.stack : undefined;
}

/**
 * Serialize an error (and its cause chain) for the `err` field.
 *
 * @param value - The thrown value attached to the log call.
 * @param env - The application environment, governing the stack policy.
 * @param depth - Current cause depth (internal; callers omit it).
 * @returns A bounded, JSON-safe error projection.
 */
export function serializeError(value: unknown, env?: string, depth = 0): SerializedError {
  const status = readStatus(value);
  const includeStack = env !== "production" || status >= 500;

  const code = readCode(value);
  const stack = includeStack ? readStack(value) : undefined;
  const cause = depth < MAX_CAUSE_DEPTH ? asErrorLike(value).cause : undefined;

  return {
    name: readName(value),
    message: readMessage(value),
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
    ...(cause === undefined ? {} : { cause: serializeError(cause, env, depth + 1) }),
  };
}
