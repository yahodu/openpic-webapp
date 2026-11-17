import { randomInt } from "node:crypto";

/**
 * Share-link slug generation (OP-115, contract §4.1, schema §15.1).
 *
 * Every event is created with one `accessLinks[]` element whose `slug` is a
 * random 8-character handle from an **unambiguous** alphabet — the visually
 * ambiguous characters `0`, `o`, `1`, `l` and `i` are excluded so a slug read
 * aloud or typed on a phone never mixes variants (OP-115 U3).
 *
 * Uniqueness is the database's job (the unique partial index on
 * `events.accessLinks.slug`, ADR-0520): the generator is pure randomness, and
 * the create route retries with a fresh draw when the index rejects a
 * collision (integration case I5).
 */

/** The 31 unambiguous characters a slug may draw from (ADR-0520). */
export const ACCESS_LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Draw a random 8-character slug from {@link ACCESS_LINK_ALPHABET}.
 *
 * @returns Exactly 8 characters, each a member of the alphabet.
 */
export function generateAccessLinkSlug(): string {
  let slug = "";
  for (let index = 0; index < 8; index += 1) {
    slug += ACCESS_LINK_ALPHABET.charAt(randomInt(ACCESS_LINK_ALPHABET.length));
  }
  return slug;
}
