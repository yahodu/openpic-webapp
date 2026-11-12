import { invitationDecisionSchema } from "@/server/collaboration/invitation-dto";
import { decideInApp } from "@/server/collaboration/invitation-decision-request";
import { requirePrincipal } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/me/invitations/{invitationId}/accept` — accept a co-organizer
 * invitation from the in-app feed (OP-121, contract §2.3, schema §13.6).
 *
 * The first call performs the conditional transition and is `200`; every replay
 * is `200` again with `alreadyResolved: true` — a double click never errors.
 * `410` for a revoked or expired invitation, `403 invitation_not_for_you` for
 * another user's invitation, `404` for an id that names no row.
 */
export const POST = defineRoute({
  route: "/api/v1/me/invitations/:invitationId/accept",
  response: invitationDecisionSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => ({
    body: await decideInApp(requirePrincipal(ctx), ctx.request, "accept"),
  }),
});
