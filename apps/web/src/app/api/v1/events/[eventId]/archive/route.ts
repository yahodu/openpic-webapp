import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import {
  assertEventNotDeleting,
  loadEventRow,
  requireEventRole,
  requirePrincipal,
} from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { eventDtoSchema, toEventDtoOrThrow, type EventRow } from "@/server/events/dto";
import { defineRoute } from "@/server/http/define-route";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/events/{eventId}/archive` — archive an event (OP-117 I3/I3b,
 * contract §4.1; ADR-0580).
 *
 * The **organizer** archives their event; a co-organizer is refused with
 * `403 forbidden` and nothing is emitted (I3). On success the row is written
 * `status: "archived"` — `published` is what gates the public link (schema
 * §15.1), so an archive that left it in place would archive nothing — and the
 * `event.archived` domain event is emitted in the same transaction. The answer
 * is `200` with the full Event DTO reflecting the new state (I3b).
 *
 * A caller with no relationship to the event receives `404`, never a `403`
 * (contract §0.4: the endpoint must not become a cross-tenant existence
 * oracle). A row whose ordered purge is already scheduled is inert
 * (`409 event_deleting`).
 */

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
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    // The literal `archive` suffix follows the id in this route's path.
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const id = eventId.toHexString();
    const row = await loadEventRow<EventArchiveRow>(db, eventId);

    // Archive is organizer-only. A related caller without the role is refused
    // with `403`, a caller with no relationship with `404` (never an oracle).
    await requireEventRole(db, eventId, row.tenantId, principal, ["organizer"]);
    assertEventNotDeleting(row, now);

    await withTransaction(async (session) => {
      await platformRepo(db)
        .collection(COLLECTIONS.events)
        .updateOne({ _id: eventId }, { $set: { status: "archived", updatedAt: now } }, { session });
      await emitDomainEvent(
        {
          eventKey: "event.archived",
          tenantId: row.tenantId,
          actorRef: { kind: "user", id: principal },
          subjectRef: { kind: "event", id },
          payload: { eventId: id },
        },
        { db, session }
      );
    });

    getLogger().info("event archived", {
      event: "event.archived",
      tenantId: row.tenantId,
      eventId: id,
    });

    const archived = await loadEventRow<EventArchiveRow>(db, eventId);
    const dto = toEventDtoOrThrow(archived, config.app.baseUrl, "internal_error");
    return { body: dto };
  },
});
