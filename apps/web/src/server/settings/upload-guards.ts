import { getLogger } from "@/server/logging";

/**
 * Upload type guards (OP-82 §4, contract §5.1.1 / §5.4 / §A.2,
 * ADR-0009).
 *
 * An upload carries three independent claims about its type: the **fileName
 * extension**, the **declared `Content-Type`**, and the **bytes themselves**.
 * A hostile client controls the first two; only the bytes are evidence. The
 * guard accepts a file only when all three agree and otherwise returns the
 * contract's `415 unsupported_media_type` outcome while signalling that the
 * stored object must be deleted and no metadata written.
 *
 * This module is a pure unit: the caller has already read the first
 * {@link SNIFF_BYTES} bytes of the object it presigned and hands them in, so
 * {@link guardUploadType} accepts synchronously with no I/O. Detection yields a
 * **container** id, not a camera brand — NEF/ARW/DNG are TIFF containers whose
 * brand marker has no fixed offset within the sniff window, so the extension is
 * authoritative for them (ADR-0009 §3).
 */

/** The number of leading bytes the caller must read for detection. */
export const SNIFF_BYTES = 64;

/** The format identifiers the guard understands. */
export type UploadFormatId =
  | "jpeg"
  | "png"
  | "webp"
  | "heic"
  | "avif"
  | "tiff"
  | "cr2"
  | "cr3"
  | "nef"
  | "arw"
  | "dng"
  | "orf"
  | "raf"
  | "rw2";

/**
 * A detected magic-byte container.
 *
 * The container is what the bytes prove; it is a subset of
 * {@link UploadFormatId} because several extensions (NEF/ARW/DNG) share a
 * container without a distinct fixed-offset signature.
 */
export type UploadContainer =
  "jpeg" | "png" | "webp" | "heic" | "avif" | "tiff" | "cr2" | "cr3" | "orf" | "raf" | "rw2";

/** Why an upload was refused. */
export type UploadGuardRejectionReason =
  "unsupported_extension" | "unsupported_media_type" | "type_mismatch" | "unrecognized_format";

/** One accepted format: its ids, claims and magic-byte container. */
export interface UploadFormat {
  /** The canonical format id returned on acceptance. */
  readonly id: UploadFormatId;
  /** The fileName extensions that identify the format (lower-case, dot-prefixed). */
  readonly extensions: readonly string[];
  /** The declared `Content-Type` values that may accompany the format. */
  readonly mimeTypes: readonly string[];
  /** The magic-byte container the format's bytes must sniff to. */
  readonly container: UploadContainer;
}

/**
 * The per-format table (ADR-0009 §1). RAW formats share the `image/tiff` MIME
 * — the contract's own §5.4 example sends a `.NEF` as `image/tiff` — and
 * NEF/ARW/DNG share the `tiff` container because their brand markers live
 * beyond the sniff window.
 */
