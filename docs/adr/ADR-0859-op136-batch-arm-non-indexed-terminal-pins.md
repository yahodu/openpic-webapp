# ADR-0859 — OP-136 TEST: the OP-126 batch arm covers the non-indexed terminal events too

- **Status:** Accepted (characterization) · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_71729b5e` (Low; finding **F1** of the review of the pin
  card `t_7e31328b`, whose pins shipped on PR #631 at `228df183`; branch
  `OP-136-task-batch-arm-non-indexed-terminal-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from `origin/main`
  `718166ec`). The parent GREEN `t_16239628` landed as `b62256b8`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — "Events where
  all queued images reached a terminal state → mark indexed", plus the card's own
  scope note "+ batch transition check from OP-126"), §4.1 (the pipeline-status
  table), §5.5 (the batch phases and the `complete_with_errors` phase),
  notification design §4.7 (the `upload.batch.completed_with_errors` line),
  schema §16.2 (`upload_sessions`), §16.3 (`event_images`).
- **Consumes:** [ADR-0852](ADR-0852-op136-indexed-check-matrix-latch-batch-pins.md)
  §4 (the eight pins these extend — its "Out of scope" list names this exact
  gap), [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md)
  §2 F2 (the arm as shipped: `checkUploadBatchTransition` per distinct
  `event_images.uploadBatchId` of **each candidate** event),
  [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this cron is
  the named caller of `checkUploadBatchTransition`) and §D4 (the
  `(batch, uploader)` dedupe key and the `fileCount` payload).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
  (the three appended pins, cases `I9`–`I11`).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read
  `0858` at this head (`718166ec`). The sweep immediately before minting found
  `ADR-0858*` in flight only, on the open PR #641 head
  (`OP-136-task-anonymize-injection-shape`, `de739d20`) and in the worktree
  `.worktrees/t_8901d758` that produced it, and `ADR-0857` as the highest record
  on the trunk. That PR squash-merged as `cbab1f0f` while this card was being
  written, so the trunk now carries `ADR-0858` and its cell reads `0859`; this
  record is still the first number above the highest one in flight, and no
  `ADR-0859*` existed on the trunk (`cbab1f0f`), in any `.worktrees/*/docs/adr`,
  in `git rev-list --objects --all -- docs/adr` or on any open PR head. It
  therefore takes `0859` and advances **only** the `OP-136 jobs lane` cell to
  `0860`; both `unallocated (future lanes)` cells stay `0869`. No number outside
  `0849`–`0868` is consumed and no range is re-cut.

## Context

ADR-0852 §4 pinned the OP-126 batch arm
(`checkUploadBatchTransition`, `apps/web/src/server/uploads/batch-notifications.ts:278`)
through **one** state: a batch whose `event_images` are all `done` inside an event
the §4.1 table derives as `indexed` (`I7`/`I8`). Its own "Out of scope" list
recorded the remainder:

> A batch that settles as `complete_with_errors` (a failed image) inside a
> `delayed` event: the card scopes the arm to the settled-batch happy path, so
> only `upload.batch.completed` is pinned, and its negative twin is asserted.

That gap is not cosmetic. The job card scopes the arm to "the batches of **each
candidate** event", and `delayed` (every photo failed) and `partial_failure`
(some failed) are the other two all-terminal states §4.1 names. An uploader whose
batch settled as `complete_with_errors` inside a partly-failed event is therefore
precisely the person who must be told — the event is deliberately **not**
announced as searchable, so the batch summary is the only notification they will
ever get about that upload.

The consequence for a GREEN is sharp: an implementation that drove the arm only
for the events it announces passes all eight of ADR-0852's pins while that
uploader is never told. That is the finding this card closes, and the mutation
probe in §Evidence reproduces it exactly: the eight existing pins stay green
while the arm is narrowed to the announced events.

## Decision

