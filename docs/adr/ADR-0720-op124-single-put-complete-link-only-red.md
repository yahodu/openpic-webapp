# ADR-0720 — OP-124 RED: the single-PUT upload, the completion transaction and the link-only attachment pinned

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-124 RED (`t_b8940223`) · **Branch:** `OP-124-task-single-put-complete-link-only-red` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_b8940223`, based on the OP-123 GREEN head `d4d3314` (branch `OP-123-task-upload-config-batch-resolve-green`, PR #422, **unmerged** at the time of writing)
- **Relates to:** [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md)/[ADR-0701](ADR-0701-op123-upload-config-batch-resolve-green.md) (the pre-check this completion path follows), [ADR-0009](ADR-0009-upload-type-guards.md) (the extension/MIME/magic-byte guard), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the consume-inside-the-transaction rule), [ADR-0580](ADR-0580-op112-object-storage-port-red.md)/[ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the `ObjectStorage` port), [ADR-0680](ADR-0680-op122-queue-port-red.md)/[ADR-0681](ADR-0681-op122-queue-green.md) (the queue port and `enqueueWork`), [ADR-0540](ADR-0540-op114-branding-upload-red.md)/[ADR-0541](ADR-0541-op114-branding-upload-green.md) (the append-only per-domain error-table shape and the single byte-accepting endpoint), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 (range allocation)
- **Contract:** API contract §5.1/§5.2/§5.3 + §4.x (`GET …/images`), schema §16.1–§16.3, §14.2, §18.1/§18.2
- **Consumers:** the OP-124 single-PUT pure rules and the specs that pin them —
  modules `apps/web/src/server/uploads/sequence.ts`, `apps/web/src/server/uploads/size-tolerance.ts`;
  specs `apps/web/e2e/uploads-single-put.spec.ts`,
  `apps/web/src/test/integration/uploads-single-put.test.ts`,
  `apps/web/src/test/unit/uploads-sequence.test.ts`,
  `apps/web/src/test/unit/uploads-size-tolerance.test.ts`.

## Context

OP-123 pinned and implemented the upload **pre-check** (`GET /uploads/config`,
`POST …/uploads/batch-resolve`). OP-124 is the transfer and registration half of
the same story: the single-PUT presign, the completion transaction that makes
storage billing and gallery state agree, and the link-only attachment for bytes
the tenant already stores. The card lists U1, U2, I1–I11 and E1.

This record fixes the parts of that contract the card left open, records the
three throwaway implementation probes used to prove the pins are satisfiable and
load-bearing, and names the gaps handed to the GREEN.

## Decisions

### D1 — two pure helpers, in the lane's existing `@/server/uploads/` module

- `sizeWithinTolerance({ declaredBytes, storedBytes })` (U1). The percentage's
  base is the **declared** `bytes` — the number the client sent — so the rule is
  `|stored − declared| × 100 ≤ declared`, integer arithmetic, boundary
  **inclusive**. A stored size that only agrees under the _stored_ base
  (`declared 10 000`, `stored 10 101` → 0.9999 % of stored) is refused, which is
  the case that tells the two readings apart.
- `allocateSequence(counter)` (U2) answers `{ sequence, nextCounter }`.
  `events.sequence` is the **next** number to issue: creation seeds `1` with
  zero images (§4.1), so a fresh event's first image is `sequence: 1` and the
  counter is left at `2`. A counter that is not a positive integer cannot come
  from a healthy row (creation seeds `1`, only `$inc` by a positive integer
  moves it), so the helper throws `AppError("internal_error")` rather than
  minting `0`, a duplicate or a fractional ordering key.

### D2 — three routes, one transaction shape

- `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/params`
  (idempotency **required**) answers exactly
  `{ uploadSessionId, method: "PUT", url, headers, expiresAt, completeUrl }`
  and upserts one `upload_sessions` row keyed on
  `{tenantId, createdByUserId, contentHash}` (`mode: "single"`, `status:
