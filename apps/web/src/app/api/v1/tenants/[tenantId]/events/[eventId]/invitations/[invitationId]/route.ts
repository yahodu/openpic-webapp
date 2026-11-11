import { ObjectId } from "mongodb";

import {
  invitationBodySchema,
  type InvitationBody,
  type InvitationRow,
} from "@/server/collaboration/invitation-dto";
import { projectInvitation } from "@/server/collaboration/invitation-access";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { requireEventRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `DELETE /api/v1/tenants/{tenantId}/events/{eventId}/invitations/{invitationId}`
 * — revoke a co-organizer invitation (OP-120, contract §2.3, schema §13.6;
 * ADR-0661).
 *
 * Revocation is the organizer's escape hatch for an invitation that is still
 * `pending` (a wrong address, a mistaken invite): the row moves to `revoked`,
 * `revokedAt`/`revokedByUserId` record who did it, and the redeemable link stops
 * working because the preview reads the row's status.
 *
 * **Idempotent by definition** (§2.3): the first call answers `200` and the
 * second answers `200` again with the same state — a client that retries must
 * not see an error for a state it already reached. The second call therefore
 * does **not** re-stamp `revokedAt` (that would rewrite the audit instant) and
 * never writes a second row. The conditional update is also what makes two
 * concurrent revokes agree: only the writer that finds `status: "pending"`
 * stamps, and the loser re-reads the row the winner left.
 *
 * A co-organizer is refused `403` (only the organizer curates the team), a
 * caller with no relationship to the event `404`, and an invitation belonging
 * to another event or workspace is simply "not found" (the scoped filter is the
 * grant).
 */

/** The invitation status that may still be revoked (§13.6). */
const PENDING = "pending";

/** The invitation status a revocation writes. */
const REVOKED = "revoked";

/** The invitation schema version the row already carries. */
const INVITATION_SCHEMA_VERSION = 1;

/**
 * Read the `{invitationId}` path segment of this request.
 *
 * The id is the last segment; the literal `invitations` precedes it. A segment
 * that is not a 24-hex id cannot name an invitation, so it denies the uniform
 * `404` rather than becoming an existence oracle.
 *
 * @param request - The inbound request.
 * @returns The invitation id.
 * @throws {AppError} `not_found` when the segment is not a valid id.
 */
function invitationIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-1));
  if (!/^[0-9a-f]{24}$/i.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/invitations/:invitationId",
  response: invitationBodySchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx): Promise<{ body: InvitationBody; headers: Record<string, string> }> => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const now = systemClock.now();
    const tenantKey = scope.tenantId.toHexString();
    const actor = scope.userId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const invitationId = invitationIdFromRequest(ctx.request);

    const event = await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId });
    if (event === null) {
      throw appError("not_found");
    }

    await requireEventRole(db, eventId, tenantKey, actor, ["organizer"]);

    const invitations = tenantRepo(tenantKey, db).collection(COLLECTIONS.invitations);
    const scoped = { _id: invitationId, eventId };
    const stored = (await invitations.findOne(scoped)) as InvitationRow | null;
    if (stored === null) {
      throw appError("not_found");
    }

    // Only a `pending` row is stamped: a second revoke matches nothing and the
    // row keeps the audit instant of the call that actually revoked it.
    const revoked = await invitations.updateOne(
      { ...scoped, status: PENDING },
      {
        $set: {
          status: REVOKED,
          revokedAt: now,
          revokedByUserId: new ObjectId(actor),
          revokeReason: null,
          updatedAt: now,
        },
      }
    );

    if (revoked.modifiedCount > 0) {
      // "Mark the in-app actions unavailable" (§2.3): the invitee's feed row for
      // this invitation must stop offering accept/reject now that the link is
      // dead. A replay changes nothing, so it runs only on the transition.
      await tenantRepo(tenantKey, db)
        .collection(COLLECTIONS.notifications)
        .updateMany(
          {
            "actionTarget.kind": "invitation",
            "actionTarget.id": invitationId.toHexString(),
          },
          { $set: { "actionTarget.state": "closed", actions: [], updatedAt: now } }
        );
    }

    const row = (await invitations.findOne(scoped)) as InvitationRow | null;
    if (row === null) {
      throw appError("not_found");
    }

    const status = row.status;
    if (status === PENDING) {
      // The conditional write matched nothing and the row is still pending: an
      // unrelated writer moved it between the two reads. Refuse rather than
      // report a revocation that did not happen.
      throw appError("conflict");
    }

    if (status === REVOKED) {
      await emitDomainEvent(
        {
          eventKey: "collab.invite.revoked",
          tenantId: tenantKey,
          actorRef: { kind: "user", id: actor },
          subjectRef: { kind: "invitation", id: invitationId.toHexString() },
          // One revocation fact per invitation: a retried DELETE must not
          // produce a second notification of the same decision.
          dedupeKey: `collab.invite.revoked:${invitationId.toHexString()}`,
          payload: {
            invitationId: invitationId.toHexString(),
            eventId: eventId.toHexString(),
            schemaVersion: INVITATION_SCHEMA_VERSION,
          },
        },
        { db }
      );
    }

    getLogger().info("invitation revoked", {
      event: "collab.invite.revoked",
      tenantId: tenantKey,
      eventId: eventId.toHexString(),
      invitationId: invitationId.toHexString(),
    });

    return { body: await projectInvitation(db, row), headers: {} };
  },
});
