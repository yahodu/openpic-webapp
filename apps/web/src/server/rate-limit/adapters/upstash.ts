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

/**
 * A Lua sliding-window script understood by Upstash.
 *
 * Two adjacent fixed buckets are tracked (`currentKey`/`previousKey`) and the
 * previous bucket is weighted by how much of the window has elapsed, so a burst
 * that straddles a window boundary cannot be over-admitted — a request is
 * admitted only when `previous * weight + current` is within `limit`. The script
 * returns the documented `[currentFields, previousFields, success]` tuple so the
 * adapter can render `RateLimit-Remaining` from the same counts.
 */
const RATE_LIMIT_SCRIPT = `
local base = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2]) * 1000
local now = tonumber(ARGV[3])
local windowIndex = math.floor(now / windowMs)
local currentKey = base .. ":" .. windowIndex
local previousKey = base .. ":" .. (windowIndex - 1)
local current = redis.call("INCR", currentKey)
if current == 1 then redis.call("PEXPIRE", currentKey, windowMs * 2) end
local prev = tonumber(redis.call("GET", previousKey) or "0")
local elapsed = now % windowMs
local weight = 1 - (elapsed / windowMs)
local weighted = math.floor(prev * weight) + current
local success = 0
if weighted <= limit then success = 1 end
return { { currentKey, tostring(current) }, { previousKey, tostring(prev) }, success }
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
      const now = Date.now();
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
          String(now),
        ]),
      });

      const payload: unknown = await response.json();
      const parsed = upstashEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Upstash rate limit response did not match the expected shape.");
      }

      const [current, previous, rawSuccess] = parsed.data.result;
      const currentCount = Number(current[1]);
      const previousCount = previous.length >= 2 ? Number(previous[1]) : 0;
      const windowMs = rule.windowSeconds * 1000;
      const elapsed = now % windowMs;
      const weight = 1 - elapsed / windowMs;
      const weighted = Math.floor(previousCount * weight) + currentCount;

      if (!Number.isFinite(currentCount) || !Number.isFinite(weighted)) {
        throw new Error("Upstash rate limit response carried a non-numeric count.");
      }

      const success = typeof rawSuccess === "boolean" ? rawSuccess : rawSuccess > 0;

      return {
        success,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - weighted),
        resetSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
      };
    },
  };
}
