import { ObjectId } from "mongodb";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventDtoSchema, toEventDto, type EventRow } from "@/server/events/dto";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { eventETag } from "@/server/http/etag";
import { platformRepo } from "@/server/repos";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `GET /api/v1/events/{eventId}` — the global event detail (OP-116 I2/I4,
 * contract §4.1; ADR-0560).
 *
 * The organizer browses an event's detail, windows and pipeline status from
 * the global path so a **co-organizer** — a caller recorded in
 * `event_organizers` (`role: "co_organizer"`) who is *not* necessarily a
 * tenant member — can read the shared event through the event-membership path.
 * A tenant member of the event's tenant is admitted through the tenant path.
 *
 * A caller with no relationship to the event — including an event belonging
 * to another tenant — receives `404`, never a `403` (contract §0.4: the
 * endpoint must not become a cross-tenant existence oracle). The response is
 * the full Event DTO plus the event's quoted `ETag`
 * (`eventETag(updatedAt, schemaVersion)`), so a later conditional write can
 * present the value it read back in `If-Match`.
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

/** The stored `events` row fields the global detail read needs beyond the DTO. */
interface EventDetailRow extends EventRow {
  readonly tenantId: string;
}

export const GET = defineRoute({
  route: "/api/v1/events/:eventId",
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }
    const db = getDb();
    const config = getConfig();
    const eventId = eventIdFromRequest(ctx.request);

    const row = (await platformRepo(db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventDetailRow | null;
    if (row === null) {
      throw appError("not_found");
    }

    // A tenant member of the event's tenant, or a co-organizer recorded in
    // `event_organizers` (`role: "co_organizer"`, not necessarily a member).
    const userObjectId = new ObjectId(principal);
    const tenantId = new ObjectId(row.tenantId);
    const [membership, coOrganizer] = await Promise.all([
      platformRepo(db).collection(COLLECTIONS.tenantMembers).findOne({
        tenantId,
        userId: userObjectId,
        status: "active",
      }),
      platformRepo(db).collection(COLLECTIONS.eventOrganizers).findOne({
        eventId,
        userId: principal,
        role: "co_organizer",
        revokedAt: null,
      }),
    ]);
    if (membership === null && coOrganizer === null) {
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
