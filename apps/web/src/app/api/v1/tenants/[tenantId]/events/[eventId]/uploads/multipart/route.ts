import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { created, defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { buildObjectKey } from "@/server/storage/object-key";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { isValidBatchId } from "@/server/uploads/batch-resolve";
import { PART_SIZE_BYTES, partCountFor, reuseUploadDecision } from "@/server/uploads/multipart";
import { getHandleService } from "@/server/uploads/multipart-handle";
import { multipartUploadIdOf } from "@/server/uploads/multipart-session";
import { batchIdValue, extensionForMime } from "@/server/uploads/single-put";
import { uploadWindowClosed } from "@/server/uploads/upload-window";

/**
 * `POST …/events/{eventId}/uploads/multipart` — Uppy's
 * `createMultipartUpload` hook (OP-125 I1/I2, contract §5.4; ADR-0741).
 *
 * One call either **resumes** the caller's still-valid upload for this content
 * hash (Uppy echoed it back as `existingUploadId`) or starts a new provider
 * series, and answers the six facts the client slices and signs with:
 * `uploadSessionId`, the provider's `uploadId`, the opaque `key` handle, the
 * published `partSizeBytes` and the derived `partCount`, and `resumed`.
 *
 * The `upload_sessions` row is the only state: `mode: "multipart"`, `pending`,
 * the provider id inside `externalRefs[{ kind: "multipart_upload" }]` (schema
 * §16.2 — never a vendor-named field) and the schema's five-day TTL. There is no
 * part-tracking collection; the provider's `ListParts` is the truth (§16.2).
 *
 * A claim after the upload window closed is `409 upload_window_closed` before
 * any storage call (§5.2), and the file is validated against
 * `platformSettings.upload` exactly as the single-PUT presign is.
 */

/** A 64-lowercase-hex SHA-256 — the content hash's only admitted shape (§5.1). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The §5.4 create body: one file's claim. */
const createBodySchema = z.object({
  batchId: z.string().refine(isValidBatchId),
  hash: z.string().regex(HASH_PATTERN),
  size: z.number().int().nonnegative(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  existingUploadId: z.string().min(1).optional(),
});

/** The §5.4 create answer — exactly these six keys (§0.15). */
const createResponseSchema = z.object({
  uploadSessionId: z.string(),
  uploadId: z.string(),
  key: z.string(),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().nonnegative(),
  resumed: z.boolean(),
});

/** The `events` fields the claim is judged against. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
}

/** The `upload_sessions` fields the resume decision reads. */
interface ResumeRow {
  readonly _id: ObjectId;
  readonly status: string;
  readonly expireAt: Date;
  readonly externalRefs: readonly { readonly kind: string; readonly id: string }[];
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/multipart",
  body: createBodySchema,
  response: createResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits three segments from the end here (ADR-0741 D2).
  tenant: tenantStage({ admission: eventActorAdmission(3) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const eventIdHex = eventId.toHexString();
    const { batchId, hash, size, fileName, mimeType, existingUploadId } = ctx.body;

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

    const sessions = tenantRepo(tenantKey, db).collection(COLLECTIONS.uploadSessions);
    const observed = (await sessions.findOne({
      createdByUserId: new ObjectId(principal),
      contentHash: hash,
      mode: "multipart",
      status: "pending",
    })) as ResumeRow | null;

    const observedUploadId = observed === null ? null : multipartUploadIdOf(observed);
    const decision = reuseUploadDecision({
      existingUploadId,
      session:
        observed !== null && observedUploadId !== null
          ? { uploadId: observedUploadId, status: observed.status, expireAt: observed.expireAt }
          : null,
      now,
    });

    const objectKey = buildObjectKey(hash, extensionForMime(mimeType));
    // Reuse only when the named id is the observed session's live one; anything
    // else starts a fresh provider series and overwrites the pending row.
    let uploadId = decision === "reuse" ? observedUploadId : null;
    const resumed = uploadId !== null;
    uploadId ??= (await getObjectStorage().createMultipart("originals", objectKey, mimeType))
      .uploadId;

    const expireAt = new Date(now.getTime() + settings.retention.uploadSessionDays * 86_400_000);
    const session = (await sessions.findOneAndUpdate(
      {
        createdByUserId: new ObjectId(principal),
        contentHash: hash,
        mode: "multipart",
        status: "pending",
      },
      {
        $set: {
          eventId,
          batchId: batchIdValue(batchId),
          fileName,
          declaredSize: size,
          declaredMimeType: mimeType,
          externalRefs: [{ kind: "multipart_upload", id: uploadId }],
          updatedAt: now,
          expireAt,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdByUserId: new ObjectId(principal),
          contentHash: hash,
          mode: "multipart",
          status: "pending",
          assetId: null,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" }
    )) as { readonly _id: ObjectId } | null;
    if (session === null) {
      // An upsert with `returnDocument: "after"` always answers the document.
      throw appError("internal_error");
    }
    const uploadSessionId = session._id.toHexString();

    return created(
      {
        uploadSessionId,
        uploadId,
        key: getHandleService().issueHandle({
          locationKey: "originals",
          objectKey,
          uploadSessionId,
          userId: principal,
        }),
        partSizeBytes: PART_SIZE_BYTES,
        partCount: partCountFor({ size, partSizeBytes: PART_SIZE_BYTES }),
        resumed,
      },
      `/api/v1/tenants/${tenantKey}/events/${eventIdHex}/uploads/multipart/${uploadId}/parts`
    );
  },
});
