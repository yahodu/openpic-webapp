# ADR-0867 — OP-136 GREEN: the checked triple is stamped after the row's arm work

- **Status:** Accepted (GREEN) · **Date:** 2026-11-17
- **Card:** OP-136 GREEN `t_bf0ae9ae` (Medium; finding **M2** of the review of the OP-136 GREEN
  `t_6a0e3e55`, PR #655 / head `496c7186`,
  [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md)). Branch
  `OP-136-task-stamp-triple-after-arm`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `f3bb846a` and rebased
  onto `533bc7f5` (the merge of PR #667 / ADR-0865) before the PR; it carries the pins of
  `t_488f057b` /
  [ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md) at `01497219`
  byte-identically.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row's bounded-cron rules — `limit`,
  `hasMore`, idempotence, retry safety), §4.1 (the pipeline-status table), notification design §4.7
  (`pipeline.event.indexed`, `upload.batch.completed` / `..._with_errors`), schema §15.1 (the
  `events` counters cache and its `pipeline` latch), §16.3 (the join rows the arm discovers).
- **Consumes:** [ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md) §1 (the
  decision of record: a row does not leave the page until its arm work completes),
  [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §1–§2 (the change-scoped
  candidate page, the checked triple, one page for both arms),
  [ADR-0862](ADR-0862-op136-indexed-check-batch-arm-cost.md) §1–§3 (the grouped discovery, the
  `limit` budget, the chunked checks),
  [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) §2 (emit before the marker it feeds),
  [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md) §1–§2
  (`derivePipelineStatus` as the oracle, the latch, the OP-126 arm), and
  [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this cron is the named caller of
  `checkUploadBatchTransition`).
- **Consumers:** `apps/web/src/server/jobs/pipeline-indexed-check.ts` (§1's ordering and §3's
  chunked row loop cite this record in place).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read `0866` on the rebased
  base `533bc7f5` (the trunk's highest record is `ADR-0865`), and the carried pin commit `01497219`
  holds `ADR-0866` and sets that cell to `0867` — its `docs/adr/README.md` merged here as a union
  with the trunk's `0865` row. The sweep immediately before minting found no `ADR-0867`/`ADR-0868`
  file on the trunk, in any `.worktrees/*/docs/adr` tree, in `git rev-list --objects --all --
docs/adr`, or on any of the (then) nineteen open PR heads. This record therefore takes `0867` and
  advances **only** the `OP-136 jobs lane` cell to `0868`; both `unallocated (future lanes)` cells
  stay `0869`. No number outside `0849`–`0868` is consumed.

## Context

ADR-0861 §2 recorded the ordering this record changes, in its own words:

- **Announcement arm:** the oracle derives `indexed` **and**
  `pipeline.indexedNotifiedAt == null` → `emitDomainEvent`, **then** one `updateOne` that stamps the
  latch **and** the checked triple (emit before marker — ADR-0856 §2).
- **Every other candidate** (latched, `indexing`, `delayed`, `partial_failure`) → one `updateOne`
  that stamps the checked triple only, and the row still counts in `skipped`.
- **Batch arm:** unchanged code, iterating _the same page_.

So every candidate left the page inside the announcement loop, and the OP-126 batch arm ran only
afterwards, over the page's batches in chunks of eight. A run that aborted between the two — a
transient driver error on the arm's read, or an invocation killed mid-run — therefore lost that
batch's §4.7 summary permanently for the counters it was owed for: the row was no longer a
candidate, so no later tick re-read it. Measured at `496c7186` in a probe worktree (the arm armed to
throw on its first batch, everything else byte-identical): run 1 `{ summaries: 0, indexedRows: 1 }`,
run 2 over unchanged counters `{ scanned: 0, details: { indexed: 0, batches: 0 }, summaries: 0 }`.
Before the drain the arm re-ran on every tick because nothing ever left the page, so the emission
was retried for free; the drain removed that retry.

## Decision

### 1. The work is ordered per candidate row, and the triple goes last

No row is stamped as evaluated until **its own** arm work has completed:

1. **Announce** exactly as shipped — `derivePipelineStatus` derives `indexed` **and**
   `pipeline.indexedNotifiedAt == null` → `emitDomainEvent`, **then** one `updateOne` that stamps
   the latch **only** (emit before marker, ADR-0856 §2 / ADR-0861 §2);
2. **the row's own batches** — the discovery's pairs filtered to this row's event id, then
   `checkUploadBatchTransition` per batch, code unchanged;
3. **then the checked triple**, in its own `updateOne`.

An announced row therefore takes two `updateOne`s (the latch, then the triple), never one that
carries both: the triple may ride the latch's update only after the arm has run for that row. A row
whose arm work did not complete keeps its triple unstamped, so it is still a candidate and the next
tick retries it — ADR-0866 §1's decision, implemented.

### 2. What does not change

- `derivePipelineStatus` stays the oracle; the latch is still `pipeline.indexedNotifiedAt`, written
  with the injected clock; the dedupe key stays `pipeline.event.indexed:<eventId>`; the first
  announcement still carries `notifyByEmail: true`.
- The candidate page stays the change-scoped `$expr` with `.sort({ _id: 1 }).limit(limit)` and one
  query, and the discovery stays the same grouped aggregate per tenant (ADR-0862 §1). It now runs
  **before** the row loop, so an abort in it stamps nothing at all and the whole page retries.
- `details.batches`, `scanned`, `skipped` and the emitted shapes are unchanged; `details.batches` is
  still the size of the discovery, not the number of rows.
- `checkUploadBatchTransition`, the routes and the sibling jobs are untouched.

### 3. The cost bound moves from batches to rows

The concurrency unit is now a candidate row, and a chunk of eight rows still goes out at once
(`ROW_CHECK_CONCURRENCY`), each row's own batches in turn. A throw inside a chunk surfaces only
after the chunk has settled (`Promise.allSettled`, then rethrow the first rejection), so no write
from the rejected run outlives the rejection — a caller that retries immediately cannot race the
aborted run's own writes.

## Evidence

### The pin

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` is carried byte-identically from
`01497219`: ADR-0852's eight cases, ADR-0859's `I9`–`I11` and ADR-0860's `I12`–`I16` in order and
numbering, plus `I17` (the RED pin at that head) and `I18`/`I19`. The whole file is `19 passed (19)`
with this change; at the pin head it was `1 failed | 18 passed (19)`.

`I17` names no marker, no ordering and no query: one event the status table derives as `indexed`
with one worker-settled batch, one transient failure thrown on the arm's read, run 1 must reject,
and the next tick over unchanged counters must leave exactly one `upload.batch.completed` carrying
its `batchId` / `eventId` / `fileCount`. Both the discovery-first ordering and the per-row stamp
satisfy it; the ordering above is the shape this record chooses.

### Why the ordering is load-bearing

`I17`'s injection is a one-shot `Collection.prototype.find` failure on `event_images`, thrown by
`readBatchSnapshot` inside `checkUploadBatchTransition` — the discovery uses the grouped
`aggregate`, so the failure lands in the arm proper, **after** the row's announcement and latch. Two
throwaway mutations of the shipped file, each restored byte-identically afterwards
(`sha256 0744e6b5…82112` both sides, `git status --porcelain` empty):

- stamp the checked triple before the row's batch loop → `1 failed | 18 skipped`, `a batch whose arm
work was cut off must be summarised by a later run: expected [] to have a length of 1 but got +0`;
- the shipped ordering (triple last) → `19 passed (19)`.

### Gates

- `vitest run --project unit --project integration --coverage` green: `326 files / 4583 passed |
3 skipped`, exit `0`, branches `80.42 %` (gate 80), statements `91.68 %`, lines `91.81 %`;
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
- `eslint` 0 issues and `prettier --check` clean on the touched paths;
- the six `adr-*` guards green.

The diff is one production file (the ordering, the per-row grouping and the chunked row loop), this
record, and the `docs/adr/README.md` bookkeeping — no test, fixture, helper or frozen pin edited.

## Assumptions

- **A1** — the discovery read runs before any announcement. It reads the same page the announcement
  loop walks, so the move changes no observable except the retry: a failure in it now leaves
  **every** row of the page a candidate, instead of the rows the loop had not yet stamped.
- **A2** — a retried row re-checks batches already summarised. That is absorbed twice: the
  announcement by the latch and the stable dedupe key, the summary by the outbox's
  `(batch, uploader)` key (ADR-0760 D4).
- **A3** — the concurrency unit. A row holds one or a few batches in practice, so eight rows in
  flight keeps the number of checks in flight that ADR-0862 §3 measured as the win; a single row
  holding many batches now runs them in turn, which the page-wide `limit` bounds.
- **A4** — `Promise.allSettled` is the settle-then-rethrow seam. Rows later in the failing chunk
  never run (their triples stay unstamped, so they retry) and rows earlier in it have completed
  their own arm work, which is why they may keep their stamps.

## Out of scope

- **A two-abort pin** — `I17` aborts once, so a weaker fix could still drop a summary on a repeat
  abort. `t_a31e0548` strengthens the pin; this ordering holds for any number of aborts, because
  the stamp is the only thing that ends the retry.
- **The `pending` slice's allocation bound** — `t_eeb212c2` / ADR-0862 owns it; the slice stays
  capped by `limit`.
- **`scanned` / `skipped` as values**, the marker's name, the sort key and the query shape.
- **The announcement leg's own emit-before-marker window** (ADR-0856 §2) and the routed
  `pipeline.event.indexed` row, which no case here re-pins.

## Consequences

- A run that aborts inside the arm loses no summary: the row stays a candidate, the next tick
  retries the arm, and the outbox's dedupe key keeps the repeat a no-op at the uploader's inbox.
- The batch arm's work is bound to the row that owes it, so a page's earlier rows finish and leave
  the page even when a later row aborts — the retry window is per row, not the whole page.
- ADR-0861 §2's one-`updateOne` shape is superseded for the announced case by this record; the rest
  of ADR-0861 stands.
- `docs/adr/README.md` is the shared-ledger hotspot: this index row, this lane note and the lane
  cell merge as a union keeping the higher cells (`0868` lane, `0869` pool).
