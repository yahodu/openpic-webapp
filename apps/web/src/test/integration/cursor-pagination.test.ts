import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeCursor } from "@/server/http/cursor";
import { paginateByCursor, type CursorPage, type CursorSort } from "@/server/repos/paginate";
import { tenantRepo } from "@/server/repos/tenant";

import { closeMongoClient } from "../../server/db/mongo";
import { MONGO_READY_HOOK_TIMEOUT_MS, createTestDb, setupMongoTestEnv } from "../helpers/db";

beforeAll(async () => {
  await setupMongoTestEnv();
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await closeMongoClient();
});

/**
 * I1 — cursor (keyset) pagination never skips or duplicates a row (API
 * contract §0.8), even when the sort field ties.
 *
 * The pagination key is the compound `(sortValue, _id)`. Production sorts by
 * `createdAt` and many rows share a timestamp (a batch upload), so an
 * `$lt`-only filter or an offset would drop or repeat rows. This drives 95 rows
 * with only 19 distinct `createdAt` values through 3 pages of 40 and asserts the
 * union is exactly the 95 rows in sort order.
 *
 * The collection is reached through `tenantRepo`, so `tenantId` is stamped on
 * every insert and filter — the paginator itself must not weaken that scope.
 */

const TENANT_ID = "tenant-batch";

// `createdAt` is stored as a Date; the cursor carries its ISO string, so the
// caller supplies the codec pair the keyset filter needs.
const SORT: CursorSort = {
  field: "createdAt",
  direction: -1,
  serialize: (value) => (value as Date).toISOString(),
  revive: (raw) => new Date(raw),
};

interface ImageRow {
  readonly _id: string;
  readonly createdAt: Date;
  readonly name: string;
}

/** 95 rows where groups of 5 share one `createdAt` (duplicate sort keys). */
function buildRows(): ImageRow[] {
  const base = Date.UTC(2026, 8, 24, 18, 0, 0);
  return Array.from({ length: 95 }, (_, index) => ({
    _id: (index + 1).toString(16).padStart(24, "0"),
    createdAt: new Date(base - Math.floor(index / 5) * 60_000),
    name: `image-${String(index)}`,
  }));
}

/** The expected order: `createdAt` descending, `_id` descending as the tiebreak. */
function expectedIds(rows: ImageRow[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a._id < b._id ? 1 : a._id > b._id ? -1 : 0)
    )
    .map((row) => row._id);
}

describe("paginateByCursor — 95 rows with duplicate createdAt in pages of 40", () => {
  it("I1: returns exactly 95 unique ids in sort order across three pages", async () => {
    const test = createTestDb("openpic_paginate");
    try {
      const rows = buildRows();
      const images = tenantRepo(TENANT_ID, test.db).collection("images");
      await images.insertMany([...rows]);

      const pageSize = 40;
      const pages: CursorPage<ImageRow>[] = [];
      let cursor: string | null = null;
      while (pages.length < 10) {
        const page: CursorPage<ImageRow> = await paginateByCursor<ImageRow>(images, {
          sort: SORT,
          limit: pageSize,
          cursor,
        });
        pages.push(page);
        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
      }

      expect(pages).toHaveLength(3);

      const lastPage = pages[2];
      if (lastPage === undefined) {
        throw new Error("expected a third page of 15 rows");
      }
      expect(pages.map((page) => page.items.length)).toEqual([40, 40, 15]);
      expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
      expect(lastPage.nextCursor).toBeNull();

      const ids = pages.flatMap((page) => page.items.map((row) => row._id));
      expect(ids).toEqual(expectedIds(rows));
      expect(new Set(ids).size).toBe(95);
    } finally {
      await test.cleanup();
    }
  });

  it("I1: the cursor of the first page points at the last row it returned", async () => {
    const test = createTestDb("openpic_paginate");
    try {
      const rows = buildRows();
      const images = tenantRepo(TENANT_ID, test.db).collection("images");
      await images.insertMany([...rows]);

      const first: CursorPage<ImageRow> = await paginateByCursor<ImageRow>(images, {
        sort: SORT,
        limit: 40,
      });

      const lastReturned = first.items[39];
      if (lastReturned === undefined) {
        throw new Error("expected a full first page of 40 rows");
      }
      const { nextCursor } = first;
      if (nextCursor === null) {
        throw new Error("expected a next cursor on a full first page");
      }
      expect(decodeCursor(nextCursor)).toEqual({
        c: lastReturned.createdAt.toISOString(),
        i: lastReturned._id,
      });
    } finally {
      await test.cleanup();
    }
  });
});
