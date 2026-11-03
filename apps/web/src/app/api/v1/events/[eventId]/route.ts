import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { normalizeInstantToUtc } from "@/server/events/dates";
import { eventDtoSchema, toEventDtoOrThrow, type EventRow } from "@/server/events/dto";
import {
  assertEventNotDeleting,
  loadEventRow,
  requireEventRole,
  requirePrincipal,
} from "@/server/events/access";
import { findForbiddenEditableFields, isEventLocked } from "@/server/events/update";
import { computeDurationDays, recomputeWindows } from "@/server/events/windows";
import { defineRoute, type RouteStage } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { eventETag, etagStage } from "@/server/http/etag";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { checkEntitlement } from "@/server/services/entitlements";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `GET`/`PATCH`/`DELETE /api/v1/events/{eventId}` — the global event surface
 * (OP-116 detail + OP-117 mutations, contract §4.1, §0.10; ADR-0560,
 * ADR-0580).
 *
 * The organizer browses an event's detail, windows and pipeline status from
 * the global path so a **co-organizer** — a caller recorded in
 * `event_organizers` (`role: "co_organizer"`) who is *not* necessarily a
 * tenant member — can read and PATCH the shared event through the
 * event-membership path. A tenant member of the event's tenant is admitted
 * through the tenant path.
 *
 * PATCH is a conditional write: `If-Match` is enforced (missing →
 * `428 precondition_required`, stale → `412 etag_mismatch` with
 * `details.currentETag`), the editable field set is contract §4.1 (anything
 * else → `422 forbidden_field`), date edits recompute **both** materialised
 * windows and re-validate `events.duration_days`, a `startAt` move on a
 * started event is refused (`409 event_already_started`), and a `deleting`
 * row is inert (`409 event_deleting` with `details.purgeScheduledAt`). On
 * success it returns the full Event DTO and the **new** quoted ETag, closing
 * the conditional-write loop, and emits `event.details.updated`.
 *
 * DELETE is deliberate and irreversible: the body must carry the exact event
 * name (`422 confirmation_mismatch` otherwise), the row flips to
 * `status: "deleting"` with a `deletedAt` stamp, the ordered-purge domain
 * event (`event.purge.scheduled`, consumed by the OP-132 purge job) and the
 * user-facing `event.deleted` are emitted, and the answer is
 * `202 {status, purgeScheduledAt, irreversible: true}`. The content is
 * destroyed later by the purge job — never by this endpoint.
 *
 * A caller with no relationship to the event receives `404`, never a `403`
 * (contract §0.4: the endpoint must not become a cross-tenant existence
 * oracle).
 */

/** The upgrade offer the plan-limit refusals carry (§0.14). */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** The `{eventId}` segment of the matched path; a malformed id denies `404`. */
function eventIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-1));
  if (!/^[0-9a-f]{24}$/i.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/** The stored `events` row fields the global routes need beyond the DTO. */
interface EventDetailRow extends EventRow {
  readonly tenantId: string;
  readonly status: string;
  readonly deletedAt?: Date;
  readonly schemaVersion?: number;
  readonly updatedAt?: Date;
}

/** The `displayTimeZone` must be a real IANA name (contract §4.1). */
function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A stored row's event ETag, with the GET route's defensive fallbacks. */
function currentETagOf(row: EventDetailRow): string {
  const updatedAt = row.updatedAt;
  const schemaVersion = row.schemaVersion;
  return eventETag(
    updatedAt instanceof Date ? updatedAt : new Date(),
    typeof schemaVersion === "number" ? schemaVersion : 1
  );
}

/** A §4.1 branding-asset reference: absent, an ObjectId, or an explicit `null`. */
function assetIdOrNull(value: string | null | undefined): ObjectId | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new ObjectId(value);
}

/**
 * The conditional-write ETag stage for a row that needs a database read.
 *
 * `defineRoute`'s `etag` slot expects a synchronous resolver, but the event's
 * current ETag lives in MongoDB. This stage loads the row first, then runs
 * the existing `etagStage` against the captured tag, so the `428`/`412`
 * refusals (with `details.currentETag`) come from the same stage every other
 * route uses.
 */
