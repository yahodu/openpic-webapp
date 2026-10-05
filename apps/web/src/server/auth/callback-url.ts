import { APIError } from "better-auth/api";

import { type AuthHookContext, bodyOf } from "./internal";

/**
 * The callback-URL trust leg of the `before` hook (OP-85, contract §1.1
 * `trustedOrigins`).
 *
 * `trustedOrigins` is the validated `ALLOWED_ORIGINS`. A sign-in request may
 * carry a `callbackURL` to bounce to; an absolute URL whose origin is outside
 * the allowlist is rejected (403) and mints no session, closing the open-
 * redirect / token-leak path.
 */

/** True when an absolute callback URL's origin is inside the trusted allowlist. */
function isTrustedCallback(callbackURL: string, allowedOrigins: readonly string[]): boolean {
  let origin: string;
  try {
    origin = new URL(callbackURL).origin;
  } catch {
    // A relative callbackURL resolves against the deployment base URL, which is
    // itself trusted, so it is always allowed.
    return true;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Reject a `callbackURL` that points outside the trusted origins.
 *
 * @param ctx - The hook context.
 * @param trustedOrigins - The validated `ALLOWED_ORIGINS`.
 * @throws APIError 403 `untrusted_callback_url` when the URL is not trusted.
 */
export function assertTrustedCallback(
  ctx: AuthHookContext,
  trustedOrigins: readonly string[]
): void {
  const callbackURL = bodyOf(ctx).callbackURL;
  if (
    typeof callbackURL === "string" &&
    callbackURL !== "" &&
    !isTrustedCallback(callbackURL, trustedOrigins)
  ) {
    throw APIError.from("FORBIDDEN", {
      message: "The callback URL is not in the trusted origins list.",
      code: "untrusted_callback_url",
    });
  }
}
