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

  it("returns null for bytes that match no accepted signature", () => {
    expect(sniffUploadFormat(padded(ascii("GIF89a")))).toBeNull();
  });

  it("does not throw on an empty buffer and detects nothing", () => {
    expect(sniffUploadFormat(new Uint8Array(0))).toBeNull();
  });

  it("does not throw on a truncated buffer shorter than the magic", () => {
    expect(sniffUploadFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
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
