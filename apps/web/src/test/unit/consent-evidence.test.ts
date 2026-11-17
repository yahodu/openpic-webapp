import { describe, expect, it } from "vitest";

import { buildConsentEvidence } from "@/server/attendee/consent-evidence";
import { parseLocale } from "@/server/auth/locale";

/**
 * Unit contract — the biometric-consent evidence builder
 * (OP-131 U1, contract §6.2, schema §15.4, ADR-0789).
 *
 * **Why this exists.** GDPR/DPDPA require consent to be _demonstrable_ years
 * after the fact: who agreed, to which document, when, and **how**. Schema §15.4
 * stores that as
 * `evidence: { ipHash, uaHash, method: "checkbox" | "in_app_action", locale }`,
 * and contract §6.2 names `method: "checkbox"` as the attendee surface's value.
 * The two hashes are the only device facts the row may keep: §0.15 forbids
 * storing or logging a raw IP or user agent, so the builder must digest them
 * with the deployment salt exactly as the session device fingerprint does
 * (`@/server/auth/device-fingerprint` — a leaked digest cannot be reversed into
 * an address).
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/consent-evidence` must export:
 *
 * ```ts
 * interface ConsentEvidenceInput {
 *   salt: string;                      // getRateLimitConfig().salt
 *   ip: string | null;                 // resolveClientIp(...) ?? null
 *   userAgent: string | null;          // request header "user-agent"
 *   acceptLanguage: string | null;     // request header "accept-language"
 * }
 * interface ConsentEvidence {
 *   ipHash: string;                    // 64-char lowercase hex SHA-256
 *   uaHash: string;                    // 64-char lowercase hex SHA-256
 *   method: "checkbox";
 *   locale: string;                    // parseLocale(acceptLanguage)
 * }
 * function buildConsentEvidence(input: ConsentEvidenceInput): ConsentEvidence
 * ```
 *
 * `ipHash` and `uaHash` are derived **separately** (never one digest of a
 * concatenation), salted with `input.salt`, deterministic for the same facts,
 * and computed even when the part is absent (`null` → the digest of an empty
 * part, never `null`). `locale` is resolved through the app's existing
 * `parseLocale`, so a stored locale is always a tag the product actually serves.
 */

/** The deployment salt these cases hash with. */
const SALT = "op131-evidence-salt-0123456789abcdef";

/** A second salt, to prove the salt participates in the digest. */
const OTHER_SALT = "op131-evidence-salt-fedcba9876543210";

/** A documentation-range client address (RFC 5737 TEST-NET-2). */
const IP = "198.51.100.24";

/** A second client address, distinct from {@link IP}. */
const OTHER_IP = "198.51.100.25";

/** A user agent long enough to look like a real browser string. */
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) ConsentProbe/1.0";

/** The `Accept-Language` header a browser sends. */
const ACCEPT_LANGUAGE = "en-IN,en;q=0.9";

/** A SHA-256 digest as the schema stores it: 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The four keys schema §15.4 gives `consents.evidence`, sorted. */
const EVIDENCE_KEYS = ["ipHash", "locale", "method", "uaHash"];

/**
 * Build the evidence for the standard request facts.
 *
 * @param overrides - The facts this case varies.
 * @returns The built evidence.
 */
function evidence(
  overrides: Partial<Parameters<typeof buildConsentEvidence>[0]> = {}
): ReturnType<typeof buildConsentEvidence> {
  return buildConsentEvidence({
    salt: SALT,
    ip: IP,
    userAgent: USER_AGENT,
    acceptLanguage: ACCEPT_LANGUAGE,
    ...overrides,
  });
}

describe("buildConsentEvidence — the four stored fields (schema §15.4)", () => {
  it("U1: returns exactly the four evidence fields and nothing else", () => {
    expect(Object.keys(evidence()).sort()).toEqual(EVIDENCE_KEYS);
  });

  it('U1: records how consent was given as "checkbox" (contract §6.2)', () => {
    expect(evidence().method).toBe("checkbox");
  });
});

describe("buildConsentEvidence — hashing (contract §0.15, schema §15.4)", () => {
  it("U1: hashes the IP and the user agent to 64-character lowercase hex digests", () => {
    const built = evidence();

    expect(built.ipHash).toMatch(SHA256_HEX);
    expect(built.uaHash).toMatch(SHA256_HEX);
  });

  it("U1: is deterministic for the same facts and the same salt", () => {
    expect(evidence()).toEqual(evidence());
  });

  it("U1: never stores the raw IP or the raw user agent", () => {
    const serialized = JSON.stringify(evidence());

    expect(serialized).not.toContain(IP);
    expect(serialized).not.toContain(USER_AGENT);
    expect(serialized).not.toContain(ACCEPT_LANGUAGE);
  });

  it("U1: hashes a different IP to a different digest while the user agent digest is unchanged", () => {
    const first = evidence();
    const second = evidence({ ip: OTHER_IP });

    expect(second.ipHash).not.toBe(first.ipHash);
    expect(second.uaHash).toBe(first.uaHash);
  });

  it("U1: hashes a different user agent to a different digest", () => {
    const first = evidence();
    const second = evidence({ userAgent: `${USER_AGENT} (tablet)` });

    expect(second.uaHash).not.toBe(first.uaHash);
    expect(second.ipHash).toBe(first.ipHash);
  });

  it("U1: mixes the deployment salt into both digests", () => {
    const first = evidence();
    const second = evidence({ salt: OTHER_SALT });

    expect(second.ipHash).not.toBe(first.ipHash);
    expect(second.uaHash).not.toBe(first.uaHash);
  });

  it("U1: hashes an absent IP and an absent user agent to digests rather than null", () => {
    const built = evidence({ ip: null, userAgent: null });

    expect(built.ipHash).toMatch(SHA256_HEX);
    expect(built.uaHash).toMatch(SHA256_HEX);
    // An absent part must not collide with a real one.
    expect(built.ipHash).not.toBe(evidence().ipHash);
  });
});

describe("buildConsentEvidence — the stored locale", () => {
  it.each<[string | null]>([[ACCEPT_LANGUAGE], [null], ["fr-FR,fr;q=0.8"]])(
    "U1: resolves the locale from the Accept-Language header %s through parseLocale",
    (acceptLanguage) => {
      expect(evidence({ acceptLanguage }).locale).toBe(parseLocale(acceptLanguage));
    }
  );

  it("U1: stores the resolved tag, never the raw Accept-Language header", () => {
    const built = evidence();

    expect(built.locale).not.toBe(ACCEPT_LANGUAGE);
    expect(built.locale).toBe("en-IN");
  });
});
