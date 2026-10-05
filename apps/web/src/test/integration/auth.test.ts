import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient } from "@/server/db/mongo";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "@/server/logging";

import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";
import { expectNoSecretsInLogs } from "../helpers/log-assertions";
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
 * session cookie, the captured OTP channel, the persisted auth documents and
 * the emitted log entries. Nothing here reaches into plugin internals, so a
 * legitimate refactor of the config (a hook moved, a plugin version bumped)
 * cannot break a spec while the behaviour is unchanged.
 *
 * ## Test isolation (reviewer round 1, High)
 *
 * `withAuth` gives each spec a throwaway database and a fresh auth instance,
 * but the rate limiter (`createRateLimiter()`) is a **process-wide memoised
 * singleton**, so `auth.otp`/`auth.verify` counters accumulate across specs
 * that share a contact or an IP. Every spec therefore mints its own
 * `makeIdentity()` — a dedicated email, phone number **and** `x-forwarded-for`
 * IP — so no two specs share a limiter bucket. A spec that must exceed a limit
 * (I2/I3/I8) does so only on its own private identity.
 *
 * ## Contract expected of the implementation
 *
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
 *   - An OTP send emits an `info` log with `event: "auth.otp.sent"`,
 *     `channel` (`email`|`sms`) and a **hashed** `contact` — never the raw
 *     email/phone and never the generated code (I12).
 *
 * Better Auth route surface exercised (contract §1.1):
 *   POST /api/auth/email-otp/send-verification-otp   { email, type }
 *   POST /api/auth/sign-in/email-otp                 { email, otp, callbackURL? }
 *   POST /api/auth/phone-number/send-otp             { phoneNumber }
 *   POST /api/auth/phone-number/verify               { phoneNumber, code }
 *   POST /api/auth/two-factor/enable                 (authenticated)
 *   POST /api/auth/two-factor/send-otp               (authenticated)
 *   POST /api/auth/two-factor/verify-otp             { code }
 *   POST /api/auth/two-factor/disable                { code }
 */

const APP_ORIGIN = "http://localhost:3000";
const WRONG_OTP = "000000";
const EVIL_CALLBACK = "https://evil.example/after";

/**
 * How many session-authenticated verify attempts I19 is willing to drive before
 * giving up. This is a *probe bound*, not the cap: the card leaves the cap value
 * open for the orchestrator/human, and I19 only pins that a cap exists, is a
 * client error when hit, and is scoped per-user/per-session rather than per
 * contact. If the decided cap exceeds this bound the constant must be raised —
 * the spec does not invent the number.
 */
const AUTHENTICATED_VERIFY_PROBE_BOUND = 100;

/** Local structural mirrors of the inbox contract. */
type OtpChannel = "email" | "sms";
interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

/**
 * A per-spec identity: a dedicated email, phone number and client IP so no two
 * specs share a rate-limit bucket (see "Test isolation" above).
 */
interface Identity {
  readonly email: string;
  readonly phone: string;
  readonly ip: string;
}

let identitySeq = 0;

/**
 * E.164 pieces, assembled rather than written as one literal.
 *
 * The value must be a genuine E.164 number (`+<country><subscriber>`, here
 * `+91` + a 10-digit Indian mobile). It is deliberately composed from parts so
 * the digits are visible in review: a single contiguous `+91…` literal is
 * masked by the tooling's phone-number redaction (which hides the middle
 * digits), making it indistinguishable from the documentation redaction in
 * API Contract §0.13 that this test must NOT use.
 */
const PHONE_COUNTRY_CODE = "91";
const PHONE_SUBSCRIBER_PREFIX = "990000"; // Indian mobile prefix (valid 6–9 range)

/** Mint a unique contact + IP for one spec. */
function makeIdentity(): Identity {
  identitySeq += 1;
  const serial = String(identitySeq).padStart(4, "0");
  return {
    email: `op85-spec-${serial}@example.com`,
    phone: `+${PHONE_COUNTRY_CODE}${PHONE_SUBSCRIBER_PREFIX}${serial}`,
    ip: `203.0.113.${String(identitySeq)}`,
  };
}

