import type { RateLimitClass } from "./classes";
import type { RateLimitScope } from "./identity";

/**
 * Result shaping for the rate-limit port (contract §0.11).
 *
 * A limiter returns one result per consulted key; `strictestRateLimitResult`
 * folds them into the single outcome a client sees — the strictest of the
 * listed limits applies, and success is the AND over every contributing key.
 * `rateLimitHeaders` renders that outcome as the fixed contract wire headers.
 */

/** The outcome of a single limiter consultation. */
export interface RateLimitResult {
  /** Whether the call is within the limit. */
  readonly success: boolean;
  /** The rule's allowance for the window. */
  readonly limit: number;
  /** Tokens left in the window (never negative). */
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly resetSeconds: number;
}

/**
 * Fold several results into the strictest outcome.
 *
 * `success` is true only when *every* contributing result succeeded (a single
 * denied key denies the request); `limit`, `remaining` and `resetSeconds` come
 * from the result with the fewest remaining tokens, so the numbers describe the
 * binding constraint. An empty list is trivially allowed.
 *
 * @param results - The per-key results to fold.
 * @returns The strictest result.
 */
export function strictestRateLimitResult(results: readonly RateLimitResult[]): RateLimitResult {
  const first = results[0];
  if (first === undefined) {
    return { success: true, limit: 0, remaining: 0, resetSeconds: 0 };
  }

  let strictest = first;
  for (const result of results) {
    if (result.remaining < strictest.remaining) {
      strictest = result;
    }
  }

  return {
    success: results.every((result) => result.success),
    limit: strictest.limit,
    remaining: strictest.remaining,
    resetSeconds: strictest.resetSeconds,
  };
}

/**
 * Render a result as the contract §0.11 rate-limit headers.
 *
 * The three `RateLimit-*` headers are always present; a denied result also
 * carries `Retry-After` equal to the window reset, so a client can back off
 * without guessing.
 *
 * @param result - The result to render.
 * @returns The wire headers for a success or a `429`.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetSeconds),
  };

  if (!result.success) {
    headers["Retry-After"] = String(result.resetSeconds);
  }

  return headers;
}

/**
 * Namespace a limiter key by class and scope.
 *
 * The same identity must never collide across classes or scopes, so the key is
 * `"<class>:<scope>:<identity>"`.
 *
 * @param classKey - The rate-limit class.
 * @param scope - The scope the identity belongs to.
 * @param identity - The derived (usually hashed) identity.
 * @returns The namespaced limiter key.
 */
export function rateLimitKey(
  classKey: RateLimitClass,
  scope: RateLimitScope,
  identity: string
): string {
  return `${classKey}:${scope}:${identity}`;
}
