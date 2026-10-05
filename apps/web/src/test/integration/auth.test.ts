import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient } from "@/server/db/mongo";

import { makeEnv, toProcessEnv } from "../factories/env";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  authPost,
  body,
  cookiePair,
  hasCookieAttribute,
  sessionCookie,
  setCookies,
} from "../helpers/auth-requests";

/**
 * Integration / contract — the OpenPic Better Auth surface (OP-85, contract
 * §1.1 "Better Auth surface").
 *
 * Every spec drives the configured auth instance through its HTTP handler
 * (`auth.handler(request)`) — the library's documented server entry point — and
 * asserts only what a client or a DB reader can observe: HTTP status, the
 * session cookie, the captured OTP channel, and the persisted auth documents.
 * Nothing here reaches into plugin internals, so a legitimate refactor of the
 * config (a hook moved, a plugin version bumped) cannot break a spec while the
 * behaviour is unchanged.
 *
 * Contract expected of the implementation
 *   - `@/server/auth` exports `createAuth({ db }): AuthLike` (plus the
 *     process singleton `auth`), wiring the `emailOTP`, `phoneNumber`,
 *     `twoFactor` and `admin` plugins, `trustedOrigins` from `ALLOWED_ORIGINS`,
 *     the `__Secure-` cookie policy from `buildCookieOptions`, and the
 *     `auth.otp` / `auth.verify` rate-limit classes.
 *   - `@/server/auth/otp-inbox` exports the process-level `otpInbox` the auth
 *     config records every delivered OTP into:
 *       record({ channel, to, code }); list(); take(channel, to); clear()
 *     Email OTPs are recorded with channel `email`; phone/SMS OTPs — including
 *     the two-factor one-time code — with channel `sms` (notification §4.1:
 *     `auth.otp.mobile.requested` is pinned to `sms`, never the `mobile` group).
 *
 * Better Auth route surface exercised (contract §1.1):
 *   POST /api/auth/email-otp/send-verification-otp   { email, type }
 *   POST /api/auth/sign-in/email-otp                 { email, otp, callbackURL? }
 *   POST /api/auth/phone-number/send-otp             { phoneNumber }
 *   POST /api/auth/phone-number/verify               { phoneNumber, otp }
 *   POST /api/auth/two-factor/enable                 (authenticated)
 *   POST /api/auth/two-factor/verify-otp             { code }
 */

const APP_ORIGIN = "http://localhost:3000";
const EMAIL = "rahul@example.com";
const OTHER_EMAIL = "ada@example.com";
const PHONE = "+919876543210";
const WRONG_OTP = "000000";
const EVIL_CALLBACK = "https://evil.example/after";

/** Local structural mirrors of the inbox contract. */
type OtpChannel = "email" | "sms";
interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

beforeAll(() => {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet"
    );
  }

  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: uri,
        RATE_LIMIT_PROVIDER: "memory",
        MESSAGE_TRANSPORT: "memory",
      })
    )
  );
});

afterAll(async () => {
  await closeMongoClient();
});

beforeEach(() => {
  otpInbox.clear();
});

/** A throwaway auth instance bound to a throwaway database. */
interface Harness {
  readonly auth: AuthLike;
  readonly database: Db;
}

/** Run `fn` against a fresh database and a fresh auth instance, then drop it. */
async function withAuth(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const test: TestDb = createTestDb("openpic_auth");
  try {
    const auth = createAuth({ db: test.db });
    await fn({ auth, database: test.db });
  } finally {
    await test.cleanup();
  }
}

/** The captured OTP, failing loudly when the transport recorded none. */
function requireOtp(channel: OtpChannel, to: string): CapturedOtp {
  const otp = otpInbox.take(channel, to) as CapturedOtp | undefined;
  if (otp === undefined) {
    throw new Error(`expected an OTP captured for ${channel}:${to}, got none`);
  }
  return otp;
}

/** A `Cookie:` header carrying every cookie the response set. */
function cookieHeader(response: Response): string {
  return setCookies(response).map(cookiePair).join("; ");
}

/** An authenticated POST: forward the session cookie captured at sign-in. */
function authPostWithCookie(
  auth: AuthLike,
  path: string,
  cookie: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return authPost(auth, APP_ORIGIN, path, payload, { cookie });
}

/** Send an email OTP and return the captured code. */
async function sendEmailOtp(auth: AuthLike, email: string): Promise<CapturedOtp> {
  const response = await authPost(auth, APP_ORIGIN, "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  expect(response.status).toBe(200);
  return requireOtp("email", email);
}

/** Sign in with a valid email OTP; returns the response and the session cookie. */
async function signInWithEmailOtp(
  auth: AuthLike,
  email: string
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const otp = await sendEmailOtp(auth, email);
  const response = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
    email,
    otp: otp.code,
  });
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  if (cookie === undefined) {
    throw new Error("sign-in did not set a session cookie");
  }
  return { response, cookie: cookiePair(cookie) };
}

