# ADR-0798 — OP-132 GREEN: purge the selfie blob before the rows, under a claim that deflects a racing submit

- **Status:** Accepted
- **Consumers:** `apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts` and
  `apps/web/src/server/attendee/selfie-submit.ts`; pinned by §2's own arm in
  `apps/web/src/test/integration/liveness-selfie-submit.test.ts` (added by
  [ADR-0828](ADR-0828-op132-purged-asset-reuse-reset-pins.md); no decision here
  is edited). The withdrawal's deletion of a profile's selfies and matches is
  also **cited by** `apps/web/src/test/integration/internal-worker-endpoints.test.ts`
  (OP-135 discards a report that lands after the withdrawal).
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

## Review sign-off (OP-132 GREEN `t_0f7341d7`, round 1 — artifact + execution lens)

**Verdict: APPROVED WITH FINDINGS (Medium ×2, Info ×3).** The delivery is PR #550,
reviewed at head `f48ff31` and squash-merged as `4c31808`; nothing was re-merged for this
sign-off. The lens was the artifact **and** the execution: every count below is the
reviewer's own run, and both probes were measured rather than assumed.

**No section of this record is retracted.** §1, §2, §3, §Consequences, §Alternatives and
§Open questions stand as written. The items at the end are dispositions, not corrections.

### The reviewed bytes are what shipped

`git diff --stat f48ff31 4c31808` is **empty**: the squash kept the branch tree, so a
suite run on the branch applies to the trunk verbatim. The squash is **7 paths**
(`git diff --name-status 4c31808^ 4c31808`): the withdrawal route and `selfie-submit.ts`
modified, the pins spec `+257`, ADR-0796 amended, ADR-0797 added, this record added and
the ledger's two `Next free` cells plus its two new index rows.

The `+257` test lines are the RED card's pins carried in, not edits this GREEN made.
Measured as blob identity, which is strictly stronger than a three-dot diff:

- `apps/web/src/test/integration/liveness-selfie-submit.test.ts` — `c29e7f6c…` at the
  RED head `4f0cfbd`, at the reviewed head `f48ff31` and at the squash `4c31808`, i.e. one
  blob OID three times, with 21 cases at each (counted, not inferred);
- this record — `0028d788…` at `f48ff31` and at `4c31808`, so the GREEN edited no record
  it satisfies;
- the withdrawal route — `82d5aa49…` at `f48ff31`, at `4c31808`, at the follow-up fix
  `76d3315c` and at the trunk `872fd046`, so every claim about that file holds on all four
  trees.

### Measured by the review at `f48ff31`

| gate                                                                                                                   | result                                       |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| the pins, `liveness-selfie-submit.test.ts`                                                                             | `21 passed (21)`                             |
| the four attendee specs (this one, `biometric-consent`, `selfie-reuse`, `selfie-submit-user`)                          | `4 files, 52 passed (52)`                    |
| full `unit`                                                                                                            | `175 files, 2907 passed \| 3 skipped (2910)` |
| full `integration`                                                                                                     | `115 files, 1242 passed (1242)`              |
| the five ADR guards (`adr-consumers`, `adr-lane-ranges`, `adr-numbering`, `adr-record-links`, `adr-source-references`) | `5 files, 218 passed (218)`                  |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                               | exit `0`                                     |
| `prettier --check` and `eslint`                                                                                        | clean / 0 warnings                           |
| CI on the head                                                                                                         | 15 of 15 checks                              |

### Re-measured on this branch's tree (`186fa464` plus this append)

- the pins: **26 passed (26)**. The five extra cases are ADR-0828's, added by `76d3315c`;
  the 21 cases measured at the squash are unchanged in behaviour;
- the four attendee specs: **4 files, 57 passed (57)**;
- full `unit`: **179 files, 2965 passed | 3 skipped (2968)**, exit `0`;
- full `integration`: **131 files, 1356 passed (1356)**, exit `0`;
- the five ADR guards: **5 files, 218 passed (218)**, unchanged;
- `tsc -p apps/web/tsconfig.json --noEmit`: exit `0`;
- `docs/adr` holds **334** records and no number appears twice; `0796`–`0800` and `0828`
  each exist exactly once;
- both shared `Next free` cells in the ledger read `0829`, which is the highest number on
  any ref plus one.

