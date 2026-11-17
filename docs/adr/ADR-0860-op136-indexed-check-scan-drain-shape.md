# ADR-0860 — OP-136 TEST: the indexed check's scan window drains, so no event is starved

- **Status:** Accepted (RED pins + decision of record) · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_07d09535` (High; finding **H1** of the review of the OP-136
  GREEN `t_16239628`, which landed as PR #635 / squash `b62256b8`; the design is the
  decision card `t_ec9726b1`'s, recorded here as the decision of record; the parent
  `t_00b26876` appended ADR-0852's round-1 sign-off as `20fcf119`). Branch
  `OP-136-task-indexed-check-scan-window-advance`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from `origin/main`
  `20fcf119`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — every 5 minutes,
  `→ mark indexed`) and its bounded-cron rules (`limit`, `hasMore`, idempotence),
  §4.1 (the pipeline-status table), notification design §4.7 (the
  `pipeline.event.indexed` and `upload.batch.completed` lines), schema §15.1 (the
  `events` document and its `counters` cache).
- **Consumes:** [ADR-0852](ADR-0852-op136-indexed-check-matrix-latch-batch-pins.md) §4
  (the eight frozen pins this record appends beside, and the pin vocabulary),
  [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md) §1–§2
  (`derivePipelineStatus` as the single oracle; the `pipeline.indexedNotifiedAt`
  latch; the OP-126 arm over every candidate event),
  [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) §2 (emit before the
  marker it feeds), and [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md)
  §A1 (this cron is the named caller of `checkUploadBatchTransition`).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
  (the four appended cases `I12`–`I15`).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read `0860` on
  this base (`20fcf119`). The sweep immediately before minting found `ADR-0859` as the
  highest record on the trunk, in every `.worktrees/*/docs/adr` tree (their maxima are
  `0851`–`0859`), in `git rev-list --objects --all -- docs/adr` and on all eighteen
  open PR heads fetched into `refs/remotes/pr/*` — no `ADR-0860*` on any surface. This
  record therefore takes `0860` and advances **only** the `OP-136 jobs lane` cell to
  `0861`; both `unallocated (future lanes)` cells stay `0869`. No number outside
  `0849`–`0868` is consumed and no range is re-cut.

## Context

The shipped job selects its candidates with

```ts
const raw: unknown = await events
  .find({ "counters.imageCount": { $gt: 0 } })
  .limit(limit)
  .toArray();
```

and applies the per-event latch (`pipeline.indexedNotifiedAt`) only **inside** the
loop. That page is a fixed first-`limit` slice over a set its own work never leaves:
a latched row keeps its slot for ever, and a `delayed` / `partial_failure` row never
latches at all, so it holds a slot for ever too. Every event ordered after the first
`limit` rows is therefore starved — never announced, and never handed to the OP-126
batch arm, so a worker-settled batch on it is never summarised either. `hasMore`
reports `true` for ever while nothing can be drained, which is the opposite of the
backpressure signal §10.2 promises.

Measured at `3e6d7e1e` (a throwaway probe; no lane file touched) with three events
that all derive `indexed` and `requestedLimit: 2`:

```
run1: scanned 2, affected 2, details {"indexed":2,"batches":0}
run2 (7 h later): scanned 2, affected 0, details {"indexed":0,"batches":0}
afterRun2: event1 {rows 1, latched true}  event2 {rows 1, latched true}  event3 {rows 0, latched false}
```

The card left two of its own instructions in tension — "the latch is the candidate
filter" against "the batch arm covers each _candidate_ event" — so the shape was
decided on `t_ec9726b1` before any pin was written, and this record is that decision.

## Decision

### 1. The candidate window is keyed on the pipeline INPUT, not on the derived status and not on the latch

A row is a candidate iff `counters.imageCount > 0` **and** its live
`(imageCount, processedImageCount, failedImageCount)` triple differs from
`pipeline.indexedCheckedCounters` — the triple this job stored when it last evaluated
that row. The filter, as decided:

```ts
{
  "counters.imageCount": { $gt: 0 },
  $expr: { $or: [
    { $eq: [{ $type: "$pipeline.indexedCheckedCounters" }, "missing"] },
    { $ne: [{ $ifNull: ["$counters.imageCount", 0] }, "$pipeline.indexedCheckedCounters.imageCount"] },
    { $ne: [{ $ifNull: ["$counters.processedImageCount", 0] }, "$pipeline.indexedCheckedCounters.processedImageCount"] },
    { $ne: [{ $ifNull: ["$counters.failedImageCount", 0] }, "$pipeline.indexedCheckedCounters.failedImageCount"] },
  ] },
}
```

plus `.sort({ _id: 1 }).limit(limit)` — siblings sort, and a deterministic page keeps
the pins stable.

### 2. One page drives both arms — no second query and no per-batch marker

- **Announcement arm:** the oracle derives `indexed` **and**
  `pipeline.indexedNotifiedAt == null` → `emitDomainEvent`, **then** one `updateOne`
  that stamps the latch **and** the checked triple. Emit first, marker second
  (ADR-0856 §2/§3: a write-then-emit order recreates the lost-announcement window this
  lane already closed).
- **Every other candidate** (latched, `indexing`, `delayed`, `partial_failure`) →
  stamp the checked triple only, and keep counting it in `skipped`.
- **Batch arm:** the code stays as it is and now iterates _the same page_. A latched
  event whose counters moved (new photos, or a new batch) is therefore still swept,
  which is why the latch must not be the filter.

### 3. Why it drains, cannot starve, and does not re-litigate the oracle

- Every evaluated row **leaves** the window until its counters move again.
  `indexing`, `delayed` and `partial_failure` rows are evaluated once per input change
  instead of holding a slot for ever, and a latched row does not hold one either. No
  fixed prefix can persist, so `hasMore: scanned >= limit` becomes a true backpressure
  signal.
- **Soundness:** a transition to `indexed` can only come from a counter change (the
  oracle reads nothing else), so such an event is in the window on the very next run
  (≤ 5 min). A latched event is never re-announced. A new batch always moves
  `imageCount` or `processedImageCount`, so its sweep lands on that change.
- The query compares **inputs**, never the derived status, so `derivePipelineStatus`
  stays the single oracle (ADR-0855 §1 is not re-litigated).
- **Known limit:** `$expr` is not index-served, so a run still scans the
  `counters.imageCount > 0` set, as it does today. The indexable refinement (a
  `counters.pipelineRevision` bumped by the counter writer) belongs to the OP-135
  counters lane and is not built here.

### 4. What is pinned, and what is deliberately not

The four cases are appended beside ADR-0852's eight frozen ones in a new `describe`
block; the frozen eight, every seed helper (`seedEvent`, `growCounters`,
`seedBatchImage`, `seedCompletedSession`, `hashFor`, `runJob`, `outboxFor`,
`indexedRowsFor`), every existing constant and every assertion are byte-identical. The
block adds its own `runJobWithLimit(at, limit)` and `seedSettledBatchOf(event)` and
nothing else.

- `I12` — **the window advances.** Three events that all derive `indexed`, one run with
  `requestedLimit: 2`, then a second run 7 h later. The first run reports
  `details.indexed: 2`; the second reports `1` (the one new event, not a repeat); each
  of the three events ends with exactly one `pipeline.event.indexed` row.
- `I13` — **no duplicate on the advance.** The same seed and two runs, with the premise
  asserted first (`outbox` holds three rows after the drain), then a third run 7 h
  later: `details.indexed: 0`, still three rows, still one per event — the drain does
  not wrap onto the page it already passed.
- `I14` — **the batch arm reaches the same events.** The third event carries a batch of
  two worker-settled files (sessions already `completed`, images already `done`, the
  completion route never called). Two runs: exactly one `upload.batch.completed`
  addressed to the batch's uploader with its `batchId`, `eventId` and `fileCount` 2,
  and no `upload.batch.completed_with_errors`.
- `I15` — **a characterization arm, green on arrival.** A `delayed` event `{2,0,2}`:
  one run announces nothing; its counters then move to `{2,2,0}` and the next run emits
  exactly one row carrying `notifyByEmail: true`. This is the discriminator against a
  "latch-as-filter" shape that would complete an un-indexed event by marking it done —
  such a row would never come back into the window.

Every assertion is an observable: outbox rows naming an event, the run's own
`details.indexed`, and the batch summary's payload. **No case names**
`pipeline.indexedCheckedCounters`, the `$expr`, `_id` order, `indexedCheckedAt`,
`scanned` or `skipped`, so a correct implementation with a different marker (or an
ordered cursor) passes. `scanned` in particular is not pinned: under this shape the
second run of `I12` reports `scanned: 1`, and the frozen pins never read it.

## Evidence

### RED at the branch head, for the documented reason

`npx vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
at the head that adds only this spec → `Tests 3 failed | 12 passed (15)`. The twelve
green are ADR-0852's eight, ADR-0859's three (which share the file) and the `I15`
characterization. The three failures are the pins, each at assertion level:

```
I12  AssertionError: expected +0 to be 1        // second run: details.indexed
I13  AssertionError: two runs must have announced all three events:
                     expected [ { …(10) }, { …(10) } ] to have a length of 3 but got 2
I14  AssertionError: expected [] to have a length of 1 but got +0   // the batch summary
```

### The pins are satisfiable, and they do not contradict the frozen ones

A faithful near-fix of the decision in `apps/web/src/server/jobs/pipeline-indexed-check.ts`
— the `$expr` filter plus `sort({ _id: 1 })`, the latch stamped with the checked triple,
and the triple-only stamp on every other candidate — turns the whole file green:

```
Test Files  1 passed (1)
     Tests  15 passed (15)
```

so the new pins and ADR-0852's eight (and ADR-0859's three) agree on one implementation.
The production file was then restored byte-identically
(`sha256 5eb913d4153cef1715c9a08bc1a07b1d430e85a7e1a2a4633e875f31c3ef00de` before and
after; `git status --short` shows only the spec, `git diff --numstat` = `177 0`). No
production file is in the diff.

### Gates

`npx vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
→ the `3 failed | 12 passed (15)` above (RED is the gate for this card);
`tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the spec 0 errors /
0 warnings; `prettier --check` clean; the six ADR guards (`adr-consumers`,
`adr-inline-code-spans`, `adr-lane-ranges`, `adr-numbering`, `adr-record-links`,
`adr-source-references`) green.

## Assumptions

- **A1** — the three seeded events are reached in seed order by whichever page order
  the implementation picks. `I12` and `I13` assert only counts, one per event, so any
  order satisfies them. `I14` needs the batched event to be the one beyond the first
  page; it is seeded last, and a `_id` sort (the decided shape) and natural insertion
  order agree on that, which the RED and the near-fix both confirm.
- **A2** — "the announcement window advances" is pinned as _every event ends with
  exactly one row_, never as _which_ row a given run announced, so a drain that pages
  by any key satisfies it.
- **A3** — `I15` is declared a **characterization**, not a RED: the shipped code has no
  marker, so nothing starves it. Its target is the wrong fix (latch-as-filter), and its
  red is demonstrated by any shape that completes a non-indexed event by marking it.
- **A4** — `I14` seeds the batch on an event that also derives `indexed`, so the run
  that reaches it both announces it and sweeps its batch; the case asserts only the
  batch observable, because `I12` owns the announcement.
- **A5** — the batch seeds reuse the file's own helpers, so the sessions are 12 minutes
  old and the images carry `finishedAt` one minute ago, the shape `I7` already proves
  yields `complete` at the `NOW` instant.

## Out of scope

- **The siblings.** `attendee-no-match-check`, `upload-session-sweep` and
  `verification-nudge` share the fixed-page shape but only emit, so outbox dedupe masks
  it; the drain decision for that class is `t_c32ed838`, not this card.
  `event-window-sweep`, `retention-warnings` and `pipeline-sweep` already drain by state.
- **The arm's cost.** The per-event `event_images` reads and the `O(limit^2)`
  materialisation are `t_eeb212c2` (M1).
- **The indexable refinement** of the candidate filter (`counters.pipelineRevision`),
  named as a known limit in §3 and owned by the OP-135 counters lane.
- **`hasMore`** as a backpressure signal: §10.2's contract is not asserted here, because
  the frozen pins never read it and a page-size choice would prescribe an
  implementation detail.
- **The outbox-failure path** inside the run (ADR-0856's subject), and the
  `delayed` → `indexed` transition's _payload_ beyond `notifyByEmail` (ADR-0852 `I5`
  owns the payload).

## Consequences

- A GREEN that keeps the fixed first-`limit` slice reds `I12`, `I13` and `I14` while
  ADR-0852's eight stay green — exactly the starvation the review measured — and a GREEN
  that "fixes" it by making the latch the candidate filter reds `I15`.
- Every evaluated row now leaves the window until its input changes, so the OP-126 arm
  is reached for an event beyond the first page and `hasMore` can finally go false.
- The pins are order-, field- and mechanism-agnostic, so a later re-implementation of
  the drain (a cursor, a revision counter) keeps them green.
- **This PR is a draft** (OP-93 / ADR-0306): a RED pin PR must never be squash-merged,
  because the GREEN `t_6a0e3e55` carries these cases forward unchanged.
- `docs/adr/README.md` is the lane's hotspot: this index row, this lane cell and this
  note merge as a union keeping the higher cell (`0861` lane, `0869` pool).
