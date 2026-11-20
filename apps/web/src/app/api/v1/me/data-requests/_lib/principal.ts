import { getAuth } from "@/server/auth";
import { enforceAuth, resolvePrincipal } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { appError } from "@/server/http/errors";
import type { RouteStage } from "@/server/http/define-route";
import { systemClock } from "@/server/runtime/clock";

/**
 * The `user` OR `attendee` credential the two `/me/data-requests` reads share
 * (OP-138, contract §8.1; ADR-0899, ADR-0902 §5).
 *
 * §0.3 lets an attendee session satisfy only the `attendee` label and a user
 * only the user labels, so neither single label admits both. The stage resolves
 * the principal itself: a missing credential is `401 unauthenticated`, an
 * account runs the `user` rules with the §0.3 ban exemption (a statutory right
 * is never gated on the ban), and an anonymous session is admitted as-is. The
 * user id is published on `ctx.principal`, an attendee session's row id on
 * `ctx.attendeeSessionId`, so a handler reads the credential this stage already
 * resolved instead of paying for the same `attendeeSessions` lookup twice.
 */
export const dsrAuth: RouteStage = async (ctx, request) => {
  const database = getDb();
  const principal = await resolvePrincipal(request, { auth: getAuth(), database });

  if (principal === null) {
    throw appError("unauthenticated");
  }

  if (principal.kind === "user") {
    enforceAuth(
      "user",
      { principal, now: systemClock.now(), allowBanned: true },
      request,
      ctx.route
    );
    Object.assign(ctx, {
      principal: principal.userId,
      ...(principal.sessionId === null || principal.sessionId === undefined
        ? {}
        : { sessionId: principal.sessionId }),
    });
  } else {
    Object.assign(ctx, { attendeeSessionId: principal.sessionId });
  }

  return undefined;
};
