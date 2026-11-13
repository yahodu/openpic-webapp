import { getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import type { RouteIdentityStage } from "@/server/http/define-route";
import {
  createRateLimiter,
  rateLimitStage,
  resolveClientIp,
  type RateLimitClass,
} from "@/server/rate-limit";

import { findRequestAttendeeSession } from "./session-resolver";

/**
 * The attendee-keyed rate-limit stage (OP-132, contract §0.11, §6.3, ADR-0792).
 *
 * `selfie.submit` and `liveness.challenge` are keyed by the **attendee**, so the
 * stage runs after auth and keys on the server-validated identity only: the
 * `X-Attendee-Session` header is a client-supplied value and must never pick its
 * own bucket. A signed-in caller's identity is `ctx.principal`; an
 * anonymous one carries no principal at all, so its `op_att` session is
 * re-resolved here — the same one indexed `tokenHash` lookup the session read
 * already pays, and the only way an attendee-only class can be keyed at all.
 *
 * The classes stay fail-closed (§0.11): an unattributable request is refused
 * rather than admitted unlimited.
 */

/** One limiter per process, so a window survives across requests. */
const limiter = createRateLimiter();

/**
 * Build the post-auth identity stage for one attendee-scoped class.
 *
 * @param classKey - The §0.11 class to enforce.
 * @returns A stage the route declares as `rateLimitIdentity`.
 */
export function attendeeRateLimitStage(
  classKey: Extract<RateLimitClass, "selfie.submit" | "liveness.challenge">
): RouteIdentityStage {
  const salt = getRateLimitConfig().salt;
  return async (ctx, request) => {
    const sessionId =
      ctx.principal ?? (await findRequestAttendeeSession({ database: getDb() }, request))?._id;
    const ip = resolveClientIp(request.headers, getTrustedClientIpHeader());
    return rateLimitStage({
      classKey,
      limiter,
      salt,
      facts: {
        ...(sessionId === undefined ? {} : { attendeeSessionId: String(sessionId) }),
        ...(ip === undefined ? {} : { ip }),
      },
    })(ctx, request);
  };
}
