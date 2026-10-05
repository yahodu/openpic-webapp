import type { Db } from "mongodb";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { twoFactor } from "better-auth/plugins/two-factor";

import {
  getConfig,
  getRateLimitConfig,
  getSessionTtlSeconds,
  type AppConfig,
} from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { createRateLimiter } from "@/server/rate-limit";

import { assertTrustedCallback } from "./callback-url";
import { buildCookieOptions } from "./cookies";
import { OTP_LENGTH } from "./internal";
import { memoryOtpSender } from "./otp-sender";
import { runPhoneHook } from "./phone-hook";
import { createRateLimitHook } from "./rate-limit-hook";
import { runTwoFactorAfterHook, runTwoFactorBeforeHook } from "./two-factor";

/**
 * The OpenPic Better Auth instance (OP-85, contract §1.1 "Better Auth surface").
 *
 * The whole surface is library-owned: Better Auth is mounted at
 * `/api/auth/[...all]` and this module only *configures* it. Everything that is
 * an OpenPic policy rather than a Better Auth default is expressed as a Better
 * Auth hook (never a hand-rolled auth handler):
 *
 *   - **Cookies** — `advanced.useSecureCookies` / `cookiePrefix` come from
 *     {@link buildCookieOptions} so a local/e2e run gets a browser-usable cookie
 *     and a TLS deploy gets `__Secure-`.
 *   - **Origins** — `trustedOrigins` is the validated `ALLOWED_ORIGINS`; a
 *     sign-in `callbackURL` outside it is rejected (403) and mints no session.
 *   - **Rate limits** — the `auth.otp` / `auth.verify` classes from the
 *     rate-limit port guard OTP send and verify; Better Auth's own limiter is
 *     disabled so the two do not compound.
 *   - **Phone rules** — an anonymous phone `send-otp` is allowed only for an
 *     existing, verified user (no number enumeration); `signUpOnVerification`
 *     stays off, so a verify can never materialise an account.
 *   - **2FA** — enabling requires a verified phone and sends its one-time code
 *     by SMS; a sign-in with 2FA on is `twoFactorRedirect` with no session until
 *     the SMS code is verified; disabling needs a fresh SMS code.
 *   - **OTP logging** — every delivered code goes through the `OtpSender` port,
 *     which records it to the process inbox and logs only a hashed contact.
 *
 * Each policy leg lives in its own focused module (`rate-limit-hook.ts`,
 * `callback-url.ts`, `phone-hook.ts`, `two-factor.ts`); this file only composes
 * them into the two global middleware Better Auth allows.
 *
 * The `AuthLike` structural view (a single `handler`) is what the specs drive,
 * so they never import Better Auth types and a config refactor cannot break
 * them while the observable behaviour holds.
 */

/** The HTTP surface the specs and the Next route handler depend on. */
export interface AuthLike {
  handler(request: Request): Promise<Response>;
}

/** Options accepted by {@link createAuth}. */
export interface CreateAuthOptions {
  /** The MongoDB database the adapter writes auth collections to. */
  readonly db: Db;
}

/**
 * Build the configured Better Auth instance bound to a database.
 *
 * @param options - The database the adapter writes auth collections to.
 * @returns The {@link AuthLike} wrapper over the Better Auth handler.
 */
export function createAuth(options: CreateAuthOptions): AuthLike {
  const config: AppConfig = getConfig();
  const sender = memoryOtpSender();
  const rateLimiter = createRateLimiter();
  const salt = getRateLimitConfig().salt;
  const trustedOrigins: readonly string[] = config.app.allowedOrigins;
  const cookieOptions = buildCookieOptions(config.app.env);

  const rateLimitHook = createRateLimitHook({ rateLimiter, salt });

  const before = createAuthMiddleware(async (ctx) => {
    await rateLimitHook(ctx);

    assertTrustedCallback(ctx, trustedOrigins);

    const phoneResult = await runPhoneHook(ctx);
    if (phoneResult !== undefined) {
      return phoneResult;
    }

    const twoFactorResult = await runTwoFactorBeforeHook(ctx, sender);
    if (twoFactorResult !== undefined) {
      return twoFactorResult;
    }

    return undefined;
  });

  const after = createAuthMiddleware(async (ctx) => runTwoFactorAfterHook(ctx, sender));

  const instance = betterAuth({
    appName: "OpenPic",
    baseURL: config.app.baseUrl,
    secret: config.auth.secret,
    database: mongodbAdapter(options.db),
    trustedOrigins: [...trustedOrigins],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: getSessionTtlSeconds(),
      /**
       * Whether *this session* passed the second factor (ADR-0023 §4).
       *
       * Better Auth 1.7.7 keeps no per-session 2FA fact, and `user.twoFactorEnabled`
       * alone cannot distinguish an admin session that enrolled 2FA (I8) from a
       * session minted earlier (I6) or a phone-OTP first-factor sign-in (I7).
       * The field is server-owned (`input: false`) and set on the verify path by
       * the two-factor hook.
       */
      additionalFields: {
        twoFactorVerified: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    advanced: {
      useSecureCookies: cookieOptions.useSecureCookies,
      cookiePrefix: cookieOptions.cookiePrefix,
      defaultCookieAttributes: {
        httpOnly: cookieOptions.httpOnly,
        sameSite: cookieOptions.sameSite,
        path: cookieOptions.path,
      },
    },
    // OpenPic owns abuse control for the auth surface (`auth.otp`/`auth.verify`);
    // Better Auth's own window would compound with it and fire early.
    rateLimit: { enabled: false },
    hooks: { before, after },
    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        sendVerificationOTP: ({ email, otp }) => {
          sender.send({ channel: "email", to: email, code: otp });
          return Promise.resolve();
        },
      }),
      phoneNumber({
        otpLength: OTP_LENGTH,
        sendOTP: ({ phoneNumber: phone, code }) => {
          sender.send({ channel: "sms", to: phone, code });
        },
        // `signUpOnVerification` is intentionally omitted: verifying a number
        // must never create an account (ADR-0020 §11).
      }),
      twoFactor({
        totpOptions: { disable: true },
        otpOptions: {
          sendOTP: ({ user, otp }) => {
            const phone = (user as { phoneNumber?: string }).phoneNumber;
            if (typeof phone === "string") {
              sender.send({ channel: "sms", to: phone, code: otp });
            }
          },
        },
      }),
      admin(),
      // Mobile clients authenticate with `Authorization: Bearer <session token>`
      // (contract §0.3); the plugin converts that header into a session and
      // exposes the token on the sign-in response as `set-auth-token`. The guard
      // resolver relies on both (ADR-0023 §3).
      bearer(),
    ],
  });

  return {
    handler: (request: Request) => instance.handler(request),
  };
}

/** The process-wide auth instance, built lazily so importing is side-effect free. */
let singleton: AuthLike | undefined;

/**
 * Return the process-wide auth instance, building it on first use.
 *
 * @returns The configured {@link AuthLike} singleton.
 */
export function getAuth(): AuthLike {
  singleton ??= createAuth({ db: getDb() });
  return singleton;
}

/**
 * The singleton exported for the route handler. The facade defers building the
 * underlying instance until the first request, so merely importing this module
 * (e.g. from a unit test) never validates the environment.
 */
export const auth: AuthLike = {
  handler: (request: Request) => getAuth().handler(request),
};
