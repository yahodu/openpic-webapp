# ADR-0801 — OP-132 GREEN: the `selfies` TTL index and a kind-aware asset identity

- **Status:** Accepted
- **Consumers:** `apps/web/src/server/db/indexes.ts` — the `media_assets` dedupe
  key (`kind` second) and the new `selfies` TTL spec;
  `apps/web/src/server/uploads/complete-upload.ts` — both asset reads
  (`settledCompletion`, `existingAsset`) scoped to `kind: "event_image"`;
  `apps/web/src/server/attendee/selfie-submit.ts` — the purge claim read and the
  owner-row upsert scoped to `kind: "selfie"`. The pins it turns green are
  [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)'s consumers.
- **Lane:** the shared attendee block `0780`–`0798` is exhausted, so this record
  takes **`0801`** — the first number above every in-flight reservation at the
  cut (`origin/main` `55e665a` holds `0780`–`0794` and `0796`–`0799`; the two
  cells read `0801` after [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)).
  Both cells advance to `0802`. See §Consequences for the duplicate `0800` the
  sweep found, which is **not** this record's to renumber.
- **Amends:** [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)
  §Open questions 1–3 (all three are answered below) and
  [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md) §Consequences
  (the two admitted gaps are now closed).
- **Consumes:** `0801`.

## Context

The round-2 review of the OP-132 F1 GREEN routed two **Medium** schema-conformance
gaps; the TEST card `t_c1cf4306` pinned both (six cases, measured red) and this
record turns them green with **no test file touched**.

| pin (ADR-0800)                                                          | measured red before this change                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the registry declares one `selfies` TTL index, `[[expireAt, 1]]`, TTL 0 | `found 0` — no `selfies` index set existed at all                                                                                                            |
| no unique `media_assets` index is kind-blind                            | `media_assets_tenant_content_hash_unique` keyed `{tenantId: 1, contentHash: 1}`                                                                              |
| the organizer completion of the selfie's bytes answers `201`            | `500 internal_error`, `TypeError: … reading 'bytes'` at `toEventImage` ← `completeStoredUpload:331`, **after** the transaction committed; `refCount` `1 → 2` |
| two rows differing only by `kind` both insert                           | `E11000` on the same index                                                                                                                                   |

## Decision

### 1. One TTL spec on `selfies`, and no `TENANT_SCOPED_COLLECTIONS` entry

`INDEX_SPECS` gains exactly the declaration schema §16.4 lists and §22 assigns to
the TTL monitor (not to the application purge job): `keys: [["expireAt", 1]]`,
`expireAfterSeconds: 0`. The name follows the neighbouring
`downloadJobs_expire_at_ttl` / `notifications_expire_at_ttl` convention. The
field `insertQueuedSelfie` stamps and the field the database expires on are now
the same field, so a biometric row cannot outlive its deadline by construction.

`selfies` is **not** added to `TENANT_SCOPED_COLLECTIONS`: the set drives the
registry's U1 lint, which governs _compound_ indexes, and this index is
single-key on `expireAt`. Adding it would assert a convention no index in this
change relies on.

### 2. `kind` joins the dedupe key, and the index keeps its name

`media_assets_tenant_content_hash_unique` becomes `[tenantId, kind, contentHash]`
(still unique). Encoding (a) of ADR-0800 §2 is the one that landed. The
**name is kept** (ADR-0800 §Open question 3): `ensureIndexes` reconciles a
same-name definition change by drop-and-rebuild, but it never drops an index the
registry no longer declares — so a rename would leave the old two-key unique
index live on any database whose bootstrap does not run again, where it would go
on refusing exactly the kind-differing pair pin I4 requires. The record and the
index comment now say `(tenantId, kind, contentHash)`.

### 3. Every reader and writer of the tenant-wide hash names its own kind

Adding `kind` to the key makes any filter that omits it ambiguous: it can match
the other kind's row. Three sites are scoped, two of them pinned:

- `complete-upload.ts` — `settledCompletion` and the `existingAsset` read both
  add `kind: "event_image"`. This is the pinned fix: the completion now inserts
  its own descriptor-bearing row instead of projecting a selfie's
  descriptor-less one, so the `201` is honest and the `refCount` of the
  biometric row stays `1`.
