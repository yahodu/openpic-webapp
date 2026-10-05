import { getTrustedClientIpHeader } from "@/server/config/env";
import type { RouteStageContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";

import { resolveClientIp } from "./client-ip";
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
 * The returned stage is usable both as the coarse, pre-auth `RouteStage`
 * (2-argument) and as the post-auth identity stage (`rateLimitIdentity`,
 * which the pipeline calls with the parsed request body as a third argument).
 *
 * @param options - Class, limiter, salt and optional pre-derived facts.
 * @returns A stage that emits headers or denies the request.
 */
export function rateLimitStage(
  options: RateLimitStageOptions
): (ctx: RouteStageContext, request: Request, body?: unknown) => Promise<Record<string, string>> {
  return async (ctx, request, body): Promise<Record<string, string>> => {
    const facts = options.facts ?? deriveFacts(ctx.principal, request, body);
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

/**
 * Derive the request facts the stage keys on (principal, contact, IP).
 *
 * `X-Attendee-Session` is a documented *request* header (§0.12) whose token is
 * a secret hashed at rest (§0.15): a client-supplied value is never trusted as
 * an identity. The attendee scope is keyed only from a pre-validated
 * `facts.attendeeSessionId` supplied by a server-side session resolver (the
 * resolved, non-raw session identity). When no resolver has run, the attendee
 * identity is simply absent, so an attendee-only class cannot mint a fresh
 * bucket per forged header.
 *
 * Pre-auth (the coarse stage) only `principal` (absent), `ip` and any explicit
 * `facts` are available; the parsed request body is absent, so no `contact` is
 * derived. The post-auth identity stage receives the parsed body and can key
 * the contact-scoped `auth.otp`/`auth.verify` rules on it.
 */
function deriveFacts(
  principal: string | undefined,
  request: Request,
  body: unknown
): RateLimitFacts {
  const ip = resolveClientIp(request.headers, getTrustedClientIpHeader());
  const contact = deriveContact(body);

  return {
    ...(principal === undefined ? {} : { principalId: principal }),
    ...(ip === undefined ? {} : { ip }),
    ...(contact === undefined ? {} : { contact }),
  };
}

/**
 * The contact a request body carries for the contact-keyed classes.
 *
 * `auth.otp`/`auth.verify` declare a `contact` field; the stage normalises and
 * salts-hashes it before it becomes a limiter key, so a raw email/phone never
 * appears in a key (§0.15). A missing or blank field is simply absent.
 */
function deriveContact(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as { contact?: unknown }).contact;
  return typeof value === "string" && value !== "" ? value : undefined;
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
