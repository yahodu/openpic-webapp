import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { requireEventRole } from "@/server/events/access";
import { eventIdAfterEventsSegment } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId}` — remove
 * an accepted co-organizer (OP-121, contract §2.3, schema §15.2).
 *
 * Only the **organizer** curates the team (a co-organizer is `403 forbidden`),
 * and the organizer themself is protected with `409 cannot_remove_organizer` —
 * the event must always keep exactly one organizer.
 *
 * The removal is **structural**, so access really ends: the `event_organizers`
 * row gets `status: "removed"` **and** `revokedAt` (the admission seam filters
 * on `revokedAt: null`, so one without the other would leave the removed member
 * admitted), and the invitation that granted the seat moves to `revoked` so the
 * row cannot be accepted again. Those two writes and the two
 * `collab.member.removed` / `.ack` emits run in one transaction, so a failed
 * removal moves neither row and stays replayable. The removed member and the
 * organizer are both notified, and the answer is `204` with no body.
 */

/** A 24-hex `ObjectId`, the only accepted `{userId}` shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/**
 * The `{userId}` segment of the matched path; a malformed id denies `404`.
 *
 * @param request - The inbound request.
 * @returns The target member's user id.
 */
function targetUserIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-1));
  if (!OBJECT_ID_HEX.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/members/:userId",
  response: noContentSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const now = systemClock.now();
    const tenantKey = scope.tenantId.toHexString();
    const eventId = eventIdAfterEventsSegment(ctx.request);
    const eventIdHex = eventId.toHexString();

    // Organizer-only: a related caller without the role is `403`, a caller with
    // no relationship to the event `404` (never an oracle).
    await requireEventRole(db, eventId, tenantKey, scope.userId, ["organizer"]);

    const targetUserId = targetUserIdFromRequest(ctx.request);
    const targetHex = targetUserId.toHexString();
    const members = platformRepo(db).collection(COLLECTIONS.eventOrganizers);
    // `event_organizers.userId` is the Better Auth id as a hex string (§15.2).
    const member = (await members.findOne({
      tenantId: tenantKey,
      eventId,
      userId: targetHex,
      revokedAt: null,
    })) as { readonly _id?: unknown; readonly role?: unknown } | null;
    if (member === null) {
      throw appError("not_found");
    }
    if (member.role === "organizer") {
      throw appError("cannot_remove_organizer", {
        details: { transferOwnershipUrl: `/events/${eventIdHex}/settings/transfer-ownership` },
      });
    }

    await withTransaction(async (session) => {
      await members.updateOne(
        { _id: member._id },
        { $set: { status: "removed", revokedAt: now, updatedAt: now } },
        { session }
      );

      // Revoke the invitation that granted the seat, so it cannot be re-accepted.
      await tenantRepo(tenantKey, db)
        .collection(COLLECTIONS.invitations)
        .updateMany(
          { eventId, status: "accepted", "invitee.userId": targetHex },
          { $set: { status: "revoked", revokedAt: now, updatedAt: now } },
          { session }
        );

      for (const eventKey of ["collab.member.removed", "collab.member.removed.ack"] as const) {
        await emitDomainEvent(
          {
            eventKey,
            tenantId: tenantKey,
            actorRef: { kind: "user", id: scope.userId },
            subjectRef: { kind: "user", id: targetHex },
            payload: { eventId: eventIdHex, userId: targetHex },
          },
          { db, session }
        );
      }
    });

    getLogger().info("event member removed", {
      event: "collab.member.removed",
      tenantId: tenantKey,
      eventId: eventIdHex,
      userId: targetHex,
    });

    return { status: 204, body: null };
  },
});
