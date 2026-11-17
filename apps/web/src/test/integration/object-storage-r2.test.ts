import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createR2ObjectStorage } from "@/server/adapters/r2/r2-object-storage";
import { TransportError, UpstreamContractError } from "@/server/adapters/transport-error";
import { AppError } from "@/server/http/app-error";

import {
  makeR2ObjectStorageConfig,
  STORAGE_PORT_METHODS,
  TEST_CONTENT_HASH,
  TEST_STORAGE_ENDPOINT,
} from "../factories/storage";
import { server } from "./setup";

/**
 * I1–I3 — the R2 object-storage adapter against a mocked S3 API (OP-112).
 *
 * The adapter is the only module that speaks R2's S3 dialect, so every case here
 * drives the **port** and asserts what a caller observes: the bytes on the wire
 * (a path-style `/bucket/key` request, or a presigned URL whose query is the
 * signature), the neutral value returned, and — on drift — the classified
 * failure. Nothing asserts on an SDK object or an adapter internal.
 *
 * The MSW handlers match the URL path only (MSW ignores the query for a string
 * pattern), which is what pins path-style addressing: `?uploads=`,
 * `?uploadId=…` and `partNumber=…` all ride the one `/<bucket>/<key>` path.
 *
 * I1: `CreateMultipartUpload` / `ListParts` / `CompleteMultipartUpload` XML is
 *     parsed into the neutral port shapes, and a response whose shape changed is
 *     refused as `UpstreamContractError` (a drift is a code/config fault, never
 *     something a retry can fix).
 * I2: a presigned `PUT` carries the requested TTL, is a real SigV4 signature over
 *     the host, addresses the mapped bucket, and exposes no bucket name,
 *     `locationKey` or object-key *field* (§0.15).
 * I3: `HeadObject` 404 is the domain `not_found` refusal (not a transport
 *     failure), a 200 is normalized to `{ bytes, contentType, etag }`, and any
 *     other upstream failure is classified as retryable-or-not for the caller.
 */

/** The bucket `originals` resolves to in {@link makeR2ObjectStorageConfig}'s map. */
const ORIGINALS_BUCKET = "bkt-a1";

/** The content-addressed key the lane's builder produces for the fixture hash. */
const OBJECT_KEY = `images/${TEST_CONTENT_HASH}.jpg`;

/** The path-style URL every S3 call for {@link OBJECT_KEY} addresses. */
const OBJECT_URL = `${TEST_STORAGE_ENDPOINT}/${ORIGINALS_BUCKET}/${OBJECT_KEY}`;

/** The upload id the mocked R2 issues and every later call echoes. */
const UPLOAD_ID = "up-1";

const XML_HEADERS = { "content-type": "application/xml" };

