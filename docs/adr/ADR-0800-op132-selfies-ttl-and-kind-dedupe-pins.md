# ADR-0800 — OP-132 TEST: the selfies TTL index and the kind-aware asset dedupe are pinned

- **Status:** Accepted (RED / executable contract)
- **Consumers:**
  `apps/web/src/test/unit/selfie-attempts.test.ts` — the two appended cases
  (`the index set — the selfies retention TTL`, `the index set — asset identity
distinguishes kinds`) and their local reader `distinguishesKind`;
  `apps/web/src/test/integration/selfie-upload-collision.test.ts` — the whole
  file (three collision cases plus the index-invariant case I4) and its local
  harness (`seedRoomyPlan`, `submitAndConfirmSelfie`, `completeOrganizerUpload`,
  `assetRows`, `eventImageOf`).
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) was **exhausted** at the branch cut:
  `docs/adr` on `origin/main` `55e665a` holds `0780`–`0794` and `0796`–`0799`,
  and the last attendee record ([ADR-0799](ADR-0799-op133-preview-url-selfie-summary-pins.md))
  recorded that it drew `0799` from the head of the `unallocated (future lanes)`
  pool and advanced both cells to `0800`. Following that precedent this record
  draws **`0800`** — the first number unused on the trunk, on every open PR head
  (`#545` @ `add1a55`, `#539` @ `a5a8fe6`, neither carries an `ADR-08xx` file)
  and in every `.worktrees/*/docs/adr` (highest `0799`, none `0800`+). Both cells
  advance to `0801`. No new lane row is minted.
- **Amends:** [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)
  §Consequences "Known gap, routed" (the missing `selfies` TTL) and "Known
  limit, not pinned" (the tenant-wide, kind-blind dedupe key).
- **Consumes:** `0800`.

## Context