"pending"`, the 5-day `expireAt`). §0.15 holds at the _field_ level: the
  answer carries no `bucket`, `objectKey` or `locationKey` field, and only the
  opaque presigned `url` — which for a path-style R2 endpoint necessarily
  contains the bucket and key inside the URL string, exactly as the contract's
  own note says ("only the opaque presigned URL").
- `POST …/uploads/{uploadSessionId}/complete` (idempotency **required**):
  `HeadObject` → 1 % size check → magic-byte guard → **one** transaction
  (`consumeEntitlement` ×2, `media_assets` upsert with `$inc refCount`,
  `event_images` insert with the event's next `sequence`, `events.counters`
  `$inc`, session `completed`) → after the commit, one `enqueueWork` pointer.
  `201` returns the `EventImage` DTO; the duplicate `{eventId, assetId}` insert
  answers `200` with the existing image.
- `POST …/uploads:link` (`{ batchId, assetIds }`): the same transaction shape
  **without** `storage.bytes` — no byte moved, so only `images.per_event` is
  consumed and only `refCount`/`sequence`/`counters.imageCount` move. An asset
  already attached to this event, or one this tenant does not hold, lands in
  `skipped` instead of failing the batch (the response is the only oracle the
  caller gets, and it names only what it was given).

Admission offsets: the event id sits **3** segments from the end on
`…/uploads/params`, **4** on `…/uploads/{id}/complete`, and **2** on
`…/uploads:link` (the default), so the shared seam is
`eventActorAdmission(3)`, `eventActorAdmission(4)` and the default. The three
routes cannot use `requireTenantScope` — an admitted co-organizer holds no
`tenantMembers` row and that helper refuses an undefined `tenantRole`; they read
`ctx.tenantId`/`ctx.principal` directly, exactly as the OP-123 route does.

### D3 — the counters belong to the **event's** tenant

Both consumptions name the `{tenantId}` path segment, never the caller's own
workspace. A co-organizer who owns another tenant moves only the event tenant's
`storage.bytes`/`images.per_event`, and is refused with the **event tenant's**
limit (`403 plan_limit_exceeded`, `details.entitlementKey: "storage.bytes"`) even
while their own plan has room. `images.per_event` is `scope: "event"`, so its
usage is the event's own `counters.imageCount` and it writes no `usageCounters`
row; `storage.bytes` is `scope: "tenant"` and does.

### D4 — a new media error code: `409 size_mismatch`

`MEDIA_ERROR_CODES` gains `size_mismatch` and `MEDIA_ERROR_TRANSPORT` its `409`,
non-retryable row, in the append-only per-domain shape ADR-0540/ADR-0701
established. The GREEN owes both files; `details` is left unspecified by the
contract and therefore unpinned (the probe carried
`{ declaredBytes, storedBytes }` as one defensible shape).

### D5 — the queue is resolved through a memoized composition root

The completion enqueues its `event_image` work item through
`getWorkQueue()` (`@/server/queue/get-work-queue`), mirroring
`getObjectStorage()`/`getPaymentProvider()`: **memoized**, because the route
stores through it and a spec (or a sweep) reads back through it, and a fresh
adapter per call would lose the pointer. I6 spies on that instance's
`enqueue`, so the pin is red if the route builds its own adapter.

`enqueueWork` logs `queue.enqueue_failed` only when its optional `logger` is
supplied, so the route must pass `getLogger()`; §18.1 makes the failed enqueue a
`warn`, never a silent no-op.

### D6 — the storage port gains two behaviours, and the memory adapter gains four

The integration suite boots `STORAGE_PROVIDER=s3` against MSW (the card's "MSW
HeadObject"), so the completion can only learn the stored size and the stored
bytes from the wire. That forces the R2 adapter's `headObject` (exists),
`getObjectRange` (the ≤64-byte prefix the guard sniffs) and `deleteObject` (the
415 cleanup) — the last two are `not_implemented` today.

E1 runs in the e2e's **memory** provider, whose presigned URL must be
_PUT-able over HTTP_ by a client in another process. The shape that keeps §0.15
intact is an **opaque token**: `presignPut` answers
`${APP_BASE_URL}/api/v1/test-support/storage/<token>` (no hash, no key, no
location in the URL), the token maps in-process to `{locationKey, objectKey,
contentType, expiresAt}`, and a test-only `PUT` route writes the body into the
same memoized store and answers an `ETag` like S3 does (the client echoes it on
completion). The route is gated exactly like the OTP read-back
(`isTestOtpRouteEnabled`): `test`/`e2e` only, `404` everywhere else. The memory
adapter also needs `headObject`, `getObjectRange` and `deleteObject`.

### D7 — the e2e's gallery read is a _minimal_ `GET …/images`

E1 ends with "GET images lists it". That route does not exist yet and the
integration suite does not pin it (only the e2e drives it), so the GREEN owes a
**minimal** §4.x projection: `200 { data, page, summary }`, newest first, each
item `{ id, sequence, processing, … }`, `summary.total` the event's image count.
The full listing lane (cursor, filters, signed thumbnail URLs, width/height) is
**out of scope** here and must not be blocked by this record.

## Assumptions

- **A1** — `images.per_event` is `scope: "event"` and reads the event's
  `counters.imageCount` as its usage (the entitlement service writes no counter
  row for a non-tenant scope); `storage.bytes` is `scope: "tenant"`.
- **A2** — `events.sequence` is the next number to issue (see D1/U2).
- **A3** — `batchId` fixtures are 24-hex ids, so `String(row.uploadBatchId)`
  matches whether the implementation stores an `ObjectId` (schema §16.3) or the
  client's string.
- **A4** — `409 size_mismatch` is a NEW code the GREEN owes (D4).
- **A5** — the object key's extension is derived from the session's declared
  MIME (`image/heic` → `.heic`), the rule ADR-0701 A5 already uses for resume.
- **A6** — session **ownership** is not an authorization gate: any admitted
  event actor may complete a session (the object is content-addressed, so the
  hash is the identity). Deliberately unpinned; flagged for review.
- **A7** — the upload window also applies to `complete`: a session created
  **after** the close may not complete (`409 upload_window_closed`), and a
  session created before the close may finish inside
  `platformSettings.upload.inflightGraceMinutes` (a new setting key the GREEN
  owes on `platformSettings.upload`; the pins only require a grace of at least
  20 minutes, so any documented default ≥ 20 satisfies them — the probe used the
  value the settings schema must carry).
- **A8** — the link-only route is **not** additionally gated by the upload
  window (the contract says nothing; the pins keep an open window).

## Evidence

Measured on this worktree, `TMPDIR=/root/tmp-mongo` where Mongo is needed.

### RED, no implementation (the state this branch ships)

- `npx tsc -p apps/web/tsconfig.json --noEmit` → exactly five new `TS2307`s for
  the modules the pins demand (`@/server/uploads/size-tolerance`,
  `@/server/uploads/sequence`, `@/server/queue/get-work-queue`, the three route
  modules) plus one `TS7006` that disappears the moment `getWorkQueue` resolves.
- `npx vitest run --project unit <both>` → `Test Files 2 failed (2)`,
  `Tests no tests`, each an honest
  `Cannot find package '@/server/uploads/size-tolerance'` /
  `… '@/server/uploads/sequence'`.
- `npx vitest run --project integration <spec>` → `Test Files 1 failed (1)`,
  `Cannot find package '@/app/api/v1/…/uploads/[uploadSessionId]/complete/route'`.

### Type-correctness and satisfiability probe (throwaway, deleted)

Minimal stubs at the exact intended paths: `tsc` exit `0`; every integration
case failed at assertion level (`expected 500 to be 201`, `expected 500 to be
401`, …) — `24 failed (24)` — and the unit specs `10 failed | 11 passed (21)`
(a permissive stub passes exactly the "true" cases).

A faithful throwaway implementation (both pure helpers, the three routes, the
memoized queue root, the R2 adapter's `getObjectRange`/`deleteObject`, the
`size_mismatch` catalogue append) then ran **unit `21 passed (21)`** and
**integration `25 passed (25)`**, repeated 4× at `25 passed (25)` with no flake.
The two probes also corrected two pins before handoff:

- the idempotent **replay** of `params` answers `200`, not `201` (§0.9
  `replayedStatus` rewrites a stored `201`) — the pin now expects `200`;
- the duplicate-asset **race** cannot pin the loser's status (a retried
  transaction may exhaust its budget before the winner commits), so I4 is split
  into a deterministic duplicate pin (a seeded existing `event_images` row →
  `200`, no second charge) and a race pin that asserts the invariants (never
  `409`, exactly one `201`, one row, one charge, one image id).

### Mutation probes (each restored byte-identically)

| Mutation                                | Result                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| U1: `≤` → `<` on the tolerance boundary | `3 failed of 12` — `expected false to be true` on the three exact-1 % cases                                  |
| U2: `counter` → `counter + 1`           | `1 failed of 9` — `expected { sequence: 2, nextCounter: 3 } to deeply equal { sequence: 1, nextCounter: 2 }` |
| I1: drop the `storage.bytes` consume    | `1 failed of 25` — `expected +0 to be 8192`                                                                  |

### E1 (Playwright)

`npx playwright test -c apps/web/playwright.config.ts --list` registers the spec
(27 tests / 25 files, `uploads-single-put.spec.ts` among them). It is **not
executed on this branch**: `next build` typechecks the whole project, so a RED
branch whose route modules do not exist cannot produce a standalone server
(the lane's RED-by-design rule). E1 executes on the GREEN's PR, which is where
the memory adapter's presigned-URL route and the minimal `GET …/images` land.

## Consequences

- The GREEN must base its branch on **this pins branch**, not on
  `origin/main` — `origin/main` has neither the OP-123 modules nor these pins,
  and this branch is itself based on the OP-123 GREEN head (`d4d3314`, PR #422).
  When #422 lands first, merge `origin/main` into this branch rather than
  re-cutting it.
- `docs/adr/README.md` is the shared-ledger hotspot. This record takes
  `0720`–`0739` from the `unallocated (future lanes)` pool (a dependent ticket
  does not continue its parent's range, ADR-0300 §7) and advances the pool cell
  `0720`+ → `0740`+. The pool cell is read on this branch's base, where OP-123
  already holds `0700`–`0719`; if another lane lands `0720` first, renumber on
  the merge (ADR-0300 §7).
- Three behaviours are deliberately **not** pinned and are handed to review: the
  session-ownership rule (A6), `409 size_mismatch`'s `details` shape (D4), and
  the link-only window gate (A8).