function dbBackedEtagStage(required: boolean): RouteStage {
  return async (ctx, request) => {
    const eventId = eventIdFromRequest(request);
    const row = (await platformRepo(getDb())
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventDetailRow | null;
    if (row === null) {
      return undefined;
    }
    const current = currentETagOf(row);
    return etagStage({ resolve: () => current, required })(ctx, request);
  };
}

/**
 * The PATCH body: every §4.1 editable field is optional and loose.
 *
 * Like `PATCH /me`, the schema is **passthrough**, not strict — the route
 * must still see a supplied `createdByUserId`/`tenantId`/… to reject it with
 * `422 forbidden_field` rather than a generic validation failure.
 */
const patchEventBodySchema = z.looseObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  displayTimeZone: z.string().optional(),
  logoAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .optional(),
  watermarkAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .optional(),
  thumbnailPreset: z.string().optional(),
  visibilityDefaults: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

/** The DELETE confirmation body (contract §4.1, §22). */
const deleteEventBodySchema = z.object({ confirmName: z.string() });

/** The DELETE `202` body — exactly the three documented keys. */
const deleteEventResponseSchema = z.object({
  status: z.literal("deleting"),
  purgeScheduledAt: z.string(),
  irreversible: z.literal(true),
});

/** The §4.1 editable surface the PATCH body may carry. */
interface PatchEventBody {
  readonly name?: string;
  readonly description?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly displayTimeZone?: string;
  readonly logoAssetId?: string | null;
  readonly watermarkAssetId?: string | null;
  readonly thumbnailPreset?: string;
  readonly visibilityDefaults?: Record<string, unknown>;
  readonly status?: string;
}

export const GET = defineRoute({
  route: "/api/v1/events/:eventId",
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    const eventId = eventIdFromRequest(ctx.request);
    const row = await loadEventRow<EventDetailRow>(db, eventId);

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

    const dto = toEventDtoOrThrow(row, config.app.baseUrl, "not_found");

    return {
      body: dto,
      headers: { etag: currentETagOf(row) },
    };
  },
});

/** Strip HTML tags to inert plain text (OP-115 I9, §5). */
function sanitizeDescription(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `PATCH /api/v1/events/{eventId}` — update an event (OP-117 I1/I2/I6/I7/I8,
 * contract §4.1, §0.10; ADR-0580).
 */
export const PATCH = defineRoute({
  route: "/api/v1/events/:eventId",
  body: patchEventBodySchema,
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  etag: dbBackedEtagStage(true),
  handler: async (ctx) => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    const eventId = eventIdFromRequest(ctx.request);
    const id = eventId.toHexString();
    const row = await loadEventRow<EventDetailRow>(db, eventId);
    await requireEventRole(db, eventId, row.tenantId, principal, [
      "organizer",
      "co_organizer",
      "tenant_member",
    ]);

    // A row whose purge is scheduled is inert: every later write is refused.
    assertEventNotDeleting(row, now);

    // Supplied keys outside the §4.1 editable set are refused outright.
    const supplied = ctx.body as PatchEventBody & Record<string, unknown>;
    const forbidden = findForbiddenEditableFields(supplied);
    if (forbidden.length > 0) {
      throw appError("forbidden_field", { details: { fields: forbidden } });
    }

    // The start-lock: once the event has begun, its start can never move.
    if (supplied.startAt !== undefined && isEventLocked(now, row.startAt)) {
      throw appError("event_already_started");
    }

    // ── date edits: normalise, re-validate duration, recompute both windows ──
    let effectiveStartAt = row.startAt;
    let effectiveEndAt = row.endAt;
    if (supplied.startAt !== undefined || supplied.endAt !== undefined) {
      try {
        if (supplied.startAt !== undefined) {
          effectiveStartAt = new Date(normalizeInstantToUtc(supplied.startAt));
        }
        if (supplied.endAt !== undefined) {
          effectiveEndAt = new Date(normalizeInstantToUtc(supplied.endAt));
        }
      } catch {
        throw appError("validation_failed", {
          details: {
            fields: [
              { path: "startAt", code: "invalid_instant", message: "must be an RFC 3339 instant" },
              { path: "endAt", code: "invalid_instant", message: "must be an RFC 3339 instant" },
            ],
          },
        });
      }
      if (effectiveEndAt.getTime() <= effectiveStartAt.getTime()) {
        throw appError("invalid_date_range", {
          details: { startAt: effectiveStartAt.toISOString(), endAt: effectiveEndAt.toISOString() },
        });
      }

      const tenantKey = row.tenantId;
      const durationDays = computeDurationDays(effectiveStartAt, effectiveEndAt);
      const durationVerdict = await checkEntitlement(
        tenantKey,
        "events.duration_days",
        durationDays,
        { counts: 0 },
        { db }
      );
      if (!durationVerdict.allowed) {
        if (durationVerdict.reason === "payment_downgrade") {
          throw appError("payment_required", {
            details: {
              entitlementKey: "events.duration_days",
              reason: "payment_downgrade",
              pendingDueMinor: durationVerdict.pendingDueMinor,
              currency: durationVerdict.currency,
              payNowUrl: `/api/v1/tenants/${tenantKey}/billing/retry-charge`,
              gracePeriodEndsAt:
                durationVerdict.gracePeriodEndsAt === null
                  ? null
                  : durationVerdict.gracePeriodEndsAt.toISOString(),
            },
          });
        }
        throw appError("plan_limit_exceeded", {
          details: {
            entitlementKey: "events.duration_days",
            limit: durationVerdict.limit,
            used: durationVerdict.used,
            periodKey: durationVerdict.periodKey,
            scope: durationVerdict.scope,
            reason: "plan_limit",
            upgradePath: UPGRADE_PATH,
            requestedDays: durationDays,
          },
        });
      }
    }

    // ── build the $set from the supplied editable fields ──
    const set: Document = { updatedAt: now };
    const suppliedFields = supplied;
    const verbatim: Record<string, unknown> = {
      name: suppliedFields.name,
      description:
        suppliedFields.description === undefined
          ? undefined
          : sanitizeDescription(suppliedFields.description),
      startAt: suppliedFields.startAt === undefined ? undefined : effectiveStartAt,
      endAt: suppliedFields.endAt === undefined ? undefined : effectiveEndAt,
      logoAssetId: assetIdOrNull(suppliedFields.logoAssetId),
      watermarkAssetId: assetIdOrNull(suppliedFields.watermarkAssetId),
      thumbnailPreset: suppliedFields.thumbnailPreset,
      visibilityDefaults: suppliedFields.visibilityDefaults,
      status: suppliedFields.status,
    };
    for (const [field, value] of Object.entries(verbatim)) {
      if (value !== undefined) {
        set[field] = value;
      }
    }
    if (suppliedFields.displayTimeZone !== undefined) {
      if (!isValidIanaTimeZone(suppliedFields.displayTimeZone)) {
        throw appError("unknown_timezone");
      }
      set.displayTimeZone = suppliedFields.displayTimeZone;
    }

    // The windows recomputed above must land on the row whenever a date moved.
    if (supplied.startAt !== undefined || supplied.endAt !== undefined) {
      const tenantKey = row.tenantId;
      const postUploadVerdict = await checkEntitlement(
        tenantKey,
        "events.post_upload_days",
        0,
        { counts: 0 },
        { db }
      );
      const retentionVerdict = await checkEntitlement(
        tenantKey,
        "gallery.retention_days",
        0,
        { counts: 0 },
        { db }
      );
      const windows = recomputeWindows({
        endAt: effectiveEndAt,
        postUploadDays: postUploadVerdict.effectiveLimit,
        retentionDays: retentionVerdict.effectiveLimit,
      });
      set.uploadWindowEndsAt = windows.uploadWindowEndsAt;
      set.retentionExpiresAt = windows.retentionExpiresAt;
    }

    // ── the conditional write + the announcement, atomically ──
    await withTransaction(async (session) => {
      await platformRepo(db)
        .collection(COLLECTIONS.events)
        .updateOne({ _id: eventId }, { $set: set }, { session });
      await emitDomainEvent(
        {
          eventKey: "event.details.updated",
          tenantId: row.tenantId,
          actorRef: { kind: "user", id: principal },
          subjectRef: { kind: "event", id },
          payload: { eventId: id },
        },
        { db, session }
      );
    });

    getLogger().info("event details updated", {
      event: "event.details.updated",
      tenantId: row.tenantId,
      eventId: id,
    });

    const updated = await loadEventRow<EventDetailRow>(db, eventId);
    const dto = toEventDtoOrThrow(updated, config.app.baseUrl, "internal_error");

    // The NEW etag (post-write `updatedAt`) overrides the stage's pre-write tag.
    return {
      body: dto,
      headers: { etag: currentETagOf(updated) },
    };
  },
});

