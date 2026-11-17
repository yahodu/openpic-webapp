import { createHash, randomUUID } from "node:crypto";

import { ObjectId, type Document } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

import * as abortRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/[uploadId]/route";
import * as partsRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/[uploadId]/parts/route";
import * as signRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/[uploadId]/parts/[partNumber]/sign/route";
import * as completeRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/[uploadId]/complete/route";
import * as createRouteModule from "@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/route";
import * as configRouteModule from "@/app/api/v1/uploads/config/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import type { Entitlement } from "@/server/plans/plans";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeSubscription } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { TEST_STORAGE_BUCKETS, TEST_STORAGE_ENDPOINT } from "../factories/storage";
import { body } from "../helpers/auth-requests";
import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { fixtureInstant } from "../helpers/fixture-clock";
import { server } from "./setup";

/**
 * Integration / contract — the multipart upload endpoints behind Uppy's
 * `@uppy/aws-s3` hooks (OP-125 I1–I7, contract §5.4, schema §16.1–§16.3;
 * ADR-0740).
 *
 * The user story: *as an uploader, I want resumable multipart uploads for large
 * files so that 100 MB photos survive flaky networks.* Six endpoints map 1:1
 * onto Uppy's hooks; Companion is never run, and bytes never transit this
 * control plane.
 *
 * | Uppy hook                 | Endpoint                                                       | Answer                       |
 * | ------------------------- | -------------------------------------------------------------- | ---------------------------- |
 * | `createMultipartUpload`   | `POST …/events/{e}/uploads/multipart`                          | `201` create answer          |
 * | `listParts`               | `GET …/uploads/multipart/{uploadId}/parts?key=`                | `200 { parts }`              |
 * | `signPart`                | `GET …/uploads/multipart/{uploadId}/parts/{n}/sign?key=`       | `200 { url, expiresAt }`     |
 * | `completeMultipartUpload` | `POST …/uploads/multipart/{uploadId}/complete`                 | `201` EventImage DTO         |
 * | `abortMultipartUpload`    | `DELETE …/uploads/multipart/{uploadId}?key=`                   | `204`                        |
 * | `getUploadParameters`     | `POST …/events/{e}/uploads/params` (OP-124)                    | `201` presigned single PUT   |
 *
 * ## Contract expected of the implementation
 *
 * - The five route modules above exist under `apps/web/src/app/api/v1/tenants/
 *   [tenantId]/events/[eventId]/uploads/multipart/…` and export `POST`, `GET`
 *   (twice), `POST` and `DELETE` respectively, declared through `defineRoute`
 *   with the contract's tenant-scoped templates. The event id sits **three**
 *   segments from the end on `…/uploads/multipart` (create), **four** on
 *   `…/multipart/{uploadId}/parts`, `…/multipart/{uploadId}/complete` and
 *   `…/multipart/{uploadId}` (abort), and **six** on
 *   `…/multipart/{uploadId}/parts/{n}/sign`, so the shared admission is
 *   `eventActorAdmission(3)` / `eventActorAdmission(4)` /
 *   `eventActorAdmission(6)`.
 * - `create` answers **exactly** `{ uploadSessionId, uploadId, key,
 *   partSizeBytes, partCount, resumed }` (§5.4). `key` is an **opaque
 *   server-issued handle** — it is never the object key and never contains the
 *   content hash (§0.15) — and `partSizeBytes` is the same value
 *   `GET /uploads/config` publishes (§5.1.1).
 * - The session upserted by `create` is `mode: "multipart"`, `status:
 *   "pending"`, carries the provider's multipart id in
 *   `externalRefs[{ kind: "multipart_upload", id }]` (schema §11.1/§16.2 —
 *   never a vendor-named field) and keeps the schema's five-day `expireAt`.
 * - `listParts` answers `{ parts: [{ PartNumber, ETag, Size }] }` — S3-shaped
 *   keys, because Uppy consumes them verbatim — and the parts are the
 *   provider's live view (there is no part-tracking collection, schema §16.2).
 * - `sign` answers `{ url, expiresAt }`; the URL is a presigned **part** PUT
 *   and the request is never logged (§5.4, security-and-logging note).
 * - `complete` takes `{ key, parts }`, requires the idempotency stage, calls
 *   `CompleteMultipartUpload` and then the **same** registration transaction
 *   as OP-124: `HeadObject`/parts total → consume `storage.bytes` +
 *   `images.per_event` → upsert `media_assets` (`refCount` 1) → insert
 *   `event_images` with the event's next `sequence` → advance the event
 *   counters → session `completed` with its `assetId` → enqueue the pipeline
 *   work item after the commit. `201` returns the `EventImage` DTO.
 * - A **missing** part is `409 parts_missing` with
 *   `details.missingPartNumbers` (§5.4) and writes nothing.
 * - A provider that has already aborted the series (the 7-day lifecycle rule)
 *   answers `409 upload_expired`, so the client restarts from `batch-resolve`.
 * - Any handle that does not prove ownership of the addressed session is
 *   `404 not_found` — never `400`, never an oracle.
 * - Attendance is re-evaluated **per call**: a co-organizer removed from the
 *   event mid-upload cannot sign or complete (§0.4).
 *
 * ## Storage is the source of truth (and the MSW surface)
 *
 * The suite boots `STORAGE_PROVIDER=s3` pointed at MSW, so every multipart call
 * goes through the real R2 adapter (path-style `/<bucket>/<key>`). The mock
 * answers `CreateMultipartUpload` (`POST ?uploads`), `ListParts` (`GET
 * ?uploadId`), the presigned part `PUT`, `CompleteMultipartUpload` (`POST
 * ?uploadId`), `AbortMultipartUpload` (`DELETE ?uploadId`), `HeadObject` and a
 * ranged `GetObject`. A part is only accepted when the client `PUT`s it to a
 * URL the sign endpoint minted, which is what makes the signed URL
 * load-bearing rather than decorative.
 *
 * ## Assumptions (ADR-0740 §Assumptions)
 *
 * - A1 — the create endpoint does **not** require an idempotency key: §5.4
 *   marks only `complete` as "Idempotency required", and a resume deliberately
 *   repeats the create with `existingUploadId`.
 * - A2 — `partSizeBytes` is the contract's fixed 8 388 608 (§5.1), the value
 *   `GET /uploads/config` already publishes; the count is
 *   `ceil(size / partSizeBytes)`.
 * - A3 — `409 parts_missing` and `409 upload_expired` are **new** media error
 *   codes the GREEN owes the contracts union and the catalogue in the
 *   append-only per-domain shape ADR-0540/ADR-0701/ADR-0721 established.
 * - A4 — the recorded `media_assets.storage.bytes` is the size of the assembled
 *   object (the sum of the uploaded parts); the spec learns it from the mock,
 *   so an implementation may read it from `HeadObject` or from `ListParts`.
 * - A5 — `resumed: true` means "the provider's `CreateMultipartUpload` was
 *   **not** called": the spec counts the upstream call, not a Mongo field.
 * - A6 — the memory adapter's multipart methods are out of scope (no e2e card
 *   in this lane); this suite drives the R2 adapter over MSW.
 */

