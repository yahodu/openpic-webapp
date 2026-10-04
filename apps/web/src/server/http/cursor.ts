import { z } from "zod";

import { appError } from "./errors";

/**
 * Cursor codec, `?cursor=&limit=` parser and page envelope builder (API
 * contract §0.8).
 *
 * The pagination key is a compound `(sortValue, id)` — `c`/`i` on the wire —
 * so a sort field that ties (a batch upload shares one `createdAt`) never
 * skips or duplicates a row. The cursor is `base64url(JSON.stringify({ c, i }))`
 * and is opaque: clients must neither construct nor parse it.
 */

/** The compound pagination key carried by a cursor. */
export interface Cursor {
  /** The serialized sort-field value of the last returned row. */
  readonly c: string;
  /** The `_id` tiebreaker of the last returned row. */
  readonly i: string;
}

/** The per-endpoint `limit` bounds and defaults. */
export interface PageQueryOptions {
  /** The `limit` used when the client omits one. Defaults to `40`. */
  readonly defaultLimit?: number;
  /** The ceiling a larger `limit` is clamped to. Defaults to `100`. */
  readonly maxLimit?: number;
}

/** The parsed `?limit=` and `?cursor=` query. */
export interface PageQuery {
  /** The effective limit, always within `1..maxLimit`. */
  readonly limit: number;
  /** The decoded cursor, or `null` for the first page. */
  readonly cursor: Cursor | null;
}

/** A page of rows plus the cursor that follows it. */
export interface CursorPage<T> {
  /** The rows returned, at most `limit`. */
  readonly items: T[];
  /** Whether more rows exist after this page. */
  readonly hasMore: boolean;
  /** The cursor for the next page, or `null` on a terminal page. */
  readonly nextCursor: string | null;
}

/** The documented default page size (contract §0.8). */
export const DEFAULT_PAGE_LIMIT = 40;

/** The documented maximum page size (contract §0.8). */
export const MAX_PAGE_LIMIT = 100;

/**
 * The strict wire shape. `.strict()` (rather than the default strip) is what
 * rejects a "foreign" cursor: any extra key, a non-string `c`/`i`, an array or
 * an empty value fails the parse and becomes a `400 invalid_cursor`.
 */
const cursorSchema = z
  .object({
    c: z.string().min(1),
    i: z.string().min(1),
  })
  .strict();

/**
 * Encode a compound cursor to its opaque, URL-safe wire form.
 *
 * @param cursor - The `(sortValue, id)` key of the last returned row.
 * @returns `base64url(JSON.stringify({ c, i }))` with no padding.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.c, i: cursor.i })).toString("base64url");
}

/**
 * Decode an opaque wire cursor back to its compound key.
 *
 * @param raw - The client-supplied cursor string.
 * @returns The decoded `{ c, i }`.
 * @throws {AppError} `invalid_cursor` (400) when `raw` is not a valid cursor.
 */
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw appError("invalid_cursor");
  }

  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw appError("invalid_cursor");
  }
  return result.data;
}

/** True when `value` is a plain non-negative integer in its decimal form. */
function isDecimalInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Parse and bound the `?limit=` and `?cursor=` query parameters.
 *
 * `limit` is an integer in `1..maxLimit`; a value above the ceiling is clamped
 * down to it, while a non-integer, a non-positive value or trailing text is a
 * `422 validation_failed`. An absent cursor yields `null` (the first page).
 *
 * @param params - The request's search params.
 * @param options - Per-endpoint default and ceiling (`40` / `100`).
 * @returns The bounded limit and the decoded cursor.
 * @throws {AppError} `validation_failed` (422) or `invalid_cursor` (400).
 */
export function parsePageQuery(params: URLSearchParams, options: PageQueryOptions = {}): PageQuery {
  const defaultLimit = options.defaultLimit ?? DEFAULT_PAGE_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_PAGE_LIMIT;

  const rawLimit = params.get("limit");
  let limit = defaultLimit;
  if (rawLimit !== null) {
    if (!isDecimalInteger(rawLimit) || Number(rawLimit) < 1) {
      throw appError("validation_failed", { details: { fields: [] } });
    }
    limit = Math.min(Number(rawLimit), maxLimit);
  }

  const rawCursor = params.get("cursor");
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);

  return { limit, cursor };
}

/**
 * Split a `limit + 1` over-fetch into a page and the cursor that follows it.
 *
 * The caller fetches one row beyond `limit`; its presence is the only signal
 * that more rows exist, so an exactly-full page is terminal and never hands the
 * client an unfollowable cursor.
 *
 * @param rows - The fetched rows (`limit + 1` at most is meaningful).
 * @param limit - The page size.
 * @param keyOf - Extract the compound key from a row.
 * @returns The page envelope.
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => Cursor
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).slice();
  const lastRow = items[items.length - 1];
  const nextCursor = hasMore && lastRow !== undefined ? encodeCursor(keyOf(lastRow)) : null;

  return { items, hasMore, nextCursor };
}
