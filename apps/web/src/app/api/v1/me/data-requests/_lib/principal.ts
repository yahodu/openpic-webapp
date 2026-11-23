import {
  findRequestAttendeeSession,
  type AttendeeSessionRow,
} from "@/server/attendee/session-resolver";
import { getAuth } from "@/server/auth";
import { enforceAuth, resolvePrincipal } from "@/server/auth/guards";
import { verifyDsrReceipt } from "@/server/compliance/receipt";
import { getConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/app-error";
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

/** True for the two `AppError`s that mean "this request carries no usable session". */
function isMissingCredential(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "unauthenticated" || error.code === "attendee_session_expired")
  );
}

/**
 * The live attendee session a request names, or `null`.
 *
 * A lapsed session is `null` here rather than the shipped
 * `attendee_session_expired`, because the receipt read must not be denied by the
 * row that has already expired (contract §8.1).
 *
 * @param request - The inbound request.
 * @returns The live stored row, or `null` when neither credential names one.
 */
export async function liveAttendeeSession(request: Request): Promise<AttendeeSessionRow | null> {
  try {
    return await findRequestAttendeeSession({ database: getDb() }, request);
  } catch (error: unknown) {
    if (isMissingCredential(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * The credential the detail read accepts: a `?receipt=` token takes precedence
 * over a missing or lapsed session credential, or else {@link dsrAuth}
 * (contract §8.1).
 *
 * A receipt must outlive the `op_att` session that filed the request, so with
 * one on the query neither a lapsed row nor no row at all is a denial. A live
 * credential still runs its own rules and still owns its own reads.
 */
export const dsrReadAuth: RouteStage = async (ctx, request) => {
  const receipt = new URL(request.url).searchParams.get("receipt");
  if (receipt === null) {
    return dsrAuth(ctx, request);
  }
  if (!verifyDsrReceipt(receipt, getConfig().internal.apiSecret).valid) {
    throw appError("unauthenticated");
  }
  try {
    await dsrAuth(ctx, request);
  } catch (error: unknown) {
    if (!isMissingCredential(error)) {
      throw error;
    }
  }
  return undefined;
};
