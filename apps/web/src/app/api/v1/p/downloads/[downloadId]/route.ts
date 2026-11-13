import { z } from "zod";

import { subjectFilter } from "@/server/attendee/consent-guard";
import {
  callerProfileId,
  downloadStatusBody,
  findDownloadJob,
  ownsJob,
} from "@/server/attendee/download-job";
import { subjectForRequest } from "@/server/attendee/subject";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getRateLimitConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";

/**
 * `GET /api/v1/p/downloads/{downloadId}` — the owner's view of one download job
 * (OP-133, contract §6.6; ADR-0794 §5).
 *
 * The URL carries no event, so the id alone addresses the row — but the id is
 * never the authorization: the caller is the owner only when their own profile
 * on the job's event is the job's profile. A stranger gets `404`, never `403`,
 * so the id's existence is not confirmed (§0.4).
 */

/** The §6.6 status body. */
const responseSchema = z.object({
  downloadId: z.string(),
  status: z.enum(["queued", "building", "ready", "failed", "expired"]),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  url: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  downloadsRemaining: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const GET = defineRoute({
  route: "/api/v1/p/downloads/:downloadId",
  response: responseSchema,
  rateLimit: rateLimitStage({
    classKey: "read.hot",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const segments = new URL(ctx.request.url).pathname.split("/").filter((part) => part !== "");
    const downloadId = segments.at(-1) ?? "";
    const db = getDb();
    const subject = await subjectForRequest(db, ctx.request, ctx.principal);

    const job = await findDownloadJob(db, downloadId);
    const owned = job === null ? null : await callerProfileId(db, job, subjectFilter(subject));
    if (job === null || !ownsJob(job, owned)) {
      throw appError("not_found", { details: { resource: "download" } });
    }

    return { body: downloadStatusBody(job) };
  },
});
