import { z } from "zod";

import { apiErrorSchema } from "../errors";
import type { ApiErrorEnvelopeDto } from "../errors";
import { acceptedSchema, collectionSchema, pageSchema } from "../envelopes";
import type { Accepted, Collection, Page } from "../envelopes";

/**
 * Fixture builders for the shared envelopes (CONVENTIONS §3).
 *
 * Every builder returns `schema.parse({ ...defaults, ...overrides })`, so a
 * fixture can never drift from its schema and an invalid override is rejected
 * at build time rather than leaking into a test as a "passing" assertion
 * against data no client would ever accept.
 */

/** A deterministic default 24-hex id every fixture can share. */
const DEFAULT_ID = "507f1f77bcf86cd799439011";

/**
 * Build a valid API error envelope.
 *
 * @param overrides - Top-level fields to override on the default payload. The
 *   spread is shallow, so an override of the nested `error` object must be
 *   complete.
 * @returns A schema-valid error envelope.
 * @throws {z.ZodError} when an override does not satisfy {@link apiErrorSchema}.
 * @example
 * buildApiError({ error: { code: "not_found", message: "gone", requestId: "req_1", retryable: false } });
 */
export function buildApiError(overrides: Partial<ApiErrorEnvelopeDto> = {}): ApiErrorEnvelopeDto {
  return apiErrorSchema.parse({
    error: {
      code: "internal_error",
      message: "Something went wrong.",
      requestId: "req_fixture00000000",
      retryable: false,
    },
    ...overrides,
  });
}

/**
 * Build a valid offset-paginated page.
 *
 * @param itemSchema - The Zod schema for one item.
 * @param overrides - Fields to override on the default payload.
 * @returns A schema-valid page.
 * @throws {z.ZodError} when an override does not satisfy the page schema.
 * @example
 * buildPage(z.object({ id: z.string() }), { total: 3 });
 */
export function buildPage<T extends z.ZodType>(
  itemSchema: T,
  overrides: Partial<Page<z.infer<T>>> = {}
): Page<z.infer<T>> {
  const page: Page<z.infer<T>> = {
    items: overrides.items ?? [],
    total: overrides.total ?? 0,
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 20,
  };
  return pageSchema(itemSchema).parse(page);
}

/**
 * Build a valid cursor collection.
 *
 * @param itemSchema - The Zod schema for one item.
 * @param overrides - Fields to override on the default payload. `hasMore` and
 *   `nextCursor` are refined together, so they must be overridden consistently.
 * @returns A schema-valid collection.
 * @throws {z.ZodError} when an override breaks the `hasMore`/`nextCursor` refinement.
 * @example
 * buildCollection(z.object({ id: z.string() }), { hasMore: true, nextCursor: "c2Vjb25k" });
 */
export function buildCollection<T extends z.ZodType>(
  itemSchema: T,
  overrides: Partial<Collection<z.infer<T>>> = {}
): Collection<z.infer<T>> {
  const collection: Collection<z.infer<T>> = {
    items: overrides.items ?? [],
    hasMore: overrides.hasMore ?? false,
    nextCursor: overrides.nextCursor ?? null,
  };
  return collectionSchema(itemSchema).parse(collection);
}

/**
 * Build a valid `202 Accepted` acknowledgement.
 *
 * @param overrides - Fields to override on the default payload.
 * @returns A schema-valid acceptance.
 * @throws {z.ZodError} when an override does not satisfy {@link acceptedSchema}.
 * @example
 * buildAccepted();
 */
export function buildAccepted(overrides: Partial<Accepted> = {}): Accepted {
  return acceptedSchema.parse({ jobId: DEFAULT_ID, ...overrides });
}
