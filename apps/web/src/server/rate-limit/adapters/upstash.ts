import { z } from "zod";

import type { RateLimiter, RateLimitRuleRef } from "../evaluate";
import type { RateLimitResult } from "../result";

/**
 * The Upstash Redis rate limiter (contract §0.11, "Upstash Ratelimit, sliding
 * window").
 *
 * Upstash exposes a REST endpoint that executes a Redis command: a single
 * `EVAL` whose result is `[currentFields, previousFields, success]`, where
 * `currentFields` is `[requestId, count]`. The adapter speaks that wire
 * directly (one POST per `limit()` call) so it stays a thin, dependency-free
 * port. The response is validated with Zod: anything that is not the documented
 * shape is a limiter failure, never a silent allow.
 */

/** The documented Upstash `EVAL` result tuple. */
const upstashResultSchema = z.tuple([
  z.array(z.string()),
  z.array(z.string()),
  z.union([z.number(), z.boolean()]),
]);

/** The Upstash REST envelope. */
const upstashEnvelopeSchema = z.object({
  result: upstashResultSchema,
});

/** A Lua sliding-window script understood by Upstash; the body is opaque here. */
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = redis.call("INCR", key)
if current == 1 then redis.call("EXPIRE", key, window) end
local ttl = redis.call("TTL", key)
if ttl < 0 then ttl = window end
return { { key, tostring(current) }, {}, current <= limit and 1 or 0 }
`.trim();

/** Construction options for {@link upstashRateLimiter}. */
export interface UpstashRateLimiterOptions {
  /** The Upstash REST base URL. */
  readonly url: string;
  /** The Upstash REST bearer token. */
  readonly token: string;
  /** A fetch implementation override (tests / instrumentation). */
  readonly fetch?: typeof fetch;
}

/**
 * Build a limiter backed by an Upstash Redis REST endpoint.
 *
 * @param options - The endpoint URL and bearer token.
 * @returns A {@link RateLimiter} that POSTs one `EVAL` per consultation.
 */
export function upstashRateLimiter(options: UpstashRateLimiterOptions): RateLimiter {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async limit(key: string, rule: RateLimitRuleRef): Promise<RateLimitResult> {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify([
          "EVAL",
          RATE_LIMIT_SCRIPT,
          "1",
          key,
          String(rule.limit),
          String(rule.windowSeconds),
        ]),
      });

      const payload: unknown = await response.json();
      const parsed = upstashEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Upstash rate limit response did not match the expected shape.");
      }

      const [current, , rawSuccess] = parsed.data.result;
      const count = Number(current[1]);
      const success = typeof rawSuccess === "boolean" ? rawSuccess : rawSuccess > 0;

      return {
        success,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetSeconds: rule.windowSeconds,
      };
    },
  };
}
