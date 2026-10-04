import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiErrorSchema } from "@openpic/contracts";

import { defineRoute } from "@/server/http/define-route";
import { createLogger, memoryTransport } from "@/server/logging";

/**
 * OP-79 follow-up — two-tier rate limiting (human ruling, Option A1).
 *
 * `defineRoute` keeps the coarse, pre-auth IP-keyed rate stage (`rateLimit`,
 * first, unchanged) and gains a second, post-auth identity-keyed stage
 * (`rateLimitIdentity`) that runs immediately after `auth`. The pipeline parses
 * the request body and hands it to that stage as its third argument, so the
 * contact-keyed `auth.otp`/`auth.verify` classes can key on the body's
 * `contact` (principal-keyed classes key on `ctx.principal`, published by the
 * route `auth` stage).
 *
 * `rateLimitIdentity` is declared on the real `DefineRouteOptions` type
 * (contract §0.11), so these pins exercise the production type surface directly
 * — a future rename of the option can no longer pass silently behind a cast.
 */

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
      rateLimitIdentity: () => {
        calls.push("rateLimitIdentity");
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
    // Two-tier: the coarse pre-auth rate stage is first, the identity-keyed
    // stage runs immediately after auth (and before the remaining stages).
    expect(calls).toEqual([
      "rateLimit",
      "auth",
      "rateLimitIdentity",
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

/**
 * Regression guard for the OP-73 review finding: a handler body that cannot be
 * parsed into its declared response schema must never be masked as a 2xx with a
 * zero-length body. In production the pipeline must project it onto the standard
 * 500 `internal_error` envelope; a merely-unknown field must still be stripped
 * and served as 200.
 *
 * The type-level cast (`as unknown as boolean`) is deliberate: it smuggles a
 * runtime type mismatch past the compiler so the wire contract can be asserted.
 */
describe("defineRoute — production serialization mismatch", () => {
  it("returns a non-empty 500 internal_error envelope when the production body fails a non-strippable schema check", async () => {
    const logger = testLogger();

    const route = defineRoute({
      route: "/api/v1/things",
      response: z.object({ ok: z.boolean() }),
      env: "production",
      logger,
      handler: () => ({ body: { ok: "not-a-boolean" as unknown as boolean } }),
    });

    const response = await route(
      new Request("http://localhost/api/v1/things", {
        headers: { "x-request-id": "0123456789abcdef" },
      })
    );

    expect(response.status).toBe(500);
    expect((await response.clone().arrayBuffer()).byteLength).toBeGreaterThan(0);

    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body).toBeTypeOf("object");
    expect(body.error.code).toBe("internal_error");
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
    expect(body.error.requestId).toBe("0123456789abcdef");
    expect(body.error.message).not.toContain("not-a-boolean");
    expect(body.error.message).not.toMatch(/\bat\s+\S+:\d+:\d+/);
  });

  it("still returns the stripped 200 body in production when the body carries only an unknown field", async () => {
    const logger = testLogger();

    const route = defineRoute({
      route: "/api/v1/things",
      response: z.object({ ok: z.boolean() }),
      env: "production",
      logger,
      handler: () => ({
        body: { ok: true, leaked: "secret" } as unknown as { ok: boolean },
      }),
    });

    const response = await route(new Request("http://localhost/api/v1/things"));

    expect(response.status).toBe(200);
    expect((await response.clone().arrayBuffer()).byteLength).toBeGreaterThan(0);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