beforeAll(async () => {
  await setupMongoTestEnv({
    APP_BASE_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: APP_ORIGIN,
    RATE_LIMIT_PROVIDER: "memory",
    MESSAGE_TRANSPORT: "memory",
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

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

/** Headers that pin the request to a spec's private rate-limit IP bucket. */
function forward(identity: Identity): Record<string, string> {
  return { "x-forwarded-for": identity.ip };
}

/** An authenticated POST: forward the session cookie and the spec's IP. */
function authPostWithCookie(
  auth: AuthLike,
  path: string,
  cookie: string,
  payload: Record<string, unknown>,
  identity: Identity
): Promise<Response> {
  return authPost(auth, APP_ORIGIN, path, payload, { cookie, ...forward(identity) });
}

/** Send an email OTP and return the captured code. */
async function sendEmailOtp(auth: AuthLike, identity: Identity): Promise<CapturedOtp> {
  const response = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/email-otp/send-verification-otp",
    { email: identity.email, type: "sign-in" },
    forward(identity)
  );
  expect(response.status).toBe(200);
  return requireOtp("email", identity.email);
}

/** Sign in with a valid email OTP; returns the response and the session cookie. */
async function signInWithEmailOtp(
  auth: AuthLike,
  identity: Identity
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const otp = await sendEmailOtp(auth, identity);
  const response = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/sign-in/email-otp",
    { email: identity.email, otp: otp.code },
    forward(identity)
  );
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  if (cookie === undefined) {
    throw new Error("sign-in did not set a session cookie");
  }
  return { response, cookie: cookiePair(cookie) };
}

/** A user with a verified phone, signed in; returns the auth cookie. */
async function signUpWithVerifiedPhone(auth: AuthLike, identity: Identity): Promise<string> {
  const { cookie } = await signInWithEmailOtp(auth, identity);

  const sent = await authPostWithCookie(
    auth,
    "/api/auth/phone-number/send-otp",
    cookie,
    { phoneNumber: identity.phone },
    identity
  );
  expect(sent.status).toBe(200);

  const otp = requireOtp("sms", identity.phone);
  const verified = await authPostWithCookie(
    auth,
    "/api/auth/phone-number/verify",
    cookie,
    { phoneNumber: identity.phone, code: otp.code },
    identity
  );
  expect(verified.status).toBe(200);

  return cookie;
}

/** A user with 2FA enabled (requires a verified phone first). */
async function signUpWithTwoFactorEnabled(
  auth: AuthLike,
  database: Db,
  identity: Identity
): Promise<string> {
  const cookie = await signUpWithVerifiedPhone(auth, identity);

  const enabled = await authPostWithCookie(
    auth,
    "/api/auth/two-factor/enable",
    cookie,
    {},
    identity
  );
  expect(enabled.status).toBe(200);

  const otp = requireOtp("sms", identity.phone);
  const confirmed = await authPostWithCookie(
    auth,
    "/api/auth/two-factor/verify-otp",
    cookie,
    { code: otp.code },
    identity
  );
  expect(confirmed.status).toBe(200);

  const user = await database.collection("user").findOne({ email: identity.email });
  expect(user?.twoFactorEnabled).toBe(true);

  otpInbox.clear();
  return cookie;
}

describe("email OTP sign-in (§1.1)", () => {
  it("I1: send → sign in creates a session and sets an HttpOnly SameSite=Lax cookie", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      const otp = await sendEmailOtp(auth, identity);

      expect(otp.channel).toBe("email");
      expect(otp.to).toBe(identity.email);
      expect(otp.code).toMatch(/^\d{6}$/);

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: otp.code },
        forward(identity)
      );

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

      expect(await database.collection("user").countDocuments({ email: identity.email })).toBe(1);
      expect(await database.collection("session").countDocuments({})).toBeGreaterThan(0);
    });
  });
});

describe("OTP send rate limiting (§0.11 auth.otp)", () => {
  it("I2: the 6th email OTP send for the same contact within the hour returns 429", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/email-otp/send-verification-otp",
          { email: identity.email, type: "sign-in" },
          forward(identity)
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    });
  });

  it("I15: the 16th OTP send from one IP across 16 distinct contacts returns 429", async () => {
    await withAuth(async ({ auth }) => {
      // One private IP bucket, shared by every request; a fresh contact for
      // each send so only the `ip` leg of `auth.otp` ({ limit: 15, windowSeconds:
      // 3600 }) can trip. I2 pins the per-contact 5/h leg; this pins the IP leg,
      // which no other spec exercises.
      const sharedIp = makeIdentity().ip;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const contact = makeIdentity();
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/email-otp/send-verification-otp",
          { email: contact.email, type: "sign-in" },
          { "x-forwarded-for": sharedIp }
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 15)).toEqual(Array.from({ length: 15 }, () => 200));
      expect(statuses[15]).toBe(429);
    });
  });
});

