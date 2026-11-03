import { ObjectId } from "mongodb";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute, type HandlerContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";
import { acceptBrandingUpload } from "@/server/media/branding-upload";
import { brandingUploadResponseSchema } from "@/server/media/branding-schema";
import { platformRepo } from "@/server/repos";

/**
 * `POST /api/v1/events/{eventId}/assets/branding` (OP-114, API contract
 * §2.1 — the event-scoped twin of the branding upload).
 *
 * Lets a co-organizer upload branding for an event they help run, even though
 * they are **not** a member of the organizer's workspace: authorisation comes
 * from an active `event_organizers` row (`{ tenantId, eventId, userId, role,
 * revokedAt: null }` — assumption A4, ADR-0540) rather than the tenant stage,
 * and the asset is stored and billed under the **event's** tenantId.
 *
 * Like the tenant route it declares no `body` schema — the JSON content-type
 * exemption (the contract's lone byte-accepting endpoint) — and the handler
 * parses the multipart stream itself. A caller with no organizer row is
 * refused `404 not_found` (the probe's non-oracle denial, unpinned).
 */

/** A 24-hex ObjectId, the only accepted explicit id shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The `user` auth stage, built per request so it reads validated config. */
function userAuth(): ReturnType<typeof requireAuth> {
  return requireAuth("user", { auth: getAuth(), database: getDb() });
}

/**
 * The `{eventId}` segment of the matched path, or `""`.
 *
 * Located by position — the segment immediately following the literal
 * `events` — mirroring `tenantIdFromRequest` in the tenant route stage.
 */
function eventIdFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments[segments.indexOf("events") + 1] ?? "";
}

export const POST = defineRoute({
  route: "/api/v1/events/:eventId/assets/branding",
  // No `body` schema — the JSON content-type exemption; the handler parses
  // the multipart stream itself.
  response: brandingUploadResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  handler: async (ctx: HandlerContext) => {
    const logger = requestLogger(ctx.request, { route: ctx.route });
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }
    const callerObjectId = new ObjectId(userId);

    const eventIdSegment = eventIdFromRequest(ctx.request);
    if (!OBJECT_ID_HEX.test(eventIdSegment)) {
      logger.warn("event branding denied", {
        event: "event.branding_access_denied",
        reason: "malformed_event_id",
      });
      throw appError("not_found");
    }
    const eventId = new ObjectId(eventIdSegment);

    const repo = platformRepo(getDb());

    const event = (await repo.collection(COLLECTIONS.events).findOne({ _id: eventId })) as
      (Record<string, unknown> & { _id: ObjectId }) | null;
    if (event === null) {
      logger.warn("event branding denied", {
        event: "event.branding_access_denied",
        reason: "event_not_found",
      });
      throw appError("not_found");
    }

    const tenantId = String(event.tenantId);

    // Authorisation is membership of the event's organizer rows — the caller
    // need not hold a tenantMembers row for the organizer's workspace (A4).
    const organizer = await repo
      .collection(COLLECTIONS.eventOrganizers)
      .findOne({ tenantId, eventId, userId: callerObjectId, revokedAt: null });
    if (organizer === null) {
      logger.warn("event branding denied", {
        event: "event.branding_access_denied",
        reason: "not_an_organizer",
      });
      throw appError("not_found");
    }

    const result = await acceptBrandingUpload({
      tenantId,
      request: ctx.request,
      route: ctx.route,
    });
    return { status: 201, body: result };
  },
});
