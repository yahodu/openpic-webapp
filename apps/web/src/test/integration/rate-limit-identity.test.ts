import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  hashIdentity,
  memoryRateLimiter,
  rateLimitStage,
  type RateLimitClass,
  type RateLimitFacts,
  type RateLimiter,
} from "../../server/rate-limit";
import { defineRoute, type RouteHandler, type RouteStage } from "../../server/http/define-route";
import {
  createLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "../../server/logging";

/**
 * Integration contract — identity trust and pipeline identity availability
 * (contract §0.11, §0.12, §0.15).
 *
 * Companion to `rate-limit-route.test.ts`; these pins exercise the full
 * request -> stage -> response path for the identity-derivation concerns the
 * OP-79 review flagged:
 *
 *   - `X-Attendee-Session` is a client-supplied request header (§0.12) and its
 *     token is a secret hashed at rest (§0.15): a rotating/forged value must
 *     never become its own bucket, and must never appear in a limiter key or a
 *     log line.
 *   - a principal-keyed class must key on the authenticated principal, not the
 *     hashed client IP, once auth has resolved.
 *   - `auth.otp` / `auth.verify` must enforce their contact-keyed rule when a
 *     contact is available to the pipeline.
 */

/**
 * OP-79 follow-up — two-tier rate limiting (human ruling, Option A1).
 *
 * `defineRoute` keeps the coarse, pre-auth IP-keyed stage (`rateLimit`, first)
 * and gains a post-auth identity-keyed stage (`rateLimitIdentity`) that runs
 * immediately after `auth`. The pipeline parses the request body and hands it to
 * that stage as its third argument, so the contact-keyed `auth.otp` /
 * `auth.verify` classes can key on the body's `contact`; principal-keyed classes
 * key on `ctx.principal`, published by the route `auth` stage.
 *
 * `rateLimitIdentity` is declared on the real `DefineRouteOptions` type
 * (contract §0.11), so these pins exercise the production type surface directly
 * — a future rename of the option can no longer pass silently behind a cast.
 */

const SALT = "integration-identity-salt";
const ROUTE = "/api/v1/identity";
const URL = `http://localhost${ROUTE}`;

const BodySchema = z.object({ contact: z.string() });
const ResponseSchema = z.object({ ok: z.boolean() });

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

/**
 * An auth stage that records the authenticated principal on the request context.
 * This is the seam a real auth stage uses to publish `ctx.principal`; it is
 * intentionally declared on the route so the observable bucketing can be
 * asserted without assuming how the principal is resolved.
 */
function principalAuthStage(): RouteStage {
  return (ctx, request) => {
    const principal = request.headers.get("x-test-principal");
    if (principal !== null) {
      (ctx as { principal?: string }).principal = principal;
    }
  };
}

interface RouteOptions {
  readonly limiter: RateLimiter;
  readonly classKey?: RateLimitClass;
  readonly facts?: RateLimitFacts;
  readonly withAuth?: boolean;
  /**
   * Which tier owns the stage under test: the coarse pre-auth stage
   * (`rateLimit`) or the post-auth identity stage (`rateLimitIdentity`,
   * the default). Attendee fail-closed pins keep exercising the coarse stage so
   * the already-implemented behaviour stays pinned.
   */
  readonly tier?: "coarse" | "identity";
}

function makeRoute(options: RouteOptions): RouteHandler {
  const stage = rateLimitStage({
    classKey: options.classKey ?? "write.normal",
    limiter: options.limiter,
    salt: SALT,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  });
  return defineRoute({
    route: ROUTE,
    body: BodySchema,
    response: ResponseSchema,
    env: "test",
    ...((options.tier ?? "identity") === "coarse"
      ? { rateLimit: stage }
      : { rateLimitIdentity: stage }),
    ...(options.withAuth === true ? { auth: principalAuthStage() } : {}),
    handler: () => ({ body: { ok: true } }),
  });
}

function post(headers: Record<string, string>, body: unknown): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("attendee-session trust through the pipeline", () => {
  it("does not admit liveness.challenge when X-Attendee-Session is rotated/forged", async () => {
    installMemoryLogger();
    const route = makeRoute({
      classKey: "liveness.challenge",
      limiter: memoryRateLimiter(),
      // The attendee-session trust pins exercise the already-implemented coarse
      // stage so their fail-closed behaviour stays pinned on this branch.
      tier: "coarse",
    });

    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const response = await route(
        post(
          { "x-attendee-session": `forged-session-${String(i)}` },
          { contact: "ada@example.com" }
        )
      );
      statuses.push(response.status);
    }

    // An unvalidated session is not an identity. liveness.challenge is
    // attendee-only (no IP fallback) and abuse-prone, so a request that cannot
    // be attributed must fail closed — never be silently bucket-per-header and
    // allowed.
    expect(statuses).not.toContain(200);
    expect(statuses.every((status) => status === 503)).toBe(true);
  });

  it("never places the raw X-Attendee-Session token in the limiter key or a log line", async () => {
    const sink = installMemoryLogger();
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve({ success: true, limit: 12, remaining: 11, resetSeconds: 30 });
      },
    };
    const route = makeRoute({ classKey: "liveness.challenge", limiter, tier: "coarse" });
    const raw = "att_raw_session_token_9f2c";

    await route(post({ "x-attendee-session": raw }, { contact: "ada@example.com" }));

    expect(keys.join("|")).not.toContain(raw);
    expect(JSON.stringify(sink.entries)).not.toContain(raw);
  });

  it("admits and limits liveness.challenge when a validated attendee identity is resolved", async () => {
    installMemoryLogger();
    const route = makeRoute({
      classKey: "liveness.challenge",
      limiter: memoryRateLimiter(),
      // The positive path: a server-side session resolver validated the request
      // and produced the attendee identity. The identity-keyed stage must admit
      // and limit it normally — never fail closed on a resolved session.
      facts: { attendeeSessionId: "sess_resolved_attendee_9f2c" },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const response = await route(
        post(
          { "x-attendee-session": `forged-session-${String(i)}` },
          { contact: "ada@example.com" }
        )
      );
      statuses.push(response.status);
    }

    // §0.11 liveness.challenge allows 12/hour per attendee: the first 12 are
    // admitted (200), the 13th is 429 — and no request is ever 503.
    expect(statuses.slice(0, 12).every((status) => status === 200)).toBe(true);
    expect(statuses[12]).toBe(429);
    expect(statuses).not.toContain(503);
  });
});

