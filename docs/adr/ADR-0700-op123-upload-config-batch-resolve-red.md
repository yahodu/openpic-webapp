# ADR-0700 — OP-123 RED: the upload pre-check pinned — the resolution reducer, the advisory quota, `batchId` validation, the extension/MIME agreement, the config endpoint and `batch-resolve` (dedupe + resume)

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-123 RED (`t_28054285`) · **Branch:** `OP-123-task-upload-config-batch-resolve-red` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_28054285`, off `origin/main` `5f28acd` (the OP-122 squash)
- **Gated GREEN:** `t_08447abd` (same worktree) — completing this card releases it
- **Relates to:** [ADR-0580](ADR-0580-op112-object-storage-port-red.md) / [ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the `ObjectStorage` port and `ListParts`), [ADR-0009](ADR-0009-upload-type-guards.md) (the extension/MIME table this lane reuses), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the advisory quota reads `checkEntitlement`, never consumes), [ADR-0640](ADR-0640-op119-members-analytics-red.md)/[ADR-0644](ADR-0644-op119-review-round1-green.md) (`tenantStage` + the event-scoped admission seam), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card draws `0700`–`0719`)

## Context

OP-123 is the first upload-lane card with a real endpoint: `GET /api/v1/uploads/config`
(contract §5.1.1) and `POST …/events/{eventId}/uploads/batch-resolve` (§5.2). The
card lists four unit cases (U1–U4) and six integration cases (I1–I6); both the
path shape and the wire body exist in the contract, but the module paths, the
pure-function surface and several semantics the card leaves open do not. This
record fixes them.

## Decisions

### D1 — the pure logic lives in one module: `@/server/uploads/batch-resolve`

`resolutionFor`, `quotaSufficiency`, `isValidBatchId` and `MAX_BATCH_FILES`,
with the `UploadPolicy`, `BatchFileClaim`, `ResolutionInput` and
`UploadResolution` types. One module because the four pieces are one decision
and the route must not re-derive any of them; a pure module because the state
machine can then be driven without a database, a bucket or a clock.

### D2 — one total resolver over the four wire states, with a fixed precedence

`resolutionFor` folds one hash's observations into exactly one of `completed` /
`in_progress` / `not_found` / `rejected`, in this order:

1. **A stored asset wins** (`completed`). Two of the states can coexist — a
   tenant asset and a user's in-flight session — and a stored asset means the
   bytes were already accepted, so no claim about the client's declared type can
   invalidate them. `linked` is `eventImageId !== null`; `eventImageId: null` is
   the "call the link-only variant" signal (§5.3).
2. **A refused claim** (`rejected`) — the client is told why, per file, and the
   file is never attempted.
3. **A resumable multipart session** (`in_progress`) — `mode: "multipart"` with
   a provider id in `externalRefs`. The parts and their byte total come from
   the caller's live `ListParts` answer, never from Mongo (§16.2 has no part
   collection).
4. **A fresh upload** (`not_found`) whose `mode` follows the policy's
   `multipartThresholdBytes` (inclusive).

A `single`-mode session resolves as `not_found`: it carries no parts and no
presigned URL, so a fresh PUT is the only correct client action. A
`multipart` session with no provider id is the same case (A3/A4).

### D3 — the route path is the contract's, and the event id is **three** segments from the end

`POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batch-resolve` as §5.2
writes it. The lane's shared `admitEventActor` reads the event id with
`eventIdFromRequest(request, { segmentFromEnd: 2 })`, which is right for
`…/events/{id}` and `…/events/{id}/archive` but reads the literal `uploads`
segment here. The GREEN therefore needs either a `segmentFromEnd` option on the
seam or a route-local equivalent using `3`; the pins are agnostic to which.

### D4 — `upload_window_closed` is a new catalogue code (`409`), appended the documented way

Appendix A.1 row 3562 documents it, but neither `ERROR_CODES` nor the server
catalogue carries it. It is appended through the per-domain table
(`MEDIA_ERROR_CODES` + `MEDIA_ERROR_TRANSPORT`), never by editing
`ERROR_CATALOG`, mirroring `file_too_large` (ADR-0540). The refusal carries
`details.uploadWindowEndsAt` (the stored instant, ISO) and `details.canExtend`.

### D5 — the quota is advisory and pre-transfer, computed from `checkEntitlement`

`sufficient` is `remaining === null || remaining >= requested`. The route calls
`checkEntitlement(tenantKey, "storage.bytes", requestedBytes)` (tenant scope,
the service reads the counter) and `checkEntitlement(tenantKey, "images.per_event",
requestedImages, { counts: event.counters.imageCount })` (event scope, the
caller supplies the count). `remaining` for a denied verdict is
`max(0, effectiveLimit - used)`; `null` stays the unlimited sentinel. Nothing is
consumed at pre-check time — enforcement stays in the completion transaction
(OP-124, ADR-0340).

### D6 — rejections reuse the upload guards' own format table

`rejectClaim` compares the declared `mimeType` against the policy's
`supportedMimeTypes`, then the declared size against `maxFileBytes`, then the
file name's extension against `UPLOAD_FORMATS` (`@/server/settings/upload-guards`,
ADR-0009). Reusing that table is what makes `.NEF` + `image/tiff` and
`.heic` + `image/heif` pass: RAW containers legitimately share the TIFF MIME,
and one format admits several MIME values. No magic-byte check here — the
pre-check has no bytes; that guard runs at completion (OP-124 I8).

### D7 — the pre-check is read-only

`batch-resolve` writes no `upload_sessions` row and emits no domain event, so it
cannot produce a per-file notification (`upload.batch.files_rejected` folds
rejections into the batch summary). Pinned by counting both collections around
the call, because sign-in itself emits `account.welcome` /
`auth.signin.new_device`.

## Assumptions (unilateral decisions)

- **A1 — the rejection vocabulary is `unsupported_mime_type`, `unsupported_extension`,
  `extension_mime_mismatch`, `file_too_large`, each with a fixed user-facing
  `message`.** The contract shows only one example reason; the spec pins the
  exact strings so the client copy cannot drift.
- **A2 — a claim with no `fileName` skips the extension comparison** (the MIME
  allow-list still applies). The name is display/audit metadata, never identity
  (§5.1).
- **A3/A4 — non-resumable sessions** (`single` mode, or `multipart` with no
  provider id) resolve as `not_found`.
- **A5 — the resumed object key** is `buildObjectKey(contentHash, <canonical
extension of the MIME>)` (`image/jpeg` → `jpg`). The pins match the key by
  `/bkt-a1/images/<64-hex>.<ext>` so any extension choice passes; a
  `fileName`-derived extension agrees for `.JPG`.
- **A6 — the session lookup accepts `status` `pending` _or_ `in_progress`.**
- **A7 — `quota.storage.requestedBytes` counts only the files that still need
  bytes** (`not_found` + `in_progress`); `completed` duplicates need none and
  `rejected` files will never be sent. `quota.images.requested` counts the same
  set per file.
- **A8 — `upload_sessions` is the schema's `uploadSessions` (§16.2)**, so the
  GREEN registers `COLLECTIONS.uploadSessions = "upload_sessions"`; the unused
  `COLLECTIONS.uploads` literal is left alone.
- **A9 — an upstream `ListParts` failure fails the whole call (`502
bad_gateway`)** rather than guessing `not_found`, which would make the client
  re-send bytes that may already be stored.
- **A10 — an invalid `batchId` is a field-level `422`** naming `batchId`; a hash
  that is not 64 lowercase hex is the same refusal (the client's hashing step is
  broken), rather than a per-file rejection.
- **A11 — the pre-check adds no rate-limit stage beyond the `upload.resolve`
  class that already exists**; the pins assert nothing about headers.

## Open items handed to the GREEN

1. Register `COLLECTIONS.uploadSessions = "upload_sessions"` and declare the
   §16.2 indexes (`{tenantId, createdByUserId, contentHash}`,
   `{eventId, batchId, status}`, the `in_progress` partial, the `expireAt` TTL).
2. Append `upload_window_closed` (`409`) to `MEDIA_ERROR_CODES` +
   `MEDIA_ERROR_TRANSPORT`.
3. Give the admission seam a `segmentFromEnd` option (D3).
4. `/api/v1/uploads/config` serves `partSizeBytes`, `presignTtlSeconds`,
   `maxConcurrentParts` and `hashAlgorithm` from the contract's fixed values —
   `platformSettings.upload` carries only the three byte/MIME tunables.
5. Log the per-state counts at `info` and never a file name (the pins prove the
   negative is non-vacuous by requiring at least one `info` entry).

## Findings for later lanes (not this card's scope)

- **F1 (Medium, OP-112 adapter).** The R2 adapter's `listParts` refuses an
  _empty_ part list: the SDK omits `NextPartNumberMarker` when no `<Part>`
  element is present, `Number(undefined)` becomes `NaN`, and the Zod schema
  reports a contract violation. A multipart upload created but not yet started
  therefore cannot be listed — exactly the most common resume. The pins
  therefore cover `uploadedPartNumbers: []` at unit level only (U1) and the
  integration resume case uses parts that exist. A follow-up in the media
  foundations lane should decide whether zero parts is a legal port answer.
- **F2 (Low).** `file_too_large`'s pinned message names "100 MB" while the limit
  is a setting; a deployment that tunes `maxFileBytes` needs a dynamic message.

## Evidence

Head: worktree `/root/openpic/openpic-webapp/.worktrees/t_28054285`, trunk `5f28acd`.
Every figure below was measured on that head.

- **RED, honest.** With no implementation the unit spec fails with
  `Cannot find package '@/server/uploads/batch-resolve'` (`Tests no tests`) and
  the integration spec with
  `Cannot find package '@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/batch-resolve/route'`;
  `tsc -p apps/web/tsconfig.json --noEmit` reports exactly three errors and
  nothing else — the three TS2307s for the pure module and the two route
  modules. No harness, fixture or helper import is broken.
- **Type-correct.** With throwaway stubs at the three pinned paths (a
  wrong-semantics pure module plus two `500` route handlers)
  `tsc -p apps/web/tsconfig.json --noEmit` exits **0** — so the whole type
  surface the specs assume (including `UploadPolicy`, `BatchFileClaim`,
  `ResolutionInput`, the four-member `UploadResolution` union and both route
  signatures) is accepted as written. The stubs were then deleted and
  `git status` shows the two spec files + this ADR + the ledger only.
- **Failures are assertion-level, not harness errors.** With those stubs the
  unit spec ran **21 failed | 16 passed (37)** (`expected { state: 'not_found',
mode: 'single' } to deeply equal { state: 'completed', …(4) }`,
  `expected false to be true`) and the integration spec **22 failed (22)**
  (`expected 500 to be 401`, `expected 500 to be 200`, `expected 500 to be 413`,
  `expected 500 to be 502`). The integration failures prove the suite really
  boots `MongoMemoryReplSet`, signs a user in, seeds the workspace and reaches
  the route — a broken harness could not produce a `500 → expected 401` line.
- **Satisfiable — unit (measured this run).** A faithful throwaway of the pure
  module (reusing `UPLOAD_FORMATS` from `@/server/settings/upload-guards`)
  turned the unit spec **37 passed (37)**, so U1–U4 including the precedence,
  the exact rejection copy, the threshold-inclusive `mode`, the `null`-as-
  unlimited quota sentinel and all twelve `batchId` rows are satisfiable
  exactly as pinned.
- **Satisfiable — `GET /api/v1/uploads/config` (measured this run).** A
  faithful throwaway of the config route (`defineRoute` + `requireAuth("user")`
  - `getPlatformSettings({ db })`, `private, max-age=300`) turned that describe
    **3 passed | 19 skipped**, so the eight-key body, the settings-driven
    tunables, the cache header and the `401` are satisfiable as pinned.
- **Satisfiable — `batch-resolve` (recorded by this card's first attempt).**
  That attempt's probe made the full integration file **22 passed (22)** and
  this run re-verified its two halves that are cheap to reproduce (above); the
  route-level green itself was **not** re-run here, so the GREEN should treat
  the 19 `batch-resolve` cases as contract text rather than as an
  already-demonstrated pass.
- **Pins are load-bearing (recorded by the first attempt).** Dropping
  `createdByUserId` from the session filter turned I1 red (`expected 502 to be
200` — the co-organizer resumed another user's upload), so the per-user scope
  is what I1 measures.
- **Corrections the probe forced in the pins:** `domain_events` is non-zero at
  the start of a test because sign-in emits two events (the read-only pin now
  compares counts), and an 8 421 310-byte claim is above the 8 MB threshold so
  I6's `not_found` mode is `single` only below it.

## Number allocation

This card had no reserved range on `main`; as the lane's first card it drew the
allocator's next block, **`0700`–`0719`**, from the `unallocated (future lanes)`
pool (ADR-0300 §7 — a dependent ticket does not continue its parent's range, so
OP-122 keeps `0680`–`0699` / `Next free 0682`). This record consumes **`0700`**
and advances the lane's `Next free` cell to `0701`; the pool row advances to
`0720`+.

## Consequences

- The pre-check's decision surface is one pure call, so a later lane can extend
  the resume UI (or the batch-progress endpoint) without touching the route.
- The `rejected` state is a client-facing contract: the exact copy is pinned, so
  a copy change is a spec change.
- F1 means the GREEN will see a `502` for a zero-part resume; the finding, not a
  weakened pin, is the record of that limitation.
