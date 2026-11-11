import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";
import {
  eventImageSchema,
  toEventImage,
  type EventImageAsset,
  type EventImageRow,
} from "@/server/uploads/event-image-dto";

/**
 * `GET …/events/{eventId}/images` — the event's gallery, newest first (OP-124
 * E1; contract §4.4).
 *
 * Deliberately **minimal**: the page, the projected `EventImage` rows and the
 * `summary` totals the upload journey reads back ("GET images lists it"). The
 * full listing lane owns the cursor, the `status`/`visibility`/`batchId`
 * filters, the signed thumbnail URLs and the width/height hints — none of which
 * this route answers yet.
 *
 * shortcut: no cursor, no filters, no signed thumbnail URLs (§4.4); upgrade when
 * the gallery UI lands.
 */

/** The page ceiling (§4.4 default). */
const DEFAULT_LIMIT = 60;

/** The §4.4 page block. */
const pageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});

/** The §4.4 summary block. */
const summarySchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  approximate: z.boolean(),
});

/** The §4.4 listing body. */
const imageListSchema = z.object({
  data: z.array(eventImageSchema),
  page: pageSchema,
  summary: summarySchema,
});

/** The `media_assets` fields the projection reads. */
interface AssetRow {
  readonly _id: { toHexString(): string };
  readonly storage: EventImageAsset;
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images",
  response: imageListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(2) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId } = ctx;
    if (tenantId === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });

    const rows = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.eventImages)
      .find({ eventId })
      .sort({ sequence: -1 })
      .limit(DEFAULT_LIMIT)
      .toArray()) as unknown as EventImageRow[];

    const event = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.events)
      .findOne({ _id: eventId })) as { counters?: { imageCount?: number } } | null;

    const assets = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.mediaAssets)
      .find({ _id: { $in: rows.map((row) => row.assetId) } })
      .toArray()) as unknown as AssetRow[];
    const assetById = new Map(assets.map((asset) => [asset._id.toHexString(), asset.storage]));

    const data = rows.map((row) =>
      toEventImage(row, assetById.get(row.assetId.toHexString()) ?? { bytes: 0, contentType: "" })
    );
    const countOf = (status: string): number =>
      data.filter((image) => image.processing.status === status).length;

    return {
      body: {
        data,
        page: { nextCursor: null, hasMore: false, limit: DEFAULT_LIMIT },
        summary: {
          total: event?.counters?.imageCount ?? data.length,
          done: countOf("done"),
          queued: countOf("queued"),
          processing: countOf("processing"),
          failed: countOf("failed"),
          approximate: false,
        },
      },
    };
  },
});
