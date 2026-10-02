import { describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptedSchema, collectionSchema, pageSchema } from "@openpic/contracts";

/**
 * U3 — the collection envelope.
 *
 * A cursor collection must never lie about whether more pages exist: a client
 * that sees `hasMore: true` follows `nextCursor`, so a non-terminal page with a
 * null cursor strands the client, and a terminal page that still offers a cursor
 * makes it fetch a page that cannot exist. The refinement is what ties the two
 * fields together.
 */

const itemSchema = z.object({ id: z.string() });

describe("collectionSchema", () => {
  it("U3: accepts a terminal page with hasMore false and a null nextCursor", () => {
    const result = collectionSchema(itemSchema).safeParse({
      items: [{ id: "a" }],
      hasMore: false,
      nextCursor: null,
    });

    expect(result.success).toBe(true);
  });

  it("U3: accepts a non-terminal page with hasMore true and a cursor", () => {
    const result = collectionSchema(itemSchema).safeParse({
      items: [{ id: "a" }],
      hasMore: true,
      nextCursor: "c2Vjb25kIHBhZ2U=",
    });

    expect(result.success).toBe(true);
  });

  it("U3: rejects hasMore true when nextCursor is null (refinement)", () => {
    const result = collectionSchema(itemSchema).safeParse({
      items: [],
      hasMore: true,
      nextCursor: null,
    });

    expect(result.success).toBe(false);
  });

  it("U3: rejects a terminal page that still offers a nextCursor (refinement)", () => {
    const result = collectionSchema(itemSchema).safeParse({
      items: [],
      hasMore: false,
      nextCursor: "c2Vjb25kIHBhZ2U=",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a collection whose items do not match the item schema", () => {
    const result = collectionSchema(itemSchema).safeParse({
      items: [{ id: 123 }],
      hasMore: false,
      nextCursor: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a collection that is missing nextCursor", () => {
    const result = collectionSchema(itemSchema).safeParse({ items: [], hasMore: false });

    expect(result.success).toBe(false);
  });
});

/**
 * Offset pagination envelope (`Page`).
 *
 * `total` counts all matching rows, `page` is 1-based and `pageSize` bounds the
 * rows returned, so none of them can be negative or zero.
 */
describe("pageSchema", () => {
  it("accepts a well-formed page", () => {
    const result = pageSchema(itemSchema).safeParse({
      items: [{ id: "a" }],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result.success).toBe(true);
  });

  it.each([
    { items: [], total: -1, page: 1, pageSize: 20 },
    { items: [], total: 0, page: 0, pageSize: 20 },
    { items: [], total: 0, page: 1, pageSize: 0 },
  ])("rejects an out-of-range page envelope %o", (value) => {
    expect(pageSchema(itemSchema).safeParse(value).success).toBe(false);
  });
});

/**
 * A `202 Accepted` envelope for asynchronous work: the client is handed the id
 * of the job it can poll, never the job's internal record.
 */
describe("acceptedSchema", () => {
  it("accepts an acceptance carrying a 24-hex job id", () => {
    expect(acceptedSchema.safeParse({ jobId: "507f1f77bcf86cd799439011" }).success).toBe(true);
  });

  it("rejects an acceptance whose job id is not a 24-hex id", () => {
    expect(acceptedSchema.safeParse({ jobId: "not-an-id" }).success).toBe(false);
  });

  it("rejects an acceptance that is missing the job id", () => {
    expect(acceptedSchema.safeParse({}).success).toBe(false);
  });
});
