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
  hashIdentity,
  memoryRateLimiter,
  rateLimitStage,
  type RateLimiter,
  type RateLimitClass,
  type RateLimitFacts,
} from "../../server/rate-limit";

/**
 * Integration contract — the rate-limit stage inside the `defineRoute` pipeline.
 *
 * I2: with the memory adapter, the 61st write in a minute is denied with the
 *     §0.11 headers and the shared `rate_limited` envelope; earlier successes
 *     carry the RateLimit-* headers too.
 * The failure policy, the first-hop IP derivation and the hashed-identity log
 * hygiene are pinned here because they need the full request → stage → response
 * path.
 */

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

interface RouteOptions {
  readonly limiter: RateLimiter;
  readonly classKey?: RateLimitClass;
  readonly facts?: RateLimitFacts;
}

function makeRoute(options: RouteOptions) {
  return defineRoute({
    route: ROUTE,
    response: z.object({ ok: z.boolean() }),
    env: "test",
    rateLimit: rateLimitStage({
      classKey: options.classKey ?? "write.normal",
      limiter: options.limiter,
      salt: SALT,
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    }),
    handler: () => ({ body: { ok: true } }),
  });
}

function writeRequest(clientIp: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "x-forwarded-for": clientIp },
  });
}

describe("rate-limit stage in the pipeline (memory adapter)", () => {
  it("I2: denies the 61st write in a minute with 429, Retry-After and the rate_limited envelope", async () => {
    installMemoryLogger();
    const route = makeRoute({ limiter: memoryRateLimiter() });
    const ip = "203.0.113.10";

    for (let i = 0; i < 60; i += 1) {
      const response = await route(writeRequest(ip));
      expect(response.status).toBe(200);
    }

    const limited = await route(writeRequest(ip));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("ratelimit-limit")).toBe("60");
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("ratelimit-reset")).toMatch(/^\d+$/);

    const body = await limited.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryable).toBe(true);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("carries the RateLimit headers on a successful response", async () => {
    installMemoryLogger();
    const route = makeRoute({ limiter: memoryRateLimiter() });

    const response = await route(writeRequest("203.0.113.11"));

    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-limit")).toBe("60");
    expect(response.headers.get("ratelimit-remaining")).toBe("59");
    expect(response.headers.get("ratelimit-reset")).toMatch(/^\d+$/);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("logs ratelimit.exceeded at warn with the class and a hashed identity, never the raw IP", async () => {
    const sink = installMemoryLogger();
    const route = makeRoute({ limiter: memoryRateLimiter() });
    const ip = "203.0.113.12";

    for (let i = 0; i < 61; i += 1) {
      await route(writeRequest(ip));
    }

    const warned = sink.entries.find((entry) => entry.event === "ratelimit.exceeded");
    expect(warned).toBeDefined();
    expect(warned?.level).toBe("warn");
    expect(warned?.classKey).toBe("write.normal");
    expect(typeof warned?.identity).toBe("string");
    expect(String(warned?.identity)).toContain(hashIdentity(ip, SALT));
    expect(JSON.stringify(sink.entries)).not.toContain(ip);
  });

  it("derives the client IP from the first hop of x-forwarded-for", async () => {
    const sink = installMemoryLogger();
    const route = makeRoute({ limiter: memoryRateLimiter() });
    const clientIp = "203.0.113.13";
    const proxyIp = "10.0.0.1";

    for (let i = 0; i < 61; i += 1) {
      await route(writeRequest(`${clientIp}, ${proxyIp}`));
    }

    const warned = sink.entries.find((entry) => entry.event === "ratelimit.exceeded");
    expect(warned).toBeDefined();
    expect(String(warned?.identity)).toContain(hashIdentity(clientIp, SALT));
    expect(JSON.stringify(sink.entries)).not.toContain(proxyIp);
  });

  it("fails open for a write class when the limiter is unavailable", async () => {
    const sink = installMemoryLogger();
    const route = makeRoute({
      limiter: {
        limit: () => Promise.reject(new Error("limiter down")),
      },
    });

    const response = await route(writeRequest("203.0.113.14"));

    expect(response.status).toBe(200);
    const failure = sink.entries.find((entry) => entry.event === "ratelimit.limiter_failed");
    expect(failure).toBeDefined();
    expect(failure?.level).toBe("error");
  });

  it("fails closed for auth.otp when the limiter is unavailable (503 service_unavailable)", async () => {
    const sink = installMemoryLogger();
    const route = makeRoute({
      classKey: "auth.otp",
      facts: { contact: "ada@example.com", ip: "203.0.113.15" },
      limiter: {
        limit: () => Promise.reject(new Error("limiter down")),
      },
    });

    const response = await route(writeRequest("203.0.113.15"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.retryable).toBe(true);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
    expect(sink.entries.some((entry) => entry.event === "ratelimit.limiter_failed")).toBe(true);
  });

  it("fails closed and never leaks the raw contact when auth.otp is exceeded", async () => {
    const sink = installMemoryLogger();
    const contact = "ada@example.com";
    const route = makeRoute({
      classKey: "auth.otp",
      facts: { contact, ip: "203.0.113.16" },
      limiter: memoryRateLimiter(),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await route(writeRequest("203.0.113.16"))).status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(JSON.stringify(sink.entries)).not.toContain(contact);
  });
});
