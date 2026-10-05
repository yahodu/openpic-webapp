import { randomInt, randomUUID } from "node:crypto";

import type { Db } from "mongodb";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
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
import { createRateLimiter, evaluateRateLimit } from "@/server/rate-limit";

import { buildCookieOptions } from "./cookies";
import { memoryOtpSender, type OtpSender } from "./otp-sender";

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
 *   - **OTP logging** — every delivered code goes through the {@link OtpSender}
 *     port, which records it to the process inbox and logs only a hashed
 *     contact.
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

/** OTP length for every channel (email, SMS, two-factor). */
const OTP_LENGTH = 6;

/** Lifetime of a one-time code, in milliseconds. */
const OTP_TTL_MS = 5 * 60 * 1000;

/** Lifetime of a pending two-factor challenge (Better Auth's default), seconds. */
const TWO_FACTOR_COOKIE_MAX_AGE_SECONDS = 600;

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

/** The `internalAdapter` surface the hooks use, kept structural for reuse. */
interface InternalAdapterLike {
  updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
  consumeVerificationValue(identifier: string): Promise<{ value?: string | null } | null>;
  deleteSession(token: string): Promise<unknown>;
}

/** A generated, uniformly distributed numeric OTP, zero-padded to length. */
function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** Monotonic-ish unique id for a two-factor challenge identifier. */
function challengeId(): string {
  return `2fa-${randomUUID().replace(/-/g, "")}`;
}

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

  const before = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    const body: Record<string, unknown> =
      typeof ctx.body === "object" && ctx.body !== null
        ? (ctx.body as Record<string, unknown>)
        : {};

    if (OTP_SEND_PATHS.has(path)) {
      await enforceRateLimit("auth.otp", ctx.headers, body);
    } else if (OTP_VERIFY_PATHS.has(path)) {
      // `auth.verify` protects credential verification during sign-in. An
      // already-authenticated verify (binding a phone, or the enable-flow's
      // one-time code) is not a sign-in credential check, so it is not counted —
      // otherwise it would spend the caller's sign-in budget before the
      // challenge it is meant to protect even begins.
      const session = await getSessionFromCtx(ctx);
      if (!session) {
        await enforceRateLimit("auth.verify", ctx.headers, body);
      }
    }

    const callbackURL = body.callbackURL;
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
    }

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
      const code = typeof body.code === "string" ? body.code : undefined;
      if (code === undefined || code === "") {
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
  });

  const after = createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-in/email-otp") {
      return;
    }
    const data = ctx.context.newSession;
    if (!data) {
      return;
    }
    const user = data.user as {
      id: string;
      phoneNumber?: string;
      twoFactorEnabled?: boolean;
    };
    if (user.twoFactorEnabled !== true) {
      return;
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
  });

  const instance = betterAuth({
    appName: "OpenPic",
    baseURL: config.app.baseUrl,
    secret: config.auth.secret,
    database: mongodbAdapter(options.db),
    trustedOrigins: [...trustedOrigins],
    emailAndPassword: { enabled: false },
    session: { expiresIn: getSessionTtlSeconds() },
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
