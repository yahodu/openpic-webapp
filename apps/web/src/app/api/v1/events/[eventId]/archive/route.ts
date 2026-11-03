import type { Document, ObjectId } from "mongodb";

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
import { appError } from "@/server/http/errors";
import { eventETag } from "@/server/http/etag";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/events/{eventId}/archive` — archive an event (OP-117 I3/I3b,
 * contract §4.1; ADR-0580, ADR-0602).
 *
 * The **organizer** archives their event; a co-organizer is refused with
 * `403 forbidden` and nothing is emitted (I3). On success the row is written
 * `status: "archived"` — `published` is what gates the public link (schema
 * §15.1), so an archive that left it in place would archive nothing — and the
 * `event.archived` domain event is emitted in the same transaction. The answer
 * is `200` with the full Event DTO reflecting the new state (I3b).
 *
 * The `archived` write is conditional on the row this request read (§0.10):
 * a concurrent writer that commits in between makes the predicate match
 * nothing, so the archive is refused instead of overwriting their state. A
 * `deleting` re-read (the DELETE that won the race) answers `409
 * event_deleting`; any other mismatch answers `412 etag_mismatch` naming the
 * re-read row's tag. Nothing is announced when the write did not match.
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

/**
 * The conditional-write predicate carrying the read row's version (contract
 * §0.10), the same shape PATCH / DELETE and `upload-window:extend` use.
 *
 * A concurrent writer that commits between this request's read and its write
 * makes the predicate match nothing, so the archive is refused instead of
 * un-scheduling that writer's transition. A row stored without an `updatedAt`
 * has no version to compare, so only its id and status are matched.
 *
 * @param eventId - The event being written.
 * @param row - The row this request read.
 * @returns The `updateOne` filter.
 */
function archiveWritePredicate(eventId: ObjectId, row: EventArchiveRow): Document {
  const predicate: Document = { _id: eventId, status: row.status };
  if (row.updatedAt instanceof Date) {
    predicate.updatedAt = row.updatedAt;
  }
  return predicate;
}

/**
 * A stored row's event ETag, with the GET route's defensive fallbacks.
 *
 * @param row - The row the refusal is reported against.
 * @param fallbackUpdatedAt - Timestamp used when the row carries no
 *   `updatedAt` (the read row always does in practice).
 * @returns The strong ETag for the row.
 */
function currentETagOf(row: EventArchiveRow, fallbackUpdatedAt: Date): string {
  const updatedAt = row.updatedAt;
  const schemaVersion = row.schemaVersion;
  return eventETag(
    updatedAt instanceof Date ? updatedAt : fallbackUpdatedAt,
    typeof schemaVersion === "number" ? schemaVersion : 1
  );
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

    const archived = await withTransaction(async (session) => {
      const written = await platformRepo(db)
        .collection(COLLECTIONS.events)
        .updateOne(
          archiveWritePredicate(eventId, row),
          {
            $set: { status: "archived", updatedAt: now },
          },
          { session }
        );
      // A zero match means another writer moved the row between this request's
      // read and its write: refuse rather than overwrite their state.
      if (written.matchedCount === 0) {
        return false;
      }
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
      return true;
    });

    if (!archived) {
      const current = await loadEventRow<EventArchiveRow>(db, eventId);
      // The concurrent DELETE that won the race: the purge stays scheduled.
      assertEventNotDeleting(current, now);
      throw appError("etag_mismatch", {
        details: { currentETag: currentETagOf(current, now) },
      });
    }

    getLogger().info("event archived", {
      event: "event.archived",
      tenantId: row.tenantId,
      eventId: id,
    });

    const archivedRow = await loadEventRow<EventArchiveRow>(db, eventId);
    const dto = toEventDtoOrThrow(archivedRow, config.app.baseUrl, "internal_error");
    return { body: dto };
  },
});
