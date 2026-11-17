import { describe, expect, it } from "vitest";

import { detectBrandingUpload, sniffBrandingFormat } from "@/server/media/branding-type";

/**
 * Branding upload type detection (OP-114, API contract §2.1 — the single
 * byte-accepting endpoint).
 *
 * Branding assets (logos / watermarks) may be exactly `png` | `jpeg` | `webp`
 * | `svg`. The decision is made by the **bytes**, never by the client-supplied
 * file name extension or `Content-Type` header — the contract says the MIME
 * type is "sniffed from magic bytes (not the client header)", and the route
 * integration suite proves a PNG named `.svg` is uploaded as a PNG. These unit
 * pins fix the detection surface the route consumes.
 *
 * U1 — magic-byte detection for each type and a spoofed extension:
 *   - the four accepted formats are recognised from their leading bytes;
 *   - a file whose name/declared type claims a *different* (spoofed) format is
 *     still detected by its bytes;
 *   - bytes that match no branding format are refused.
 */

/** A minimal PNG signature (8-byte magic + a bit of body). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** A minimal JPEG signature (the `FF D8 FF` start-of-image marker). */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

/** A minimal WebP signature (`RIFF` … `WEBP` at offsets 0 and 8). */
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** A text SVG with an XML declaration before the root element. */
const SVG_XML_BYTES = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'
);

/** A bare `<svg>` root with no declaration. */
const SVG_BARE_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>'
);

/** A Windows executable (`MZ`) whose bytes prove nothing about images. */
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);

describe("sniffBrandingFormat", () => {
  it("detects png from its 8-byte magic", () => {
    expect(sniffBrandingFormat(PNG_BYTES)).toBe("png");
  });

  it("detects jpeg from its FF D8 FF start-of-image marker", () => {
    expect(sniffBrandingFormat(JPEG_BYTES)).toBe("jpeg");
  });

  it("detects webp from its RIFF/WEBP structure", () => {
    expect(sniffBrandingFormat(WEBP_BYTES)).toBe("webp");
  });

  it("detects an svg that begins with an XML declaration", () => {
    expect(sniffBrandingFormat(SVG_XML_BYTES)).toBe("svg");
  });

  it("detects a bare <svg> root without a declaration", () => {
    expect(sniffBrandingFormat(SVG_BARE_BYTES)).toBe("svg");
  });

  it("returns null for bytes that match no branding format (an exe)", () => {
    expect(sniffBrandingFormat(EXE_BYTES)).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(sniffBrandingFormat(new Uint8Array())).toBeNull();
  });

  it("returns null for a buffer shorter than any signature", () => {
    expect(sniffBrandingFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("detectBrandingUpload", () => {
  it.each([
    {
      name: "png",
      bytes: PNG_BYTES,
      expected: { format: "png", mimeType: "image/png", extension: "png" },
    },
    {
      name: "jpeg",
      bytes: JPEG_BYTES,
      expected: { format: "jpeg", mimeType: "image/jpeg", extension: "jpg" },
    },
    {
      name: "webp",
      bytes: WEBP_BYTES,
      expected: { format: "webp", mimeType: "image/webp", extension: "webp" },
    },
    {
      name: "svg",
      bytes: SVG_BARE_BYTES,
      expected: { format: "svg", mimeType: "image/svg+xml", extension: "svg" },
    },
  ])(
    "accepts $name bytes and reports its format, MIME type and extension",
    ({ bytes, expected }) => {
      const result = detectBrandingUpload({
        bytes,
        fileName: `logo.${expected.extension}`,
        declaredMimeType: expected.mimeType,
      });
      expect(result).toEqual({ ok: true, ...expected });
    }
  );

  it("U1: a PNG whose file name claims .svg is still detected as PNG (spoofed extension)", () => {
    const result = detectBrandingUpload({
      bytes: PNG_BYTES,
      fileName: "logo.svg",
      declaredMimeType: "image/png",
    });
    expect(result).toEqual({ ok: true, format: "png", mimeType: "image/png", extension: "png" });
  });

  it("an SVG whose file name claims .png is still detected as SVG", () => {
    const result = detectBrandingUpload({
      bytes: SVG_BARE_BYTES,
      fileName: "logo.png",
      declaredMimeType: "image/png",
    });
    expect(result).toEqual({
      ok: true,
      format: "svg",
      mimeType: "image/svg+xml",
      extension: "svg",
    });
  });

  it("does not use the declared Content-Type for acceptance", () => {
    const result = detectBrandingUpload({
      bytes: PNG_BYTES,
      fileName: "logo.bin",
      declaredMimeType: "application/octet-stream",
    });
    expect(result).toEqual({ ok: true, format: "png", mimeType: "image/png", extension: "png" });
  });

  it("refuses bytes that detect to nothing, whatever the file claims", () => {
    const result = detectBrandingUpload({
      bytes: EXE_BYTES,
      fileName: "photo.png",
      declaredMimeType: "image/png",
    });
    expect(result).toEqual({
      ok: false,
      reason: "unsupported_media_type",
      detectedFormat: null,
    });
  });
});
