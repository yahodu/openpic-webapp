import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { loadMultipartUpload } from "@/server/uploads/multipart-session";

/**
 * `DELETE …/uploads/multipart/{uploadId}?key=` — Uppy's
 * `abortMultipartUpload` hook (OP-125 I6, contract §5.4; ADR-0741).
 *
 * Aborting is idempotent: the provider drops the series (a series it already
 * dropped is a success) and the session is marked `aborted`, so a retried abort
 * after a network blip answers `204` again with an empty body. Nothing else is
 * written — no asset, no join row, no counter.
 */

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/multipart/:uploadId",
  response: noContentSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits four segments from the end here (ADR-0741 D2).
  tenant: tenantStage({ admission: eventActorAdmission(4) }),
  handler: async (ctx) => {
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const db = getDb();

    const { session, uploadId, locationKey, objectKey } = await loadMultipartUpload({
      db,
      tenantKey: tenantId,
      request: ctx.request,
      principal,
      eventIdFromEnd: 4,
      uploadIdFromEnd: 1,
    });

    await getObjectStorage().abortMultipart(locationKey, objectKey, uploadId);
    await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.uploadSessions)
      .updateOne(
        { _id: session._id },
        { $set: { status: "aborted", updatedAt: systemClock.now() } }
      );

    return { status: 204, body: null };
  },
});
