import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { eventActorAdmission } from "@/server/events/access";
import { eventIdFromRequest } from "@/server/events/event-id";
import { buildCursorPage, parsePageQuery } from "@/server/http/cursor";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { toFieldErrors } from "@/server/http/validation";
import {
  eventImageListSchema,
  toEventImageListItem,
  type EventImageListAsset,
  type EventImageListRow,
} from "@/server/images/dto";
import { buildEventImageListFilter } from "@/server/images/filters";
import { createMediaSigner } from "@/server/media/signer";
import { tenantRepo } from "@/server/repos";
import { userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `GET …/events/{eventId}/images` — the organizer's curation grid (OP-127 I1/I5,
 * contract §4.4; ADR-0762 D1/D3/D4).
 *
 * Newest-first by `sequence` (the monotonic key a batch upload cannot tie),
 * narrowed by the five documented filters and continued by the §0.8 compound
 * cursor. Each item carries a §5.6-signed 24 h thumbnail minted per item, the
 * asset's `imageMeta` dimensions so the grid reserves aspect ratio before load,
 * and the durable `processing` state. A soft-deleted image is never listed; a
 * hidden one is, unless the caller filters it out — hide is not delete. The
 * `summary` mixes the event's cached counters with a live tally, marked
 * `approximate` (§4.4).
 */

/** The §4.4 page size when the client omits `limit` (ADR-0762 F6). */
const DEFAULT_LIMIT = 60;

/** The five documented filters, validated at the wire. */
const listQuerySchema = z.object({
  status: z.enum(["queued", "processing", "done", "failed", "skipped"]).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  uploadedBy: z.string().optional(),
  batchId: z.string().optional(),
  sort: z.enum(["sequence_desc", "sequence_asc"]).optional(),
});

/** The `events` fields the summary reads. */
interface EventCountersRow {
  readonly counters?: {
    readonly processedImageCount?: number;
    readonly failedImageCount?: number;
  };
}

/** The `media_assets` fields the grid projection reads. */
interface AssetRow extends EventImageListAsset {
  readonly _id: { toHexString(): string };
}

export const GET = defineRoute({
  route: "/api/v1/tenants/:tenantId/events/:eventId/images",
  response: eventImageListSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage({ admission: eventActorAdmission(2) }),
  handler: async (ctx) => {
    const db = getDb();
    const { tenantId } = ctx;
    if (tenantId === undefined) {
      throw appError("internal_error");
    }
    const eventId = eventIdFromRequest(ctx.request, { segmentFromEnd: 2 });
    const params = new URL(ctx.request.url).searchParams;

    const parsed = listQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      visibility: params.get("visibility") ?? undefined,
      uploadedBy: params.get("uploadedBy") ?? undefined,
      batchId: params.get("batchId") ?? undefined,
      sort: params.get("sort") ?? undefined,
    });
    if (!parsed.success) {
      throw appError("validation_failed", { details: { fields: toFieldErrors(parsed.error) } });
    }

    const pageQuery = parsePageQuery(params, { defaultLimit: DEFAULT_LIMIT });
    const query = buildEventImageListFilter({
      eventId,
      ...parsed.data,
      cursor: pageQuery.cursor,
    });

    const images = tenantRepo(tenantId, db).collection(COLLECTIONS.eventImages);
    const rows = (await images
      .find(query.filter)
      .sort(query.sort)
      .limit(pageQuery.limit + 1)
      .toArray()) as unknown as EventImageListRow[];

    const assets = (await tenantRepo(tenantId, db)
      .collection(COLLECTIONS.mediaAssets)
      .find({ _id: { $in: rows.map((row) => row.assetId) } })
      .toArray()) as unknown as AssetRow[];
    const assetById = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));

    const signer = createMediaSigner({
      currentSecret: getConfig().media.signingSecretCurrent,
    });
    const page = buildCursorPage(rows, pageQuery.limit, (row) => ({
      c: String(row.sequence),
      i: row._id.toHexString(),
    }));
    const data = page.items.map((row) => {
      const asset = assetById.get(row.assetId.toHexString());
      if (asset === undefined) {
        throw appError("internal_error");
      }
      return toEventImageListItem(row, asset, signer);
    });

    const [event, queued, processing] = await Promise.all([
      tenantRepo(tenantId, db)
        .collection(COLLECTIONS.events)
        .findOne({ _id: eventId }) as Promise<EventCountersRow | null>,
      images.countDocuments({ eventId, deletedAt: null, "processing.status": "queued" }),
      images.countDocuments({ eventId, deletedAt: null, "processing.status": "processing" }),
    ]);
    if (event === null) {
      throw appError("internal_error");
    }
    const done = event.counters?.processedImageCount ?? 0;
    const failed = event.counters?.failedImageCount ?? 0;

    return {
      body: {
        data,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: pageQuery.limit },
        summary: {
          // The §4.4 invariant is structural: the four buckets are the total, so
          // counter drift shows as an approximate figure rather than a gap.
          total: done + failed + queued + processing,
          done,
          queued,
          processing,
          failed,
          approximate: true,
        },
      },
    };
  },
});
