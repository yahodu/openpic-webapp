import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("admits liveness.challenge when a server-validated attendeeSessionId resolves an identity", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve(allowed());
      },
    };
    // The positive path: a session resolver has validated the request and
    // produced the resolved attendee identity. liveness.challenge is
    // attendee-only, so a validated identity must be admitted and limited
    // normally (headers attached, request not fail-closed).
    const resolvedSessionId = "sess_resolved_attendee_9f2c";
    const stage = rateLimitStage({
      classKey: "liveness.challenge",
      limiter,
      salt: SALT,
      facts: { attendeeSessionId: resolvedSessionId },
    });

    const headers = await stage(
      context(),
      new Request(URL, {
        method: "POST",
        headers: { "x-attendee-session": "att_raw_session_token_9f2c" },
      })
    );

    // Bucketed on the resolved attendee identity, exactly once.
    expect(keys).toEqual([`liveness.challenge:attendee:${resolvedSessionId}`]);
    // Admitted with the §0.11 RateLimit headers — not a 503 fail-closed.
    expect(headers).toEqual({
      "RateLimit-Limit": "12",
      "RateLimit-Remaining": "11",
      "RateLimit-Reset": "30",
    });
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
    // A resolving facts value makes the evaluator consult the denying limiter,
    // so this genuinely exercises the `ratelimit.exceeded` path (not the
    // no-identity `ratelimit.limiter_failed` branch).
    const stage = asCallable(
      rateLimitStage({
        classKey: "liveness.challenge",
        limiter,
        salt: SALT,
        facts: { attendeeSessionId: "sess_resolved_attendee_9f2c" },
      })
    );

    await expect(
      stage(context(), new Request(URL, { method: "POST", headers: { "x-attendee-session": raw } }))
    ).rejects.toMatchObject({ code: "rate_limited" });

    // The denial log path must be the one that actually fired ...
    const denial = sink.entries.find((entry) => entry.event === "ratelimit.exceeded");
    expect(denial).toBeDefined();
    expect(denial?.level).toBe("warn");
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

/**
 * Characterization pins for the two properties the `attendee.session` limit
 * (60 requests / hour / IP, contract §0.11) actually rests on — review F2 of
 * the OP-129 rate-limit lane.
 *
 * 1. The stage derives the IP leg through `resolveClientIp` **with the
 *    `TRUSTED_CLIENT_IP_HEADER` knob** (ADR-0024). A client that forges or
 *    rotates `x-forwarded-for` therefore cannot choose its own bucket; if a
 *    future change injects `facts` into the stage or swaps the derivation for a
 *    route-local `resolveClientIp(headers)` call, the 60/h/IP limit silently
 *    becomes a per-forgeable-header limit. P1 pins that.
 * 2. A request with no attributable IP is refused (`503 service_unavailable`),
 *    never silently unlimited, and the limiter is not even consulted — the
 *    fail-closed consequence the class declares (ADR-0786). P3 pins that.
 *
 * Both properties hold today: these pins are green on first run by design and
 * exist only so a regression breaks a test instead of shipping.
 */

/** An allow result with the attendee.session allowance (for the consulted spy). */
function attendeeSessionAllowed(): RateLimitResult {
  return { success: true, limit: 60, remaining: 59, resetSeconds: 3600 };
}

/** A limiter that records the keys it is consulted with and admits the call. */
function attendeeSessionLimiter(keys: string[]) {
  return {
    limit: (key: string, rule: { limit: number; windowSeconds: number }) => {
      keys.push(key);
      return Promise.resolve({
        success: true,
        limit: rule.limit,
        remaining: rule.limit - 1,
        resetSeconds: rule.windowSeconds,
      });
    },
  } satisfies RateLimiter;
}

const ORIGINAL_TRUSTED_CLIENT_IP_HEADER = process.env.TRUSTED_CLIENT_IP_HEADER;

