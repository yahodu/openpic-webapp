import { AsyncLocalStorage } from "node:async_hooks";

import { idGenerator } from "./ids";

/**
 * Request-scoped context and request-id handling (OP-72, epic Runtime
 * Primitives).
 *
 * The context is carried on `AsyncLocalStorage`, so it is visible for the whole
 * async tree of a request and never leaks across concurrent operations.
 */

/** Inbound and outbound correlation header. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * An inbound request id is trusted only when it is a short, log-safe token.
 * Anything else is replaced, so a client can never inject into logs via the
 * header (newlines, quotes, control characters, oversize values).
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The context bound to every operation inside one request. */
export interface RequestContext {
  /** The resolved correlation id (validated inbound, or generated). */
  readonly requestId: string;
  /** The matched route template, e.g. `/api/v1/health`. */
  readonly route: string;
  /** When the request scope was opened. */
  readonly startedAt: Date;
  /** The authenticated principal, when known. */
  readonly principal?: string;
  /** The `session` id (hex) backing the request, when known. */
  readonly sessionId?: string;
  /** The tenant scope, when known. */
  readonly tenantId?: string;
}

/**
 * Mint a fresh correlation id: `req_` + a 26-character ULID.
 *
 * @returns A collision-resistant, sortable request id.
 */
export function newRequestId(): string {
  return `req_${idGenerator.ulid()}`;
}

/**
 * Resolve the correlation id for an inbound request.
 *
 * @param inbound - The raw `x-request-id` header value, if any.
 * @returns `inbound` when it is a log-safe token, otherwise a fresh id.
 */
export function resolveRequestId(inbound: string | null | undefined): string {
  if (typeof inbound === "string" && VALID_REQUEST_ID.test(inbound)) {
    return inbound;
  }

  return newRequestId();
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` bound as the active request scope.
 *
 * The context is visible to every `await`/callback in `fn`'s async tree and is
 * restored to the previous scope (or cleared) when `fn` returns.
 *
 * @param context - The request scope to bind.
 * @param fn - The work to run inside the scope.
 * @returns Whatever `fn` returns.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The active request context, or `undefined` outside a request scope.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
