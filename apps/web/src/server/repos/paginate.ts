import type { Document } from "mongodb";

import { buildCursorPage, decodeCursor, type Cursor, type CursorPage } from "@/server/http/cursor";
import { type RepositoryCollection } from "./collection";

export type { CursorPage } from "@/server/http/cursor";

/**
 * Keyset (cursor) pagination over a tenant-scoped collection (API contract
 * §0.8).
 *
 * The pagination key is the compound `(sortValue, _id)`, so rows that share a
 * sort value — many images in one upload batch share a `createdAt` — are never
 * skipped or duplicated. The Mongo filter it builds carries the tenant scope
 * already, because the collection handle stamps `tenantId` into every filter.
 */

/** A `1 | -1` sort direction. */
export type CursorDirection = 1 | -1;

/**
 * The sort the paginator keys on, plus the codec that maps its native value to
 * and from the string carried in the cursor (`Date` ⇄ ISO string).
 */
export interface CursorSort {
  /** The document field to sort (and paginate) by. */
  readonly field: string;
  /** The sort direction: `-1` descending, `1` ascending. */
  readonly direction: CursorDirection;
  /** Serialize a native sort value to the string stored in the cursor. */
  readonly serialize: (value: unknown) => string;
  /** Revive a cursor's string back to the native sort value for the query. */
  readonly revive: (raw: string) => unknown;
}

/** The arguments to {@link paginateByCursor}. */
export interface PaginateOptions {
  /** The sort key and its codec. */
  readonly sort: CursorSort;
  /** The page size (the caller bounds it before calling). */
  readonly limit: number;
  /** The cursor from the previous page, or `null`/absent for the first page. */
  readonly cursor?: string | null;
}

/**
 * Build the compound keyset filter for a cursor.
 *
 * For a descending sort it is `{$or: [{field: {$lt: value}}, {field: value,
 * _id: {$lt: id}}]}` — the strict `$or` is what keeps a tie from skipping the
 * remainder of its group. An absent cursor yields the empty filter (first page).
 *
 * @param sort - The sort key and codec.
 * @param cursor - The decoded cursor, or `null` for the first page.
 * @returns The Mongo filter, before the repository stamps the tenant scope.
 */
export function cursorFilter(sort: CursorSort, cursor: Cursor | null): Document {
  if (cursor === null) {
    return {};
  }
  const value = sort.revive(cursor.c);
  const rangeOp = sort.direction === -1 ? "$lt" : "$gt";
  return {
    $or: [
      { [sort.field]: { [rangeOp]: value } },
      { [sort.field]: value, _id: { [rangeOp]: cursor.i } },
    ],
  };
}

/**
 * Fetch one cursor page from a (tenant-scoped) collection.
 *
 * Fetches `limit + 1` rows sorted by `(field, _id)` and splits them with
 * {@link buildCursorPage}, so `hasMore`/`nextCursor` are derived from the same
 * over-fetch the page builder sees.
 *
 * @param collection - The repository collection handle (already tenant-scoped).
 * @param options - The sort, page size and previous cursor.
 * @returns The page envelope.
 * @throws {AppError} `invalid_cursor` (400) when the cursor is malformed.
 */
export async function paginateByCursor<T>(
  collection: RepositoryCollection,
  options: PaginateOptions
): Promise<CursorPage<T>> {
  const { sort, limit } = options;
  const cursor = options.cursor == null ? null : decodeCursor(options.cursor);

  const rows = (await collection
    .find(cursorFilter(sort, cursor))
    .sort({ [sort.field]: sort.direction, _id: sort.direction })
    .limit(limit + 1)
    .toArray()) as unknown as T[];

  return buildCursorPage(rows, limit, (row) => {
    const doc = row as Record<string, unknown>;
    return { c: sort.serialize(doc[sort.field]), i: String(doc._id) };
  });
}
