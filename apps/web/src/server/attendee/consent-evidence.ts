import { hashFingerprint } from "@/server/auth/device-fingerprint";
import { parseLocale } from "@/server/auth/locale";

/**
 * The biometric-consent evidence builder (OP-131, contract §6.2, schema §15.4;
 * ADR-0789 §1).
 *
 * Consent must be demonstrable years later — who agreed, and **how** — so the
 * `consents.evidence` row keeps the device facts as salted digests: §0.15
 * forbids storing or logging a raw IP or user agent, and a leaked digest cannot
 * be reversed into an address. The two hashes are derived separately (never one
 * digest of a concatenation) on the shipped {@link hashFingerprint} scheme, so a
 * consent digest is consistent with the session device fingerprints; an absent
 * part hashes its empty slot rather than becoming `null`. The locale is
 * resolved through {@link parseLocale}, so a stored tag is always one the
 * product serves.
 */

/** The request facts and deployment salt the evidence is derived from. */
export interface ConsentEvidenceInput {
  /** The deployment salt (`getRateLimitConfig().salt`). */
  readonly salt: string;
  /** The client address, or `null` when it could not be resolved. */
  readonly ip: string | null;
  /** The raw `user-agent` header, or `null`. */
  readonly userAgent: string | null;
  /** The raw `accept-language` header, or `null`. */
  readonly acceptLanguage: string | null;
}

/** The four fields schema §15.4 stores under `consents.evidence`. */
export interface ConsentEvidence {
  /** A 64-character lowercase hex SHA-256 of the client address. */
  readonly ipHash: string;
  /** A 64-character lowercase hex SHA-256 of the user agent. */
  readonly uaHash: string;
  /** How consent was given on the attendee surface (contract §6.2). */
  readonly method: "checkbox";
  /** The served locale the consent was given in (schema §15.4). */
  readonly locale: string;
}

/**
 * Build the stored evidence for one consent grant.
 *
 * @param input - The request facts and the deployment salt.
 * @returns The four `evidence` fields, never carrying a raw value.
 */
export function buildConsentEvidence(input: ConsentEvidenceInput): ConsentEvidence {
  return {
    ipHash: hashFingerprint({ ip: input.ip }, input.salt),
    uaHash: hashFingerprint({ userAgent: input.userAgent }, input.salt),
    method: "checkbox",
    locale: parseLocale(input.acceptLanguage),
  };
}
