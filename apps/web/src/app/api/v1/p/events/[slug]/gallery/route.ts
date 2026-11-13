import type { ObjectId } from "mongodb";
import { z } from "zod";

import {
  GALLERY_DEFAULT_LIMIT,
  GALLERY_MAX_LIMIT,
  afterCursor,
  afterWatermark,
  decodePageCursor,
  decodeWatermark,
  encodePageCursor,
  galleryItem,
  newestFirst,
  type GalleryItem,
} from "@/server/attendee/gallery-projection";
import { attendeeMediaSigner } from "@/server/attendee/attendee-media";
import { eventIndexingComplete } from "@/server/attendee/poll-policy";
import { requireAttendeeProfile } from "@/server/attendee/request-event";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo, tenantRepo, type TenantRepository } from "@/server/repos";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `GET /api/v1/p/events/{slug}/gallery` — the attendee's own photos (OP-133,
 * contract §6.5, schema §15.3/§16.1/§16.3/§17.5; ADR-0794 §5–§8).
 *
 * The only screen that shows an attendee their own photos, so every rule is a
 * rule about somebody's data:
 *
 *   - newest first by the image's upload `sequence` — the match's own timestamp
 *     stamps every row of a first match run within milliseconds (§16.3);
 *   - nothing they hid (`faceMatches.hiddenAt`, counted) and nothing the
 *     organizer hid (`event_images.visibility`, not counted — I1b);
 *   - `confidence` only: the raw `similarity` is never read (§6.5);
 *   - an anonymous caller stops at the platform's preview allowance and is told
 *     to sign in; a signed-in caller pages the whole gallery.
 */

/** One §6.5 gallery item — exactly twelve keys. */
const itemSchema = z.object({
  matchId: z.string(),
  imageId: z.string(),
  thumbnailUrl: z.string(),
  thumbnailUrlExpiresAt: z.string(),
  width: z.number(),
  height: z.number(),
  orientation: z.number(),
  aspectRatio: z.number(),
  isNew: z.boolean(),
  confidence: z.string(),
  originalAvailable: z.boolean(),
  createdAt: z.iso.datetime(),
});

/** The §6.5 body. The two anonymous keys appear only when truncation happened. */
const gallerySchema = z.object({
  data: z.array(itemSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }),
  summary: z.object({
    matchCount: z.number().int().nonnegative(),
    newMatchCount: z.number().int().nonnegative(),
    hiddenCount: z.number().int().nonnegative(),
    galleryExpiresAt: z.iso.datetime().nullable(),
    indexingComplete: z.boolean(),
  }),
  truncatedForAnonymous: z.boolean().optional(),
  loginUrl: z.string().optional(),
});

/** The `face_matches` fields the listing reads (§17.5). */
interface MatchRow {
  readonly _id: ObjectId;
  readonly imageId: ObjectId;
  readonly confidence: string;
  readonly createdAt: Date;
  readonly seenAt: Date | null;
  readonly hiddenAt: Date | null;
}

/** The `event_images` fields the listing reads (§16.3). */
interface ImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly sequence: number;
}

/** The `media_assets` fields a tile is drawn and signed from (§16.1). */
interface AssetRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly status: string;
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } } | null;
  readonly imageMeta?: {
    readonly width?: number;
    readonly height?: number;
    readonly orientation?: number | null;
  } | null;
}

/** The `events` fields the summary reads (§15.1). */
interface EventRow {
  readonly counters: { readonly imageCount: number; readonly processedImageCount: number };
  readonly retentionExpiresAt?: Date | null;
}

/** One visible row, before it is projected onto the wire. */
interface GalleryRow {
  readonly sequence: number;
  readonly matchId: string;
  readonly imageId: string;
  readonly createdAt: Date;
  readonly seenAt: Date | null;
  readonly confidence: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: number | null;
  readonly thumbnail: { readonly url: string; readonly expiresAt: string };
  readonly originalAvailable: boolean;
}

