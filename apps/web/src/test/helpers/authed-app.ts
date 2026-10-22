import { randomUUID } from "node:crypto";

import { ObjectId, type Db } from "mongodb";

import { createAuth, type AuthLike } from "@/server/auth";
import { otpInbox, type OtpChannel } from "@/server/auth/otp-inbox";
import { closeMongoClient, getDb } from "@/server/db/mongo";

import { makeEnv, toProcessEnv, type EnvInput } from "../factories/env";

import { authPost, cookiePair, sessionCookie } from "./auth-requests";
import { requireMongoTestUri, waitForMongoReady } from "./db";

/**
 * Authenticated test application harness (OP-97).
 *
 * Several notification-feed suites need the same three things before they can
 * assert anything: a private database bound to the process singletons the route
 * handlers read through, a real Better Auth instance writing to that database,
 * and a caller session cookie minted by the real email-OTP sign-in flow. This
 * helper factors that bootstrap out of the specs so each suite states only the
 * behaviour it pins.
 *
 * It deliberately mirrors the long-proven `me-current-user.test.ts` bootstrap:
 * the singleton Mongo client is rebuilt against a uniquely-named database, the
 * environment is applied from the shared `makeEnv` fixture, and the session is
 * obtained by driving the auth HTTP handler (never by writing a session row).
 */

/** The origin every request in these suites is built against. */
export const APP_ORIGIN = "http://localhost:3000";

/** A unique caller identity, so no two specs share a rate-limit bucket. */
export interface TestIdentity {
  readonly email: string;
  readonly phone: string;
  readonly ip: string;
}

/** A signed-in caller: the cookie to replay and the Better Auth user id. */
export interface SignedInUser {
  readonly cookie: string;
  readonly userId: ObjectId;
  readonly identity: TestIdentity;
}

/** A booted app: the database, the auth surface and the sign-in helper. */
export interface TestApp {
  readonly db: Db;
  readonly auth: AuthLike;
  /** Sign in a fresh identity (or the supplied one) and return its session. */
  signIn(identity?: TestIdentity): Promise<SignedInUser>;
  /** Drop the private database and release the singleton client. */
  cleanup(): Promise<void>;
}

let identitySeq = 0;

/**
 * Build a unique email/phone/IP triple.
 *
 * @param prefix - A suite-local prefix so a captured OTP is traceable.
 * @returns The identity.
 */
export function makeIdentity(prefix: string): TestIdentity {
  identitySeq += 1;
  const serial = String(identitySeq).padStart(4, "0");
  const noise = randomUUID().replace(/-/g, "").slice(0, 8);
  return {
    email: `${prefix}-${serial}-${noise}@example.com`,
    phone: `+9190000${serial}`,
    ip: `203.0.113.${String((identitySeq % 250) + 1)}`,
  };
}

/** Point a MongoDB URI at `dbName`, preserving options. */
function uriWithDb(uri: string, dbName: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** The captured OTP, failing loudly when the transport recorded none. */
function requireOtp(channel: OtpChannel, to: string): string {
  const otp = otpInbox.take(channel, to);
  if (otp === undefined) {
    throw new Error(`expected an OTP captured for ${channel}:${to}, got none`);
  }
  return otp.code;
}

/**
 * Boot the app against a fresh private database.
 *
 * Must be awaited from a `beforeAll`, never inside a timed spec: it pays the
 * cold connect / replica-set discovery / primary election cost and the
 * readiness probe.
 *
 * @param options - A database-name `prefix` and optional env overrides.
 * @returns The booted {@link TestApp}.
 */
export async function startTestApp(options: {
  readonly prefix: string;
  readonly env?: EnvInput;
}): Promise<TestApp> {
  const uri = requireMongoTestUri();
  const dbName = `openpic_${options.prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Rebuild the singleton client from this file's configuration: a previous
  // file in the same worker may have left a client bound to another database.
  await closeMongoClient();
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: uriWithDb(uri, dbName),
        RATE_LIMIT_PROVIDER: "memory",
        MESSAGE_TRANSPORT: "memory",
        ...options.env,
      })
    )
  );

  const database = getDb();
  const auth = createAuth({ db: database });

  await waitForMongoReady();

  /** Sign in via the real email-OTP handshake and resolve the stored user row. */
  const signIn = async (identity = makeIdentity(options.prefix)): Promise<SignedInUser> => {
    const forward = { "x-forwarded-for": identity.ip };

    const sent = await authPost(
      auth,
      APP_ORIGIN,
      "/api/auth/email-otp/send-verification-otp",
      { email: identity.email, type: "sign-in" },
      forward
    );
    if (sent.status !== 200) {
      throw new Error(`email OTP send failed: ${String(sent.status)}`);
    }

    const response = await authPost(
      auth,
      APP_ORIGIN,
      "/api/auth/sign-in/email-otp",
      { email: identity.email, otp: requireOtp("email", identity.email) },
      forward
    );
    if (response.status !== 200) {
      throw new Error(`email OTP sign-in failed: ${String(response.status)}`);
    }

    const cookie = sessionCookie(response);
    if (cookie === undefined) {
      throw new Error("sign-in did not set a session cookie");
    }

    const user = await database.collection("user").findOne({ email: identity.email });
    if (user === null) {
      throw new Error(`no user document for ${identity.email}`);
    }

    return { cookie: cookiePair(cookie), userId: user._id, identity };
  };

  return {
    db: database,
    auth,
    signIn,
    async cleanup(): Promise<void> {
      await database.dropDatabase();
      await closeMongoClient();
    },
  };
}
