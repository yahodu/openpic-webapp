# ADR-0721 — OP-124 GREEN: the single-PUT upload, its completion transaction and the link-only attach

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-124 GREEN (`t_bf46953d`) · **Branch:** `OP-124-task-single-put-complete-link-only-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_b8940223`, based on the OP-124 RED head `5d535ce` (branch `OP-124-task-single-put-complete-link-only-red`, PR #423), itself based on the OP-123 GREEN head `d4d3314` (PR #422, **unmerged** at the time of writing)
- **Relates to:** [ADR-0720](ADR-0720-op124-single-put-complete-link-only-red.md) (the pins this GREEN satisfies), [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md)/[ADR-0701](ADR-0701-op123-upload-config-batch-resolve-green.md) (the pre-check and the `upload_window_closed`/extension rules), [ADR-0009](ADR-0009-upload-type-guards.md) (the three-claim type guard), [ADR-0340](ADR-0340-op103-entitlements-red.md) (consume-inside-the-transaction), [ADR-0520](ADR-0520-op112-object-storage-port-red.md)/[ADR-0521](ADR-0521-op112-object-storage-port-green.md) (the `ObjectStorage` port), [ADR-0680](ADR-0680-op122-queue-port-red.md)/[ADR-0681](ADR-0681-op122-queue-green.md) (the queue port and `enqueueWork`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 (range allocation)
- **Contract:** API contract §5.1/§5.3/§4.4 + §0.15, schema §16.1–§16.3, §18.1/§18.2, §22

## Context

ADR-0720 pinned the transfer-and-register half of the upload story: `U1`/`U2`
(the two pure rules), `I1`–`I11` (the three endpoints and their refusals) and
`E1` (the journey through a real server). This record documents the
implementation choices the pins left open and the one schema deviation they
forced.

## Decisions

### D1 — the pure rules are modules, not route-local code

- `@/server/uploads/size-tolerance` — `sizeWithinTolerance`, integer arithmetic
  against the **declared** bytes (`diff × 100 ≤ declared`, boundary inclusive).
- `@/server/uploads/sequence` — `allocateSequence(counter)` with
  `events.sequence` as the **next** number to issue; a counter that is not a
  positive integer is `AppError("internal_error")`.
- `@/server/uploads/upload-window` — `uploadWindowClosed(input)` is the **one**
  window rule: closed now → refuse; a session that started before the close is
  judged against `platformSettings.upload.inflightGraceMinutes` instead. The
  default grace is **30** minutes, not 20: the pin closes the window 20 minutes
  ago and completes a session started an hour before it, so a 20-minute grace
  would sit exactly on the boundary and flake on any millisecond of drift.

### D2 — three routes, one attach path, per-asset atomicity

- `params` upserts the session on `{createdByUserId, contentHash, mode,
status: "pending"}` and answers the six §5.3 keys. `completeUrl` is the **path**
  (§5.3's own example), never an absolute URL.
- `complete` runs `HeadObject` → 1 % tolerance → magic-byte guard → **one**
  transaction → enqueue. The transaction re-reads the event, the asset and any
  existing join row on **every attempt**, so a retried attempt sees the winner of
  a race and answers `200` with the existing image instead of charging twice.
  The duplicate is resolved by the unique `{eventId, assetId}` index, which is
  `ensureIndexes`' own invariant, not a route-local check.
- `uploads:link` attaches each asset in **its own** transaction. The card says
  "same transaction pattern"; per-asset atomicity gives the same guarantee per
  image (consume, `refCount`, `sequence`, counters commit or abort together) and
  lets a racing link of one asset land in `skipped` without aborting the batch.
- The shared half — consume `images.per_event`, mint the sequence, insert the
  join row, advance the counters — is `attachImage()` in
  `@/server/uploads/registration`. Only `complete` passes `storageBytes`, because
  only `complete` moved a byte.

### D3 — `409 size_mismatch`, and the details it carries

`MEDIA_ERROR_CODES` gains `size_mismatch` and `MEDIA_ERROR_TRANSPORT` its
non-retryable `409` row (append-only, ADR-0540). `details` is
`{ declaredBytes, storedBytes }` — the contract leaves it unspecified; naming
both figures is what makes an operator's "which number was wrong" answerable
without a second request.

### D4 — the storage port's two new behaviours, and the memory adapter's presign

- The R2 adapter gains `getObjectRange` (a `GetObject` with an inclusive
  `Range: bytes=<start>-<end>`, used for the ≤64-byte prefix the guard sniffs)
  and `deleteObject` (the `415` cleanup; an absent object is a success, because
  `DeleteObject` is idempotent).
- The memory adapter gains `presignPut`, `headObject` and `deleteObject`. A
  presigned PUT is an **opaque token** URL on the app's own origin
  (`${APP_BASE_URL}/api/v1/test-support/storage/<token>`): the e2e client uploads
  from another process, so the URL must be `PUT`-able over HTTP and must name no
  hash, bucket or key (§0.15). The token registry lives in
  `@/server/storage/memory-presigns` — outside the adapter — because route
  handlers may not import adapters, and each entry holds a write-back closure
  into the store that minted it, so instances stay isolated.
- `GET`/`PUT /api/v1/test-support/storage/[token]` is gated exactly like the OTP
  read-back (`isTestOtpRouteEnabled`: `test`/`e2e` only, `404` elsewhere). A
  leaked writer would be a "store an object the completion will register"
  primitive.

### D5 — the queue composition root

`getWorkQueue()` (`@/server/queue/get-work-queue`) memoizes the adapter, mirroring
`getObjectStorage()`: the route enqueues through it and a spec claims from the
same instance. `getQueueRuntimeConfig()` in `@/server/config/env` is the one
place `QUEUE_PROVIDER`/`UPSTASH_*` are read, and it fails closed with a
`ConfigError` naming the missing variables on a non-`memory` selection.

### D6 — `uploadBatchId` may be a string

Schema §16.3 declares `uploadBatchId` as an `ObjectId` and contract §5.3's
examples are 24-hex, but §5.2 accepts a UUIDv4 and E1 sends one. `batchIdValue()`
therefore stores the `ObjectId` when the id is 24-hex and the client's string
otherwise. Recorded as a `shortcut:` in the module; the field goes back to
`ObjectId`-only when the client is constrained to 24-hex.

### D7 — the gallery read is minimal

`GET …/events/{eventId}/images` answers `{ data, page, summary }` newest-first,
projected through the same `EventImage` schema the completion returns.
`summary.total` is the page length, which is exact while `hasMore` is always
`false`; the event's `counters.imageCount` is not read (that second query bought
nothing the page does not already answer). The cursor, the filters and the
signed thumbnail URLs stay with the listing lane (`shortcut:` in the module).

### D8 — the session TTL index

`upload_sessions_expire_at_ttl` on `{ expireAt: 1 }`. OP-124 is the first lane to
write a session row, and without the index every abandoned upload leaks a
document for ever (schema §22).

## Consequences

- Three behaviours remain deliberately unpinned (ADR-0720 §Consequences): the
  session-ownership rule, `409 size_mismatch`'s details shape (D3 settles it),
  and the link-only window gate (A8 — not applied, as the pins require an open
  window).
- The card's §4 also names `multipart create` and `sign`. Those routes do not
  exist on this branch (no card has pinned them yet), so the window rule they
  owe is a call to `uploadWindowClosed`, not new code: when they land they must
  not re-derive the comparison.
- `docs/adr/README.md` is the shared-ledger hotspot: this lane takes `0721` from
  its own `0720`–`0739` range and advances its `Next free` to `0722`. If another
  lane lands `0721` first, renumber on the merge (ADR-0300 §7).

## Round 1 — the merge with `main` and the coverage gate

The branch merged `origin/main` (`c9c259c`, the OP-122 follow-up) with one
conflict, `docs/adr/README.md`, resolved as a union: OP-122's `Next free` keeps
main's `0684`, OP-123 keeps `0702`, OP-124 keeps `0722`, the pool keeps `0740`
and the ADR index rows are ordered by number. No number was renumbered.

The global branch gate then read **79.95 %** (threshold 80 %, after the OP-122
follow-up `main` sat at ~80.36 %): the three routes, the two services and the
memory adapter this lane adds carry ~40 branches the pins do not drive. The fix
is code, not tests — this card may not write one:

- the gallery stub's second query (`events.findOne` for `counters.imageCount`)
  is gone; `summary.total` is the page length (D7);
- the completion route parses its session segment with the shared
  `eventIdFromRequest(…, { segmentFromEnd: 2 })` instead of a private copy;
- the R2 adapter classifies a failed call through one `transportFailure()`
  helper and no longer special-cases a 404 that `DeleteObject` never returns;
- the presign registry hands back the writer alone (`contentType` was never
  read), and `getQueueRuntimeConfig()` drops its redundant `UPSTASH_*` checks.

A second merge (`3f39718`, PR #426, the OP-122 retry-position/containment
**pins**) hit the same `docs/adr/README.md` conflict and was resolved the same
way: OP-122's `Next free` keeps main's `0685`, the pool keeps `0740`, the index
rows are ordered by number. That PR is **test-only and RED on `main`**: four of
its eighteen cases (`memory` redelivering a nacked message after the one behind
it; the three poison-payload containment cases) pin behaviour that its own GREEN
card `t_1d32d0a2` owes. They fail identically here — the spec is byte-identical
to `main`'s and this branch touches no queue adapter — so they are inherited,
not caused by this lane; PR #425's `test_coverage` check therefore cannot be
green until `t_1d32d0a2` lands.

Evidence at the merge head: coverage **statements 91.55 % / branches 80.19 % /
functions 95.35 % / lines 91.82 %** (exit 0), `pnpm test:unit` 150 files /
2433 passed | 3 skipped, `pnpm test:int` 100 files / 947 passed before the
#426 merge (after it, the only four reds are that PR's inherited pins),
Playwright 27 passed (both projects, E1 included), `tsc` ×3 exit 0, ESLint 0
errors, `prettier --check` clean.
