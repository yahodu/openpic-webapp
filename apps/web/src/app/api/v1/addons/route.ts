import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { ifNoneMatchSatisfied } from "@/server/http/etag";
import {
  addonCatalogueETag,
  projectAddon,
  servedAddonListSchema,
  storedAddonSchema,
} from "@/server/plans/addons";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/addons` (contract §3.6; ADR-0320).
 *
 * A top-up an organizer can buy is catalogue-as-data, a peer of `plans`, so the
 * public pricing page lists the orderable add-ons next to the tiers. The route
 * is **public** (`public, max-age=300`) and rate-limited as a `read.normal` read
 * keyed on the caller (§0.11), and answers `{ data: Addon[] }` from the
 * platform-scope `addons` collection:
 *
 *   - only **active** add-ons are served (a retired top-up is hidden);
 *   - `prices` follows `GET /plans` — `active: true`, optionally filtered to the
 *     `currency` query, projected without `validFrom`/`validUntil` and **never**
 *     with `externalRefs` (§0.15);
 *   - each add-on carries a non-empty `display` string.
 *
 * The endpoint is separate from `GET /plans` (ADR-0320) so the `GET /plans` body
 * stays the strict §3.1 Plan list and each catalogue carries its own cache/ETag
 * without versioning the other.
 */

/** The §3.6 cache policy: publicly cacheable for five minutes. */
const CACHE_CONTROL = "public, max-age=300";

export const GET = defineRoute({
  route: "/api/v1/addons",
  response: servedAddonListSchema,
  rateLimit: rateLimitStage({
    classKey: "read.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const params = new URL(ctx.request.url).searchParams;
    const currency = params.get("currency");

    const documents = await platformRepo(getDb())
      .collection(COLLECTIONS.addons)
      .find({ active: true })
      .sort({ _id: 1 })
      .toArray();

    const data = documents.map((document) =>
      projectAddon(storedAddonSchema.parse(document), currency)
    );
    const etag = addonCatalogueETag(data);
    const headers = { "cache-control": CACHE_CONTROL, etag };

    if (ifNoneMatchSatisfied(ctx.request, etag)) {
      return { status: 304, body: { data: [] }, headers };
    }

    return { body: { data }, headers };
  },
});