The full-suite figures are larger than the review's because sibling lanes landed cases
between the squash and this append (ADR-0828's pins pack is the visible one). No figure
above is a transcription of the implementer's handoff.

### The two probes, and what they decided

- **Probe (a) — a claim injected between the submit's guard read and its `$inc`.** The
  submit's own `withTransaction` retries the write conflict and the loser answers
  `{"submitStatus":409,"submitCode":"conflict","refCount":0,"status":"purged","readable":false}`:
  the purge really happened, no reference survives it, and nothing dangles. §2's refusal is
  therefore atomic **enough** in practice even though the read-then-write shape is not
  atomic in principle (Info F-I3, no action).
- **Probe (b) — a reuse after a completed purge.** The re-submitted hash re-referenced the
  surviving row and left `{"refCount":1,"status":"purged","purgedAt":"<date>"}` with the
  bytes readable: a live reference recorded as purged, and §2's cosmetic-status reasoning
  turned out to have a measurable cost (Medium F-A2b). The defect is now pinned and closed;
  its mutation is re-run for this append under §"Honesty checks" below.

### Honesty checks

The GREEN touched no existing test, fixture, mock or helper: the spec's added lines are the
RED card's carried-in pins (blob identity above), and the squash's production hunks carry no
`NODE_ENV`, `process.env`, `console.`, `ts-ignore`, `eslint-disable`, `.only` or `.skip`
(grepped over the added lines of both files).

The F-A2b mutation was re-measured for this append, twice, and only the second attempt is
evidence (the `selfie-submit.ts` blob is `901fcf19…` both where the mutation ran and on this
branch's tree, so the reading holds for both):

1. reverting the **whole** `selfie-submit.ts` file to `4c31808` reddened **20** cases with
   `expected 500 to be 202`. That is **not** recorded as a proof: it mixes the reviewed tree's
   server module with the trunk's neighbours, so it measures the mix and not the defect.
2. reversing exactly the `+4/−1` of `76d3315c` (`git diff 76d3315c^ 76d3315c -- apps/web/src/server/attendee/selfie-submit.ts`) reddens **exactly one** case,
   `1 failed | 25 passed (26)`, with the assertion carrying the defect's own signature:
   `"refCount":1,"status":"purged","purgedAt":"…": expected 'purged' to be 'stored'`. The file
   was then restored byte-identically (`sha256` equal to the pre-mutation hash, `git status`
   empty), so no pin is vacuous and none passes for a broken fixture.

### Findings and their disposition

- **Medium — F-A2b, a reused row keeps the purge marker.** Routed to TEST `t_ecc695e5`, then
  GREEN `t_1805f512`. Landed as `76d3315c` (PR #604) and recorded in
  [ADR-0828](ADR-0828-op132-purged-asset-reuse-reset-pins.md), whose case sits at
  `liveness-selfie-submit.test.ts:1577`. Closed, and pinned in the direction that reddens.
- **Medium — F-L1, the ledger cell.** At review time the ledger read `0799` for this lane
  while §Lane says `0800`, and `0799` was in flight on the OP-133 preview-url pins. That PR
  landed as `55e665a` and consumed `0799`, moving the cell to `0800`; the lane has since
  drawn every number through `0828`, so both cells read `0829` at `186fa464`. The DOCS card's
  instruction to set the cell to `0800` is therefore **void** at this trunk: the cell only
  moves forward, and lowering it would re-mint twenty-nine consumed numbers. This append
  touches the ledger not at all.
- **Info — F-I1, the handoff's suite counts.** The implementer's `unit` 2846 / `integration`
  1216 over 112 files are pre-merge figures; at the squash the same suites measure 2907 and
  1242 over 115 files, because the trunk merge brought the OP-133 specs. Anchored to
  `4c31808`, both sets are true of different trees.
- **Info — F-I2, the check count.** PR #550 carries **15** checks, not 14; the post-close
  `notify-discord` run is the extra one (`statusCheckRollup` measured at 15 today).
- **Info — F-I3, the guard's shape.** `insertQueuedSelfie`'s refusal is a read-then-write and
  §2 claims determinism from the transaction's ordering; probe (a) shows the ordering holds
  under an injected claim, so the claim is right for the shipped code even though it is
  right by `withTransaction` rather than by the guard alone. No action, and no pin asked for.

### Post-review status

- **§Open questions' first item is decided, by a later record.** Whether a resubmit after a
  completed purge should reset `status` to `stored` was left "as is (§2); unpinned". It is now
  answered **yes**: ADR-0828 puts `status: "stored"` and `purgedAt: null` on the upsert's
  `$set`, the **Consumers** line at the top of this record names that decision, and the case
  at `liveness-selfie-submit.test.ts:1577` pins it. This record is not edited for it — the
  later record carries the change and supersedes the open question.
- **§Consequences' "Known limit, not pinned" stands untouched.** A submit that lands after
  the purge completed is still admitted whenever `headObject` passes; ADR-0828 resets the
  row's lifecycle fields but does not re-check object existence inside the transaction.
- **§Consequences' "Known gap, routed" is consumed.** `t_6b53935c` landed the consumption
  pin, `liveness-selfie-submit.test.ts:1435` ("consumes the pending purge candidate, so the
  bytes are gone after the retry"), so §1's claim that the withdrawal retry is the consumer
  is pinned rather than only argued.
