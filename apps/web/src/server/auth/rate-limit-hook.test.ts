import { describe, expect, it, vi } from "vitest";

import { createRateLimitHook } from "@/server/auth/rate-limit-hook";
import {
  hashIdentity,
  rateLimitKey,
  type RateLimiter,
  type RateLimitResult,
} from "@/server/rate-limit";

/**
 * Unit pins for the session-authenticated verify cap's fail-closed behaviour
 * (OP-85 follow-up, ADR-0023 §4).
 *
 * `auth.verify` deliberately does not count a session-authenticated verify
 * (ADR-0021 §1), so the `before` hook bounds those with a complementary
 * per-user cap consulted directly on the rate-limit port. The port is an
 * external dependency (Upstash in production): when it errors, the hook must
 * **fail closed** — deny with the same 429 `too_many_requests` envelope a spent
 * cap produces — never let a limiter outage reopen the code-guessing surface.
 *
 * The hook is driven directly with a context carrying an authenticated session
 * (`ctx.context.session`), which is the first thing `getSessionFromCtx` reads,
 * so no database or network is involved. Only the port is injected.
 */

const SALT = "auth-hook-rate-limit-salt";
const USER_ID = "user_cap_test_9f2c";
const VERIFY_PATH = "/phone-number/verify";

type Hook = ReturnType<typeof createRateLimitHook>;
type HookContext = Parameters<Hook>[0];

/** A `before`-hook context for an authenticated `/phone-number/verify`. */
function authenticatedVerifyContext(): HookContext {
  return {
    path: VERIFY_PATH,
    headers: new Headers({ "x-forwarded-for": "203.0.113.42" }),
    body: { phoneNumber: "+919900000001", code: "123456" },
    query: {},
    context: {
      session: {
        user: { id: USER_ID },
        session: { id: "sess_cap_test", userId: USER_ID },
      },
    },
  } as unknown as HookContext;
}

function allowed(): RateLimitResult {
  return { success: true, limit: 10, remaining: 9, resetSeconds: 600 };
}

describe("createRateLimitHook — authenticated verify cap fails closed", () => {
  it("denies with the 429 too_many_requests envelope when the limiter rejects", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.reject(new Error("limiter down")));
    const hook = createRateLimitHook({ rateLimiter: { limit }, salt: SALT });

    await expect(hook(authenticatedVerifyContext())).rejects.toMatchObject({
      statusCode: 429,
      body: { code: "too_many_requests", message: "Too many requests. Try again later." },
    });

    // The cap is the thing that was consulted (once) — not some other path.
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("denies with the 429 too_many_requests envelope when the limiter reports the cap as spent", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> =>
      Promise.resolve({ success: false, limit: 10, remaining: 0, resetSeconds: 600 })
    );
    const hook = createRateLimitHook({ rateLimiter: { limit }, salt: SALT });

    await expect(hook(authenticatedVerifyContext())).rejects.toMatchObject({
      statusCode: 429,
      body: { code: "too_many_requests", message: "Too many requests. Try again later." },
    });
  });

  it("admits an authenticated verify when the limiter allows (positive control)", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const hook = createRateLimitHook({ rateLimiter: { limit }, salt: SALT });

    await expect(hook(authenticatedVerifyContext())).resolves.toBeUndefined();
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("keys the cap on a salted hash of the user id, never the raw id", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      limit: (key) => {
        keys.push(key);
        return Promise.resolve(allowed());
      },
    };
    const hook = createRateLimitHook({ rateLimiter: limiter, salt: SALT });

    await hook(authenticatedVerifyContext());

    expect(keys).toEqual([rateLimitKey("auth.verify", "user", hashIdentity(USER_ID, SALT))]);
    expect(keys.join("|")).not.toContain(USER_ID);
  });
});
