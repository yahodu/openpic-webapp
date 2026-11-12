import { invitationDecisionSchema } from "@/server/collaboration/invitation-dto";
import { decideByToken } from "@/server/collaboration/invitation-decision-request";
import { defineRoute } from "@/server/http/define-route";

/**
 * `POST /api/v1/invitations/{token}/reject` — reject from the emailed or texted
 * link (OP-121, contract §2.3, schema §13.6).
 *
 * Same authorization as the accept link (`401` with `loginUrl` and the masked
 * invitee, `403 invitation_not_for_you`), and the same finality: a repeat is
 * `200` with `alreadyResolved: true`, and nothing is granted.
 */
export const POST = defineRoute({
  route: "/api/v1/invitations/:token/reject",
  response: invitationDecisionSchema,
  handler: async (ctx) => ({ body: await decideByToken(ctx.request, "reject") }),
});
