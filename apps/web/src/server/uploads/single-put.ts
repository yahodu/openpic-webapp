import { ObjectId } from "mongodb";

/**
 * The §5.3 single-PUT wire details (OP-124, ADR-0721).
 *
 * The presign TTL is the contract's fixed value — one constant shared by
 * `GET /uploads/config` (§5.1.1) and the `params` presign, so a client never
 * learns a TTL the server does not honour. The object key's extension comes
 * from the session's declared MIME (ADR-0721 A5), the same rule OP-123 uses
 * when it resumes a multipart upload. `batchIdValue` is how a client-generated
 * `batchId` reaches storage.
 */

/** The single-PUT presign lifetime in seconds (contract §5.1). */
export const PRESIGN_TTL_SECONDS = 900;

/** 24-lowercase-hex, the shape of an `ObjectId` on the wire. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The canonical extension for a declared MIME, for the content-addressed key. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

/**
 * The object-key extension for a declared MIME.
 *
 * An unrecognised type falls back to `jpg`: `params` refuses it against the
 * settings allow-list before a key is ever built, so the fallback only keeps
 * the builder total.
 *
 * @param mimeType - The session's declared `mimeType`.
 * @returns The extension without a dot.
 */
export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? "jpg";
}

/**
 * The stored value of a client-generated `batchId`.
 *
 * Schema §16.3 declares `uploadBatchId` as an `ObjectId`, and the contract's
 * examples are 24-hex; a client may also send a UUIDv4 (§5.2 accepts both), so
 * a 24-hex id becomes the `ObjectId` and anything else is kept verbatim rather
 * than refused.
 *
 * shortcut: a non-24-hex batch id is stored as a string (§16.3 says ObjectId);
 * upgrade when the client is constrained to 24-hex ids.
 *
 * @param batchId - The validated client `batchId`.
 * @returns The value to store on the session / event image.
 */
export function batchIdValue(batchId: string): ObjectId | string {
  return OBJECT_ID_PATTERN.test(batchId) ? new ObjectId(batchId) : batchId;
}