/**
 * `DELETE /api/v1/events/{eventId}` — delete an event deliberately
 * (OP-117 I4/I5, contract §4.1, §22; ADR-0580).
 */
export const DELETE = defineRoute({
  route: "/api/v1/events/:eventId",
  body: deleteEventBodySchema,
  response: deleteEventResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  etag: dbBackedEtagStage(false),
  handler: async (ctx) => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const now = systemClock.now();
    const eventId = eventIdFromRequest(ctx.request);
    const id = eventId.toHexString();
    const row = await loadEventRow<EventDetailRow>(db, eventId);

    // Delete is organizer-only; a related caller without the role is refused
    // with `403`, a caller with no relationship with `404` (never an oracle).
    await requireEventRole(db, eventId, row.tenantId, principal, ["organizer"]);

    assertEventNotDeleting(row, now);

    // The confirmation must be the exact event name — nothing is written or
    // announced on a mismatch.
    if (ctx.body.confirmName !== row.name) {
      throw appError("confirmation_mismatch", { details: { field: "confirmName" } });
    }

    const purgeScheduledAt = now.toISOString();

    await withTransaction(async (session) => {
      await platformRepo(db)
        .collection(COLLECTIONS.events)
        .updateOne(
          { _id: eventId },
          { $set: { status: "deleting", deletedAt: now, updatedAt: now } },
          { session }
        );

      // The ordered purge: a queue/analytics event the OP-132 purge job
      // consumes. `event.deleted` is the user-facing announcement.
      await emitDomainEvent(
        {
          eventKey: "event.purge.scheduled",
          tenantId: row.tenantId,
          actorRef: { kind: "user", id: principal },
          subjectRef: { kind: "event", id },
          payload: { eventId: id, purgeScheduledAt },
        },
        { db, session }
      );
      await emitDomainEvent(
        {
          eventKey: "event.deleted",
          tenantId: row.tenantId,
          actorRef: { kind: "user", id: principal },
          subjectRef: { kind: "event", id },
          payload: { eventId: id },
        },
        { db, session }
      );
    });

    getLogger().info("event deleted", {
      event: "event.deleted",
      tenantId: row.tenantId,
      eventId: id,
      actor: principal,
    });

    return {
      status: 202,
      body: { status: "deleting", purgeScheduledAt, irreversible: true },
    };
  },
});
