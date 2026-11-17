import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * The `EventImage` DTO (OP-124, contract §4.4 / §5.3, schema §16.3).
 *
 * One projection for the two places an image reaches a client: the completion
 * answer and the gallery listing. It names no `objectKey`, `locationKey`,
 * `bucket` or `_id` (§0.15) — the stored asset's coordinates stay server-side —
 * and the pipeline state is the durable `processing` object (§18.2), so a
 * client renders "queued" without a second call.
 */

/** The `event_images.processing` fields the DTO exposes (schema §18.2). */
const processingSchema = z.object({
  status: z.string(),
  attempts: z.number().int().nonnegative(),
});

/** One `EventImage` on the wire. */
export const eventImageSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  sequence: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  contentType: z.string(),
  faceCount: z.number().int().nonnegative(),
  visibility: z.string(),
  processing: processingSchema,
  uploadedByUserId: z.string(),
  uploadBatchId: z.string(),
  createdAt: z.string(),
});

/** A validated `EventImage`. */
export type EventImageDto = z.infer<typeof eventImageSchema>;

/** The `event_images` fields {@link toEventImage} projects. */
export interface EventImageRow {
  readonly _id: ObjectId;
  readonly assetId: ObjectId;
  readonly uploadedByUserId: ObjectId | string;
  readonly uploadBatchId: unknown;
  readonly sequence: number;
  readonly faceCount?: number;
  readonly visibility?: string;
  readonly processing?: { readonly status?: string; readonly attempts?: number };
  readonly createdAt: Date;
}

/** The `media_assets.storage` fields {@link toEventImage} projects. */
export interface EventImageAsset {
  readonly bytes: number;
  readonly contentType: string;
}

/**
 * Project one stored `event_images` row onto the wire.
 *
 * @param row - The join document.
 * @param asset - The asset's `storage` block (its size and content type).
 * @returns The `EventImage` DTO.
 */
export function toEventImage(row: EventImageRow, asset: EventImageAsset): EventImageDto {
  return {
    id: row._id.toHexString(),
    assetId: row.assetId.toHexString(),
    sequence: row.sequence,
    bytes: asset.bytes,
    contentType: asset.contentType,
    faceCount: row.faceCount ?? 0,
    visibility: row.visibility ?? "visible",
    processing: {
      status: row.processing?.status ?? "queued",
      attempts: row.processing?.attempts ?? 0,
    },
    uploadedByUserId: String(row.uploadedByUserId),
    uploadBatchId: String(row.uploadBatchId),
    createdAt: row.createdAt.toISOString(),
  };
}
