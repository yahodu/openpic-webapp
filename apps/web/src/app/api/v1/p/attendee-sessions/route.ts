import type { Db, ObjectId } from "mongodb";
import { z } from "zod";

import { buildAttendeeSessionCookie } from "@/server/attendee/session-cookie";
import {
  generateAttendeeSessionToken,
  hashAttendeeSessionToken,
} from "@/server/attendee/session-token";
import { buildCookieOptions } from "@/server/auth/cookies";
import { hashFingerprint } from "@/server/auth/device-fingerprint";
import { getAppEnv, getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { resolveClientIp } from "@/server/rate-limit/client-ip";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/p/attendee-sessions` — create an anonymous attendee session
 * (OP-129, contract §1.5, schema §13.5; ADR-0769, ADR-0770).
 *
 * The attendee has no account, so the session **is** the credential: the route
 * mints an `opat_` token, stores only its SHA-256 (plus a hashed device
 * fingerprint) and returns the raw token exactly once — in the body for native
 * clients and in the `op_att` cookie for the browser. The TTL follows
 * `platformSettings.retention.attendeeSessionDays`, so the row's `expireAt`, the
 * body's `expiresAt` and the cookie's `Max-Age` can never disagree.
 *
 * `Secure` is environment-scoped for the same reason the Better Auth cookie's is
 * (`buildCookieOptions`): a browser drops a `Secure` cookie on a plain-HTTP
 * origin, which would break local development and the e2e journey.
 */

/** The create body (contract §1.5): the optional slug of the event to bind. */
const createBodySchema = z.object({ eventSlug: z.string().min(1).optional() });

/** The §1.5 create response — exactly three keys. */
const createdSessionSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string(),
  issuedAt: z.string(),
});

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000;

/** Seconds in one day. */
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The events an `eventSlug` names, as the row's `eventIds`.
 *
 * A slug that matches no event is `404 not_found` rather than a silently
 * unbound session: the attendee would otherwise believe their selfie was
 * attached to an event it never reached (ADR-0770).
 *
 * @param db - The database to read `events` from.
 * @param slug - The optional `accessLinks[].slug` from the body.
 * @returns The bound event ids (`[]` when no slug was given).
 * @throws {AppError} `not_found` when the slug matches no event.
 */
async function eventIdsFor(db: Db, slug: string | undefined): Promise<ObjectId[]> {
  if (slug === undefined) {
    return [];
  }
  const event = (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .findOne({ "accessLinks.slug": slug }, { projection: { _id: 1 } })) as {
    readonly _id: ObjectId;
  } | null;
  if (event === null) {
    throw appError("not_found");
  }
  return [event._id];
}

/**
 * Hash the three device components the schema records (schema §13.5).
 *
 * Each part is hashed on its own with the deployment salt, so the row can be
 * correlated without retaining a reversible IP or user-agent.
 *
 * @param request - The inbound request.
 * @returns The `{ uaHash, ipHash, acceptLangHash }` triple.
 */
function deviceFingerprint(request: Request): {
  uaHash: string;
  ipHash: string;
  acceptLangHash: string;
} {
  const salt = getRateLimitConfig().salt;
  const ip = resolveClientIp(request.headers, getTrustedClientIpHeader());
  return {
    uaHash: hashFingerprint({ userAgent: request.headers.get("user-agent") }, salt),
    ipHash: hashFingerprint({ ip: ip ?? null }, salt),
    acceptLangHash: hashFingerprint(
      { acceptLanguage: request.headers.get("accept-language") },
      salt
    ),
  };
}

export const POST = defineRoute({
  route: "/api/v1/p/attendee-sessions",
  body: createBodySchema,
  response: createdSessionSchema,
  handler: async (ctx) => {
    const db = getDb();
    const settings = await getPlatformSettings({ db });
    const now = systemClock.now();
    const ttlDays = settings.retention.attendeeSessionDays;
    // One TTL source: the cookie's Max-Age and the row's expireAt cannot drift.
    const ttlSeconds = ttlDays * SECONDS_PER_DAY;
    const expiresAt = new Date(now.getTime() + ttlSeconds * MS_PER_SECOND);
    const token = generateAttendeeSessionToken();
    const eventIds = await eventIdsFor(db, ctx.body.eventSlug);

    await platformRepo(db)
      .collection(COLLECTIONS.attendeeSessions)
      .insertOne({
        tokenHash: hashAttendeeSessionToken(token),
        claimedByUserId: null,
        claimedAt: null,
        eventIds,
        deviceFingerprint: deviceFingerprint(ctx.request),
        createdAt: now,
        lastSeenAt: now,
        expireAt: expiresAt,
      });

    return {
      status: 201,
      body: {
        sessionToken: token,
        expiresAt: expiresAt.toISOString(),
        issuedAt: now.toISOString(),
      },
      headers: {
        "set-cookie": buildAttendeeSessionCookie({
          token,
          maxAgeSeconds: ttlSeconds,
          secure: buildCookieOptions(getAppEnv()).useSecureCookies,
        }),
      },
    };
  },
});