/** The collection the schema calls `uploadSessions` (§16.2). */
const UPLOAD_SESSIONS = COLLECTIONS.uploadSessions;

/** The bucket `originals` resolves to in the storage runtime wiring. */
const ORIGINALS_BUCKET = TEST_STORAGE_BUCKETS.originals ?? "bkt-a1";

/** The contract's fixed part size (§5.1). */
const PART_SIZE_BYTES = 8_388_608;

/** The presign TTL the sign endpoint must honour (§5.1). */
const PRESIGN_TTL_SECONDS = 900;

/** Three full parts — the card's "sign ×3". */
const THREE_PARTS_BYTES = 3 * PART_SIZE_BYTES;

/** One full part. */
const ONE_PART_BYTES = PART_SIZE_BYTES;

/** The session TTL the schema fixes at five days. */
const SESSION_TTL_MS = 5 * 86_400_000;

/** A deterministic lowercase hex SHA-256 for a named scenario. */
function hashFor(name: string): string {
  return createHash("sha256").update(`op125-${name}`).digest("hex");
}

const HASH_HAPPY = hashFor("happy");
const HASH_RESUME = hashFor("resume");
const HASH_MISSING_PART = hashFor("missing-part");
const HASH_EXPIRED = hashFor("expired");
const HASH_OTHER_USER = hashFor("other-user");
const HASH_ABORT = hashFor("abort");
const HASH_REMOVED = hashFor("removed");
const HASH_CLOSED = hashFor("closed-window");
const HASH_LOG = hashFor("logged-url");
const HASH_CROSS_SESSION = hashFor("cross-session");
const HASH_SECOND_SESSION = hashFor("second-session");
const HASH_OUTSIDER = hashFor("outsider");

/** A JPEG magic prefix — `FF D8 FF`, so the completion's sniff accepts the object. */
const JPEG_PREFIX = [0xff, 0xd8, 0xff] as const;

/** Build a deterministic part body that starts with `prefix`. */
function makePart(size: number, prefix: readonly number[] = []): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix, 0);
  // A non-zero filler, so a truncated or wrongly ordered part cannot pass by
  // being indistinguishable from an uninitialised buffer.
  bytes.fill(0x5a, prefix.length);
  return bytes;
}

/** One part the mock storage holds for an in-flight upload. */
interface MockPart {
  readonly etag: string;
  readonly size: number;
  readonly bytes: Uint8Array | null;
}

/** One in-flight multipart upload the mock storage issued an id for. */
interface MockUpload {
  readonly objectKey: string;
  readonly contentType: string;
  readonly parts: Map<number, MockPart>;
}

/** One assembled object the mock storage holds. */
interface MockObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** The in-flight uploads, keyed by the vendor upload id. */
const liveUploads = new Map<string, MockUpload>();

/** The assembled objects, keyed by object key. */
const storedObjects = new Map<string, MockObject>();

/** Upstream call counters, so "no new Create call" is an observable. */
let initiateCalls = 0;
let completeCalls = 0;
let abortCalls = 0;

/** The path every content-addressed original is addressed by. */
const OBJECT_PATH = new RegExp(`/${ORIGINALS_BUCKET}/images/[0-9a-f]{64}\\.[a-z]+`);

/** The object key of the URL a request / presigned URL addresses. */
function objectKeyOf(request: Request): string {
  return new URL(request.url).pathname.split("/").slice(2).join("/");
}

/** The object key of a content hash in the originals bucket. */
function objectKeyFor(contentHash: string): string {
  return `images/${contentHash}.jpg`;
}

const XML_HEADERS = { "content-type": "application/xml" };

/** `CreateMultipartUpload` → `InitiateMultipartUploadResult`. */
function initiateXml(uploadId: string, objectKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${objectKey}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
}

/** `ListParts` → `ListPartsResult`, every part the mock holds. */
function listPartsXml(
  uploadId: string,
  objectKey: string,
  parts: readonly (readonly [number, MockPart])[]
): string {
  const rendered = parts
    .map(
      ([partNumber, part]) =>
        `<Part><PartNumber>${String(partNumber)}</PartNumber><LastModified>2026-09-25T09:00:00.000Z</LastModified><ETag>${part.etag}</ETag><Size>${String(part.size)}</Size></Part>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${objectKey}</Key><UploadId>${uploadId}</UploadId><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>${String(parts.length)}</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${rendered}</ListPartsResult>`;
}

/** `CompleteMultipartUpload` → `CompleteMultipartUploadResult`. */
function completeXml(objectKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${TEST_STORAGE_ENDPOINT}/${ORIGINALS_BUCKET}/${objectKey}</Location><Bucket>${ORIGINALS_BUCKET}</Bucket><Key>${objectKey}</Key><ETag>"completed-etag"</ETag></CompleteMultipartUploadResult>`;
}

/** The provider's "this multipart series does not exist" refusal. */
function noSuchUpload(): Response {
  return new HttpResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchUpload</Code><Message>The specified upload does not exist.</Message><RequestId>op125</RequestId><HostId>op125</HostId></Error>`,
    { status: 404, headers: XML_HEADERS }
  );
}

/** Assemble the parts an acknowledged `CompleteMultipartUpload` names. */
function assemble(partNumbers: readonly number[], upload: MockUpload): Uint8Array {
  const chunks = partNumbers.map((partNumber) => upload.parts.get(partNumber)?.bytes ?? null);
  const total = chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0);
  const composed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk !== null) {
      composed.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return composed;
}

