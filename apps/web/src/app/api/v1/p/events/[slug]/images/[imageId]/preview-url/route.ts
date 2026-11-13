import { z } from "zod";

import { signAttendeeMedia } from "@/server/attendee/attendee-media";
import { requireSignableImage } from "@/server/attendee/image-access";
import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { getRateLimitConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/images/{imageId}/preview-url` — one preview
 * token (OP-133, contract §6.6, §5.6; ADR-0794 §4).
 *
 * A preview is the middle derivative: strictly longer-lived than a thumbnail
 * and strictly shorter than an original (§5.6), and it is **not** the original,
 * so it is not gated by `originals.download`. The green card makes it
 * identified users only, and the RED pack pins the anonymous refusal.
 */

/** The §6.6 answer, in the same envelope as an original. */
const previewUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  ttlSeconds: z.number().int().positive(),
});

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/images/:imageId/preview-url",
  response: previewUrlSchema,
  rateLimit: rateLimitStage({
    classKey: "media.sign",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const scope = await requireAttendeeProfile(ctx, { slugFromEnd: 4 });
    if (scope.subject.kind !== "user") {
      // §6.6: a preview is for an identified attendee; an anonymous session is
      // a caller that has nothing to preview beyond the gallery thumbnail.
      throw appError("forbidden", { details: { reason: "identified_only" } });
    }

    const { db, event, profile } = scope;
    const segments = new URL(ctx.request.url).pathname.split("/").filter((part) => part !== "");
    const image = await requireSignableImage({
      db,
      event,
      profileId: profile._id,
      imageId: segments.at(-2) ?? "",
    });

    return {
      status: 201,
      body: signAttendeeMedia("preview", image.asset, systemClock.now()),
    };
  },
});
