import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiErrorSchema } from "@openpic/contracts";

import { POST } from "../../app/api/v1/echo/route";
import { defineRoute } from "../../server/http/define-route";
import {
  createLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "../../server/logging";

const ECHO_URL = "http://localhost/api/v1/echo";
const REQUEST_ID = "0123456789abcdef";

function installMemoryLogger(): MemoryTransport {
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

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ECHO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/**
 * Integration contract — the defineRoute pipeline behind a real route handler.
 *
 * `POST /api/v1/echo` is the tracer-bullet route for the pipeline: it accepts
 * `{ message: string }` and echoes it. Exercising the handler directly proves the
 * same Request/Response contract the HTTP server serves, without a network hop
 * (mirrors how `GET /api/v1/health` is tested).
 */
describe("POST /api/v1/echo — request validation pipeline", () => {
  it("I1: rejects a non-JSON content type with 415 unsupported_media_type", async () => {
    const sink = installMemoryLogger();

    const response = await POST(
      new Request(ECHO_URL, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-request-id": REQUEST_ID },
        body: "hello",
      })
    );

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = await response.json();
    expect(body.error.code).toBe("unsupported_media_type");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(body.error.retryable).toBe(false);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
    expect(sink.entries.length).toBeGreaterThan(0);
  });

  it("I2: rejects invalid JSON with 400 malformed_json", async () => {
    installMemoryLogger();

    const response = await POST(jsonRequest("{ not json", { "x-request-id": REQUEST_ID }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("malformed_json");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("I3: rejects a schema-invalid body with 422 validation_failed and fields", async () => {
    installMemoryLogger();

    const response = await POST(
      jsonRequest(JSON.stringify({ message: "" }), {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": REQUEST_ID,
      })
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
    expect(Array.isArray(body.error.details?.fields)).toBe(true);
    expect(body.error.details.fields.length).toBeGreaterThan(0);
    expect(body.error.details.fields[0].path).toBe("message");
  });

  it("I4: maps a thrown handler error to 500 internal_error, echoes the request id and logs the stack", async () => {
    const sink = installMemoryLogger();

    const route = defineRoute({
      route: "/api/v1/boom",
      response: z.object({ ok: z.boolean() }),
      env: "test",
      handler: () => {
        throw new Error("kaboom-stack-marker");
      },
    });

    const response = await route(
      new Request("http://localhost/api/v1/boom", { headers: { "x-request-id": REQUEST_ID } })
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(body.error.message).not.toContain("kaboom-stack-marker");
    expect(apiErrorSchema.safeParse(body).success).toBe(true);

    const logged = sink.entries.find((entry) => entry.level === "error");
    expect(logged).toBeDefined();
    expect(logged?.requestId).toBe(REQUEST_ID);
    expect(typeof logged?.err?.stack).toBe("string");
    expect(logged?.err?.stack).toContain("kaboom-stack-marker");
  });

  it("I5: every JSON response carries the default security headers", async () => {
    installMemoryLogger();

    const response = await POST(
      jsonRequest(JSON.stringify({ message: "hi" }), { "x-request-id": REQUEST_ID })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  });

  it("I6: maps an unparseable production body to a non-empty 500 internal_error envelope", async () => {
    const sink = installMemoryLogger();

    const route = defineRoute({
      route: "/api/v1/boom",
      response: z.object({ ok: z.boolean() }),
      env: "production",
      handler: () => ({ body: { ok: "not-a-boolean" as unknown as boolean } }),
    });

    const response = await route(
      new Request("http://localhost/api/v1/boom", { headers: { "x-request-id": REQUEST_ID } })
    );

    expect(response.status).toBe(500);
    expect((await response.clone().arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);

    const body = await response.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);

    const logged = sink.entries.find((entry) => entry.level === "error");
    expect(logged).toBeDefined();
    expect(logged?.requestId).toBe(REQUEST_ID);
  });
});
