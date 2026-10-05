import type { Db, Document, WithId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAuth, type AuthLike } from "@/server/auth";
import { resolvePrincipal, requireAuth, type AuthLabel } from "@/server/auth/guards";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient } from "@/server/db/mongo";
import { defineRoute, type RouteHandler } from "@/server/http/define-route";
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
import { authPost, body, cookiePair, sessionCookie } from "../helpers/auth-requests";

/**
 * Integration / contract — the auth guards (OP-86, contract §0.3).
 *
 * Every spec drives the real Better Auth instance (`createAuth({ db })`, OP-85)
 * over its HTTP handler, then asks the guard under test what principal that
 * session resolves to and whether it satisfies a label. Nothing reaches into
 * plugin internals: the observable surface is the guard's decision, the
 * principal it exposes, the HTTP status/body on a route built from
 * `defineRoute`, and the persisted auth documents.
 *
 * Contract expected of the implementation (see ADR-0022):
 *
 *   - `@/server/auth/guards` exports `resolvePrincipal(request, { auth, database })`
 *     → `Principal | null` and `requireAuth(label, options)` → `RouteStage`.
 *   - A `user` principal exposes `status`, `platformRole`, `accountCompletedAt`
 *     (from `userProfiles`) and `emailVerified`, `phoneNumberVerified`,
 *     `twoFactorEnabled`, `sessionTwoFactorVerified`, `banned`, `banReason`,
 *     `banExpires`.
 *   - `requireAuth` publishes the user id on `ctx.principal` for the identity
 *     rate-limit tier and denies by throwing the Appendix A code.
 *
 * Test isolation (as OP-85): a fresh database and auth instance per spec, and
 * a private email/phone/IP identity per spec so `auth.otp`/`auth.verify` never
 * collide across specs.
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/test/guard-route";

/** A completed-at instant that is deliberately never the "now" of a spec. */
const COMPLETED_AT = new Date("2026-01-01T00:00:00.000Z");
const NEVER = new Date("2099-01-01T00:00:00.000Z");

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
    email: `op86-spec-${serial}@example.com`,
    phone: `+91990000${serial}`,
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
  const test: TestDb = createTestDb("openpic_guard");
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

function forward(identity: Identity): Record<string, string> {
  return { "x-forwarded-for": identity.ip };
}

/** Sign in with a valid email OTP; returns the response and the session cookie. */
async function signInWithEmailOtp(
  auth: AuthLike,
  identity: Identity
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const sent = await authPost(
    auth,
    APP_ORIGIN,
    "/api/auth/email-otp/send-verification-otp",
    { email: identity.email, type: "sign-in" },
    forward(identity)
  );
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

/**
 * Insert the `userProfiles` row the guard must load (schema §13.2).
 *
 * `userId` is the Better Auth user's `_id` *as stored* (an ObjectId), so the
 * guard must map the hex string `getSession` returns onto it — a raw string
 * comparison would silently miss every profile.
 */
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

interface GuardRouteOptions {
  readonly allowBanned?: boolean;
}

/**
 * A route whose only job is to expose what the guard decided: the status, the
 * `ctx.principal` it published, and (on success) the body.
 */
function guardRoute(
  harness: Harness,
  label: AuthLabel,
  options: GuardRouteOptions = {}
): RouteHandler {
  return defineRoute({
    route: ROUTE,
    response: z.object({ principal: z.string().nullable() }),
    env: "test",
    auth: requireAuth(label, {
      auth: harness.auth,
      database: harness.database,
      ...(options.allowBanned === true ? { allowBanned: true } : {}),
    }),
    handler: (ctx) => ({ body: { principal: ctx.principal ?? null } }),
  });
}

/** The error envelope a guard denial is projected onto. */
interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
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

describe("principal resolution (§0.3)", () => {
  it("I1: a real Better Auth session cookie resolves to the user principal", async () => {
    await withHarness(async ({ auth, database }) => {
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);
      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { platformRole: "client", accountCompletedAt: null });

      const principal = await resolvePrincipal(requestWith({ cookie }), { auth, database });

      expect(principal).toMatchObject({
        kind: "user",
        userId: String(user._id),
        status: "active",
        platformRole: "client",
        emailVerified: true,
        phoneNumberVerified: false,
        twoFactorEnabled: false,
        banned: false,
      });
    });
  });

  it("I2: a bearer token resolves to the same principal as the session cookie", async () => {
    await withHarness(async ({ auth, database }) => {
      const identity = makeIdentity();
      const { response, cookie } = await signInWithEmailOtp(auth, identity);

      // The bearer plugin exposes the session token on the sign-in response;
      // without it a mobile client has no way to obtain a bearer credential.
      const token = response.headers.get("set-auth-token");
      expect(typeof token).toBe("string");
      expect((token ?? "").length).toBeGreaterThan(0);

      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { platformRole: "client", accountCompletedAt: null });

      const viaCookie = await resolvePrincipal(requestWith({ cookie }), { auth, database });
      const viaBearer = await resolvePrincipal(
        requestWith({ authorization: `Bearer ${token ?? ""}` }),
        { auth, database }
      );

      expect(viaBearer).not.toBeNull();
      expect(viaBearer).toEqual(viaCookie);
    });
  });

  it("returns no principal for a request carrying no credential", async () => {
    await withHarness(async ({ auth, database }) => {
      await expect(resolvePrincipal(requestWith(), { auth, database })).resolves.toBeNull();
    });
  });
});

