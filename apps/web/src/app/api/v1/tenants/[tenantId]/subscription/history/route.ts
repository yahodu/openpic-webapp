import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  readSubscriptionHistory,
  subscriptionHistorySchema,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/subscription/history` — the subscription
 * status history (OP-106, contract §3.2, schema §14.3; ADR-0400).
 *
 * Answers the support question behind the "nothing was deleted" story — *why is
 * this workspace on free?* — as the §0.5 collection envelope
 * `{ data: statusHistoryEntry[] }`, newest first and capped at 50.
 *
 * The gate order matters: the reusable `tenant` stage runs first, so a
 * non-member is the uniform `404 not_found` (never an existence oracle), and
 * only then is the role checked — a plain `member` is `403 forbidden`, the same
 * shape OP-104's `/usage` uses. A workspace with no subscription document
 * answers the empty list, not a `404`.
 */
export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/subscription/history",
  response: subscriptionHistorySchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }
    const data = await readSubscriptionHistory(getDb(), scope.tenantId.toHexString());
    return { body: { data } };
  },
});