describe("rateLimitStage — attendee.session IP trust model (review F2)", () => {
  beforeEach(() => {
    // The deployment knob: the edge overwrites `x-real-ip`, so it is the only
    // header the stage may trust for the IP leg (ADR-0024).
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-real-ip";
  });

  afterEach(() => {
    if (ORIGINAL_TRUSTED_CLIENT_IP_HEADER === undefined) {
      delete process.env.TRUSTED_CLIENT_IP_HEADER;
    } else {
      process.env.TRUSTED_CLIENT_IP_HEADER = ORIGINAL_TRUSTED_CLIENT_IP_HEADER;
    }
  });

  it("P1: keys the attendee.session bucket on the trusted header, so a forged x-forwarded-for cannot choose one", async () => {
    const keys: string[] = [];
    const stage = asCallable(
      rateLimitStage({
        classKey: "attendee.session",
        limiter: attendeeSessionLimiter(keys),
        salt: SALT,
      })
    );

    // Same trusted IP, two different client-forged forwarding chains. A client
    // that rotates `x-forwarded-for` must land in the SAME bucket, or the
    // 60/h/IP limit is evaded by editing one header.
    await stage(
      context(),
      new Request(URL, {
        method: "POST",
        headers: { "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" },
      })
    );
    await stage(
      context(),
      new Request(URL, {
        method: "POST",
        headers: { "x-real-ip": "9.9.9.9", "x-forwarded-for": "2.2.2.2" },
      })
    );

    // Both requests were limited once each, on exactly the trusted-header IP —
    // the forged values never became an identity.
    const trustedKey = `attendee.session:ip:${hashIdentity("9.9.9.9", SALT)}`;
    expect(keys).toEqual([trustedKey, trustedKey]);
    expect(keys.join("|")).not.toContain("1.1.1.1");
    expect(keys.join("|")).not.toContain("2.2.2.2");
  });

  it("P1: keys two different trusted-header IPs on two different attendee.session buckets", async () => {
    const keys: string[] = [];
    const stage = asCallable(
      rateLimitStage({
        classKey: "attendee.session",
        limiter: attendeeSessionLimiter(keys),
        salt: SALT,
      })
    );

    await stage(
      context(),
      new Request(URL, { method: "POST", headers: { "x-real-ip": "9.9.9.9" } })
    );
    await stage(
      context(),
      new Request(URL, { method: "POST", headers: { "x-real-ip": "8.8.4.4" } })
    );

    // The control for the pin above: distinct callers still get distinct
    // buckets, so P1 cannot pass by hashing every request onto one key.
    expect(keys).toEqual([
      `attendee.session:ip:${hashIdentity("9.9.9.9", SALT)}`,
      `attendee.session:ip:${hashIdentity("8.8.4.4", SALT)}`,
    ]);
  });

  it("P2: renders the attendee.session success headers (60 per 3600s) and no Retry-After", async () => {
    const keys: string[] = [];
    const stage = rateLimitStage({
      classKey: "attendee.session",
      limiter: attendeeSessionLimiter(keys),
      salt: SALT,
    });

    const headers = await stage(
      context(),
      new Request(URL, { method: "POST", headers: { "x-real-ip": "9.9.9.9" } })
    );

    // The class allowance itself: 60 requests per hour (§0.11). An admitted
    // request carries no `Retry-After` — that header belongs to a 429 only.
    expect(headers).toEqual({
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "59",
      "RateLimit-Reset": "3600",
    });
  });

  it("P3: refuses an unattributable request with 503 service_unavailable and never consults the limiter", async () => {
    const limit = vi.fn(() => Promise.resolve(attendeeSessionAllowed()));
    const stage = asCallable(
      rateLimitStage({ classKey: "attendee.session", limiter: { limit }, salt: SALT })
    );

    // The trusted header (~x-real-ip) is configured but absent, and the request
    // carries no IP header at all, so there is no attributable IP.
    await expect(stage(context(), new Request(URL, { method: "POST" }))).rejects.toMatchObject({
      code: "service_unavailable",
      status: 503,
    });

    // Fail-closed, not fail-unlimited: an unattributable request must not skip
    // the limit, so the limiter is never even asked for a verdict.
    expect(limit).toHaveBeenCalledTimes(0);
  });

  it("P3: refuses a request with no IP header at all when the trusted-header knob is unset", async () => {
    // The dev/e2e fallback branch: no knob means `x-forwarded-for` then
    // `x-real-ip`, and with neither present there is still no identity.
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
    const limit = vi.fn(() => Promise.resolve(attendeeSessionAllowed()));
    const stage = asCallable(
      rateLimitStage({ classKey: "attendee.session", limiter: { limit }, salt: SALT })
    );

    await expect(stage(context(), new Request(URL, { method: "POST" }))).rejects.toMatchObject({
      code: "service_unavailable",
      status: 503,
    });

    expect(limit).toHaveBeenCalledTimes(0);
  });
});
