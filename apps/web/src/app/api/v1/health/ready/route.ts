import { after } from "next/server";

import { getReadinessProbe } from "@/server/db/readiness";
import { requestLogger, type Logger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithRequestContext,
} from "@/server/runtime/request-context";

/**
 * Readiness probe — the dependency-aware sibling of the liveness endpoint
 * (OP-75, §4).
 *
 * Pings MongoDB and answers `200 { status: 'ok' }` when it responds or
 * `503 { status: 'unavailable' }` when it does not. It fails safe: a rejected
 * ping is a deliberate `503` (retryable via `Retry-After`), never a `500`, and
 * the connection string is never logged. `Cache-Control: no-store` keeps an
 * orchestrator from caching the readiness decision.
 */

/** Matched route template bound to both the context and the access log line. */
const ROUTE = "/api/v1/health/ready";

/** Seconds an orchestrator should wait before re-probing an unavailable DB. */
const RETRY_AFTER_SECONDS = 5;

/**
 * Defer the logger flush to after the response is sent (see the liveness probe
 * for the rationale; the seam is a no-op outside a Next.js request scope).
 */
function flushAfterResponse(logger: Logger): void {
  try {
    after(() => logger.flush());
  } catch {
    // No Next.js request scope; the flush is a no-op here.
  }
}

/**
 * Readiness probe handler.
 *
 * @param request - Inbound request (used to resolve the request id).
 * @returns `200` with `{ status: 'ok' }` when the database answers, otherwise
 *   `503` with `{ status: 'unavailable' }` and a `Retry-After` hint.
 * @see API contract §4.2
 */
export function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const startedAt = systemClock.now();

  return runWithRequestContext({ requestId, route: ROUTE, startedAt }, async () => {
    const logger = requestLogger(request, { route: ROUTE });
    let status = 200;
    let body: { status: string } = { status: "ok" };

    try {
      await getReadinessProbe()();
    } catch (error: unknown) {
      status = 503;
      body = { status: "unavailable" };
      // Never attach the raw error: a driver failure can carry the
      // credential-bearing connection string.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      logger.warn("readiness probe failed", {
        event: "health.ready.unavailable",
        status,
        errorName,
      });
    }

    const response = buildResponse(status, body, requestId);
    logger.info("request completed", {
      event: "http.request",
      method: request.method,
      route: ROUTE,
      status: response.status,
      durationMs: systemClock.now().getTime() - startedAt.getTime(),
    });
    flushAfterResponse(logger);

    return response;
  });
}

/** Build the JSON readiness response with the shared wire hygiene. */
function buildResponse(status: number, body: { status: string }, requestId: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  };

  if (status === 503) {
    headers["retry-after"] = String(RETRY_AFTER_SECONDS);
  }

  return new Response(JSON.stringify(body), { status, headers });
}
