import { buildHealthResponse } from "@openpic/contracts";

/**
 * Liveness probe.
 *
 * Reports that the process is up. Deliberately dependency-free: it must keep
 * answering even when downstream services are unreachable.
 *
 * @param _request - Inbound request (unused by liveness).
 * @returns `200` with a `{ status: 'ok' }` body and `Cache-Control: no-store`.
 * @see API contract §4.1
 */
export function GET(_request: Request): Promise<Response> {
  const body = buildHealthResponse();

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  );
}