/** Install the mocked S3 multipart surface. */
function installStorageMock(): void {
  server.use(
    http.post(OBJECT_PATH, async ({ request }) => {
      const url = new URL(request.url);
      const objectKey = objectKeyOf(request);
      const uploadId = url.searchParams.get("uploadId");
      if (uploadId === null) {
        initiateCalls += 1;
        const minted = `up-${String(initiateCalls)}`;
        liveUploads.set(minted, {
          objectKey,
          contentType: request.headers.get("content-type") ?? "image/jpeg",
          parts: new Map(),
        });
        return new HttpResponse(initiateXml(minted, objectKey), {
          status: 200,
          headers: XML_HEADERS,
        });
      }

      completeCalls += 1;
      const upload = liveUploads.get(uploadId);
      if (upload === undefined) {
        return noSuchUpload();
      }
      const bodyText = await request.text();
      const partNumbers = Array.from(
        bodyText.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
        (match) => Number(match[1] ?? "0")
      );
      const composed = assemble(partNumbers, upload);
      storedObjects.set(upload.objectKey, { bytes: composed, contentType: upload.contentType });
      liveUploads.delete(uploadId);
      return new HttpResponse(completeXml(upload.objectKey), {
        status: 200,
        headers: XML_HEADERS,
      });
    }),

    http.put(OBJECT_PATH, async ({ request }) => {
      const url = new URL(request.url);
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("partNumber"));
      const upload = uploadId === null ? undefined : liveUploads.get(uploadId);
      if (upload === undefined) {
        return noSuchUpload();
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const etag = `"p${String(partNumber)}-etag"`;
      upload.parts.set(partNumber, { etag, size: bytes.byteLength, bytes });
      return new HttpResponse(null, { status: 200, headers: { etag } });
    }),

    http.get(OBJECT_PATH, ({ request }) => {
      const url = new URL(request.url);
      const objectKey = objectKeyOf(request);
      const uploadId = url.searchParams.get("uploadId");
      if (uploadId !== null) {
        const upload = liveUploads.get(uploadId);
        if (upload === undefined) {
          return noSuchUpload();
        }
        const parts = [...upload.parts.entries()].sort(([left], [right]) => left - right);
        return new HttpResponse(listPartsXml(uploadId, upload.objectKey, parts), {
          status: 200,
          headers: XML_HEADERS,
        });
      }

      const object = storedObjects.get(objectKey);
      if (object === undefined) {
        return new HttpResponse(null, { status: 404 });
      }
      const range = request.headers.get("range");
      const parsed = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = parsed === null ? 0 : Number(parsed[1] ?? "0");
      const end =
        parsed === null
          ? object.bytes.byteLength - 1
          : Math.min(Number(parsed[2] ?? "0"), object.bytes.byteLength - 1);
      const slice = object.bytes.slice(start, end + 1);
      return new HttpResponse(slice, {
        status: parsed === null ? 200 : 206,
        headers: {
          "content-length": String(slice.byteLength),
          "content-type": object.contentType,
          etag: '"completed-etag"',
        },
      });
    }),

    http.head(OBJECT_PATH, ({ request }) => {
      const object = storedObjects.get(objectKeyOf(request));
      if (object === undefined) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(null, {
        status: 200,
        headers: {
          "content-length": String(object.bytes.byteLength),
          "content-type": object.contentType,
          etag: '"completed-etag"',
        },
      });
    }),

    http.delete(OBJECT_PATH, ({ request }) => {
      const url = new URL(request.url);
      const uploadId = url.searchParams.get("uploadId");
      if (uploadId !== null) {
        abortCalls += 1;
        liveUploads.delete(uploadId);
        return new HttpResponse(null, { status: 204 });
      }
      storedObjects.delete(objectKeyOf(request));
      return new HttpResponse(null, { status: 204 });
    })
  );
}

/** Record a part the mock holds without a byte body (a resume or a gap case). */
function recordPart(uploadId: string, partNumber: number, size: number): string {
  const upload = liveUploads.get(uploadId);
  if (upload === undefined) {
    throw new Error(`expected the mocked storage to hold upload ${uploadId}`);
  }
  const etag = `"p${String(partNumber)}-etag"`;
  upload.parts.set(partNumber, { etag, size, bytes: null });
  return etag;
}

/** Forget an in-flight upload, as the provider's abort lifecycle rule does. */
function forgetUpload(uploadId: string): void {
  liveUploads.delete(uploadId);
}

let app: TestApp;

/** The log sink the suite reads, so a pin can assert what was never logged. */
let logSink: MemoryTransport;

beforeAll(async () => {
  app = await startTestApp({
    prefix: "op125-multipart",
    env: {
      STORAGE_PROVIDER: "s3",
      QUEUE_PROVIDER: "memory",
      R2_ENDPOINT: TEST_STORAGE_ENDPOINT,
      R2_REGION: "auto",
      R2_ACCESS_KEY_ID: "op125-test-access-key",
      R2_SECRET_ACCESS_KEY: "op125-test-secret-key",
      R2_BUCKET_ORIGINALS: TEST_STORAGE_BUCKETS.originals,
      R2_BUCKET_THUMBNAILS: TEST_STORAGE_BUCKETS.thumbnails,
      R2_BUCKET_EXPORTS: TEST_STORAGE_BUCKETS.exports,
      R2_BUCKET_BRANDING: TEST_STORAGE_BUCKETS.branding,
    },
  });
  await ensureIndexes(app.db);
  logSink = memoryTransport();
  setLogger(
    createLogger({ level: "trace", transports: [logSink], service: "openpic-web", env: "test" })
  );
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [
    COLLECTIONS.tenants,
    COLLECTIONS.tenantMembers,
    COLLECTIONS.userProfiles,
    COLLECTIONS.events,
    COLLECTIONS.eventOrganizers,
    COLLECTIONS.mediaAssets,
    COLLECTIONS.eventImages,
    COLLECTIONS.plans,
    COLLECTIONS.subscriptions,
    COLLECTIONS.usageCounters,
    COLLECTIONS.entitlementGrants,
    COLLECTIONS.domainEvents,
    UPLOAD_SESSIONS,
    "platformSettings",
  ]) {
    await app.db.collection(name).deleteMany({});
  }
  invalidatePlatformSettings();
  liveUploads.clear();
  storedObjects.clear();
  initiateCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  logSink.clear();
  installStorageMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The handler names each module must export. */
type HandlerName = "GET" | "POST" | "DELETE";

/** Read one route export off a namespace, failing with a naming message. */
function requireHandler(
  module: object,
  name: HandlerName,
  path: string
): (request: Request) => Promise<Response> {
  const handler = (module as Record<string, unknown>)[name];
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as (request: Request) => Promise<Response>;
}

const createUpload = requireHandler(
  createRouteModule,
  "POST",
  "…/events/:eventId/uploads/multipart"
);
const listParts = requireHandler(
  partsRouteModule,
  "GET",
  "…/events/:eventId/uploads/multipart/:uploadId/parts"
);
const signPart = requireHandler(
  signRouteModule,
  "GET",
  "…/events/:eventId/uploads/multipart/:uploadId/parts/:partNumber/sign"
);
const completeUpload = requireHandler(
  completeRouteModule,
  "POST",
  "…/events/:eventId/uploads/multipart/:uploadId/complete"
);
const abortUpload = requireHandler(
  abortRouteModule,
  "DELETE",
  "…/events/:eventId/uploads/multipart/:uploadId"
);
const uploadConfig = requireHandler(configRouteModule, "GET", "/api/v1/uploads/config");

/** A fresh UUIDv4 for the idempotency header. */
function idempotencyKey(): string {
  return randomUUID();
}

/** A `batchId` in the 24-hex shape the contract accepts. */
function batchId(): string {
  return new ObjectId().toHexString();
}

/** The §5.4 `create` body for one file. */
interface CreateBody {
  readonly batchId: string;
  readonly hash: string;
  readonly size: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly existingUploadId?: string;
}

/** A `create` claim for one file, with the extension and MIME in agreement. */
function claimFor(hash: string, overrides: Partial<CreateBody> = {}): CreateBody {
  return {
    batchId: batchId(),
    hash,
    size: THREE_PARTS_BYTES,
    fileName: "DSC_0422.JPG",
    mimeType: "image/jpeg",
    ...overrides,
  };
}

/** A JSON `POST` carrying the caller's session cookie. */
function jsonPost(path: string, cookie: string, payload: unknown, key?: string): Request {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (key !== undefined) {
    headers["idempotency-key"] = key;
  }
  return new Request(new URL(path, APP_ORIGIN), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

/** A `GET` carrying the caller's session cookie. */
function cookieGet(path: string, cookie: string): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "GET", headers: { cookie } });
}