describe("user:complete guard (§0.3)", () => {
  it("I3: an incomplete account is 403 account_incomplete with the missing phone", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);
      const user = await findUser(database, identity);
      // Email OTP sign-in verifies the email; the phone is still unverified.
      await insertProfile(database, user._id, { accountCompletedAt: null });

      const response = await requestGuardRoute(guardRoute(harness, "user:complete"), cookie);

      expect(response.status).toBe(403);
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("account_incomplete");
      expect(envelope.error.details?.missing).toEqual(["phoneNumberVerified"]);
      expect(typeof envelope.error.details?.verifyUrl).toBe("string");
    });
  });
});

describe("admin guard (§0.3)", () => {
  it("I4: an admin without 2FA is 403 admin_2fa_required", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);
      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { platformRole: "admin" });

      const response = await requestGuardRoute(guardRoute(harness, "admin"), cookie);

      expect(response.status).toBe(403);
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("admin_2fa_required");
      expect(typeof envelope.error.details?.setupUrl).toBe("string");
    });
  });

  it("I6: an admin session created before 2FA was enabled is 403 admin_2fa_required", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();

      // Two sessions for the same user: `preTwoFactor` is minted before 2FA is
      // switched on and must never gain admin access; `setup` drives the
      // enable-and-confirm flow.
      const preTwoFactor = await signInWithEmailOtp(auth, identity);
      const setup = await signInWithEmailOtp(auth, identity);
      await enableTwoFactor(auth, identity, setup.cookie);

      const user = await findUser(database, identity);
      expect(user.twoFactorEnabled).toBe(true);
      await insertProfile(database, user._id, { platformRole: "admin" });

      const response = await requestGuardRoute(guardRoute(harness, "admin"), preTwoFactor.cookie);

      expect(response.status).toBe(403);
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("admin_2fa_required");
    });
  });

  it("I7: an admin signing in with phone OTP first never gets an admin session", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();

      // Enable 2FA on one session, then make the user an admin.
      const setup = await signInWithEmailOtp(auth, identity);
      await enableTwoFactor(auth, identity, setup.cookie);
      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { platformRole: "admin" });
      otpInbox.clear();

      // An unauthenticated phone-OTP sign-in: the phone is already verified, so
      // the send is allowed (OP-85) and the verify doubles as a first-factor
      // sign-in that never sees the second factor.
      const sent = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/send-otp",
        { phoneNumber: identity.phone },
        forward(identity)
      );
      expect(sent.status).toBe(200);
      const otp = requireOtp("sms", identity.phone);

      const verified = await authPost(
        auth,
        APP_ORIGIN,
        "/api/auth/phone-number/verify",
        { phoneNumber: identity.phone, code: otp.code },
        forward(identity)
      );
      expect(verified.status).toBe(200);

      // The unauthenticated phone-OTP verify mints a full session even though the
      // user has 2FA enabled: the two-factor plugin only intercepts
      // `/sign-in/phone-number`, never `/phone-number/verify` (verified against
      // the installed 1.7.7 plugin source and reproduced in-process). So this is
      // the "session minted but second factor never passed" branch, not the
      // "sign-in refused" one. Pin the mechanism exactly rather than accepting
      // either outcome.
      const phoneCookie = sessionCookie(verified);
      if (phoneCookie === undefined) {
        throw new Error("the phone-OTP sign-in did not mint a session cookie");
      }

      const response = await requestGuardRoute(
        guardRoute(harness, "admin"),
        cookiePair(phoneCookie)
      );

      expect(response.status).toBe(403);
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("admin_2fa_required");
    });
  });

  it("I8: an admin session that completed the second factor is allowed", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();

      // One session drives the whole 2FA enrolment (verify phone → enable →
      // confirm) and then authenticates the admin route. ADR-0022 §4 leaves the
      // per-session mechanism to GREEN; this spec pins only the observable fact:
      // the session that just passed the second factor is recognised, so a
      // resolver that hard-codes `sessionTwoFactorVerified: false` cannot pass.
      const { cookie } = await signInWithEmailOtp(auth, identity);
      await enableTwoFactor(auth, identity, cookie);

      const user = await findUser(database, identity);
      expect(user.twoFactorEnabled).toBe(true);
      await insertProfile(database, user._id, { platformRole: "admin" });

      const response = await requestGuardRoute(guardRoute(harness, "admin"), cookie);

      expect(response.status).toBe(200);
      expect((await response.json()) as { principal: string }).toEqual({
        principal: String(user._id),
      });
    });
  });
});

