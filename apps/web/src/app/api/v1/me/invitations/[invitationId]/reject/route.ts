import { invitationDecisionSchema } from "@/server/collaboration/invitation-dto";
import { decideInApp } from "@/server/collaboration/invitation-decision-request";
import { requirePrincipal } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/me/invitations/{invitationId}/reject` — reject a co-organizer
 * invitation from the in-app feed (OP-121, contract §2.3, schema §13.6).
 *
 * Final and idempotent: the first call is `200`, every replay is `200` with
 * `alreadyResolved: true`. A reject after an accept answers the accept — a late
 * click never undoes a decision.
 */
export const POST = defineRoute({
  route: "/api/v1/me/invitations/:invitationId/reject",
  response: invitationDecisionSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => ({
    body: await decideInApp(requirePrincipal(ctx), ctx.request, "reject"),
  }),
});
