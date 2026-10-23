import { randomInt } from "node:crypto";

/**
 * Tenant slug generation (OP-100, contract §0.4, schema §13.3).
 *
 * `tenants.slug` is a *stable, public-ish handle* — schema §13.3 calls it
 * "Stable handle for support and admin URLs; **non-sequential**" and gives it a
 * unique index — so it must be URL-safe, fixed-width (readable aloud and
 * pasteable) and unguessable: a sequential slug would turn "show me tenant
 * k7m2xq9p" into "show me tenant 41".
 *
 * This module owns only the *string*. Uniqueness under concurrency is enforced
 * by the `{slug:1}` unique index plus the caller's collision retry
 * ({@link import("./provisioning").ensureTenantForUser}).
 */

/** The documented slug alphabet: lowercase letters and digits (schema §13.3). */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The documented slug width (schema §13.3). */
const SLUG_LENGTH = 8;

/**
 * Generate a fresh tenant slug.
 *
 * Every call draws {@link SLUG_LENGTH} characters from {@link SLUG_ALPHABET}
 * using `crypto.randomInt`, so the result is cryptographically random (never a
 * counter or a clock) and independent of any other call.
 *
 * @returns Exactly 8 characters of `[a-z0-9]`.
 * @example
 * generateTenantSlug(); // "k7m2xq9p"
 */
export function generateTenantSlug(): string {
  let slug = "";
  for (let index = 0; index < SLUG_LENGTH; index += 1) {
    slug += SLUG_ALPHABET.charAt(randomInt(SLUG_ALPHABET.length));
  }
  return slug;
}
