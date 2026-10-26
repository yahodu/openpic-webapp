import { describe, expect, it } from "vitest";

import { ACCESS_LINK_ALPHABET, generateAccessLinkSlug } from "@/server/events/slug";

/**
 * Unit — the share-link slug generator (OP-115 U3, contract §4.1, schema
 * §15.1 `accessLinks`).
 *
 * Every event is created with one `accessLinks[]` element whose `slug` is a
 * random 8-character handle from an **unambiguous** alphabet — the visually
 * ambiguous characters `0`, `o`, `1`, `l` and `i` are excluded so a slug read
 * aloud or typed on a phone never mixes variants. The alphabet and width are
 * the contract (documented in ADR-0520); the collision-retry behaviour around
 * the unique index is pinned at the integration level (I5), not here.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/slug
 *   ACCESS_LINK_ALPHABET: string            // "abcdefghjkmnpqrstuvwxyz23456789"
 *   generateAccessLinkSlug(): string        // exactly 8 chars from the alphabet
 * ```
 */

describe("ACCESS_LINK_ALPHABET (U3)", () => {
  it("is the documented 31-character unambiguous alphabet", () => {
    expect(ACCESS_LINK_ALPHABET).toBe("abcdefghjkmnpqrstuvwxyz23456789");
  });

  it.each(["0", "o", "1", "l", "i"])(
    "excludes the visually ambiguous character %s",
    (ambiguous) => {
      expect(ACCESS_LINK_ALPHABET).not.toContain(ambiguous);
    }
  );
});

describe("generateAccessLinkSlug (U3)", () => {
  it("produces exactly 8 characters", () => {
    expect(generateAccessLinkSlug()).toHaveLength(8);
  });

  it("draws every character from the exported alphabet", () => {
    const slug = generateAccessLinkSlug();
    for (const char of slug) {
      expect(ACCESS_LINK_ALPHABET).toContain(char);
    }
  });

  it("produces a different slug on consecutive calls", () => {
    expect(generateAccessLinkSlug()).not.toBe(generateAccessLinkSlug());
  });
});
