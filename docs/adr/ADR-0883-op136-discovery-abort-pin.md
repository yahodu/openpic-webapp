# ADR-0883 — OP-136 TEST: a throw from the grouped batch discovery aborts the indexed-check run and stamps nothing

- **Status:** Accepted (characterization pin — green on arrival against the
  landed containment ADR-0872, so the PR is non-draft and merges)
- **Card:** OP-136 TEST `t_b13a68d7` (Low; finding **F3** of the landing review of
  PR #741, card `t_05687f95`, squash `b3f63308`). Branch
  `OP-136-task-grouped-discovery-abort-pin`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from `origin/main`
  `acade549`.
- **Implements:** nothing. This record changes **no** production file: it closes a
  coverage gap, and the behaviour it pins is already on the trunk.
- **Consumes:** [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md)
  §2 (the two halves of a crashed run: a row's own arm work is retried, and a
  throw from the grouped discovery aborts the run and stamps nothing),
  [ADR-0872](ADR-0872-op136-poison-row-containment-green.md) §1 (containment is
  scoped to a **row**), §3 and §Review — round 1 (the corrected `I22` citation and
  the finding that the abort half was unpinned),
  [ADR-0871](ADR-0871-op136-poison-row-containment-pins.md) §1 (the row-level
  containment this case is the counterpart of),
  [ADR-0876](ADR-0876-op136-per-tenant-early-stop-pin.md) §1 (`I22`'s real
  subject — the per-tenant early stop), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (an
  exhausted lane block keeps its range and draws from the pool, advancing both
  cells).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`.
- **Findings:** **F3** (Low, coverage / suite accuracy) of the review of
  `t_05687f95`.
- **Number allocation:** `0883`, a **pool draw**. The OP-136 lane block
  `0849`–`0868` is exhausted, and both `Next free` cells read `0882` at
  `acade549`. The sweep immediately before minting found: the trunk's highest
  record is `0881`; the highest anywhere is `0882` —
  `ADR-0882-op137-delivery-receipts-green.md`, in flight in `.worktrees/t_01fd59cf`
  (mtime `2026-11-20 07:50`) and committed on the branch
  `OP-137-task-delivery-receipts-green` (open PR #745) — and
  `git rev-list --objects --all -- docs/adr` also tops out at `0882`. The other
  open PR heads — #743 (max `0881`) and #272 (max `0306`) — carry no `ADR-0883`.
  So this record takes the highest in-flight number plus one and advances **both**
  cells to `0884`. No range is re-cut. `0882` then landed on the trunk as
  `c92ca81f` (PR #745) before this branch merged `origin/main`, so its row now
  sits directly below this record's; see §Reconciliation.

## Context — a claim, a measurement, and nothing in the suite

ADR-0867 §2 records what a crashed run must leave behind. Its first half — a row
whose own OP-126 batch arm work was cut off keeps its checked triple unstamped
and is retried — is pinned by `I17`/`I23` and `I28`. Its second half is the
opposite shape:

> a throw from the grouped batch-discovery aggregate aborts the whole run and
> stamps nothing, so the page retries as a whole

`apps/web/src/server/jobs/pipeline-indexed-check.ts` does exactly that at this
base: `pendingBatches` runs one grouped `event_images` aggregate per tenant in
the candidate page and returns its pairs, `pipelineIndexedCheck` awaits it
**before** any row loop, and `checkRow` — the only writer of
`pipeline.indexedCheckedCounters` and the only caller of `emitDomainEvent` — runs
after it. The row-level `Promise.allSettled` containment that ADR-0872 §1 added
sits _inside_ that loop, so it cannot absorb a discovery failure: a broken page
read is fatal to the tick, and the page comes back whole on the next one.

Until this record nothing in the suite made an `aggregate` throw. At `acade549`
the pin file contains 29 cases and three occurrences of the word `aggregate` —
lines 1494, 1500 and 1503, all prose in ADR-0876's block docblock, none of them a
spy, a stub or a throw. ADR-0872 §3 claimed the half was pinned by `I22`;
`I22` is ADR-0876's per-tenant **early-stop** case and never makes a read fail.
The property was true only because it had been measured out of band, so the
obvious future change — wrapping the discovery in a `catch` that answers "no
batches" — would have turned a broken page read into a permanent `errors` count,
lost every batch summary the page owed, and passed all 29 cases. That is the gap
this record closes.

## Decision

### 1. One appended case in a new block; the 29 existing cases are untouched

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` gains one
block at the end and one case in it:

- **Block:** `describe("pipeline-indexed-check: a throw from the grouped batch discovery aborts the whole run")`
- **Case:** `I30: the run rejects, stamps nothing and emits nothing, and the next tick retries the page`

`git diff --numstat` is `227 0` in that one file: every one of the 29 delivered
cases, every module-level helper, every fixture and every constant is
byte-identical, and nothing is deleted. No `.only`, no skip, no loosened matcher.
The block carries its own three block-scoped helpers (`failAggregateOn`,
`seedCandidate`, `storedPipelineOf`) and one `runPage`, the way `I26`–`I29`'s
block carries its own, so no shared fixture moved.

The new case is numbered `I30` because `I1`–`I29` are live cases in this file
(ADR-0871 numbered its block `I26`–`I29` for the same reason).

### 2. The failure is armed on the collection, from the driver's own method

The injection captures `Collection.prototype.aggregate` out of its property
descriptor **before** any spy exists, then `vi.spyOn(Collection.prototype, "aggregate")`
and throws for `this.collectionName === COLLECTIONS.eventImages` with
`code: 91` (the replica-set-election shape `failNextFind`/`failFindWhen` already
use) and the message `injected failure: aggregate on event_images`. It counts its
calls, and the case asserts the count is `≥ 1` before it reads any outcome, so
the case cannot pass on a seed the discovery never reached.

It is armed on the **collection**, not on a tenant or an event, and it stays
armed for the whole first tick, because the subject is the run's page read and
not a transient one-off. The error is thrown, never resolved to an empty page: a
discovery that answers "no batches" is exactly the mutation this case exists to
catch.

### 3. The observables

1. **The run rejects:** `await expect(run).rejects.toThrow(/injected failure: aggregate/)`.
   This is the whole subject — a page-level read failure is fatal, unlike a
   row-level one.
2. **The failure fired:** `fired() ≥ 1`.
3. **Nothing is stamped:** every seeded event's
   `pipeline.indexedCheckedCounters` **and** `pipeline.indexedNotifiedAt` is
   `undefined`, so every one of them is still a candidate.
4. **Nothing is emitted:** `COLLECTIONS.domainEvents` holds `0` rows.
5. **The page retries as a whole:** the injection is restored, and the next
   tick's envelope is `scanned: 3`, `errors: 0`, with exactly one
   `pipeline.event.indexed` row per seeded event and every row now carrying its
   checked triple `{ imageCount: 3, processedImageCount: 3, failedImageCount: 0 }`.

The page is three candidates, each an `indexed` event (the shipped
`derivePipelineStatus` is the oracle) with a worker-settled two-file batch —
`seedCandidate`/`seedEvent` + `seedCompletedSession` + `seedBatchImage(status: "done")`,
`I26`/`I29`'s shape, and the reviewer's probe size, so the numbers below are
directly comparable.

No assertion names the query, the grouping, the sort, the chunk size or the
`catch`, and nothing pins _when_ the abort happens within the tick beyond "no row
was reached". A correct implementation with a different tenant batching, a
different aggregation pipeline or a different fatal-error type satisfies it.

### 4. Characterization, not RED-by-design — and why that is the right shape

The card allows either, and this is a characterization pin: the shipped head
already aborts, so the case was green on arrival and the PR is non-draft. A
RED-by-design draft would have had to assert a behaviour the trunk does not have,
which for this property would mean asserting something none of the three ADRs
decided — there is no defect here to drive, only an unpinned guarantee.

The case is load-bearing anyway, which is what a green pin normally cannot show:
four mutations of the production file each red **`I30` alone**, §Evidence.

### 5. Deliberately not done

- **No production change.** `apps/web/src/server/jobs/pipeline-indexed-check.ts`
  is byte-identical to `acade549`
  (`sha256 fa4f0b917976721090e799b582fc52b754a028e7f90d5afcdceb7cdac39a72b4`,
  measured before and after every mutation).
- **ADR-0872 is not edited**, including its §3 `I22` sentence: it is frozen once
  PR #744 landed as `acade549`, and the correction is already recorded there in
  §Review — round 1. This record cites that section and the card, not the
  superseded sentence.
- **No assertion on the log line.** The run writes no
  `pipeline.indexed_check.row_failed` warn here (no row was reached) and the
  abort's own log shape is not a decided contract, so pinning it would invent
  one.
- **The retry is not asserted to be idempotent beyond one announcement per row.**
  A third tick would re-pin the latch, which `I4`/`I8` already own.
- **The `error`-field question is out of scope.** Whether the row-level warn
  carries its reason through the real logger is finding **F1** and card
  `t_3b30fc42`, the sibling of this one.

## Consequences

- ADR-0867 §2's abort half is now executable: a change that contains the
  discovery — a `catch` around `pendingBatches`, a `Promise.allSettled` over the
  per-tenant reads, or a fallback to an empty pair list — reds `I30` at its first
  assertion while the other 29 cases stay green, so the coverage loss is loud and
  local.
- Conversely, the row-level containment of ADR-0872 §1 keeps its own pin
  (`I26`–`I29`) and its own red set, so the two halves stay distinguishable: the
  file now fails differently for "a row broke" and for "the page read broke".
- The spec grows from 29 to 30 cases (`+227/−0` in one file); no production
  module, helper, fixture or config moves.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, the note and the
  two cells merge as a union keeping the higher cells (`0884`), and the in-flight
  `0882` of the OP-137 lane is untouched.

## Alternatives

1. **A separate spec file.** Rejected: the card allows either, and the case needs
   this file's `seedEvent`, `seedCompletedSession`, `seedBatchImage`, `hashFor`,
   `outboxFor`, `indexedRowsFor` and `ALL_PROCESSED` to stay the same fixture
   shape as `I26`/`I29`. A second file would either copy them (two fixtures that
   can drift) or import them from a spec (the house rule keeps a spec's helpers in
   its own block).
2. **Reuse the block-scoped `seedCandidate` of the `I26`–`I29` block.** Rejected:
   it is scoped inside another `describe`, and hoisting it would edit that
   block — the card requires the 29 existing cases and their helpers to stay
   byte-identical.
3. **Inject on a tenant or an event filter instead of the collection.** Rejected:
   `this.collectionName` is the only handle that identifies the discovery's read
   for every tenant on the page, and the card's contract is the page read.
4. **Assert the discovery's own error code or message shape in the envelope.**
   Rejected: `defineCronJob` does not decide the propagation shape, and pinning it
   would make a future wrapping for operator context a false red. The case
   asserts only that the rejection carries the injected reason.
5. **Make the case RED by design by asserting a `catch`-and-count shape.**
   Rejected: that would pin an _undecided_ alternative (ADR-0872 rejected option
   3 for the row case on the same reasoning) and would ask the implementation to
   contradict ADR-0867 §2.

## Evidence

Base `origin/main` `acade549` (ADR-0872's record and corrected §Review — round 1).
All runs below are the `integration` project in the lane worktree.

Baseline, measured on the base file written out of `origin/main` and run on its
own (the temp file was deleted before the commit):

```
base spec (29 cases):   Test Files  1 passed (1)   Tests  29 passed (29)
delivered (30 cases):   Test Files  1 passed (1)   Tests  30 passed (30)
```

`grep -c 'aggregate'` on the base file is `3` and all three hits are prose
(lines 1494, 1500, 1503); `grep -c '^  it('` is `29`; on the delivered file it is
`30`. The 29 pre-existing cases report `29 passed (29)` with `-t` on none of them
moved — the delivered block is additive.

Green on arrival, so four mutations of the production file were used to show the
case bites. Each was applied alone, run with `-t "I30"`, and reverted with
`git checkout --`; the file came back at
`sha256 fa4f0b917976721090e799b582fc52b754a028e7f90d5afcdceb7cdac39a72b4` every
time and `git status --porcelain` then named only the spec.

| Probe | Mutation of `pipeline-indexed-check.ts`                                                              | Result                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | the discovery wrapped in `try { … } catch { pending = [] }` — the change this record exists to catch | `1 failed \| 29 skipped (30)` — **`I30` alone**, `AssertionError: promise resolved "{ job: 'pipeline-indexed-check', …(9) }" instead of rejecting`                                                             |
| M2    | every candidate's checked triple stamped **before** the discovery                                    | `1 failed \| 29 skipped (30)` — **`I30` alone**, `an aborted run must not stamp the checked triple on any row: expected [ { imageCount: 3, …(2) }, …(2) ] to deeply equal [ undefined, undefined, undefined ]` |
| M3    | every candidate announced and latched **before** the discovery                                       | `1 failed \| 29 skipped (30)` — **`I30` alone**, `an aborted run must not latch any row as notified: expected [ 2026-11-17T09:00:00.000Z, …(2) ] to deeply equal [ undefined, undefined, undefined ]`          |
| M4    | every candidate announced (no latch, no stamp) before the discovery                                  | `1 failed \| 29 skipped (30)` — **`I30` alone**, `an aborted run must not emit a single domain event: expected 3 to be +0`                                                                                     |

M1 is the failure mode the record is about; M2–M4 show that each of the three
"nothing was written" assertions is reached and load-bearing rather than shadowed
by the rejection assertion. M1 also reproduces the reviewer's finding that the
case "fails if the run resolves", with the resolved envelope in the message.

Gates at the delivered head: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`
and `tsc -p tsconfig.json --noEmit` exit `0`; `eslint` `0` errors and `0`
warnings on the spec; `prettier --check` clean on the spec, this record and
`docs/adr/README.md`; the six `adr-*` guards green — `6 files / 236 passed (236)`
(`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
`adr-inline-code-spans`, `adr-source-references`, `adr-consumers`); the full
`unit` project `188 files / 3162 passed | 3 skipped (3165)` (exit `0`, the three
skips pre-existing) and the full `integration` project
`147 files / 1552 passed (1552)` in 385.59 s, exit `0`, 0 failures. The focused
spec is `1 file / 30 passed (30)` at the delivered head, after the delivered
block was reformatted by `prettier --write` and one redundant `as never` was
dropped from `failAggregateOn` (the only lint finding this file has ever had from
this change: `@typescript-eslint/no-unnecessary-type-assertion`, cleared with
`tsc` still exit `0` and the spec still `30 passed (30)`).
`git diff --numstat` is `227 0` in the spec and `32 2` in `docs/adr/README.md`
(two cells, one index row, one note), plus this record (+255 lines, a new file).
No number outside `0883` is consumed.

## Reconciliation — the merged `origin/main` after minting

The number above was swept against `origin/main` `acade549`, where `0882` was in
flight. It merged first: the branch `OP-137-task-delivery-receipts-green` landed
as `c92ca81f` (PR #745), followed by the release commit `41aec3b0`, and this
branch then merged `origin/main` to clear the `docs/adr/README.md` conflict the
merge ref reported (`mergeable CONFLICTING`, `mergeStateStatus DIRTY` — §9.1 G1).

The resolution is a union that keeps the higher cell and both sides' rows and
notes:

- `docs/adr/README.md` carries ADR-0882's index row **and** this record's, in
  ascending order, with both notes appended after ADR-0881's;
- both `Next free` cells stay `0884`: the merged trunk read `0883` (ADR-0882
  advanced them), and ADR-0300 §11 item 20 forbids lowering a cell, so the
  higher of `0883` and `0884` wins;
- no other path conflicted, and the spec's diff against the merged trunk is still
  `227 0`, so the 29 delivered cases are still byte-identical and the pin that
  ran is the pin that is being merged;
- the gates of §Evidence were re-run on the merged tree, and the six `adr-*`
  guards and the focused spec are re-quoted in the PR body against the new head.

Numbers in §Evidence that name the base (`acade549`) are the base this delivery
was cut from and measured on; they are not restated, because the merge changes
neither the spec nor the production module.
