import { hashCatalogueTag } from "./catalogue-tag";

/**
 * The `GET /plans` catalogue entity tag (OP-102, contract §3.1/§0.10,
 * ADR-0320).
 *
 * `GET /plans` is `public, max-age=300` and supports a conditional request, so
 * the tag must be a function of the catalogue's **plan versions** and nothing
 * else: an unchanged catalogue revalidates to `304`, while any plan whose
 * entitlements changed (a `version` bump — ADR-0014 §6) invalidates every
 * cached copy so no client serves stale limits.
 *
 * The tag is derived from the served plans' `(key, version)` pairs only, so a
 * copy-only edit (`name`, `description`, `marketingFeatures`) deliberately does
 * **not** invalidate a cached response; `max-age=300` bounds that staleness to
 * five minutes. The tag's shape is an implementation detail: only the
 * invariants matter — same versions ⇒ same tag, and any added/removed plan or
 * bumped version ⇒ a different tag.
 */

/**
 * Compute the `GET /plans` entity tag from the served plans' versions.
 *
 * @param entries - The served plans, as `{ key, version }` pairs.
 * @returns A strong `ETag` header value, stable for the same version set and
 *   distinct for any added/removed plan or bumped version (and non-empty for an
 *   empty catalogue).
 */
export function planCatalogueETag(
  entries: readonly { readonly key: string; readonly version: number }[]
): string {
  return hashCatalogueTag(
    entries.map((entry) => `${entry.key}\u0000${String(entry.version)}`).join("\u0001")
  );
}
