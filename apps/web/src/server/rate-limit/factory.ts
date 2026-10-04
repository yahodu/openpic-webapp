import { ConfigError, getRateLimitConfig } from "@/server/config/env";

import { memoryRateLimiter } from "./adapters/memory";
import { upstashRateLimiter } from "./adapters/upstash";
import type { RateLimiter } from "./evaluate";

/**
 * Build the process rate limiter from the environment.
 *
 * The provider is data (`RATE_LIMIT_PROVIDER`): `redis` builds the Upstash
 * adapter from `UPSTASH_REDIS_REST_URL`/`_TOKEN`, anything else (the default
 * outside production) builds the in-process memory adapter. Selecting `redis`
 * without credentials fails closed (`ConfigError`) — it must never silently
 * degrade to the per-process memory limiter. The result is memoised so counters
 * persist across requests within one process — required for the memory provider
 * to actually accumulate a window.
 */

let singleton: RateLimiter | undefined;

/**
 * Return the memoised process limiter, building it on first use.
 *
 * @returns The configured {@link RateLimiter}.
 * @throws {ConfigError} When the `redis` provider is selected without credentials.
 */
export function createRateLimiter(): RateLimiter {
  if (singleton !== undefined) {
    return singleton;
  }

  const config = getRateLimitConfig();
  if (config.provider === "redis") {
    const url = config.upstashUrl;
    const token = config.upstashToken;
    if (url === undefined || token === undefined) {
      // `getRateLimitConfig` already rejects a redis provider without
      // credentials; this guard narrows the optional type without a non-null
      // assertion and keeps the factory fail-closed on its own.
      throw new ConfigError(["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]);
    }
    singleton = upstashRateLimiter({ url, token });
  } else {
    singleton = memoryRateLimiter();
  }

  return singleton;
}
