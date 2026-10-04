import type { RateLimiter, RateLimitRuleRef } from "../evaluate";
import type { RateLimitResult } from "../result";

/**
 * The in-memory rate limiter (tests and the `memory` provider).
 *
 * A simple fixed window: the first `limit` calls within `windowSeconds` are
 * allowed, the next are denied. Counters are kept per key in a `Map`, so a
 * process serves its own limits without any external dependency — the adapter
 * used by the test suite and by local/e2e runs.
 */

interface Window {
  count: number;
  windowStart: number;
}

/**
 * Build a fresh in-memory limiter.
 *
 * Each call to this factory owns an isolated counter map, so tests never share
 * state; the `memory` provider calls it once per process to persist counters
 * across requests.
 *
 * @returns A {@link RateLimiter} backed by an in-process `Map`.
 */
export function memoryRateLimiter(): RateLimiter {
  const windows = new Map<string, Window>();

  return {
    limit(key: string, rule: RateLimitRuleRef): Promise<RateLimitResult> {
      const now = Date.now();
      const windowMs = rule.windowSeconds * 1000;
      const existing = windows.get(key);

      let window: Window;
      if (existing === undefined || now - existing.windowStart >= windowMs) {
        window = { count: 0, windowStart: now };
        windows.set(key, window);
      } else {
        window = existing;
      }

      window.count += 1;
      const resetMs = window.windowStart + windowMs - now;

      return Promise.resolve({
        success: window.count <= rule.limit,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - window.count),
        resetSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      });
    },
  };
}
