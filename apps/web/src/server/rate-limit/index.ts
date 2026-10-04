/**
 * The rate-limit port (contract §0.11).
 *
 * A single import surface for the class table, identity derivation, strictest
 * result folding, the Upstash and memory adapters, the evaluation boundary and
 * the `defineRoute` stage. Call sites depend on this barrel only.
 */

export { deriveRateLimitIdentities, hashIdentity } from "./identity";
export type {
  IdentityDerivationOptions,
  RateLimitFacts,
  RateLimitIdentities,
  RateLimitScope,
} from "./identity";

export {
  RATE_LIMIT_BYPASS_CLASSES,
  RATE_LIMIT_CLASSES,
  isRateLimitBypassed,
  rateLimitFailurePolicy,
} from "./classes";
export type { RateLimitClass, RateLimitFailurePolicy, RateLimitRule } from "./classes";

export { rateLimitHeaders, rateLimitKey, strictestRateLimitResult } from "./result";
export type { RateLimitResult } from "./result";

export { evaluateRateLimit } from "./evaluate";
export type {
  EvaluateRateLimitOptions,
  RateLimiter,
  RateLimitEvaluation,
  RateLimitOutcome,
  RateLimitRuleRef,
} from "./evaluate";

export { memoryRateLimiter } from "./adapters/memory";
export { upstashRateLimiter } from "./adapters/upstash";
export type { UpstashRateLimiterOptions } from "./adapters/upstash";

export { rateLimitStage } from "./stage";
export type { RateLimitStageOptions } from "./stage";

export { createRateLimiter } from "./factory";
