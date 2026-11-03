import type { Document, ObjectId } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import {
  assertEventNotDeleting,
  loadEventRow,
  requireEventRole,
  requirePrincipal,
} from "@/server/events/access";
import { eventDtoSchema, toEventDtoOrThrow, type EventRow } from "@/server/events/dto";
import { eventIdFromRequest } from "@/server/events/event-id";
import {
  computeDurationDays,
  computeUploadWindowEndsAt,
  extendUploadWindow,
} from "@/server/events/windows";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { checkEntitlement } from "@/server/services/entitlements";
import { userAuth } from "@/server/tenancy/route-scope";

/**
 * `POST /api/v1/events/{eventId}/upload-window:extend` — extend an event's
 * upload window by whole days (OP-117 §3, contract §4.1, Appendix D; ADR-0601).
 *
 * The **organizer** keeps the upload window open for `additionalDays` more whole
 * days so late guests can still send photos. The stored
 * `uploadWindowEndsAt` moves by exactly that many days — the time of day is
 * preserved — and the answer is the full Event DTO carrying the new close. A
 * row whose materialised close is still `null` (an unlimited plan) is derived
 * from `endAt + events.post_upload_days` first, so the extension never invents
 * a close out of thin air.
 *
 * The extension may not push the window past the plan's
 * `events.post_upload_days` allowance: the total post-upload span
 * (`newClose - endAt`, in whole days) is checked against the entitlement's
 * effective limit and a request beyond it is refused with `403
 * plan_limit_exceeded` carrying `details.upgradePath`, the same offer the PATCH
 * duration refusal names. The refusal writes nothing.
 *
 * Admission mirrors the lane's other mutations: `organizer` only — a related
 * caller without the role answers `403 forbidden`, a caller with no
 * relationship `404 not_found` (never a cross-tenant existence oracle, contract
 * §0.4) — and a row whose ordered purge is already scheduled is inert
 * (`409 event_deleting`).
 *
 * ## Path decision
 *
 * The contract spells this endpoint tenant-scoped
 * (`POST /api/v1/tenants/{tenantId}/events/{eventId}/upload-window:extend`); it
 * lives on the **global** `/api/v1/events/{eventId}` family instead, like this
 * lane's PATCH / DELETE / archive, because that is the family that admits a
 * co-organizer who is not a tenant member (ADR-0580). Recorded in ADR-0601.
 */

/** The upgrade offer the plan-limit refusals carry (§0.14). */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** The stored `events` row fields this route needs beyond the DTO. */
interface EventExtendRow extends EventRow {
  readonly tenantId: string;
  readonly deletedAt?: Date;
}

/**
 * The request body: `additionalDays` must be a strictly positive whole number.
 *
 * A missing, zero, negative, fractional or non-numeric value is a
 * `422 validation_failed` naming `additionalDays` — never a silent clamp.
 */
const extendUploadWindowBodySchema = z.object({
  additionalDays: z.number().int().positive(),
});

/**
 * The conditional-write predicate carrying the read row's version (contract
 * §0.10).
 *
 * The handler reads the row to derive both the base close and the write
 * predicate; a concurrent writer that commits in between makes the predicate
 * match nothing, so the extension is refused instead of silently overwriting
 * the other caller's value. A row stored without an `updatedAt` has no version
 * to compare, so only its id and status are matched.
 *
 * @param eventId - The event being written.
 * @param row - The row this request read.
 * @returns The `updateOne` filter.
 */
function extendWritePredicate(eventId: ObjectId, row: EventExtendRow): Document {
  const predicate: Document = { _id: eventId, status: row.status };
  if (row.updatedAt instanceof Date) {
    predicate.updatedAt = row.updatedAt;
  }
  return predicate;
}

export const POST = defineRoute({
  route: "/api/v1/events/:eventId/upload-window:extend",
  body: extendUploadWindowBodySchema,
  response: eventDtoSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx) => {
    const principal = requirePrincipal(ctx);
    const db = getDb();
    const config = getConfig();
    const now = systemClock.now();
    // The literal `upload-window:extend` suffix follows the id in this path.
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const id = eventId.toHexString();
    const row = await loadEventRow<EventExtendRow>(db, eventId);

    // Extend is organizer-only. A related caller without the role is refused
    // with `403`, a caller with no relationship with `404` (never an oracle).
    await requireEventRole(db, eventId, row.tenantId, principal, ["organizer"]);
    assertEventNotDeleting(row, now);

    // The plan's post-upload allowance, read exactly like the create/PATCH
    // paths read it: the verdict carries the effective limit (`null` when the
    // plan leaves the window unlimited).
    const verdict = await checkEntitlement(
      row.tenantId,
      "events.post_upload_days",
      0,
      { counts: 0 },
      { db }
    );
    const limit = verdict.effectiveLimit;

    // The close being extended: the materialised one, or — for a row stored
    // before the window was materialised — `endAt + events.post_upload_days`.
    const base = row.uploadWindowEndsAt ?? computeUploadWindowEndsAt(row.endAt, limit);
    const uploadWindowEndsAt =
      base === null ? null : extendUploadWindow(base, ctx.body.additionalDays);

    // The allowance caps the total post-upload span, not just the increment: a
    // window already at the plan's limit cannot grow.
    if (uploadWindowEndsAt !== null && limit !== null) {
      const postUploadDays = computeDurationDays(row.endAt, uploadWindowEndsAt);
      if (postUploadDays > limit) {
        throw appError("plan_limit_exceeded", {
          details: {
            entitlementKey: "events.post_upload_days",
            limit,
            used: verdict.used,
            periodKey: verdict.periodKey,
            scope: verdict.scope,
            reason: "plan_limit",
            upgradePath: UPGRADE_PATH,
            requestedDays: postUploadDays,
          },
        });
      }
    }

    const written = await platformRepo(db)
      .collection(COLLECTIONS.events)
      .updateOne(extendWritePredicate(eventId, row), {
        $set: { uploadWindowEndsAt, updatedAt: now },
      });
    // A zero match means another writer moved the row between this request's
    // read and its write: refuse rather than overwrite their value. This route
    // carries no `If-Match` contract, so the refusal names no client tag.
    if (written.matchedCount === 0) {
      throw appError("etag_mismatch");
    }

    getLogger().info("event upload window extended", {
      event: "event.upload_window.extended",
      tenantId: row.tenantId,
      eventId: id,
      additionalDays: ctx.body.additionalDays,
    });

    const extended = await loadEventRow<EventExtendRow>(db, eventId);
    const dto = toEventDtoOrThrow(extended, config.app.baseUrl, "internal_error");
    return { body: dto };
  },
});
