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
