import { invitationDecisionSchema } from "@/server/collaboration/invitation-dto";
import { decideByToken } from "@/server/collaboration/invitation-decision-request";
import { defineRoute } from "@/server/http/define-route";

/**
 * `POST /api/v1/invitations/{token}/accept` — accept from the emailed or
 * texted link (OP-121, contract §2.3, schema §13.6).
 *
 * Auth is `public` in the pipeline because the landing page must work for a
 * signed-out visitor; the route resolves the session itself so an unauthenticated
 * caller gets `401 authentication_required` carrying `loginUrl` and the masked
 * invitee — with the token left unconsumed. `?via=sms` records the SMS channel;
 * the default is `email`. A signed-in caller who is not the invitee is `403
 * invitation_not_for_you`; the invitee's second click is `200` with
 * `alreadyResolved: true`.
 */
export const POST = defineRoute({
  route: "/api/v1/invitations/:token/accept",
  response: invitationDecisionSchema,
  handler: async (ctx) => ({ body: await decideByToken(ctx.request, "accept") }),
});
