# ADR-0741 — OP-125 GREEN: the multipart upload endpoints behind Uppy's `@uppy/aws-s3` hooks

- **Status:** Accepted
- **Date:** 2026-11-11
- **Card:** `t_a20d4ae2` (OP-125, `tdd_stage: GREEN`)
- **Lane:** OP-125 uploads lane — `0740`–`0759`, `Next free` → `0742`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_bbd746d9`
- **Branch:** `OP-125-task-multipart-uploads-green` (based on the pins branch
  `OP-125-task-multipart-uploads-red`, head `7da2b48`)
- **Pins:** [ADR-0740](ADR-0740-op125-multipart-uploads-red.md)
- **Consumes:** [ADR-0580](ADR-0580-op112-object-storage-port-red.md) /
  [ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the storage port and
  the handle service), [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md)
  (batch-resolve), [ADR-0720](ADR-0720-op124-single-put-complete-link-only-red.md)
  / [ADR-0721](ADR-0721-op124-single-put-complete-link-only-green.md) (single
  PUT, the registration transaction, the upload window)

## Context

The RED (ADR-0740) pinned 44 cases: 28 unit (11 `partCountFor`, 9
`resolveMultipartHandle`, 8 `reuseUploadDecision`) and 16 integration (I1–I7,
X1–X5) booting `STORAGE_PROVIDER=s3` over MSW. This card turns them green with
production code only; no test, fixture, mock or ADR-0740 row was touched.

## Decision

### D1 — Two pure rules and one refusal mapping, in the pinned modules

| Unit | Module                              | Export                               |
| ---- | ----------------------------------- | ------------------------------------ |
| U1   | `@/server/uploads/multipart`        | `partCountFor` (+ `PART_SIZE_BYTES`) |
| U3   | `@/server/uploads/multipart`        | `reuseUploadDecision`                |
| U2   | `@/server/uploads/multipart-handle` | `resolveMultipartHandle`             |

`PART_SIZE_BYTES` (`8 388 608`) moved here from the `uploads/config` route, so
the create answer and `GET /uploads/config` read **one** constant — the spec
asserts the two agree. `reuseUploadDecision` keeps the exclusive expiry boundary
(at `expireAt` the provider's lifecycle rule may already have aborted the
series).

`resolveMultipartHandle` adds the **session** binding on top of the service's
user and signature bindings and maps every `AppError` the service raises to
`404 not_found` (the service answers `400`; §5.4 requires `404` so the endpoint
is not an existence oracle). Non-`AppError` throws are re-raised, not swallowed.

### D2 — Five routes, and the event-id offsets the behaviour actually demands

`apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/multipart/`

| Hook                      | File                                          | Method   | `eventIdFromRequest` offset | `{uploadId}` offset |
| ------------------------- | --------------------------------------------- | -------- | --------------------------- | ------------------- |
| `createMultipartUpload`   | `route.ts`                                    | `POST`   | 3                           | —                   |
| `listParts`               | `[uploadId]/parts/route.ts`                   | `GET`    | 5                           | 2                   |
| `signPart`                | `[uploadId]/parts/[partNumber]/sign/route.ts` | `GET`    | 7                           | 4                   |
| `completeMultipartUpload` | `[uploadId]/complete/route.ts`                | `POST`   | 5                           | 2                   |
| `abortMultipartUpload`    | `[uploadId]/route.ts`                         | `DELETE` | 4                           | 1                   |

**ADR-0740's table is off by one on four rows** (it reads 4/6/4/4). The
trailing action segment counts: `…/multipart/{uploadId}/parts` puts the event id
at `-5`, `…/parts/{n}/sign` at `-7`, `…/complete` at `-5`; only `abort`
(`…/multipart/{uploadId}`) really is `-4`. The pins assert this through
behaviour (a member is admitted, a stranger is `404`), not through the table, so
the corrected offsets are what the suite demands — with the table's numbers every
admitted call answered `404`. This is a documentation defect in ADR-0740, not a
disputed test.

The sixth hook, `getUploadParameters`, is OP-124's `…/uploads/params` and was
already green.

### D3 — The session preamble is written once

`loadMultipartUpload({ db, tenantKey, request, principal, eventIdFromEnd,
uploadIdFromEnd, handle? })` finds the session by `{ eventId, externalRefs:
{ $elemMatch: { kind: "multipart_upload", id: uploadId } } }`, resolves the
handle against **that session id**, and returns `{ session, uploadId,
locationKey, objectKey }`. Four routes therefore share one refusal surface: an
unknown upload id, a foreign presenter, an edited token and a token minted for
another session are all `404`. `complete` passes the token from its body (the
other three read the `key` query parameter).

The object key comes from the **handle**, not from a re-derivation, so the
signed URL and the completion address exactly what `create` minted.

### D4 — `create` reuses or starts, and there is still no part collection

`create` validates the claim exactly as `params` does (window first, then
`maxFileBytes`/`supportedMimeTypes`), then:

1. reads the caller's own `pending` multipart session for the hash;
2. `reuseUploadDecision` on the named `existingUploadId`;
3. **reuse** → no provider call (`resumed: true`), **create** →
   `CreateMultipartUpload`;
4. one upsert keeps a single session per (user, hash): `mode: "multipart"`,
   `status: "pending"`, `externalRefs: [{ kind: "multipart_upload", id }]`, the
   schema's five-day `expireAt`;
5. issues the opaque handle for that session id.

No idempotency key is required (only `complete` carries one, per §5.4), and no
part-tracking collection exists — `ListParts` is the truth (§16.2).

### D5 — `complete` refuses a subset before it assembles anything

The acknowledged part numbers are compared against
`partCountFor(declaredSize, PART_SIZE_BYTES)`, **not** against what the provider
holds: a three-part file completed with parts 1 and 3 names `[2]` in
`details.missingPartNumbers` (S3 itself would concatenate that subset). The check
runs before `CompleteMultipartUpload`, so a refused completion assembles nothing
and writes nothing. The upload window is then enforced with the session's
`createdAt` and `inflightGraceMinutes` (a completion started before the close may
finish inside the grace).

### D6 — One completion transaction, shared with OP-124

`@/server/uploads/complete-upload` is the OP-124 transaction extracted verbatim
(`HeadObject` + 1 % size tolerance, type sniff with the object deleted on
mismatch, `storage.bytes`/`images.per_event` consumption, asset upsert with
`refCount`, join row with the next `sequence`, counters, session closure,
duplicate-key and retry-limit convergence to the committed winner, the `q:image`
envelope after the commit, the `info` line). Each completion route supplies the
two facts only it knows:

- **single PUT** — the key derived from the hash and the client's declared
  `bytes`;
- **multipart** — the key resolved from the handle and `declaredBytes: null`,
  i.e. the assembled object's `HeadObject` size is the recorded size (A4).

`uploads/[uploadSessionId]/complete/route.ts` was reduced to load → window →
call. Its 25 pins still pass unchanged.

### D7 — The storage port and the R2 adapter

`presignPart` now returns `PresignedPut` and takes the TTL, like `presignPut`:
one presign envelope shape for both uploads, and the sign route passes the
contract's 900 s. The R2 adapter implements the two methods that were
`not_implemented`:

- `presignPart` — `UploadPartCommand` signed path-style; the URL carries
  `partNumber`, `uploadId` and the signature, and the route returns only
  `{ url, expiresAt }`;
- `abortMultipart` — `AbortMultipartUploadCommand`, where a `404` means the
  series is already gone and is therefore a success (the contract's idempotent
  abort).

Two normalizations the suite forced:

- `completeMultipart` maps a `404` (`NoSuchUpload`) to `AppError("upload_expired")`
  instead of a transport failure — the series being gone is a domain answer the
  client acts on;
- `listParts` maps an absent `Parts` element to `[]`. S3 omits `Part` entirely
  for a series with nothing landed; the old `parts: undefined` failed Zod and
  made the "empty upload lists nothing" pin a `500`.

The memory adapter's multipart methods stay `not_implemented` (A6/A8 — no e2e in
this lane).

### D8 — Two new media codes, append-only

`parts_missing` and `upload_expired` were appended to
`MEDIA_ERROR_CODES` and `MEDIA_ERROR_TRANSPORT`, both `409`, both
non-retryable, in the ADR-0540/0701/0721 shape. Only `parts_missing` carries
details (`{ missingPartNumbers }`).

### D9 — Handle composition root

`getHandleService()` memoizes `createHandleService({ secret:
getConfig().media.signingSecretCurrent })`. The service's registry is what turns
an opaque token back into an object key, so `create` and every later call must
share **one** instance — a fresh service per request would 404 every subsequent
call. `MEDIA_SIGNING_SECRET_CURRENT` is already a required 32+ char secret, so no
new environment variable was introduced (A7).

## Consequences

- Signing is rate limited at `upload.sign` (900/min, per user) and the presigned
  part URL is never logged; the sign route logs nothing at all.
- A truncated multipart file can no longer be registered, and an expired series
  is a `409` the client can restart from rather than a `502`.
- The multipart surface and the single-PUT surface now share one registration
  path; a change to the transaction cannot drift between them.
- `docs/adr/README.md` remains the lane hotspot: this card contributes one row,
  one ledger row and the `Next free` bump to `0742`.

## Alternatives considered

- **Re-deriving the object key in each route** instead of resolving it from the
  handle: rejected — two places that must agree on the hash/extension rule, and
  the handle already carries the answer.
- **Tracking parts in Mongo** to detect gaps: rejected by the card and by
  §16.2; the declared-size rule (D5) is the correct source and needs no
  collection.
- **Leaving `presignPart` returning `unknown`** and narrowing in the route:
  rejected — a cast at the trust boundary is exactly what the port's typed
  envelope exists to avoid.