- `selfie-submit.ts` — the owner-row upsert and the ADR-0798 purge-claim read
  both add `kind: "selfie"`. **Unpinned, and the answer to ADR-0800 §Open
  question 1**: the pins only drive the selfie-first order, but once `kind` is in
  the key a filter without it matches an organizer's `event_image` row — the
  submit would take a reference on it, and a purge in flight on the organizer's
  row would answer `409 selfie_purged` for the attendee's own asset. Naming the
  kind in the writer is what makes the index change sound in both orders, so it
  is part of this change rather than a speculative guard.

No refusal is added: ADR-0800 §3 pinned the collision as **success**, and the
tree now answers it.

### 4. The migration is an index rebuild, and it is a required deploy step

The `media_assets` key change is a **migration**. Per environment, after deploy,
run the bootstrap (`pnpm db:ensure-indexes`, i.e.
`scripts/db/ensure-indexes.ts`); `ensureIndexes` reports the definition change as
`db.indexes.reconciled` and drop-rebuilds the index under its existing name.

- **No duplicate can block the rebuild.** The old index already forbade two rows
  with the same `(tenantId, contentHash)`, so no `(tenantId, kind, contentHash)`
  triple can be duplicated on a collection that carried it.
- **No backfill and no row rewrite.** `kind` is a schema field every row already
  carries (`event_image`, `selfie`, `event_logo`, `export`, …), and the new key
  only _relaxes_ uniqueness (three keys cannot collide where two did not), so no
  existing row changes meaning.
- **The step is not optional.** A database whose bootstrap never runs again keeps
  the two-key index, and there the organizer's second row for a selfie's bytes is
  still refused `E11000` — the `500` this record removes. The `selfies` TTL is
  created by the same run (`db.indexes.created`), so one command covers both arms.

## Consequences

- The two gaps [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)
  §Consequences admitted are closed: the retention deadline is enforced by the
  TTL monitor, and an asset's identity includes its kind.
- Both orders of the collision now work: selfie-first is the pinned case, and
  organizer-first (ADR-0800 §5's unpinned hazard) is handled by construction,
  because each writer names its own kind and finds no row to corrupt.
- **§16.1's written key list is now stale.** The schema document still lists
  `{tenantId:1, contentHash:1}` unique; this record is the decision of record
  for the deviation, and the schema doc's owner should carry the `kind` key into
  it on its next revision. Not edited here: the schema document is product spec,
  and this lane's diff is the registry.
- The rest of the §16.4 `selfies` index set (`{profileId, isActive}`, the two
  `createdAt` reads, the processing lease pair, the reusable pair) stays
  undeclared, exactly as ADR-0800 §5 recorded. This change adds the TTL the
  schema assigns to this collection and nothing else.
- **Ledger finding, not this record's to fix:** the number `0800` is in flight
  **twice** — this lane's pins (PR #552) and the OP-133 soft-delete pins
  (`ADR-0800-op133-soft-deleted-image-and-null-preview-pins.md`, PR #551). The
  sweep required before minting was therefore not empty, which is why this
  record sits at `0801`; whichever of the two `0800`s lands second must renumber,
  and the reviewer owns that routing.
- `docs/adr/README.md` stays the shared-ledger hotspot: this row and the two
  `Next free` cells merge as a union keeping the highest value.
- No new module, so no coverage-threshold risk: the change is two index specs,
  two scoped reads and one scoped upsert, all exercised by the six pins and the
  seven frozen neighbour files.

## Alternatives

1. **A unique index made partial on `kind`** (ADR-0800's encoding (b)). Rejected:
   a partial filter fixes _one_ value, so the next kind needs its own index; the
   neighbouring `media_assets_tenant_kind_qr_cache_key` already carries `kind` as
   a key, so the key is the convention here.
2. **Rename the index to `media_assets_tenant_kind_content_hash_unique`.**
   Rejected for the reason in §2 — `ensureIndexes` never drops an undeclared
   index, so the old definition would survive where the bootstrap does not rerun.
3. **Refuse the collision (`409`/`422`) instead of serving it.** Rejected in
   ADR-0800 §3: it would bless a shared biometric asset row and make the
   erasure path reachable from an `eventImages` row.
4. **Guard only the projection in `complete-upload`.** Rejected: measured on the
   RED cut, the `refCount` moved `1 → 2` while the response 500ed, and pin I4
   would still answer `E11000` — a projection guard fixes neither arm.
