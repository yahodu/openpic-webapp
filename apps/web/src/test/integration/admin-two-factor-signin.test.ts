import type { Db, Document, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAuth, type AuthLike } from "@/server/auth";
import { resolvePrincipal, requireAuth, type AuthLabel } from "@/server/auth/guards";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient } from "@/server/db/mongo";
import { defineRoute, type RouteHandler } from "@/server/http/define-route";

import {
  MONGO_READY_HOOK_TIMEOUT_MS,
  createTestDb,
  setupMongoTestEnv,
  type TestDb,
} from "../helpers/db";
import { authPost, body, cookiePair, sessionCookie, setCookies } from "../helpers/auth-requests";

/**
 * Integration / contract — the admin 2FA *sign-in* branch (OP-86 follow-up,
 * contract §0.3).
 *
 * I8 in `auth-guards.test.ts` pins the admin ALLOW path only for a session that
 * *already existed* when 2FA was enrolled: the same cookie enables and confirms
 * the second factor. It never exercises the signing-in branch, where Better
 * Auth's two-factor plugin intercepts `/sign-in/email-otp` (returns
 * `twoFactorRedirect`, mints no session), the SMS OTP completes
 * `/two-factor/verify-otp`, and the plugin then mints a *brand-new* session via
 * `setSessionCookie`. That new-session path is where `recordVerifiedSession`
 * reads `ctx.context.newSession`; if it instead read only the (absent)
 * `ctx.context.session`, the fresh admin session would silently deny with
 * `admin_2fa_required`.
 *
 * This spec drives that journey end to end against the real auth instance, then
 * asserts the observable facts the contract cares about: the resolved principal
 * reports `sessionTwoFactorVerified === true`, and the admin route answers 200
 * with `ctx.principal` set.
 *
 * Test isolation (as OP-85/OP-86): a fresh database and auth instance per spec,
 * and a private email/phone/IP identity per spec so `auth.otp`/`auth.verify`
 * never collide across specs.
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/test/guard-route";

/** A completed-at instant that is deliberately never the "now" of a spec. */
const COMPLETED_AT = new Date("2026-01-01T00:00:00.000Z");

type OtpChannel = "email" | "sms";
interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

interface Identity {
  readonly email: string;
  readonly phone: string;
  readonly ip: string;
}

let identitySeq = 0;

/** A unique email/phone/IP so no two specs share a rate-limit bucket. */
function makeIdentity(): Identity {
  identitySeq += 1;
  const serial = String(identitySeq).padStart(4, "0");
  return {
    email: `op86-2fa-signin-${serial}@example.com`,
    phone: `+919****0000${serial}`,
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

interface Harness {
  readonly auth: AuthLike;
  readonly database: Db;
}

/** Run `fn` against a fresh database and a fresh auth instance, then drop it. */
async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const test: TestDb = createTestDb("openpic_2fa_signin");
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

function forward(identity: Identity): Record<string, string> {
  return { "x-forwarded-for": identity.ip };
}

/** Send an email sign-in OTP and return the response. */
function sendEmailOtp(auth: AuthLike, identity: Identity): Promise<Response> {
  return authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/email-otp/send-verification-otp",
    { email: identity.email, type: "sign-in" },
    forward(identity)
  );
}

/** Sign in with a valid email OTP; returns the response and the session cookie. */
async function signInWithEmailOtp(
  auth: AuthLike,
  identity: Identity
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const sent = await sendEmailOtp(auth, identity);
  expect(sent.status).toBe(200);
  const otp = requireOtp("email", identity.email);

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

/** Verify a phone number using the given authenticated session. */
async function verifyPhone(auth: AuthLike, identity: Identity, cookie: string): Promise<void> {
  const sent = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/phone-number/send-otp",
    { phoneNumber: identity.phone },
    { cookie, ...forward(identity) }
  );
  expect(sent.status).toBe(200);
  const otp = requireOtp("sms", identity.phone);

  const verified = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/phone-number/verify",
    { phoneNumber: identity.phone, code: otp.code },
    { cookie, ...forward(identity) }
  );
  expect(verified.status).toBe(200);
}

/** Verify phone and enable+confirm 2FA on the given session (OP-85 flows). */
async function enableTwoFactor(auth: AuthLike, identity: Identity, cookie: string): Promise<void> {
  await verifyPhone(auth, identity, cookie);
  otpInbox.clear();

  const enabled = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/two-factor/enable",
    {},
    { cookie, ...forward(identity) }
  );
  expect(enabled.status).toBe(200);

  const otp = requireOtp("sms", identity.phone);
  const confirmed = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/two-factor/verify-otp",
    { code: otp.code },
    { cookie, ...forward(identity) }
  );
  expect(confirmed.status).toBe(200);
  otpInbox.clear();
}

