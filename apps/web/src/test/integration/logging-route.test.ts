import { describe, expect, it } from "vitest";

import { GET } from "../../app/api/v1/health/route";
import { createLogger, memoryTransport, setLogger } from "../../server/logging";

/**
 * Integration — the logging port wired into a real route handler.
 *
 * I3: `GET /api/v1/health` must emit exactly one `info` access line through
 *     the port, scoped to the request: `requestId` comes from the incoming
 *     `x-request-id` header (or is generated) and `route` is bound to the
 *     handler's path. The response contract from OP-69 is unchanged.
 *
 * The process logger is replaced with a memory-backed logger through the
 * `setLogger` seam so the test can observe what the handler emitted.
 */

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

describe("GET /api/v1/health — access logging", () => {
  it("emits one access log entry carrying the request id and route", async () => {
    const sink = installMemoryLogger();

    const response = await GET(
      new Request("http://localhost/api/v1/health", {
        headers: { "x-request-id": "req-abc-123" },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });

    const entry = sink.entries.find((candidate) => candidate.route === "/api/v1/health");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: "info",
      event: "http.request",
      requestId: "req-abc-123",
      route: "/api/v1/health",
    });
  });

  it("generates a request id when the header is absent", async () => {
    const sink = installMemoryLogger();

    await GET(new Request("http://localhost/api/v1/health"));

    const entry = sink.entries.find((candidate) => candidate.route === "/api/v1/health");
    const requestId = entry?.requestId;
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toBe("");
  });
});
