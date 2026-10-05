import { randomInt, randomUUID } from "node:crypto";

import { APIError, getSessionFromCtx } from "better-auth/api";

import {
  type AuthHookContext,
  bodyOf,
  type InternalAdapterLike,
  OTP_LENGTH,
  OTP_TTL_MS,
  TWO_FACTOR_COOKIE_MAX_AGE_SECONDS,
} from "./internal";
import type { OtpSender } from "./otp-sender";

/**
 * The two-factor leg of the `before` and `after` hooks (OP-85, contract §1.1
 * `twoFactor` plugin).
 *
 *   - **Enable** requires a signed-in user with a verified phone; it flips
 *     `twoFactorEnabled` and sends the one-time code by SMS.
 *   - **Disable** requires a fresh SMS code: a missing or wrong code is refused
 *     (4xx) and leaves 2FA on; a matching code clears the flag and the stored
 *     factor.
 *   - **Sign-in conversion** (the `after` hook): the email-OTP endpoint mints a
 *     full session *before* the second factor is checked, so on a 2FA account
 *     the hook converts that session into a pending two-factor challenge — no
 *     session cookie, no persisted session, and an SMS code to complete with.
 */

/** A generated, uniformly distributed numeric OTP, zero-padded to length. */
function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** Monotonic-ish unique id for a two-factor challenge identifier. */
function challengeId(): string {
  return `2fa-${randomUUID().replace(/-/g, "")}`;
}

/**
 * Issue a one-time SMS code for a two-factor challenge and record it under the
 * `2fa-otp-<key>` identifier Better Auth's OTP verifier consumes.
 *
 * @param adapter - The auth internal adapter (verification store).
 * @param sender - The OTP port.
 * @param key - The challenge key (`<userId>!<sessionId>` or the pending cookie).
 * @param phone - The verified E.164 phone number to deliver to.
 */
async function issueTwoFactorCode(
  adapter: InternalAdapterLike,
  sender: OtpSender,
  key: string,
  phone: string
): Promise<void> {
  const code = generateOtp();
  await adapter.createVerificationValue({
    identifier: `2fa-otp-${key}`,
    value: `${code}:0`,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  sender.send({ channel: "sms", to: phone, code });
}

/**
 * Consume and compare the stored two-factor code for a challenge key.
 *
 * @returns `true` when the supplied code matches the stored one.
 */
async function consumeTwoFactorCode(
  adapter: InternalAdapterLike,
  key: string,
  code: string
): Promise<boolean> {
  const consumed = await adapter.consumeVerificationValue(`2fa-otp-${key}`).catch(() => null);
  if (consumed === null || typeof consumed.value !== "string") {
    return false;
  }
  const [stored] = consumed.value.split(":");
  return stored === code;
}

/**
 * Run the two-factor policy for a request.
 *
 * @param ctx - The hook context.
 * @param sender - The OTP port used to deliver the enable-flow code.
 * @returns The enable/disable JSON response, or `undefined` for every other
 *   path.
 * @throws APIError 401 when not signed in, 403 for an unverified phone, and
 *   400 for a missing or wrong disable code.
 */
export async function runTwoFactorBeforeHook(
  ctx: AuthHookContext,
  sender: OtpSender
): Promise<unknown> {
  const path = ctx.path;

  if (path === "/two-factor/enable") {
    const session = await getSessionFromCtx(ctx);
    if (!session) {
      throw APIError.from("UNAUTHORIZED", {
        message: "You must be signed in to enable two-factor authentication.",
        code: "unauthorized",
      });
    }
    const user = session.user as {
      id: string;
      phoneNumber?: string;
      phoneNumberVerified?: boolean;
    };
    if (user.phoneNumberVerified !== true || typeof user.phoneNumber !== "string") {
      throw APIError.from("FORBIDDEN", {
        message: "A verified phone number is required to enable two-factor authentication.",
        code: "phone_not_verified",
      });
    }
    await ctx.context.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    await issueTwoFactorCode(
      ctx.context.internalAdapter,
      sender,
      `${user.id}!${session.session.id}`,
      user.phoneNumber
    );
    return ctx.json({ method: "otp" });
  }

  if (path === "/two-factor/disable") {
    const session = await getSessionFromCtx(ctx);
    if (!session) {
      throw APIError.from("UNAUTHORIZED", {
        message: "You must be signed in to disable two-factor authentication.",
        code: "unauthorized",
      });
    }
    const code = bodyOf(ctx).code;
    if (typeof code !== "string" || code === "") {
      throw APIError.from("BAD_REQUEST", {
        message: "A fresh one-time code is required to disable two-factor authentication.",
        code: "code_required",
      });
    }
    const verified = await consumeTwoFactorCode(
      ctx.context.internalAdapter,
      `${session.user.id}!${session.session.id}`,
      code
    );
    if (!verified) {
      throw APIError.from("BAD_REQUEST", { message: "Invalid code.", code: "invalid_code" });
    }
    await ctx.context.internalAdapter.updateUser(session.user.id, { twoFactorEnabled: false });
    await ctx.context.adapter.delete({
      model: "twoFactor",
      where: [{ field: "userId", value: session.user.id }],
    });
    return ctx.json({ status: true });
  }

  return undefined;
}

/**
 * Convert a full session minted by the email-OTP endpoint into a pending
 * two-factor challenge when the signing-in user has 2FA enabled.
 *
 * @param ctx - The `after` hook context.
 * @param sender - The OTP port used to deliver the challenge code.
 * @returns The pending-challenge JSON response that overrides the endpoint's
 *   session response, or `undefined` for every other path.
 */
export async function runTwoFactorAfterHook(
  ctx: AuthHookContext,
  sender: OtpSender
): Promise<unknown> {
  if (ctx.path !== "/sign-in/email-otp") {
    return undefined;
  }
  const data = ctx.context.newSession;
  if (!data) {
    return undefined;
  }
  const user = data.user as {
    id: string;
    phoneNumber?: string;
    twoFactorEnabled?: boolean;
  };
  if (user.twoFactorEnabled !== true) {
    return undefined;
  }

  // The email-OTP endpoint mints a full session before the second factor is
  // checked; convert it into a pending two-factor challenge instead: no
  // session cookie, no persisted session, and an SMS code to complete with.
  // `ctx.context.responseHeaders` is the live headers the endpoint built, so
  // clearing `set-cookie` there drops the session cookie for good.
  ctx.context.responseHeaders?.delete("set-cookie");
  await ctx.context.internalAdapter.deleteSession(data.session.token);
  ctx.context.setNewSession(null);

  const cookie = ctx.context.createAuthCookie("two_factor", {
    maxAge: TWO_FACTOR_COOKIE_MAX_AGE_SECONDS,
  });
  const identifier = challengeId();
  const expiresAt = new Date(Date.now() + TWO_FACTOR_COOKIE_MAX_AGE_SECONDS * 1000);
  await ctx.context.internalAdapter.createVerificationValue({
    identifier,
    value: data.user.id,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: `2fa-attempts-${identifier}`,
    value: "0",
    expiresAt,
  });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);

  if (typeof user.phoneNumber === "string") {
    await issueTwoFactorCode(ctx.context.internalAdapter, sender, identifier, user.phoneNumber);
  }

  return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ["otp"] });
}
