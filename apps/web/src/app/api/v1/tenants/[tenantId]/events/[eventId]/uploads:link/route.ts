import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import { MAX_BATCH_FILES, isValidBatchId } from "@/server/uploads/batch-resolve";
import { attachImage } from "@/server/uploads/registration";
import { batchIdValue } from "@/server/uploads/single-put";

/**
 * `POST …/uploads:link` — attaching stored assets without bytes (OP-124 I5,
 * contract §5.3; ADR-0721 D2).
 *
 * The client's `batch-resolve` answered `state: "completed", linked: false` for
 * these hashes, so the tenant already stores the bytes: only the event link is
 * missing. Each asset is attached in its own transaction — consume
 * `images.per_event`, `refCount` + 1, the event's next `sequence`, the event
 * counters — and **no** `storage.bytes` moves, because no byte did (I5).
 *
 * The answer is the caller's only oracle, and it names only what it was given:
 * an asset this tenant does not hold, or one this event already holds, lands in
 * `skipped` instead of failing the batch.
 */

/** A 24-hex `ObjectId` — the only shape an asset id may take. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The §5.3 link body. */
const linkBodySchema = z.object({
  batchId: z.string().refine(isValidBatchId),
  assetIds: z.array(z.string()).min(1).max(MAX_BATCH_FILES),
});

/** The §5.3 link answer. */
const linkResponseSchema = z.object({
  linked: z.array(z.object({ assetId: z.string(), eventImageId: z.string() })),
  skipped: z.array(z.string()),
});

/** MongoDB's duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/uploads:link",
  body: linkBodySchema,
  response: linkResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  // The event id sits two segments from the end here — the default (ADR-0721 D2).
  tenant: tenantStage({ admission: eventActorAdmission(2) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const tenantKey = tenantId;
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const { batchId, assetIds } = ctx.body;

    const event = await tenantRepo(tenantKey, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId });
    if (event === null) {
      throw appError("not_found");
    }

    const assets = tenantRepo(tenantKey, db).collection(COLLECTIONS.mediaAssets);
    const images = tenantRepo(tenantKey, db).collection(COLLECTIONS.eventImages);
    const uploadBatchId = batchIdValue(batchId);
    const now = systemClock.now();

    const linked: { assetId: string; eventImageId: string }[] = [];
    const skipped: string[] = [];

    for (const assetIdHex of [...new Set(assetIds)]) {
      if (!OBJECT_ID_HEX.test(assetIdHex)) {
        skipped.push(assetIdHex);
        continue;
      }
      const assetId = new ObjectId(assetIdHex);
      const asset = await assets.findOne({ _id: assetId });
      // A foreign asset is indistinguishable from an absent one on purpose.
      if (asset === null || (await images.findOne({ eventId, assetId })) !== null) {
        skipped.push(assetIdHex);
        continue;
      }

      try {
        const eventImageId = await withTransaction(async (txn) => {
          await assets.updateOne({ _id: assetId }, { $inc: { refCount: 1 } }, { session: txn });
          const row = await attachImage({
            session: txn,
            db,
            tenantKey,
            eventId,
            assetId,
            actorUserId: principal,
            uploadBatchId,
            storageBytes: 0,
            now,
          });
          return row._id.toHexString();
        });
        linked.push({ assetId: assetIdHex, eventImageId });
      } catch (error) {
        // A racing link of the same asset lost the unique `{eventId, assetId}`
        // race: the asset is already attached, so it is skipped, not an error.
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        skipped.push(assetIdHex);
      }
    }

    return { status: 201, body: { linked, skipped } };
  },
});
