import { z } from "zod";

import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { defineRoute } from "@/server/http/define-route";
import { optionalJsonBody } from "@/server/http/optional-json-body";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/gallery:seen` — dismiss the "New" badges
 * (OP-133, contract §6.5, schema §15.3/§17.5; ADR-0794 §5).
 *
 * The only writer of `seenAt`, deliberately: §6.5 makes the dismissal an
 * explicit call so a prefetch can never clear a badge. `seenAt` is optional and
 * defaults to now; an explicit instant lets a client stamp "seen up to here",
 * which leaves anything matched after it still new.
 */

/** The optional §6.5 body. */
const seenBodySchema = z.object({
  seenAt: z.iso.datetime().optional(),
});

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/gallery:seen",
  response: noContentSchema,
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const body = await optionalJsonBody(ctx.request, seenBodySchema);
    const seenAt = body?.seenAt === undefined ? systemClock.now() : new Date(body.seenAt);

    const scope = await requireAttendeeProfile(ctx);
    const { db, event, profile } = scope;
    const tenant = tenantRepo(event.tenantKey, db);

    // Only the rows created up to the watermark: a match that arrives later
    // stays new, which is what the explicit instant is for.
    await tenant
      .collection(COLLECTIONS.faceMatches)
      .updateMany(
        { profileId: profile._id, seenAt: null, createdAt: { $lte: seenAt } },
        { $set: { seenAt } }
      );
    await tenant
      .collection(COLLECTIONS.attendeeEventProfiles)
      .updateOne(
        { _id: profile._id },
        { $set: { lastSeenGalleryAt: seenAt, updatedAt: systemClock.now() } }
      );

    return { status: 204, body: null };
  },
});
