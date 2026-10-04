import { describe, expect, it } from "vitest";

import { memoryRateLimiter } from "@/server/rate-limit";

/**
 * I2 (adapter level) — the in-memory limiter used by tests and the `memory`
 * provider. A fixed window of N allows exactly N calls, then denies.
 */

describe("memoryRateLimiter", () => {
  it("allows the first N calls and denies the N+1st within the window", async () => {
    const limiter = memoryRateLimiter();
    const rule = { limit: 60, windowSeconds: 60 };

    let lastAllowed;
    for (let i = 0; i < 60; i += 1) {
      lastAllowed = await limiter.limit("write.normal:user:abc", rule);
    }

    expect(lastAllowed?.success).toBe(true);

    const denied = await limiter.limit("write.normal:user:abc", rule);
    expect(denied.success).toBe(false);
    expect(denied.limit).toBe(60);
    expect(denied.remaining).toBe(0);
    expect(denied.resetSeconds).toBeGreaterThan(0);
  });

  it("keeps separate counters per key", async () => {
    const limiter = memoryRateLimiter();
    const rule = { limit: 1, windowSeconds: 60 };

    expect((await limiter.limit("a", rule)).success).toBe(true);
    expect((await limiter.limit("b", rule)).success).toBe(true);
    expect((await limiter.limit("a", rule)).success).toBe(false);
    expect((await limiter.limit("b", rule)).success).toBe(false);
  });
});
