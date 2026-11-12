import { ObjectId } from "mongodb";

import type { Cursor } from "@/server/http/cursor";
import { appError } from "@/server/http/errors";

/**
 * The organizer's image-grid query (OP-127 U1, contract §4.4 and §0.8,
 * schema §16.3).
 *
 * The listing route sends exactly the clause this builder returns, so the
 * index-shaped ordering ({eventId: 1, sequence: -1}), the five documented
 * filters and the compound cursor are reviewable in one pure function.
 */

/** The `processing.status` values §4.4 lets a caller filter on. */
export type EventImageListStatus = "queued" | "processing" | "done" | "failed" | "skipped";

/** The organizer's visibility filter. Hide is not delete, so both are listed. */
export type EventImageListVisibility = "visible" | "hidden";

/** The ordering the grid may ask for. */
export type EventImageListSort = "sequence_desc" | "sequence_asc";

/** The validated `?status=&visibility=&uploadedBy=&batchId=&sort=&cursor=` query. */
export interface EventImageListParams {
  readonly eventId: ObjectId;
  readonly status?: EventImageListStatus | undefined;
  readonly visibility?: EventImageListVisibility | undefined;
  /** The caller's 24-hex user id. */
  readonly uploadedBy?: string | undefined;
  /** A 24-hex id or the UUIDv4 a client-generated batch carries (§5.2). */
  readonly batchId?: string | undefined;
  readonly sort?: EventImageListSort | undefined;
  readonly cursor?: Cursor | null | undefined;
}

/** The `find` clause and `sort` the listing route sends. */
export interface EventImageListQuery {
  readonly filter: Record<string, unknown>;
  readonly sort: Readonly<Record<string, 1 | -1>>;
}

/** A 24-hex `ObjectId`, the only shape a stored id has. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** A sequence number as the cursor carries it. */
const DECIMAL_INTEGER = /^\d+$/;

/**
 * Build the listing query.
 *
 * A soft-deleted image is never listed (`deletedAt: null` also matches the rows
 * OP-124 writes without the field). A `batchId` is matched in both stored shapes
 * — the `ObjectId` of §16.3 and the verbatim string a UUIDv4 leaves behind
 * (ADR-0721 A3). A cursor whose `c` is not a sequence number is a foreign
 * cursor: `400 invalid_cursor`, never a silent full scan (§0.8).
 *
 * @param params - The validated listing query.
 * @returns The `find` clause and the ordering.
 * @throws {AppError} `invalid_cursor` (400) for a cursor this event cannot
 *   continue, `validation_failed` (422) for an `uploadedBy` that is not an id.
 */
export function buildEventImageListFilter(params: EventImageListParams): EventImageListQuery {
  const filter: Record<string, unknown> = { eventId: params.eventId, deletedAt: null };

  if (params.status !== undefined) {
    filter["processing.status"] = params.status;
  }
  if (params.visibility !== undefined) {
    filter.visibility = params.visibility;
  }
  if (params.uploadedBy !== undefined) {
    // Validated before the cast: `new ObjectId(garbage)` is a driver error, i.e.
    // a 500 on client-controlled input (ADR-0762 F7).
    if (!OBJECT_ID_HEX.test(params.uploadedBy)) {
      throw appError("validation_failed", {
        details: {
          fields: [{ path: "uploadedBy", code: "invalid_id", message: "must be a 24-hex id" }],
        },
      });
    }
    filter.uploadedByUserId = new ObjectId(params.uploadedBy);
  }
  if (params.batchId !== undefined) {
    filter.uploadBatchId = {
      $in: OBJECT_ID_HEX.test(params.batchId)
        ? [new ObjectId(params.batchId), params.batchId]
        : [params.batchId],
    };
  }

  const direction = params.sort === "sequence_asc" ? 1 : -1;
  const cursor = params.cursor ?? null;

  if (cursor !== null) {
    if (!DECIMAL_INTEGER.test(cursor.c) || !OBJECT_ID_HEX.test(cursor.i)) {
      throw appError("invalid_cursor");
    }
    const sequence = Number(cursor.c);
    const id = new ObjectId(cursor.i);
    const comparison = direction === 1 ? "$gt" : "$lt";
    filter.$or = [
      { sequence: { [comparison]: sequence } },
      { sequence, _id: { [comparison]: id } },
    ];
  }

  return { filter, sort: { sequence: direction, _id: direction } };
}
