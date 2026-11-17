import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { platformRepo, tenantRepo } from "@/server/repos";
import type { TenantAdmission, TenantAdmissionContext } from "@/server/tenancy/route-stage";

import { eventIdAfterEventsSegment, eventIdFromRequest } from "./event-id";

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
 *
 * The same resolver backs {@link admitEventActor}, the event-scoped admission
 * seam a nested tenant route hands to `tenantStage` (ADR-0644), so a nested read
 * admits exactly the callers this family admits.
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

/**
 * Admit the caller through their relationship to the event named by the
 * route's `{eventId}` segment (contract §0.4, §4.3; ADR-0644).
 *
 * This is the event-scoped admission seam a nested tenant route hands to
 * `tenantStage`, so `current` resolution, the `X-Tenant-Id` echo and the single
 * `tenancy.access_denied` log stay in one place. The stage has already resolved
 * the workspace; this function answers only "is the caller an actor on this
 * event of this workspace".
 *
 * The tenant-scoped `events` read is both the workspace check and the existence
 * check — another workspace's event is the uniform `404` — and
 * {@link resolveEventActorRole} keeps the `revokedAt: null` filter that refuses
 * a removed worker while admitting a co-organizer who holds no `tenantMembers`
 * row.
 *
 * @param context - The resolved workspace, the caller and the stage's `deny`.
 * @param segmentFromEnd - How far from the path's end the event id sits: `2`
 *   for `…/events/{eventId}/members`, `3` for
 *   `…/events/{eventId}/uploads/batch-resolve` (ADR-0701). Omitted when the
 *   route has no fixed suffix at all (`…/events/{eventId}`, the OP-121 detail
 *   read): the id is then located by its `events` anchor, so a route whose
 *   suffix length varies does not read the wrong segment.
 */
export async function admitEventActor(
  { db, request, tenantId, userId, deny }: TenantAdmissionContext,
  segmentFromEnd?: number
): Promise<void> {
  const eventId =
    segmentFromEnd === undefined
      ? eventIdAfterEventsSegment(request)
      : eventIdFromRequest(request, { segmentFromEnd });
  const tenantKey = tenantId.toHexString();

  const event = await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.events)
    .findOne({ _id: eventId });
  if (event === null) {
    deny("event_not_found");
  }

  if ((await resolveEventActorRole(db, eventId, tenantKey, userId)) === null) {
    deny("not_an_event_actor");
  }
}

/**
 * The event-actor seam for a route whose `{eventId}` sits at a non-default
 * offset from the end of the path.
 *
 * @param segmentFromEnd - The offset {@link eventIdFromRequest} should read.
 * @returns A {@link TenantAdmission} for `tenantStage({ admission })`.
 */
export function eventActorAdmission(segmentFromEnd: number): TenantAdmission {
  return (context) => admitEventActor(context, segmentFromEnd);
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
