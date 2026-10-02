import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineRoute } from "@/server/http/define-route";
import { createLogger, memoryTransport } from "@/server/logging";

function testLogger(): ReturnType<typeof createLogger> {
  const sink = memoryTransport();
  return createLogger({
    level: "info",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
  });
}

/**
 * U7 — the pipeline runs its stages in the documented order (architecture §3):
 *
 *   context -> rate limit -> auth -> CSRF -> tenant resolution -> idempotency ->
 *   ETag -> validate -> handler -> serialize
 *
 * Each stage is a pluggable no-op until its own story lands, so the test spies on
 * the pluggable stages and observes the handler input (parsed body, i.e. after
 * validate) and the response (after serialize) to pin the whole order.
 */
describe("defineRoute", () => {
  it("U7: runs the stages in order and gives the handler the parsed body", async () => {
    const calls: string[] = [];
    const logger = testLogger();

    const route = defineRoute({
      route: "/api/v1/things",
      body: z.object({ name: z.string().min(1) }),
      response: z.object({ id: z.string() }),
      env: "test",
      logger,
      rateLimit: () => {
        calls.push("rateLimit");
      },
      auth: () => {
        calls.push("auth");
      },
      csrf: () => {
        calls.push("csrf");
      },
      tenant: () => {
        calls.push("tenant");
      },
      idempotency: () => {
        calls.push("idempotency");
      },
      etag: () => {
        calls.push("etag");
      },
      handler: (ctx) => {
        calls.push("handler");
        expect(ctx.body).toEqual({ name: "Ada" });
        return { status: 200, body: { id: "1" } };
      },
    });

    const response = await route(
      new Request("http://localhost/api/v1/things", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "0123456789abcdef",
        },
        body: JSON.stringify({ name: "Ada" }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "1" });
    expect(calls).toEqual([
      "rateLimit",
      "auth",
      "csrf",
      "tenant",
      "idempotency",
      "etag",
      "handler",
    ]);
  });

  it("U7: the first stage sees the resolved request context", async () => {
    const logger = testLogger();
    let seen: { requestId?: string; route?: string } = {};

    const route = defineRoute({
      route: "/api/v1/things",
      response: z.object({ ok: z.boolean() }),
      env: "test",
      logger,
      rateLimit: (ctx) => {
        seen = { requestId: ctx.requestId, route: ctx.route };
      },
      handler: () => ({ body: { ok: true } }),
    });

    await route(
      new Request("http://localhost/api/v1/things", {
        headers: { "x-request-id": "0123456789abcdef" },
      })
    );

    expect(seen.requestId).toBe("0123456789abcdef");
    expect(seen.route).toBe("/api/v1/things");
  });

  it("U7: skips stages that were not configured", async () => {
    const logger = testLogger();

    const route = defineRoute({
      route: "/api/v1/things",
      response: z.object({ ok: z.boolean() }),
      env: "test",
      logger,
      handler: () => ({ body: { ok: true } }),
    });

    const response = await route(new Request("http://localhost/api/v1/things"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("U7: does not run the handler when validation fails", async () => {
    const logger = testLogger();
    let handlerCalls = 0;

    const route = defineRoute({
      route: "/api/v1/things",
      body: z.object({ name: z.string().min(1) }),
      response: z.object({ ok: z.boolean() }),
      env: "test",
      logger,
      handler: () => {
        handlerCalls += 1;
        return { body: { ok: true } };
      },
    });

    const response = await route(
      new Request("http://localhost/api/v1/things", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      })
    );

    expect(response.status).toBe(422);
    expect(handlerCalls).toBe(0);
  });
});
