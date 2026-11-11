import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { requirePrincipal, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { eventMemberListSchema, type EventMember } from "@/server/events/member-schema";
import { listEventMembers } from "@/server/events/members";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { userAuth } from "@/server/tenancy/route-scope";
import { TENANT_ID_HEADER, tenantIdFromRequest } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/events/{eventId}/members` — who works on one
 * event (OP-119, contract §4.3, schema §15.2).
 *
 * Admission is "`user` + event member" (§4.3), which is **not** the same thing
 * as workspace membership: a co-organizer commonly holds no `tenantMembers` row,
 * so the reusable `tenantStage()` would refuse the very people the listing
 * exists to attribute. The route therefore reuses
 * `resolveEventActorRole` (OP-117, `@/server/events/access`), whose
 * `event_organizers` read keeps `revokedAt: null` — a removed worker is **not**
 * admitted and never reads the roster (ADR-0641). An active workspace member is
 * admitted too, but only the event's own members are listed.
 *
 * Every denial is the uniform `404 not_found` (never `403`), so the route is not
 * a cross-workspace oracle (§0.4); no session is `401`. Both the event read and
 * the member read are tenant-scoped, so a mismatched path tenant is simply "not
 * found".
 */

/** A 24-hex `ObjectId`, the only shape a tenant segment may take. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/members",
  response: eventMemberListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (
    ctx
  ): Promise<{ body: { data: EventMember[] }; headers: Record<string, string> }> => {
    const principal = requirePrincipal(ctx);
    const db = getDb();

    const tenantSegment = tenantIdFromRequest(ctx.request);
    if (!OBJECT_ID_HEX.test(tenantSegment)) {
      throw appError("not_found");
    }
    const tenantKey = new ObjectId(tenantSegment).toHexString();
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    // The tenant-scoped read is both the grant's tenant check and the event's
    // existence check: another workspace's event is "not found" here, and a
    // caller who is a workspace member cannot read a phantom event.
    const event = await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId });
    if (event === null) {
      throw appError("not_found");
    }

    if ((await resolveEventActorRole(db, eventId, tenantKey, principal)) === null) {
      throw appError("not_found");
    }

    const data = await listEventMembers(db, tenantKey, eventId);
    return { body: { data }, headers: { [TENANT_ID_HEADER]: tenantKey } };
  },
});
