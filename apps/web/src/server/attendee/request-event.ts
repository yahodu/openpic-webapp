import type { Db, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

/**
 * The event an attendee request addresses (OP-131/OP-132, contract §6.2/§6.3;
 * ADR-0792).
 *
 * Every attendee route is addressed by the event's **active** access-link slug,
 * so the lookup and the "no such event" refusal live here once instead of in
 * each of the consent, liveness and selfie routes.
 */

/** The `events` fields the slug lookup reads (schema §15.1). */
interface EventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
}

/** The event one attendee call addresses. */
export interface ResolvedEvent {
  readonly db: Db;
  /** The event's tenant (hex, as the event row stores it). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/**
 * The `{slug}` path segment of the request, counted from the end of the path.
 *
 * The route template is not part of the handler's `Request`, so the slug is read
 * by position: `…/{slug}/consent` is two segments from the end,
 * `…/{slug}/liveness/challenges` three, and so on.
 *
 * @param request - The inbound request.
 * @param segmentFromEnd - The slug's position from the path's end.
 * @returns The segment, or `""` when the path is shorter than expected.
 */
export function slugFromRequest(request: Request, segmentFromEnd = 2): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-segmentFromEnd) ?? "";
}

/**
 * Resolve the event a request addresses through an **active** access link.
 *
 * @param db - The database to read `events` from.
 * @param slug - The requested slug.
 * @returns The event's tenant and id.
 * @throws {AppError} `not_found` when no active link carries the slug.
 */
export async function resolveEventBySlug(db: Db, slug: string): Promise<ResolvedEvent> {
  const event =
    slug === ""
      ? null
      : ((await platformRepo(db)
          .collection(COLLECTIONS.events)
          .findOne(
            { accessLinks: { $elemMatch: { slug, active: true } } },
            { projection: { _id: 1, tenantId: 1 } }
          )) as EventRow | null);
  if (event === null) {
    throw appError("not_found", { details: { resource: "event" } });
  }
  return { db, tenantKey: event.tenantId, eventId: event._id };
}
