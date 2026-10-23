import { defineRoute } from "@/server/http/define-route";
import { getDb } from "@/server/db/mongo";
import { memberListSchema } from "@/server/tenancy/member-schema";
import { listWorkspaceMembers } from "@/server/tenancy/members";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/members` — the workspace member list
 * (OP-101, contract §2.2).
 *
 * Returns every membership as `{ data: Member[] }`, each with a §0.13 **masked**
 * contact — the raw address of another user is never returned (§0.15). The
 * reusable `tenant` stage resolves `current` or an explicit id, authorises an
 * active membership and echoes `X-Tenant-Id`; a non-member is `404 not_found`
 * (never `403`), so the endpoint is not a cross-workspace existence oracle
 * (contract §0.4).
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/members",
  response: memberListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const data = await listWorkspaceMembers(getDb(), scope.tenantId);
    return { body: { data } };
  },
});
