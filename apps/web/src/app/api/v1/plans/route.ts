import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { ifNoneMatchSatisfied } from "@/server/http/etag";
import { planCatalogueETag } from "@/server/plans/plan-etag";
import { projectPlan, servedPlanListSchema } from "@/server/plans/plan-projection";
import { planSchema } from "@/server/plans/plans";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/plans` (contract §3.1; schema §14.1; ADR-0320).
 *
 * The public pricing page is driven by this catalogue so pricing copy changes
 * need no deploy. The route is **public** (`public, max-age=300`) and
 * rate-limited as a `read.normal` read keyed on the caller (the hashed client
 * IP for an anonymous caller, §0.11), and answers `{ data: Plan[] }`:
 *
 *   - only **active** plans, ascending `tierRank` (so "upgrade or downgrade?"
 *     is a comparison);
 *   - each entitlement served verbatim plus a synthesised `display`;
 *   - each price filtered to `active: true` and to the `currency`/`billingCycle`
 *     query, projected without its lifecycle fields and **never** with
 *     `externalRefs` (§0.15);
 *   - `contactSalesUrl` on the sales-assisted tiers.
 *
 * `?includeInactive=true` is **ignored** on this public route (ADR-0320): a
 * caller who is not a platform admin simply never sees a retired plan, and the
 * response is still `200` with the active catalogue. The admin surface
 * (`/admin/plans`, §9.3) is where full documents, including `externalRefs`, are
 * read.
 *
 * The `ETag` is a function of the served plans' **versions** (ADR-0320), so a
 * matching `If-None-Match` answers a bodyless `304` and an entitlement change
 * invalidates every cached copy.
 */

/** The §3.1 cache policy: publicly cacheable for five minutes. */
const CACHE_CONTROL = "public, max-age=300";

export const GET = defineRoute({
  route: "/api/v1/plans",
  response: servedPlanListSchema,
  rateLimit: rateLimitStage({
    classKey: "read.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const params = new URL(ctx.request.url).searchParams;
    const filter = {
      currency: params.get("currency"),
      billingCycle: params.get("billingCycle"),
    };

    const documents = await platformRepo(getDb())
      .collection(COLLECTIONS.plans)
      .find({ active: true })
      .sort({ tierRank: 1 })
      .toArray();

    const data = documents.map((document) => projectPlan(planSchema.parse(document), filter));
    const etag = planCatalogueETag(data.map((plan) => ({ key: plan.key, version: plan.version })));
    const headers = { "cache-control": CACHE_CONTROL, etag };

    if (ifNoneMatchSatisfied(ctx.request, etag)) {
      return { status: 304, body: { data: [] }, headers };
    }

    return { body: { data }, headers };
  },
});
