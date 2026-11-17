import { z } from "zod";

import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getObjectStorage } from "@/server/storage/get-object-storage";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { loadMultipartUpload } from "@/server/uploads/multipart-session";

/**
 * `GET …/uploads/multipart/{uploadId}/parts?key=` — Uppy's `listParts` hook
 * (OP-125 I1, contract §5.4; ADR-0741).
 *
 * The answer is the provider's live view, in the provider's own S3-shaped keys
 * (§16.2: there is no part-tracking collection), so a resuming client learns
 * exactly which parts already landed. The `key` handle must prove ownership of
 * the addressed session first — a foreign or edited token is `404`.
 */

/** The `ListParts` answer, S3-shaped because Uppy consumes it verbatim. */
const listedPartsSchema = z.object({
  parts: z.array(
    z.object({
      PartNumber: z.number().int().positive(),
      ETag: z.string(),
      Size: z.number().int().nonnegative(),
    })
  ),
});

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads/multipart/:uploadId/parts",
  response: listedPartsSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits five segments from the end here — `parts` counts as one
  // (ADR-0741 D2).
  tenant: tenantStage({ admission: eventActorAdmission(5) }),
  handler: async (ctx) => {
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }

    const { locationKey, objectKey, uploadId } = await loadMultipartUpload({
      db: getDb(),
      tenantKey: tenantId,
      request: ctx.request,
      principal,
      eventIdFromEnd: 5,
      uploadIdFromEnd: 2,
    });

    const listed = await getObjectStorage().listParts(locationKey, objectKey, uploadId);
    return {
      body: {
        parts: listed.parts.map((part) => ({
          PartNumber: part.PartNumber,
          ETag: part.ETag,
          Size: part.Size,
        })),
      },
    };
  },
});
