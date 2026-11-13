# ADR-0796 — OP-132 GREEN: the selfie's owner row, its retention deadline and the purge path on withdrawal

- **Status:** Accepted
- **Consumers:** `apps/web/src/server/attendee/selfie-submit.ts`,
  `apps/web/src/server/attendee/request-event.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/selfies:reuse/route.ts`,
  `apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts` and
  `apps/web/src/test/integration/liveness-selfie-submit.test.ts` (the F1 pins and,
  from ADR-0797, the F-A2 pins).
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), `Next free` read as `0796` at the renumber
  on `OP-132-task-selfie-asset-erasure` (`51c42f9`). This record first took
  `0793`, which the OP-133 gallery lane (`ADR-0793-op133-attendee-gallery-red.md`,
  PR #545, plus `0794` in the same worktree) already held in flight; round-1
  review F-A1 measured that the second of the two merges reddens the ADR
  numbering guard, so it moved to `0796`. A sweep of `docs/adr`, every
  `.worktrees/*/docs/adr` and every open `OP-13x` PR head finds no `ADR-0795`
  through `ADR-0799` and no `ADR-0796`, so this record takes `0796`; the ledger
  cell advances to `0797`.
- **Amends:** [ADR-0791](ADR-0791-op132-liveness-selfie-red.md) §6 — the three
  F1 pins (card `t_dd9cbd7c`) this record turns green; and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) §3, whose submit
  transaction left `assetId: null` and wrote no `expireAt`.
- **Consumes:** `0796`.

## Context

F1 (High) of the OP-132 round-1 review: a submit stored the selfie's bytes at
`originals/selfies/<sha256>`, but the queued `selfies` row carried
`assetId: null`, no `mediaAssets` row existed for the hash and no `expireAt` was
stamped. The OP-131 withdrawal (`DELETE …/consent`) releases the references that
deleted selfie rows hold, so it deleted the rows and left the biometric object in
storage until the bucket's own lifecycle rule — an incomplete erasure.

ADR-0791 §6 fixed the executable contract; the three pins live in
`apps/web/src/test/integration/liveness-selfie-submit.test.ts` (`:862`, `:889`,
`:914`). This record states the choices the pins leave to the implementation.

## Decision

### 1. One `mediaAssets` row per `(tenant, content hash)`, written with the row

`insertQueuedSelfie` now upserts the owner row before inserting the selfie, in
the caller's transaction:

```js
findOneAndUpdate(
  { contentHash }, // tenantRepo stamps tenantId
  {
    $setOnInsert: { _id, tenantId, contentHash, kind: "selfie", status: "stored", createdAt },
    $inc: { refCount: 1 },
  },
  { upsert: true, returnDocument: "after", projection: { _id: 1 } }
);
```

The `(tenantId, contentHash)` unique index (`mediaAssets_tenant_content_hash_unique`)
is the only arbiter: a repeat submit of the same bytes — a second attempt, or
`…/selfies:reuse` in the same tenant — increments `refCount` to 2 and reuses the
id instead of creating a second row. One `$inc` serves both directions because it
creates `refCount: 1` on insert and increments otherwise; `$setOnInsert` must not
also name `refCount` (MongoDB refuses two operators on one path).

The selfie row stores that id as its `assetId` (§16.4 "The image").

**No `storage` sub-document is written.** §16.1 calls `contentHash` "the object
key" and §6.3's submit body names only the hash, so `selfieObjectKey()` derives
`selfies/<sha256>` from it. A descriptor that repeated the derivation could drift
from it, and the erasure path must not depend on a slot that seeded or legacy rows
do not carry (the OP-131 fixture at `biometric-consent.test.ts:603-611` has no
`storage`; reading it there makes the withdrawal answer `500`, measured by the
reviewer).

### 2. `expireAt` is a property of the queued row: `createdAt + 90 d`, capped by the event

`selfieExpireAt(createdAt, eventRetentionExpiresAt)` returns the earlier of
`createdAt + SELFIE_RETENTION_DAYS` (`90`) and the event's own
`retentionExpiresAt`. §22 states the window as "`createdAt + 90 d` or event
retention, whichever first".

No `retention.*` setting names a selfie window — the settings schema carries
notification, dispatch, domain-event, webhook, attendee-session and
upload-session windows only — so the 90 days is the schema's constant, raised as
`SELFIE_RETENTION_DAYS` rather than inlined. The event's deadline is read from the
row `resolveEventBySlug` already loads (the projection gains one field), so the
cap costs no extra round trip. `ResolvedEvent` now carries it, and both callers
(submit and reuse) pass it through.

Retention is stamped at queue time, not at confirmation: the pin asserts a
still-`queued` row. Confirmation does not move the deadline — a confirmed selfie
is not kept longer than an abandoned attempt.

### 3. Withdrawal releases the references and deletes the blob at zero — synchronously