/** Where the anonymous truncation sends a caller who wants the rest (§6.5). */
const LOGIN_URL = "/login";

/**
 * Parse the §6.5 `limit` query value.
 *
 * @param raw - The `?limit=` value, when the request carried one.
 * @returns The requested page size, `40` by default and at most `100`.
 * @throws {AppError} `validation_failed` for a value that is not a page size.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) {
    return GALLERY_DEFAULT_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw appError("validation_failed", {
      details: { fields: [{ path: "limit", code: "invalid_value", message: "must be 1..100" }] },
    });
  }
  return Math.min(parsed, GALLERY_MAX_LIMIT);
}

/** The `events` row the summary needs. */
async function readEventRow(
  db: Parameters<typeof platformRepo>[0],
  eventId: ObjectId
): Promise<EventRow | null> {
  return (await platformRepo(db)
    .collection(COLLECTIONS.events)
    .findOne(
      { _id: eventId },
      { projection: { counters: 1, retentionExpiresAt: 1 } }
    )) as EventRow | null;
}

/**
 * Every visible row of one profile, newest first, plus the attendee's own hide
 * count.
 *
 * The sequence lives on `event_images`, not on `face_matches`, so the order is
 * applied after the two batched reads. One attendee's match set is bounded by
 * `settings.face.matchLimit`, so this never materialises anything large.
 *
 * @param tenant - The event's tenant repository.
 * @param eventId - The addressed event.
 * @param profileId - The caller's profile.
 * @param signer - The media signer the thumbnail URLs are minted with.
 * @returns The visible rows (unordered) and how many matches the attendee hid.
 */
async function readRows(
  tenant: TenantRepository,
  eventId: ObjectId,
  profileId: ObjectId,
  signer: ReturnType<typeof attendeeMediaSigner>
): Promise<{ readonly rows: GalleryRow[]; readonly hiddenCount: number }> {
  const matches = (await tenant
    .collection(COLLECTIONS.faceMatches)
    .find(
      { profileId },
      { projection: { _id: 1, imageId: 1, confidence: 1, createdAt: 1, seenAt: 1, hiddenAt: 1 } }
    )
    .toArray()) as unknown as MatchRow[];

  const visibleMatches = matches.filter((match) => match.hiddenAt === null);
  const images = (await tenant
    .collection(COLLECTIONS.eventImages)
    .find(
      {
        _id: { $in: visibleMatches.map((match) => match.imageId) },
        eventId,
        visibility: "visible",
        deletedAt: null,
      },
      { projection: { _id: 1, assetId: 1, sequence: 1 } }
    )
    .toArray()) as unknown as ImageRow[];
  const imageById = new Map(images.map((image) => [image._id.toHexString(), image]));

  const assets = (await tenant
    .collection(COLLECTIONS.mediaAssets)
    .find(
      { _id: { $in: images.map((image) => image.assetId) } },
      { projection: { _id: 1, contentHash: 1, status: 1, derivatives: 1, imageMeta: 1 } }
    )
    .toArray()) as unknown as AssetRow[];
  const assetById = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));

  const rows: GalleryRow[] = [];
  for (const match of visibleMatches) {
    const image = imageById.get(match.imageId.toHexString());
    if (image === undefined) {
      // The organizer hid or deleted it: excluded, and not the attendee's hide.
      continue;
    }
    const asset = assetById.get(image.assetId.toHexString());
    if (asset === undefined) {
      continue;
    }
    const signed = signer.sign({
      kind: "thumbnail",
      contentHash: asset.contentHash,
      ext: asset.derivatives?.thumbnail?.format ?? "webp",
    });
    rows.push({
      sequence: image.sequence,
      matchId: match._id.toHexString(),
      imageId: image._id.toHexString(),
      createdAt: match.createdAt,
      seenAt: match.seenAt,
      confidence: match.confidence,
      width: asset.imageMeta?.width ?? 0,
      height: asset.imageMeta?.height ?? 0,
      orientation: asset.imageMeta?.orientation ?? null,
      thumbnail: { url: signed.url, expiresAt: signed.expiresAt },
      originalAvailable: asset.status === "derivatives_ready",
    });
  }

  return { rows, hiddenCount: matches.length - visibleMatches.length };
}

