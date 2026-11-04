# ADR-0623 — OP-118 GREEN: the QR cache hides the render, is kind-scoped, and absorbs the racing upsert

- **Status:** Accepted
- **Date:** 2026-11-04
- **Ticket:** OP-118 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_d0ac3946` (tdd_stage GREEN, implementer; the pre-created child of
  the round-1 pins card `t_0be9980d`)
- **Branch:** `OP-118-feature-qr-cache` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_d0ac3946`, based on the pins head
  `0b5f28a` off `origin/main` `21c77d7`)
- **Supersedes nothing.** Consumes `0623` of the OP-118 lane range `0620`–`0639`
  (ADR-0300 §7); the preceding records are
  [ADR-0620](ADR-0620-op118-access-links-qr-red.md) (the pins contract),
  [ADR-0621](ADR-0621-op118-access-links-qr-green.md) (the first GREEN) and
  [ADR-0622](ADR-0622-op118-qr-cache-pins.md) (the round-1 pins this card turns
  green).

## Context

`GET /api/v1/events/{eventId}/access-links/{slug}/qr` cached its rendered image
by the **content hash** of the bytes, but it computed that hash by rendering
first — so the cache saved storage, not work (F2). It also matched
`{ tenantId, contentHash }` without `kind: "export"` on both the read and the
upsert, so a `mediaAssets` row of another kind holding identical bytes was reused
as the QR cache and stamped with `qrUrl`/`qrExpiresAt` (F3). Round 1 of the
review additionally noted that the upsert's loser in a true first-time race can
surface `E11000` from `media_assets_tenant_content_hash_unique` as a `500` (F4).

ADR-0622 pinned F2 and F3 (test-only) and handed the implementation to this
card.

## Decision

### 1. A render-free cache key on `mediaAssets`

A new additive, tenant-scoped field `mediaAssets.qrCacheKey` holds the request
identity `(eventId, slug, format, size)` — a colon-joined string
`"<eventId>:<slug>:<format>:<size>"`, built by the pure `qrAssetCacheKey`
helper. The route reads the cache row **before** calling `renderQrCode`:

```
findOne({ tenantId, kind: "export", qrCacheKey })
```

A valid stored signed URL ends the request there: no render, no re-sign, and the
repeat body is byte-identical (`url` **and** `expiresAt`, `exp` included, which
is what `I2` pins). The bytes' identity stays **content-addressed**: the row
still carries `contentHash` and the object is still stored under
`buildObjectKey(contentHash, ext)`, so the stored object count, the `/o/<hash>.<ext>`
URL, and the object-key shape are what the existing pins assert.

An expired stored URL is treated as a miss and re-rendered: re-signing without
rendering was not pinned, and the render path already recomputes the content
hash, reuses the existing row (matched by `kind: "export"` + `contentHash`) and
only rewrites `qrUrl`/`qrExpiresAt`. (A row that predates the field has no
`qrCacheKey`; the first request after the change re-renders once and stamps it.)

### 2. `kind: "export"` on both filters

Both the render-free read and the content-hash read/upsert now carry
`kind: "export"`, so a foreign-kind row is neither matched nor rewritten. The
`$setOnInsert` still writes `kind: "export"`, so the row a QR request creates is
unchanged in kind.

### 3. Absorbing the racing `E11000`

The upsert moves into `upsertQrExportAsset`, which retries the same upsert once
(a true race's loser then matches the winner's row and reconciles) and swallows a
**second** `E11000`. The second failure is the F3/Low case: the
`(tenantId, contentHash)` unique slot is held by a row of another `kind`, so no
`export` row can ever exist for those bytes. The answer still serves the bytes
with a freshly signed URL; only the QR cache row cannot be written. A
non-duplicate error is re-thrown.

### 4. A supporting index

`media_assets_tenant_kind_qr_cache_key` on `(tenantId, kind, qrCacheKey)`
(non-unique) is added to `INDEX_SPECS` so the render-free read is a keyed lookup
rather than a collection scan. `media_assets_tenant_content_hash_unique` remains
the only hard invariant.

## Evidence at handoff

- Focused spec `event-access-links.test.ts` — **16 passed (16)**: the two new
  pins green and the original 14 untouched.
- The two new pins were RED on the pins head for the reported reasons
  (`expected "renderQrCode" to be called 1 times, but got 2 times`;
  `expected 'https://pic.openpic.in/o/f54025ef…' to be undefined`) before this
  change.

## Alternatives considered

- **Scope the unique index by `kind`** (so an `export` row could coexist with the
  byte-identical `thumbnail` row). Rejected: it changes a shipped, load-bearing
  invariant (`media_assets_tenant_content_hash_unique` is the §16.1 dedupe key
  for every kind) to fix one cache's edge case, and it would make the same bytes
  storable twice under one tenant — the opposite of "dedupe".
- **Keep the content hash as the only cache key and render to compute it.**
  Rejected: that is exactly F2.
- **Store the cache key on the `events.accessLinks[]` element.** Rejected: it
  writes the event document on a read-shaped download and spreads cache state
  across collections; the `mediaAssets` field keeps the cache in one place.

## Consequences

- `qrCacheKey` is additive; a pre-existing `export` row without it is
  re-rendered once and then cached by key. No migration is required.
- F4 is absorbed as a precondition of F3, not as an independently pinned race
  (ADR-0622 records the same observation).
- `docs/adr/README.md` is the shared-ledger hotspot: the lane's `Next free` cell
  advances from `0623` to `0624` and merges as a union keeping the highest cell.

## Coverage gaps handed to the Test Author

- The expired-qrUrl re-sign path (the stored URL past its `exp`) is still
  unpinned; the implementation re-renders there.
- `format=pdf` / `svg` rendering shape and the true concurrent-upsert race (two
  simultaneous first-time requests) remain unpinned.
- The new index's effect on query plans is not asserted anywhere.
