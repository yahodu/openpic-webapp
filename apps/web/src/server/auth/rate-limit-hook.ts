import { APIError, getSessionFromCtx } from "better-auth/api";

import { getTrustedClientIpHeader } from "@/server/config/env";
import {
  evaluateRateLimit,
  hashIdentity,
  rateLimitKey,
  resolveClientIp,
  type RateLimiter,
} from "@/server/rate-limit";

import { type AuthHookContext, bodyOf } from "./internal";

/**
 * The OTP rate-limit leg of the `before` hook (OP-85, contract §0.11).
 *
 * OpenPic owns abuse control for the auth surface: the `auth.otp` class guards
 * every endpoint that delivers a code and `auth.verify` guards the endpoints
 * that check one. Better Auth's own limiter is disabled in the config, so these
 * two classes never compound with it.
 *
 * The `auth.verify` class protects credential verification during sign-in. An
 * already-authenticated verify (binding a phone, or the enable-flow's one-time
 * code) is not a sign-in credential check, so it is not counted — otherwise it
 * would spend the caller's sign-in budget before the challenge it is meant to
 * protect even begins. It is instead bounded by a complementary per-user cap
 * (`AUTHENTICATED_VERIFY_LIMIT` per `AUTHENTICATED_VERIFY_WINDOW_SECONDS`),
 * consulted with an explicit rule so the frozen class table is untouched
 * (ADR-0021 §1, ADR-0023 §4).
 *
 * A denied evaluation throws the same 429 envelope a client would observe
 * before this decomposition.
 */

/** Endpoints that deliver an OTP and therefore consume an `auth.otp` token. */
const OTP_SEND_PATHS: ReadonlySet<string> = new Set([
  "/email-otp/send-verification-otp",
  "/phone-number/send-otp",
  "/two-factor/send-otp",
]);

/** Endpoints that verify an OTP and therefore consume an `auth.verify` token. */
const OTP_VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email-otp",
  "/phone-number/verify",
  "/two-factor/verify-otp",
]);

/**
 * Verify endpoints that, when a session is present, spend the complementary
 * per-user cap instead of `auth.verify` (ADR-0021 §1, ADR-0023 §4).
 *
 * `/sign-in/email-otp` is excluded: it is the sign-in credential check itself,
 * so an authenticated call to it is not a "session holder guessing a code".
 */
const AUTHENTICATED_VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/phone-number/verify",
  "/two-factor/verify-otp",
]);

/** The authenticated-verify cap budget (ADR-0023 §4 product decision). */
const AUTHENTICATED_VERIFY_LIMIT = 10;
const AUTHENTICATED_VERIFY_WINDOW_SECONDS = 600;

/** The contact (email/phone) an OTP endpoint body carries, when present. */
function contactFromBody(body: Record<string, unknown>): string | undefined {
  if (typeof body.email === "string" && body.email !== "") {
    return body.email;
  }
  if (typeof body.phoneNumber === "string" && body.phoneNumber !== "") {
    return body.phoneNumber;
  }
  return undefined;
}

/** The collaborators the OTP rate-limit hook needs. */
export interface RateLimitHookDeps {
  /** The shared rate-limit port. */
  readonly rateLimiter: RateLimiter;
  /** The identity hash salt from the rate-limit configuration. */
  readonly salt: string;
}

/**
 * Build the `before`-hook function that enforces the OTP rate-limit classes.
 *
 * @param deps - The rate limiter and its hash salt.
 * @returns A hook function that throws a 429 `APIError` when a class is spent.
 */
export function createRateLimitHook(
  deps: RateLimitHookDeps
): (ctx: AuthHookContext) => Promise<void> {
  const { rateLimiter, salt } = deps;

  /** The 429 an OTP rate-limit denial (or a fail-closed limiter fault) throws. */
  const tooManyRequests = (): APIError =>
    APIError.from("TOO_MANY_REQUESTS", {
      message: "Too many requests. Try again later.",
      code: "too_many_requests",
    });

  /** Enforce one rate-limit class for a request, throwing 429 when denied. */
  const enforceRateLimit = async (
    classKey: "auth.otp" | "auth.verify",
    headers: unknown,
    body: Record<string, unknown>
  ): Promise<void> => {
    const ip =
      headers instanceof Headers ? resolveClientIp(headers, getTrustedClientIpHeader()) : undefined;
    const bodyContact = contactFromBody(body);
    // A verify request carries no contact on the two-factor path; the account is
    // identified by the pending challenge, so bucket those by client IP instead.
    const contact = bodyContact ?? (classKey === "auth.verify" ? ip : undefined);
    const evaluation = await evaluateRateLimit({
      classKey,
      facts: {
        ...(contact === undefined ? {} : { contact }),
        ...(ip === undefined ? {} : { ip }),
      },
      limiter: rateLimiter,
      salt,
    });
    if (evaluation.outcome !== "allowed") {
      throw tooManyRequests();
    }
  };

  /**
   * Enforce the complementary per-user cap on session-authenticated verifies
   * (`phone-number/verify`, `two-factor/verify-otp`).
   *
   * `auth.verify` deliberately does not count an authenticated verify
   * (ADR-0021 §1), so without this a session holder could guess codes without
   * bound. The budget is one shared, per-user (per-session) counter — rotating
   * the target contact must not reset it — and is consulted directly with an
   * explicit rule because the frozen rate-limit class table may not gain a
   * `user` rule for `auth.verify` (ADR-0023 §4). A denial, or an unavailable
   * limiter (fail-closed), is the same 429 envelope.
   */
  const enforceAuthenticatedVerifyCap = async (userId: string): Promise<void> => {
    let allowed = false;
    try {
      const result = await rateLimiter.limit(
        rateLimitKey("auth.verify", "user", hashIdentity(userId, salt)),
        { limit: AUTHENTICATED_VERIFY_LIMIT, windowSeconds: AUTHENTICATED_VERIFY_WINDOW_SECONDS }
      );
      allowed = result.success;
    } catch {
      // Fail closed: a limiter fault must not reopen the guessing surface.
      allowed = false;
    }
    if (!allowed) {
      throw tooManyRequests();
    }
  };

  return async (ctx: AuthHookContext): Promise<void> => {
    const path = ctx.path;
    const body = bodyOf(ctx);

    if (OTP_SEND_PATHS.has(path)) {
      await enforceRateLimit("auth.otp", ctx.headers, body);
    } else if (OTP_VERIFY_PATHS.has(path)) {
      const session = await getSessionFromCtx(ctx);
      if (!session) {
        await enforceRateLimit("auth.verify", ctx.headers, body);
      } else if (AUTHENTICATED_VERIFY_PATHS.has(path)) {
        await enforceAuthenticatedVerifyCap(session.user.id);
      }
    }
  };
}