The pins require the bytes to be gone when the `204` is answered, so the
withdrawal deletes the object itself; the lazy-purge reading of the OP-131 route
comment does not satisfy `getObject` rejecting `not_found`. The route's contract
is unchanged: still `204`, still the same `X-Deleted-Counts`, the asset row is
**not** deleted (the OP-131 case pins it surviving at `refCount: 0`).

The release is per reference, not per asset: the map counts the selfie rows each
asset id appeared on, and one `$inc` applies the count under the same
`refCount: { $gt: 0 }` guard. A selfie and its reuse are two references to one
asset in one profile, and releasing one would leave the object tagged live
forever.

The object key is derived — `deleteObject(SELFIE_LOCATION_KEY, selfieObjectKey(asset.contentHash))`
— never read from `storage` (see §1). The delete runs only when the post-inc
`refCount` is `<= 0`, and only for an asset the `> 0`-guarded update still
matched, so an already-released or missing row purges nothing.

`shortcut:` the update and the object delete are two calls, so a concurrent
submit that re-references the hash between them could lose its blob. Acceptable
while the same bytes are only re-referenced by the same subject's own attempts;
if cross-subject reuse of one tenant's hash ever becomes a normal path, gate the
delete on a conditional `status: "purged"` write instead.

## Consequences

- `DELETE …/consent` now erases the biometric object as well as the rows, so the
  attendee's "delete my data" is complete for selfies.
- Every submit writes one extra `mediaAssets` document (or one increment), inside
  the existing transaction; no new round trip on the request path except the
  reads `resolveEventBySlug` already made.
- A selfie asset carries no `storage`/`derivatives`/`imageMeta` — a future purge
  job or thumbnail lane must derive the key from `contentHash`, exactly as the
  erasure path does.
- The window is 90 days and the event cap can only shorten it; the pin does not
  bound the duration (`t_26ab6dd7` adds that pin), so a future change of the
  constant is a one-line edit.
- **Known gap, routed (F-A2, High):** the withdrawal deletes the rows and _then_
  purges the blob, so a transient `deleteObject` failure answers `500` with the
  consent un-withdrawn; the retry then finds no `selfies` rows, derives no
  references, answers `204` and leaves the object readable. Fixing that ordering
  needs the pin the reviewer routed to `t_c146a82e` → `t_0f7341d7`; the pin this
  record turns green reads the object back after the `204`, so the delete has to
  stay on the withdrawal path.
- **Known gap, routed:** `expireAt` is written on every queued selfie, but
  `apps/web/src/server/db/indexes.ts` carries **no** `selfies` index set, so the
  §16.4 `{expireAt: 1}` TTL does not exist yet — the deadline is inert until that
  index is added. It is left out here because no case pins it and the index set is
  the Test Author's to pin; reported in the handoff.
- **Known limit, not pinned:** the tenant-wide `(tenantId, contentHash)` unique
  index does not include `kind`, so an organizer uploading bytes that an attendee
  already submitted as a selfie resolves to the **selfie** row, which has no
  `storage` slot, and `uploads/complete-upload.ts` reads `existingAsset.storage`
  unguarded. Same-hash collisions between a probe image and an event image were
  impossible before this record (no `kind: "selfie"` rows existed); they are now
  possible but no case covers them. Routing a pin to the Test Author is the
  correct next step rather than a speculative guard here.

## Alternatives

1. **Write the asset row in the submit route instead of `insertQueuedSelfie`.**
   Rejected: `…/selfies:reuse` inserts through the same function, and an asset row
   created only by submit would leave a reused selfie with `assetId: null` — the
   original F1, re-opened on the second route.
2. **Read the object key from `mediaAssets.storage.objectKey` on withdrawal.**
   Rejected on a measured `500`: the OP-131 case's seeded asset has no `storage`
   sub-document, and the key is a pure function of `contentHash` anyway.
3. **Leave the blob to the bucket lifecycle / a sweep.** Rejected: the pin reads
   the object back through `getObjectStorage()` right after the `204`, and §16.1
   says purge at 0 references, not "eventually".
4. **Delete the `mediaAssets` row at 0.** Rejected: the OP-131 case pins the row
   surviving with `refCount: 0` (it is the record that the reference was
   released), and a later re-submit of the same bytes can re-reference it.
5. **Hardcode the retention inline in `insertQueuedSelfie`.** Rejected: the
   schema §22 rule has two inputs, and the event cap is a minimisation guarantee,
   not a constant.

## Evidence

Measured on `OP-132-task-selfie-asset-erasure` (base `7d0d215`), real
`MongoMemoryReplSet` and the memoized memory object store:

- RED before the change: `liveness-selfie-submit.test.ts` **3 failed | 16 passed
  (19)** — `:862` no `mediaAssets` row, `:889` no `expireAt`, `:954` the bytes
  still readable after withdrawal.
- GREEN after: the four attendee specs — `liveness-selfie-submit` (19),
  `biometric-consent` (22), `selfie-reuse` (7), `selfie-submit-user` (2) —
  **50 passed (50)**, no test file edited.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; prettier clean.