/** A `DELETE` carrying the caller's session cookie. */
function cookieDelete(path: string, cookie: string): Request {
  return new Request(new URL(path, APP_ORIGIN), { method: "DELETE", headers: { cookie } });
}

/** The multipart base path of one event. */
function multipartPath(tenantKey: string, eventId: ObjectId): string {
  return `/api/v1/tenants/${tenantKey}/events/${eventId.toHexString()}/uploads/multipart`;
}

/** The `create` request for one claim. */
function createRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  claim: CreateBody
): Request {
  return jsonPost(multipartPath(tenantKey, eventId), cookie, claim);
}

/** The `listParts` request, with the create answer's opaque handle. */
function listPartsRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  uploadId: string,
  key: string
): Request {
  return cookieGet(
    `${multipartPath(tenantKey, eventId)}/${uploadId}/parts?key=${encodeURIComponent(key)}`,
    cookie
  );
}

/** The `signPart` request for one part number. */
function signRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  uploadId: string,
  partNumber: number,
  key: string
): Request {
  return cookieGet(
    `${multipartPath(tenantKey, eventId)}/${uploadId}/parts/${String(partNumber)}/sign?key=${encodeURIComponent(key)}`,
    cookie
  );
}

/** One part acknowledgement, as Uppy echoes it back. */
interface PartAcknowledgement {
  readonly PartNumber: number;
  readonly ETag: string;
}

/** The `complete` request for one upload. */
function completeRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  uploadId: string,
  payload: { readonly key: string; readonly parts: readonly PartAcknowledgement[] },
  key: string = idempotencyKey()
): Request {
  return jsonPost(
    `${multipartPath(tenantKey, eventId)}/${uploadId}/complete`,
    cookie,
    payload,
    key
  );
}

/** The `abort` request for one upload. */
function abortRequest(
  cookie: string,
  tenantKey: string,
  eventId: ObjectId,
  uploadId: string,
  key: string
): Request {
  return cookieDelete(
    `${multipartPath(tenantKey, eventId)}/${uploadId}?key=${encodeURIComponent(key)}`,
    cookie
  );
}

