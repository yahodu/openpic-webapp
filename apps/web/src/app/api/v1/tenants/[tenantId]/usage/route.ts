import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { readUsageCounters, usageCountersSchema } from "@/server/services/entitlements";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/usage?periodKey=` — the raw usage counters
 * (OP-104, contract §3.5, schema §14.2; ADR-0360).
 *
 * For support and reconciliation: the unconverted `usageCounters` rows,
 * filtered to `?periodKey=` when supplied, answered as the §0.5 collection
 * envelope `{ data: […] }` and **never** with the driver's `_id`.
 *
 * The role gate is `owner`|`admin` — a plain `member` is `403 forbidden`
 * (support data is not part of a member's surface). Membership itself is still
 * enforced first by the reusable `tenant` stage, so a non-member gets `404`,
 * never a role-dependent `403` (contract §0.4).
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/usage",
  response: usageCountersSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }
    const periodKey = new URL(ctx.request.url).searchParams.get("periodKey");
    const body = await readUsageCounters(
      getDb(),
      scope.tenantId.toHexString(),
      periodKey ?? undefined
    );
    return { body };
  },
});
