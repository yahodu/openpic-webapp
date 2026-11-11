import { getDb } from "@/server/db/mongo";
import { admitEventActor } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { eventMemberListSchema, type EventMember } from "@/server/events/member-schema";
import { listEventMembers } from "@/server/events/members";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/events/{eventId}/members` — who works on one
 * event (OP-119, contract §4.3, schema §15.2).
 *
 * Admission is "`user` + event member" (§4.3), which is **not** the same thing
 * as workspace membership: a co-organizer commonly holds no `tenantMembers` row,
 * so the bare workspace check would refuse the very people the listing exists to
 * attribute. The route therefore runs the shared `tenantStage` with the
 * event-scoped `admitEventActor` seam (ADR-0644): `current` is resolved to
 * `userProfiles.primaryTenantId`, the resolved id is echoed in `X-Tenant-Id`, and
 * every denial is the same logged `tenancy.access_denied` `404` — none of that
 * is reimplemented here. The seam reuses OP-117's `resolveEventActorRole`
 * (`@/server/events/access`), whose `event_organizers` read keeps
 * `revokedAt: null`, so a removed worker is **not** admitted and never reads the
 * roster (ADR-0641). An active workspace member is admitted too, but only the
 * event's own members are listed.
 *
 * Every denial is the uniform `404 not_found` (never `403`), so the route is not
 * a cross-workspace oracle (§0.4); no session is `401`. Both the event read and
 * the member read are tenant-scoped, so a mismatched path tenant is simply "not
 * found".
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/members",
  response: eventMemberListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: admitEventActor }),
  handler: async (ctx): Promise<{ body: { data: EventMember[] } }> => {
    const tenantId = ctx.tenantId;
    if (tenantId === undefined) {
      // The tenant stage publishes the resolved workspace or denies; a handler
      // without one is a pipeline wiring error, never a caller error.
      throw appError("internal_error");
    }

    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const data = await listEventMembers(getDb(), tenantId, eventId);

    return { body: { data } };
  },
});