/** The error envelope of a failed response. */
interface ErrorBody {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

/** Parse an error envelope without reading the body twice. */
async function errorOf(response: Response): Promise<ErrorBody> {
  const parsed = await body(response);
  return parsed.error as ErrorBody;
}

/** The §5.4 create answer. */
interface CreateAnswer {
  readonly uploadSessionId: string;
  readonly uploadId: string;
  readonly key: string;
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly resumed: boolean;
}

/** The §5.4 `listParts` answer. */
interface ListedPartsAnswer {
  readonly parts: readonly {
    readonly PartNumber: number;
    readonly ETag: string;
    readonly Size: number;
  }[];
}

/** The `signPart` answer. */
interface SignAnswer {
  readonly url: string;
  readonly expiresAt: string;
}

/** The `EventImage` DTO the completion answers with. */
interface EventImageAnswer {
  readonly id: string;
  readonly assetId: string;
  readonly sequence: number;
  readonly bytes: number;
  readonly contentType: string;
  readonly visibility: string;
  readonly faceCount: number;
  readonly processing: Record<string, unknown>;
  readonly uploadedByUserId: string;
  readonly uploadBatchId: string;
  readonly createdAt: string;
}

/** The exact key set of the `EventImage` DTO (contract §4.4). */
const EVENT_IMAGE_KEYS = [
  "assetId",
  "bytes",
  "contentType",
  "createdAt",
  "faceCount",
  "id",
  "processing",
  "sequence",
  "uploadBatchId",
  "uploadedByUserId",
  "visibility",
];

/** Insert a tenant (schema §13.3) and make the caller its owner. */
async function insertTenant(slug: string, owner: SignedInUser): Promise<ObjectId> {
  const _id = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id,
    slug,
    name: "OP125 Studio",
    status: "active",
    ownerUserId: owner.userId,
    billingContactUserId: owner.userId,
    dataRegion: "in",
    counters: {
      eventCount: 1,
      activeEventCount: 1,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId: _id,
    userId: owner.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  return _id;
}

/** Insert an `events` row plus the organizer's `event_organizers` row. */
async function seedEvent(
  tenantKey: string,
  organizerUserId: ObjectId,
  overrides: Record<string, unknown> = {}
): Promise<ObjectId> {
  const _id = new ObjectId();
  const now = new Date();
  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name: "Rahul & Priya's Wedding",
    description: "",
    status: "published",
    startAt: new Date(fixtureInstant("10:00:00.000Z", 10)),
    endAt: new Date(fixtureInstant("12:00:00.000Z", 10)),
    displayTimeZone: "Asia/Kolkata",
    uploadWindowEndsAt: new Date(fixtureInstant("12:00:00.000Z", 17)),
    retentionExpiresAt: new Date(fixtureInstant("12:00:00.000Z", 100)),
    accessLinks: [
      {
        slug: `op125${_id.toHexString().slice(-8)}`,
        active: true,
        createdAt: now,
        revokedAt: null,
      },
    ],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: organizerUserId.toHexString(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId: _id,
    userId: organizerUserId.toHexString(),
    role: "organizer",
    status: "active",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  return _id;
}

/** A workspace with a signed-in organizer and an open upload window. */
interface Workspace {
  readonly organizer: SignedInUser;
  readonly tenantId: ObjectId;
  readonly tenantKey: string;
  readonly eventId: ObjectId;
}

/** Sign an organizer in, provision their workspace and seed one open event. */
async function seedWorkspace(
  prefix: string,
  eventOverrides: Record<string, unknown> = {}
): Promise<Workspace> {
  const organizer = await app.signIn(makeIdentity(prefix));
  const tenantId = await insertTenant(`op125-${prefix}`, organizer);
  const tenantKey = tenantId.toHexString();
  const eventId = await seedEvent(tenantKey, organizer.userId, eventOverrides);
  return { organizer, tenantId, tenantKey, eventId };
}

/** Record an `event_organizers` row for a co-organizer of another workspace. */
async function addCoOrganizer(
  tenantKey: string,
  eventId: ObjectId,
  user: SignedInUser
): Promise<void> {
  const now = new Date();
  await app.db.collection(COLLECTIONS.eventOrganizers).insertOne({
    tenantId: tenantKey,
    eventId,
    userId: user.userId.toHexString(),
    role: "co_organizer",
    status: "active",
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
}

/** Insert the plan catalogue row for a key (once) and activate it for a tenant. */
async function seedPlanFor(
  tenantKey: string,
  key: string,
  entitlements: Record<string, Entitlement>
): Promise<void> {
  const existing = await app.db.collection(COLLECTIONS.plans).findOne({ key });
  if (existing === null) {
    await app.db.collection(COLLECTIONS.plans).insertOne(makePlan({ key, entitlements }));
  }
  await app.db.collection(COLLECTIONS.subscriptions).insertOne(
    makeSubscription({
      tenantId: tenantKey,
      subscribedPlanKey: key,
      activePlanKey: key,
      status: "active",
    })
  );
}

/** Give a tenant room for a multipart file and for its event's images. */
async function seedRoomyPlan(workspace: Workspace): Promise<void> {
  await seedPlanFor(workspace.tenantKey, "op125-roomy", {
    "storage.bytes": makeEntitlement({
      limit: 10_000_000_000,
      scope: "tenant",
      resetPeriod: "monthly",
    }),
    "images.per_event": makeEntitlement({
      limit: 5_000,
      scope: "event",
      resetPeriod: "none",
    }),
  });
}

/** The `upload_sessions` fields these pins read (§16.2). */
interface UploadSessionRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly createdByUserId: ObjectId;
  readonly contentHash: string;
  readonly mode: string;
  readonly status: string;
  readonly declaredSize: number;
  readonly declaredMimeType: string;
  readonly externalRefs: readonly { readonly kind: string; readonly id: string }[];
  readonly assetId: ObjectId | null;
  readonly expireAt: Date;
  readonly batchId: unknown;
}

/** Read one `upload_sessions` row by id. */
async function readSession(uploadSessionId: string): Promise<UploadSessionRow> {
  const row = (await app.db
    .collection(UPLOAD_SESSIONS)
    .findOne({ _id: new ObjectId(uploadSessionId) })) as UploadSessionRow | null;
  if (row === null) {
    throw new Error(`expected the upload session ${uploadSessionId} to exist`);
  }
  return row;
}

/** The `event_images` fields these pins read (schema §16.3). */
interface EventImageRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly assetId: ObjectId;
  readonly uploadedByUserId: ObjectId;
  readonly sequence: number;
  readonly visibility: string;
  readonly processing: { readonly status?: string };
  readonly uploadBatchId: unknown;
}

/** The `event_images` rows of one event, oldest first. */
async function readEventImages(eventId: ObjectId): Promise<readonly EventImageRow[]> {
  const rows = await app.db.collection(COLLECTIONS.eventImages).find({ eventId }).toArray();
  return rows as unknown as readonly EventImageRow[];
}

/** Read the event row's counters and sequence. */
async function readEvent(
  eventId: ObjectId
): Promise<{ counters: Record<string, number>; sequence: number }> {
  const row = (await app.db.collection(COLLECTIONS.events).findOne({ _id: eventId })) as
    (Document & { counters?: Record<string, number>; sequence?: number }) | null;
  if (row === null) {
    throw new Error("expected the seeded event to exist");
  }
  return { counters: row.counters ?? {}, sequence: row.sequence ?? 0 };
}

/** The tenant's `storage.bytes` counter value, or `0` when it has no row. */
async function readStorageCounter(tenantKey: string): Promise<number> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: tenantKey, entitlementKey: "storage.bytes" });
  if (row === null) {
    return 0;
  }
  const value: unknown = row.value;
  return typeof value === "number" ? value : 0;
}

/** The envelopes currently sitting on the image queue, claimed for inspection. */
async function queuedEnvelopes(): Promise<readonly Record<string, unknown>[]> {
  const claimed = await getWorkQueue().claim("q:image", 500);
  return claimed.map((message) => message.envelope as unknown as Record<string, unknown>);
}

/** Upload one part to a URL the sign endpoint minted, as the browser does. */
async function uploadPart(url: string, bytes: Uint8Array): Promise<string> {
  // A fresh view over its own `ArrayBuffer`: the `fetch` body init wants a
  // concrete buffer, and the copy also proves nothing mutates the fixture.
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(bytes),
  });
  if (response.status !== 200) {
    throw new Error(
      `expected the presigned part URL to accept the PUT, got ${String(response.status)}`
    );
  }
  const etag = response.headers.get("etag");
  if (etag === null) {
    throw new Error("expected the part PUT to answer an ETag");
  }
  return etag;
}

