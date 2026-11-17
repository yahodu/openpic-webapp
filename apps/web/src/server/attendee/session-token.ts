import { randomToken, sha256Hex } from "@/server/runtime/crypto";

/**
 * Anonymous attendee session token (OP-129, contract §1.5, schema §13.5).
 *
 * The `op_att` token is the only credential an anonymous attendee holds, and it
 * is a bearer key to that person's selfie and matched photos. Two properties
 * therefore live here and nowhere else:
 *
 *   - minting is the shipped {@link randomToken} primitive (32 random bytes as
 *     43 unpadded base64url characters behind the `opat_` prefix), which also
 *     keeps the value inside the log redactor's `opat_` pattern;
 *   - hashing is plain, unsalted SHA-256 over the **whole** token, because the
 *     `{tokenHash:1}` unique index is a digest lookup of exactly what a client
 *     presents (a salted digest could not be looked up).
 */

/** The documented token prefix (contract §1.5). */
export const ATTENDEE_TOKEN_PREFIX = "opat_";

/**
 * Mint a fresh attendee session token.
 *
 * @returns `opat_` followed by 43 base64url characters.
 */
export function generateAttendeeSessionToken(): string {
  return randomToken(32, ATTENDEE_TOKEN_PREFIX);
}

/**
 * Hash a raw token for storage or lookup.
 *
 * @param raw - The whole token, prefix included.
 * @returns 64 lowercase hex characters.
 */
export function hashAttendeeSessionToken(raw: string): string {
  return sha256Hex(raw);
}
