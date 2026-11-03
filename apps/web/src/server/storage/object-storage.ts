import type { StorageLocationKey } from "./locations";

/**
 * The `ObjectStorage` port (OP-112, ADR-0520 §2 / ADR-0521).
 *
 * Both adapters — `@/server/adapters/memory-object-storage` (e2e) and
 * `@/server/adapters/r2/r2-object-storage` (R2 today, any S3-compatible store
 * tomorrow) — expose **exactly** these methods as own enumerable keys of a
 * plain object, so swapping the provider is "a new adapter plus config"
 * (CONVENTIONS §6.6) and never a change to domain code.
 *
 * The port never names a bucket and never returns an object key in a neutral
 * value (§0.15): the caller addresses objects by a logical `locationKey`
 * (`originals`, `thumbnails`, `exports`, `branding` — §11.2) plus the
 * content-addressed key the key builder minted, and the vendor id (an upload
 * id, an etag) is all that comes back. The presigned envelope is the one
 * thing a client ever handles, and it carries no bucket/`locationKey`/key
 * *field* — the bucket lives in the URL, the key in the pathname.
 */

/** A SigV4-presigned PUT, what a client needs to upload a whole small object. */
export interface PresignedPut {
  readonly method: "PUT";
  readonly url: string;
  /** Headers the client must send with the PUT (currently the content type). */
  readonly headers: Readonly<Record<string, string>>;
  /** Absolute RFC 3339 UTC instant with milliseconds, `now + ttl`. */
  readonly expiresAt: string;
}

/** The id R2 issued for a multipart upload — the *only* multipart handle. */
export interface CreatedMultipart {
  readonly uploadId: string;
}

/**
 * One uploaded part, S3-shaped (OP-112, ADR-0520 §7).
 *
 * Uppy consumes the list verbatim for its resume UI, so the part carries the
 * vendor's exact field names and the `ETag` keeps the quotes R2 sent. The
 * vendor's `LastModified` is deliberately stripped — it is not part of the
 * neutral contract.
 */
export interface UploadedPart {
  readonly PartNumber: number;
  readonly ETag: string;
  readonly Size: number;
}

/** The neutral `ListParts` answer. */
export interface ListedParts {
  readonly parts: readonly UploadedPart[];
  readonly isTruncated: boolean;
  readonly nextPartNumberMarker: number;
}

/**
 * One part a caller acknowledges when completing a multipart upload.
 *
 * The caller only echoes back what `listParts` handed it (its own part number
 * plus the vendor's `ETag`), so the acknowledgement shape is the slim
 * `{ PartNumber, ETag }` — `Size` is the vendor's bookkeeping, not something
 * a client asserts about its own upload.
 */
export interface CompletedPart {
  readonly PartNumber: number;
  readonly ETag: string;
}

/** The neutral `CompleteMultipartUpload` answer. */
export interface CompletedMultipart {
  readonly etag: string;
}

/** The normalized `HeadObject` answer (size/type from the object itself, §5.3). */
export interface ObjectHead {
  readonly bytes: number;
  readonly contentType: string;
  readonly etag: string;
}

/** An inclusive byte range, mirroring S3's `Range: bytes=<start>-<end>`. */
export interface ObjectRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The provider-neutral storage surface.
 *
 * Methods a current lane does not drive may refuse with `AppError(
 * "not_implemented")` — the port is complete for the lanes that follow
 * (multipart signing, aborts, deletes), and each arrives with the tests that
 * pin its behaviour. `getObject`/`getObjectRange` return small-object bytes
 * (`branding`/QR assets); `getObjectStream` is the streaming variant for the
 * same small-object reads.
 */
export interface ObjectStorage {
  presignPut(
    locationKey: StorageLocationKey,
    objectKey: string,
    contentType: string,
    ttlSeconds: number
  ): Promise<PresignedPut>;
  createMultipart(
    locationKey: StorageLocationKey,
    objectKey: string,
    contentType: string
  ): Promise<CreatedMultipart>;
  presignPart(
    locationKey: StorageLocationKey,
    objectKey: string,
    uploadId: string,
    partNumber: number
  ): Promise<unknown>;
  listParts(
    locationKey: StorageLocationKey,
    objectKey: string,
    uploadId: string
  ): Promise<ListedParts>;
  completeMultipart(
    locationKey: StorageLocationKey,
    objectKey: string,
    uploadId: string,
    parts: readonly CompletedPart[]
  ): Promise<CompletedMultipart>;
  abortMultipart(
    locationKey: StorageLocationKey,
    objectKey: string,
    uploadId: string
  ): Promise<unknown>;
  headObject(locationKey: StorageLocationKey, objectKey: string): Promise<ObjectHead>;
  getObjectStream(locationKey: StorageLocationKey, objectKey: string): Promise<unknown>;
  putObject(
    locationKey: StorageLocationKey,
    objectKey: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void>;
  deleteObject(locationKey: StorageLocationKey, objectKey: string): Promise<unknown>;
  getObject(locationKey: StorageLocationKey, objectKey: string): Promise<Uint8Array>;
  getObjectRange(
    locationKey: StorageLocationKey,
    objectKey: string,
    range: ObjectRange
  ): Promise<Uint8Array>;
}