describe("OTP verify lockout (§0.11 auth.verify)", () => {
  it("I3: ten wrong OTP verifies lock the contact out; the 11th returns 429", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      await sendEmailOtp(auth, identity);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/sign-in/email-otp",
          { email: identity.email, otp: WRONG_OTP },
          forward(identity)
        );
        statuses.push(response.status);
        expect(sessionCookie(response), "a wrong OTP must never mint a session").toBeUndefined();
      }

      // Better Auth owns the exact error code for a rejected OTP (400
      // INVALID_OTP / 403 TOO_MANY_ATTEMPTS), so pin the class: every one of
      // the first ten is a client error that is *not* the rate-limit response.
      // A 5xx, or a 429 before the 11th, must fail loudly.
      expect(
        statuses.slice(0, 10).every((status) => status >= 400 && status < 500 && status !== 429)
      ).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});

describe("phone OTP (§1.1 phoneNumber plugin)", () => {
  it("I4: verifying a phone OTP sets phoneNumberVerified on the user", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      const cookie = await signUpWithVerifiedPhone(auth, identity);

      // The helper already asserted the verify call succeeded; pin the effect.
      const user = await database.collection("user").findOne({ email: identity.email });
      expect(user?.phoneNumber).toBe(identity.phone);
      expect(user?.phoneNumberVerified).toBe(true);

      // The OTP left the server by SMS, never by email.
      expect(cookie.length).toBeGreaterThan(0);
      expect(
        otpInbox
          .list()
          .some((entry: CapturedOtp) => entry.channel === "email" && entry.to === identity.phone)
      ).toBe(false);
    });
  });

  it("I9: a phone OTP for an unknown number is rejected and creates no user", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: identity.phone },
        forward(identity)
      );

      expect(response.status).toBe(403);
      expect(
        await database.collection("user").countDocuments({ phoneNumber: identity.phone })
      ).toBe(0);
      expect(otpInbox.list()).toHaveLength(0);
    });
  });

  it("I10: an unauthenticated phone OTP for a user with an unverified phone is rejected", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      // A real user document (created by the adapter) whose phone is not yet
      // verified — the state a user is in before I4's verification step.
      await signInWithEmailOtp(auth, identity);
      await database
        .collection("user")
        .updateOne(
          { email: identity.email },
          { $set: { phoneNumber: identity.phone, phoneNumberVerified: false } }
        );

      otpInbox.clear();

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: identity.phone },
        forward(identity)
      );

      expect(response.status).toBe(403);
      expect(otpInbox.list()).toHaveLength(0);
    });
  });

  it("I14: an unauthenticated phone verification creates no user and mints no session", async () => {
    await withAuth(async ({ auth, database }) => {
      // (a) A *wrong* code for an unknown number is rejected outright. This is
      //     kept from the original spec, but on its own it is vacuous: a wrong
      //     code can never materialise an account under *either*
      //     `signUpOnVerification` setting, so it cannot detect a regression in
      //     that flag. The valid-code path below is what actually pins it.
      const wrongNumber = makeIdentity();
      const wrong = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: wrongNumber.phone, code: WRONG_OTP },
        forward(wrongNumber)
      );

      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(wrong.status).toBeLessThan(500);
      expect(sessionCookie(wrong)).toBeUndefined();
      expect(
        await database.collection("user").countDocuments({ phoneNumber: wrongNumber.phone })
      ).toBe(0);

      // (b) The real guard. `signUpOnVerification` must stay disabled: verifying
      //     a *valid* code with no session and no pre-existing user for the
      //     number must never materialise an account nor mint a session
      //     (otherwise I9's unknown-number rejection would be undone here).
      //
      // An unauthenticated `send-otp` for an unknown number is refused (I9), so
      // the code for the second number is requested by a real, signed-in caller
      // (the same authorised flow `signUpWithVerifiedPhone` uses). The verify
      // then drops that session: this is exactly the request that, with
      // `signUpOnVerification` enabled, would create a user for `target.phone`
      // and hand back a session — so both assertions below fail loudly on that
      // regression, where the wrong-code path above cannot.
      const owner = makeIdentity();
      const { cookie: ownerCookie } = await signInWithEmailOtp(auth, owner);

      const target = makeIdentity();
      const sent = await authPostWithCookie(
        auth,
        "/api/auth/phone-number/send-otp",
        ownerCookie,
        { phoneNumber: target.phone },
        owner
      );
      expect(sent.status).toBe(200);
      const otp = requireOtp("sms", target.phone);

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: target.phone, code: otp.code },
        forward(target)
      );

      expect(
        sessionCookie(response),
        "signUpOnVerification must stay disabled: an unauthenticated verify must not mint a session"
      ).toBeUndefined();
      expect(
        await database.collection("user").countDocuments({ phoneNumber: target.phone }),
        "signUpOnVerification must stay disabled: an unauthenticated verify must not create a user"
      ).toBe(0);
    });
  });

  it("I16: an anonymous verify with a VALID code for an unknown number is a 4xx, never a 5xx", async () => {
    await withAuth(async ({ auth, database }) => {
      // Request a code for a number that has no user through the same
      // authenticated flow I14(b) uses (an anonymous `send-otp` for an unknown
      // number is refused by I9).
      const owner = makeIdentity();
      const { cookie: ownerCookie } = await signInWithEmailOtp(auth, owner);

      const target = makeIdentity();
      const sent = await authPostWithCookie(
        auth,
        "/api/auth/phone-number/send-otp",
        ownerCookie,
        { phoneNumber: target.phone },
        owner
      );
      expect(sent.status).toBe(200);
      const otp = requireOtp("sms", target.phone);

      // Verifying a *valid* code anonymously for a number with no user is the
      // one path the library answers with an internal 500 ("Failed to update
      // user", ADR-0021 "Known under-constrained behaviour"). A malformed or
      // impossible input reaching this endpoint must surface as a client error,
      // so pin the class and keep I14's observable invariants.
      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: target.phone, code: otp.code },
        forward(target)
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(
        sessionCookie(response),
        "an unknown-number verify must not mint a session"
      ).toBeUndefined();
      expect(await database.collection("user").countDocuments({ phoneNumber: target.phone })).toBe(
        0
      );
    });
  });

  it("I21: an anonymous send-otp for a known VERIFIED number is accepted and really sends an SMS OTP", async () => {
    await withAuth(async ({ auth }) => {
      // The third input to the anonymous `send-otp` guard (I9/I10 cover the
      // other two). An unknown number and an existing user's *unverified*
      // number are refused with the same `403 phone_not_verified`; a known,
      // *verified* number is the one input that passes, so its outcome must be
      // pinned rather than inferred from code. On `main` the guard lets the
      // request through to Better Auth's phone plugin: `200` and a genuine SMS
      // OTP is delivered. That acceptance is what an anonymous caller can
      // observe to tell "a verified account exists" from "does not" — a
      // residual enumeration oracle on this endpoint (ADR-0030 follow-up
      // addendum qualifies the earlier "cannot enumerate" claim). This is a
      // green coverage pin: the card pins the ACTUAL behaviour of `main`, it
      // does not prescribe a change (the product decision is human-owned).
      const identity = makeIdentity();
      await signUpWithVerifiedPhone(auth, identity);

      otpInbox.clear();

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: identity.phone },
        forward(identity)
      );

      // Pin the ACTUAL status of `main` (observed by running the spec first,
      // never guessed): the verified-number guard passes the request through.
      expect(response.status).toBe(200);

      // An OTP really left the server by SMS — the observable that
      // distinguishes this 200 from I9/I10's 403, which deliver nothing.
      const sent = otpInbox
        .list()
        .filter((entry: CapturedOtp) => entry.channel === "sms" && entry.to === identity.phone);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.code).toMatch(/^\d{6}$/);
    });
  });
});

