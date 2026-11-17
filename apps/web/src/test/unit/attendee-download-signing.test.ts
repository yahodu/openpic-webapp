import { describe, expect, it } from "vitest";

import { createMediaSigner, type SignMediaInput } from "@/server/media/signer";
import { hmacSha256Base64Url } from "@/server/runtime/crypto";

/**
 * Unit contract — a download's filename is bound into the signed original URL
 * (OP-133 U4; contract §6.6, §5.6/§5.7; ADR-0793 §4).
 *
 * **Why this exists.** §6.6 hands the attendee a 15-minute original URL. When
 * that URL is a *download*, the browser's saved file name comes from the
 * `Content-Disposition` the media Worker derives from the URL — so the file
 * name is part of the authorization surface. If the name travelled as an
 * unsigned query parameter, anyone holding a signed link could rewrite it: at
 * best the attendee gets `photo.jpg` instead of `Rahul & Priya 019.jpg`, at
 * worst the parameter becomes a header-injection or log-forging vector. The
 * signature scheme of §5.7 therefore has to cover it.
 *
 * **Contract pinned here.**
 *
 * ```
 * sign({ kind: "original", contentHash, ext, download?: string }): { url, expiresAt }
 * verify(url): boolean
 * ```
 *
 * - `download` is optional. Absent, the URL and its signature are exactly what
 *   the shipped signer mints today — every existing §5.6/§5.7 pin keeps
 *   passing.
 * - Present, the URL carries `download=<percent-encoded name>` and the
 *   signature covers the *name*, not just the path: changing it, dropping it,
 *   or adding one to a URL that had none all fail `verify`.
 * - The name is percent-encoded, so a name with a quote, a semicolon, a space
 *   or non-ASCII text can never appear raw in the URL. `verify` still accepts
 *   the encoded form it minted.
 */

/** A fixed instant, so `exp` and `expiresAt` are deterministic. */
const NOW = new Date("2026-11-13T10:00:00.000Z");

/** The §5.6 current secret (a test fixture, never a real one). */
const SECRET = "op133-media-signing-fixture-secret-0123456789";

/** A content hash shaped like §5.1's (`sha256`, lowercase hex). */
const CONTENT_HASH = "3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff";

/** The 15-minute original lifetime (§6.6). */
const ORIGINAL_TTL_SECONDS = 900;

/** The signer these cases drive, bound to the fixed clock. */
const signer = createMediaSigner({
  currentSecret: SECRET,
  clock: { now: () => NOW },
});

/** A sign call whose `download` name is the only thing a case varies. */
function signDownload(fileName: string, kind: "original" | "export" = "original") {
  // The intersection keeps this spec type-clean before and after the signer
  // grows the optional field: it is assignable either way.
  const input: SignMediaInput & { readonly download: string } = {
    kind,
    contentHash: CONTENT_HASH,
    ext: "jpg",
    download: fileName,
  };
  return signer.sign(input);
}

/** The parsed query of a signed URL. */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("a signed download URL", () => {
  it("carries the filename as a percent-encoded query parameter", () => {
    const { url } = signDownload("Rahul & Priya 019.jpg");

    expect(new URL(url).pathname).toBe(`/o/${CONTENT_HASH}.jpg`);
    expect(queryOf(url).get("download")).toBe("Rahul & Priya 019.jpg");
    expect(url).toContain("download=Rahul%20%26%20Priya%20019.jpg");
  });

  it("keeps the 15-minute original lifetime", () => {
    const { url, expiresAt } = signDownload("photo.jpg");

    expect(Number(queryOf(url).get("exp"))).toBe(
      Math.floor(NOW.getTime() / 1000) + ORIGINAL_TTL_SECONDS
    );
    expect(expiresAt).toBe("2026-11-13T10:15:00.000Z");
  });

  it("verifies when it is presented unchanged", () => {
    expect(signer.verify(signDownload("photo.jpg").url)).toBe(true);
  });

  it("does not verify once the filename is changed", () => {
    // The binding itself: a signed link cannot be relabelled.
    const { url } = signDownload("photo.jpg");
    const tampered = url.replace("download=photo.jpg", "download=someone-else.jpg");

    expect(tampered).not.toBe(url);
    expect(signer.verify(tampered)).toBe(false);
  });

  it("does not verify once the filename is dropped", () => {
    const { url } = signDownload("photo.jpg");
    const stripped = url.replace(/[?&]download=[^&]*/, "");

    expect(stripped).not.toBe(url);
    expect(signer.verify(stripped)).toBe(false);
  });

  it("does not verify when a filename is added to a URL that was signed without one", () => {
    const plain = signer.sign({ kind: "original", contentHash: CONTENT_HASH, ext: "jpg" });
    const extended = `${plain.url}&download=photo.jpg`;

    expect(signer.verify(plain.url)).toBe(true);
    expect(signer.verify(extended)).toBe(false);
  });

  it("signs two different filenames over the same path differently", () => {
    const first = signDownload("photo.jpg").url;
    const second = signDownload("photo-2.jpg").url;

    expect(queryOf(first).get("sig")).not.toBe(queryOf(second).get("sig"));
  });

  it("percent-encodes a name that could forge a header or a log line", () => {
    const hostile = 'evil"; filename="x.jpg\r\n';
    const { url } = signDownload(hostile);
    const raw = new URL(url).search;

    expect(raw).not.toContain('"');
    expect(raw).not.toContain(";");
    expect(raw).not.toContain("\r");
    expect(raw).not.toContain("\n");
    expect(queryOf(url).get("download")).toBe(hostile);
    expect(signer.verify(url)).toBe(true);
  });

  it("round-trips a non-ASCII filename", () => {
    const { url } = signDownload("Ünïcode-photo.jpg");

    expect(url).not.toContain("Ü");
    expect(queryOf(url).get("download")).toBe("Ünïcode-photo.jpg");
    expect(signer.verify(url)).toBe(true);
  });

  it("binds the filename on an exported archive too", () => {
    const { url } = signDownload("all-matches.zip", "export");

    expect(new URL(url).pathname).toBe(`/o/${CONTENT_HASH}.jpg`);
    expect(queryOf(url).get("download")).toBe("all-matches.zip");
    expect(signer.verify(url)).toBe(true);
    expect(signer.verify(url.replace("all-matches.zip", "other.zip"))).toBe(false);
  });

  it("leaves a URL signed without a filename on the shipped three-part preimage", () => {
    // Independent check of §5.7's `METHOD\nPATH\nEXPIRY` preimage, so a signer
    // that unconditionally appended an empty filename would fail here.
    const plain = signer.sign({ kind: "original", contentHash: CONTENT_HASH, ext: "jpg" });
    const exp = String(Math.floor(NOW.getTime() / 1000) + ORIGINAL_TTL_SECONDS);
    const expectedSignature = hmacSha256Base64Url(SECRET, `GET\n/o/${CONTENT_HASH}.jpg\n${exp}`);

    expect(plain.url).toBe(
      `https://pic.openpic.in/o/${CONTENT_HASH}.jpg?exp=${exp}&sig=${expectedSignature}`
    );
    expect(queryOf(plain.url).get("download")).toBeNull();
  });
});
