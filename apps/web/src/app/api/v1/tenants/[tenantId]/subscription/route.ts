import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { systemClock } from "@/server/runtime/clock";
import {
  buildSubscriptionActions,
  readSubscriptionView,
  subscriptionViewSchema,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/subscription` — the single subscription view
 * (OP-106, contract §3.2, schema §14.3; ADR-0400).
 *
 * The one read every billing surface renders: the stored subscription, a
 * computed `actions` block (what the caller may do) and a computed `banner`
 * (the reassuring line the organizer sees). It answers the §3.2 body **bare**
 * (§0.5: a single resource), and a workspace with no `subscriptions` document
 * is the explicit free state (`exists: false`, `status: "none"`) — never a
 * `404`.
 *
 * The reusable `tenant` stage resolves `current` or an explicit id, authorises
 * an active membership and echoes `X-Tenant-Id`; a signed-in caller with no
 * membership is the uniform `404 not_found` (billing is never visible to
 * event-only roles), while any workspace member may read the body (§3.3's
 * mutations are what is `owner`-only, and the `actions` block reflects that).
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/subscription",
  response: subscriptionViewSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const view = await readSubscriptionView(
      getDb(),
      scope.tenantId.toHexString(),
      systemClock.now()
    );
    return {
      body: {
        ...view,
        actions: buildSubscriptionActions({
          status: view.status,
          mandateStatus: view.mandateStatus ?? null,
          role: scope.role,
        }),
      },
    };
  },
});