The round-2 review of the OP-132 GREEN (`t_fb098cce`, PR #546, squash `90110ee`)
routed two **Medium** schema-conformance gaps. The F1 GREEN
([ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)) made both
reachable: it stamps `expireAt` on every queued `selfies` row
(`apps/web/src/server/attendee/selfie-submit.ts:319`) and it writes the first
`kind: "selfie"` row into `media_assets` — a row that deliberately carries **no**
`storage` descriptor, because §16.1's `contentHash` _is_ the object key and the
bytes are erased with the selfie.

Measured on the branch cut (`origin/main` `55e665a`):

| probe                                                                      | result                                                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grep -c 'COLLECTIONS.selfies' apps/web/src/server/db/indexes.ts`          | `0` — no `selfies` index set exists, so §16.4's `{expireAt: 1}` TTL (`expireAfterSeconds: 0`) is absent from every environment                                             |
| organizer completion of the selfie's exact bytes (single-PUT, same tenant) | `500` `internal_error`; logged `TypeError: Cannot read properties of undefined (reading 'bytes')` at `toEventImage` (`event-image-dto.ts:69`) ← `completeStoredUpload:331` |
| the selfie's `media_assets` row after that completion                      | `{kind: "selfie", status: "stored", refCount: 2}`, still descriptor-less — the organizer path took a reference on the biometric row                                        |
| two `media_assets` rows differing **only** by `kind`, both inserted        | `E11000` on `media_assets_tenant_content_hash_unique`, `keyPattern: {tenantId: 1, contentHash: 1}`                                                                         |

The `500` is the worst shape of the defect: the completion's transaction has
**already committed** when the projection raises, so an `eventImages` row points
at an asset the gallery cannot render, and the uploader is told nothing usable.

This card (`t_c1cf4306`) is **pins only**: no production change, no edit to an
existing case, fixture or helper. The GREEN sibling `t_e6c45f3b` makes the pins
pass.

## Decision

### 1. The retention field is pinned as the index §22 names, not as a purge job

Case one asserts the **declared registry**: exactly one `selfies` TTL index,
`keys: [["expireAt", 1]]`, `expireAfterSeconds: 0`. §22 puts `selfies` in the
TTL column (`createdAt + 90 d` or event retention, whichever first) while it
explicitly assigns `eventImages`/`imageAnalyses`/`faceMatches`/`mediaAssets` to
an **application purge job** ("never TTL"), so the enforcement mechanism the
schema owes this collection is the TTL monitor, not a sweep. The pin therefore
does not require a job, and it does not name the index: the failure message
names the missing set, and the shape assertion is the same one the registry's own
U2 lint applies to every TTL index (`@/server/db/indexes.test.ts`).

A second property follows without a second case: the field the submit route
writes is now the field the database expires on, so a selfie row cannot outlive
its retention deadline by construction.

### 2. The dedupe key must distinguish kinds — either encoding is accepted

Case two asserts the **invariant**, not a name: no unique index on
`media_assets` may be kind-blind, i.e. two rows that differ only by `kind` must
not be forced to share one asset. Two encodings satisfy it and both are
accepted:

- **(a) `kind` as a key of the unique dedupe index** — `[tenantId, kind,
contentHash]`, which the unit reader accepts and which this lane expects,
  because the GREEN card names it first and the neighbouring
  `media_assets_tenant_kind_qr_cache_key` index already carries `kind`;
- **(b) a unique index made partial on `kind`** — the reader also accepts a
  `partialFilterExpression` that fixes `kind`.

Integration case **I4** then asserts the invariant behaviourally, so it is
encoding-agnostic: with `ensureIndexes(app.db)` having built the real registry,
two rows that differ only by `kind` must both insert. That is the case the
`E11000` above reddens, and its failure message quotes the offending index name
and `keyPattern`.

### 3. The collision is pinned as success, not as a refusal

The card allowed either "a second asset" or "a documented refusal". The tree
answers **neither** today — it answers `500`, which the contract has no code for
— so the pin asks for the outcome the schema describes:

- the completion answers **`201`** with the §5.3 `EventImage` DTO;
- the `eventImages` row's asset is a **different** row from the selfie's, is
  `kind: "event_image"`, and carries a `storage` descriptor whose `objectKey` is
  the content-addressed original (`images/<hash>.jpg`) and whose `bytes` is the
  stored size;
- the selfie's own asset row is **untouched** (`kind: "selfie"`,
  `status: "stored"`, `refCount: 1`, still no `storage` descriptor).

A refusal was rejected for three reasons: §16.1's dedupe exists to avoid storing
one organiser's duplicate twice, not to make an attendee's biometric asset serve
an organiser's gallery; ADR-0796 §3 keeps that row owner-scoped and
descriptor-less on purpose, so sharing it makes the erasure path reachable from
an `eventImages` row; and the upload is a legitimate first upload of that image
**to that event** (§16.3's `{eventId, assetId}` uniqueness is what refuses a
duplicate, and this event holds none).

The `refCount` arm is pinned separately from the descriptor arm because they
fail for different reasons and a fix can satisfy one without the other: on the
current tree the reference count moves (`1 → 2`) while the response 500s, so a
GREEN that only guards the projection would still hand the attendee's asset a
second reference.

### 4. Satisfiability was probed, not assumed

A throwaway near-fix was applied to three production files and reverted
(`sha256` equality per file plus `git diff` empty):

1. `indexes.ts` — the `selfies` TTL spec, and `kind` added to the
   `media_assets` unique key;
2. `complete-upload.ts` — both asset reads scoped by `kind: "event_image"`
   (`settledCompletion` and the `existingAsset` read);
3. `selfie-submit.ts` — the owner-row upsert scoped by `kind: "selfie"`.

| probe run                                                                                                   | result         |
| ----------------------------------------------------------------------------------------------------------- | -------------- |
| the two appended unit cases + `@/server/db/indexes.test.ts`                                                 | 2 files passed |
| `selfie-upload-collision.test.ts` (4 cases)                                                                 | 1 file passed  |
| frozen attendee specs (`liveness-selfie-submit`, `selfie-reuse`, `biometric-consent`, `selfie-submit-user`) | 4 files passed |
| frozen upload specs (`uploads-single-put`, `uploads-multipart`, `index-bootstrap`)                          | 3 files passed |

So no pin here is unsatisfiable by the minimal repair, and the repair does not
disturb a neighbour.

### 5. Deliberately not pinned

- **The reverse order** — an organizer upload of hash _X_ first, then an
  attendee's submit of the same bytes. That is a different route with a
  different observable (the selfie row would take a reference on a
  descriptor-bearing `event_image` asset), the card fixes the selfie-first order,
  and a GREEN that scopes the asset reads correctly on both sides makes it moot.
  Recorded in §Open questions instead of invented as a requirement.
- **The TTL's actual deletion.** MongoDB's monitor runs about once a minute and
  a spec cannot wait on it; the registry declaration plus the existing U2 lint is
  the honest, deterministic half. Same reasoning as §22's own note.
- **The `selfies` non-TTL indexes §16.4 also lists** (`{profileId, isActive}`,
  `{eventId, subject.userId, createdAt}`, the processing lease pair, the reusable
  pair). The card pins the TTL; the others are reads this lane does not change,
  and pinning them would over-constrain the GREEN's minimal diff.

## Consequences

- The GREEN has one sentence per arm: the retention deadline is enforced by the
  database, and an asset's identity includes its kind.
- **The unique-index change is a migration, and it is bounded.** `ensureIndexes`
  compares the whole definition, so a live database carrying
  `media_assets_tenant_content_hash_unique` **with the old keys and the same
  name** is `reconciled`: the index is dropped and rebuilt. The rebuild cannot
  refuse a duplicate, because the old index already forbade two rows with the
  same `(tenantId, contentHash)` — so no `(tenantId, contentHash, kind)` pair can
  be duplicated. The only per-environment step is running the bootstrap
  (`scripts/db/ensure-indexes.ts`).
- The comment at `apps/web/src/server/db/indexes.ts:387-389` ("the
  `(tenantId, contentHash)` unique index remains the only hard invariant")
  becomes stale with the fix and the GREEN owes it an update.
- `docs/adr/README.md` stays the shared-ledger hotspot: the attendee cell and
  the pool cell both move to `0801`, and the row plus the note merge as a union
  keeping the highest value.
- No number outside `0800` is touched, and no lane row is created.

## Alternatives

1. **Pin the purge job instead of the TTL.** Rejected: §22 assigns `selfies` to
   the TTL column, so a job is a second mechanism the schema does not ask for —
   and a job cannot be pinned cheaply by a unit spec.
2. **Pin the index name** (`selfies_expire_at_ttl`). Rejected: the invariant is
   "the field is enforced", and the registry convention already fixes the shape
   so the name carries no extra meaning for a reviewer.
3. **Pin a `409`/`422` refusal on the collision.** Rejected for the reasons in
   §3 — it would bless a shared biometric asset row, and the contract has no
   code for it (the tree answers `500`).
4. **Pin the descriptor only, not the `refCount`.** Rejected: measured, the
   current tree already moves the reference count, so a projection-only pin
   would pass a fix that leaves the attendee's asset referenced by an organizer
   upload.

## Open questions (for the GREEN `t_e6c45f3b`)

1. **Does `insertQueuedSelfie` get the `kind` filter too?** Its upsert filter is
   `{contentHash}` (tenant-stamped), so once `kind` joins the index it can match
   an organizer's `event_image` row and take the selfie's reference on it. The
   pins do not require it; the reverse-order hazard in §5 is why it matters.
2. **Which encoding lands** — `kind` in the unique key (expected) or a partial
   unique index? The record must name it, and a name that still says
   `content_hash_unique` while keying on three fields should be reconsidered.
3. **Does the drifted index keep its name?** `ensureIndexes` reconciles a
   same-name definition change by drop-and-rebuild, so keeping the name is safe
   in every environment; renaming it additionally leaves the old index live on a
   database where the bootstrap never runs again.
