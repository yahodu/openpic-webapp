import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

import { classifyTransportFailure, UpstreamContractError } from "@/server/adapters/transport-error";
import { AppError } from "@/server/http/app-error";
import { bucketForLocation } from "@/server/storage/locations";
import type {
  CompletedMultipart,
  CreatedMultipart,
  ListedParts,
  ObjectHead,
  ObjectStorage,
  PresignedPut,
} from "@/server/storage/object-storage";

/**
 * The R2 object-storage adapter (OP-112, ADR-0520 §7).
 *
 * The only module that speaks R2's S3 dialect. It is built on
 * `@aws-sdk/client-s3` + `s3-request-presigner` with **path-style
 * addressing** (`forcePathStyle: true`): every call and every presigned URL
 * addresses `/bucket/key` on the configured endpoint host, never a
 * virtual-hosted `bucket.endpoint` name. The `locationKey` → bucket map comes
 * from the injected config — the adapter never reads the environment — and is
 * resolved per call through `bucketForLocation`, so an unknown location is a
 * `ConfigError` before any wire traffic.
 *
 * Multipart XML responses are parsed by the SDK and then **validated by Zod**
 * into the neutral port shapes; a response whose shape changed (a part with
 * no `ETag`, an absent upload id) is refused as `UpstreamContractError` — a
 * drift is a code/config fault, never something a retry can fix (ADR-0072).
 *
 * S3-level retries are disabled (`maxAttempts: 1`): an upstream failure is
 * classified once, as a `TransportError` whose `retryable` flag the caller
 * (a dispatch ledger, a job loop) owns — the SDK must not hide a 503 behind
 * its own retry budget and jitter.
 */

/** An explicit config object — the composition root derives it; a spec builds it with zero process env. */
export interface R2ObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  /** The logical location → physical bucket map (§11.2 → deployment detail). */
  readonly buckets: Readonly<Record<string, string>>;
}

/** The neutral `CreateMultipartUpload` shape, validated after SDK XML parsing. */
const createdMultipartSchema = z.object({ uploadId: z.string() });

/** One S3-shaped part — `ETag` required, so a part that lost it is drift. */
const uploadedPartSchema = z.object({
  PartNumber: z.number(),
  ETag: z.string(),
  Size: z.number(),
});

/** The neutral `ListParts` answer. */
const listedPartsSchema = z.object({
  parts: z.array(uploadedPartSchema),
  isTruncated: z.boolean(),
  nextPartNumberMarker: z.number(),
});

/** The neutral `CompleteMultipartUpload` answer. */
const completedMultipartSchema = z.object({ etag: z.string() });

/** The normalized `HeadObject` answer. */
const objectHeadSchema = z.object({
  bytes: z.number(),
  contentType: z.string(),
  etag: z.string(),
});

/** Refuse a response whose shape no longer matches the pinned wire contract. */
function contractViolation(message: string): UpstreamContractError {
  return new UpstreamContractError(message);
}

/** The HTTP status the SDK attached to a thrown service error, if any. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode;
}

/**
 * Build an R2 object-storage adapter.
 *
 * @param config - Endpoint, region, credentials and the location→bucket map.
 * @returns A plain object exposing exactly the `ObjectStorage` port surface.
 */
export function createR2ObjectStorage(config: R2ObjectStorageConfig): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
    maxAttempts: 1,
  });

  /** Resolve the physical bucket for a logical location (throws `ConfigError` before any wire traffic). */
  const bucketFor = (locationKey: string): string => bucketForLocation(locationKey, config.buckets);

  return {
    async presignPut(locationKey, objectKey, contentType, ttlSeconds): Promise<PresignedPut> {
      const bucket = bucketFor(locationKey);
      // `expiresIn` becomes `X-Amz-Expires` verbatim — the caller's TTL, never
      // a constant — and the signature is computed over the endpoint host and
      // the path-style `/bucket/key` target.
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }),
        { expiresIn: ttlSeconds }
      );
      return {
        method: "PUT",
        url,
        headers: { "content-type": contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },

    async createMultipart(locationKey, objectKey, contentType): Promise<CreatedMultipart> {
      const bucket = bucketFor(locationKey);
      const output = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: contentType,
        })
      );
      // The vendor id and nothing else: no bucket, no `locationKey`, no key (§0.15).
      const parsed = createdMultipartSchema.safeParse({ uploadId: output.UploadId });
      if (!parsed.success) {
        throw contractViolation("R2 answered CreateMultipartUpload without an UploadId.");
      }
      return parsed.data;
    },

    presignPart: () => Promise.reject(new AppError("not_implemented")),

    async listParts(locationKey, objectKey, uploadId): Promise<ListedParts> {
      const bucket = bucketFor(locationKey);
      const output = await client.send(
        new ListPartsCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId })
      );
      const parsed = listedPartsSchema.safeParse({
        parts: output.Parts,
        isTruncated: output.IsTruncated,
        // The SDK parses `NextPartNumberMarker` as a numeric string; the
        // neutral contract hands the caller a number. An absent marker
        // becomes `NaN`, which the schema refuses as drift.
        nextPartNumberMarker: Number(output.NextPartNumberMarker),
      });
      if (!parsed.success) {
        throw contractViolation("R2 answered ListParts with a changed part shape.");
      }
      return parsed.data;
    },

    async completeMultipart(locationKey, objectKey, uploadId, parts): Promise<CompletedMultipart> {
      const bucket = bucketFor(locationKey);
      const output = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: [...parts] },
        })
      );
      const parsed = completedMultipartSchema.safeParse({ etag: output.ETag });
      if (!parsed.success) {
        throw contractViolation("R2 answered CompleteMultipartUpload without an ETag.");
      }
      return parsed.data;
    },

    abortMultipart: () => Promise.reject(new AppError("not_implemented")),

    async headObject(locationKey, objectKey): Promise<ObjectHead> {
      const bucket = bucketFor(locationKey);
      try {
        const output = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        // Size and type come from the object itself, never from the client's
        // declaration (§5.3); a missing header normalizes to the neutral
        // shape's "unknown" value.
        const parsed = objectHeadSchema.safeParse({
          bytes: output.ContentLength ?? 0,
          contentType: output.ContentType ?? "",
          etag: output.ETag ?? "",
        });
        if (!parsed.success) {
          throw contractViolation("R2 answered HeadObject with a changed shape.");
        }
        return parsed.data;
      } catch (error) {
        const status = httpStatusOf(error);
        if (status === 404) {
          // The object is absent — the domain `not_found` refusal, never a
          // transport failure, so callers branch on absence not on status.
          throw new AppError("not_found");
        }
        // Anything else is a classified transport failure: a 5xx is
        // retryable, a network error is retryable, a stray 4xx is not.
        throw classifyTransportFailure(status === undefined ? { error } : { status });
      }
    },

    getObjectStream: () => Promise.reject(new AppError("not_implemented")),
    putObject: () => Promise.reject(new AppError("not_implemented")),
    deleteObject: () => Promise.reject(new AppError("not_implemented")),
    getObject: () => Promise.reject(new AppError("not_implemented")),
    getObjectRange: () => Promise.reject(new AppError("not_implemented")),
  };
}