export const GET = defineRoute({
  route: "/api/v1/p/events/:slug/gallery",
  response: gallerySchema,
  rateLimit: rateLimitStage({
    classKey: "read.hot",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const rawCursor = url.searchParams.get("cursor");
    const rawNewerThan = url.searchParams.get("newerThan");
    const cursor = rawCursor === null ? null : decodePageCursor(rawCursor);
    const watermark = rawNewerThan === null ? null : decodeWatermark(rawNewerThan);
    // §6.5 query validation: a cursor this server did not mint is refused, so a
    // malformed page position can never silently serve page one again.
    if ((rawCursor !== null && cursor === null) || (rawNewerThan !== null && watermark === null)) {
      throw appError("validation_failed", {
        details: {
          fields: [
            {
              path: cursor === null ? "cursor" : "newerThan",
              code: "invalid_format",
              message: "must be a cursor this server minted",
            },
          ],
        },
      });
    }

    const scope = await requireAttendeeProfile(ctx);
    const { db, event, profile } = scope;
    const tenant = tenantRepo(event.tenantKey, db);
    const signer = attendeeMediaSigner();

    const [eventRow, settings, listing] = await Promise.all([
      readEventRow(db, event.eventId),
      getPlatformSettings({ db }),
      readRows(tenant, event.eventId, profile._id, signer),
    ]);

    // The window: everything created after the watermark the poll handed out.
    const window =
      watermark === null
        ? listing.rows
        : listing.rows.filter((row) => afterWatermark(row, watermark));
    const ordered = [...window].sort(newestFirst);
    const remaining = cursor === null ? ordered : ordered.filter((row) => afterCursor(row, cursor));

    const anonymous = scope.subject.kind === "anonymous";
    const allowance = settings.attendee.anonymousPreviewLimit;
    const effectiveLimit = anonymous ? Math.min(limit, allowance) : limit;
    // The allowance is a total, not a page size: it stops the response only when
    // the gallery holds more photos than an anonymous caller may see at all.
    const truncated = anonymous && ordered.length > allowance;
    const pageRows = remaining.slice(0, effectiveLimit);
    const last = pageRows.at(-1);
    const hasMore = !truncated && remaining.length > pageRows.length;

    const data: GalleryItem[] = pageRows.map((row) =>
      galleryItem({
        match: {
          matchId: row.matchId,
          createdAt: row.createdAt,
          seenAt: row.seenAt,
          confidence: row.confidence,
        },
        image: {
          imageId: row.imageId,
          sequence: row.sequence,
          width: row.width,
          height: row.height,
          orientation: row.orientation,
        },
        thumbnail: row.thumbnail,
        originalAvailable: row.originalAvailable,
      })
    );

    return {
      body: {
        data,
        page: {
          nextCursor:
            hasMore && last !== undefined
              ? encodePageCursor({ sequence: last.sequence, matchId: last.matchId })
              : null,
          hasMore,
          limit: effectiveLimit,
          total: profile.matchCount,
        },
        summary: {
          matchCount: profile.matchCount,
          // Counted over the window, so `?newerThan=` answers "how many of the
          // new ones are still new" (I13).
          newMatchCount: window.filter((row) => row.seenAt === null).length,
          hiddenCount: listing.hiddenCount,
          galleryExpiresAt:
            eventRow?.retentionExpiresAt === undefined || eventRow.retentionExpiresAt === null
              ? null
              : eventRow.retentionExpiresAt.toISOString(),
          indexingComplete: eventIndexingComplete(
            eventRow?.counters ?? { imageCount: 0, processedImageCount: 0 }
          ),
        },
        ...(truncated ? { truncatedForAnonymous: true, loginUrl: LOGIN_URL } : {}),
      },
    };
  },
});