export const UPLOAD_FORMATS: readonly UploadFormat[] = [
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

/** Every accepted extension, flattened from {@link UPLOAD_FORMATS}. */
export const allowedExtensions: readonly string[] = UPLOAD_FORMATS.flatMap(
  (format) => format.extensions
);

/** Every accepted MIME type, de-duplicated and flattened from {@link UPLOAD_FORMATS}. */
export const allowedMimeTypes: readonly string[] = [
  ...new Set(UPLOAD_FORMATS.flatMap((f) => f.mimeTypes)),
];

/** Extension → format lookup, built once from {@link UPLOAD_FORMATS}. */
const FORMAT_BY_EXTENSION: ReadonlyMap<string, UploadFormat> = new Map(
  UPLOAD_FORMATS.flatMap((format) => format.extensions.map((extension) => [extension, format]))
);

/** The smallest buffer any live signature needs, used to short-circuit sniffing. */
const MIN_SIGNATURE_BYTES = 3;

/** Return whether `bytes` carries `signature` beginning at `offset`. */
function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Detect the ISO Base Media File Format (`ftyp`) brand at bytes 8…12. */
function sniffFtypBrand(bytes: Uint8Array): UploadContainer | null {
  if (!matches(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    return null;
  }
  if (matches(bytes, 8, [0x68, 0x65, 0x69, 0x63])) {
    return "heic"; // "heic"
  }
  if (matches(bytes, 8, [0x61, 0x76, 0x69, 0x66])) {
    return "avif"; // "avif"
  }
  if (matches(bytes, 8, [0x63, 0x72, 0x78, 0x20])) {
    return "cr3"; // "crx "
  }
  return null;
}

/**
 * Sniff the magic-byte container of an upload prefix.
 *
 * Only the bytes a signature actually occupies are required: a 3-byte JPEG
 * prefix already sniffs as `"jpeg"`, while empty or truncated buffers return
 * `null` and never throw. `NEF`, `ARW` and `DNG` bytes sniff as `"tiff"`
 * (ADR-0009 §3).
 *
 * @param bytes - The first bytes of the object, up to {@link SNIFF_BYTES}.
 * @returns The detected container, or `null` when nothing matches.
 */
export function sniffUploadFormat(bytes: Uint8Array): UploadContainer | null {
  if (bytes.length < MIN_SIGNATURE_BYTES) {
    return null;
  }

  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return "webp"; // "RIFF" … "WEBP"
  }

  const brand = sniffFtypBrand(bytes);
  if (brand !== null) {
    return brand;
  }

  // Canon CR2: TIFF-LE header, IFD at 0x10, then the "CR" marker at offset 8.
  if (matches(bytes, 0, [0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52])) {
    return "cr2";
  }
  if (matches(bytes, 0, [0x49, 0x49, 0x52, 0x4f])) {
    return "orf"; // "IIRO"
  }
  if (matches(bytes, 0, [0x4d, 0x4d, 0x4f, 0x52])) {
    return "orf"; // "MMOR"
  }
  if (matches(bytes, 0, [0x49, 0x49, 0x52, 0x53])) {
    return "orf"; // "IIRS"
  }
  if (matches(bytes, 0, [0x49, 0x49, 0x55, 0x00])) {
    return "rw2"; // "IIU\0"
  }
  if (matches(bytes, 0, [0x46, 0x55, 0x4a, 0x49, 0x46, 0x49, 0x4c, 0x4d])) {
    return "raf"; // "FUJIFILM"
  }
  if (matches(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || matches(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "tiff"; // TIFF little- or big-endian
  }

  return null;
}

/** The input to {@link guardUploadType}: the three independent type claims. */
export interface UploadGuardInput {
  /** The first bytes of the object; the caller read {@link SNIFF_BYTES} where available. */
  readonly bytes: Uint8Array;
  /** The client-supplied fileName, whose extension is one of the claims. */
  readonly fileName: string;
  /** The client-supplied `Content-Type`. */
  readonly declaredMimeType: string;
}

/** A file the guard accepted, together with the format it resolved to. */
export interface UploadAccepted {
  readonly ok: true;
  readonly format: UploadFormatId;
}

/**
 * A file the guard refused.
 *
 * The shape is consumed by the upload route without re-deriving policy: it
 * carries the HTTP outcome (`status`/`code`/`details`) and the cleanup signal
 * (`deleteObject` / `persist`).
 */
export interface UploadRejected {
  readonly ok: false;
  /** Always `415` — the contract's `unsupported_media_type` status. */
  readonly status: 415;
  /** Always `unsupported_media_type` (contract §A.2). */
  readonly code: "unsupported_media_type";
  /** Which of the three claims failed. */
  readonly reason: UploadGuardRejectionReason;
  /** The container the bytes sniffed to, or `null` when nothing was detected. */
  readonly detectedFormat: UploadContainer | null;
  /** The `details` payload of `415 unsupported_media_type`. */
  readonly details: { readonly supportedMimeTypes: readonly string[] };
  /** The stored object must be deleted. */
  readonly deleteObject: true;
  /** No mediaAssets/eventImages row may be written. */
  readonly persist: false;
}

/** The discriminated result of {@link guardUploadType}. */
export type UploadGuardResult = UploadAccepted | UploadRejected;

/** Extract the lower-cased extension (including the dot) from a fileName. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/** Build the single rejection shape, logging the refusal for observability. */
function reject(
  reason: UploadGuardRejectionReason,
  detectedFormat: UploadContainer | null
): UploadRejected {
  getLogger().debug("upload.rejected", {
    event: "upload.rejected",
    reason,
    detectedFormat,
  });

  return {
    ok: false,
    status: 415,
    code: "unsupported_media_type",
    reason,
    detectedFormat,
    details: { supportedMimeTypes: allowedMimeTypes },
    deleteObject: true,
    persist: false,
  };
}

/**
 * Guard an upload against its three type claims (ADR-0009 §7).
 *
 * Checks are ordered so the first failure decides the outcome: the extension
 * must be in {@link allowedExtensions} (case-insensitively), the declared MIME
 * must be in {@link allowedMimeTypes}, the bytes must sniff to a container, that
 * container must match the extension's format, and the declared MIME must be one
 * of that format's `mimeTypes`. Every failure returns the same `415
 * unsupported_media_type` {@link UploadRejected} with `deleteObject: true` and
 * `persist: false`.
 *
 * @param input - The bytes, fileName and declared `Content-Type`.
 * @returns `{ ok: true, format }` on an agreeing file, else the rejection shape.
 */
export function guardUploadType(input: UploadGuardInput): UploadGuardResult {
  const format = FORMAT_BY_EXTENSION.get(extensionOf(input.fileName));
  if (format === undefined) {
    return reject("unsupported_extension", null);
  }

  if (!allowedMimeTypes.includes(input.declaredMimeType)) {
    return reject("unsupported_media_type", null);
  }

  const detected = sniffUploadFormat(input.bytes);
  if (detected === null) {
    return reject("unrecognized_format", null);
  }

  if (detected !== format.container) {
    return reject("type_mismatch", detected);
  }

  if (!format.mimeTypes.includes(input.declaredMimeType)) {
    return reject("type_mismatch", detected);
  }

  return { ok: true, format: format.id };
}
