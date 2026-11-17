import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { eventActorAdmission, requireEventRole } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  eventImageListItemSchema,
  toEventImageListItem,
  type EventImageListAsset,
  type EventImageListRow,
} from "@/server/images/dto";
import { createMediaSigner } from "@/server/media/signer";
import { tenantRepo, type RepositoryCollection } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { releaseEntitlement } from "@/server/services/entitlements";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `PATCH`/`DELETE …/images/{imageId}` — hide or remove one image (OP-127 I3/I6/I7,
 * contract §4.4; ADR-0762 D5/D7).
 *
 * Both are organizer/co-organizer only (§4.4), so an active workspace member
 * reads the grid but cannot mutate it.
 *
 * `PATCH {visibility}` writes **only** `event_images.visibility`: hide is
 * reversible and both the attendee gallery and the §5.6 signed-URL gate filter
 * on `{visibility: "visible", deletedAt: null}`, so no match row and no cached
 * count moves.
 *
 * `DELETE` is one transaction with four effects: soft-delete the join row
 * (`deletedAt`), drop the image's `face_matches` rows and each affected
 * profile's cached `matchCount`, decrement the asset's `refCount` (the object is
 * purged only at `0`, by a job) and decrement the event's `imageCount`/
 * `storageBytes` while releasing the tenant's `storage.bytes` meter (§0.14 C6).
 */

/** The §4.4 visibility mutation. */
const patchBodySchema = z.object({
  visibility: z.enum(["visible", "hidden"]),
});

/** The `event_images` fields these handlers read. */
interface ImageRow extends EventImageListRow {
  readonly assetId: ObjectId;
}

/** The `media_assets` fields the delete reads. */
interface AssetRow extends EventImageListAsset {
  readonly _id: ObjectId;
}

/** One `face_matches` row's profile pointer. */
interface MatchRow {
  readonly profileId?: ObjectId;
}

/**
 * Load one live image and its asset, or deny `404` (a row of another event or a
 * soft-deleted one is the uniform not-found, never an existence oracle, §0.4).
 */
async function loadImage(
  db: Db,
  tenantKey: string,
  imageId: ObjectId,
  eventId: ObjectId
): Promise<{
  readonly image: ImageRow;
  readonly asset: AssetRow;
  readonly images: RepositoryCollection;
}> {
  const images = tenantRepo(tenantKey, db).collection(COLLECTIONS.eventImages);
  const image = (await images.findOne({
    _id: imageId,
    eventId,
    deletedAt: null,
  })) as ImageRow | null;
  if (image === null) {
    throw appError("not_found");
  }
  const asset = (await tenantRepo(tenantKey, db)
    .collection(COLLECTIONS.mediaAssets)
    .findOne({ _id: image.assetId })) as AssetRow | null;
  if (asset === null) {
    throw appError("internal_error");
  }
  return { image, asset, images };
}

export const PATCH = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images/:imageId",
  body: patchBodySchema,
  response: eventImageListItemSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(3) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const imageId = eventIdFromRequest(ctx.request, { segmentFromEnd: 1 });

    await requireEventRole(db, eventId, tenantId, principal, ["organizer", "co_organizer"]);

    const { asset, images } = await loadImage(db, tenantId, imageId, eventId);
    await images.updateOne({ _id: imageId }, { $set: { visibility: ctx.body.visibility } });

    const updated = (await images.findOne({ _id: imageId })) as ImageRow | null;
    if (updated === null) {
      throw appError("internal_error");
    }

    const signer = createMediaSigner({ currentSecret: getConfig().media.signingSecretCurrent });
    return { body: toEventImageListItem(updated, asset, signer) };
  },
});

export const DELETE = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images/:imageId",
  response: z.unknown(),
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(3) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId, principal } = ctx;
    if (tenantId === undefined || principal === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 3 });
    const imageId = eventIdFromRequest(ctx.request, { segmentFromEnd: 1 });

    await requireEventRole(db, eventId, tenantId, principal, ["organizer", "co_organizer"]);

    const now = systemClock.now();
    await withTransaction(async (session) => {
      const images = tenantRepo(tenantId, db).collection(COLLECTIONS.eventImages);
      const assets = tenantRepo(tenantId, db).collection(COLLECTIONS.mediaAssets);
      const matches = tenantRepo(tenantId, db).collection(COLLECTIONS.faceMatches);
      const profiles = tenantRepo(tenantId, db).collection(COLLECTIONS.attendeeEventProfiles);

      const image = (await images.findOne(
        { _id: imageId, eventId, deletedAt: null },
        { session }
      )) as ImageRow | null;
      if (image === null) {
        throw appError("not_found");
      }
      const asset = (await assets.findOne({ _id: image.assetId }, { session })) as AssetRow | null;
      if (asset === null) {
        throw appError("internal_error");
      }
      const bytes = asset.storage.bytes;

      await images.updateOne({ _id: imageId }, { $set: { deletedAt: now } }, { session });

      // "Removed from matched attendees' galleries" is the match rows: the
      // gallery reads matches, and each profile's cached total follows them.
      const matchRows = (await matches
        .find({ eventId, imageId }, { session })
        .project({ profileId: 1 })
        .toArray()) as unknown as MatchRow[];
      const removedPerProfile = new Map<string, { readonly id: ObjectId; count: number }>();
      for (const match of matchRows) {
        const id = match.profileId;
        if (id === undefined) {
          continue;
        }
        const key = id.toHexString();
        const known = removedPerProfile.get(key);
        removedPerProfile.set(key, { id, count: (known?.count ?? 0) + 1 });
      }
      await matches.deleteMany({ eventId, imageId }, { session });
      for (const removed of removedPerProfile.values()) {
        await profiles.updateOne(
          { _id: removed.id },
          { $inc: { matchCount: -removed.count } },
          { session }
        );
      }

      await assets.updateOne({ _id: image.assetId }, { $inc: { refCount: -1 } }, { session });
      await tenantRepo(tenantId, db)
        .collection(COLLECTIONS.events)
        .updateOne(
          { _id: eventId },
          { $inc: { "counters.imageCount": -1, "counters.storageBytes": -bytes } },
          { session }
        );
      await releaseEntitlement(session, tenantId, "storage.bytes", bytes);
    });

    return { status: 204, body: null };
  },
});