describe("POST …/uploads/multipart — the create hook (I1/I2, contract §5.4)", () => {
  it("I1: create, three signed parts, three uploads and a complete write the image", async () => {
    // Arrange — a roomy workspace, so the completion is not a quota case.
    const workspace = await seedWorkspace("op125-happy");
    await seedRoomyPlan(workspace);
    const claim = claimFor(HASH_HAPPY);

    // Act (1) — the create answer.
    const createResponse = await createUpload(
      createRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );

    // Assert — the §5.4 create envelope, and nothing else.
    expect(createResponse.status).toBe(201);
    const created = (await body(createResponse)) as unknown as CreateAnswer;
    expect(Object.keys(created).sort()).toEqual([
      "key",
      "partCount",
      "partSizeBytes",
      "resumed",
      "uploadId",
      "uploadSessionId",
    ]);
    expect(created.partCount).toBe(3);
    expect(created.resumed).toBe(false);
    expect(created.uploadId.length).toBeGreaterThan(0);
    // §0.15 — the handle is opaque: it spells neither the object key, the
    // content hash nor the bucket, so a leaked handle is not a leaked key.
    expect(created.key).not.toContain(HASH_HAPPY);
    expect(created.key).not.toContain("images/");
    expect(created.key).not.toContain(ORIGINALS_BUCKET);
    expect(findForbiddenFields(created, "default")).toEqual([]);

    // The part size is the same number `GET /uploads/config` publishes (§5.1.1).
    const configResponse = await uploadConfig(
      cookieGet("/api/v1/uploads/config", workspace.organizer.cookie)
    );
    const config = (await body(configResponse)) as unknown as { readonly partSizeBytes: number };
    expect(created.partSizeBytes).toBe(PART_SIZE_BYTES);
    expect(created.partSizeBytes).toBe(config.partSizeBytes);

    // The session the completion reads back.
    const session = await readSession(created.uploadSessionId);
    const multipartRefs = session.externalRefs.filter((ref) => ref.kind === "multipart_upload");
    expect(session).toMatchObject({
      tenantId: workspace.tenantKey,
      eventId: workspace.eventId,
      createdByUserId: workspace.organizer.userId,
      contentHash: HASH_HAPPY,
      mode: "multipart",
      status: "pending",
      declaredSize: THREE_PARTS_BYTES,
      declaredMimeType: "image/jpeg",
    });
    expect(multipartRefs.map((ref) => ref.id)).toEqual([created.uploadId]);
    expect(String(session.batchId)).toBe(claim.batchId);
    expect(session.expireAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);

    // Act (2) — the parts an empty upload lists.
    const emptyParts = await listParts(
      listPartsRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        created.key
      )
    );
    expect(emptyParts.status).toBe(200);
    expect(((await body(emptyParts)) as unknown as ListedPartsAnswer).parts).toEqual([]);

    // Act (3) — sign part 1 and upload it to the URL the server minted.
    const beforeSign = Date.now();
    const signOne = await signPart(
      signRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        1,
        created.key
      )
    );
    const afterSign = Date.now();
    expect(signOne.status).toBe(200);
    const signedOne = (await body(signOne)) as unknown as SignAnswer;
    expect(Object.keys(signedOne).sort()).toEqual(["expiresAt", "url"]);
    expect(new URL(signedOne.url).searchParams.get("partNumber")).toBe("1");
    expect(new URL(signedOne.url).searchParams.get("uploadId")).toBe(created.uploadId);
    expect(new URL(signedOne.url).searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(signedOne.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(signedOne.expiresAt)).toBeGreaterThanOrEqual(
      beforeSign + PRESIGN_TTL_SECONDS * 1_000
    );
    expect(Date.parse(signedOne.expiresAt)).toBeLessThanOrEqual(
      afterSign + PRESIGN_TTL_SECONDS * 1_000
    );
    const etagOne = await uploadPart(signedOne.url, makePart(PART_SIZE_BYTES, JPEG_PREFIX));

    // Act (4) — sign and upload parts 2 and 3.
    const signTwo = await signPart(
      signRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        2,
        created.key
      )
    );
    const etagTwo = await uploadPart(
      ((await body(signTwo)) as unknown as SignAnswer).url,
      makePart(PART_SIZE_BYTES)
    );
    const signThree = await signPart(
      signRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        3,
        created.key
      )
    );
    const etagThree = await uploadPart(
      ((await body(signThree)) as unknown as SignAnswer).url,
      makePart(PART_SIZE_BYTES)
    );

    // Act (5) — the parts the provider now holds, then the completion.
    const listed = await listParts(
      listPartsRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        created.key
      )
    );
    const listedParts = ((await body(listed)) as unknown as ListedPartsAnswer).parts;
    expect(listedParts.map((part) => [part.PartNumber, part.Size])).toEqual([
      [1, PART_SIZE_BYTES],
      [2, PART_SIZE_BYTES],
      [3, PART_SIZE_BYTES],
    ]);

    const completeResponse = await completeUpload(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        {
          key: created.key,
          parts: [
            { PartNumber: 1, ETag: etagOne },
            { PartNumber: 2, ETag: etagTwo },
            { PartNumber: 3, ETag: etagThree },
          ],
        }
      )
    );

    // Assert — the DTO the gallery renders.
    expect(completeResponse.status).toBe(201);
    const image = (await body(completeResponse)) as unknown as EventImageAnswer;
    expect(Object.keys(image).sort()).toEqual(EVENT_IMAGE_KEYS);
    expect(image.sequence).toBe(1);
    expect(image.bytes).toBe(THREE_PARTS_BYTES);
    expect(image.contentType).toBe("image/jpeg");
    expect(image.visibility).toBe("visible");
    expect(image.faceCount).toBe(0);
    expect(image.processing).toEqual({ status: "queued", attempts: 0 });
    expect(image.uploadedByUserId).toBe(workspace.organizer.userId.toHexString());
    expect(image.uploadBatchId).toBe(claim.batchId);
    expect(findForbiddenFields(image, "default")).toEqual([]);

    // The asset row (schema §16.1): content-addressed, tenant-scoped, refCount 1.
    const asset = await app.db
      .collection(COLLECTIONS.mediaAssets)
      .findOne({ contentHash: HASH_HAPPY });
    expect(asset).toMatchObject({
      tenantId: workspace.tenantKey,
      kind: "event_image",
      status: "stored",
      refCount: 1,
      storage: {
        locationKey: "originals",
        objectKey: objectKeyFor(HASH_HAPPY),
        bytes: THREE_PARTS_BYTES,
        contentType: "image/jpeg",
        checksum: HASH_HAPPY,
      },
    });
    expect(asset?._id.toHexString()).toBe(image.assetId);

    // Exactly one join row, and it is the DTO's document.
    const images = await readEventImages(workspace.eventId);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      tenantId: workspace.tenantKey,
      uploadedByUserId: workspace.organizer.userId,
      sequence: 1,
      visibility: "visible",
    });
    expect(String(images[0]?.processing.status)).toBe("queued");
    expect(images[0]?._id.toHexString()).toBe(image.id);

    // Counters: the event's own figures, the tenant's metered storage, the
    // sequence advanced past the number just issued.
    const event = await readEvent(workspace.eventId);
    expect(event.counters.imageCount).toBe(1);
    expect(event.counters.storageBytes).toBe(THREE_PARTS_BYTES);
    expect(event.sequence).toBe(2);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(THREE_PARTS_BYTES);

    // The session is closed on the asset it registered.
    const completed = await readSession(created.uploadSessionId);
    expect(completed.status).toBe("completed");
    expect(completed.assetId?.toHexString()).toBe(image.assetId);

    // One pipeline work item, enqueued after the commit (OP-124's contract).
    const envelopes = await queuedEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ kind: "event_image", id: image.id });
  });

  it("I2: a resumed create reuses the live upload and calls CreateMultipartUpload once", async () => {
    // Arrange — the first create, as an interrupted attempt leaves it.
    const workspace = await seedWorkspace("op125-resume");
    const claim = claimFor(HASH_RESUME);
    const firstResponse = await createUpload(
      createRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, claim)
    );
    const first = (await body(firstResponse)) as unknown as CreateAnswer;
    expect(firstResponse.status).toBe(201);
    expect(initiateCalls).toBe(1);

    // Act — Uppy resumes with the id `batch-resolve` handed it.
    const resumedResponse = await createUpload(
      createRequest(workspace.organizer.cookie, workspace.tenantKey, workspace.eventId, {
        ...claim,
        existingUploadId: first.uploadId,
      })
    );

    // Assert — the same upload, the same session, no new provider call.
    expect(resumedResponse.status).toBe(201);
    const resumed = (await body(resumedResponse)) as unknown as CreateAnswer;
    expect(resumed.resumed).toBe(true);
    expect(resumed.uploadId).toBe(first.uploadId);
    expect(resumed.uploadSessionId).toBe(first.uploadSessionId);
    expect(resumed.partCount).toBe(3);
    expect(initiateCalls).toBe(1);
    expect(
      await app.db.collection(UPLOAD_SESSIONS).countDocuments({ contentHash: HASH_RESUME })
    ).toBe(1);
  });

  it("X3: a claim made after the upload window closed is 409 upload_window_closed", async () => {
    // Arrange — an event whose window closed an hour ago.
    const workspace = await seedWorkspace("op125-closed", {
      uploadWindowEndsAt: new Date(Date.now() - 3_600_000),
    });

    // Act
    const response = await createUpload(
      createRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_CLOSED)
      )
    );

    // Assert — the §5.2 refusal shape, and no provider call at all.
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("upload_window_closed");
    expect(Object.keys(error.details ?? {}).sort()).toEqual(["canExtend", "uploadWindowEndsAt"]);
    expect(error.details?.canExtend).toBe(true);
    expect(initiateCalls).toBe(0);
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(0);
  });

  it("X2: a caller with no relationship to the event is 404 on create", async () => {
    // Arrange — a signed-in user who is neither an organizer nor a member.
    const workspace = await seedWorkspace("op125-outsider-owner");
    const outsider = await app.signIn(makeIdentity("op125-outsider"));

    // Act
    const response = await createUpload(
      createRequest(
        outsider.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_OUTSIDER)
      )
    );

    // Assert — never an oracle, and nothing is created.
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    expect(initiateCalls).toBe(0);
    expect(await app.db.collection(UPLOAD_SESSIONS).countDocuments({})).toBe(0);
  });
});

