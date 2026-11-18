# ADR-0866 — OP-136 TEST: the batch arm's work is retried, and `hasMore` is observable

- **Status:** Accepted (TEST, RED by design) · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_488f057b` (Medium; finding **M2** of the review of the OP-136 GREEN
  `t_6a0e3e55`, PR #655 / head `496c7186`, [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md)).
  Branch `OP-136-task-batch-arm-retry-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `1d471f2f`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row's bounded-cron rules — `limit`,
  `hasMore`, idempotence, retry safety), notification design §4.7 (`upload.batch.completed` /
  `..._with_errors`), schema §15.1 (the `events` counters cache), §16.2 / §16.3 (the sessions and
  join rows the arm reads).
- **Consumes:** [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §1–§2 (the
  change-scoped candidate window, the checked triple, one page for both arms) and §Out of scope
  (the `scanned` / `skipped` / `hasMore` note this record narrows),
  [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md) §1–§2
  (`derivePipelineStatus` as the oracle, the latch, the OP-126 arm),
  [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) §2 (emit before the marker it feeds),
  [ADR-0862](ADR-0862-op136-indexed-check-batch-arm-cost.md) §1–§3 (the arm's grouped discovery,
  its `limit` budget and the chunked checks this record's window sits on), and
  [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this cron is the named caller
  of `checkUploadBatchTransition`).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (the two new
  block headers cite §1 and §2 in place).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read `0864` on this base
  (`1d471f2f`). The sweep immediately before minting found `ADR-0863` as the highest record on the
  trunk, and **two** lane siblings in flight above the cell: `ADR-0864` on open PR #666
  (`OP-136-task-sweep-observability-pins`) and `ADR-0865` on open PR #667
  (`OP-136-task-requeue-enqueue-warn`). Every other one of the eighteen open PR heads carries no
  `ADR-086*` file, no `.worktrees/*/docs/adr` tree holds an `ADR-0866*`, and
  `git rev-list --objects --all -- docs/adr` has no `ADR-0866` object. This record therefore takes
  `0866` and advances **only** the `OP-136 jobs lane` cell to `0867`; both
  `unallocated (future lanes)` cells stay `0869`. No number outside `0849`–`0868` is consumed.

## Context

ADR-0861 §1–§2 made the job drain: a row is a candidate only while its live
`(imageCount, processedImageCount, failedImageCount)` triple differs from the job-owned
`pipeline.indexedCheckedCounters`, and one page drives both arms. That closed the starvation of H1
and removed the retry the fixed page used to give for free: before the drain the arm re-ran over the
same page every five minutes because nothing ever left it, so a summary that failed to emit was
retried indefinitely.

The ordering the drain kept is the one M2 measured. `pipelineIndexedCheck` stamps the checked triple
for **every** candidate in the announcement loop, and only afterwards reads and checks the page's
batches (`pendingBatches` → `checkUploadBatchTransition` → `readBatchSnapshot`). A run that aborts
between the stamp and the arm — a transient driver error on the arm's read, or an invocation killed
mid-run, where the arm is up to `limit` checks over grouped reads (the cost `t_eeb212c2` /
ADR-0862 measured) — leaves the row outside the window with the batch's §4.7 summary never emitted
for that counter state. The next tick scans nothing, and no later tick can tell the uploader its
batch finished.

Measured at `496c7186` in a throwaway probe worktree (the production job's batch loop armed to throw
on its first batch, everything else byte-identical):

- run 1 (aborts in the arm): `{ summaries: 0, indexedRows: 1 }` — the announcement landed, the
  summary did not;
- run 2 (next tick, unchanged counters): `{ scanned: 0, details: { indexed: 0, batches: 0 }, summaries: 0 }`.

The same class as the window ADR-0856 §2 closed for the announcement leg ("emit before the marker it
feeds"), one step later in the run.

## Decision

### 1. A row does not leave the page until its arm work completes

**The decision of record:** no candidate may be marked as evaluated in a way that removes it from a
later page while the same run still owes that candidate's OP-126 arm work. Concretely, the batch
arm's work for a page must be retried by a later run whenever a run aborts after evaluating the page.

The pin (`I17`) is outcome-only, so the mechanism stays the implementation's choice: moving the
checked-triple stamp after the arm, re-stamping on failure, keeping an "arm pending" flag, or any
other shape that leaves the row a candidate. What is contract is the observation the card names:

```
seed one event deriving `indexed` + one worker-settled batch
arm one transient failure on the arm's own read
run 1  → rejects
run 2  → unchanged counters
assert exactly one upload.batch.completed for that batch,
       with its batchId / eventId / fileCount
```

The failure is injected at the driver's `Collection.prototype.find`, gated on
`this.collectionName === COLLECTIONS.eventImages` and armed for exactly **one** call
(`failNextFind`); the error carries `code: 91` (an election) and is thrown, never resolved to an
empty page, so the run aborts instead of reading a batch that is not there. The case asserts
`fired() === 1` before any outcome, so a vacuous injection cannot pass.

### 2. The observable half of the §10.2 backpressure fields

ADR-0861 §Out of scope declared `scanned`, `skipped` and `hasMore` deliberately unpinned. This
record narrows that for the one field that is a scheduling contract rather than a counter: `hasMore`
is what tells the scheduler to invoke again sooner.

- `I18` — a run whose page is full (`scanned === limit`; three `indexed` events against a page of
  two) reports `hasMore: true`, because events are left unread.
- `I19` — a run over a drained window reports `hasMore: false`, because nothing is left to read.

Both are **green on arrival** at the base. Neither asserts `scanned`: the page size is the case's own
input, and both the shipped `scanned >= limit` and a stricter "another candidate exists" reading of
the field satisfy them.

### 3. What stays unpinned

- The marker's field name, the sort key and the query shape — the drain shape is not the contract,
  and `I17` must pass for any implementation that keeps the row a candidate.
- `scanned` and `skipped` as values.
- The retry's timing: the case runs the next tick and never asserts _which_ run emitted the summary,
  only that some run after the abort did.

## Evidence

### The lane file, carried and extended

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` keeps ADR-0852's eight cases,
ADR-0859's `I9`–`I11` and ADR-0860's `I12`–`I16` byte-identical in order and numbering. The diff is
additive: two `describe` blocks appended after `I16`, one new module-level helper (`failNextFind`,
its two driver captures and the `InjectedReadFailure` interface), and the two import specifiers the
helper needs (`Collection`, `vi`). No existing case, fixture, helper, constant or assertion is
touched.

### RED at the branch head, and why it is not vacuous

`19 tests | 1 failed` at the branch head:

```
FAIL > I17: the next run still summarises the batch whose run aborted in the arm
AssertionError: a batch whose arm work was cut off must be summarised by a later run:
  expected [] to have a length of 1 but got +0
```

The case's own earlier assertions already passed at that point — the first run rejected with
`injected failure: find on event_images`, the injection fired exactly once, and the aborted run left
no summary — so the failure is the lost work, not the harness.

**Control:** the same case with the injection armed on a collection name that matches nothing (so
the arm is never disturbed) passes `1 passed (1)` over the same seed and the same two runs: run 1
emits the summary itself. The RED is therefore caused by the abort alone, and the seed/fixtures are
not the reason. The control was a throwaway copy of the spec, removed before the commit.

`I18` and `I19` pass at the branch head (green on arrival).

### Gates

`tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 issues and `prettier --check` clean on
the spec, and the six ADR guards green. No production file is in the diff; the PR is a **draft**
(OP-93 / ADR-0306) because the GREEN `t_bf0ae9ae` carries these cases forward.

## Assumptions

- **A1** — the arm's read is the right seam. `readBatchSnapshot` issues the only `find` the arm makes
  on `event_images` / `upload_sessions`, and the job's own candidate read targets `events`, so a
  collection-gated injection cannot hit the wrong leg. `I17` names the collection, never a caller.
- **A2** — an aborted run is observable as a rejection: `defineCronJob`'s `run` awaits the job
  without a `catch`, so a thrown driver error reaches the caller. The case asserts the rejection
  rather than a `errors` counter, and does not prescribe which.
- **A3** — `hasMore` is a scheduling signal, not a count. `I18` / `I19` read only its two extremes,
  so any honest reading of "there may be more" satisfies them.
- **A4** — one tenant per event in the fixtures is enough: the case's contract is the retry, and the
  arm's cross-tenant discovery order is `t_eeb212c2`'s (ADR-0862 §A2, F3), which no case here
  depends on.

## Out of scope

- **The fix.** Whether the GREEN moves the stamp, re-adds the row, or carries a per-page pending
  marker is `t_bf0ae9ae`'s; this record pins the outcome only.
- **The arm's cost** — ADR-0862's grouped discovery, the `limit` budget and the chunked checks are
  unchanged and unpinned here.
- **`scanned` / `skipped` values**, the marker's name, the sort key and the query shape.
- **The truncation order across tenants** (F3 of `t_eeb212c2`), and the announcement leg's own
  emit-before-marker window (ADR-0856 §2), which `I17` does not re-pin.

## Consequences

- A run that aborts inside the arm no longer loses the batch summary: a later run finishes it, and
  the outbox's `(batch, uploader)` dedupe key keeps the repeat a no-op.
- The GREEN that follows must keep the row a candidate until its arm work completes, which is a
  production change to the ordering ADR-0861 recorded — this record is that decision, so the GREEN
  cites it rather than re-deciding it.
- `hasMore` can no longer be turned into a constant in either direction without reddening `I18` or
  `I19`.
- `docs/adr/README.md` is the lane's hotspot: this index row, this lane cell and this note merge as
  a union keeping the higher cell (`0867` lane, `0869` pool).

## Review sign-off (round 1, artifact + execution lens) — APPROVED WITH FINDINGS

This section reviews PR #668 at head `01497219`, the delivery recorded above. The PR was
**closed unmerged**: it is a RED-by-design pin PR (OP-93 / ADR-0306), and its GREEN sibling
`t_bf0ae9ae` is what carried `I17`–`I19` onto the trunk. This record's own blob is `2730db48…`
at the reviewed head, at the GREEN's squash `40b65309` and on today's `origin/main`, so every
section above is the bytes that shipped.

**No decision in §1–§3 is retracted.** F1 is a routed test-quality gap, F2 a corrected figure in
the README, and F3–F5 observations; none of them withdraws a decision, changes an assumption or
narrows §Out of scope.

### The head, re-measured for this section

Measured at `01497219` in a throwaway worktree detached there, with `node_modules`,
`apps/web/node_modules` and `packages/contracts/node_modules` symlinked from the lane (the
contracts tree is byte-identical on both sides, so the links resolve to the same sources), and
removed afterwards. The job's sha256 at that head is `f0abfe0a…8dfe5e6`, restored
byte-identically after every probe below.

- **The focused file is RED on `I17` alone** (`19 tests | 1 failed`), the failure being:

  ```
  a batch whose arm work was cut off must be summarised by a later run:
    expected [] to have a length of 1 but got +0
  ```

  The case reaches that assertion only after its own checks pass — run 1 rejects with
  `injected failure: find on event_images`, `fired() === 1`, and the aborted run's outbox is
  empty — so the RED is the lost work, not the harness. `I18` and `I19` are green on arrival.

- **`I18` and `I19` discriminate.** Hardcoding the production line `hasMore: scanned >= limit`
  to `true` reds `I19` with `expected true to be false`; hardcoding it to `false` reds `I18`
  with `expected false to be true`. Each run is `2 failed | 17 passed (19)`, the second failure
  being the standing `I17` RED, so neither extreme of the field survives the file.
- **§1 is satisfiable.** Replaying the intended fix — every checked-triple stamp moved after the
  arm loop, the latch left where it is — answers `19 passed (19)`, so the decision of record
  asks for no shape the frozen cases refuse and no pin contradicts a sibling.
- **The gates.** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` exit `0` on the
  spec; `prettier --check` clean on the spec, on this record and on `docs/adr/README.md`; the
  six `adr-*` guards `6 files / 236 passed (236)`; the full `integration` project
  `140 files / 1 failed | 1469 passed (1470)`, `I17` the only failure.

### F1 — Low, test quality: §1's property was half-pinned (routed to `t_a31e0548`)

`I17` arms one abort. Measured in a throwaway probe worktree at `01497219`, a
weaker-but-plausible fix — the page rows the announcement loop does not announce keep the
shipped inline stamp, and only the announced rows are deferred — keeps `I17` green
(`summaries: 1`), while a two-abort probe is RED (`ticks: both rejected, fired 1 each;
summaries: 0`). An implementation can consequently re-stamp a latched row before the arm, pass
every case in the file, and still lose the batch summary when the next run also aborts.

Routed by card id, because a PR or ADR number can renumber while a card is open: `t_a31e0548`,
a TEST card that adds a two-abort arm, gated on the GREEN and on the lane's existing test
chain. It has since landed as PR #675 (squash `e311b4e6`), adding `I23` ("two aborts in a row
still leave the batch summarised once") inside the same `describe` block and re-measuring the
weak shape as `I17` green and `I23` red. It minted no ADR number, so §1 now holds with two pins
and no second record.

### F2 — Low, docs accuracy: the `+254/−0` figure is superseded

The `0866` index row and the lane note in `docs/adr/README.md` record the appended spec blocks
as `+254/−0`. Measured, `git diff --numstat 01497219^ 01497219` over the spec answers
**`258 2`**, in two hunks: `@@ -1,5 +1,5 @@` rewrites the two import lines (`Collection` joins
the `mongodb` import, `vi` the `vitest` one), and `@@ -923,3 +923,259 @@` appends **256** lines
— the two `describe` blocks, the `failNextFind` helper and its interface. The file is therefore
`+258/−2` and the appended hunk alone is 256. §Evidence's prose above ("additive: two
`describe` blocks appended after `I16`, the helper and the two import specifiers") holds; only
the README's arithmetic is wrong.

This card leaves `docs/adr/README.md` byte-identical (sha256 `d4da9878…f95a99d` before and
after), so the figure cannot be repaired at its source in this change. This paragraph is the
correction of record, and the index row keeps the number it shipped with.

### F3 — Info: the merge is index-only, and the union rule

PR #668 read `CONFLICTING` / `DIRTY` on `docs/adr/README.md` alone. At the review-time trunk
`268c842e` — and at `f3bb846a` and `47d36617` before it — `git merge-tree --write-tree <trunk>
01497219` names exactly that path, because the trunk landed ADR-0864's row via #666 after this
base; the two sides add different rows and rewrite different cells, so no number is duplicated.
The union rule that keeps the ledger consistent is the lane's: keep main's `0864` row, keep
every row ascending, take the higher cell for the lane (`0867` over main's `0865`), and leave
the pool cells at `0869`.

On today's trunk `bbfa0f9a` the same command also names the spec, because `e311b4e6` and the
later pin cards extended it. That is the closed branch being superseded and not a second
number, and nothing in this card merges it.

### F4 — Info: where the injection sits

`I17`'s failure is injected at `Collection.prototype.find`, gated on
`this.collectionName === COLLECTIONS.eventImages`. That is the arm's read today
(`readBatchSnapshot`), and it stays right only while that read is a `find`: a refactor of it to
an aggregation would leave the injection unfired, and the case would red at `rejects.toThrow`
and at `fired() === 1` instead of passing silently — a loud failure, which is the acceptable
direction. §A1 already documents the seam; no card.

### F5 — Info: hygiene

The PR's three paths are the spec, this record and `docs/adr/README.md`: no production file, no
fixture-specific branch, no test-environment conditional, no lint suppression and no new
dependency. The head carried four check-runs — CodeQL, two `Analyze` jobs and the repo's
"Assert CI evidence" job — and no `CI` or `PR Checks` run, which is what a draft gets in this
repo, so the gates above were run locally. The GREEN's PR #670 then ran the repo's gate set in
CI on the spec's identical bytes (`5de03872…` at both heads, all fifteen checks green).

### Posture

This was a **RED-by-design pin PR and it stays a draft** (OP-93 / ADR-0306): the RED branch is
unmergeable by construction, and `t_bf0ae9ae` (squash `40b65309`, ADR-0867) is what carried
`I17`–`I19` to the trunk. The PR was closed unmerged on 2026-11-17, and nothing from this card
merges anything.

This section consumes **no** ADR number, adds no index row and leaves `docs/adr/README.md`
byte-identical. The ledger moves only when a card mints a record, and every card this review
raised is a pin (`t_a31e0548`) or the correction carried here.
