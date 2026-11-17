import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { isValidBatchId } from "@/server/uploads/batch-resolve";
import { PRESIGN_TTL_SECONDS, batchIdValue, extensionForMime } from "@/server/uploads/single-put";
import { uploadWindowClosed } from "@/server/uploads/upload-window";

/**
 * `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/params` — the
 * single-PUT presign (OP-124 I1, contract §5.3; ADR-0721 D2).
 *
 * Uppy's `getUploadParameters` hook. Answers `201` with an **opaque** presigned
 * PUT (`{ uploadSessionId, method, url, headers, expiresAt, completeUrl }`) and
 * nothing else: no bucket, no object key, no location field (§0.15). One
 * `upload_sessions` row is upserted (`mode: "single"`, `status: "pending"`, the
 * schema's TTL on `expireAt`), and the completion reads it back.
 *
 * Idempotency is **required** (§0.9): a client that cannot name its attempt is
 * refused rather than minting a second session and a second presign.
 *
 * The claim is validated against `platformSettings.upload` before any storage
 * call — a file above `maxFileBytes` is `413 file_too_large`, a MIME outside
 * the allow-list is `415 unsupported_media_type` — and a closed upload window
 * is `409 upload_window_closed` (§5.2). The presigned URL is a bearer
 * credential, so it is never logged.
 */

/** A 64-lowercase-hex SHA-256 — the content hash's only admitted shape (§5.1). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The §5.3 request body: one file's claim. */
const paramsBodySchema = z.object({
  batchId: z.string().refine(isValidBatchId),
  hash: z.string().regex(HASH_PATTERN),
  size: z.number().int().nonnegative(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
});

/** The §5.3 answer — exactly these six keys (§0.15). */
const paramsResponseSchema = z.object({
  uploadSessionId: z.string(),
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  completeUrl: z.string(),
});

/** The `events` fields the presign reads. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
}

/** The `upload_sessions` fields the response needs back. */
interface SessionRow {
  readonly _id: ObjectId;
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/params",
  body: paramsBodySchema,
  response: paramsResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits three segments from the end here, not two (ADR-0721 D2).
  tenant: tenantStage({ admission: eventActorAdmission(3) }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      // The auth and tenant stages always publish both, or deny.
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const eventIdHex = eventId.toHexString();
    const { batchId, hash, size, fileName, mimeType } = ctx.body;

    const event = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventRow | null;
    if (event === null) {
      throw appError("not_found");
    }

    const settings = await getPlatformSettings({ db });
    const now = systemClock.now();

    const role = await resolveEventActorRole(db, eventId, tenantKey, principal);
    const windowClosed = uploadWindowClosed({
      windowEndsAt: event.uploadWindowEndsAt,
      now,
      canExtend: role === "organizer",
    });
    if (windowClosed !== null) {
      throw appError("upload_window_closed", { details: { ...windowClosed } });
    }

    if (size > settings.upload.maxFileBytes) {
      throw appError("file_too_large", {
        details: { maxBytes: settings.upload.maxFileBytes, actualBytes: size },
      });
    }
    if (!settings.upload.supportedMimeTypes.includes(mimeType)) {
      throw appError("unsupported_media_type", {
        details: { supportedMimeTypes: settings.upload.supportedMimeTypes },
      });
    }

    const presigned = await getObjectStorage().presignPut(
      "originals",
      buildObjectKey(hash, extensionForMime(mimeType)),
      mimeType,
      PRESIGN_TTL_SECONDS
    );

    const expireAt = new Date(now.getTime() + settings.retention.uploadSessionDays * 86_400_000);
    const session = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.uploadSessions)
      .findOneAndUpdate(
        {
          createdByUserId: new ObjectId(principal),
          contentHash: hash,
          mode: "single",
          status: "pending",
        },
        {
          $set: {
            eventId,
            batchId: batchIdValue(batchId),
            fileName,
            declaredSize: size,
            declaredMimeType: mimeType,
            updatedAt: now,
            expireAt,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdByUserId: new ObjectId(principal),
            contentHash: hash,
            mode: "single",
            status: "pending",
            externalRefs: [],
            assetId: null,
            createdAt: now,
          },
        },
        { upsert: true, returnDocument: "after" }
      )) as SessionRow | null;
    if (session === null) {
      // An upsert with `returnDocument: "after"` always answers the document.
      throw appError("internal_error");
    }
    const uploadSessionId = session._id.toHexString();
    const completePath = `/api/v1/tenants/${tenantKey}/events/${eventIdHex}/uploads/${uploadSessionId}/complete`;

    return created(
      {
        uploadSessionId,
        method: "PUT" as const,
        url: presigned.url,
        headers: { ...presigned.headers },
        expiresAt: presigned.expiresAt,
        completeUrl: completePath,
      },
      completePath
    );
  },
});
