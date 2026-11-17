import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `DELETE /api/v1/tenants/{tenantId}/billing/scheduled-change` — cancel a
 * pending period-end plan change (OP-109, contract §3.3; ADR-0460).
 *
 * The symmetric half of the downgrade: it clears `scheduledChange` on the
 * workspace's live row and nothing else — the subscription itself is untouched
 * (only a *pending change* is gone). §3.3 shows only the `204`; the route is
 * idempotent, so a workspace with nothing scheduled is still `204`.
 */

/** The empty body a `204` serves (the pipeline short-circuits before serialization). */
const noContentSchema = z.null();

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/scheduled-change",
  response: noContentSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    // §3.3 makes every billing mutation owner-only.
    if (scope.role !== "owner") {
      throw appError("forbidden");
    }

    const db = getDb();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();

    await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.subscriptions)
      .updateOne({ cancelledAt: null }, { $set: { scheduledChange: null, updatedAt: now } });

    getLogger().info("billing scheduled change cancelled", {
      event: "billing.plan.scheduled_change_cancelled",
      tenantId,
    });

    return { status: 204, body: null };
  },
});
