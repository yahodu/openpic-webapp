import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { apiErrorSchema } from "@openpic/contracts";

import { makeEnv, toProcessEnv } from "@/test/factories/env";

/**
 * I1 — the edge middleware contract (OP-78, plus the OP-78 reviewer follow-ups).
 *
 * `src/middleware.ts` is invoked here the way Next.js invokes it: with a
 * `NextRequest`. An allowed request produces a continuation response (status
 * `200`, empty body, no JSON envelope); a denied request produces a security
 * `Response` that stops the request.
 *
 * The middleware resolves `ALLOWED_ORIGINS` from the validated configuration, so
 * each run installs a fresh, complete environment before importing the module
 * (mirrors `src/server/config/env.test.ts`).
 *
 * Contract:
 *   - A denied request answers `403` with the shared `{ error }` envelope whose
 *     code is `csrf_failed` (or `forbidden` for an internal route), echoing the
 *     inbound `x-request-id` when it is well-formed and minting one otherwise.
 *   - An allowed request continues: status `200`, no JSON error body. (Asserted
 *     on the response *shape*, not on Next.js's internal continuation header.)
 *   - The browser session cookie is recognised under both its plain and
 *     `__Secure-`-prefixed names (Better Auth prefixes secure cookies).
 *   - A denial emits exactly one structured security warning; the event name
 *     distinguishes a CSRF failure from an internal-route denial.
 */
const APP_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "https://evil.example";
const REQUEST_ID = "0123456789abcdef";
const SESSION_COOKIE = "better-auth.session_token=test-stub";
const SECURE_SESSION_COOKIE = "__Secure-better-auth.session_token=test-stub";
const INTERNAL_PATH = "/api/v1/internal/jobs/reap";
const MINTED_REQUEST_ID = /^req_[0-9a-f]{32}$/;

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

/** A request with exactly the given headers (no default correlation id). */
function requestWithHeaders(
  path: string,
  headers: Record<string, string>,
  method = "POST"
): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

/** Assert the request was allowed through (a continuation, not a denial). */
function expectContinued(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
}

/** Parse the structured `security.*` warning lines out of captured console calls. */
function parseSecurityWarnings(calls: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  const warnings: Record<string, unknown>[] = [];
  for (const call of calls) {
    const argument = call[0];
    if (typeof argument !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argument);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { event?: unknown }).event === "string" &&
      (parsed as { event: string }).event.startsWith("security.")
    ) {
      warnings.push(parsed as Record<string, unknown>);
    }
  }
  return warnings;
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

    expectContinued(response);
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

    expectContinued(response);
  });

  it("I5: lets a GET with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        method: "GET",
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expectContinued(response);
  });

  it("I6: lets a webhook POST with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/v1/webhooks/stripe", {
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expectContinued(response);
  });

  it("I7: lets an auth POST with a foreign Origin continue", async () => {
    const response = await middleware(
      requestFor("/api/auth/sign-in/email", {
        headers: { origin: FOREIGN_ORIGIN, cookie: SESSION_COOKIE },
      })
    );

    expectContinued(response);
  });
});

