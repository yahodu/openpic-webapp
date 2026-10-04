import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiErrorSchema } from "@openpic/contracts";

import { defineRoute } from "../../server/http/define-route";
import {
  createLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "../../server/logging";
import {
  rateLimitStage,
  upstashRateLimiter,
  type RateLimitClass,
  type RateLimitFacts,
} from "../../server/rate-limit";

import { server } from "./setup";

/**
 * I1 — the Upstash adapter against the Upstash REST endpoints (MSW).
 *
 * The adapter speaks Upstash's Redis REST protocol: a single `eval` (or
 * `evalsha`) command whose `result` is `[currentFields, previousFields, success]`.
 * MSW mocks that endpoint; the adapter validates the shape with Zod.
 *
 *   I1a: exceeding write.normal over the mocked endpoint returns 429 with the
 *        §0.11 headers, and the request carried the bearer token.
 *   I1b: a response that breaks the Upstash shape is treated as a limiter
 *        failure — fail-open for write.normal (200) and an error log.
 *   I1c: the same contract break on auth.otp fails closed (503).
 */

const UPSTASH_URL = "https://mock-upstash.test/ratelimit";
const UPSTASH_TOKEN = "test-upstash-token";
const SALT = "integration-rate-limit-salt";
const ROUTE = "/api/v1/things";
const URL = `http://localhost${ROUTE}`;

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

interface MockOptions {
  /** How many `eval`/`evalsha` commands succeed before the mock denies. */
  readonly denyAfter: number;
  /** When true, every command returns a body that breaks the Upstash shape. */
  readonly malformed?: boolean;
}

function installUpstashMock(options: MockOptions) {
  let authorization: string | null = null;
  let commands = 0;

  server.use(
    http.post(UPSTASH_URL, async ({ request }) => {
      authorization = request.headers.get("authorization");
      const body: unknown = await request.json();
      const command = Array.isArray(body) && typeof body[0] === "string" ? body[0] : "";

      // The @upstash/redis client loads the script before EVALSHA; answer it.
      if (command === "script") {
        return HttpResponse.json({ result: "0".repeat(40) });
      }

      if (options.malformed === true) {
        return HttpResponse.json({ result: "not-an-upstash-result" });
      }

      commands += 1;
      const allowed = commands <= options.denyAfter;
      return HttpResponse.json({
        result: [allowed ? ["req-1", "1"] : ["req-1", "60"], [], allowed ? 1 : 0],
      });
    })
  );

  return {
    authorization: () => authorization,
    commands: () => commands,
  };
}

interface RouteOptions {
  readonly classKey?: RateLimitClass;
  readonly facts?: RateLimitFacts;
}

function makeRoute(options: RouteOptions = {}) {
  return defineRoute({
    route: ROUTE,
    response: z.object({ ok: z.boolean() }),
    env: "test",
    rateLimit: rateLimitStage({
      classKey: options.classKey ?? "write.normal",
      limiter: upstashRateLimiter({ url: UPSTASH_URL, token: UPSTASH_TOKEN }),
      salt: SALT,
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    }),
    handler: () => ({ body: { ok: true } }),
  });
}

function writeRequest(clientIp: string): Request {
  return new Request(URL, { method: "POST", headers: { "x-forwarded-for": clientIp } });
}

describe("upstashRateLimiter (MSW)", () => {
  it("I1a: exceeding write.normal returns 429 with Retry-After and the rate_limited envelope", async () => {
    installMemoryLogger();
    const mock = installUpstashMock({ denyAfter: 60 });
    const route = makeRoute();
    const ip = "203.0.113.40";

    let limited: Response | undefined;
    for (let i = 0; i < 61 && limited === undefined; i += 1) {
      const response = await route(writeRequest(ip));
      if (response.status === 429) {
        limited = response;
      }
    }

    expect(limited).toBeDefined();
    expect(limited?.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited?.headers.get("ratelimit-limit")).toBe("60");
    expect(limited?.headers.get("ratelimit-remaining")).toBe("0");
    expect(mock.authorization()).toBe(`Bearer ${UPSTASH_TOKEN}`);

    const body = await limited?.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryable).toBe(true);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("parses an allowed Upstash response into the port result", async () => {
    installMemoryLogger();
    installUpstashMock({ denyAfter: 60 });
    const route = makeRoute();

    const response = await route(writeRequest("203.0.113.43"));

    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-limit")).toBe("60");
    expect(response.headers.get("ratelimit-remaining")).toBe("59");
  });

  it("I1b: a malformed Upstash response fails open for write.normal and logs at error", async () => {
    const sink = installMemoryLogger();
    installUpstashMock({ denyAfter: 0, malformed: true });
    const route = makeRoute();

    const response = await route(writeRequest("203.0.113.41"));

    expect(response.status).toBe(200);
    const failure = sink.entries.find((entry) => entry.event === "ratelimit.limiter_failed");
    expect(failure).toBeDefined();
    expect(failure?.level).toBe("error");
  });

  it("I1c: a malformed Upstash response fails closed for auth.otp (503)", async () => {
    const sink = installMemoryLogger();
    installUpstashMock({ denyAfter: 0, malformed: true });
    const route = makeRoute({
      classKey: "auth.otp",
      facts: { contact: "ada@example.com", ip: "203.0.113.42" },
    });

    const response = await route(writeRequest("203.0.113.42"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.retryable).toBe(true);
    expect(sink.entries.some((entry) => entry.event === "ratelimit.limiter_failed")).toBe(true);
  });
});