/** A user with a verified phone, signed in; returns the auth cookie. */
async function signUpWithVerifiedPhone(auth: AuthLike): Promise<string> {
  const { cookie } = await signInWithEmailOtp(auth, EMAIL);

  const sent = await authPostWithCookie(auth, "/api/auth/phone-number/send-otp", cookie, {
    phoneNumber: PHONE,
  });
  expect(sent.status).toBe(200);

  const otp = requireOtp("sms", PHONE);
  const verified = await authPostWithCookie(auth, "/api/auth/phone-number/verify", cookie, {
    phoneNumber: PHONE,
    otp: otp.code,
  });
  expect(verified.status).toBe(200);

  return cookie;
}

/** A user with 2FA enabled (requires a verified phone first). */
async function signUpWithTwoFactorEnabled(auth: AuthLike, database: Db): Promise<string> {
  const cookie = await signUpWithVerifiedPhone(auth);

  const enabled = await authPostWithCookie(auth, "/api/auth/two-factor/enable", cookie, {});
  expect(enabled.status).toBe(200);

  const otp = requireOtp("sms", PHONE);
  const confirmed = await authPostWithCookie(auth, "/api/auth/two-factor/verify-otp", cookie, {
    code: otp.code,
  });
  expect(confirmed.status).toBe(200);

  const user = await database.collection("user").findOne({ email: EMAIL });
  expect(user?.twoFactorEnabled).toBe(true);

  otpInbox.clear();
  return cookie;
}

describe("email OTP sign-in (§1.1)", () => {
  it("I1: send → sign in creates a session and sets an HttpOnly SameSite=Lax cookie", async () => {
    await withAuth(async ({ auth, database }) => {
      const otp = await sendEmailOtp(auth, EMAIL);

      expect(otp.channel).toBe("email");
      expect(otp.to).toBe(EMAIL);
      expect(otp.code).toMatch(/^\d{6}$/);

      const response = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
        email: EMAIL,
        otp: otp.code,
      });

      expect(response.status).toBe(200);

      const header = sessionCookie(response);
      if (header === undefined) {
        throw new Error("expected a better-auth session cookie");
      }
      expect(hasCookieAttribute(header, "HttpOnly")).toBe(true);
      expect(hasCookieAttribute(header, "SameSite=Lax")).toBe(true);
      expect(hasCookieAttribute(header, "Path=/")).toBe(true);
      // APP_ENV=test is not TLS, so the cookie must not be Secure-only.
      expect(hasCookieAttribute(header, "Secure")).toBe(false);

      expect(await database.collection("user").countDocuments({ email: EMAIL })).toBe(1);
      expect(await database.collection("session").countDocuments({})).toBeGreaterThan(0);
    });
  });
});

describe("OTP send rate limiting (§0.11 auth.otp)", () => {
  it("I2: the 6th email OTP send for the same contact within the hour returns 429", async () => {
    await withAuth(async ({ auth }) => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/email-otp/send-verification-otp",
          { email: OTHER_EMAIL, type: "sign-in" }
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    });
  });
});

