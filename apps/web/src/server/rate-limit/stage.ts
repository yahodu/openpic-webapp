import type { RouteStage } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";

import { isRateLimitBypassed, rateLimitFailurePolicy, type RateLimitClass } from "./classes";
import { evaluateRateLimit, type RateLimiter } from "./evaluate";
import { deriveRateLimitIdentities, type RateLimitFacts } from "./identity";
import { rateLimitHeaders } from "./result";

/**
 * The `defineRoute` rate-limit stage (contract §0.11).
 *
 * Wraps {@link evaluateRateLimit} as a pipeline stage: on success it returns the
 * `RateLimit-*` headers for the pipeline to merge into the response; on a
 * denial it throws a `429 rate_limited` carrying `Retry-After` + the headers;
 * on a limiter failure it applies the class's policy — fail open (log and pass)
 * for ordinary classes, fail closed (`503 service_unavailable`) for the
 * abuse-prone auth/selfie/liveness classes.
 */

/** Options for {@link rateLimitStage}. */
export interface RateLimitStageOptions {
  /** The class to enforce. */
  readonly classKey: RateLimitClass;
  /** The limiter adapter. */
  readonly limiter: RateLimiter;
  /** The deployment salt mixed into hashed identities. */
  readonly salt: string;
  /** Explicit facts; when omitted they are derived from the request. */
  readonly facts?: RateLimitFacts;
}

/**
 * Build the rate-limit pipeline stage for a class.
 *
 * @param options - Class, limiter, salt and optional pre-derived facts.
 * @returns A stage that emits headers or denies the request.
 */
export function rateLimitStage(options: RateLimitStageOptions): RouteStage {
  return async (ctx, request): Promise<Record<string, string>> => {
    const facts = options.facts ?? deriveFacts(ctx.principal, request);
    const evaluation = await evaluateRateLimit({
      classKey: options.classKey,
      facts,
      limiter: options.limiter,
      salt: options.salt,
    });

    const logger = requestLogger(request, { route: ctx.route });

    if (evaluation.outcome === "denied") {
      logger.warn("rate limit exceeded", {
        event: "ratelimit.exceeded",
        classKey: options.classKey,
        identity: logIdentity(facts, options.salt),
      });
      throw appError("rate_limited", { headers: rateLimitHeaders(evaluation) });
    }

    if (evaluation.outcome === "unavailable") {
      logger.error("rate limiter failed", {
        event: "ratelimit.limiter_failed",
        classKey: options.classKey,
      });
      if (rateLimitFailurePolicy(options.classKey) === "fail-closed") {
        throw appError("service_unavailable");
      }
      return {};
    }

    if (isRateLimitBypassed(options.classKey)) {
      return {};
    }

    return rateLimitHeaders(evaluation);
  };
}

/** Derive the request facts the stage keys on (principal, attendee, IP). */
function deriveFacts(principal: string | undefined, request: Request): RateLimitFacts {
  const attendeeSessionId = request.headers.get("x-attendee-session") ?? undefined;
  const ip = firstForwardedHop(request.headers.get("x-forwarded-for"));

  return {
    ...(principal === undefined ? {} : { principalId: principal }),
    ...(attendeeSessionId === undefined || attendeeSessionId === "" ? {} : { attendeeSessionId }),
    ...(ip === undefined ? {} : { ip }),
  };
}

/**
 * The trusted client IP: the first hop of `x-forwarded-for`.
 *
 * Vercel overwrites the header at the platform edge, so the leftmost entry is
 * the real client; fallback hops (`10.0.0.1`) are dropped.
 */
function firstForwardedHop(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const first = value.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

/**
 * A hashed identity safe to log — never a raw IP or contact.
 *
 * The primary bucket is the `user` scope (principal or hashed IP), falling back
 * to the attendee/contact/ip scopes for classes that carry no user identity.
 */
function logIdentity(facts: RateLimitFacts, salt: string): string {
  const identities = deriveRateLimitIdentities(facts, { salt });
  return (
    identities.user ?? identities.attendee ?? identities.contact ?? identities.ip ?? "anonymous"
  );
}
