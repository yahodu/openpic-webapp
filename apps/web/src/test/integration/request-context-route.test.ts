import { describe, expect, it } from "vitest";

import { GET } from "../../app/api/v1/health/route";
import { createLogger, memoryTransport, setLogger } from "../../server/logging";

/**
 * Integration contract — request context wired into a real route handler
 * (OP-72, epic Runtime Primitives).
 *
 * The `GET /api/v1/health` handler must:
 *
 *   - resolve the inbound request id through `resolveRequestId` (echoing a
 *     valid `x-request-id`, minting `req_` + ULID otherwise);
 *   - run its work inside `runWithRequestContext`, so the access log line it
 *     emits carries the resolved `requestId`;
 *   - echo the resolved id back to the caller as the `x-request-id` response
 *     header, so the response header and the log correlation id always agree.
 *
 * The process logger is replaced with a memory-backed logger through the
 * `setLogger` seam so the test can observe exactly what the handler emitted.
 * No outbound HTTP is performed; MSW's fail-closed `onUnhandledRequest: 'error'`
 * (integration setup) guarantees that stays true.
 */

/** Canonical generated shape: `req_` + 26-char Crockford base32 ULID. */
const GENERATED_REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

const HEALTH_URL = "http://localhost/api/v1/health";

function installMemoryLogger(): ReturnType<typeof memoryTransport> {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

describe("GET /api/v1/health — request context and id echo", () => {
  it("I1: echoes a valid inbound id and logs it as the context requestId", async () => {
    const sink = installMemoryLogger();
    const inbound = "0123456789abcdef";

    const response = await GET(
      new Request(HEALTH_URL, { headers: { "x-request-id": inbound } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(inbound);

    const entry = sink.entries.find((candidate) => candidate.event === "http.request");
    expect(entry).toBeDefined();
    expect(entry?.requestId).toBe(inbound);
    expect(entry).toMatchObject({
      level: "info",
      event: "http.request",
      route: "/api/v1/health",
      method: "GET",
      status: 200,
    });
    expect(typeof entry?.durationMs).toBe("number");
  });

  it("I1: replaces a malformed inbound id and echoes the generated id that it logged", async () => {
    const sink = installMemoryLogger();

    const response = await GET(
      new Request(HEALTH_URL, { headers: { "x-request-id": "not a valid id!" } })
    );

    const echoed = response.headers.get("x-request-id");
    expect(echoed).toEqual(expect.stringMatching(GENERATED_REQUEST_ID));

    const entry = sink.entries.find((candidate) => candidate.event === "http.request");
    expect(entry?.requestId).toBe(echoed);
  });

  it("I1: mints and echoes a generated id when the header is absent", async () => {
    const sink = installMemoryLogger();

    const response = await GET(new Request(HEALTH_URL));

    const echoed = response.headers.get("x-request-id");
    expect(echoed).toEqual(expect.stringMatching(GENERATED_REQUEST_ID));

    const entry = sink.entries.find((candidate) => candidate.event === "http.request");
    expect(entry?.requestId).toBe(echoed);
  });

  it("does not leak a request context after the handler returns", async () => {
    installMemoryLogger();

    await GET(new Request(HEALTH_URL, { headers: { "x-request-id": "0123456789abcdef" } }));

    const { getRequestContext } = await import("../../server/runtime/request-context");
    expect(getRequestContext()).toBeUndefined();
  });
});