describe("POST …/uploads/multipart/{uploadId}/complete — the registration (I3/I4)", () => {
  it("I3: a part the provider does not hold is 409 parts_missing naming it", async () => {
    // Arrange — three parts declared, only 1 and 3 stored, and the client
    // acknowledges exactly what it stored.
    const workspace = await seedWorkspace("op125-missing-part");
    await seedRoomyPlan(workspace);
    const createResponse = await createUpload(
      createRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        claimFor(HASH_MISSING_PART)
      )
    );
    expect(createResponse.status).toBe(201);
    const created = (await body(createResponse)) as unknown as CreateAnswer;
    const etagOne = recordPart(created.uploadId, 1, PART_SIZE_BYTES);
    const etagThree = recordPart(created.uploadId, 3, PART_SIZE_BYTES);

    // Act
    const response = await completeUpload(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        {
          key: created.key,
          parts: [
            { PartNumber: 1, ETag: etagOne },
            { PartNumber: 3, ETag: etagThree },
          ],
        }
      )
    );

    // Assert — the gap is named, and nothing was assembled or registered.
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("parts_missing");
    expect(error.details?.missingPartNumbers).toEqual([2]);
    expect(completeCalls).toBe(0);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await readEventImages(workspace.eventId)).toHaveLength(0);
    expect((await readSession(created.uploadSessionId)).status).toBe("pending");
    expect((await readEvent(workspace.eventId)).counters.storageBytes).toBe(0);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
  });

  it("I4: a provider that already aborted the series is 409 upload_expired", async () => {
    // Arrange — the 7-day lifecycle rule has removed the in-flight series.
    const workspace = await seedWorkspace("op125-expired");
    await seedRoomyPlan(workspace);
    const created = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_EXPIRED, { size: ONE_PART_BYTES })
        )
      )
    )) as unknown as CreateAnswer;
    forgetUpload(created.uploadId);

    // Act
    const response = await completeUpload(
      completeRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        {
          key: created.key,
          parts: [{ PartNumber: 1, ETag: '"p1-etag"' }],
        }
      )
    );

    // Assert — the client must restart from `batch-resolve`, and nothing is
    // registered against an upload the provider no longer holds.
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("upload_expired");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await readEventImages(workspace.eventId)).toHaveLength(0);
    expect(await readStorageCounter(workspace.tenantKey)).toBe(0);
  });
});

describe("handle binding on the multipart surface (I5, X4, X5)", () => {
  it("I5: another user's handle is 404 on sign and on complete", async () => {
    // Arrange — the uploader mints the handle; a second admitted actor
    // (a co-organizer of the same event) learns the token.
    const workspace = await seedWorkspace("op125-handle-owner");
    await seedRoomyPlan(workspace);
    const other = await app.signIn(makeIdentity("op125-handle-other"));
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, other);
    const created = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_OTHER_USER)
        )
      )
    )) as unknown as CreateAnswer;

    // Act — the second actor presents the first actor's handle.
    const signResponse = await signPart(
      signRequest(
        other.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        1,
        created.key
      )
    );
    const completeResponse = await completeUpload(
      completeRequest(other.cookie, workspace.tenantKey, workspace.eventId, created.uploadId, {
        key: created.key,
        parts: [{ PartNumber: 1, ETag: '"p1-etag"' }],
      })
    );

    // Assert — 404 for both, no part URL served and no image written.
    expect(signResponse.status).toBe(404);
    expect((await errorOf(signResponse)).code).toBe("not_found");
    expect(completeResponse.status).toBe(404);
    expect((await errorOf(completeResponse)).code).toBe("not_found");
    expect(completeCalls).toBe(0);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await readEventImages(workspace.eventId)).toHaveLength(0);
    expect((await readSession(created.uploadSessionId)).status).toBe("pending");
  });

  it("X4: the presigned part URL is never logged", async () => {
    // Arrange
    const workspace = await seedWorkspace("op125-logged-url");
    const created = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_LOG)
        )
      )
    )) as unknown as CreateAnswer;

    // Act
    const response = await signPart(
      signRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        2,
        created.key
      )
    );
    const signed = (await body(response)) as unknown as SignAnswer;

    // Assert — the URL is a bearer credential for one part; nothing may record it.
    const logged = JSON.stringify(logSink.entries);
    expect(response.status).toBe(200);
    expect(signed.url).toContain("X-Amz-Signature");
    expect(logged).not.toContain(signed.url);
    expect(logged).not.toContain("X-Amz-Signature");
    expect(logged).not.toContain("X-Amz-Credential");
  });

  it("X5: a handle minted for one session cannot sign for another", async () => {
    // Arrange — one uploader, two files in flight at once.
    const workspace = await seedWorkspace("op125-cross-session");
    const first = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_CROSS_SESSION)
        )
      )
    )) as unknown as CreateAnswer;
    const second = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_SECOND_SESSION)
        )
      )
    )) as unknown as CreateAnswer;

    // Act — the first upload's handle against the second upload's id.
    const response = await signPart(
      signRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        second.uploadId,
        1,
        first.key
      )
    );

    // Assert — the two object keys must never mix.
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });
});

