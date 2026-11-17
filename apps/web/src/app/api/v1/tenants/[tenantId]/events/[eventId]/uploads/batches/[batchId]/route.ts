import { z } from "zod";

import { getRateLimitConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { readUploadBatch } from "@/server/uploads/batch-notifications";
import { isValidBatchId } from "@/server/uploads/batch-resolve";

/**
 * `GET /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batches/{batchId}` —
 * the batch status read (OP-126, contract §5.5; ADR-0760 D3/D5).
 *
 * The client polls this while a drag-and-drop is in flight and stops at a
 * terminal phase. One read answers the eight §5.5 keys: the phase, what the
 * transfer settled, what the pipeline is doing, the user-safe failures and the
 * stalled sessions (empty in v1 — the 24-hour sweep is OP-136's, so this read
 * never calls the storage provider).
 *
 * The read is scoped to the **event's** tenant: an event the caller is not an
 * actor on is the uniform `404`, never an existence oracle (§0.4). A `batchId`
 * outside §5.2's two shapes is `422`, because it is client-generated data rather
 * than a route param that could name another resource.
 */

/** The `batchId` shapes §5.2 accepts: a 24-hex id or a UUIDv4. */
const batchIdFieldSchema = z.string().refine(isValidBatchId);

/** The §5.5 response body — bare, exactly the eight keys. */
const batchStatusResponseSchema = z.object({
  batchId: z.string(),
  phase: z.enum(["uploading", "processing", "complete", "complete_with_errors"]),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  files: z.object({
    total: z.number(),
    uploaded: z.number(),
    duplicatesSkipped: z.number(),
    rejected: z.number(),
    failedUpload: z.number(),
  }),
  pipeline: z.object({
    queued: z.number(),
    processing: z.number(),
    done: z.number(),
    failed: z.number(),
  }),
  failures: z.array(
    z.object({
      eventImageId: z.string(),
      fileName: z.string(),
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
  ),
  stalledSessions: z.array(
    z.object({
      uploadSessionId: z.string(),
      fileName: z.string(),
      uploadedBytes: z.number(),
      totalBytes: z.number(),
      abortDeadline: z.string(),
    })
  ),
});

/** The last path segment — the client-generated `batchId` (§5.2). */
function batchIdFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return String(segments.at(-1));
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/batches/:batchId",
  response: batchStatusResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  rateLimitIdentity: rateLimitStage({
    classKey: "read.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  // The event id sits four segments from the end here (ADR-0741's off-by-one).
  tenant: tenantStage({ admission: eventActorAdmission(4) }),
  handler: async (ctx) => {
    const { tenantId } = ctx;
    if (tenantId === undefined) {
      throw appError("internal_error");
    }

    const batchId = batchIdFromRequest(ctx.request);
    if (!batchIdFieldSchema.safeParse(batchId).success) {
      throw appError("validation_failed", {
        details: {
          fields: [{ path: "batchId", code: "custom", message: "must be a 24-hex id or a UUIDv4" }],
        },
      });
    }

    return {
      status: 200,
      body: await readUploadBatch({
        db: getDb(),
        tenantKey: tenantId,
        eventId: eventIdFromRequest(ctx.request, { segmentFromEnd: 4 }),
        batchId,
      }),
    };
  },
});
