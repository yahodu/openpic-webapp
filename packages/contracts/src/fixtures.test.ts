import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acceptedSchema,
  apiErrorSchema,
  buildAccepted,
  buildApiError,
  buildCollection,
  buildPage,
  collectionSchema,
  pageSchema,
} from "@openpic/contracts";

/**
 * U4 — fixture builders are the only way test data is created.
 *
 * Following CONVENTIONS §3, a builder returns `schema.parse({ ...defaults,
 * ...overrides })`, so a fixture can never drift from its schema and an invalid
 * override is rejected at build time instead of leaking into a test as a
 * "passing" assertion against data no client would ever accept.
 */

const itemSchema = z.object({ id: z.string() });

describe("fixture builders", () => {
  it("buildApiError returns an envelope that satisfies the error schema", () => {
    expect(apiErrorSchema.safeParse(buildApiError()).success).toBe(true);
  });

  it("buildApiError honours a valid override", () => {
    expect(buildApiError({ error: { code: "forbidden" } }).error.code).toBe("forbidden");
  });

  it("buildPage returns a page that satisfies its schema", () => {
    expect(pageSchema(itemSchema).safeParse(buildPage(itemSchema)).success).toBe(true);
  });

  it("buildCollection returns a collection that satisfies its schema", () => {
    expect(collectionSchema(itemSchema).safeParse(buildCollection(itemSchema)).success).toBe(true);
  });

  it("buildAccepted returns an acceptance that satisfies its schema", () => {
    expect(acceptedSchema.safeParse(buildAccepted()).success).toBe(true);
  });

  // The builder rejects the override by running its own `schema.parse`, so the
  // failure is a `ZodError` — asserting the *type* keeps a missing builder (a
  // bare `TypeError`) from passing this test by accident.
  it("U4: buildPage throws a ZodError when an override is schema-invalid", () => {
    expect(() => buildPage(itemSchema, { total: -1 })).toThrow(z.ZodError);
  });

  it("U4: buildCollection throws a ZodError when an override breaks the hasMore/nextCursor refinement", () => {
    expect(() => buildCollection(itemSchema, { hasMore: true, nextCursor: null })).toThrow(
      z.ZodError
    );
  });
});
