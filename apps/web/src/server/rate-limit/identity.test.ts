import { describe, expect, it } from "vitest";

import { deriveRateLimitIdentities, hashIdentity } from "@/server/rate-limit";

/**
 * U1 + U6 — identity derivation and hashing (contract §0.11).
 *
 * A class is keyed by an identity: the principal id when authenticated, the
 * attendee-session id for attendee classes, or the client IP otherwise. Contact
 * keyed classes (auth.otp / auth.verify) are keyed by a *hashed* contact so a
 * raw email or phone number never becomes part of a rate-limit key.
 */

const SALT = "test-rate-limit-salt";

describe("rate-limit identity derivation", () => {
  it("U1: derives the principal id verbatim for an authenticated user", () => {
    const identities = deriveRateLimitIdentities({ principalId: "usr_01H" }, { salt: SALT });

    expect(identities.user).toBe("usr_01H");
    expect(identities.attendee).toBeUndefined();
    expect(identities.ip).toBeUndefined();
    expect(identities.contact).toBeUndefined();
  });

  it("U1: derives the attendee-session id verbatim for an attendee", () => {
    const identities = deriveRateLimitIdentities({ attendeeSessionId: "att_9" }, { salt: SALT });

    expect(identities.attendee).toBe("att_9");
    expect(identities.user).toBeUndefined();
  });

  it("U1: derives a salted hash for a client IP and never the raw IP", () => {
    const identities = deriveRateLimitIdentities({ ip: "203.0.113.7" }, { salt: SALT });

    expect(identities.ip).toBe(hashIdentity("203.0.113.7", SALT));
    expect(identities.ip).not.toContain("203.0.113.7");
  });

  it("U1: falls back to the hashed IP for the user scope when there is no principal", () => {
    const identities = deriveRateLimitIdentities({ ip: "198.51.100.4" }, { salt: SALT });

    expect(identities.user).toBe(hashIdentity("198.51.100.4", SALT));
  });

  it("U6: hashes the contact key and never places the raw email in the key", () => {
    const identities = deriveRateLimitIdentities({ contact: "Ada@Example.COM " }, { salt: SALT });

    expect(identities.contact).toBe(hashIdentity("ada@example.com", SALT));
    expect(identities.contact).not.toContain("Ada");
    expect(identities.contact).not.toContain("ada");
    expect(identities.contact).not.toContain("Example");
  });
});

describe("hashIdentity", () => {
  it("U6: is deterministic for the same value and salt", () => {
    expect(hashIdentity("203.0.113.7", SALT)).toBe(hashIdentity("203.0.113.7", SALT));
  });

  it("U6: is salted (a different salt yields a different hash)", () => {
    expect(hashIdentity("203.0.113.7", "salt-a")).not.toBe(hashIdentity("203.0.113.7", "salt-b"));
  });
});
