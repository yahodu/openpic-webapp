import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { readAnalyticsSeries, type AnalyticsScopeTarget } from "@/server/analytics/daily";
import { parseAnalyticsQuery } from "@/server/analytics/query";
import { analyticsResponseSchema, type AnalyticsResponse } from "@/server/analytics/schema";
import { reduceAnalyticsTotals } from "@/server/analytics/totals";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/analytics` — the tenant performance series
 * (OP-119, contract §4.5, schema §20.1).
 *
 * `owner`|`admin` only: a `member` is `403 forbidden`, a non-member is the
 * tenant stage's `404` (never a cross-workspace oracle, §0.4) and no session is
 * `401`. The answer is a **pure rollup read** — the days stored in
 * `analyticsDaily` inside `from..to`, oldest first, plus the pure totals
 * reducer — so it never aggregates `eventImages`/`domainEvents` at request time,
 * which is the card's acceptance criterion and the reason request latency does
 * not grow with an event's image count.
 *
 * The `note` is the contract's own caveat: the rollup runs nightly, so today's
 * figures are partial until the next run.
 */

/** The `note` §4.5's worked body carries with every answer. */
const PARTIAL_TODAY_NOTE = "Rolled up nightly. Today's figures are partial.";

/**
 * Resolve the aggregate the request reads, or deny `404`.
 *
 * The tenant scope is the authorised workspace itself. The event scope is
 * checked against the tenant in the path, so another workspace's event is the
 * uniform `404` — the reading that keeps the tenant segment meaningful
 * (ADR-0640 §A8).
 *
 * @param tenantId - The authorised workspace from the tenant stage.
 * @param query - The decoded query.
 * @returns The scope target to read.
 * @throws An `AppError` with code `not_found` when the event does not exist in
 *   this workspace.
 */
async function resolveScopeTarget(
  tenantId: ObjectId,
  query: { readonly kind: "tenant" | "event"; readonly eventId: string | null }
): Promise<AnalyticsScopeTarget> {
  if (query.kind === "tenant" || query.eventId === null) {
    return { kind: "tenant", id: tenantId };
  }

  const eventId = new ObjectId(query.eventId);
  const row = await tenantRepo(tenantId.toHexString())
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId });
  if (row === null) {
    throw appError("not_found");
  }
  return { kind: "event", id: eventId };
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/analytics",
  response: analyticsResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx): Promise<{ body: AnalyticsResponse }> => {
    const scope = requireTenantScope(ctx);
    if (scope.role !== "owner" && scope.role !== "admin") {
      throw appError("forbidden");
    }

    const query = parseAnalyticsQuery(new URL(ctx.request.url).searchParams);
    const db = getDb();
    const target = await resolveScopeTarget(scope.tenantId, query);
    const series = await readAnalyticsSeries(db, target, query.range);

    return {
      body: {
        scope: { kind: target.kind, id: target.id.toHexString() },
        from: query.range.from,
        to: query.range.to,
        series,
        totals: reduceAnalyticsTotals(series),
        computedAt: systemClock.now().toISOString(),
        note: PARTIAL_TODAY_NOTE,
      },
    };
  },
});