describe("DELETE …/uploads/multipart/{uploadId} — the abort hook (I6)", () => {
  it("I6: abort answers 204 twice and leaves the session aborted", async () => {
    // Arrange
    const workspace = await seedWorkspace("op125-abort");
    const created = (await body(
      await createUpload(
        createRequest(
          workspace.organizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_ABORT)
        )
      )
    )) as unknown as CreateAnswer;

    // Act — Uppy aborts, then retries the abort after a network blip.
    const first = await abortUpload(
      abortRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        created.key
      )
    );
    const firstBody = new Uint8Array(await first.arrayBuffer());
    const second = await abortUpload(
      abortRequest(
        workspace.organizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        created.key
      )
    );
    const secondBody = new Uint8Array(await second.arrayBuffer());

    // Assert — idempotent, bodyless, and no image registered.
    expect(first.status).toBe(204);
    expect(firstBody.byteLength).toBe(0);
    expect(second.status).toBe(204);
    expect(secondBody.byteLength).toBe(0);
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect((await readSession(created.uploadSessionId)).status).toBe("aborted");
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await readEventImages(workspace.eventId)).toHaveLength(0);
  });
});

describe("attendance is re-evaluated per call (I7)", () => {
  it("I7: after removal, the ex-co-organizer cannot sign or complete the in-flight upload", async () => {
    // Arrange — a co-organizer starts a multipart upload.
    const workspace = await seedWorkspace("op125-removed-owner");
    await seedRoomyPlan(workspace);
    const coOrganizer = await app.signIn(makeIdentity("op125-removed-co"));
    await addCoOrganizer(workspace.tenantKey, workspace.eventId, coOrganizer);
    const created = (await body(
      await createUpload(
        createRequest(
          coOrganizer.cookie,
          workspace.tenantKey,
          workspace.eventId,
          claimFor(HASH_REMOVED)
        )
      )
    )) as unknown as CreateAnswer;

    // The organizer removes them (the member-removal endpoint is a later lane,
    // so the row is stamped directly — the pin is that admission is re-read on
    // every call, not that a particular route wrote the stamp).
    await app.db
      .collection(COLLECTIONS.eventOrganizers)
      .updateOne(
        { eventId: workspace.eventId, userId: coOrganizer.userId.toHexString() },
        { $set: { revokedAt: new Date(), updatedAt: new Date() } }
      );

    // Act
    const signResponse = await signPart(
      signRequest(
        coOrganizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        1,
        created.key
      )
    );
    const completeResponse = await completeUpload(
      completeRequest(
        coOrganizer.cookie,
        workspace.tenantKey,
        workspace.eventId,
        created.uploadId,
        {
          key: created.key,
          parts: [{ PartNumber: 1, ETag: '"p1-etag"' }],
        }
      )
    );

    // Assert — 404 on both, nothing assembled, nothing registered.
    expect(signResponse.status).toBe(404);
    expect((await errorOf(signResponse)).code).toBe("not_found");
    expect(completeResponse.status).toBe(404);
    expect((await errorOf(completeResponse)).code).toBe("not_found");
    expect(completeCalls).toBe(0);
    expect(await app.db.collection(COLLECTIONS.mediaAssets).countDocuments({})).toBe(0);
    expect(await readEventImages(workspace.eventId)).toHaveLength(0);
    expect((await readSession(created.uploadSessionId)).status).toBe("pending");
    expect((await readEvent(workspace.eventId)).counters.storageBytes).toBe(0);
  });
});

describe("the multipart surface is a closed door without a session (X1)", () => {
  /** Ids that exist in no database: the auth stage decides before any read. */
  const TENANT_KEY = "6702f20000000000000000aa";
  const EVENT_KEY = "6702ff00000000000000bb";
  const UPLOAD_ID = "up-unauthenticated";
  const BASE = `/api/v1/tenants/${TENANT_KEY}/events/${EVENT_KEY}/uploads/multipart`;

  /** One endpoint of the family, and the anonymous request it must refuse. */
  const ENDPOINTS: readonly {
    readonly name: string;
    readonly handler: (request: Request) => Promise<Response>;
    readonly request: Request;
  }[] = [
    {
      name: "create",
      handler: createUpload,
      request: new Request(new URL(BASE, APP_ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: "6705aa0000000000000000cc" }),
      }),
    },
    {
      name: "list parts",
      handler: listParts,
      request: new Request(new URL(`${BASE}/${UPLOAD_ID}/parts?key=x`, APP_ORIGIN), {
        method: "GET",
      }),
    },
    {
      name: "sign a part",
      handler: signPart,
      request: new Request(new URL(`${BASE}/${UPLOAD_ID}/parts/1/sign?key=x`, APP_ORIGIN), {
        method: "GET",
      }),
    },
    {
      name: "complete",
      handler: completeUpload,
      request: new Request(new URL(`${BASE}/${UPLOAD_ID}/complete`, APP_ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "x", parts: [] }),
      }),
    },
    {
      name: "abort",
      handler: abortUpload,
      request: new Request(new URL(`${BASE}/${UPLOAD_ID}?key=x`, APP_ORIGIN), {
        method: "DELETE",
      }),
    },
  ];

  it.each(ENDPOINTS)("$name answers 401 authentication_required", async (endpoint) => {
    // Act
    const response = await endpoint.handler(endpoint.request);

    // Assert
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("authentication_required");
  });
});
