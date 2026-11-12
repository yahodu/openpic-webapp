import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ATTENDEE_TOKEN_PREFIX,
  generateAttendeeSessionToken,
  hashAttendeeSessionToken,
} from "@/server/attendee/session-token";

/**
 * Unit contract — anonymous attendee session token minting and hashing (OP-129
 * U1, contract §1.5, schema §13.5, ADR-0780).
 *
 * **Why this exists.** The `op_att` token is the *only* credential an anonymous
 * attendee holds, and it is a bearer key to that person's selfie and matched
 * photos (notification §2, schema §27). The contract makes two promises that
 * must hold before any route writes a row:
 *
 *   - the raw token is an **opaque, prefixed** secret (`opat_` + 32 random
 *     bytes, base64url) — random enough that it cannot be guessed, and shaped
 *     so the log redactor's `opat_` pattern matches it;
 *   - only `sha256(token)` is ever persisted (§0.15 "raw bearer tokens after
 *     their single issuance response", §1.5 "Server stores `sha256(token)`").
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/session-token` must export:
 *
 * ```ts
 * ATTENDEE_TOKEN_PREFIX: "opat_"
 * generateAttendeeSessionToken(): string            // fresh on every call
 * hashAttendeeSessionToken(rawToken: string): string // lowercase hex SHA-256
 * ```
 *
 * `hashAttendeeSessionToken` hashes the **whole** token, prefix included, so
 * the stored digest is a digest of exactly the value a client presents — the
 * resolver can therefore hash an inbound cookie/header and compare it byte for
 * byte (contract §1.5, schema §13.5 `{tokenHash:1}` unique).
 *
 * ## Assumptions (ADR-0780 §Assumptions)
 *
 * - 32 bytes of entropy encoded as 43 unpadded base64url characters is the
 *   documented shape: it reuses the shipped `randomToken(32, "opat_")`
 *   primitive (`@/server/runtime/crypto`), so the pinned entropy is the
 *   repository's existing convention rather than a new one.
 * - The digest is plain (unsalted) SHA-256, as schema §13.5 and contract §1.5
 *   both state; a salted digest would break the `{tokenHash:1}` lookup.
 */

/** The documented token shape: the literal prefix plus 32 bytes as base64url. */
const TOKEN_PATTERN = /^opat_[A-Za-z0-9_-]{43}$/;

/** A stored digest: lowercase hex SHA-256, 64 characters (contract §0.13). */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Known-answer vectors — `printf %s <input> | sha256sum`.
 *
 * A fixed vector proves the digest is SHA-256 over the exact UTF-8 bytes,
 * including the `opat_` prefix; a self-consistent hash/verify pair could not.
 */
const HASH_VECTORS: readonly (readonly [string, string])[] = [
  ["opat_9f2c", "6f65ea787a0e59ca8ec39e139944fb1a917050a4e40787b96c93dc05c8f3377b"],
  [
    "opat_9f2cQa1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    "d12f81550b4f87cf9a495a90dfe771d77d33b485512da891424d1cef817eacb1",
  ],
];

describe("attendee session token format", () => {
  it("U1: the token prefix is the documented literal 'opat_'", () => {
    expect(ATTENDEE_TOKEN_PREFIX).toBe("opat_");
  });

  it("U1: mints an 'opat_' token of 32 random bytes as 43 base64url characters", () => {
    const tokens = [
      generateAttendeeSessionToken(),
      generateAttendeeSessionToken(),
      generateAttendeeSessionToken(),
    ];

    expect(tokens.map((token) => TOKEN_PATTERN.test(token))).toEqual([true, true, true]);
  });

  it("U1: mints a distinct token on every call", () => {
    const tokens = Array.from({ length: 8 }, () => generateAttendeeSessionToken());

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("U1: never mints a value a log redactor would leave in the clear", () => {
    // The repository's redaction pattern is `opat_[A-Za-z0-9_-]{6,}`
    // (`@/server/logging/redaction`); a minted token must stay inside it.
    const token = generateAttendeeSessionToken();

    expect(/opat_[A-Za-z0-9_-]{6,}/.test(token)).toBe(true);
  });
});

describe("attendee session token hashing", () => {
  it.each(HASH_VECTORS)("U1: hashes %s to the known SHA-256 vector", (input, expected) => {
    expect(hashAttendeeSessionToken(input)).toBe(expected);
  });

  it("U1: hashes the whole token, prefix included, and not the bare payload", () => {
    const withPrefix = hashAttendeeSessionToken("opat_abc");
    const withoutPrefix = hashAttendeeSessionToken("abc");

    expect(withPrefix).not.toBe(withoutPrefix);
    expect(withPrefix).toMatch(HASH_PATTERN);
    expect(withoutPrefix).toMatch(HASH_PATTERN);
  });

  it("U1: a minted token hashes to a stable digest that never contains the token", () => {
    const token = generateAttendeeSessionToken();

    const first = hashAttendeeSessionToken(token);
    const second = hashAttendeeSessionToken(token);

    expect(first).toBe(second);
    expect(first).toMatch(HASH_PATTERN);
    expect(first).toBe(createHash("sha256").update(token).digest("hex"));
    expect(first).not.toContain(token);
  });

  it("U1: two different tokens never share a digest", () => {
    const first = hashAttendeeSessionToken(generateAttendeeSessionToken());
    const second = hashAttendeeSessionToken(generateAttendeeSessionToken());

    expect(first).not.toBe(second);
  });
});
