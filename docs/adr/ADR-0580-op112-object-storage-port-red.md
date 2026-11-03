# ADR-0580 — OP-112 RED: the object storage port — opaque HMAC handles, content-addressed keys, the location→bucket map, the memory and R2 adapters

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-112 RED (`t_3d79f253`) · **Branch:** `OP-112-task-object-storage-port` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_3d79f253`
- **Relates to:** [ADR-0001](ADR-0001-ports-and-adapters.md) (the ports-and-adapters shape this lane instantiates for storage), [ADR-0009](ADR-0009-upload-type-guards.md) / [ADR-0010](ADR-0010-upload-type-guards-green-implementation.md) / [ADR-0011](ADR-0011-heif-avif-ftyp-brand-set.md) (the image-type vocabulary the object-key builder's extension allow-list is drawn from), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this lane draws its own block), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design: MSW↔SDK interop and any real-R2 traffic execute only in the GREEN's PR)
- **Contract:** §6.6 (backing services behind ports, provider swappable without touching domain code), §6 ("dev/prod parity — the same adapters in every environment"), §8.1/§0.15 (the never-return list: bucket names and object keys are storage-internal, never client-visible), §5.2 (field dictionary — presigned URLs/keys never logged at `info`) · **Schema:** §11.2 (the logical `locationKey` vocabulary)

## Context

OP-112 is the storage half of the Media Foundations epic: an object-storage port
whose backing provider (R2 today, any S3-compatible store or a memory adapter in
tests) can be swapped without touching domain code. The user story is one
sentence: _"bucket names and object keys are never exposed and R2 can be swapped
for S3."_

The card's test list is short — U1 handle roundtrip/tamper/different-user, U2
key-builder rejections, U3 the location map, U4 the range read, and the three
MSW integration behaviours — and it names almost no module paths, signatures or
error classes. This record fixes the executable contract the tests encode, so
the GREEN (`t_a9d218d5`) has one coherent spec to implement.

Two design sentences shape everything below:

- **A stored document names a _logical_ location, never a bucket.** `originals`,
  `thumbnails`, `exports`, `branding` are the §11.2 vocabulary; the physical
  bucket, region and credentials are a deployment detail resolved at runtime.
  Moving buckets or swapping R2 for S3 is a config change plus a copy job — not
  a rewrite of the media documents.
- **The handle is the only thing that crosses the client boundary.** The
  multipart API hands Uppy a `key` it echoes on every later call, so a plaintext
  object key would hand the storage layout to the client. The handle is a
  signed, tamper-evident token bound to the user and upload session that own it.

## Decisions

### 1. Module layout

| Module                                    | Exports                                                           | Drives |
| ----------------------------------------- | ----------------------------------------------------------------- | ------ |
| `@/server/storage/locations`              | `StorageLocationKey`, `isStorageLocationKey`, `bucketForLocation` | U3     |
| `@/server/storage/object-key`             | `buildObjectKey`                                                  | U2     |
| `@/server/storage/handles`                | `createHandleService`, `IssueHandleInput`                         | U1     |
| `@/server/adapters/memory-object-storage` | `memoryObjectStorage`                                             | U4     |
| `@/server/adapters/r2/r2-object-storage`  | `createR2ObjectStorage`, `R2ObjectStorageConfig`                  | I1–I3  |

`@/server/adapters/transport-error` (`TransportError`, `UpstreamContractError`)
and `@/server/http/app-error` (`AppError`) already exist on `main` and are
reused, not re-declared.

### 2. The `ObjectStorage` port surface (12 methods)

Both adapters expose **exactly** these methods as own enumerable keys of a
plain object (the `createCashfreeProvider` / `memoryMessageTransport` shape,
ADR-0001):

```
presignPut, createMultipart, presignPart, listParts, completeMultipart,
abortMultipart, headObject, getObjectStream, putObject, deleteObject,
getObject, getObjectRange
```

`getObjectRange` is the GREEN card's own §1 addition. `getObject` (whole-object
bytes) is an **addition the RED makes**: the memory adapter's byte-level read
(U4) is the only place the port's roundtrip contract can be pinned without a
network, and the R2 adapter should expose the same small-object reader. Both
surface pins (`U4: the adapter exposes exactly…` and `I1: the adapter exposes
exactly…`) force the port to be complete for the lanes that come after
(multipart signing, aborts, deletes), even though no current spec drives
`presignPart`, `abortMultipart`, `putObject`, `getObjectStream` or
`deleteObject` — the GREEN implements them minimally (typed on the port, bodies
may be `not_implemented` refusals until a lane drives them).

### 3. `@/server/storage/locations` — the `locationKey` → bucket map

- `StorageLocationKey = "originals" | "thumbnails" | "exports" | "branding"`.
- `isStorageLocationKey(value: string): value is StorageLocationKey` narrows
  exactly that vocabulary (`videos`, `original`, `Originals` all `false`).
- `bucketForLocation(locationKey: string, buckets: Readonly<Record<string,
string>>): string` resolves through the injected map and throws
  `ConfigError` for an unknown location **naming the location** in the message,
  and for a known location the deployment's map does not carry. `undefined` may
  never be used as a bucket name; a resolution fault is a config error, not a
  wire value.
- The adapter receives the bucket map in its explicit config (§7); the fixture
  map (`originals → "bkt-a1"` etc.) is deliberately **not** `openpic-<location>`
  so "the logical key never reaches the URL" stays a real assertion.

### 4. `@/server/storage/object-key` — the content-addressed key builder

- `buildObjectKey(contentHash: string, extension: string): string` →
  `` `images/${contentHash}.${extension}` ``.
- **Total:** anything that is not a canonical **lowercase** 64-character hex
  SHA-256 (uppercase, wrong length, a non-hex letter, a path separator,
  surrounding whitespace, empty) or not an admitted extension throws
  `AppError("bad_request")` — a crafted hash is a path-injection vector and a
  concatenation of it is refused, never stored.
- Admitted extensions: `jpg`, `jpeg`, `png`, `webp`, `avif`, `heic`, `heif`,
  `tif`, `tiff` (the user-image vocabulary of the upload type guards,
  ADR-0009/0010/0011) **plus** `svg`, admitted deliberately for `branding`
  assets (the GREEN card §1 ships `getObjectStream` for "branding/QR small
  objects"; §2 maps a `branding` bucket; logos are SVG). Rejected:
  `exe`, `gif` (an image format the upload contract never accepts), `JPG`,
  `jpg `, `jpeg2`, `""`.

### 5. `@/server/storage/handles` — the opaque handle service

- `IssueHandleInput = { locationKey: StorageLocationKey; objectKey: string;
uploadSessionId: string; userId: string }`.
- `createHandleService({ secret })` → `{ issueHandle(input): string;
resolveHandle(handle: string, presentingUserId: string): ResolvedHandle }`
  where `ResolvedHandle = { locationKey: string; objectKey: string;
uploadSessionId: string }`.
- The token is an HMAC-signed **base64url** string (JWT-segment shape
  permitted) that must never contain or be the object key, and carries the
  issuing `userId` + `uploadSessionId` the presentation is checked against.
- Every refusal is the same observable — `resolveHandle` **throws `AppError`**
  rather than answering a location it cannot prove the presenter owns: any
  single-character tamper (including the trailing character, so the MAC is
  actually verified, not just the payload re-read), presentation by a
  **different `userId`**, a string that is not a handle, and a handle signed
  with a different secret.
- `issueHandle` validates `locationKey` against the vocabulary and throws
  `ConfigError` for an unknown location (§3's guard reused) — a handle is never
  minted for a location that cannot resolve to a bucket.

### 6. `@/server/adapters/memory-object-storage` — the e2e adapter

- `memoryObjectStorage()` — no config, a fresh isolated store per call, keyed
  by `(locationKey, objectKey)` so the same key in another location is a
  different object.
- `putObject(locationKey, objectKey, body: Uint8Array, contentType)` /
  `getObject(locationKey, objectKey): Promise<Uint8Array>` byte-for-byte
  roundtrip.
- `getObjectRange(locationKey, objectKey, { start, end }): Promise<Uint8Array>`
  — **both ends inclusive** (S3's `Range: bytes=<start>-<end>` semantics):
  `{start: 2, end: 5}` over `"0123456789"` is `"2345"`.
- A read of something the location does not hold throws
  `AppError("not_found")` for both `getObject` and `getObjectRange` — the same
  refusal the R2 adapter answers for a `HeadObject` 404, so callers branch on
  absence, not on status.
- This adapter is what an e2e boot selects (§6 parity), which is why the port
  surface pin (§2) lives on it.

### 7. `@/server/adapters/r2/r2-object-storage` — the R2 adapter (MSW)

- `R2ObjectStorageConfig = { endpoint, region, credentials: {
accessKeyId, secretAccessKey }, buckets: Readonly<Record<string, string>> }`
  — an **explicit** config object, no env read inside the adapter (the
  `createCashfreeProvider` shape, ADR-0380). The composition root derives it
  from config; the fixture builds one with zero process env.
- Built on `@aws-sdk/client-s3` + `s3-request-presigner` (the GREEN's
  dependency addition; `package.json` is untouched here). **Path-style
  addressing** (`forcePathStyle: true`) — the presigned URL and every S3 call
  address `/bucket/key` on the endpoint host; the I2 pin asserts the exact
  host + pathname so a virtual-hosted style cannot slip in.
- `locationKey` → bucket is resolved per call through `bucketForLocation`
  (§3), the map coming from the injected config.
- **Multipart XML → neutral shapes** (I1):
  - `createMultipart(locationKey, objectKey, contentType)` →
    `{ uploadId }` — the vendor id and nothing else (no bucket, no key).
  - `listParts(locationKey, objectKey, uploadId)` →
    `{ parts: [{ PartNumber, ETag, Size }], isTruncated,
nextPartNumberMarker }` — the `UploadedPart` shape is **S3-shaped** (Uppy
    consumes it verbatim, so `ETag` keeps the vendor's quotes and
    `LastModified` is stripped rather than normalised away).
  - `completeMultipart(locationKey, objectKey, uploadId, parts)` →
    `{ etag }`.
  - A response whose shape changed (the drift fixture drops a part's `ETag`)
    is refused as **`UpstreamContractError`** — a drift is a code/config fault,
    never something a retry can fix ([ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) reuses the shared classification).
- **Presigned PUT** (I2): `presignPut(locationKey, objectKey, contentType,
ttlSeconds)` → `{ method: "PUT", url, headers: { "content-type": … },
expiresAt }` — a real SigV4 (`X-Amz-Algorithm: AWS4-HMAC-SHA256`,
  `X-Amz-Signature` = 64 lowercase hex, `X-Amz-SignedHeaders` containing
  `host`), the **caller's** TTL in `X-Amz-Expires` (never a constant),
  `expiresAt` an absolute RFC 3339 UTC instant with milliseconds whose value is
  `now + ttl` (bracketed against a real clock), and the envelope's exact key
  set is `[expiresAt, headers, method, url]` — no bucket, no `locationKey`,
  no `objectKey` field, the §0.15 rule at the port boundary.
- **HeadObject** (I3): a 404 refusal is the domain `AppError` with
  `code: "not_found"` and `status: 404`; a 200 is normalized to
  `{ bytes, contentType, etag }` (size/type from the object itself, never from
  the client's declaration — §5.3); a 5xx is `TransportError` with
  `retryable: true` (never a `not_found`).

### 8. MSW wiring

The integration spec registers per-case handlers on the shared
`setupServer` from `apps/web/src/test/integration/setup.ts`
(`onUnhandledRequest: "error"` — an unhandled S3 call is a bug, not a live
network). Handlers match the URL **path only**, which is what pins
path-style addressing: `?uploads=`, `?uploadId=…` and `?partNumber=…` all
ride the one `/<bucket>/<key>` path. The SDK↔MSW handshake itself executes
only in the GREEN's PR (RED-by-design, ADR-0306): at the RED head the module
does not exist, and the interop depends on the SDK's HTTP transport, which
MSW intercepts at the `node:http(s)`/fetch layer (both are patched by
`@mswjs/interceptors`).

## Number allocation

This lane had no reserved range on `main`, so — as its first card — it drew
the next block from the allocator's `unallocated (future lanes)` pool:
**`0580`–`0599`** (Renumbered 2026-10-26: this lane originally drew `0520`–`0539`; OP-115 merged first and owns `0520`/`0521` on `main`, so the lane re-drew `0580`–`0599`, clear of OP-114's `0540`–`0559` and OP-116's `0560`–`0579`). The table gains an `OP-112 media foundations lane` row
with `Next free = 0581`, the pool advances to `0600`+, and this record
consumes `0580`. The gated GREEN `t_a9d218d5` consumes `0581` next and must
base its branch on this pins branch, not bare `origin/main`. No number
outside the lane range `0580`–`0599` is touched.

## Consequences

- **Provider neutrality is pinned at both ends**: the exact port surface on
  both adapters (swapping R2 for S3 is "a new adapter plus config", §6.6) and
  the explicit-config factory shape (no env read inside an adapter).
- **The media documents stay logical**: only `locationKey`s cross the DB
  boundary; bucket names exist only in config and in the vendor wire traffic
  the tests intercept.
- **A handle leak is not a key leak**: the object key is unrecoverable from the
  token, tampering is detected, and a handle presented by a different user is
  refused.
- This RED delivers **test files only** (four unit specs + one integration
  spec + the fixture factory) plus this ADR and the README ledger rows. The
  temporary contract stubs used to prove type-correctness were deleted, and
  `git status` shows the six test files only. No production file is touched.

## Evidence

With throwaway stubs at the five intended module paths (deleted before
handoff): `npx tsc -p apps/web/tsconfig.json --noEmit` exited `0` (the RED is
type-correct — the GREEN inherits no type ambush); the unit probe failed
**34 | 16 passed (50)** and the integration probe **10 failed (10)**, every
failure assertion-level (`expected function to throw an error, but it didn't`,
`expected undefined to be an instance of AppError`,
`expected Uint8Array[] to deeply equal Uint8Array[48,49,…]`,
`expected [ 'getObject', … ] to deeply equal [ 'abortMultipart', …(11) ]`,
`expected { uploadId: 'stub-upload-id' } to deeply equal { uploadId: 'up-1' }`,
`expected 'POST' to be 'PUT'`, `promise resolved … instead of rejecting`).
At handoff the suite is red as **module-not-found** for the five modules;
the full unit project is otherwise green (**122 files, 4 failed | 118 passed
(2042 passed | 3 skipped)** — the 4 failures are exactly this lane's unit
specs) and the full integration project likewise (**85 files, 1 failed | 84
passed (704 passed)** — the single failure is this lane's spec). `eslint`
0 problems and `prettier --check` clean on all six files.

## Assumptions and open questions

- **The extension allow-list is a decision.** `svg` is admitted for
  `branding`; the raw camera containers the upload guards accept (`cr2`,
  `cr3`, `nef`, `arw`, `dng`, `orf`, `raf`, `rw2`) are **excluded** from the
  key builder. If the media pipeline must store raw formats, that is new
  tests, not a silent widening.
- **`getObject` joins the port surface** beside `getObjectStream` (GREEN card
  §1 names `getObjectStream (branding/QR small objects only)`). The whole-byte
  variant is the memory adapter's pinned read path.
- **The handle signing secret's source is unpinned.** The service takes
  `{ secret }` explicitly; the composition root may reuse the existing
  `MEDIA_SIGNING_SECRET_CURRENT` env or add a storage-specific secret — no test
  names the environment variable.
- **The "no bucket/key in any API response" scanner (GREEN acceptance
  criterion) has nothing to scan in this lane**: there is no route in the card.
  The port-level analogues are pinned instead — the presigned envelope's exact
  key set, the `{ uploadId }`/`{ etag }`/`UploadedPart` shapes, and the handle
  token's opacity. The scanner belongs with the upload-API lane.
- **The upload-completion type check** (GREEN card §6: read the first 64
  bytes, mismatched type → 415, delete the object, write nothing) is not in
  the RED card's test list and is not pinned here; it lands with the route that
  completes an upload.
- **Presigned-header coverage**: only `host` is pinned as signed; whether
  `content-type` additionally lands in `X-Amz-SignedHeaders` is
  SDK-determined and unpinned (the returned `headers` map always carries the
  client's content type either way).