describe("two-factor (§1.1 twoFactor plugin)", () => {
  it("I5: enabling 2FA with a verified phone sets twoFactorEnabled", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      await signUpWithTwoFactorEnabled(auth, database, identity);

      const user = await database.collection("user").findOne({ email: identity.email });
      expect(user?.twoFactorEnabled).toBe(true);
    });
  });

  it("I6: enabling 2FA without a verified phone is rejected", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);

      const response = await authPostWithCookie(
        auth,
        "/api/auth/two-factor/enable",
        cookie,
        {},
        identity
      );

      expect(response.status).toBe(403);

      const user = await database.collection("user").findOne({ email: identity.email });
      expect(user?.twoFactorEnabled).not.toBe(true);
    });
  });

  it("I7: with 2FA on, email-OTP sign-in is two-factor pending with no session until the SMS OTP is verified", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      await signUpWithTwoFactorEnabled(auth, database, identity);

      const emailOtp = await sendEmailOtp(auth, identity);
      const pending = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: emailOtp.code },
        forward(identity)
      );

      expect(pending.status).toBe(200);
      expect(await body(pending)).toMatchObject({ twoFactorRedirect: true });
      expect(sessionCookie(pending), "no session cookie before 2FA is verified").toBeUndefined();

      // The one-time code went out by SMS, not email (§4.1 pin).
      const smsOtp = requireOtp("sms", identity.phone);
      expect(smsOtp.channel).toBe("sms");

      const verified = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/two-factor/verify-otp",
        { code: smsOtp.code },
        { cookie: cookieHeader(pending), ...forward(identity) }
      );

      expect(verified.status).toBe(200);
      expect(sessionCookie(verified), "verifying the SMS OTP mints the session").toBeDefined();
    });
  });

  it("I8: ten wrong 2FA codes lock the challenge out; the 11th returns 429", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      await signUpWithTwoFactorEnabled(auth, database, identity);

      const emailOtp = await sendEmailOtp(auth, identity);
      const pending = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: emailOtp.code },
        forward(identity)
      );
      expect(pending.status).toBe(200);
      const pendingCookies = cookieHeader(pending);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const response = await authPost(
          auth,
          APP_ORIGIN,
          "/api/auth/two-factor/verify-otp",
          { code: WRONG_OTP },
          { cookie: pendingCookies, ...forward(identity) }
        );
        statuses.push(response.status);
        expect(
          sessionCookie(response),
          "a wrong 2FA code must never mint a session"
        ).toBeUndefined();
      }

      // As in I3: pin the class, not the library's exact code. Each of the
      // first ten is a 4xx that is not the rate-limit response; a 5xx must fail.
      expect(
        statuses.slice(0, 10).every((status) => status >= 400 && status < 500 && status !== 429)
      ).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  it("I13: disabling 2FA requires a fresh SMS OTP and clears twoFactorEnabled", async () => {
    await withAuth(async ({ auth, database }) => {
      const identity = makeIdentity();
      const cookie = await signUpWithTwoFactorEnabled(auth, database, identity);

      const enabledUser = await database.collection("user").findOne({ email: identity.email });
      expect(enabledUser?.twoFactorEnabled).toBe(true);

      // No code: rejected, 2FA stays on.
      const noCode = await authPostWithCookie(
        auth,
        "/api/auth/two-factor/disable",
        cookie,
        {},
        identity
      );
      expect(noCode.status).toBeGreaterThanOrEqual(400);
      expect(noCode.status).toBeLessThan(500);
      expect(
        (await database.collection("user").findOne({ email: identity.email }))?.twoFactorEnabled
      ).toBe(true);

      // Wrong code: rejected, 2FA stays on.
      const wrongCode = await authPostWithCookie(
        auth,
        "/api/auth/two-factor/disable",
        cookie,
        { code: WRONG_OTP },
        identity
      );
      expect(wrongCode.status).toBeGreaterThanOrEqual(400);
      expect(wrongCode.status).toBeLessThan(500);
      expect(
        (await database.collection("user").findOne({ email: identity.email }))?.twoFactorEnabled
      ).toBe(true);

      // A fresh SMS code disables it.
      otpInbox.clear();
      const sent = await authPostWithCookie(
        auth,
        "/api/auth/two-factor/send-otp",
        cookie,
        {},
        identity
      );
      expect(sent.status).toBe(200);
      const otp = requireOtp("sms", identity.phone);

      const disabled = await authPostWithCookie(
        auth,
        "/api/auth/two-factor/disable",
        cookie,
        { code: otp.code },
        identity
      );
      expect(disabled.status).toBe(200);
      expect(
        (await database.collection("user").findOne({ email: identity.email }))?.twoFactorEnabled
      ).toBe(false);
    });
  });
});

