import { describe, expect, it } from "vitest";

import {
  allowedExtensions,
  allowedMimeTypes,
  guardUploadType,
  SNIFF_BYTES,
  sniffUploadFormat,
  UPLOAD_FORMATS,
  type UploadFormatId,
  type UploadGuardResult,
  type UploadRejected,
} from "@/server/settings/upload-guards";

/**
 * Unit contract — the upload type guards (OP-82 §4, `docs/API Contract.md`
 * §5.1.1 / §A.2).
 *
 * An upload carries three independent claims about its type: the **fileName
 * extension**, the **declared `Content-Type`**, and the bytes themselves. A
 * hostile client controls the first two; only the bytes are evidence. The guard
 * therefore accepts a file only when all three agree, and otherwise returns the
 * `415 unsupported_media_type` outcome while signalling that the stored object
 * must be deleted and no metadata written.
 *
 * These specs pin, at the smallest observable surface:
 *
 *   SNIFF_BYTES: 64
 *   allowedExtensions: readonly string[]
 *   allowedMimeTypes: readonly string[]
 *   UPLOAD_FORMATS: readonly {
 *     id: UploadFormatId;
 *     extensions: readonly string[];
 *     mimeTypes: readonly string[];
 *     container: UploadContainer
 *   }[]
 *   sniffUploadFormat(bytes: Uint8Array): UploadContainer | null
 *   guardUploadType(input: {
 *     bytes: Uint8Array;
 *     fileName: string;
 *     declaredMimeType: string
 *   }): UploadGuardResult
 *
 * `guardUploadType` accepts synchronously — the caller has already read the
 * first {@link SNIFF_BYTES} bytes of the object it presigned. The allow-lists
 * are asserted **by literal value**, never derived from the implementation, so
 * a narrowed or widened format table fails the spec instead of passing it.
 */

/**
 * The extensions the guard accepts, pinned by value (card §1 + §4). RAW files
 * are TIFF-container formats whose browser-reported MIME is `image/tiff`, so
 * the extension — not the MIME — is what identifies them (contract §5.4's own
 * `DSC_0422.NEF` example is sent with `"mimeType": "image/tiff"`).
 */
const EXPECTED_EXTENSIONS: readonly string[] = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".avif",
  ".tif",
  ".tiff",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".dng",
  ".orf",
  ".raf",
  ".rw2",
];

/**
 * The MIME types the guard accepts for originals — exactly contract §5.1.1's
 * `supportedMimeTypes` list. RAW formats share `image/tiff` (the contract
 * example sends a `.NEF` as `image/tiff`), so no raw-specific MIME appears.
 */
const EXPECTED_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/tiff",
];

/** The per-format table, pinned by value (card §1). */
const EXPECTED_FORMATS: readonly {
  readonly id: UploadFormatId;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly container: UploadFormatId;
}[] = [
  { id: "jpeg", extensions: [".jpg", ".jpeg"], mimeTypes: ["image/jpeg"], container: "jpeg" },
  { id: "png", extensions: [".png"], mimeTypes: ["image/png"], container: "png" },
  { id: "webp", extensions: [".webp"], mimeTypes: ["image/webp"], container: "webp" },
  {
    id: "heic",
    extensions: [".heic", ".heif"],
    mimeTypes: ["image/heic", "image/heif"],
    container: "heic",
  },
  { id: "avif", extensions: [".avif"], mimeTypes: ["image/avif"], container: "avif" },
  { id: "tiff", extensions: [".tif", ".tiff"], mimeTypes: ["image/tiff"], container: "tiff" },
  { id: "cr2", extensions: [".cr2"], mimeTypes: ["image/tiff"], container: "cr2" },
  { id: "cr3", extensions: [".cr3"], mimeTypes: ["image/tiff"], container: "cr3" },
  { id: "nef", extensions: [".nef"], mimeTypes: ["image/tiff"], container: "tiff" },
  { id: "arw", extensions: [".arw"], mimeTypes: ["image/tiff"], container: "tiff" },
  { id: "dng", extensions: [".dng"], mimeTypes: ["image/tiff"], container: "tiff" },
  { id: "orf", extensions: [".orf"], mimeTypes: ["image/tiff"], container: "orf" },
  { id: "raf", extensions: [".raf"], mimeTypes: ["image/tiff"], container: "raf" },
  { id: "rw2", extensions: [".rw2"], mimeTypes: ["image/tiff"], container: "rw2" },
];

