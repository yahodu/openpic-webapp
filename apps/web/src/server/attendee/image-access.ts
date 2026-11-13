import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { checkEntitlement } from "@/server/services/entitlements";

import type { ResolvedEvent } from "./request-event";

/**
 * Who may be handed a URL for one image (OP-133; contract §6.6, §5.6, §0.4;
 * ADR-0794 §4).
 *
 * The gallery never carries an original: the bytes are requested on an explicit
 * tap, with a 15-minute token, so the original is a **signed capability** and
 * the interesting cases are the refusals. §6.6 fixes their order, and none of
 * them may reveal whether a row exists (§0.4):
 *
 *   1. `not_found` — no live image of this event carries the id;
 *   2. `feature_not_available` — the event's plan does not grant the derivative;
 *   3. `forbidden` — the caller holds no match for the image, or the organizer
 *      hid it (`event_images.visibility`, §16.3).
 */

/** The `event_images` fields the gate reads (§16.3). */
interface ImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly visibility?: string;
}

/** The `media_assets` fields a URL is signed from (§16.1). */
export interface SignableAssetRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly status?: string;
  readonly storage?: { readonly contentType?: string } | null;
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } } | null;
}

/** An image the caller is allowed to be handed a URL for. */
export interface SignableImage {
  readonly imageId: ObjectId;
  readonly asset: SignableAssetRow;
}

/** What one gate resolution needs. */
export interface SignableImageOptions {
  readonly db: Db;
  readonly event: ResolvedEvent;
  /** The caller's own profile in the addressed event. */
  readonly profileId: ObjectId;
  /** The `{imageId}` path segment. */
  readonly imageId: string;
  /** A plan gate to apply before the match check (`originals.download`). */
  readonly entitlementKey?: string;
}

/**
 * Resolve the image a signed-URL route may serve.
 *
 * @param options - The database, event scope, caller profile and image id.
 * @returns The live image and its asset.
 * @throws {AppError} `not_found`, `feature_not_available` or `forbidden` in the
 *   documented order.
 */
export async function requireSignableImage(options: SignableImageOptions): Promise<SignableImage> {
  const { db, event, profileId, imageId } = options;
  const tenant = tenantRepo(event.tenantKey, db);

  const image = !ObjectId.isValid(imageId)
    ? null
    : ((await tenant
        .collection(COLLECTIONS.eventImages)
        .findOne(
          { _id: new ObjectId(imageId), eventId: event.eventId, deletedAt: null },
          { projection: { _id: 1, assetId: 1, visibility: 1 } }
        )) as ImageRow | null);
  if (image === null) {
    throw appError("not_found", { details: { resource: "image" } });
  }

  const asset = (await tenant
    .collection(COLLECTIONS.mediaAssets)
    .findOne(
      { _id: image.assetId },
      { projection: { _id: 1, contentHash: 1, status: 1, storage: 1, derivatives: 1 } }
    )) as SignableAssetRow | null;
  if (asset === null) {
    throw appError("not_found", { details: { resource: "image" } });
  }

  if (options.entitlementKey !== undefined) {
    // Read-only verdict: `amount = 0` asks "is the feature granted".
    const verdict = await checkEntitlement(event.tenantKey, options.entitlementKey, 0, {}, { db });
    if (!verdict.allowed) {
      throw appError("feature_not_available", {
        details: { entitlementKey: options.entitlementKey },
      });
    }
  }

  const matched = await tenant
    .collection(COLLECTIONS.faceMatches)
    .countDocuments({ profileId, imageId: image._id });
  if (matched === 0 || image.visibility === "hidden") {
    throw appError("forbidden");
  }

  return { imageId: image._id, asset };
}
