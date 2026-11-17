import { ObjectId, type Db } from "mongodb";

import { appError } from "@/server/http/errors";

import type { ConsentSubject } from "./consent-guard";
import { findRequestAttendeeSession } from "./session-resolver";

/**
 * The data subject behind an attendee request (OP-131/OP-132, contract §0.2,
 * schema §10.3; ADR-0792).
 *
 * The `attendee` label admits two credentials: the anonymous `op_att` session
 * and a signed-in user. The consent, liveness, selfie and reuse routes all need
 * the same answer — whose rows the request is about — so the resolution lives
 * here once. An anonymous session wins over a user session when both are
 * present, because the `op_att` cookie is the credential the attendee workflow
 * minted for this event.
 */

/**
 * The consent subject behind the request.
 *
 * @param db - The database to read `attendeeSessions` from.
 * @param request - The inbound request.
 * @param principal - The authenticated user id, when the caller is signed in.
 * @returns The subject the attendee's rows belong to.
 * @throws {AppError} `authentication_required` when neither credential resolves.
 */
export async function subjectForRequest(
  db: Db,
  request: Request,
  principal: string | undefined
): Promise<ConsentSubject> {
  const session = await findRequestAttendeeSession({ database: db }, request);
  if (session !== null) {
    return { kind: "anonymous", attendeeSessionId: session._id.toHexString() };
  }
  if (principal !== undefined) {
    return { kind: "user", userId: new ObjectId(principal) };
  }
  throw appError("authentication_required");
}
