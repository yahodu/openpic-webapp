import { ObjectId, type Db } from "mongodb";

import type { AttendeeSessionResolver } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

import { hashAttendeeSessionToken } from "./session-token";

/**
 * The attendee session resolver (OP-129, contract §1.5 + §0.2 `attendee` label,
 * schema §13.5).
 *
 * It implements the OP-86 `AttendeeSessionResolver` port: the `op_att` cookie
 * (web) or the `X-Attendee-Session` header (mobile) is hashed and matched
 * against `attendeeSessions.tokenHash`. The three outcomes are deliberately
 * distinct, because a client can only choose the right recovery path when it
 * can tell them apart:
 *
 *   - no credential, or a token that matches no row → `null` (the guard then
 *     answers `401 authentication_required`);
 *   - a token whose session has lapsed → throws `attendee_session_expired`
 *     with `details.recreateUrl`, so the attendee is told to re-create a
 *     session and re-upload a selfie (ADR-0769 §3);
 *   - otherwise the principal, carrying the session id.
 *
 * Expiry is inclusive (`now >= expireAt`), matching the MongoDB TTL monitor.
 */

/** Where a client re-creates a lapsed session (contract §1.5 `recreateUrl`). */
const RECREATE_URL = "/p";

/** The mobile credential header (contract §0.2). */
const SESSION_HEADER = "x-attendee-session";

/** The stored row fields this module reads (schema §13.5). */
export interface AttendeeSessionRow {
  readonly _id: ObjectId;
  readonly tokenHash: string;
  readonly claimedByUserId: ObjectId | null;
  readonly eventIds: readonly ObjectId[];
  readonly expireAt: Date;
}

/** Options accepted by {@link findAttendeeSession} and the resolver factory. */
export interface AttendeeSessionLookupOptions {
  /** The database holding `attendeeSessions`. */
  readonly database: Db;
  /** The clock expiry is compared against; defaults to the system clock. */
  readonly clock?: Clock;
}

/** The raw token on a request: the cookie first, then the mobile header. */
function cookieToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === "op_att") {
      return pair.slice(separator + 1).trim();
    }
  }
  return null;
}

/**
 * The attendee token a request presents, if any.
 *
 * @param request - The inbound request.
 * @returns The raw token, or `null` when the request carries neither credential.
 */
export function attendeeTokenFrom(request: Request): string | null {
  return cookieToken(request) ?? request.headers.get(SESSION_HEADER);
}

/**
 * Read the session a raw token names.
 *
 * @param options - The database and an optional clock.
 * @param token - The raw token a client presented.
 * @returns The stored row, or `null` when the token matches nothing.
 * @throws {AppError} `attendee_session_expired` when the row has lapsed.
 */
export async function findAttendeeSession(
  options: AttendeeSessionLookupOptions,
  token: string
): Promise<AttendeeSessionRow | null> {
  const row = (await platformRepo(options.database)
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) })) as AttendeeSessionRow | null;

  if (row === null) {
    return null;
  }
  if ((options.clock ?? systemClock).now().getTime() >= row.expireAt.getTime()) {
    throw appError("attendee_session_expired", { details: { recreateUrl: RECREATE_URL } });
  }
  return row;
}

/**
 * Build the `AttendeeSessionResolver` the `attendee` auth label consumes.
 *
 * @param options - The database and an optional clock.
 * @returns A resolver that reads the cookie or the mobile header.
 */
export function createAttendeeSessionResolver(
  options: AttendeeSessionLookupOptions
): AttendeeSessionResolver {
  return {
    resolve: async (request: Request) => {
      const token = attendeeTokenFrom(request);
      if (token === null) {
        return null;
      }
      const session = await findAttendeeSession(options, token);
      if (session === null) {
        return null;
      }
      return {
        kind: "attendee",
        sessionId: session._id.toHexString(),
        eventId: session.eventIds[0]?.toHexString() ?? null,
      };
    },
  };
}