describe("principal identity availability through the pipeline", () => {
  it.each([
    "read.normal",
    "write.normal",
    "upload.resolve",
    "media.sign",
    "admin",
    "internal",
  ] as const)(
    "keys the principal-scoped class %s on the principal, not the hashed IP",
    async (classKey) => {
      installMemoryLogger();
      const keys: string[] = [];
      const limiter: RateLimiter = {
        limit: (key) => {
          keys.push(key);
          return Promise.resolve({ success: true, limit: 300, remaining: 299, resetSeconds: 30 });
        },
      };
      const route = makeRoute({ classKey, limiter, withAuth: true });
      const ip = "203.0.113.201";
      const principal = "usr_01HPIPELINE";

      const response = await route(
        post(
          { "x-forwarded-for": ip, "x-test-principal": principal },
          { contact: "ada@example.com" }
        )
      );

      expect(response.status).toBe(200);
      expect(keys.join("|")).toContain(principal);
      expect(keys.join("|")).not.toContain(hashIdentity(ip, SALT));
    }
  );
});

describe("contact availability through the pipeline", () => {
  it.each<{ classKey: RateLimitClass; allowance: number }>([
    { classKey: "auth.otp", allowance: 5 },
    { classKey: "auth.verify", allowance: 10 },
  ])(
    "enforces the $classKey contact-keyed rule when the request carries a contact",
    async ({ classKey, allowance }) => {
      installMemoryLogger();
      const route = makeRoute({ classKey, limiter: memoryRateLimiter() });
      const contact = "victim@example.com";

      const statuses: number[] = [];
      for (let i = 0; i <= allowance; i += 1) {
        // A distinct client IP each round isolates the contact-keyed rule from
        // the IP-keyed rule: rotating IPs must not evade the contact limit.
        const response = await route(
          post({ "x-forwarded-for": `198.51.100.${String(i + 1)}` }, { contact })
        );
        statuses.push(response.status);
      }

      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    }
  );
});
