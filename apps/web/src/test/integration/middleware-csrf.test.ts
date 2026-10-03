import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { apiErrorSchema } from "@openpic/contracts";

import { makeEnv, toProcessEnv } from "@/test/factories/env";

/**
 * I1 — the edge middleware contract (OP-78).
 *
 * `src/middleware.ts` is invoked here the way Next.js invokes it: with a
 * `NextRequest`, producing either a `NextResponse.next()` (the request
 * continues — observable as the `x-middleware-next: 1` continuation header) or
 * a security `Response` that stops the request.
 *
 * The middleware resolves `ALLOWED_ORIGINS` from the validated configuration, so
 * each run installs a fresh, complete environment before importing the module
 * (mirrors `src/server/config/env.test.ts`).
 *
 * Contract:
 *   - A denied request answers `403` with the shared `{ error }` envelope whose
 *     code is `csrf_failed`, echoing the inbound `x-request-id`.
 *   - An allowed request continues (`x-middleware-next: 1`).
 */
const APP_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "https://evil.example";
const REQUEST_ID = "0123456789abcdef";
const SESSION_COOKIE = "better-auth.session_token=test-stub";

const ORIGINAL_ENV = process.env;

type MiddlewareModule = typeof import("@/middleware");
let middleware: MiddlewareModule["middleware"];

beforeAll(async () => {
  vi.resetModules();
  process.env = toProcessEnv(makeEnv());
  const mod = await import("@/middleware");
  middleware = mod.middleware;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

function requestFor(path: string, options: RequestOptions = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: options.method ?? "POST",
    headers: {
      "x-request-id": REQUEST_ID,
      ...options.headers,
    },
  });
}

describe("middleware — CSRF origin + header enforcement", () => {
  it("I1: returns a 403 csrf_failed envelope for a cookie POST with a foreign Origin", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: FOREIGN_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: SESSION_COOKIE,
        },
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.error.code).toBe("csrf_failed");
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(body.error.retryable).toBe(false);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("I2: returns a 403 csrf_failed envelope when X-Requested-With is missing", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: { origin: APP_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("csrf_failed");
  });

  it("I3: lets a cookie POST continue when Origin is allowlisted and the header is present", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: APP_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: SESSION_COOKIE,
        },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.status).not.toBe(403);
  });
});

describe("middleware — exemptions", () => {
  it("I4: lets a Bearer POST with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: FOREIGN_ORIGIN,
          authorization: "Bearer opat_example-token",
        },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("I5: lets a GET with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        method: "GET",
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("I6: lets a webhook POST with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/webhooks/stripe", {
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("I7: lets an auth POST with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/auth/sign-in/email", {
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("middleware — internal-route shielding", () => {
  it("I8: rejects an internal route carrying a browser Origin header", async () => {
    const response = await middleware(
      requestFor("/api/v1/internal/jobs/reap", {
        headers: { origin: APP_ORIGIN, authorization: "Bearer internal-secret" },
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();

    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("I9: lets a server-to-server internal request (no Origin) continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/internal/jobs/reap", {
        headers: { authorization: "Bearer internal-secret" },
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
