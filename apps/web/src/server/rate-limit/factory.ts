import { getRateLimitConfig } from "@/server/config/env";

import { memoryRateLimiter } from "./adapters/memory";
import { upstashRateLimiter } from "./adapters/upstash";
import type { RateLimiter } from "./evaluate";

/**
 * Build the process rate limiter from the environment.
 *
 * The provider is data (`RATE_LIMIT_PROVIDER`): `redis` builds the Upstash
 * adapter from `UPSTASH_REDIS_REST_URL`/`_TOKEN`, anything else (the default
 * outside production) builds the in-process memory adapter. The result is
 * memoised so counters persist across requests within one process — required
 * for the memory provider to actually accumulate a window.
 */

let singleton: RateLimiter | undefined;

/**
 * Return the memoised process limiter, building it on first use.
 *
 * @returns The configured {@link RateLimiter}.
 */
export function createRateLimiter(): RateLimiter {
  if (singleton !== undefined) {
    return singleton;
  }

  const config = getRateLimitConfig();
  if (
    config.provider === "redis" &&
    config.upstashUrl !== undefined &&
    config.upstashToken !== undefined
  ) {
    singleton = upstashRateLimiter({ url: config.upstashUrl, token: config.upstashToken });
  } else {
    singleton = memoryRateLimiter();
  }

  return singleton;
}
