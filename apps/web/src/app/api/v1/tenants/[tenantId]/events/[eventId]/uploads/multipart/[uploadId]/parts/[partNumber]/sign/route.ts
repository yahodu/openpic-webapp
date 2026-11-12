import { z } from "zod";

import { getRateLimitConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { loadMultipartUpload } from "@/server/uploads/multipart-session";
import { PRESIGN_TTL_SECONDS } from "@/server/uploads/single-put";

/**
 * `GET …/uploads/multipart/{uploadId}/parts/{n}/sign?key=` — Uppy's `signPart`
 * hook (OP-125 I1, contract §5.4; ADR-0741).
 *
 * One presigned **part** `PUT` for one part number: the URL carries the upload
 * id, the part number and the SigV4 signature, and the client `PUT`s the bytes
 * straight to storage. The URL is a bearer credential for that part, so it is
 * never logged (the answer is the only place it appears), and the class is rate
 * limited at `upload.sign` (900 / minute, §0.11) because a client asks for one
 * per part.
 *
 * §5.4 allows part numbers `1–10000`; anything else is refused before a URL is
 * signed, and a handle that does not prove ownership of the session is `404`.
 */

/** The sign answer: the URL and the instant it stops working. */
const signPartSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
});

/** §5.4's part-number bounds. */
const PART_NUMBER_MIN = 1;
const PART_NUMBER_MAX = 10_000;

/**
 * Read the `{n}` path segment of `…/parts/{n}/sign`.
 *
 * @param request - The inbound request.
 * @returns The parsed part number.
 * @throws {AppError} `validation_failed` when it is not an integer in §5.4's range.
 */
function partNumberFromRequest(request: Request): number {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-2) ?? "";
  const partNumber = Number(raw);
  if (
    !Number.isInteger(partNumber) ||
    partNumber < PART_NUMBER_MIN ||
    partNumber > PART_NUMBER_MAX
  ) {
    throw appError("validation_failed", {
      details: {
        fields: [
          {
            path: "partNumber",
            code: "custom",
            message: `partNumber must be an integer between ${String(PART_NUMBER_MIN)} and ${String(PART_NUMBER_MAX)}.`,
          },
        ],
      },
    });
  }
  return partNumber;
}

export const GET = defineRoute({
  route:
    "/api/v1/tenants/:tenantId/events/:eventId/uploads/multipart/:uploadId/parts/:partNumber/sign",
  response: signPartSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // `upload.sign` is a per-user class, so it keys on the authenticated
  // principal after the auth stage, not on the pre-auth IP fallback (§0.11).
  rateLimitIdentity: rateLimitStage({
    classKey: "upload.sign",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  // The event id sits seven segments from the end here — `sign`/`{n}` count as two
  // (ADR-0741 D2).
  tenant: tenantStage({ admission: eventActorAdmission(7) }),
  handler: async (ctx) => {
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }

    const partNumber = partNumberFromRequest(ctx.request);
    const { locationKey, objectKey, uploadId } = await loadMultipartUpload({
      db: getDb(),
      tenantKey: tenantId,
      request: ctx.request,
      principal,
      eventIdFromEnd: 7,
      uploadIdFromEnd: 4,
    });

    const signed = await getObjectStorage().presignPart(
      locationKey,
      objectKey,
      uploadId,
      partNumber,
      PRESIGN_TTL_SECONDS
    );

    return { body: { url: signed.url, expiresAt: signed.expiresAt } };
  },
});
