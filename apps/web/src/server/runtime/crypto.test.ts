import { describe, expect, it } from "vitest";

import {
  hmacSha256Base64Url,
  hmacSha256Hex,
  randomToken,
  sha256Hex,
  timingSafeEqualStr,
} from "./crypto";

/**
 * Contract under test — crypto helpers (OP-72, epic Runtime Primitives).
 *
 * `src/server/runtime/crypto.ts` must expose:
 *
 *   - `sha256Hex(input)` — lowercase hex SHA-256 of the UTF-8 input.
 *   - `hmacSha256Hex(key, data)` — lowercase hex HMAC-SHA256.
 *   - `hmacSha256Base64Url(key, data)` — base64url HMAC-SHA256 (no padding).
 *   - `timingSafeEqualStr(a, b)` — constant-time string comparison that is
 *     length-safe (returns `false` for different lengths instead of throwing).
 *   - `randomToken(bytes, prefix?)` — base64url-encoded random bytes, with an
 *     optional literal prefix.
 *
 * Vectors: SHA-256 from FIPS 180-4 / NIST examples; HMAC-SHA256 from RFC 4231
 * test cases 1–3.
 */

describe("sha256Hex", () => {
  it.each([
    ["the empty string", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["'a'", "a", "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"],
    ["'abc'", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("U4: hashes %s to the known SHA-256 vector", (_label, input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("U4: hashes UTF-8 bytes, not UTF-16 code units", () => {
    // 'é' is 2 UTF-8 bytes (0xc3 0xa9); a code-unit hash would differ.
    expect(sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"
    );
    // Astral-plane characters (a surrogate pair) must hash the same 4 bytes.
    expect(sha256Hex("🚀")).toBe(
      "ebbc0b2870eb323f2b6cffa5c493ceef81ae7eb36afc73d4e0367301631daec5"
    );
  });
});

describe("hmacSha256", () => {
  it("U5: matches RFC 4231 test case 1 (20-byte 0x0b key, text message)", () => {
    expect(hmacSha256Hex(Buffer.alloc(20, 0x0b), "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
  });

  it("U5: matches RFC 4231 test case 2 (text key and message)", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
  });

  it("U5: matches RFC 4231 test case 3 (binary key and binary message)", () => {
    expect(hmacSha256Hex(Buffer.alloc(20, 0xaa), Buffer.alloc(50, 0xdd))).toBe(
      "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
    );
  });

  it("U5: hmacSha256Base64Url is the unpadded base64url of the same digest (TC2)", () => {
    expect(hmacSha256Base64Url("Jefe", "what do ya want for nothing?")).toBe(
      "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM"
    );
  });
});

describe("timingSafeEqualStr", () => {
  it("U6: returns false for different-length strings without throwing", () => {
    expect(() => timingSafeEqualStr("abc", "abcd")).not.toThrow();
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });

  it("U6: returns true for identical strings", () => {
    expect(timingSafeEqualStr("s3cr3t-value", "s3cr3t-value")).toBe(true);
  });

  it("U6: returns false for same-length strings that differ", () => {
    expect(timingSafeEqualStr("abcd", "abce")).toBe(false);
  });

  it("U6: handles the empty string without throwing", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });

  it("U6: compares bytes, so a multi-byte character is not treated as one unit", () => {
    expect(timingSafeEqualStr("é", "é")).toBe(true);
    expect(timingSafeEqualStr("é", "e")).toBe(false);
  });
});

describe("randomToken", () => {
  it("U7: randomToken(32) yields 43 url-safe characters", () => {
    const token = randomToken(32);

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("U7: randomToken(32) is url-safe with no base64 padding", () => {
    const token = randomToken(32);

    expect(token).not.toContain("=");
    expect(token).not.toMatch(/[+/]/);
  });

  it("U7: scales the length with the byte count (16 bytes -> 22 chars)", () => {
    expect(randomToken(16)).toHaveLength(22);
  });

  it("U7: prefixes the token when a prefix is given", () => {
    const token = randomToken(32, "opat_");

    expect(token.startsWith("opat_")).toBe(true);
    expect(token).toHaveLength("opat_".length + 43);
    expect(token.slice("opat_".length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("U7: two calls yield different tokens", () => {
    expect(randomToken(32)).not.toBe(randomToken(32));
  });

  it("U7: uses call-specific randomness, never a fixed seed", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => randomToken(32)));

    expect(tokens.size).toBe(20);
  });
});