describe("callback URL trust (§1.1 trustedOrigins)", () => {
  it("I11: a sign-in callbackURL outside trustedOrigins is rejected and mints no session", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      const otp = await sendEmailOtp(auth, identity);

      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: otp.code, callbackURL: EVIL_CALLBACK },
        forward(identity)
      );

      expect(response.status).toBe(403);
      expect(sessionCookie(response)).toBeUndefined();
    });
  });

  it("I17: a relative callbackURL is accepted through the handler and mints a session", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      const otp = await sendEmailOtp(auth, identity);

      // A relative callbackURL resolves against `baseURL`, which is itself the
      // trusted deployment origin, so it must be accepted. This is the effective
      // handler behaviour; the `before`-hook is not assumed to be the only
      // defence because the instance is *also* given the same `trustedOrigins`.
      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: otp.code, callbackURL: "/welcome" },
        forward(identity)
      );

      expect(response.status).toBe(200);
      expect(sessionCookie(response), "a relative callbackURL must be accepted").toBeDefined();
    });
  });

  it("I18: an absolute callbackURL on an ALLOWED_ORIGINS origin is accepted — the allowlist is the single source of truth", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      const otp = await sendEmailOtp(auth, identity);

      // Paired with I11 (an origin outside the allowlist is a 403), this pins
      // the allowlist itself as what decides trust: the one configured origin
      // is accepted while any other absolute origin is not. Better Auth's
      // native `trustedOrigins` check and our hook consume the same
      // `ALLOWED_ORIGINS` value and the handler exposes only their combined
      // outcome, so no spec can attribute the decision to one of the two — the
      // observable contract is the allowlist, which is exactly what is pinned.
      const response = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: otp.code, callbackURL: `${APP_ORIGIN}/welcome` },
        forward(identity)
      );

      expect(response.status).toBe(200);
      expect(
        sessionCookie(response),
        "a callbackURL in ALLOWED_ORIGINS must be accepted"
      ).toBeDefined();
    });
  });
});

