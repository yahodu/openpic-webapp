import { AppError } from "@/server/http/app-error";

/**
 * The content-addressed object key builder (OP-112, ADR-0520 §4).
 *
 * `mediaAssets.contentHash` *is* the identity: the lowercase hex SHA-256 of
 * the original bytes doubles as the R2 object key, so two uploads of
 * identical bytes address the same object and dedupe without any
 * application-level lookup. This builder is the one place that may turn a
 * caller-supplied hash into a key, and it is **total**: anything that is not
 * a canonical lowercase hex digest, or not one of the known image extensions,
 * is refused instead of being concatenated into a key (a crafted hash is a
 * path-injection vector).
 */

/** A canonical lowercase SHA-256 hex digest — exactly 64 `[0-9a-f]`. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The image extensions the key builder admits (ADR-0520 §4): the user-image
 * vocabulary of the upload type guards plus `svg`, admitted deliberately for
 * `branding` assets (logos are SVG). The raw camera containers the upload
 * guards accept (`cr2`, `cr3`, `nef`, …) are excluded.
 */
const ADMITTED_EXTENSIONS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "svg",
];

/**
 * Build a content-addressed object key under the `images/` prefix.
 *
 * @param contentHash - The lowercase 64-hex SHA-256 of the original bytes.
 * @param extension - One of the admitted image extensions, without a dot.
 * @returns `` `images/${contentHash}.${extension}` ``.
 * @throws {AppError} `bad_request` when either input is outside the contract.
 */
export function buildObjectKey(contentHash: string, extension: string): string {
  if (!SHA256_HEX_PATTERN.test(contentHash)) {
    throw new AppError("bad_request");
  }
  if (!ADMITTED_EXTENSIONS.includes(extension)) {
    throw new AppError("bad_request");
  }
  return `images/${contentHash}.${extension}`;
}
