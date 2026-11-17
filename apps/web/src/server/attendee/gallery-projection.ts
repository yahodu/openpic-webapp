import { displayGeometry } from "./image-geometry";

/**
 * The gallery's projection, ordering and cursors (OP-133; contract §6.5;
 * schema §16.3/§17.5; ADR-0794 §5, §7).
 *
 * The gallery is a read over the event's own library, not over the match rows'
 * timestamps: a first match run stamps every row within milliseconds of its
 * neighbours, so the stable "newest first" order is `event_images.sequence`
 * descending (§16.3). Everything here is pure — the route does the I/O.
 */

/** §6.5's default page size. */
export const GALLERY_DEFAULT_LIMIT = 40;

/** §6.5's maximum page size. */
export const GALLERY_MAX_LIMIT = 100;

/** One visible match, reduced to what the projection reads (§17.5). */
export interface GalleryMatch {
  readonly matchId: string;
  readonly createdAt: Date;
  readonly seenAt: Date | null;
  readonly confidence: string;
}

/** The image a match points at, reduced to what the projection reads (§16.3). */
export interface GalleryImage {
  readonly imageId: string;
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly orientation: number | null;
}

/** The signed thumbnail an item carries (§5.6). */
export interface SignedThumbnail {
  readonly url: string;
  readonly expiresAt: string;
}

/** One §6.5 gallery item — exactly twelve keys. */
export interface GalleryItem {
  readonly matchId: string;
  readonly imageId: string;
  readonly thumbnailUrl: string;
  readonly thumbnailUrlExpiresAt: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
  readonly aspectRatio: number;
  readonly isNew: boolean;
  readonly confidence: string;
  readonly originalAvailable: boolean;
  readonly createdAt: string;
}

/**
 * Project one match onto a §6.5 item.
 *
 * The geometry is the **displayed** one (EXIF transposed) and `similarity` is
 * never read at all: only the coarse `confidence` leaves the server (§6.5).
 *
 * @param input - The match, its image, the signed thumbnail and the media fact.
 * @returns The item, with exactly the twelve documented keys.
 */
export function galleryItem(input: {
  readonly match: GalleryMatch;
  readonly image: GalleryImage;
  readonly thumbnail: SignedThumbnail;
  readonly originalAvailable: boolean;
}): GalleryItem {
  const geometry = displayGeometry({
    width: input.image.width,
    height: input.image.height,
    orientation: input.image.orientation,
  });
  return {
    matchId: input.match.matchId,
    imageId: input.image.imageId,
    thumbnailUrl: input.thumbnail.url,
    thumbnailUrlExpiresAt: input.thumbnail.expiresAt,
    width: geometry.width,
    height: geometry.height,
    // The stored EXIF value is what the client applies to the image itself.
    orientation: input.image.orientation ?? 1,
    aspectRatio: geometry.aspectRatio,
    // A read never clears the badge: only `POST …/gallery:seen` stamps seenAt.
    isNew: input.match.seenAt === null,
    confidence: input.match.confidence,
    originalAvailable: input.originalAvailable,
    createdAt: input.match.createdAt.toISOString(),
  };
}

/** One row's place in the newest-first order. */
export interface OrderedRow {
  readonly sequence: number;
  readonly matchId: string;
}

/** A page's position: the last item the previous page served. */
export type PageCursor = OrderedRow;

/** A watermark: the newest match a client already knows about. */
export interface MatchWatermark {
  readonly createdAt: Date;
  readonly matchId: string;
}

/**
 * Order two rows newest first, with the match id as a stable tiebreak.
 *
 * @param left - One row.
 * @param right - The other row.
 * @returns The comparator result for `Array.prototype.sort`.
 */
export function newestFirst(left: OrderedRow, right: OrderedRow): number {
  return right.sequence - left.sequence || left.matchId.localeCompare(right.matchId);
}

/**
 * Whether a row sorts strictly after `cursor` (so a later page serves it).
 *
 * @param row - The candidate row.
 * @param cursor - The last row the previous page served.
 * @returns `true` when the row belongs to a later page.
 */
export function afterCursor(row: OrderedRow, cursor: PageCursor): boolean {
  return newestFirst(row, cursor) > 0;
}

/**
 * Whether a match was created after the watermark the poll handed out.
 *
 * @param row - The candidate match.
 * @param watermark - The newest match the client already has.
 * @returns `true` when the match is newer than the watermark.
 */
export function afterWatermark(
  row: { readonly createdAt: Date; readonly matchId: string },
  watermark: MatchWatermark
): boolean {
  const delta = row.createdAt.getTime() - watermark.createdAt.getTime();
  return delta > 0 || (delta === 0 && row.matchId.localeCompare(watermark.matchId) > 0);
}

/** The wire shape of a page cursor. */
interface CursorPayload {
  readonly k: "page" | "watermark";
  readonly n?: number;
  readonly t?: number;
  readonly m: string;
}

/** A 24-hex ObjectId, as every id on the wire is spelled. */
const HEX_ID = /^[0-9a-f]{24}$/;

/**
 * Encode one payload into the opaque cursor the client round-trips.
 *
 * The cursor is unsigned and self-describing: it only ever addresses the
 * caller's own gallery or their own watermark, so a forged one can skip items
 * in the caller's own list and nothing else.
 *
 * @param payload - The page or watermark payload.
 * @returns The base64url cursor.
 */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode one cursor, refusing anything this server did not mint.
 *
 * @param raw - The `?cursor=` / `?newerThan=` value.
 * @returns The payload, or `null` when the value is not a cursor of this shape.
 */
function decodeCursor(raw: string): CursorPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const { k, n, t, m } = parsed as Record<string, unknown>;
  if ((k !== "page" && k !== "watermark") || typeof m !== "string" || !HEX_ID.test(m)) {
    return null;
  }
  if (k === "page") {
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? { k, n, m } : null;
  }
  return typeof t === "number" && Number.isFinite(t) ? { k, t, m } : null;
}

/**
 * Encode the position a page ended at.
 *
 * @param cursor - The last row the page served.
 * @returns The opaque cursor.
 */
export function encodePageCursor(cursor: PageCursor): string {
  return encodeCursor({ k: "page", n: cursor.sequence, m: cursor.matchId });
}

/**
 * Encode the newest match a client already has.
 *
 * @param watermark - The newest match's creation instant and id.
 * @returns The opaque cursor.
 */
export function encodeWatermark(watermark: MatchWatermark): string {
  return encodeCursor({ k: "watermark", t: watermark.createdAt.getTime(), m: watermark.matchId });
}

/**
 * Decode a `?cursor=` value.
 *
 * @param raw - The query value.
 * @returns The page position, or `null` when it is not one.
 */
export function decodePageCursor(raw: string): PageCursor | null {
  const payload = decodeCursor(raw);
  return payload !== null && payload.k === "page" && payload.n !== undefined
    ? { sequence: payload.n, matchId: payload.m }
    : null;
}

/**
 * Decode a `?newerThan=` value.
 *
 * @param raw - The query value.
 * @returns The watermark, or `null` when it is not one.
 */
export function decodeWatermark(raw: string): MatchWatermark | null {
  const payload = decodeCursor(raw);
  return payload !== null && payload.k === "watermark" && payload.t !== undefined
    ? { createdAt: new Date(payload.t), matchId: payload.m }
    : null;
}
