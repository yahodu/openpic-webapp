import { randomUUID } from "node:crypto";

import type { Db, Document, WithId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as meGet } from "@/app/api/v1/me/route";
import { createAuth, type AuthLike } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { otpInbox } from "@/server/auth/otp-inbox";
import { closeMongoClient, getDb } from "@/server/db/mongo";
import { defineRoute, type RouteHandler } from "@/server/http/define-route";

import { makeEnv, toProcessEnv } from "../factories/env";
import { MONGO_READY_HOOK_TIMEOUT_MS, requireMongoTestUri, waitForMongoReady } from "../helpers/db";
import { authPost, body, cookiePair, sessionCookie } from "../helpers/auth-requests";

/**
 * Integration / contract — the ban exemption on the shipped `GET /api/v1/me`
 * (OP-86 follow-up, contract §0.3).
 *
 * I5 in `auth-guards.test.ts` proves the guard *flag* (`allowBanned`) on a
 * synthetic route. It never proves the flag is wired onto the real, deployed
 * route: `apps/web/src/app/api/v1/me/route.ts` could build `requireAuth("user",
 * { auth, database })` with no `allowBanned`, and a banned user would get `423`
 * where the contract says `200` — while every existing spec stays green.
 *
 * This spec therefore drives the REAL handler exported from the route module
 * (`import { GET }`) with a banned session, and pins the other half of the rule
 * on a non-exempt route with the same session. The `/me` response BODY is
 * OP-88's contract and deliberately not asserted here.
 *
 * The real handler resolves `getAuth()`/`getDb()` from validated configuration,
 * so this spec is the one integration file that must share a database with the
 * process singletons: it points `MONGODB_URI` at a private, uniquely-named
 * database *before* the singleton client is built, and builds its own auth
 * instance on that same database.
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/test/guard-route";
const ME_PATH = "/api/v1/me";

/** A completed-at instant that is deliberately never the "now" of a spec. */
const COMPLETED_AT = new Date("2026-01-01T00:00:00.000Z");
/** A ban expiry far in the future, so the ban is active at test time. */
const NEVER = new Date("2099-01-01T00:00:00.000Z");

/**
 * A private database shared by the spec's auth instance and the route's
 * singletons. Uniquely named per run so a stale run can never leak into this
 * one.
 */
const DB_NAME = `openpic_me_ban_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

/**
 * Point a MongoDB connection string at `dbName`, preserving any options.
 *
 * @param uri - The replica-set URI published by the integration globalSetup.
 * @param dbName - The database the singleton client should default to.
 * @returns A URI whose default database is `dbName`.
 */
function uriWithDb(uri: string, dbName: string): string {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

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
    email: `op86-me-ban-${serial}@example.com`,
    phone: `+919****0000${serial}`,
    ip: `203.0.113.${String(identitySeq)}`,
  };
}

beforeAll(async () => {
  const uri = requireMongoTestUri();

  // Rebuild the singleton client from this file's configuration: a previous
  // file in the same worker may have left a client bound to the shared URI.
  await closeMongoClient();

  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: uriWithDb(uri, DB_NAME),
        RATE_LIMIT_PROVIDER: "memory",
        MESSAGE_TRANSPORT: "memory",
      })
    )
  );

  // Built inside the hook so they read this file's configuration, not an
  // earlier file's environment.
  database = getDb();
  auth = createAuth({ db: database });

  // Cold connect / replica-set discovery / primary election belong in this
  // hook, never inside a timed spec.
  await waitForMongoReady();

  // Sanity: the singletons must be bound to this spec's private database, or
  // the route would read a database no session was written to.
  expect(database.databaseName).toBe(DB_NAME);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await getDb().dropDatabase();
  await closeMongoClient();
});

let database: Db;
let auth: AuthLike;

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

/** Sign in with a valid email OTP; returns the session cookie pair. */
async function signInWithEmailOtp(identity: Identity): Promise<string> {
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
  return cookiePair(cookie);
}

/** Read the raw Better Auth user document for an identity. */
async function findUser(identity: Identity): Promise<WithId<Document>> {
  const user = await database.collection("user").findOne({ email: identity.email });
  if (user === null) {
    throw new Error(`no user document for ${identity.email}`);
  }
  return user;
}

/** Insert the `userProfiles` row the guard must load (schema §13.2). */
async function insertProfile(
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

/** Active-ban a Better Auth user until `NEVER`. */
async function banUser(userId: unknown): Promise<void> {
  await database.collection("user").updateOne({ _id: userId } as never, {
    $set: { banned: true, banReason: "spam", banExpires: NEVER },
  });
}

/** A GET request carrying the given headers, at the app origin. */
function requestWith(headers: Record<string, string> = {}, path = ROUTE): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "GET", headers });
}

/**
 * A route whose only job is to expose what the guard decided, built on the same
 * auth/database the real `/me` handler reads.
 */
function guardRoute(label: "user"): RouteHandler {
  return defineRoute({
    route: ROUTE,
    response: z.object({ principal: z.string().nullable() }),
    env: "test",
    auth: requireAuth(label, { auth, database }),
    handler: (ctx) => ({ body: { principal: ctx.principal ?? null } }),
  });
}

/** The error envelope a guard denial is projected onto. */
interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

describe("ban exemption on the shipped GET /api/v1/me (§0.3)", () => {
  it("I9: a banned user is 200 on GET /api/v1/me and 423 on a non-exempt route", async () => {
    const identity = makeIdentity();
    const cookie = await signInWithEmailOtp(identity);
    const user = await findUser(identity);
    await insertProfile(user._id, { accountCompletedAt: COMPLETED_AT });
    await banUser(user._id);

    // The rule has two halves and both must be pinned with the same banned
    // session: a non-exempt route denies with 423 account_banned...
    const normal = await guardRoute("user")(requestWith({ cookie }));
    expect(normal.status).toBe(423);
    const envelope = (await body(normal)) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("account_banned");

    // ...while the shipped `/me` route is on the exemption list and must allow
    // the banned user through (contract §0.3). The response BODY is OP-88's
    // contract; only the reachability of the exempt route is pinned here.
    const me = await meGet(requestWith({ cookie }, ME_PATH));
    expect(me.status).toBe(200);
  });
});