/** The ASCII code points of a short label, for building magic-byte prefixes. */
function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

/** Build a {@link SNIFF_BYTES}-long buffer from a magic-byte prefix, zero-padded. */
function padded(prefix: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(SNIFF_BYTES);
  bytes.set(prefix);
  return bytes;
}

/**
 * Narrow a guard result to its rejection arm, failing the calling test loudly
 * if the guard unexpectedly accepted.
 */
function expectRejected(result: UploadGuardResult): UploadRejected {
  if (result.ok) {
    throw new Error("expected the upload guard to reject, but it accepted");
  }
  return result;
}

/** Sorted copy, so allow-list assertions are order-independent. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

// Representative magic-byte prefixes, one per detectable container.
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [...ascii("RIFF"), 0x00, 0x00, 0x00, 0x00, ...ascii("WEBP")];
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];
const CR2 = [0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, ...ascii("CR"), 0x02, 0x00];
const ORF = [...ascii("IIRO"), 0x08, 0x00, 0x00, 0x00];
const RW2 = [0x49, 0x49, 0x55, 0x00, 0x08, 0x00, 0x00, 0x00];
const RAF = ascii("FUJIFILM");
const HEIC = [0x00, 0x00, 0x00, 0x18, ...ascii("ftyp"), ...ascii("heic")];
const AVIF = [0x00, 0x00, 0x00, 0x1c, ...ascii("ftyp"), ...ascii("avif")];
const CR3 = [0x00, 0x00, 0x00, 0x18, ...ascii("ftyp"), ...ascii("crx ")];

// Alternative real-world prefixes for containers already pinned above: the same
// container reached through a different (still valid) magic. Big-endian TIFF is
// the `MM 00 2A` byte order of the pinned little-endian TIFF; Olympus ORF files
// may carry `MMOR` or `IIRS` as their first four bytes instead of `IIRO`.
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08, 0x00, 0x00];
const ORF_MM = [...ascii("MMOR"), 0x00, 0x08, 0x00, 0x00];
const ORF_IIRS = [...ascii("IIRS"), 0x00, 0x08, 0x00, 0x00];

/** The magic-byte prefix that must sniff to each detectable container. */
const MAGIC: readonly { readonly format: UploadFormatId; readonly prefix: readonly number[] }[] = [
  { format: "jpeg", prefix: JPEG },
  { format: "png", prefix: PNG },
  { format: "webp", prefix: WEBP },
  { format: "heic", prefix: HEIC },
  { format: "avif", prefix: AVIF },
  { format: "tiff", prefix: TIFF_LE },
  { format: "cr2", prefix: CR2 },
  { format: "cr3", prefix: CR3 },
  { format: "orf", prefix: ORF },
  { format: "raf", prefix: RAF },
  { format: "rw2", prefix: RW2 },
];

/**
 * Alternative real-world magic-byte prefixes that must sniff to the **same
 * container** as their pinned representative in {@link MAGIC} (card §1, §2).
 *
 * A big-endian TIFF (`MM 00 2A …`) is the same container as the pinned
 * little-endian TIFF (ADR-0010 §2), and Olympus ORF files legitimately carry
 * `MMOR` or `IIRS` instead of the pinned `IIRO` (ADR-0009 §3). Pinning each
 * variant by value stops a future narrowing of the sniff table from silently
 * refusing a format the allow-list accepts.
 */
const MAGIC_VARIANTS: readonly {
  readonly label: string;
  readonly container: UploadFormatId;
  readonly prefix: readonly number[];
}[] = [
  { label: "big-endian TIFF", container: "tiff", prefix: TIFF_BE },
  { label: "Olympus ORF MMOR", container: "orf", prefix: ORF_MM },
  { label: "Olympus ORF IIRS", container: "orf", prefix: ORF_IIRS },
];

/**
 * The HEIF `ftyp` **major brands** real Apple/Android `.heic`/`.heif` files
 * carry, pinned by value (card §1). `heic` is already covered by {@link MAGIC};
 * the rest are the broadening this spec pins. Detection must map every one of
 * them to the `heic` container.
 */
