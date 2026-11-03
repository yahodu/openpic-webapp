import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
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
  if (organizerRow !== null) {
    return organizerRow.role === "co_organizer" ? "co_organizer" : "organizer";
  }

  const membership = await platformRepo(db)
    .collection(COLLECTIONS.tenantMembers)
    .findOne({
      tenantId: new ObjectId(tenantKey),
      userId: new ObjectId(userId),
      status: "active",
    });
  if (membership !== null) {
    return "tenant_member";
  }
  return null;
}

/** The authenticated principal the auth stage established. */
export function requirePrincipal(ctx: { readonly principal?: string }): string {
  const principal = ctx.principal;
  if (principal === undefined) {
    throw appError("authentication_required");
  }
  return principal;
}

/** Load the event behind `{eventId}`, or deny `404`. */
export async function loadEventRow<T>(db: Db, eventId: ObjectId): Promise<T> {
  const row = (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId })) as T | null;
  if (row === null) {
    throw appError("not_found");
  }
  return row;
}

/**
 * The mutation role gate: a caller with no relationship gets `404` (never an
 * oracle), a related caller outside `roles` gets `403`.
 */
export async function requireEventRole(
  db: Db,
  eventId: ObjectId,
  tenantKey: string,
  userId: string,
  roles: readonly EventActorRole[]
): Promise<EventActorRole> {
  const role = await resolveEventActorRole(db, eventId, tenantKey, userId);
  if (role === null) {
    throw appError("not_found");
  }
  if (!roles.includes(role)) {
    throw appError("forbidden");
  }
  return role;
}

/** Refuse every write on a row whose ordered purge is already scheduled. */
export function assertEventNotDeleting(
  row: { readonly status?: string; readonly deletedAt?: Date },
  now: Date
): void {
  if (row.status === "deleting") {
    throw appError("event_deleting", {
      details: { purgeScheduledAt: (row.deletedAt ?? now).toISOString() },
    });
  }
}