describe("banned-users guard (§0.3)", () => {
  it("I5: a banned user is 423 account_banned on a normal route and 200 on the exempt /me route", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);
      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { accountCompletedAt: COMPLETED_AT });

      await database
        .collection("user")
        .updateOne(
          { _id: user._id },
          { $set: { banned: true, banReason: "spam", banExpires: NEVER } }
        );

      const normal = await requestGuardRoute(guardRoute(harness, "user"), cookie);
      expect(normal.status).toBe(423);
      const envelope = (await body(normal)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("account_banned");
      expect(envelope.error.details).toMatchObject({ banReason: "spam" });
      expect(envelope.error.details?.banExpires).toBe(NEVER.toISOString());

      // `GET /me` is on the ban exemption list: a banned user may still read
      // their own account to see why they are banned.
      const exempt = await requestGuardRoute(
        guardRoute(harness, "user", { allowBanned: true }),
        cookie
      );
      expect(exempt.status).toBe(200);
      expect((await exempt.json()) as { principal: string }).toEqual({
        principal: String(user._id),
      });
    });
  });
});

describe("authenticated principal through the pipeline (§0.3)", () => {
  it("publishes the user id on ctx.principal for the identity rate-limit tier", async () => {
    await withHarness(async (harness) => {
      const { auth, database } = harness;
      const identity = makeIdentity();
      const { cookie } = await signInWithEmailOtp(auth, identity);
      const user = await findUser(database, identity);
      await insertProfile(database, user._id, { accountCompletedAt: COMPLETED_AT });

      const response = await requestGuardRoute(guardRoute(harness, "user"), cookie);

      expect(response.status).toBe(200);
      expect((await response.json()) as { principal: string }).toEqual({
        principal: String(user._id),
      });
    });
  });

  it("returns 401 authentication_required with WWW-Authenticate for a missing credential", async () => {
    await withHarness(async (harness) => {
      const response = await requestGuardRoute(guardRoute(harness, "user"), undefined);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).not.toBeNull();
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("authentication_required");
    });
  });

  it("returns 401 authentication_required with a loginUrl for a missing credential", async () => {
    // Appendix A pins `authentication_required.details.loginUrl`; today only the
    // e2e spec checks it, so the in-process envelope must carry it too rather
    // than relying on Next.js/route glue to add it.
    await withHarness(async (harness) => {
      const response = await requestGuardRoute(guardRoute(harness, "user"), undefined);

      expect(response.status).toBe(401);
      const envelope = (await body(response)) as unknown as ErrorEnvelope;
      expect(envelope.error.code).toBe("authentication_required");
      expect(typeof envelope.error.details?.loginUrl).toBe("string");
    });
  });

  // `session_expired` (Appendix A, 401) is deliberately NOT exercised here:
  // Better Auth's `get-session` resolves both a missing and an expired cookie to
  // `null`, so `resolvePrincipal` cannot distinguish them and OP-86 has no
  // observable signal to assert. See ADR-0022 §7 — the code is reserved for a
  // future story that can observe expiry (e.g. a signed expiry hint).
});

describe("guard denial logging (security_and_logging_requirements)", () => {
  it("logs auth.denied at warn with the label and reason, never the raw cookie", async () => {
    const previous = getLogger();
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
      await withHarness(async (harness) => {
        const { auth, database } = harness;
        const identity = makeIdentity();
        const { cookie } = await signInWithEmailOtp(auth, identity);
        const user = await findUser(database, identity);
        await insertProfile(database, user._id, { accountCompletedAt: null });

        const response = await requestGuardRoute(guardRoute(harness, "user:complete"), cookie);
        expect(response.status).toBe(403);

        const entry = sink.entries.find((candidate) => candidate.event === "auth.denied");
        expect(entry).toBeDefined();
        expect(entry?.level).toBe("warn");
        expect(entry?.label).toBe("user:complete");
        expect(entry?.reason).toBe("account_incomplete");

        const rawToken = cookie.split("=").slice(1).join("=");
        expect(JSON.stringify(sink.entries)).not.toContain(rawToken);
      });
    } finally {
      setLogger(previous);
    }
  });
});