const HEIF_MAJOR_BRANDS: readonly string[] = ["heic", "heix", "hevc", "hevx", "msf1", "mif1"];

/**
 * The AVIF `ftyp` **major brands**: `avif` for still images and `avis` for AVIF
 * image sequences, pinned by value (card §2). Both must map to the `avif`
 * container.
 */
const AVIF_MAJOR_BRANDS: readonly string[] = ["avif", "avis"];

/**
 * ISO-BMFF `ftyp` major brands that are **not** recognised as HEIF/AVIF/CR3
 * (card §3). A box carrying one of these is not an accepted image, so detection
 * must return `null` and the guard must reject it as `unrecognized_format`
 * rather than guessing a container from the surrounding bytes (fail-closed).
 */
const UNRECOGNIZED_FTYP_BRANDS: readonly string[] = ["mp42", "isom"];

/**
 * Build a {@link SNIFF_BYTES}-agnostic ISO-BMFF `ftyp` prefix whose **major
 * brand** is `brand` at bytes 8…12 — the bytes a real HEIF/AVIF file carries.
 *
 * @param brand - The four-character major brand (e.g. `"heix"`, `"avis"`).
 * @returns The magic-byte prefix (`size` + `"ftyp"` + brand).
 */
function ftyp(brand: string): number[] {
  return [0x00, 0x00, 0x00, 0x18, ...ascii("ftyp"), ...ascii(brand)];
}

describe("upload format allow-lists", () => {
  it("exposes exactly the allowed extensions, asserted by value", () => {
    expect(sorted(allowedExtensions)).toEqual(sorted(EXPECTED_EXTENSIONS));
  });

  it("exposes exactly the contract §5.1.1 MIME types, asserted by value", () => {
    expect(sorted(allowedMimeTypes)).toEqual(sorted(EXPECTED_MIME_TYPES));
  });

  it("maps each format to its extensions, MIME types and magic container", () => {
    const actual = UPLOAD_FORMATS.map((format) => ({
      id: format.id,
      extensions: sorted(format.extensions),
      mimeTypes: sorted(format.mimeTypes),
      container: format.container,
    }));
    const expected = EXPECTED_FORMATS.map((format) => ({
      id: format.id,
      extensions: sorted(format.extensions),
      mimeTypes: sorted(format.mimeTypes),
      container: format.container,
    }));

    expect([...actual].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...expected].sort((a, b) => a.id.localeCompare(b.id))
    );
  });

  it("sniffs the documented 64-byte window", () => {
    expect(SNIFF_BYTES).toBe(64);
  });
});

