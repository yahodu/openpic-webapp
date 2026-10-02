import { z } from "zod";

import { idSchema } from "./primitives";

/**
 * Shared response envelopes (API contract §0.15 / Appendix A).
 *
 * Envelopes wrap the items of a collection and the acknowledgement of work the
 * server has accepted but not yet finished. They are generic over the item
 * schema so a domain story composes its own collection without re-deriving the
 * pagination invariants.
 */

/** An offset-paginated page of items. */
export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Build the offset pagination envelope for an item schema.
 *
 * `total` counts every matching row, `page` is 1-based and `pageSize` bounds the
 * rows returned, so none of them can be negative or zero.
 *
 * @param itemSchema - The Zod schema for one item.
 * @returns A Zod schema for the page envelope.
 */
export function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.int().min(0),
    page: z.int().min(1),
    pageSize: z.int().min(1),
  });
}

/** A cursor-paginated collection of items. */
export interface Collection<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * Build the cursor collection envelope for an item schema.
 *
 * `hasMore` and `nextCursor` are refined together: a non-terminal page with a
 * null cursor would strand a client that follows the cursor, and a terminal
 * page that still offers a cursor would make the client fetch a page that
 * cannot exist.
 *
 * @param itemSchema - The Zod schema for one item.
 * @returns A Zod schema for the collection envelope.
 */
export function collectionSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    })
    .refine((collection) => collection.hasMore === (collection.nextCursor !== null), {
      message: "nextCursor must be set exactly when hasMore is true.",
    });
}

/** The `202 Accepted` envelope for asynchronous work. */
export const acceptedSchema = z.object({
  jobId: idSchema,
});

/** Inferred DTO for {@link acceptedSchema}. */
export type Accepted = z.infer<typeof acceptedSchema>;
