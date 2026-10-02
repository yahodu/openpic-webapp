import { buildHealthResponse } from "@openpic/contracts";
import { after } from "next/server";

import { requestLogger, type Logger } from "@/server/logging";

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
 * answering even when downstream services are unreachable. Emits exactly one
 * `http.request` access line through the logging port, scoped to the request.
 *
 * @param request - Inbound request (used to derive the request id).
 * @returns `200` with a `{ status: 'ok' }` body and `Cache-Control: no-store`.
 * @see API contract §4.1
 */
export function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const logger = requestLogger(request, { route: "/api/v1/health" });

  const body = buildHealthResponse();
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

  logger.info("request completed", {
    event: "http.request",
    durationMs: Date.now() - startedAt,
  });
  flushAfterResponse(logger);

  return Promise.resolve(response);
}
