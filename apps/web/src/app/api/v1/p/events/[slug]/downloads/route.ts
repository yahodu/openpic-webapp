import { ObjectId } from "mongodb";
import { z } from "zod";

import { DOWNLOAD_JOB_TTL_SECONDS, DOWNLOAD_POLL_MS, DOWNLOAD_LINK_DOWNLOADS } from "@/server/attendee/download-job";
import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { defineRoute } from "@/server/http/define-route";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/p/events/{slug}/downloads` — queue one download (OP-133,
 * contract §6.6; ADR-0794 §5).
 *
 * §6.6 splits the work: this route answers `202` with a job id and the build
 * runs elsewhere, so the row is the whole contract between them. The request
 * carries an `Idempotency-Key` because a retried tap must not queue a second
 * build of the same photos.
 */

/** The §6.6 request; both media facts default to what the tap means. */
const requestSchema = z.object({
  scope: z.enum(["all_matches", "selected"]).default("all_matches"),
  matchIds: z.array(z.string()).optional(),
  quality: z.enum(["original", "thumbnail"]).default("original"),
});

/** The §6.6 answer: four keys, no row internals. */
const responseSchema = z.object({
  downloadId: z.string(),
  status: z.literal("queued"),
  pollUrl: z.string(),
  pollIntervalMs: z.number().int().positive(),
});

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/downloads",
  body: requestSchema,
  response: responseSchema,
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const scope = await requireAttendeeProfile(ctx);
    const { db, event, profile } = scope;
    const now = systemClock.now();
    const downloadId = new ObjectId();

    await platformRepo(db)
      .collection(COLLECTIONS.downloadJobs)
      .insertOne({
        _id: downloadId,
        tenantId: event.tenantKey,
        eventId: event.eventId,
        profileId: profile._id,
        subject: scope.subject,
        kind: "attendee",
        scope: ctx.body.scope,
        matchIds: ctx.body.matchIds ?? null,
        quality: ctx.body.quality,
        status: "queued",
        fileCount: 0,
        bytes: 0,
        url: null,
        urlExpiresAt: null,
        downloadsRemaining: DOWNLOAD_LINK_DOWNLOADS,
        createdAt: now,
        updatedAt: now,
        // §22: the row and its link expire on their own; the TTL index reads it.
        expireAt: new Date(now.getTime() + DOWNLOAD_JOB_TTL_SECONDS * 1000),
      });

    return {
      status: 202,
      body: {
        downloadId: downloadId.toHexString(),
        status: "queued" as const,
        pollUrl: `/api/v1/p/downloads/${downloadId.toHexString()}`,
        pollIntervalMs: DOWNLOAD_POLL_MS,
      },
    };
  },
});
