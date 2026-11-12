import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission, resolveEventActorRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { idempotencyStage, mongoIdempotencyStore } from "@/server/idempotency";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { completeStoredUpload } from "@/server/uploads/complete-upload";
import { eventImageSchema } from "@/server/uploads/event-image-dto";
import { PART_SIZE_BYTES, partCountFor } from "@/server/uploads/multipart";
import { loadMultipartUpload } from "@/server/uploads/multipart-session";
import { uploadWindowClosed } from "@/server/uploads/upload-window";

/**
 * `POST …/uploads/multipart/{uploadId}/complete` — Uppy's
 * `completeMultipartUpload` hook (OP-125 I3-I5, contract §5.4; ADR-0741).
 *
 * The client acknowledges the parts it uploaded; the server verifies the
 * acknowledgement against the **declared** file, asks the provider to assemble,
 * and then runs the very same registration transaction as the single-`PUT`
 * completion (`@/server/uploads/complete-upload`).
 *
 * The gap is derived from the file's expected part count, not from what the
 * provider holds: a three-part file completed with parts 1 and 3 names `[2]`
 * even though S3 would happily concatenate that subset into a truncated photo.
 * The check runs before `CompleteMultipartUpload`, so a refused completion
 * assembles nothing and writes nothing. A provider that no longer holds the
 * series answers `409 upload_expired`, so the client restarts from the
 * pre-check.
 *
 * Idempotency is required (§0.9): a client that cannot name its attempt is
 * refused rather than assembling twice.
 */

/** One part acknowledgement, as Uppy echoes it back. */
const completedPartSchema = z.object({
  PartNumber: z.number().int().min(1).max(10_000),
  ETag: z.string().min(1),
});

/** The §5.4 completion body. */
const completeBodySchema = z.object({
  key: z.string().min(1),
  parts: z.array(completedPartSchema).min(1),
});

/** The `events` fields the window rule reads. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
}

/** The parts the declared size slices into but the acknowledgement omits. */
function missingPartNumbers(expectedParts: number, acknowledged: readonly number[]): number[] {
  const present = new Set(acknowledged);
  const missing: number[] = [];
  for (let partNumber = 1; partNumber <= expectedParts; partNumber += 1) {
    if (!present.has(partNumber)) {
      missing.push(partNumber);
    }
  }
  return missing;
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/multipart/:uploadId/complete",
  body: completeBodySchema,
  response: eventImageSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits five segments from the end here — `complete` counts as one
  // (ADR-0741 D2).
  tenant: tenantStage({ admission: eventActorAdmission(5) }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal, requestId } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 5 });
    const { parts } = ctx.body;

    const { session, uploadId, locationKey, objectKey } = await loadMultipartUpload({
      db,
      tenantKey,
      request: ctx.request,
      principal,
      eventIdFromEnd: 5,
      uploadIdFromEnd: 2,
      handle: ctx.body.key,
    });

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
      startedAt: session.createdAt,
      graceMinutes: settings.upload.inflightGraceMinutes,
    });
    if (windowClosed !== null) {
      throw appError("upload_window_closed", { details: { ...windowClosed } });
    }

    // A subset S3 would concatenate happily is still a truncated file, so the
    // gap is computed from the declaration before the provider is asked to
    // assemble anything (ADR-0741 A6).
    const missing = missingPartNumbers(
      partCountFor({ size: session.declaredSize, partSizeBytes: PART_SIZE_BYTES }),
      parts.map((part) => part.PartNumber)
    );
    if (missing.length > 0) {
      throw appError("parts_missing", { details: { missingPartNumbers: missing } });
    }

    await getObjectStorage().completeMultipart(locationKey, objectKey, uploadId, parts);

    return completeStoredUpload({
      db,
      tenantKey,
      principal,
      eventId,
      session,
      objectKey,
      // A multipart completion declares no byte count: the assembled object is
      // the truth (ADR-0741 A4).
      declaredBytes: null,
      requestId,
      now,
      spaceKey: settings.face.activeSpaceKey,
    });
  },
});
