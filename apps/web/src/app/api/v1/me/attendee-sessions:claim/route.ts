import { z } from "zod";

import { claimAttendeeSession } from "@/server/attendee/claim";
import { attendeeTokenFrom } from "@/server/attendee/session-resolver";
import { buildAttendeeSessionCookie } from "@/server/attendee/session-cookie";
import { getAuth } from "@/server/auth";
import { buildCookieOptions } from "@/server/auth/cookies";
import { requireAuth } from "@/server/auth/guards";
import { getAppEnv } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { optionalJsonBody } from "@/server/http/optional-json-body";

/**
 * `POST /api/v1/me/attendee-sessions:claim` — link an anonymous attendee
 * session to the signed-in account (OP-134, contract §6.7, §0.2, schema §13.5,
 * §15.3; ADR-0815).
 *
 * This is the PRD's *"she doesn't have to re-visit and re-upload"*: the claim
 * re-points every anonymous profile of the session at the caller, moving no
 * data and reprocessing nothing (see {@link claimAttendeeSession}).
 *
 * Auth is `user` (Appendix D: identified attendees only). The session is named
 * by the body's `sessionToken` when present, else by the `op_att` cookie the
 * browser still holds. The owner calling twice is a `200` no-op; a **different**
 * account gets `409 session_claimed_by_other_user`, because a second account
 * must never reach the first person's photos.
 *
 * The answer clears `op_att` — an expired cookie with an empty value, in the
 * session cookie's own attribute set, so a browser cannot end up holding two
 * differently-scoped `op_att` cookies.
 */

/** The claim body: the token is optional, the cookie being the usual source. */
const claimBodySchema = z.object({ sessionToken: z.string().min(1).optional() });

/** One re-pointed event, as §6.7 shows it. */
const claimedEventSchema = z.object({
  eventId: z.string(),
  eventName: z.string(),
  profileId: z.string(),
  matchCount: z.number().int().nonnegative(),
  galleryUrl: z.string(),
});

/** One event the caller already owned. */
const skippedEventSchema = z.object({
  eventId: z.string(),
  reason: z.string(),
});

/** The §6.7 answer — exactly the two documented keys. */
const claimResponseSchema = z.object({
  claimed: z.array(claimedEventSchema),
  skipped: z.array(skippedEventSchema),
});

/** The body of a request that names no session at all. */
function missingSessionToken(): Error {
  return appError("validation_failed", {
    details: {
      fields: [
        {
          path: "sessionToken",
          code: "required",
          message: "send a token or present the op_att cookie",
        },
      ],
    },
  });
}

export const POST = defineRoute({
  route: "/api/v1/me/attendee-sessions:claim",
  response: claimResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const { principal } = ctx;
    if (principal === undefined) {
      // The `user` auth stage always publishes the principal, or denies.
      throw appError("internal_error");
    }

    // §6.7's body is optional — the cookie is the usual source, so the stream
    // is read here rather than declared as `body:`, which would answer a
    // bodyless request `415`.
    const body = await optionalJsonBody(ctx.request, claimBodySchema);
    const token = body?.sessionToken ?? attendeeTokenFrom(ctx.request);
    if (token === null || token === "") {
      throw missingSessionToken();
    }

    const result = await claimAttendeeSession({ db: getDb(), userId: principal, token });
    if (result.outcome === "conflict") {
      throw appError("session_claimed_by_other_user");
    }

    return {
      body: { claimed: [...result.claimed], skipped: [...result.skipped] },
      headers: {
        "set-cookie": buildAttendeeSessionCookie({
          token: "",
          maxAgeSeconds: 0,
          secure: buildCookieOptions(getAppEnv()).useSecureCookies,
        }),
      },
    };
  },
});
