import { describe, expect, it } from "vitest";
import { z } from "zod";

import { serializeResponse } from "@/server/http/serialize-response";
import { createLogger, memoryTransport, type MemoryTransport } from "@/server/logging";

function memoryLogger(): { sink: MemoryTransport; logger: ReturnType<typeof createLogger> } {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "info",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
  });
  return { sink, logger };
}

/**
 * U5 / U6 — response serialization is the never-return control.
 *
 * Every response body passes through its `packages/contracts` schema. An unknown
 * field is a schema violation, not a cosmetic detail: outside production it
 * throws so the test (and the developer) sees it; in production it is logged at
 * error with the route and the body is returned stripped, so a leaked field can
 * never reach a client even when the handler misbehaves (CONVENTIONS §8.1).
 */
describe("serializeResponse", () => {
  it("U5: returns the schema-parsed body when it matches", () => {
    const { logger } = memoryLogger();
    const schema = z.object({ id: z.string(), count: z.number() });

    const body = serializeResponse({
      schema,
      data: { id: "a", count: 1 },
      route: "/api/v1/echo",
      logger,
      env: "test",
    });

    expect(body).toEqual({ id: "a", count: 1 });
  });

  it("U5: throws outside production when a field has the wrong type", () => {
    const { logger } = memoryLogger();
    const schema = z.object({ id: z.string() });

    expect(() =>
      serializeResponse({
        schema,
        data: { id: 123 },
        route: "/api/v1/echo",
        logger,
        env: "test",
      })
    ).toThrow(/\/api\/v1\/echo/);
  });

  it("U5: throws outside production when the body carries an unknown field", () => {
    const { logger } = memoryLogger();
    const schema = z.object({ id: z.string() });

    expect(() =>
      serializeResponse({
        schema,
        data: { id: "a", passwordHash: "leaked" },
        route: "/api/v1/echo",
        logger,
        env: "test",
      })
    ).toThrow();
  });

  it("U6: in production strips unknown fields and logs an error with the route", () => {
    const { sink, logger } = memoryLogger();
    const schema = z.object({ id: z.string(), count: z.number() });

    const body = serializeResponse({
      schema,
      data: {
        id: "a",
        count: 1,
        passwordHash: "leaked",
        providerPayload: { raw: true },
      },
      route: "/api/v1/echo",
      logger,
      env: "production",
    });

    expect(body).toEqual({ id: "a", count: 1 });
    const logged = sink.entries.find((entry) => entry.level === "error");
    expect(logged).toBeDefined();
    expect(logged).toMatchObject({
      event: "http.response.serialization_failed",
      route: "/api/v1/echo",
    });
  });

  it("U6: in production returns the parsed body for a matching response and logs nothing", () => {
    const { sink, logger } = memoryLogger();
    const schema = z.object({ id: z.string() });

    const body = serializeResponse({
      schema,
      data: { id: "a" },
      route: "/api/v1/echo",
      logger,
      env: "production",
    });

    expect(body).toEqual({ id: "a" });
    expect(sink.entries.filter((entry) => entry.level === "error")).toHaveLength(0);
  });
});
