import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import { buildObjectKey } from "@/server/storage/object-key";

import { TEST_CONTENT_HASH } from "../factories/storage";

/**
 * U2 — the content-addressed object key builder (OP-112; contract §5.2, §5.4).
 *
 * `mediaAssets.contentHash` *is* the identity: the lowercase hex SHA-256 of the
 * original bytes doubles as the R2 object key, so two uploads of identical bytes
 * address the same object and dedupe without any application-level lookup. The
 * builder is therefore the one place that may turn a caller-supplied hash into a
 * key, and it must be **total**: anything that is not a canonical lowercase hex
 * digest, or not one of the known image extensions, is refused instead of being
 * concatenated into a key (a crafted hash is a path-injection vector).
 */
const HEX_HASH = TEST_CONTENT_HASH;

/** The four-letter alphabet of a SHA-256 digest, for the "not hex" cases. */
const NON_HEX_HASHES: ReadonlyArray<readonly [string, string]> = [
  ["an uppercase digest", HEX_HASH.toUpperCase()],
  ["a digest that is one character short", HEX_HASH.slice(0, 63)],
  ["a digest that is one character long", `${HEX_HASH}0`],
  ["a digest carrying a non-hex letter", `${HEX_HASH.slice(0, 63)}g`],
  ["a digest carrying a path separator", `${HEX_HASH.slice(0, 31)}/${HEX_HASH.slice(32)}`],
  ["a digest with surrounding whitespace", ` ${HEX_HASH} `],
  ["an empty string", ""],
];

/** The known image extensions the key builder admits (contract §5.1.1 + branding SVG). */
const KNOWN_EXTENSIONS = [
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

/** Extensions the builder must refuse. */
const UNKNOWN_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["a non-image type", "exe"],
  ["an image type the upload contract does not accept", "gif"],
  ["an uppercase extension", "JPG"],
  ["an extension with trailing whitespace", "jpg "],
  ["a near-miss extension", "jpeg2"],
  ["an empty extension", ""],
];

/**
 * Run `build` and return the thrown value.
 *
 * @param build - The call under test.
 * @returns The thrown value, or `undefined` when nothing was thrown.
 */
function thrownBy(build: () => unknown): unknown {
  try {
    build();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("object key builder", () => {
  it("U2: builds a content-addressed key under the images prefix", () => {
    expect(buildObjectKey(HEX_HASH, "jpg")).toBe(`images/${HEX_HASH}.jpg`);
  });

  it.each(KNOWN_EXTENSIONS)("U2: accepts the %s extension", (extension) => {
    expect(buildObjectKey(HEX_HASH, extension)).toBe(`images/${HEX_HASH}.${extension}`);
  });

  it.each(NON_HEX_HASHES)("U2: rejects %s", (_label, hash) => {
    const thrown = thrownBy(() => buildObjectKey(hash, "jpg"));

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("bad_request");
  });

  it.each(UNKNOWN_EXTENSIONS)("U2: rejects %s", (_label, extension) => {
    const thrown = thrownBy(() => buildObjectKey(HEX_HASH, extension));

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("bad_request");
  });
});
