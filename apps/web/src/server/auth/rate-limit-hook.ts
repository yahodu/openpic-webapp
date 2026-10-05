import { APIError, getSessionFromCtx } from "better-auth/api";

import { evaluateRateLimit, type RateLimiter } from "@/server/rate-limit";

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
 * protect even begins.
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

/** The client IP the rate limiter buckets on (first `x-forwarded-for` hop). */
function clientIp(headers: unknown): string | undefined {
  if (!(headers instanceof Headers)) {
    return undefined;
  }
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") {
      return first;
    }
  }
  const real = headers.get("x-real-ip");
  return real === null || real === "" ? undefined : real;
}

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

  /** Enforce one rate-limit class for a request, throwing 429 when denied. */
  const enforceRateLimit = async (
    classKey: "auth.otp" | "auth.verify",
    headers: unknown,
    body: Record<string, unknown>
  ): Promise<void> => {
    const ip = clientIp(headers);
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
      throw APIError.from("TOO_MANY_REQUESTS", {
        message: "Too many requests. Try again later.",
        code: "too_many_requests",
      });
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
      }
    }
  };
}
