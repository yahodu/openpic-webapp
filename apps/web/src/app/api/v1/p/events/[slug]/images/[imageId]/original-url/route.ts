import { z } from "zod";

import { signAttendeeMedia } from "@/server/attendee/attendee-media";
import { requireSignableImage } from "@/server/attendee/image-access";
import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { getRateLimitConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/images/{imageId}/original-url` — one 15-minute
 * original token (OP-133, contract §6.6, §5.6–§5.7, §14.1; ADR-0794 §4).
 *
 * Originals are never listed: the bytes are requested only on an explicit user
 * action, and what buys the URL is "I am in this photo" plus a plan that grants
 * attendee downloads. Both refusals are decided before anything is signed.
 */

/** The §6.6 answer. */
const originalUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  ttlSeconds: z.number().int().positive(),
});

/** The entitlement that grants attendee original downloads (§14.1, §6.6). */
const ORIGINALS_KEY = "originals.download";

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/images/:imageId/original-url",
  response: originalUrlSchema,
  rateLimit: rateLimitStage({
    classKey: "media.sign",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const scope = await requireAttendeeProfile(ctx, { slugFromEnd: 4 });
    const { db, event, profile } = scope;
    const segments = new URL(ctx.request.url).pathname.split("/").filter((part) => part !== "");

    const image = await requireSignableImage({
      db,
      event,
      profileId: profile._id,
      imageId: segments.at(-2) ?? "",
      entitlementKey: ORIGINALS_KEY,
    });

    return {
      status: 201,
      body: signAttendeeMedia("original", image.asset, systemClock.now()),
    };
  },
});
