import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Crypto helpers (OP-72, epic Runtime Primitives).
 *
 * Thin, typed wrappers over `node:crypto` for signing and secret comparison so
 * call sites never hand-roll hashing or reach for `===` on secrets.
 */

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes of `input`.
 *
 * @param input - The string to hash.
 * @returns 64 lowercase hex characters.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Lowercase hex HMAC-SHA256.
 *
 * @param key - The signing key (string is UTF-8 encoded, or raw bytes).
 * @param data - The message (string is UTF-8 encoded, or raw bytes).
 * @returns 64 lowercase hex characters.
 */
export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Base64url (unpadded) HMAC-SHA256.
 *
 * @param key - The signing key (string is UTF-8 encoded, or raw bytes).
 * @param data - The message (string is UTF-8 encoded, or raw bytes).
 * @returns The URL-safe digest with no `=` padding.
 */
export function hmacSha256Base64Url(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/**
 * Constant-time comparison of two strings by their UTF-8 bytes.
 *
 * Length-safe: different lengths short-circuit to `false` instead of throwing
 * the way `crypto.timingSafeEqual` does.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns `true` only when both strings have identical bytes.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * A base64url-encoded cryptographically-random token.
 *
 * @param bytes - Number of random bytes to encode.
 * @param prefix - Optional literal prefix (e.g. `"opat_"`).
 * @returns The prefix followed by the unpadded base64url encoding.
 */
export function randomToken(bytes: number, prefix = ""): string {
  return prefix + randomBytes(bytes).toString("base64url");
}
