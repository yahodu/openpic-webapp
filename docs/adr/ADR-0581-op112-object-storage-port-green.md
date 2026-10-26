# ADR-0581 — OP-112 GREEN: the object storage port implemented — the R2 adapter, memory adapter, location map, key builder and HMAC handles

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-112 GREEN (`t_a9d218d5`) · **Branch:** `OP-112-feature-object-storage-port` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a9d218d5`, stacked on the RED head `4fb9ec0`
- **Relates to:** [ADR-0580](ADR-0580-op112-object-storage-port-red.md) (the RED contract this card turns green), [ADR-0001](ADR-0001-ports-and-adapters.md) (the port shape), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) (the shared transport/drift classification), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the explicit-config adapter factory shape), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card takes the lane's next free `0581`)

## Context

ADR-0580 fixed the executable contract the RED's four unit specs (U1–U4) and
one MSW integration spec (I1–I3) encode. This GREEN implements it — the five
pinned modules, the two dependency additions the RED deferred, and the
provider-neutral port contract driving both adapters — with the six test
files carried byte-unchanged.

## Decisions

### 1. The `ObjectStorage` port type has a home: `@/server/storage/object-storage`

ADR-0580 §1's module table names the five runtime modules; the twelve-method
port surface (§2) lives as a **types-only** module the two adapters implement
(`ObjectStorage`, `PresignedPut`, `CreatedMultipart`, `UploadedPart`,
`ListedParts`, `CompletedPart`, `CompletedMultipart`, `ObjectHead`,
`ObjectRange`). Types are erased at runtime (zero coverage cost, no wire
shape), and a single shared port type is what makes "swapping the provider is
a new adapter plus config" (CONVENTIONS §6.6) a compile-checked promise: a
method the R2 adapter omits fails `tsc`, not a later lane's review.

### 2. `completeMultipart` acknowledges slim `{ PartNumber, ETag }` parts

The RED's spec passes `[{ PartNumber, ETag }]` — no `Size` — to
`completeMultipart`, and the RED was type-correct only against a stub with
that input. The port therefore types the acknowledgement as `CompletedPart`
(`{ PartNumber: number; ETag: string }`), the caller echoing back what
`listParts` handed it; `Size` is the vendor's bookkeeping and stays out of
the client-asserted shape (ADR-0580 §7 calls the three-field shape the
_list_ contract, not the complete input).

### 3. The handle's object key is unrecoverable from the token — and that made the service stateful

ADR-0580 §5 and its Consequences promise "the object key is unrecoverable
from the token", with the service taking only `{ secret }`. A token that
carries the object key (even base64url-encoded) is decodable by the client
Uppy echoes it to, which would hand the storage layout to the client — the
exact leak the handle exists to prevent. With no datastore in the service's
contract, resolution comes from a **per-instance registry** keyed by the
issued token: `issueHandle` stores `{ locationKey, objectKey,
uploadSessionId, userId }` under the token, the token's payload carries only
`{ sub: userId, usid: uploadSessionId, loc: locationKey, jti: random nonce }`
(no object key), and `resolveHandle` verifies the HMAC over the payload
bytes **before** consulting the registry, then checks the presenter against
the stored `userId`. Every refusal is the same `AppError` throw the RED
pins: tamper at any index (including the trailing signature character),
a different presenter, a non-handle string, a handle signed under another
secret.

**Open for the upload-route lane / composition root:** the registry is
in-process, so a handle is resolvable for the life of the issuing process.
A deployment that must resolve handles across restarts or instances moves
this map behind a shared store (the existing Upstash Redis) — the refusal
surface is identical. The signing secret's env source also stays unpinned
(ADR-0580 open item): `createHandleService({ secret })` takes it explicitly.

### 4. Vendor quirks pinned by the live MSW↔SDK handshake (the RED could not see the wire)

The handshake executes only in this PR (ADR-0306), and it surfaced two
things no stub could:

- **`ListParts` returns `NextPartNumberMarker` as a numeric string.** The SDK
  parses `<NextPartNumberMarker>3</NextPartNumberMarker>` to `"3"`; the
  neutral contract (and the RED's assertion) wants the number `3`, so the
  adapter converts with `Number(...)`. An absent marker becomes `NaN`, which
  the Zod schema refuses as drift — fail-closed, no synthesized value.
- **The SDK needs `maxAttempts: 1`.** The default standard-retry mode retries
  a 503 twice with backoff (several seconds of hidden jitter before the I3
  "upstream 5xx" refusal surfaces). Retry policy is the port's own domain —
  `classifyTransportFailure` sets `TransportError.retryable` for the caller
  (a dispatch ledger, a job loop) — so the adapter disables SDK-level retries
  and answers the first upstream status deterministically.

### 5. Undriven port methods are `not_implemented` refusals on both adapters

ADR-0580 §2 explicitly permits minimal bodies "until a lane drives them":
`presignPart`, `abortMultipart`, `deleteObject`, `getObjectStream` (and
`putObject`/`getObject`/`getObjectRange` on the R2 adapter) refuse with
`AppError("not_implemented")` (501). Writing untested vendor calls now would
ship the next cycle's liability (the OP-105 `createPlan`/`cancelMandate`
precedent, ADR-0381 D3). The port surface pin (`Object.keys(...)` equality)
holds on both adapters regardless.

### 6. Everything else implements the ADR-0580 pin exactly

`locations` (type guard + `bucketForLocation` via `ConfigError` naming the
location, never `undefined`), `object-key` (total `images/<64-hex>.<ext>`
builder, `bad_request` refusals), the memory adapter (byte-for-byte roundtrip,
inclusive `getObjectRange` where `{start: 2, end: 5}` over `"0123456789"` is
`"2345"`, `AppError("not_found")` on absent reads, per-instance and
per-location isolation), and the R2 adapter (explicit config, path-style
addressing, multipart XML → Zod-validated neutral shapes with a drifted part
shape → `UpstreamContractError`, the `{ expiresAt, headers, method, url }`
presigned envelope with the caller's `X-Amz-Expires`, and `HeadObject`
404/200/5xx classification). The adapter validates every SDK-parsed XML
response through Zod before returning it (§5 of the card's scope notes), so a
shape change is refused, never coerced.

### 7. Dependencies

`@aws-sdk/client-s3@^3.1156.0` and `@aws-sdk/s3-request-presigner@^3.1156.0`
are added to `apps/web` (the RED deferred both). `pnpm audit --prod` reports
no findings.

## Number allocation

This card consumes the lane's **`0581`** (ADR-0580: "The gated GREEN
`t_a9d218d5` consumes `0581` next") and advances the lane's `Next free` cell
to `0582`. No number outside the lane range `0580`–`0599` is touched.

## Consequences

- **Provider neutrality is compile-checked**: both adapters implement one
  `ObjectStorage` type with exactly the twelve pinned method keys; swapping
  R2 for S3 is a new adapter plus config.
- **The media documents stay logical** and **a handle leak is not a key
  leak**: `locationKey`s are the only locations crossing the DB/client
  boundary, and the object key is unrecoverable from the handle token — at
  the cost of the in-process registry, which the upload-route lane must move
  behind a shared store for cross-restart durability.
- The live MSW↔SDK traffic now pins the R2 wire behaviour (path-style
  `/bucket/key`, XML neutral shapes, SigV4 query) that the RED could only
  contract on.

## Evidence

At the head: unit **123 files · 2099 passed | 3 skipped**, integration
**85 files · 714 passed** (`TMPDIR=/root/tmp-mongo`); `tsc` exit `0` on the
root / `packages/contracts` / `apps/web` projects; ESLint 0 problems;
`prettier --check` clean; the `adr-numbering` guard green; `test:coverage`
exit `0` with all global thresholds above the 80 % bars — statements `92.04 %`,
branches `80.8 %`, functions `95.21 %`, lines `92.41 %`. The six RED files
(`apps/web/src/test/{factories/storage.ts, unit/storage-*.test.ts,
integration/object-storage-r2.test.ts}`) are byte-unchanged from the RED head.
No test, mock, fixture or factory was written or edited by this card.