describe("magic-byte sniffing", () => {
  it.each(MAGIC)("detects a $format header as $format", ({ format, prefix }) => {
    expect(sniffUploadFormat(padded(prefix))).toBe(format);
  });

  it.each(MAGIC_VARIANTS)("sniffs the $label variant as $container", ({ container, prefix }) => {
    expect(sniffUploadFormat(padded(prefix))).toBe(container);
  });

  it.each(HEIF_MAJOR_BRANDS)("sniffs the HEIF ftyp major brand %s as heic", (brand) => {
    expect(sniffUploadFormat(padded(ftyp(brand)))).toBe("heic");
  });

  it.each(AVIF_MAJOR_BRANDS)("sniffs the AVIF ftyp major brand %s as avif", (brand) => {
    expect(sniffUploadFormat(padded(ftyp(brand)))).toBe("avif");
  });

  it.each(UNRECOGNIZED_FTYP_BRANDS)(
    "detects nothing for the unrecognized ftyp major brand %s",
    (brand) => {
      expect(sniffUploadFormat(padded(ftyp(brand)))).toBeNull();
    }
  );

  it("returns null for bytes that match no accepted signature", () => {
    expect(sniffUploadFormat(padded(ascii("GIF89a")))).toBeNull();
  });

  it("does not throw on an empty buffer and detects nothing", () => {
    expect(sniffUploadFormat(new Uint8Array(0))).toBeNull();
  });

  it("does not throw on a truncated buffer shorter than the magic", () => {
    expect(sniffUploadFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("detects nothing for a buffer truncated part-way through a longer signature", () => {
    // A 3-byte PNG prefix clears the minimum-length gate but is shorter than the
    // 8-byte PNG magic, so the signature compare must bail out without throwing.
    expect(sniffUploadFormat(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it("detects a complete magic that fits in a buffer shorter than the sniff window", () => {
    expect(sniffUploadFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("jpeg");
  });
});

/** A file the guard must accept, with all three claims agreeing. */
const ACCEPT_CASES: readonly {
  readonly format: UploadFormatId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly prefix: readonly number[];
}[] = [
  { format: "jpeg", fileName: "DSC_0421.JPG", mimeType: "image/jpeg", prefix: JPEG },
  { format: "jpeg", fileName: "photo.jpeg", mimeType: "image/jpeg", prefix: JPEG },
  { format: "png", fileName: "photo.png", mimeType: "image/png", prefix: PNG },
  { format: "webp", fileName: "photo.webp", mimeType: "image/webp", prefix: WEBP },
  { format: "heic", fileName: "photo.heic", mimeType: "image/heic", prefix: HEIC },
  { format: "heic", fileName: "photo.heif", mimeType: "image/heif", prefix: HEIC },
  { format: "avif", fileName: "photo.avif", mimeType: "image/avif", prefix: AVIF },
  { format: "tiff", fileName: "scan.tif", mimeType: "image/tiff", prefix: TIFF_LE },
  { format: "tiff", fileName: "scan.tiff", mimeType: "image/tiff", prefix: TIFF_LE },
  { format: "cr2", fileName: "IMG_0001.CR2", mimeType: "image/tiff", prefix: CR2 },
  { format: "cr3", fileName: "IMG_0002.CR3", mimeType: "image/tiff", prefix: CR3 },
  { format: "nef", fileName: "DSC_0422.NEF", mimeType: "image/tiff", prefix: TIFF_LE },
  { format: "arw", fileName: "DSC_0001.ARW", mimeType: "image/tiff", prefix: TIFF_LE },
  { format: "dng", fileName: "photo.dng", mimeType: "image/tiff", prefix: TIFF_LE },
  { format: "orf", fileName: "photo.orf", mimeType: "image/tiff", prefix: ORF },
  { format: "raf", fileName: "photo.raf", mimeType: "image/tiff", prefix: RAF },
  { format: "rw2", fileName: "photo.rw2", mimeType: "image/tiff", prefix: RW2 },
];

describe("guardUploadType accepts a file whose declarations match its bytes", () => {
  it.each(ACCEPT_CASES)("accepts $fileName declared $mimeType as $format", (testCase) => {
    const result = guardUploadType({
      bytes: padded(testCase.prefix),
      fileName: testCase.fileName,
      declaredMimeType: testCase.mimeType,
    });

    expect(result).toEqual({ ok: true, format: testCase.format });
  });

  it("matches the extension case-insensitively", () => {
    const result = guardUploadType({
      bytes: padded(JPEG),
      fileName: "DSC_0421.JPG",
      declaredMimeType: "image/jpeg",
    });

    expect(result).toEqual({ ok: true, format: "jpeg" });
  });
});

/**
 * A `.heic`/`.heif`/`.avif` file whose bytes carry any of the broad major
 * brands must be accepted end-to-end (card §3): the brand is a detection
 * detail that must not leak into the allow-list decision. Each case pairs a
 * representative extension + declared MIME with one major brand.
 */
const BROAD_BRAND_ACCEPT_CASES: readonly {
  readonly format: UploadFormatId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly brand: string;
}[] = [
  ...HEIF_MAJOR_BRANDS.flatMap((brand) => [
    { format: "heic" as const, fileName: "photo.heic", mimeType: "image/heic", brand },
    { format: "heic" as const, fileName: "photo.heif", mimeType: "image/heif", brand },
  ]),
  ...AVIF_MAJOR_BRANDS.map((brand) => ({
    format: "avif" as const,
    fileName: "photo.avif",
    mimeType: "image/avif",
    brand,
  })),
];

describe("guardUploadType accepts every HEIF/AVIF major brand end-to-end", () => {
  it.each(BROAD_BRAND_ACCEPT_CASES)(
    "accepts $fileName declared $mimeType carrying $brand bytes as $format",
    (testCase) => {
      const result = guardUploadType({
        bytes: padded(ftyp(testCase.brand)),
        fileName: testCase.fileName,
        declaredMimeType: testCase.mimeType,
      });

      expect(result).toEqual({ ok: true, format: testCase.format });
    }
  );
});

/**
 * Alternative real-world magic-byte variants that must be accepted **end-to-end**
 * for an already-allow-listed format (card §1, §2). Each case pairs the format's
 * extension and declared MIME with the variant magic so the three claims agree:
 * a big-endian TIFF must satisfy every TIFF-container extension (`.tif`,
 * `.tiff`, `.nef`, `.arw`, `.dng`), and an `MMOR`/`IIRS` header must satisfy
 * `.orf` (ADR-0010 §2, ADR-0009 §3).
 */
const VARIANT_ACCEPT_CASES: readonly {
  readonly format: UploadFormatId;
  readonly fileName: string;
  readonly mimeType: string;
  readonly prefix: readonly number[];
}[] = [
  { format: "tiff", fileName: "scan-be.tif", mimeType: "image/tiff", prefix: TIFF_BE },
  { format: "tiff", fileName: "scan-be.tiff", mimeType: "image/tiff", prefix: TIFF_BE },
  { format: "nef", fileName: "DSC_0430.NEF", mimeType: "image/tiff", prefix: TIFF_BE },
  { format: "arw", fileName: "DSC_0430.ARW", mimeType: "image/tiff", prefix: TIFF_BE },
  { format: "dng", fileName: "photo-be.dng", mimeType: "image/tiff", prefix: TIFF_BE },
  { format: "orf", fileName: "photo-mm.orf", mimeType: "image/tiff", prefix: ORF_MM },
  { format: "orf", fileName: "photo-iirs.orf", mimeType: "image/tiff", prefix: ORF_IIRS },
];

describe("guardUploadType accepts the alternative TIFF/ORF magic-byte variants", () => {
  it.each(VARIANT_ACCEPT_CASES)(
    "accepts $fileName declared $mimeType carrying the variant bytes as $format",
    (testCase) => {
      const result = guardUploadType({
        bytes: padded(testCase.prefix),
        fileName: testCase.fileName,
        declaredMimeType: testCase.mimeType,
      });

      expect(result).toEqual({ ok: true, format: testCase.format });
    }
  );
});

/** A file whose declared type and/or extension disagrees with its bytes. */
const MISMATCH_CASES: readonly {
  readonly fileName: string;
  readonly mimeType: string;
  readonly prefix: readonly number[];
  readonly detected: UploadFormatId;
}[] = [
  // Bytes are PNG, but the file claims to be a JPEG.
  { fileName: "photo.jpg", mimeType: "image/jpeg", prefix: PNG, detected: "png" },
  // Bytes are JPEG, but the file claims to be a PNG.
  { fileName: "photo.png", mimeType: "image/png", prefix: JPEG, detected: "jpeg" },
  // Extension and MIME disagree with each other.
  { fileName: "photo.jpg", mimeType: "image/png", prefix: JPEG, detected: "jpeg" },
  // Extension and MIME disagree with the declared RAW container.
  { fileName: "photo.nef", mimeType: "image/jpeg", prefix: TIFF_LE, detected: "tiff" },
  // A `.cr2` must carry Canon's "CR" marker, not a bare TIFF header.
  { fileName: "photo.cr2", mimeType: "image/tiff", prefix: TIFF_LE, detected: "tiff" },
];

describe("guardUploadType rejects a declared/detected mismatch with 415", () => {
  it.each(MISMATCH_CASES)(
    "rejects $fileName declared $mimeType against detected $detected",
    (testCase) => {
      const rejected = expectRejected(
        guardUploadType({
          bytes: padded(testCase.prefix),
          fileName: testCase.fileName,
          declaredMimeType: testCase.mimeType,
        })
      );

      expect(rejected.status).toBe(415);
      expect(rejected.code).toBe("unsupported_media_type");
      expect(rejected.reason).toBe("type_mismatch");
      expect(rejected.detectedFormat).toBe(testCase.detected);
    }
  );

  it("returns the exact 415 shape and the delete-and-write-nothing signal", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(PNG),
        fileName: "photo.jpg",
        declaredMimeType: "image/jpeg",
      })
    );

    expect(rejected).toEqual({
      ok: false,
      status: 415,
      code: "unsupported_media_type",
      reason: "type_mismatch",
      detectedFormat: "png",
      details: { supportedMimeTypes: expect.arrayContaining([...EXPECTED_MIME_TYPES]) },
      deleteObject: true,
      persist: false,
    });
    expect(sorted(rejected.details.supportedMimeTypes)).toEqual(sorted(EXPECTED_MIME_TYPES));
  });
});

describe("guardUploadType rejects declarations outside the allow-list", () => {
  it("rejects an unsupported file extension", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(PNG),
        fileName: "photo.gif",
        declaredMimeType: "image/png",
      })
    );

    expect(rejected.reason).toBe("unsupported_extension");
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });

  it("rejects an unsupported declared media type", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(PNG),
        fileName: "photo.png",
        declaredMimeType: "image/gif",
      })
    );

    expect(rejected.reason).toBe("unsupported_media_type");
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });
});

