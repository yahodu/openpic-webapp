import type { ObjectId } from "mongodb";

/**
 * DTO projection — the boundary between stored documents and the shape
 * returned to callers (OP-77, conventions §8.1 never-return).
 *
 * A document read from MongoDB carries its raw `_id`; the never-return rule
 * forbids exposing internal identifiers, so every read path projects through
 * {@link toDto}. Renaming `_id` to a string `id` (and dropping `_id` entirely)
 * means a leak is impossible by accident — the caller never holds the field.
 */

/** A stored document with its driver-assigned `_id`. */
export type WithId<T> = T & { _id: ObjectId };

/** A client-facing projection: the document with `_id` renamed to a string `id`. */
export type Dto<T> = Omit<T, "_id"> & { readonly id: string };

/**
 * Project a stored document into its client-facing DTO.
 *
 * Maps `_id` to a string `id` and strips the internal `_id` key so it can never
 * be serialised. A null input passes straight through, which keeps the call
 * site free of null-handling noise on optional reads.
 *
 * @param doc - The stored document, or null when no row matched.
 * @returns The DTO with a string `id` and no `_id`, or null.
 * @example
 * ```ts
 * toDto({ _id: objectId, name: "Rahul Studio" }); // { name: "Rahul Studio", id: "6702ff..." }
 * ```
 */
export function toDto<T extends Record<string, unknown>>(doc: WithId<T> | null): Dto<T> | null {
  if (doc === null) {
    return null;
  }

  const { _id, ...rest } = doc;
  return { ...(rest as Omit<T, "_id">), id: String(_id) };
}
