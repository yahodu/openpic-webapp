import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  eventImageListItemSchema,
  toEventImageListItem,
  type EventImageListAsset,
  type EventImageListRow,
} from "@/server/images/dto";
import { requeueImages } from "@/server/images/requeue";
import { createMediaSigner } from "@/server/media/signer";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST …/images/{imageId}/reprocess` — retry one failed image (OP-127 I2,
 * contract §4.4; ADR-0762 D8/D9).
 *
 * Only a `failed` image is reprocessable: anything else is `409 not_failed`, and
 * nothing is enqueued. The reset zeroes `attempts`, clears the previous run's
 * error and timing, re-stamps `queuedAt`, re-enqueues the pipeline work item and
 * answers `202` with the updated §4.4 item so the client re-renders from one
 * call.
 */

/** The `event_images` fields this route reads. */
interface ImageRow extends EventImageListRow {
  readonly deletedAt?: Date | null;
}

/** The `media_assets` fields the answer projects. */
interface AssetRow extends EventImageListAsset {
  readonly _id: { toHexString(): string };
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images/:imageId/reprocess",
  response: eventImageListItemSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(4) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, requestId } = ctx;
    if (tenantId === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 4 });
    const imageId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    const images = tenantRepo(tenantId, db).collection(COLLECTIONS.eventImages);
    const image = (await images.findOne({
      _id: imageId,
      eventId,
      deletedAt: null,
    })) as ImageRow | null;
    if (image === null) {
      throw appError("not_found");
    }
    if (image.processing?.status !== "failed") {
      throw appError("not_failed");
    }

    const settings = await getPlatformSettings({ db });
    await requeueImages({
      db,
      tenantKey: tenantId,
      eventId,
      rows: [image],
      now: systemClock.now(),
      spaceKey: settings.face.activeSpaceKey,
      requestId,
    });

    const updated = (await images.findOne({ _id: imageId })) as ImageRow | null;
    if (updated === null) {
      throw appError("internal_error");
    }
    const asset = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ _id: updated.assetId })) as AssetRow | null;
    if (asset === null) {
      throw appError("internal_error");
    }

    const signer = createMediaSigner({ currentSecret: getConfig().media.signingSecretCurrent });
    return { status: 202, body: toEventImageListItem(updated, asset, signer) };
  },
});
