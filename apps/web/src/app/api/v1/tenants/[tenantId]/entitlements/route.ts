import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { systemClock } from "@/server/runtime/clock";
import { entitlementsSchema, readEntitlementsView } from "@/server/services/entitlements";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/entitlements` — the advisory entitlements
 * view (OP-104, contract §3.5, schema §14.2/§14.3; ADR-0360).
 *
 * The one call behind every quota bar, disabled button and upgrade tooltip,
 * readable by any workspace `member`. It answers the §3.5 body **bare** (§0.5,
 * a single resource) and is **advisory only**: it performs no write, and the
 * server re-checks at write time (§0.14).
 *
 * The reusable `tenant` stage resolves `current` or an explicit id, authorises
 * an active membership and echoes `X-Tenant-Id`; a non-member is `404
 * not_found` (never `403`), so the endpoint is not a cross-workspace existence
 * oracle (contract §0.4).
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/entitlements",
  response: entitlementsSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const body = await readEntitlementsView(
      getDb(),
      scope.tenantId.toHexString(),
      systemClock.now()
    );
    return { body };
  },
});
