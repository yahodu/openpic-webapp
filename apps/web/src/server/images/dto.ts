import { ObjectId } from "mongodb";
import { z } from "zod";

import type { MediaSigner } from "@/server/media/signer";

import type { ProcessingState } from "./reprocess";

/**
 * The §4.4 list item (OP-127 D3): the organizer's grid projection.
 *
 * Distinct from the upload DTO `@/server/uploads/event-image-dto`, which is the
 * **completion** answer (§5.3). This item carries the signed thumbnail, the
 * asset's `imageMeta` dimensions and the durable pipeline state, and names no
 * `assetId`, `objectKey`, `locationKey`, `bucket` or `_id` (§0.15).
 */

/** The §4.4 `processing` subset a client renders (schema §18.2). */
const processingSchema = z.object({
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  lastError: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
});

/** One §4.4 list item. The thumbnail is nullable: a just-uploaded image has none. */
export const eventImageListItemSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  thumbnailUrl: z.string().nullable(),
  thumbnailUrlExpiresAt: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  orientation: z.number(),
  bytes: z.number().int().nonnegative(),
  contentType: z.string(),
  faceCount: z.number().int().nonnegative(),
  visibility: z.string(),
  processing: processingSchema,
  uploadedByUserId: z.string(),
  uploadBatchId: z.string(),
  createdAt: z.string(),
});

/** A validated §4.4 list item. */
export type EventImageListItem = z.infer<typeof eventImageListItemSchema>;

/** The §4.4 page block. */
export const imagePageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});

/** The §4.4 `summary` block. */
export const imageSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  approximate: z.boolean(),
});

/** The §4.4 listing body. */
export const eventImageListSchema = z.object({
  data: z.array(eventImageListItemSchema),
  page: imagePageSchema,
  summary: imageSummarySchema,
});

/** The `event_images` fields the list projection reads (§16.3). */
export interface EventImageListRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly sequence: number;
  readonly uploadedByUserId: ObjectId | string;
  readonly uploadBatchId: unknown;
  readonly faceCount?: number;
  readonly visibility?: string;
  readonly processing?: ProcessingState;
  readonly createdAt: Date;
}

/** The `media_assets` fields the list projection reads (§16.1, §25). */
export interface EventImageListAsset {
  readonly contentHash: string;
  readonly storage: { readonly bytes: number; readonly contentType: string };
  readonly imageMeta?: {
    readonly width?: number;
    readonly height?: number;
    readonly orientation?: number;
  };
  readonly derivatives?: { readonly thumbnail?: { readonly format?: string } };
}

/** The client-visible shape of a stored `processing.lastError` (§18.2). */
function lastErrorOf(error: unknown): { code: string; message: string; retryable: boolean } | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const stored = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof stored.code !== "string" || typeof stored.message !== "string") {
    return null;
  }
  const retryable = (error as { readonly retryable?: unknown }).retryable;
  return { code: stored.code, message: stored.message, retryable: retryable === true };
}

/**
 * Project one stored image onto the §4.4 list item.
 *
 * The thumbnail is a §5.6-signed `t` derivative with a 24 h life, minted per
 * item; an asset without a generated derivative yet answers `null` so the grid
 * reserves its cell instead of calling the data plane for a 404.
 *
 * @param row - The join document.
 * @param asset - The asset the row points at (`bytes`, `contentType`, `imageMeta`,
 *   the thumbnail derivative and the `contentHash` the URL path is built from).
 * @param signer - The §5.6 signer.
 * @returns The §4.4 list item.
 */
export function toEventImageListItem(
  row: EventImageListRow,
  asset: EventImageListAsset,
  signer: MediaSigner
): EventImageListItem {
  const format = asset.derivatives?.thumbnail?.format;
  const thumbnail =
    format === undefined || asset.contentHash === ""
      ? null
      : signer.sign({ kind: "thumbnail", contentHash: asset.contentHash, ext: format });
  const processing = row.processing;

  return {
    id: row._id.toHexString(),
    sequence: row.sequence,
    thumbnailUrl: thumbnail?.url ?? null,
    thumbnailUrlExpiresAt: thumbnail?.expiresAt ?? null,
    width: asset.imageMeta?.width ?? 0,
    height: asset.imageMeta?.height ?? 0,
    orientation: asset.imageMeta?.orientation ?? 0,
    bytes: asset.storage.bytes,
    contentType: asset.storage.contentType,
    faceCount: row.faceCount ?? 0,
    visibility: row.visibility ?? "visible",
    processing: {
      status: processing?.status ?? "queued",
      attempts: processing?.attempts ?? 0,
      finishedAt: processing?.finishedAt?.toISOString() ?? null,
      durationMs: processing?.durationMs ?? null,
      lastError: lastErrorOf(processing?.lastError),
    },
    uploadedByUserId: String(row.uploadedByUserId),
    uploadBatchId: String(row.uploadBatchId),
    createdAt: row.createdAt.toISOString(),
  };
}
