import { ObjectId } from "mongodb";
import { z } from "zod";

import { subjectFilter } from "@/server/attendee/consent-guard";
import { subjectForRequest } from "@/server/attendee/subject";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { optionalJsonBody } from "@/server/http/optional-json-body";
import { requestLogger } from "@/server/logging";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { crossTenantReads, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/matches/{matchId}/hide` — the attendee's own "not me"
 * (OP-133, contract §6.5, schema §17.5; ADR-0794 §6).
 *
 * `hiddenAt` rather than deletion, because a false positive is a model-quality
 * signal and a delete would make the next incremental match run re-insert the
 * row. The URL carries no event, so the row's own `tenantId` scopes the
 * ownership check — and a match that is not yours is indistinguishable from one
 * that does not exist (§0.4).
 */

/** The optional §6.5 body; the reason feeds quality review. */
const hideBodySchema = z.object({
  reason: z.enum(["not_me", "poor_quality", "other"]).optional(),
});

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

export const POST = defineRoute({
  route: "/api/v1/p/matches/:matchId/hide",
  response: noContentSchema,
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const body = await optionalJsonBody(ctx.request, hideBodySchema);
    const segments = new URL(ctx.request.url).pathname.split("/").filter((part) => part !== "");
    const matchId = segments.at(-2) ?? "";
    const db = getDb();

    // The caller's own subject decides ownership, so it is resolved before any
    // row is looked at.
    const subject = await subjectForRequest(db, ctx.request, ctx.principal);
    const match = await crossTenantReads.findFaceMatchById(matchId, db);
    if (match === null) {
      throw appError("not_found", { details: { resource: "match" } });
    }

    const tenant = tenantRepo(match.tenantId, db);
    const owned = await tenant
      .collection(COLLECTIONS.attendeeEventProfiles)
      .findOne(
        { _id: match.profileId, eventId: match.eventId, ...subjectFilter(subject) },
        { projection: { _id: 1 } }
      );
    if (owned === null) {
      throw appError("not_found", { details: { resource: "match" } });
    }

    await tenant
      .collection(COLLECTIONS.faceMatches)
      .updateOne(
        { _id: new ObjectId(matchId), profileId: match.profileId },
        { $set: { hiddenAt: systemClock.now() } }
      );

    requestLogger(ctx.request, { route: ctx.route }).info("match hidden", {
      event: "match.hidden",
      matchId,
      reason: body?.reason ?? null,
    });

    return { status: 204, body: null };
  },
});