### 1. Three appended cases, one new `describe` block, nothing existing touched

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` gains **168
appended lines** and **zero** deletions. The eight frozen cases, their fixtures,
their seed helpers (`seedEvent`, `seedBatchImage`, `seedCompletedSession`,
`hashFor`, `runJob`, `outboxFor`, `indexedRowsFor`) and every existing constant
are byte-identical; the new block adds its own seed helper
(`seedSettledFailingBatch`) and its own three constants
(`BATCH_COMPLETED_WITH_ERRORS_EVENT`, `PARTIAL_FAILURE_COUNTERS`,
`ALL_FAILED_COUNTERS`).

`seedSettledFailingBatch(counters, statuses)` seeds one event with the given §4.1
counters, one `batchId`, and — per entry in `statuses` — one `upload_sessions`
row already `completed` and one `event_images` row carrying that
`processing.status`, **all with the raw driver**. The completion route is never
called: this is the worker's own end state, exactly the state the arm reads.

### 2. `derivePipelineStatus` is the oracle, asserted before the outbox

Each case proves its seeded shape derives the state it claims
(`partial_failure`, then `delayed`) and only then counts rows. The status is
never re-derived arithmetically in the spec, so a future change to the §4.1 table
moves the pin with it.

### 3. What is pinned: the errors summary, exactly once, and its negative twin

- `I9` — a `partial_failure` event (`{imageCount: 3, processedImageCount: 1,
failedImageCount: 2}`) whose one batch is one `done` and two `failed` images
  with three `completed` sessions. One run must write **exactly one**
  `upload.batch.completed_with_errors` row: the event's tenant, `subjectRef`
  `{kind: "user", id: <uploader>}`, `payload.batchId`, `payload.eventId`,
  `payload.fileCount` 3. **No** `upload.batch.completed` row for the same batch,
  and no `pipeline.event.indexed` row for the event.
- `I10` — the same for a `delayed` event (`{imageCount: 2,
processedImageCount: 0, failedImageCount: 2}`), both images `failed`,
  `payload.fileCount` 2.
- `I11` — both shapes seeded together, one run, then a second run **7 h later**
  (a full 6-hour dedupe bucket away). The first run writes exactly two errors
  summaries, one per batch id; the second adds none, and no
  `upload.batch.completed` row ever appears.

`fileCount` is the batch's **session** count (3 and 2), because that is what
`readBatchSnapshot` folds into `files.total` and what ADR-0760 §D4's payload
contract multiplies into the email's "N files" line. The pins read the payload,
not the resolver.

The idempotence half is pinned as a **count**, never as a key: whether the second
run is stopped by the outbox's `(batch, uploader)` dedupe key or by a hypothetical
per-batch marker, one batch is one summary. `I11` also asserts the two first-run
rows can be matched back to their own batch ids, so a run that wrote two rows for
one batch and none for the other cannot pass on the total.

## Evidence

### Green on arrival, and load-bearing

The three cases are **characteristically green at this head** (`Tests 11 passed
(11)`: ADR-0852's eight plus the three new ones), which the reviewer's card
comment predicted: `pipeline-indexed-check.ts` iterates `candidates` — every
event with `counters.imageCount > 0`, whatever its derived status — for the
batch arm, while the announcement loop is the only place the derived status
gates anything.

A green characterization is worthless unless it bites, so the gap was reproduced
by narrowing the arm to the announced events only (a throwaway mutation of
`apps/web/src/server/jobs/pipeline-indexed-check.ts`: the batch loop iterated
`candidates.filter((row) => derivePipelineStatus(pipelineCounts(row)) === "indexed")`):

```
I9   AssertionError: expected [] to have a length of 1 but got +0
I10  AssertionError: expected [] to have a length of 1 but got +0
I11  AssertionError: expected [] to have a length of 2 but got +0
Test Files  1 failed (1) · Tests  3 failed | 8 passed (11)
```

The `8 passed` is the point of the card: ADR-0852's eight pins are blind to the
narrowing. The production file was restored byte-identically afterwards
(`sha256 5eb913d4153cef1715c9a08bc1a07b1d430e85a7e1a2a4633e875f31c3ef00de`
before and after; `git status --short` shows only the spec, `git diff --numstat`
\=`168 0`).

### Gates

`npx vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
→ `Tests 11 passed (11)`; `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
`eslint` on the spec 0 errors / 0 warnings; `prettier --check` clean; the six ADR
guards (`adr-consumers`, `adr-inline-code-spans`, `adr-lane-ranges`,
`adr-numbering`, `adr-record-links`, `adr-source-references`) green. No
production file in the diff.

## Assumptions

- **A1** — a batch of `completed` sessions whose images are a mix of `done` and
  `failed`, with no `queued`/`processing` left, derives `complete_with_errors` in
  `deriveUploadBatchPhase` (its `settled` count covers all sessions, and
  `pipeline.failed > 0` decides the phase). The two seeds satisfy that, so the
  scenario is reachable without the completion route.
- **A2** — "the batch's uploader" is `upload_sessions.createdByUserId`, the only
  identity the batch read has. All sessions of a seeded batch share one uploader,
  so the per-uploader loop emits one row; a batch with **two** organizers is not
  seeded here.
- **A3** — the event counters are the oracle's whole input and the arm never
  compares them with the join rows, so a seed that disagreed would still pin the
  arm. The pins keep them consistent anyway, because an inconsistent seed would
  document nothing.
- **A4** — `I11`'s 7-hour offset is the next 6-hour bucket in spirit only: no key
  in this path carries a bucket, and the second run is over the same rows, which
  is the strongest form of the re-check.

## Out of scope

- **The scan window.** The reviewer's High finding on the parent GREEN (H1: the
  per-event latch is an in-loop discriminator, never a candidate predicate, so
  the fixed first-limit page never drains) means a batch on an event **past the
  page** is still never summarised. These pins seed one or two events per case
  and the default limit is 500, so the page is never exceeded; the drain itself
  is `t_07d09535`/`t_6a0e3e55`.
- **The arm's cost.** The per-event `event_images` reads, the `O(limit^2)`
  materialisation and the sequential awaits are `t_eeb212c2` (M1).
- A batch that settles as `complete` (no failure) inside a `partial_failure` or
  `delayed` event — the D4 dedupe key is per batch, so such a summary is legal
  and unpinned.
- Multiple uploaders in one batch, `payload.durationMs`, the `payload.files`
  sub-object, and the `failures[]` copy (`processing.lastError` is `null` in the
  seeds, so the failures arm collapses to the generic view and is not read).
- The outbox-failure path: `checkUploadBatchTransition` swallows a broken outbox
  through `safeEmit` and this cron never surfaces it; that is ADR-0760's subject.

## Consequences

- A GREEN that drives the arm only for the events it announces — the natural
  reading of "announce the indexed ones, then summarise their batches" — now
  reds `I9`, `I10` and `I11` while ADR-0852's eight stay green, which is exactly
  the failure mode this card was opened for.
- The arm is now pinned in **both** directions of §5.5's terminal split:
  `complete` (ADR-0852 `I7`/`I8`) and `complete_with_errors` (this record), so a
  refactor that folds the two event keys together reds one of the four.
- Because the trio is a characterization, there is no GREEN sibling: the PR is a
  normal test PR, not a draft.
- `docs/adr/README.md` is the lane's hotspot: this index row, this lane cell and
  this note merged as an **index-only union** against PR #641's `ADR-0858`, which
  squash-merged as `cbab1f0f` mid-work — its index row and its note are kept
  verbatim, this record's row and note are appended, and the lane cell takes the
  higher value (`0860` lane / `0869` pool). `0851`, `0854` and `0856` carry no
  index row on this head; this record adds only its own and leaves those as it
  found them.
