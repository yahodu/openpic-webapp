import { hmacSha256Base64Url } from "@/server/runtime/crypto";

/**
 * Identity derivation for the rate-limit port (contract §0.11).
 *
 * A rate limit is keyed by an identity, never by a raw client-supplied value:
 * the principal id when authenticated, the attendee-session id for attendee
 * classes, or a *salted hash* of the client IP otherwise. Contact-keyed classes
 * (`auth.otp` / `auth.verify`) hash the normalised contact so an email or phone
 * number never becomes, or appears in, a rate-limit key (§0.15 never-return).
 */

/** The facts a request can contribute to identity derivation. */
export interface RateLimitFacts {
  /** The authenticated principal id, when known. */
  readonly principalId?: string;
  /** The attendee-session id, for attendee classes. */
  readonly attendeeSessionId?: string;
  /** The client IP (already resolved to the trusted hop by the caller). */
  readonly ip?: string;
  /** The contact (email/phone) for contact-keyed classes. */
  readonly contact?: string;
}

/** The scope a rule is keyed by; mirrors the §0.11 "keyed by" vocabulary. */
export type RateLimitScope = "user" | "attendee" | "ip" | "contact";

/** The identities derived from a request, one optional value per scope. */
export interface RateLimitIdentities {
  readonly user?: string;
  readonly attendee?: string;
  readonly ip?: string;
  readonly contact?: string;
}

/** Options for {@link deriveRateLimitIdentities}. */
export interface IdentityDerivationOptions {
  /** The salt mixed into every hashed identity; never logged. */
  readonly salt: string;
}

/**
 * Hash a value with the rate-limit salt.
 *
 * HMAC-SHA256 keyed by the salt, so the same value yields the same key for a
 * given deployment while a different salt yields a different key. The digest is
 * base64url (unpadded), so it contains no dots/`@` and can never carry the raw
 * IP or contact it was derived from.
 *
 * @param value - The value to hash (an IP or a normalised contact).
 * @param salt - The deployment salt.
 * @returns The URL-safe digest.
 */
export function hashIdentity(value: string, salt: string): string {
  return hmacSha256Base64Url(salt, value);
}

/** Normalise a contact so casing/whitespace cannot dodge a contact bucket. */
function normalizeContact(contact: string): string {
  return contact.trim().toLowerCase();
}

/**
 * Derive every identity a request can be keyed by.
 *
 * `user` is the principal id when authenticated, otherwise the hashed IP (so
 * an anonymous caller is still bucketed); `attendee` is the attendee-session
 * id; `ip` and `contact` are always salted hashes. Absent facts yield absent
 * identities, so a caller can skip a rule it cannot derive an identity for.
 *
 * @param facts - The request-derived facts.
 * @param options - The deployment salt.
 * @returns The derived identities, omitting any scope with no usable fact.
 */
export function deriveRateLimitIdentities(
  facts: RateLimitFacts,
  options: IdentityDerivationOptions
): RateLimitIdentities {
  const hashedIp =
    facts.ip === undefined || facts.ip === "" ? undefined : hashIdentity(facts.ip, options.salt);
  const user = facts.principalId ?? hashedIp;
  const attendee =
    facts.attendeeSessionId === undefined || facts.attendeeSessionId === ""
      ? undefined
      : facts.attendeeSessionId;
  const contact =
    facts.contact === undefined || facts.contact === ""
      ? undefined
      : hashIdentity(normalizeContact(facts.contact), options.salt);

  return {
    ...(user === undefined ? {} : { user }),
    ...(attendee === undefined ? {} : { attendee }),
    ...(hashedIp === undefined ? {} : { ip: hashedIp }),
    ...(contact === undefined ? {} : { contact }),
  };
}