describe("guardUploadType treats a fileName with no extension as unsupported", () => {
  it("rejects a dotless fileName as unsupported_extension with 415", () => {
    // A name with no dot makes `extensionOf` resolve the whole name to the
    // empty-string extension (its `lastIndexOf(".") === -1` branch), so the
    // allow-list lookup misses and the first claim — the extension — decides.
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(PNG),
        fileName: "photo",
        declaredMimeType: "image/png",
      })
    );

    expect(rejected.reason).toBe("unsupported_extension");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.status).toBe(415);
    expect(rejected.code).toBe("unsupported_media_type");
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });
});

describe("guardUploadType rejects an ftyp box with an unrecognized major brand", () => {
  it.each(UNRECOGNIZED_FTYP_BRANDS)(
    "reports unrecognized_format for the %s major brand and signals delete-and-write-nothing",
    (brand) => {
      const rejected = expectRejected(
        guardUploadType({
          bytes: padded(ftyp(brand)),
          fileName: "photo.heic",
          declaredMimeType: "image/heic",
        })
      );

      expect(rejected.status).toBe(415);
      expect(rejected.code).toBe("unsupported_media_type");
      expect(rejected.reason).toBe("unrecognized_format");
      expect(rejected.detectedFormat).toBeNull();
      expect(rejected.deleteObject).toBe(true);
      expect(rejected.persist).toBe(false);
    }
  );
});

