import { ObjectId } from "mongodb";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventDtoSchema, toEventDto, type EventRow } from "@/server/events/dto";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { eventETag } from "@/server/http/etag";
import { tenantRepo } from "@/server/repos";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET /api/v1/tenants/{tenantId}/events/{eventId}` — read one event
 * (OP-115 E1, contract §4.1).
 *
 * The e2e journey reads the created event back through this tenant-scoped
 * read: same auth + tenant stage as the create route, `200` with the full
 * Event DTO and the event's `ETag`, `404` for an id this tenant does not own
 * (never a cross-tenant oracle, contract §0.4).
 */

/** The `{eventId}` segment of the matched path; a malformed id denies `404`. */
function eventIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-1) ?? "";
  if (!/^[0-9a-f]{24}$/i.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId",
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const config = getConfig();
    const tenantKey = scope.tenantId.toHexString();
    const eventId = eventIdFromRequest(ctx.request);

    const row = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventRow | null;
    if (row === null) {
      throw appError("not_found");
    }

    const dto = toEventDto(row, config.app.baseUrl);
    if (dto === null) {
      throw appError("not_found");
    }

    const updatedAt = row.updatedAt;
    const schemaVersion = row.schemaVersion;
    return {
      body: dto,
      headers: {
        etag: eventETag(
          updatedAt instanceof Date ? updatedAt : new Date(),
          typeof schemaVersion === "number" ? schemaVersion : 1
        ),
      },
    };
  },
});
