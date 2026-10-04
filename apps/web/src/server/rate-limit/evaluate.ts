import { RATE_LIMIT_CLASSES, isRateLimitBypassed, type RateLimitClass } from "./classes";
import { deriveRateLimitIdentities, type RateLimitFacts } from "./identity";
import { rateLimitKey, strictestRateLimitResult, type RateLimitResult } from "./result";

/**
 * The evaluation boundary of the rate-limit port (contract §0.11).
 *
 * `evaluateRateLimit` turns request facts into one or more identity keys, asks
 * the limiter for each applicable rule and applies the strictest result. A
 * webhook never consults the limiter. A limiter failure is surfaced as an
 * `unavailable` outcome; the caller then applies the per-class failure policy.
 */

/** The rate-limiter port: one sliding-window consultation per key/rule. */
export interface RateLimiter {
  /**
   * Consume one token for `key` under `rule`.
   *
   * @param key - The namespaced limiter key (`class:scope:identity`).
   * @param rule - The allowance and window to apply.
   * @returns The resulting allowance state.
   */
  limit(key: string, rule: RateLimitRuleRef): Promise<RateLimitResult>;
}

/** A rule as the limiter sees it (scope is irrelevant to the adapter). */
export interface RateLimitRuleRef {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The three possible evaluation outcomes. */
export type RateLimitOutcome = "allowed" | "denied" | "unavailable";

/** The folded evaluation a stage renders into headers / an error. */
export interface RateLimitEvaluation {
  readonly outcome: RateLimitOutcome;
  readonly success: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
  /** True when the class bypasses rate limiting (webhook). */
  readonly bypass: boolean;
  /** The limiter failure, present only for an `unavailable` outcome. */
  readonly error?: unknown;
}

/** Options for {@link evaluateRateLimit}. */
export interface EvaluateRateLimitOptions {
  readonly classKey: RateLimitClass;
  readonly facts: RateLimitFacts;
  readonly limiter: RateLimiter;
  readonly salt: string;
}

/**
 * Evaluate every applicable rule for a class and fold the results.
 *
 * Rules whose identity is absent are skipped (a caller with no contact is not
 * bucketed against the contact limit); a rule whose consultation throws aborts
 * the evaluation as `unavailable` so the caller can fail open/closed.
 *
 * @param options - Class, facts, limiter and salt.
 * @returns The folded evaluation.
 */
export async function evaluateRateLimit(
  options: EvaluateRateLimitOptions
): Promise<RateLimitEvaluation> {
  if (isRateLimitBypassed(options.classKey)) {
    return allowedResult(true);
  }

  const identities = deriveRateLimitIdentities(options.facts, { salt: options.salt });
  const rules = RATE_LIMIT_CLASSES[options.classKey];
  const results: RateLimitResult[] = [];

  for (const rule of rules) {
    const identity = identities[rule.scope];
    if (identity === undefined) {
      continue;
    }

    try {
      results.push(
        await options.limiter.limit(rateLimitKey(options.classKey, rule.scope, identity), rule)
      );
    } catch (error: unknown) {
      return {
        outcome: "unavailable",
        success: false,
        limit: 0,
        remaining: 0,
        resetSeconds: 0,
        bypass: false,
        error,
      };
    }
  }

  if (results.length === 0) {
    return allowedResult(false);
  }

  const strictest = strictestRateLimitResult(results);
  return {
    outcome: strictest.success ? "allowed" : "denied",
    success: strictest.success,
    limit: strictest.limit,
    remaining: strictest.remaining,
    resetSeconds: strictest.resetSeconds,
    bypass: false,
  };
}

/** Build an allowed evaluation with a zeroed result. */
function allowedResult(bypass: boolean): RateLimitEvaluation {
  return {
    outcome: "allowed",
    success: true,
    limit: 0,
    remaining: 0,
    resetSeconds: 0,
    bypass,
  };
}
