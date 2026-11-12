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
import { buildObjectKey } from "@/server/storage/object-key";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { completeStoredUpload } from "@/server/uploads/complete-upload";
import { eventImageSchema } from "@/server/uploads/event-image-dto";
import { extensionForMime } from "@/server/uploads/single-put";
import { uploadWindowClosed } from "@/server/uploads/upload-window";

/**
 * `POST …/uploads/{uploadSessionId}/complete` — the registration transaction
 * (OP-124 I1–I4/I6/I8/I9, contract §5.3; ADR-0721 D2).
 *
 * The bytes are already in storage, put there by the client's own `PUT` to the
 * presigned URL — they never transit this server. This route loads the session,
 * enforces the upload window (a session started before the close may finish
 * inside `inflightGraceMinutes`) and hands the object to the shared completion,
 * which verifies the stored size and type and then registers it in one
 * transaction (see `@/server/uploads/complete-upload`).
 *
 * A duplicate — the event already holds this asset — is not an error: the
 * unique `{eventId, assetId}` index is the arbiter, the transaction writes
 * nothing, and the answer is `200` with the existing image (§5.3, I4).
 *
 * Counters always follow the **event's** tenant, never the caller's own
 * workspace: a co-organizer from another tenant moves only `{tenantId}`'s usage
 * and is refused with that tenant's limit (I10/I11).
 */

/** The §5.3 completion body. */
const completeBodySchema = z.object({
  etag: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

/** The `events` fields this route reads outside the transaction. */
interface EventRow {
  readonly _id: ObjectId;
  readonly uploadWindowEndsAt: Date | null;
}

/** The `upload_sessions` fields this route reads (§16.2). */
interface SessionRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly batchId: ObjectId | string;
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly createdAt: Date;
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/:uploadSessionId/complete",
  body: completeBodySchema,
  response: eventImageSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits four segments from the end here (ADR-0721 D2).
  tenant: tenantStage({ admission: eventActorAdmission(4) }),
  idempotency: idempotencyStage({ store: mongoIdempotencyStore(), required: true }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal, requestId } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 4 });
    const sessionId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const { bytes } = ctx.body;

    const event = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as EventRow | null;
    if (event === null) {
      throw appError("not_found");
    }

    const session = (await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.uploadSessions)
      .findOne({ _id: sessionId, eventId })) as SessionRow | null;
    if (session === null) {
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

    return completeStoredUpload({
      db,
      tenantKey,
      principal,
      eventId,
      session,
      objectKey: buildObjectKey(session.contentHash, extensionForMime(session.declaredMimeType)),
      declaredBytes: bytes,
      requestId,
      now,
      spaceKey: settings.face.activeSpaceKey,
    });
  },
});
