import { describe, expect, it, vi } from "vitest";

import {
  rateLimitStage,
  hashIdentity,
  type RateLimiter,
  type RateLimitResult,
} from "@/server/rate-limit";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import type { RouteStageContext } from "@/server/http/define-route";

/**
 * Stage-level pins for identity trust in the `defineRoute` rate stage
 * (contract §0.11 / §0.12 / §0.15).
 *
 * `X-Attendee-Session` is a documented *request* header (§0.12) whose token is
 * a secret hashed at rest (§0.15), so a client-supplied value can never be the
 * rate-limit identity on its own. The stage must resolve/validate the session
 * server-side and either key the attendee scope on a stable (salted-hashed)
 * identity or — when the session cannot be validated — apply the class failure
 * policy, never silently bucket whatever the caller sent.
 *
 * These pins drive the stage with forged/rotating headers and observe the
 * limiter keys and the emitted logs. The "trust" pins below supply a healthy
 * server-side fact (`facts.attendeeSessionId`) — what a session resolver
 * produces after validating the header — to prove the raw header is ignored;
 * the fail-closed pin supplies no such fact.
 */

const SALT = "stage-rate-limit-salt";
const ROUTE = "/api/v1/things";
const URL = `http://localhost${ROUTE}`;

function context(): RouteStageContext {
  return { requestId: "req_stage_test", route: ROUTE, startedAt: new Date(0) };
}

function allowed(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return { success: true, limit: 12, remaining: 11, resetSeconds: 30, ...overrides };
}

/** A stage typed as a plain async callable so `rejects` is well-typed. */
function asCallable(stage: ReturnType<typeof rateLimitStage>) {
  return stage as (ctx: RouteStageContext, request: Request) => Promise<unknown>;
}

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

describe("rateLimitStage — attendee-session trust", () => {
  it("does not use the raw client-supplied X-Attendee-Session value as a limiter key", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve(allowed());
      },
    };
    // A healthy server-side resolver has already validated the session and
    // produced a stable resolved identity; only that may key the bucket.
    const resolvedSessionId = "sess_resolved_attendee_9f2c";
    const stage = asCallable(
      rateLimitStage({
        classKey: "liveness.challenge",
        limiter,
        salt: SALT,
        facts: { attendeeSessionId: resolvedSessionId },
      })
    );
    const raw = "att_raw_session_token_9f2c";

    await stage(
      context(),
      new Request(URL, { method: "POST", headers: { "x-attendee-session": raw } })
    );

    // The resolved identity is what got bucketed (the limiter ran exactly once),
    // and the raw client-supplied header never reached the limiter key.
    expect(keys).toHaveLength(1);
    expect(keys.join("|")).toContain(resolvedSessionId);
    expect(keys.join("|")).not.toContain(raw);
  });

  it("does not mint a fresh attendee bucket when X-Attendee-Session is rotated or forged", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve(allowed());
      },
    };
    // The server-side session identity is fixed; a client rotating or forging
    // the request header must not move the bucket.
    const stage = asCallable(
      rateLimitStage({
        classKey: "liveness.challenge",
        limiter,
        salt: SALT,
        facts: { attendeeSessionId: "sess_resolved_attendee_9f2c" },
      })
    );

    for (const forged of ["forged-a", "forged-b", "forged-c"]) {
      await stage(
        context(),
        new Request(URL, { method: "POST", headers: { "x-attendee-session": forged } })
      );
    }

    // A rotating header must not map to a rotating identity, or the per-attendee
    // bucket for liveness.challenge could be evaded indefinitely.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys.join("|")).not.toContain("forged");
  });

  it("fails closed for liveness.challenge when the X-Attendee-Session value is not a validated session", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const stage = asCallable(
      rateLimitStage({ classKey: "liveness.challenge", limiter: { limit }, salt: SALT })
    );

    await expect(
      stage(
        context(),
        new Request(URL, { method: "POST", headers: { "x-attendee-session": "forged-xyz" } })
      )
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("never logs the raw X-Attendee-Session token on a rate-limit denial", async () => {
    const sink = installMemoryLogger();
    const raw = "att_raw_session_token_9f2c";
    const limiter: RateLimiter = {
      limit: () => Promise.resolve(allowed({ success: false, limit: 12, remaining: 0 })),
    };
    const stage = asCallable(
      rateLimitStage({ classKey: "liveness.challenge", limiter, salt: SALT })
    );

    await expect(
      stage(context(), new Request(URL, { method: "POST", headers: { "x-attendee-session": raw } }))
    ).rejects.toBeDefined();

    // A denial (or a fail-closed limiter failure) must be observed ...
    expect(
      sink.entries.some(
        (entry) =>
          entry.event === "ratelimit.exceeded" || entry.event === "ratelimit.limiter_failed"
      )
    ).toBe(true);
    // ... and the raw session token must not be anywhere in the log.
    expect(JSON.stringify(sink.entries)).not.toContain(raw);
  });
});

describe("rateLimitStage — hashed-identity hygiene for attendee classes", () => {
  it("never derives the attendee scope verbatim from the request header", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve(allowed());
      },
    };
    const stage = asCallable(rateLimitStage({ classKey: "public.gallery", limiter, salt: SALT }));
    const raw = "att_raw_session_token_9f2c";

    await stage(
      context(),
      new Request(URL, {
        headers: { "x-attendee-session": raw, "x-forwarded-for": "203.0.113.77" },
      })
    );

    expect(keys.join("|")).not.toContain(raw);
    // The IP scope is still a salted hash, never the raw hop.
    expect(keys.join("|")).not.toContain("203.0.113.77");
    expect(keys.join("|")).toContain(hashIdentity("203.0.113.77", SALT));
  });
});
