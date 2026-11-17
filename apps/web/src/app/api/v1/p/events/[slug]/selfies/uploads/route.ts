import { z } from "zod";

import { attendeeRateLimitStage } from "@/server/attendee/attendee-rate-limit";
import { requireAttendeeScope, requireRetentionOpen } from "@/server/attendee/request-event";
import { SELFIE_LOCATION_KEY, selfieObjectKey } from "@/server/attendee/selfie-submit";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { PRESIGN_TTL_SECONDS } from "@/server/uploads/single-put";

/**
 * `POST /api/v1/p/events/{slug}/selfies/uploads` — presign one selfie upload
 * (OP-132, contract §6.3, §5.3; ADR-0792).
 *
 * Selfies are always a single `PUT` (§6.3), so the answer is exactly the §5.3
 * envelope — `{method, url, headers, expiresAt, confirmUrl}` — and the bytes
 * never transit the control plane. The object is content-addressed by the hash
 * alone, so the submit route's `headObject` verification derives the same key
 * without being told a MIME type.
 *
 * The declared size is refused against `platformSettings.upload.maxFileBytes`
 * before any storage call, and consent remains the hard precondition (§6.2).
 */

/** A 64-lowercase-hex SHA-256 — the content hash's only admitted shape (§5.1). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The §6.3 upload claim. */
const uploadBodySchema = z.object({
  hash: z.string().regex(HASH_PATTERN),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
});

/** The §5.3 presign envelope: exactly five keys, no bucket and no object key. */
const uploadResponseSchema = z.object({
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  confirmUrl: z.string(),
});

export const POST = defineRoute({
  route: "/api/v1/p/events/:slug/selfies/uploads",
  body: uploadBodySchema,
  response: uploadResponseSchema,
  auth: (ctx, request) =>
    requireAuth("attendee", { auth: getAuth(), database: getDb() })(ctx, request),
  rateLimitIdentity: attendeeRateLimitStage("selfie.submit"),
  handler: async (ctx) => {
    const { db, slug, event } = await requireAttendeeScope(ctx, { slugFromEnd: 3 });

    // §6.3: the retention window is checked before the declared size, so an
    // expired event answers `410` rather than `413` when both apply.
    requireRetentionOpen(event, systemClock.now());

    const settings = await getPlatformSettings({ db });
    const { hash, size, mimeType } = ctx.body;
    if (size > settings.upload.maxFileBytes) {
      throw appError("file_too_large", {
        details: { maxBytes: settings.upload.maxFileBytes, actualBytes: size },
      });
    }

    const presigned = await getObjectStorage().presignPut(
      SELFIE_LOCATION_KEY,
      selfieObjectKey(hash),
      mimeType,
      PRESIGN_TTL_SECONDS
    );

    return {
      status: 201,
      body: {
        method: "PUT" as const,
        url: presigned.url,
        headers: { ...presigned.headers },
        expiresAt: presigned.expiresAt,
        confirmUrl: `/api/v1/p/events/${slug}/selfies`,
      },
    };
  },
});