describe("guardUploadType reports the first failing claim in ADR-0009 §7 precedence order", () => {
  it("reports unsupported_extension when the extension, MIME and bytes all fail", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(PNG),
        fileName: "photo.gif",
        declaredMimeType: "image/jpeg",
      })
    );

    expect(rejected.reason).toBe("unsupported_extension");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });

  it("reports unsupported_media_type when the extension is allowed but the MIME and bytes fail", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(JPEG),
        fileName: "photo.png",
        declaredMimeType: "image/gif",
      })
    );

    expect(rejected.reason).toBe("unsupported_media_type");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });

  it("still reports unsupported_extension when the extension, MIME and bytes each fail on their own", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: padded(JPEG),
        fileName: "photo.gif",
        declaredMimeType: "image/gif",
      })
    );

    expect(rejected.reason).toBe("unsupported_extension");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });
});

describe("guardUploadType handles short and empty payloads without throwing", () => {
  it("rejects an empty payload as an unrecognized format", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: new Uint8Array(0),
        fileName: "photo.png",
        declaredMimeType: "image/png",
      })
    );

    expect(rejected.reason).toBe("unrecognized_format");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.status).toBe(415);
    expect(rejected.deleteObject).toBe(true);
    expect(rejected.persist).toBe(false);
  });

  it("rejects a truncated payload without throwing", () => {
    const rejected = expectRejected(
      guardUploadType({
        bytes: new Uint8Array([0xff, 0xd8]),
        fileName: "photo.jpg",
        declaredMimeType: "image/jpeg",
      })
    );

    expect(rejected.reason).toBe("unrecognized_format");
    expect(rejected.detectedFormat).toBeNull();
    expect(rejected.deleteObject).toBe(true);
  });
});
