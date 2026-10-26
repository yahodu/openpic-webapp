import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

/**
 * Event-actor admission for the global `/api/v1/events/{eventId}` mutation
 * family (OP-117, ADR-0580).
 *
 * A caller is admitted to the event when an `event_organizers` row exists for
 * them (role `organizer` **or** `co_organizer`, `revokedAt: null`) or when
 * they are an active member of the event's tenant. This mirrors the OP-116
 * detail admission so a co-organizer who is *not* a tenant member can still
 * write the shared event. The returned role is what the per-route role gate
 * splits on: PATCH admits every admitted actor, archive/delete admit the
 * `organizer` only.
 */

/** The caller's relationship to an event, once admission passed. */
export type EventActorRole = "organizer" | "co_organizer" | "tenant_member";

/**
 * Resolve the caller's relationship to an event.
 *
 * @param db - The database handle.
 * @param eventId - The event's id.
 * @param tenantKey - The event's tenant id (hex string).
 * @param userId - The caller's Better Auth user id (hex string).
 * @returns `"organizer"`, `"co_organizer"` or `"tenant_member"`, or `null`
 *   when the caller has no relationship to the event (the route answers `404`
 *   — never an oracle, contract §0.4).
 */
export async function resolveEventActorRole(
  db: Db,
  eventId: ObjectId,
  tenantKey: string,
  userId: string
): Promise<EventActorRole | null> {
  const organizerRow = (await platformRepo(db)
    .collection(COLLECTIONS.eventOrganizers)
    .findOne({
      eventId,
      userId,
      revokedAt: null,
      role: { $in: ["organizer", "co_organizer"] },
    })) as { readonly role?: string } | null;
  if (organizerRow !== null && organizerRow.role === "co_organizer") {
    return "co_organizer";
  }
  if (organizerRow !== null) {
    return "organizer";
  }

  const membership = await platformRepo(db)
    .collection(COLLECTIONS.tenantMembers)
    .findOne({
      tenantId: new ObjectId(tenantKey),
      userId: new ObjectId(userId),
      status: "active",
    });
  return membership === null ? null : "tenant_member";
}