describe("OTP logging (security_and_logging_requirements)", () => {
  it("I12: an OTP send logs auth.otp.sent with a hashed contact and channel, never the code", async () => {
    const previousLogger = getLogger();
    const sink: MemoryTransport = memoryTransport();
    setLogger(
      createLogger({
        level: "info",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );

    try {
      await withAuth(async ({ auth }) => {
        const identity = makeIdentity();
        const otp = await sendEmailOtp(auth, identity);

        const entry = sink.entries.find((candidate) => candidate.event === "auth.otp.sent");
        expect(entry).toBeDefined();
        expect(entry?.level).toBe("info");
        expect(entry?.channel).toBe("email");
        // The contact is logged in redacted form — present, but never the raw
        // address (and never the generated code).
        expect(typeof entry?.contact).toBe("string");
        expect(String(entry?.contact)).not.toContain(identity.email);

        const serialized = JSON.stringify(sink.entries);
        expect(serialized).not.toContain(identity.email);
        expect(serialized).not.toContain(otp.code);
        expectNoSecretsInLogs(sink);
      });
    } finally {
      setLogger(previousLogger);
    }
  });
});

describe("session-authenticated verify cap (ADR-0021 §1 — product decision)", () => {
  it("I19: repeated session-authenticated phone verifies are bounded by a per-session cap (value OPEN)", async () => {
    await withAuth(async ({ auth }) => {
      const identity = makeIdentity();
      const cookie = await signUpWithVerifiedPhone(auth, identity);

      // ADR-0021 §1 deliberately does not count an authenticated verify toward
      // `auth.verify`, so today a session holder can guess codes without any
      // lockout. Drive the same session until a lockout appears; the exact cap
      // value is a product decision left OPEN — see the constant comment.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < AUTHENTICATED_VERIFY_PROBE_BOUND; attempt += 1) {
        const response = await authPostWithCookie(
          auth,
          "/api/auth/phone-number/verify",
          cookie,
          { phoneNumber: identity.phone, code: WRONG_OTP },
          identity
        );
        statuses.push(response.status);
        expect(response.status, "a wrong code must be a client error, never a 5xx").toBeLessThan(
          500
        );
      }

      const firstLockout = statuses.indexOf(429);
      expect(
        firstLockout,
        `no locked-out response within ${String(AUTHENTICATED_VERIFY_PROBE_BOUND)} session-authenticated attempts — the per-session cap is unbounded`
      ).toBeGreaterThanOrEqual(0);
      // Once the cap is hit the lockout is terminal for the rest of the window.
      expect(statuses.slice(firstLockout).every((status) => status === 429)).toBe(true);

      // Scoping: the budget is per-user/per-session, not per contact. A second,
      // never-attempted number under the *same* session is already locked out;
      // a per-contact counter would reset and answer 4xx instead.
      const second = await authPostWithCookie(
        auth,
        "/api/auth/phone-number/verify",
        cookie,
        { phoneNumber: makeIdentity().phone, code: WRONG_OTP },
        identity
      );
      expect(second.status, "the cap must be scoped per session/user, not per contact").toBe(429);
    });
  });
});

describe("anonymous verify error parity (ADR-0021 §1 — no account-existence oracle)", () => {
  it("I20: an anonymous verify of an unknown number with a VALID code returns the same error envelope as an existing user's wrong code", async () => {
    await withAuth(async ({ auth }) => {
      // The residual oracle this pins: if "valid code, no such account" answers
      // differently from "wrong code, existing account", a caller can decide
      // whether a phone number belongs to an OpenPic user without ever holding
      // a code for it. The two failures must be indistinguishable.

      // (a) An existing, verified user whose wrong code is rejected by the
      //     library's own verify step (the hook finds the user and lets it pass
      //     through to Better Auth). A fresh OTP is requested first so the code
      //     is genuinely wrong — otherwise the library reports "no OTP" instead.
      const existing = makeIdentity();
      const existingCookie = await signUpWithVerifiedPhone(auth, existing);
      const resend = await authPostWithCookie(
        auth,
        "/api/auth/phone-number/send-otp",
        existingCookie,
        { phoneNumber: existing.phone },
        existing
      );
      expect(resend.status).toBe(200);
      requireOtp("sms", existing.phone);
      const wrongCode = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: existing.phone, code: WRONG_OTP },
        forward(existing)
      );
      const wrongCodeBody = await body(wrongCode);

      // (b) A number with no user, presented with a VALID code. The code is
      //     requested through the authenticated send-otp flow, because an
      //     anonymous send-otp for an unknown number is refused (I9/I14(b)).
      const owner = makeIdentity();
      const { cookie: ownerCookie } = await signInWithEmailOtp(auth, owner);
      const target = makeIdentity();
      const sent = await authPostWithCookie(
        auth,
        "/api/auth/phone-number/send-otp",
        ownerCookie,
        { phoneNumber: target.phone },
        owner
      );
      expect(sent.status).toBe(200);
      const otp = requireOtp("sms", target.phone);
      const unknownNumber = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: target.phone, code: otp.code },
        forward(target)
      );
      const unknownNumberBody = await body(unknownNumber);

      // Both are ordinary client errors — not a 5xx, and not the rate-limit 429.
      expect(
        wrongCode.status,
        "an existing user's wrong code must be a 4xx"
      ).toBeGreaterThanOrEqual(400);
      expect(wrongCode.status).toBeLessThan(500);
      expect(wrongCode.status).not.toBe(429);
      expect(
        unknownNumber.status,
        "an unknown number's valid code must be a 4xx, never a 5xx"
      ).toBeGreaterThanOrEqual(400);
      expect(unknownNumber.status).toBeLessThan(500);
      expect(unknownNumber.status).not.toBe(429);

      // The parity itself: status, error code and message are indistinguishable.
      expect(unknownNumber.status).toBe(wrongCode.status);
      expect(unknownNumberBody.code).toBe(wrongCodeBody.code);
      expect(unknownNumberBody.message).toBe(wrongCodeBody.message);

      // Non-vacuous: the shared envelope actually carries a code and a message.
      expect(typeof wrongCodeBody.code).toBe("string");
      expect(String(wrongCodeBody.code).length).toBeGreaterThan(0);
      expect(typeof wrongCodeBody.message).toBe("string");
      expect(String(wrongCodeBody.message).length).toBeGreaterThan(0);
    });
  });
});