describe("middleware — internal-route shielding", () => {
  it("I8: rejects an internal route carrying a browser Origin header", async () => {
    const response = await middleware(
      requestFor(INTERNAL_PATH, {
        headers: { origin: APP_ORIGIN, authorization: "Bearer internal-secret" },
      })
    );

    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("I9: lets a server-to-server internal request (no Origin) continue", async () => {
    const response = await middleware(
      requestFor(INTERNAL_PATH, {
        headers: { authorization: "Bearer internal-secret" },
      })
    );

    expectContinued(response);
  });
});

describe("middleware — internal-route fetch-metadata shielding", () => {
  it("I19: rejects an internal route whose Sec-Fetch-Site is same-origin (no Origin header)", async () => {
    const response = await middleware(
      requestFor(INTERNAL_PATH, {
        headers: { "sec-fetch-site": "same-origin", authorization: "Bearer internal-secret" },
      })
    );

    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it("I20: rejects an internal route whose Sec-Fetch-Site is cross-site (no Origin header)", async () => {
    const response = await middleware(
      requestFor(INTERNAL_PATH, {
        headers: { "sec-fetch-site": "cross-site", authorization: "Bearer internal-secret" },
      })
    );

    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("I21: lets an internal GET with Sec-Fetch-Site: none continue (typed-URL/bookmark navigation is outside the decided deny set)", async () => {
    const response = await middleware(
      requestFor(INTERNAL_PATH, {
        method: "GET",
        headers: { "sec-fetch-site": "none", authorization: "Bearer internal-secret" },
      })
    );

    expectContinued(response);
  });

  it("I22: still lets a non-internal same-origin cookie POST with Sec-Fetch-Site: same-origin continue (scoped to internal routes)", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: APP_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: SESSION_COOKIE,
          "sec-fetch-site": "same-origin",
        },
      })
    );

    expectContinued(response);
  });

  it("I23: logs security.internal_origin_denied for a Sec-Fetch-Site browser-context denial", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await middleware(
        requestFor(INTERNAL_PATH, {
          headers: { "sec-fetch-site": "same-origin", authorization: "Bearer internal-secret" },
        })
      );

      const warnings = parseSecurityWarnings(warn.mock.calls);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: "warn",
        event: "security.internal_origin_denied",
        path: INTERNAL_PATH,
      });

      const raw = String(warn.mock.calls[0]?.[0] ?? "");
      expect(raw).not.toContain("internal-secret");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("middleware — session-cookie recognition", () => {
  it("I10: rejects a foreign-Origin POST carrying the __Secure- session cookie", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: FOREIGN_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: SECURE_SESSION_COOKIE,
        },
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("csrf_failed");
  });

  it("I11: rejects a missing-header POST carrying the __Secure- session cookie", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: { origin: APP_ORIGIN, cookie: SECURE_SESSION_COOKIE },
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("csrf_failed");
  });

  it("I12: does not treat a near-miss cookie name as the session cookie", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: FOREIGN_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: "__Secure-better-auth.session_token_backup=test-stub",
        },
      })
    );

    expectContinued(response);
  });

  it("I13: does not treat an unrelated __Secure- cookie as the session cookie", async () => {
    const response = await middleware(
      requestFor("/api/v1/echo", {
        headers: {
          origin: FOREIGN_ORIGIN,
          "x-requested-with": "XMLHttpRequest",
          cookie: "__Secure-some-other=test-stub",
        },
      })
    );

    expectContinued(response);
  });
});

describe("middleware — security warn log", () => {
  it("I14: logs a distinct event for an internal-route denial", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await middleware(
        requestFor(INTERNAL_PATH, {
          headers: { origin: FOREIGN_ORIGIN, authorization: "Bearer internal-secret" },
        })
      );

      const warnings = parseSecurityWarnings(warn.mock.calls);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: "warn",
        event: "security.internal_origin_denied",
        path: INTERNAL_PATH,
        originHost: "evil.example",
      });

      const raw = String(warn.mock.calls[0]?.[0] ?? "");
      expect(raw).not.toContain("internal-secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("I15: logs security.csrf_failed (path without query, host only, no cookie) for a CSRF denial", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await middleware(
        requestFor("/api/v1/echo?secret=leak-me", {
          headers: {
            origin: FOREIGN_ORIGIN,
            "x-requested-with": "XMLHttpRequest",
            cookie: SESSION_COOKIE,
          },
        })
      );

      const warnings = parseSecurityWarnings(warn.mock.calls);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: "warn",
        event: "security.csrf_failed",
        path: "/api/v1/echo",
        originHost: "evil.example",
      });

      const raw = String(warn.mock.calls[0]?.[0] ?? "");
      expect(raw).not.toContain("test-stub");
      expect(raw).not.toContain("leak-me");
      expect(raw).not.toContain("better-auth.session_token");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("middleware — correlation id resolution", () => {
  function denialHeaders(): Record<string, string> {
    return {
      origin: FOREIGN_ORIGIN,
      "x-requested-with": "XMLHttpRequest",
      cookie: SESSION_COOKIE,
    };
  }

  async function denialBody(headers: Record<string, string>) {
    const response = await middleware(requestWithHeaders("/api/v1/echo", headers));
    expect(response.status).toBe(403);
    return response.json();
  }

  it("I16: mints a correlation id when the header is absent", async () => {
    const body = await denialBody(denialHeaders());

    expect(body.error.requestId).toMatch(MINTED_REQUEST_ID);
  });

  it.each(["abc", "short_7", "has space", "with;semi", "A".repeat(65)])(
    "I17: mints a correlation id for an out-of-spec inbound id %j",
    async (inbound: string) => {
      const body = await denialBody({ ...denialHeaders(), "x-request-id": inbound });

      expect(body.error.requestId).toMatch(MINTED_REQUEST_ID);
      expect(body.error.requestId).not.toBe(inbound);
    }
  );

  it.each(["ABCDEF12", "0123456789abcdef", "A".repeat(64)])(
    "I18: echoes a well-formed inbound id %j",
    async (inbound: string) => {
      const body = await denialBody({ ...denialHeaders(), "x-request-id": inbound });

      expect(body.error.requestId).toBe(inbound);
    }
  );
});