/** Read the raw Better Auth user document for an identity. */
async function findUser(database: Db, identity: Identity): Promise<WithId<Document>> {
  const user = await database.collection("user").findOne({ email: identity.email });
  if (user === null) {
    throw new Error(`no user document for ${identity.email}`);
  }
  return user;
}

/** Insert the `userProfiles` row the guard must load (schema §13.2). */
async function insertProfile(
  database: Db,
  userId: unknown,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await database.collection("userProfiles").insertOne({
    userId,
    status: "active",
    platformRole: "client",
    accountCompletedAt: null,
    primaryTenantId: null,
    schemaVersion: 1,
    ...overrides,
  });
}

/** A GET request carrying the given headers, at the app origin. */
function requestWith(headers: Record<string, string> = {}, path = ROUTE): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "GET", headers });
}

/**
 * A route whose only job is to expose what the guard decided: the status, the
 * `ctx.principal` it published, and (on success) the body.
 */
function guardRoute(harness: Harness, label: AuthLabel): RouteHandler {
  return defineRoute({
    route: ROUTE,
    response: z.object({ principal: z.string().nullable() }),
    env: "test",
    auth: requireAuth(label, { auth: harness.auth, database: harness.database }),
    handler: (ctx) => ({ body: { principal: ctx.principal ?? null } }),
  });
}

/** A request to a guard route carrying a session cookie (or none). */
async function requestGuardRoute(
  route: RouteHandler,
  cookie: string | undefined
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return route(requestWith(headers));
}

describe("admin 2FA sign-in branch (§0.3)", () => {
  it("I10: completing verify-otp on a fresh sign-in mints an admin session whose principal is 2FA-verified", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();

      // Enrol 2FA on one session, then make the user an admin (as I8 does).
      const setup = await signInWithEmailOtp(auth, identity);
      await enableTwoFactor(auth, identity, setup.cookie);
      const user = await findUser(database, identity);
      expect(user.twoFactorEnabled).toBe(true);
      await insertProfile(database, user._id, {
        platformRole: "admin",
        accountCompletedAt: COMPLETED_AT,
      });
      otpInbox.clear();

      // Sign in again from a fresh session: with 2FA on, the email-OTP endpoint
      // converts the would-be session into a pending challenge and sets no
      // session cookie.
      const sent = await sendEmailOtp(auth, identity);
      expect(sent.status).toBe(200);
      const emailOtp = requireOtp("email", identity.email);

      const challenge = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/sign-in/email-otp",
        { email: identity.email, otp: emailOtp.code },
        forward(identity)
      );
      expect(challenge.status).toBe(200);
      expect((await body(challenge)) as { twoFactorRedirect?: boolean }).toMatchObject({
        twoFactorRedirect: true,
      });
      expect(sessionCookie(challenge), "no session before the second factor").toBeUndefined();

      // The challenge code arrives by SMS to the verified phone.
      const smsOtp = requireOtp("sms", identity.phone);
      expect(smsOtp.channel).toBe("sms");

      const verified = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/two-factor/verify-otp",
        { code: smsOtp.code },
        { cookie: cookieHeader(challenge), ...forward(identity) }
      );
      expect(verified.status).toBe(200);

      // Completing the challenge mints a NEW session (the signing-in branch),
      // distinct from the session that enrolled 2FA.
      const setCookie = sessionCookie(verified);
      if (setCookie === undefined) {
        throw new Error("completing 2FA did not mint a session cookie");
      }
      const cookie = cookiePair(setCookie);
      expect(cookie).not.toBe(setup.cookie);

      // The new session carries the per-session 2FA fact the admin label reads.
      const principal = await resolvePrincipal(requestWith({ cookie }), { auth, database });
      expect(principal).not.toBeNull();
      expect(principal).toMatchObject({
        kind: "user",
        userId: String(user._id),
        twoFactorEnabled: true,
        sessionTwoFactorVerified: true,
      });

      // ...and the admin route allows it, publishing the principal id.
      const response = await requestGuardRoute(guardRoute(harness, "admin"), cookie);
      expect(response.status).toBe(200);
      expect((await body(response)) as { principal: string | null }).toEqual({
        principal: String(user._id),
      });
    });
  });
});
