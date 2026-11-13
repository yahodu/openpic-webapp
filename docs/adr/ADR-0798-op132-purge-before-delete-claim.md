# ADR-0798 — OP-132 GREEN: purge the selfie blob before the rows, under a claim that deflects a racing submit

- **Status:** Accepted
- **Consumers:** `apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts` and
  `apps/web/src/server/attendee/selfie-submit.ts`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`), of which this record is the last number.
  `Next free` re-read as `0798` at this branch's head (`4f0cfbd`, cut from
  `origin/main` `4cff381` after PR #547); the sweep at mint time found `0780`–
  `0794` and `0796` on the trunk and `0797` (OP-132 pins) plus `0798` on this
  branch. `0798` is reserved for this GREEN by the card body and the pins'
  handoff, and the OP-133 preview-url pins' branch — which had minted `0798`
  five minutes later — was renaming itself to `0799` while this card ran, its
  own record yielding `0798` to this worktree. So this record takes `0798`; the
  attendee cell and the pool cell both read `0800` (`0799` being in flight on
  `OP-133-task-preview-url-selfie-summary-pins`), so the next attendee-lane card
  draws a fresh block from `0800` instead of minting into the exhausted block.
- **Amends:** [ADR-0797](ADR-0797-op132-failed-purge-retry-pin.md) §Open
  questions (which repair the GREEN takes and how the losing submit is
  answered); [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)
  §Consequences "Known gap, routed (F-A2, High)" and §3's `shortcut:` (the
  release/delete window), both now closed.
- **Consumes:** `0798`.

## Context

ADR-0797 turns F-A2 (High) into two executable pins. The shipped withdrawal
deleted the `selfies`/`faceMatches` rows **first**, then released the reference
and called `deleteObject`, so a transient object-store failure answered `500`
with the only pointer to the biometric object already gone; the retry derived no
references and answered `204` while the blob stayed readable. The release and
the delete were also two separate calls, so a submit that re-referenced the hash
in between was handed a reference to bytes the withdrawal was about to erase.

## Decision

### 1. Synchronous purge, ordered before the row deletion

The withdrawal now does, per referenced asset, in this order:

1. **claim**, atomically with the last release:
   `findOneAndUpdate({_id, refCount: {$lte: count}},
{$set: {refCount: 0, status: "purged", purgedAt: null}})` — one write, so a
   row can never be observed at `refCount: 0` while still `stored`;
2. `deleteObject("originals", selfies/<contentHash>)`;
3. `$set: {purgedAt: now}` — the mark that the bytes are really gone;
4. only then the `selfies`/`faceMatches` deletes, the `withdrawnAt` stamp and the
   profile's `withdrawn` status.

A failed delete therefore leaves the rows **and** a durable purge candidate
(`refCount: 0`, `status: "purged"`, `purgedAt: null`) behind, and the attempt
still answers `500` — the withdrawal did not complete, which is what that status
means. Keeping `500` is deliberate: the card allowed a documented status, but the
first attempt legitimately failed and no pin requires a softer answer.

`refCount: {$lte: count}` is what makes the **retry** work: on the second
withdrawal the rows are still there, the release matches the already-zero row,
and the object is re-attempted. There is no queue entry and no sweep — the
withdrawal retry _is_ the consumer (ADR-0797 F2), which is the cheaper thing for
`t_6b53935c` to pin.

### 2. The claim deflects a racing submit instead of losing its bytes

`insertQueuedSelfie` refuses to take a reference on a row that is claimed but not
yet purged (`status: "purged"` **and** `purgedAt: null`) with
`409 conflict { details: { reason: "selfie_purged" } }`. The submit runs in a
transaction that starts after the claim committed, so the refusal is
deterministic; a `409` also keeps the attempt budget and the liveness challenge
unspent, which an `E11000` from the `(tenantId, contentHash)` index does not
(ADR-0797 measured that probe answering `500`).

The refusal is scoped to the **in-flight** window on purpose. After a completed
purge `purgedAt` is a date, so a re-upload of the same bytes is a normal submit
again — it re-increments the surviving row and the next withdrawal claims and
purges it once more. The row's `status` then reads `purged` while it holds a
reference; that is cosmetic (a sweep keys on `refCount: 0`), and the alternative
— rewriting `status` on every submit — would also rewrite a **image** asset
sharing the hash, which this card must not touch.

### 3. The happy path is byte-identical

`204`, the same `X-Deleted-Counts` (the deletes still report the driver's own
`deletedCount`s), the asset row kept at `refCount: 0` (OP-131's pin), the
seven-key selfie envelope untouched and no status code changed for any existing
case: the only new wire answer is the `409` above, which no earlier case could
reach because no row was ever claimed before.

## Consequences

- A transient object-store failure is now retryable: the second withdrawal
  erases the bytes, and a retry that never comes leaves a candidate a sweep can
  act on without the deleted `selfies` rows.
- One extra write per released asset (`$set purgedAt`) and one extra read per
  submit (the claim probe) — both single-document, both on paths that already
  touch the row.
- A withdrawal that fails mid-way leaves the selfie rows in place, so the retry
  reports `selfies=1` rather than `0`; ADR-0797 reads the counts as a format for
  exactly this reason.
- **Known limit, not pinned:** the claim and the object delete are still two
  calls. A submit that lands **after** the purge completes and the rows are gone
  sees `purgedAt` set and is admitted onto a row whose bytes are gone, exactly as
  a submit of any hash whose object is missing is admitted whenever `headObject`
  passes. Closing that would need the object existence to be re-checked inside
  the submit transaction, which no pin demands and which the storage port cannot
  do atomically with the claim.
- **Known gap, routed:** nothing sweeps a candidate whose withdrawal is never
  retried. `t_6b53935c` (gated behind this lane) pins the consumption; §1 makes
  the retry the consumer so that pin needs no new queue plumbing. Until that
  retry happens the claim also keeps refusing a submit of those bytes (`409`),
  which is the deliberate fail-closed side: a reference is never handed to bytes
  a pending purge owns.

## Alternatives

1. **Purge candidate on a failed delete, no reorder** (the reviewer's probe 1).
   Rejected: it turns P1 green while the bytes stay readable and leaves nothing
   that ever re-attempts them (F2), i.e. a marker on an orphan.
2. **Queue entry instead of a row marker.** Rejected: ADR-0797's P1 second
   branch reads only the `mediaAssets` row, so a queue-only repair stays red; the
   card text allowed it, the pin does not, and widening the pin was not mine to
   do.
3. **Delete the object before releasing the reference.** Rejected: a submit in
   the window would then hold a live reference to bytes already deleted, which
   is the P2 defect with the ordering reversed.
4. **Refuse the racing submit with the `E11000`** (the reviewer's measured
   probe 2). Rejected: it answers `500` and spends the challenge and the attempt
   budget on a request that was never at fault.
5. **`410 gone` instead of `409 conflict`.** Rejected: the asset is not gone
   from the ledger — it is momentarily unpurged, and the documented retry is a
   later submit once the purge finished, which `conflict` describes and `gone`
   does not.

## Open questions

- Whether a resubmit of the same bytes after a completed purge should reset the
  row's `status` back to `stored`. Left as is (§2); unpinned.
- Whether the first attempt should answer a softer status than `500`. Left as is
  (§1); unpinned.
