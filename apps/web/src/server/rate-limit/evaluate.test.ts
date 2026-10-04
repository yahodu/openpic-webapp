import { describe, expect, it, vi } from "vitest";

import {
  evaluateRateLimit,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from "@/server/rate-limit";

/**
 * U2 + U4 + U5 at the evaluation boundary.
 *
 * `evaluateRateLimit` turns facts into one or more identity keys, asks the
 * limiter for each applicable rule and applies the strictest result. A webhook
 * never consults the limiter, and a limiter failure is surfaced as an
 * `unavailable` outcome (the caller then applies the per-class failure policy).
 */

const SALT = "test-salt";

function allowed(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return { success: true, limit: 60, remaining: 59, resetSeconds: 30, ...overrides };
}

describe("evaluateRateLimit", () => {
  it("U2: denies when any contributing rule is exceeded and reports the strictest result", async () => {
    const limit = vi.fn((_key: string, rule: RateLimitRule): Promise<RateLimitResult> =>
      Promise.resolve(
        rule.scope === "contact"
          ? { success: false, limit: 5, remaining: 0, resetSeconds: 12 }
          : allowed({ limit: 15, remaining: 3, resetSeconds: 40 })
      )
    );
    const limiter: RateLimiter = { limit };

    const evaluation = await evaluateRateLimit({
      classKey: "auth.otp",
      facts: { contact: "ada@example.com", ip: "203.0.113.7" },
      limiter,
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("denied");
    expect(evaluation.success).toBe(false);
    expect(evaluation.limit).toBe(5);
    expect(evaluation.remaining).toBe(0);
    expect(evaluation.resetSeconds).toBe(12);
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("U2: allows when every contributing rule allows", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> =>
      Promise.resolve(allowed({ remaining: 59 }))
    );
    const evaluation = await evaluateRateLimit({
      classKey: "write.normal",
      facts: { ip: "203.0.113.7" },
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("allowed");
    expect(evaluation.success).toBe(true);
    expect(evaluation.limit).toBe(60);
    expect(evaluation.remaining).toBe(59);
  });

  it("U2: keys the limiter by class + scope using only hashed identities", async () => {
    const keys: string[] = [];
    const limit = vi.fn((key: string): Promise<RateLimitResult> => {
      keys.push(key);
      return Promise.resolve(allowed());
    });
    await evaluateRateLimit({
      classKey: "auth.otp",
      facts: { contact: "ada@example.com", ip: "203.0.113.7" },
      limiter: { limit },
      salt: SALT,
    });

    expect(keys.every((key) => key.startsWith("auth.otp:"))).toBe(true);
    expect(keys.join("|")).not.toContain("ada@example.com");
    expect(keys.join("|")).not.toContain("203.0.113.7");
  });

  it("U2: skips a rule whose identity is not present", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const evaluation = await evaluateRateLimit({
      classKey: "auth.otp",
      facts: { ip: "203.0.113.7" },
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("allowed");
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("U4: treats a limited class with no usable identity as a limiter failure, never a silent bypass", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const evaluation = await evaluateRateLimit({
      classKey: "write.normal",
      facts: {},
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("unavailable");
    expect(evaluation.success).toBe(false);
    expect(limit).not.toHaveBeenCalled();
  });

  it("U4: treats a blank identity fact as absent (an empty IP cannot key a bucket)", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const evaluation = await evaluateRateLimit({
      classKey: "write.normal",
      facts: { ip: "" },
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("unavailable");
    expect(limit).not.toHaveBeenCalled();
  });

  it("U5: never consults the limiter for the webhook class", async () => {
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.resolve(allowed()));
    const evaluation = await evaluateRateLimit({
      classKey: "webhook",
      facts: { ip: "203.0.113.7" },
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("allowed");
    expect(evaluation.bypass).toBe(true);
    expect(limit).not.toHaveBeenCalled();
  });

  it("U4: surfaces a limiter failure as an `unavailable` outcome", async () => {
    const failure = new Error("upstash unreachable");
    const limit = vi.fn((): Promise<RateLimitResult> => Promise.reject(failure));

    const evaluation = await evaluateRateLimit({
      classKey: "write.normal",
      facts: { ip: "203.0.113.7" },
      limiter: { limit },
      salt: SALT,
    });

    expect(evaluation.outcome).toBe("unavailable");
    expect(evaluation.error).toBe(failure);
  });
});