describe("OTP verify lockout (§0.11 auth.verify)", () => {
  it("I3: ten wrong OTP verifies lock the contact out; the 11th returns 429", async () => {
    await withAuth(async ({ auth }) => {
      await sendEmailOtp(auth, OTHER_EMAIL);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
          email: OTHER_EMAIL,
          otp: WRONG_OTP,
        });
        statuses.push(response.status);
        expect(sessionCookie(response), "a wrong OTP must never mint a session").toBeUndefined();
      }

      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});

describe("phone OTP (§1.1 phoneNumber plugin)", () => {
  it("I4: verifying a phone OTP sets phoneNumberVerified on the user", async () => {
    await withAuth(async ({ auth, database }) => {
      const cookie = await signUpWithVerifiedPhone(auth);

      // The helper already asserted the verify call succeeded; pin the effect.
      const user = await database.collection("user").findOne({ email: EMAIL });
      expect(user?.phoneNumber).toBe(PHONE);
      expect(user?.phoneNumberVerified).toBe(true);

      // The OTP left the server by SMS, never by email.
      expect(cookie.length).toBeGreaterThan(0);
      expect(otpInbox.list().some((entry) => entry.channel === "email" && entry.to === PHONE)).toBe(
        false
      );
    });
  });

  it("I9: a phone OTP for an unknown number is rejected and creates no user", async () => {
    await withAuth(async ({ auth, database }) => {
      const response = await authPost(auth, APP_ORIGIN, "/api/auth/phone-number/send-otp", {
        phoneNumber: PHONE,
      });

      expect(response.status).toBe(403);
      expect(await database.collection("user").countDocuments({ phoneNumber: PHONE })).toBe(0);
      expect(otpInbox.list()).toHaveLength(0);
    });
  });

  it("I10: an unauthenticated phone OTP for a user with an unverified phone is rejected", async () => {
    await withAuth(async ({ auth, database }) => {
      // A real user document (created by the adapter) whose phone is not yet
      // verified — the state a user is in before I4's verification step.
      await signInWithEmailOtp(auth, OTHER_EMAIL);
      await database
        .collection("user")
        .updateOne(
          { email: OTHER_EMAIL },
          { $set: { phoneNumber: PHONE, phoneNumberVerified: false } }
        );

      otpInbox.clear();

      const response = await authPost(auth, APP_ORIGIN, "/api/auth/phone-number/send-otp", {
        phoneNumber: PHONE,
      });

      expect(response.status).toBe(403);
      expect(otpInbox.list()).toHaveLength(0);
    });
  });
});

describe("two-factor (§1.1 twoFactor plugin)", () => {
  it("I5: enabling 2FA with a verified phone sets twoFactorEnabled", async () => {
    await withAuth(async ({ auth, database }) => {
      await signUpWithTwoFactorEnabled(auth, database);

      const user = await database.collection("user").findOne({ email: EMAIL });
      expect(user?.twoFactorEnabled).toBe(true);
    });
  });

  it("I6: enabling 2FA without a verified phone is rejected", async () => {
    await withAuth(async ({ auth, database }) => {
      const { cookie } = await signInWithEmailOtp(auth, EMAIL);

      const response = await authPostWithCookie(auth, "/api/auth/two-factor/enable", cookie, {});

      expect(response.status).toBe(403);

      const user = await database.collection("user").findOne({ email: EMAIL });
      expect(user?.twoFactorEnabled).not.toBe(true);
    });
  });

  it("I7: with 2FA on, email-OTP sign-in is two-factor pending with no session until the SMS OTP is verified", async () => {
    await withAuth(async ({ auth, database }) => {
      await signUpWithTwoFactorEnabled(auth, database);

      const emailOtp = await sendEmailOtp(auth, EMAIL);
      const pending = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
        email: EMAIL,
        otp: emailOtp.code,
      });

      expect(pending.status).toBe(200);
      expect(await body(pending)).toMatchObject({ twoFactorRedirect: true });
      expect(sessionCookie(pending), "no session cookie before 2FA is verified").toBeUndefined();

      // The one-time code went out by SMS, not email (§4.1 pin).
      const smsOtp = requireOtp("sms", PHONE);
      expect(smsOtp.channel).toBe("sms");

      const verified = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/two-factor/verify-otp",
        { code: smsOtp.code },
        { cookie: cookieHeader(pending) }
      );

      expect(verified.status).toBe(200);
      expect(sessionCookie(verified), "verifying the SMS OTP mints the session").toBeDefined();
    });
  });

  it("I8: ten wrong 2FA codes lock the challenge out; the 11th returns 429", async () => {
    await withAuth(async ({ auth, database }) => {
      await signUpWithTwoFactorEnabled(auth, database);

      const emailOtp = await sendEmailOtp(auth, EMAIL);
      const pending = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
        email: EMAIL,
        otp: emailOtp.code,
      });
      expect(pending.status).toBe(200);
      const pendingCookies = cookieHeader(pending);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/two-factor/verify-otp",
          { code: WRONG_OTP },
          { cookie: pendingCookies }
        );
        statuses.push(response.status);
        expect(
          sessionCookie(response),
          "a wrong 2FA code must never mint a session"
        ).toBeUndefined();
      }

      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});

describe("callback URL trust (§1.1 trustedOrigins)", () => {
  it("I11: a sign-in callbackURL outside trustedOrigins is rejected and mints no session", async () => {
    await withAuth(async ({ auth }) => {
      const otp = await sendEmailOtp(auth, EMAIL);

      const response = await authPost(auth, APP_ORIGIN, "/api/auth/sign-in/email-otp", {
        email: EMAIL,
        otp: otp.code,
        callbackURL: EVIL_CALLBACK,
      });

      expect(response.status).toBe(403);
      expect(sessionCookie(response)).toBeUndefined();
    });
  });
});

describe("test-only OTP route", () => {
  it.each(["development", "staging", "production"])(
    "U2: GET /api/v1/__test__/otp returns 404 when APP_ENV=%s",
    async (env) => {
      const previous = process.env.APP_ENV;
      process.env.APP_ENV = env;
      try {
        const { GET } = await import("@/app/api/v1/__test__/otp/route");
        const response = await GET(
          new Request(
            `${APP_ORIGIN}/api/v1/__test__/otp?contact=${encodeURIComponent(EMAIL)}&channel=email`
          )
        );

        expect(response.status).toBe(404);
      } finally {
        process.env.APP_ENV = previous;
      }
    }
  );

  it("U2: GET /api/v1/__test__/otp answers 200 in test so the harness can read a code", async () => {
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = "test";
    try {
      otpInbox.record({ channel: "email", to: EMAIL, code: "123456" });
      const { GET } = await import("@/app/api/v1/__test__/otp/route");
      const response = await GET(
        new Request(
          `${APP_ORIGIN}/api/v1/__test__/otp?contact=${encodeURIComponent(EMAIL)}&channel=email`
        )
      );

      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({ code: "123456" });
    } finally {
      process.env.APP_ENV = previous;
    }
  });
});
