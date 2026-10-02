import { buildHealthResponse } from "@openpic/contracts";
import { after } from "next/server";

import { requestLogger, type Logger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithRequestContext,
} from "@/server/runtime/request-context";

/** Matched route template bound to both the context and the access log line. */
const ROUTE = "/api/v1/health";

/**
 * Defer the logger flush to after the response is sent.
 *
 * In a real Next.js request this registers the flush with `after()`. When the
 * handler is invoked directly (unit/integration tests, scripts) there is no
 * request scope, so `after()` throws — there is nothing to defer and the
 * transports flush on their own. The seam must never break the handler.
 */
function flushAfterResponse(logger: Logger): void {
  try {
    after(() => logger.flush());
  } catch {
    // No Next.js request scope; the flush is a no-op here.
  }
}

/**
 * Liveness probe.
 *
 * Reports that the process is up. Deliberately dependency-free: it must keep
 * answering even when downstream services are unreachable. Resolves the
 * inbound `x-request-id` (validating it, minting `req_` + ULID otherwise),
 * runs its work inside the request context, and echoes the resolved id on the
 * response so the header and the access log correlation id always agree.
 * Emits exactly one `http.request` access line through the logging port,
 * scoped to the request.
 *
 * @param request - Inbound request (used to resolve the request id).
 * @returns `200` with a `{ status: 'ok' }` body, `Cache-Control: no-store` and
 *   the `x-request-id` echo.
 * @see API contract §4.1
 */
export function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  const startedAt = systemClock.now();

  const response = runWithRequestContext({ requestId, route: ROUTE, startedAt }, () => {
    const logger = requestLogger(request, { route: ROUTE });
    const body = buildHealthResponse();
    const response = new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        [REQUEST_ID_HEADER]: requestId,
      },
    });

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

  return Promise.resolve(response);
}
