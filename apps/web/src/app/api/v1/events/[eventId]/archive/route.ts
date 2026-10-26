import { ObjectId } from "mongodb";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { resolveEventActorRole } from "@/server/events/access";
import { eventDtoSchema, toEventDto, type EventRow } from "@/server/events/dto";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/events/{eventId}/archive` — archive an event (OP-117 I3/I3b,
 * contract §4.1; ADR-0580).
 *
 * The **organizer** archives their event; a co-organizer is refused with
 * `403 forbidden` and nothing is emitted (I3). On success the route answers
 * `200` with the full Event DTO and emits `event.archived` (I3b) — the
 * notification resolver owns any downstream fan-out.
 *
 * A caller with no relationship to the event receives `404`, never a `403`
 * (contract §0.4: the endpoint must not become a cross-tenant existence
 * oracle). A row whose ordered purge is already scheduled is inert
 * (`409 event_deleting`).
 */

/** The `{eventId}` segment before the literal `archive`; a malformed id denies `404`. */
function eventIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-2) ?? "";
  if (!/^[0-9a-f]{24}$/i.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/** The stored `events` row fields the archive route needs beyond the DTO. */
interface EventArchiveRow extends EventRow {
  readonly tenantId: string;
  readonly status: string;
  readonly deletedAt?: Date;
}

export const POST = defineRoute({
  route: "/api/v1/events/:eventId/archive",
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const eventId = eventIdFromRequest(ctx.request);
    const id = eventId.toHexString();

    const row = (await platformRepo(db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventArchiveRow | null;
    if (row === null) {
      throw appError("not_found");
    }

    // Archive is organizer-only. A related caller without the role is refused
    // with `403`, a caller with no relationship with `404` (never an oracle).
    const role = await resolveEventActorRole(db, eventId, row.tenantId, principal);
    if (role === null) {
      throw appError("not_found");
    }
    if (role !== "organizer") {
      throw appError("forbidden");
    }

    if (row.status === "deleting") {
      throw appError("event_deleting", {
        details: { purgeScheduledAt: row.deletedAt?.toISOString() ?? now.toISOString() },
      });
    }

    await emitDomainEvent(
      {
        eventKey: "event.archived",
        tenantId: row.tenantId,
        actorRef: { kind: "user", id: principal },
        subjectRef: { kind: "event", id },
        payload: { eventId: id },
      },
      { db }
    );

    getLogger().info("event archived", {
      event: "event.archived",
      tenantId: row.tenantId,
      eventId: id,
    });

    const dto = toEventDto(row, config.app.baseUrl);
    if (dto === null) {
      throw appError("internal_error");
    }
    return { body: dto };
  },
});
