import { APIError, getSessionFromCtx } from "better-auth/api";

import { type AuthHookContext, bodyOf } from "./internal";

/**
 * The phone-number leg of the `before` hook (OP-85, contract §1.1
 * `phoneNumber` plugin).
 *
 * Two distinct policies live on the phone endpoints:
 *
 *   - **Anonymous `send-otp`** is allowed only for an existing, *verified*
 *     user. A caller who is not signed in and asks for a code for a number that
 *     is unknown or unverified is refused (403), so the endpoint can never be
 *     used to enumerate numbers.
 *   - **Authenticated `verify`** binds the new number to the signed-in user.
 *     Better Auth only performs the bind when `updatePhoneNumber` is set, so the
 *     hook rewrites the body to set it. An unauthenticated verify is left
 *     untouched — `signUpOnVerification` stays off, so it can never materialise
 *     an account.
 */

/**
 * Run the phone-number policy for a request.
 *
 * @param ctx - The hook context.
 * @returns The body rewrite for an authenticated `/phone-number/verify`, or
 *   `undefined` for every other case.
 * @throws APIError 403 `phone_not_verified` for an anonymous send-otp to a
 *   number that is not a verified user's.
 */
export async function runPhoneHook(ctx: AuthHookContext): Promise<unknown> {
  const path = ctx.path;
  const body = bodyOf(ctx);

  if (path === "/phone-number/send-otp") {
    const session = await getSessionFromCtx(ctx);
    if (!session) {
      const value = body.phoneNumber;
      const user =
        typeof value === "string"
          ? await ctx.context.adapter.findOne<{ phoneNumberVerified?: boolean }>({
              model: "user",
              where: [{ field: "phoneNumber", value }],
            })
          : undefined;
      if (user?.phoneNumberVerified !== true) {
        throw APIError.from("FORBIDDEN", {
          message: "A verified phone number is required to sign in by phone.",
          code: "phone_not_verified",
        });
      }
    }
  }

  if (path === "/phone-number/verify") {
    const session = await getSessionFromCtx(ctx);
    if (session) {
      // The authenticated flow verifies and *binds* a new number to the
      // signed-in user; Better Auth only does so when `updatePhoneNumber` is
      // set.
      return { context: { body: { ...body, updatePhoneNumber: true } } };
    }

    // Anonymous verify: only an existing user's number has anything to verify.
    // A number with no user would otherwise fall through to Better Auth's
    // "failed to update user" branch and surface an internal `500` (I16). Fail
    // with the *same* generic client error a wrong code produces
    // (`400 INVALID_OTP` / "Invalid OTP"), so the response does not reveal
    // whether the number has an account (I20).
    const value = body.phoneNumber;
    const user =
      typeof value === "string"
        ? await ctx.context.adapter.findOne<{ phoneNumber?: string }>({
            model: "user",
            where: [{ field: "phoneNumber", value }],
          })
        : undefined;
    if (user === undefined || user === null) {
      throw APIError.from("BAD_REQUEST", {
        message: "Invalid OTP",
        code: "INVALID_OTP",
      });
    }
  }

  return undefined;
}
