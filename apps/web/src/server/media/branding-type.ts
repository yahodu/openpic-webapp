/**
 * Branding upload type detection (OP-114, API contract §2.1).
 *
 * Branding assets may be exactly `png` | `jpeg` | `webp` | `svg`, and the
 * decision is made by the **bytes** — never by the client-supplied file name
 * extension or `Content-Type` header. A file whose name claims `.svg` but whose
 * bytes are a PNG is a PNG (the integration suite proves it), and an exe
 * claiming `image/png` is refused. These two functions are the only place the
 * route consults; the detection table maps onto the neutral format/MIME/extension
 * triple the storage layer keys on.
 */

/** The closed vocabulary of branding formats the endpoint accepts. */
export type BrandingFormat = "png" | "jpeg" | "webp" | "svg";

/** The inputs the route supplies — bytes plus the client's (ignored) claims. */
export interface BrandingUploadInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly declaredMimeType: string;
}

/** The accepted-detection answer: the format plus its wire vocabulary. */
export interface DetectedBrandingUpload {
  readonly ok: true;
  readonly format: BrandingFormat;
  readonly mimeType: string;
  readonly extension: string;
}

/** The refusal answer: the bytes match no branding format. */
export interface RefusedBrandingUpload {
  readonly ok: false;
  readonly reason: "unsupported_media_type";
  readonly detectedFormat: null;
}

/** The discriminated result of a branding upload detection. */
export type BrandingUploadResult = DetectedBrandingUpload | RefusedBrandingUpload;

/** The PNG 8-byte magic (`89 50 4E 47 0D 0A 1A 0A`). */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The JPEG start-of-image marker (`FF D8 FF`). */
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

/** The WebP `RIFF` header at offset 0. */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"

/** The WebP `WEBP` header at offset 8. */
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

/** Whitespace bytes admitted before an SVG root (space, tab, LF, CR). */
function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** True when `bytes` starts with exactly `magic` (a known byte sequence). */
function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) {
    return false;
  }
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) {
      return false;
    }
  }
  return true;
}

/** True when the bytes (after leading whitespace) begin an SVG root. */
function hasSvgRoot(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length && isAsciiWhitespace(bytes[index] ?? -1)) {
    index += 1;
  }
  // `<svg` (a bare root) or `<?xml` (a declaration before the root).
  return (
    bytes[index] === 0x3c && // "<"
    ((bytes[index + 1] === 0x73 && bytes[index + 2] === 0x76 && bytes[index + 3] === 0x67) || // "svg"
      (bytes[index + 1] === 0x3f && bytes[index + 2] === 0x78 && bytes[index + 3] === 0x6d)) // "?xm"
  );
}

/**
 * Sniff the branding format from the leading bytes.
 *
 * @param bytes - The uploaded bytes, never empty in practice (guarded anyway).
 * @returns `png` | `jpeg` | `webp` | `svg`, or `null` when no branding format
 *   matches (including a buffer shorter than every signature).
 */
export function sniffBrandingFormat(bytes: Uint8Array): BrandingFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) {
    return "png";
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    return "jpeg";
  }
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes.slice(8), WEBP_MAGIC)) {
    return "webp";
  }
  if (hasSvgRoot(bytes)) {
    return "svg";
  }
  return null;
}

/** The neutral vocabulary per detected format (contract §2.1). */
const FORMAT_INFO: Readonly<Record<BrandingFormat, { mimeType: string; extension: string }>> = {
  png: { mimeType: "image/png", extension: "png" },
  jpeg: { mimeType: "image/jpeg", extension: "jpg" },
  webp: { mimeType: "image/webp", extension: "webp" },
  svg: { mimeType: "image/svg+xml", extension: "svg" },
};

/**
 * Detect a branding upload from its bytes, mapping a sniff onto the neutral
 * format/MIME/extension triple or the uniform refusal.
 *
 * The `fileName` and `declaredMimeType` inputs are part of the signature so the
 * route's full evidence is passed here, but they are deliberately **not
 * consulted** for acceptance — the bytes are the only type evidence.
 *
 * @param input - The uploaded bytes plus the client's name and declared type.
 * @returns `{ ok: true, format, mimeType, extension }` for a detected format,
 *   or `{ ok: false, reason: "unsupported_media_type", detectedFormat: null }`.
 */
export function detectBrandingUpload(input: BrandingUploadInput): BrandingUploadResult {
  const format = sniffBrandingFormat(input.bytes);
  if (format === null) {
    return { ok: false, reason: "unsupported_media_type", detectedFormat: null };
  }
  return { ok: true, format, ...FORMAT_INFO[format] };
}