/** `CreateMultipartUpload` → `InitiateMultipartUploadResult`. */
const INITIATE_XML = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${OBJECT_KEY}</Key><UploadId>${UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>`;

/** `ListParts` → `ListPartsResult`, two parts already landed, nothing truncated. */
const LIST_PARTS_XML = `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${OBJECT_KEY}</Key><UploadId>${UPLOAD_ID}</UploadId><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>3</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><LastModified>2026-10-25T10:00:00.000Z</LastModified><ETag>"p1-etag"</ETag><Size>5242880</Size></Part><Part><PartNumber>3</PartNumber><LastModified>2026-10-25T10:01:00.000Z</LastModified><ETag>"p3-etag"</ETag><Size>1048576</Size></Part></ListPartsResult>`;

/** The same call, answered by a deployment whose part shape lost its `ETag`. */
const LIST_PARTS_DRIFT_XML = `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${OBJECT_KEY}</Key><UploadId>${UPLOAD_ID}</UploadId><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><Size>5242880</Size></Part></ListPartsResult>`;

/** `CompleteMultipartUpload` → `CompleteMultipartUploadResult`. */
const COMPLETE_XML = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${OBJECT_URL}</Location><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${OBJECT_KEY}</Key><ETag>"c-etag"</ETag></CompleteMultipartUploadResult>`;

/**
 * Read a response header case-insensitively.
 *
 * @param headers - The header bag the port returned.
 * @param name - The lower-case header name to find.
 * @returns The header value, or `undefined` when it is absent.
 */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

describe("R2 object storage adapter (MSW)", () => {
  it("I1: the adapter exposes exactly the ObjectStorage port surface", () => {
    // The same port-completeness contract the memory adapter pins: the R2
    // factory returns a plain object carrying every port method as an own key,
    // so swapping the provider really is "a new adapter plus config" (§6.6).
    expect(Object.keys(createR2ObjectStorage(makeR2ObjectStorageConfig())).sort()).toEqual(
      [...STORAGE_PORT_METHODS].sort()
    );
  });

  it("I1: createMultipart returns the upload id R2 issued for the mapped bucket", async () => {
    // Arrange
    server.use(
      http.post(
        OBJECT_URL,
        () => new HttpResponse(INITIATE_XML, { status: 200, headers: XML_HEADERS })
      )
    );
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const created = await storage.createMultipart("originals", OBJECT_KEY, "image/jpeg");

    // Assert — the multipart handle is the vendor's id and nothing else: no
    // bucket, no `locationKey`, no object key (§0.15).
    expect(created).toEqual({ uploadId: UPLOAD_ID });
    expect(Object.keys(created).sort()).toEqual(["uploadId"]);
  });

  it("I1: listParts returns the parts exactly as the contract's S3-shaped type", async () => {
    // Arrange
    server.use(
      http.get(
        OBJECT_URL,
        () => new HttpResponse(LIST_PARTS_XML, { status: 200, headers: XML_HEADERS })
      )
    );
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const listed = await storage.listParts("originals", OBJECT_KEY, UPLOAD_ID);

    // Assert — Uppy consumes these verbatim, so the ETag keeps the quotes R2
    // sent, and the vendor's own `LastModified` does not leak into the port's
    // `UploadedPart` shape.
    expect(listed.parts).toEqual([
      { PartNumber: 1, ETag: '"p1-etag"', Size: 5242880 },
      { PartNumber: 3, ETag: '"p3-etag"', Size: 1048576 },
    ]);
    expect(listed.isTruncated).toBe(false);
    expect(listed.nextPartNumberMarker).toBe(3);
  });

  it("I1: completeMultipart reports the etag R2 returned", async () => {
    // Arrange
    server.use(
      http.post(
        OBJECT_URL,
        () => new HttpResponse(COMPLETE_XML, { status: 200, headers: XML_HEADERS })
      )
    );
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const completed = await storage.completeMultipart("originals", OBJECT_KEY, UPLOAD_ID, [
      { PartNumber: 1, ETag: '"p1-etag"' },
      { PartNumber: 3, ETag: '"p3-etag"' },
    ]);

    // Assert
    expect(completed).toEqual({ etag: '"c-etag"' });
  });

  it("I1: a ListParts response whose shape changed is an upstream contract violation", async () => {
    // Arrange — a part with no `ETag` is not a part: trusting it would hand Uppy
    // an unusable upload id, so the shape change is refused, not coerced.
    server.use(
      http.get(
        OBJECT_URL,
        () => new HttpResponse(LIST_PARTS_DRIFT_XML, { status: 200, headers: XML_HEADERS })
      )
    );
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const listed = storage.listParts("originals", OBJECT_KEY, UPLOAD_ID);

    // Assert
    await expect(listed).rejects.toBeInstanceOf(UpstreamContractError);
  });

  it("I2: a presigned PUT carries the requested TTL, a host-bound signature and the client's content type", async () => {
    // Arrange
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());
    const before = Date.now();

    // Act
    const presigned = await storage.presignPut("originals", OBJECT_KEY, "image/jpeg", 900);
    const after = Date.now();

    // Assert — the URL is a real SigV4 PUT addressed path-style at the bucket the
    // `originals` location resolved to.
    const url = new URL(presigned.url);
    expect(presigned.method).toBe("PUT");
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(new URL(TEST_STORAGE_ENDPOINT).host);
    expect(url.pathname).toBe(`/${ORIGINALS_BUCKET}/${OBJECT_KEY}`);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect((url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";")).toContain("host");

    // §0.13: an absolute, RFC 3339 UTC instant with milliseconds.
    expect(presigned.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresAtMs = Date.parse(presigned.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 900_000);

    // The envelope the client receives is vendor-neutral: no `bucket`, no
    // `locationKey`, no `objectKey` field (§0.15), only what Uppy PUTs with.
    expect(Object.keys(presigned).sort()).toEqual(["expiresAt", "headers", "method", "url"]);
    expect(headerValue(presigned.headers, "content-type")).toBe("image/jpeg");
  });

  it("I2: the presigned TTL is the caller's, not a constant", async () => {
    // Arrange
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const presigned = await storage.presignPut("originals", OBJECT_KEY, "image/png", 120);

    // Assert
    const url = new URL(presigned.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("I3: a HeadObject 404 is a not_found domain error", async () => {
    // Arrange — the object is gone (an expired multipart upload, a purged asset),
    // so the caller must be able to branch on absence rather than on a status.
    server.use(http.head(OBJECT_URL, () => new HttpResponse(null, { status: 404 })));
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const head = storage.headObject("originals", OBJECT_KEY);

    // Assert
    await expect(head).rejects.toBeInstanceOf(AppError);
    await expect(head).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("I3: a HeadObject answer is normalized to the neutral { bytes, contentType, etag } shape", async () => {
    // Arrange
    server.use(
      http.head(
        OBJECT_URL,
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: {
              "content-length": "2140000",
              "content-type": "image/jpeg",
              etag: '"h-etag"',
            },
          })
      )
    );
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const head = await storage.headObject("originals", OBJECT_KEY);

    // Assert — size and type are read from the object itself, never from what
    // the client declared (§5.3), and no vendor field name survives the port.
    expect(head.bytes).toBe(2_140_000);
    expect(head.contentType).toBe("image/jpeg");
    expect(Object.keys(head).sort()).toEqual(["bytes", "contentType", "etag"]);
  });

  it("I3: an upstream 5xx is a retryable transport failure, never a not_found", async () => {
    // Arrange
    server.use(http.head(OBJECT_URL, () => new HttpResponse(null, { status: 503 })));
    const storage = createR2ObjectStorage(makeR2ObjectStorageConfig());

    // Act
    const head = storage.headObject("originals", OBJECT_KEY);

    // Assert
    await expect(head).rejects.toBeInstanceOf(TransportError);
    await expect(head).rejects.toMatchObject({ retryable: true });
  });
});
