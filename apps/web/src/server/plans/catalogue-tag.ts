import { createHash } from "node:crypto";

import { strongETag } from "@/server/http/etag";

/**
 * The catalogue entity-tag digest (OP-102, contract §0.10).
 *
 * Both public catalogue reads — `GET /plans` and `GET /addons` — answer a
 * strong `ETag` so a client can revalidate cheaply (§3.1/§3.6). The tag's
 * *shape* is an implementation detail; only the invariants are contractual
 * (stable for an unchanged catalogue, distinct for a changed one). Keeping the
 * digest construction in one place means the two catalogues cannot drift on
 * the digest length or the hex encoding.
 */

/** The length of the hex digest kept in a catalogue tag (collision-safe, short enough for a header). */
const DIGEST_LENGTH = 32;

/**
 * Hash a catalogue fingerprint into a strong entity tag.
 *
 * @param fingerprint - The canonical string the tag is derived from (e.g. a
 *   join of the plans' `(key, version)` pairs, or the JSON of the served
 *   add-ons).
 * @returns A strong `ETag` header value.
 */
export function hashCatalogueTag(fingerprint: string): string {
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, DIGEST_LENGTH);

  return strongETag(digest);
}
