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

## Review (round 1)

**Verdict: APPROVED WITH FINDINGS.** This section reviews PR #670 at head `1b38307d` (squash
`40b65309`, on the trunk as `9bda367e`), the delivery recorded above.

**No decision in §1–§A4 is retracted.** §1's ordering, §2's unchanged list, §3's cost bound, the
four assumptions and §Out of scope stand as written. The findings below are one routed design
decision, one ledger allocation, one measured characterization and one docs observation. None of
them withdraws a decision, changes an assumption or narrows §Out of scope. Each follow-up's own
record documents what followed it.

### The delivery matches the card

- **One production file.** `git diff --numstat 40b65309^ 40b65309` answers `67 44` (added,
  deleted) for `apps/web/src/server/jobs/pipeline-indexed-check.ts`; the other four paths are the
  pin file (`258 2`, the carried `t_488f057b` / ADR-0866 bytes), ADR-0866 (`183 0`), this record
  (`171 0`) and `docs/adr/README.md` (`68 1`). No test, fixture or helper was edited by the
  GREEN.
- **The per-row ordering is what shipped.** In `checkRow`, the announcement and its latch
  (`pipeline.indexedNotifiedAt`, one `updateOne`) run first, then
  `checkUploadBatchTransition` for each of that row's own batches, then the checked triple in
  its own `updateOne`. A row that announces therefore takes two stamps, never one that carries
  both (§1).
- **§2's unchanged list holds.** `derivePipelineStatus` is still the oracle; the latch, the
  dedupe key `pipeline.event.indexed:<eventId>`, the `notifyByEmail: true` first announcement,
  the change-scoped `$expr` page with `.sort({ _id: 1 }).limit(limit)`, the grouped discovery
  moved before the row loop, and `details.batches` / `scanned` / `skipped` are unchanged.
  `checkUploadBatchTransition`, the routes and the sibling jobs are untouched. The production
  file's sha256 is `0744e6b5…82112` at the squash and on today's trunk, and no commit since the
  squash names it.

### The gates, at the reviewed head

Reproduced at `1b38307d` by the round-1 review:

- **Full suite:** green at `vitest run --project unit --project integration --coverage`:
  `326 files / 4583 passed | 3 skipped`, exit `0`, branches **`80.42 %`** (gate 80),
  statements `91.68 %`, lines `91.81 %`.
- **The pin file:** `19 passed (19)`.
- **Types and lint:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 issues;
  `prettier --check` clean on the five PR paths.
- **The ledger guards:** the six `adr-*` guards `6 files / 236 passed (236)`.

### The ordering is load-bearing — the reviewer's own mutation

In a throwaway probe worktree at the shipped tree, the checked-triple `updateOne` moved
**before** the row's batch loop (everything else byte-identical) reddens **`I17` alone**:

```
a batch whose arm work was cut off must be summarised by a later run:
  expected [] to have a length of 1 but got +0
```

The round-1 review measured that mutation on its 22-case probe variant of the spec
(`1 failed | 21 skipped`). Re-measured for this section on the shipped 19-case file, the same
mutation answers `1 failed | 18 passed (19)`: `I17` the only red, the same assertion. The
production file was restored byte-identically afterwards (`sha256 0744e6b5…82112`), and the
shipped ordering answers `19 passed (19)`.

### Two probes on the property §1 promises

Both were measured by the round-1 review at `1b38307d` and measured again for this section at
the squash `40b65309`, with identical numbers.

- **The retry is not one-shot.** Two one-shot aborts fired, then a third tick with the injection
  cleared:

  ```
  {"rejected":[true,true],"fired":2,"afterTwoAborts":0,"thirdScanned":1,
   "summaries":1,"batchIdMatches":true}
  ```

  No summary exists after the two aborts, the third tick scans the row again, and exactly one
  `upload.batch.completed` lands for that batch — because the triple, not the tick count, is
  what ends the retry.

- **A poison row is a run failure, not permanent head-of-line blocking.** One event whose arm
  read throws on **every** call, as the lowest `_id` of eleven candidates (`requestedLimit: 12`,
  `ROW_CHECK_CONCURRENCY = 8`), three ticks then one cleared tick:

  ```
  {"ticks":[{"tick":0,"rejected":true,"announcedAfterTick":8},
            {"tick":1,"rejected":true,"announcedAfterTick":11},
            {"tick":2,"rejected":true,"announcedAfterTick":11}],
   "cleared":{"scanned":1}}
  ```

  Every tick rejects and `errors` stays `0`, so the envelope cannot tell that run from a clean
  one; but the page advances at up to `ROW_CHECK_CONCURRENCY - 1` = **7 rows per tick** while
  healthy rows remain, and stops only when the poison row is the last candidate. This is a
  permanent run failure plus a throughput cap, **not** the permanent stall the finding card
  assumed. Routed, with the premise corrected, to `t_39d7b19f`.

### The landing proof

- `git rev-parse 48bd808f^{tree}` == `git rev-parse 40b65309^{tree}` ==
  `d02fe3e448d2135aa0b40474c42ca8be5d017e18`. `48bd808f` merges the trunk (`e8cf60b0`, the
  docs-only ADR-0863 sign-off) into the reviewed head `1b38307d`, so **the tested bytes are the
  shipped bytes**: that merge changed no code the pins read.
- The pin file and ADR-0866 carry `sha256 2174e452…0fc216` and `cb105c3b…05b1e0`, identical to
  `01497219` — at `01497219`, at the squash `40b65309` and at the review-time trunk `9bda367e`.
  On today's trunk both have moved: six later commits took the pin file from `I1`–`I19` to
  `I1`–`I25`, and `t_4cfda896` appended the ADR-0866 sign-off section as `88d65749`. That is
  later lane work, not a change to this delivery, and the production file has not moved.
- The superseded draft-pins PR **#668** was **closed unmerged** (`state: CLOSED`,
  `mergedAt: null`, closed `2026-11-17T20:52:26Z`) and its branch
  `OP-136-task-batch-arm-retry-pins` is deleted from `origin`, once the pins were proven
  byte-identical on the trunk. PR #668 could not merge by construction: its RED was what this
  GREEN answers.

### Routing

Cited by card id, never by an ADR number that a still-unmerged follow-up may renumber:

- **`t_39d7b19f`** — the poison-row liveness decision (finding above). Its premise was
  corrected by comment with the measured numbers, and the decision of record is **option 1,
  contain per row**: count the failure in `errors`, keep the remaining rows and chunks running,
  warn `pipeline.indexed_check.row_failed` naming the event, and leave the row's triple
  unstamped so the retry survives. §1 is unchanged by it. The chain behind that decision is
  `t_fba690f8` (RED), `t_6275f30a` (GREEN) and `t_05687f95` (review and land).
- **`t_f21a0110`** — the lane's ADR-number allocation. The OP-136 block `0849`–`0868` is
  exhausted by this delivery: `0867` is the highest record and the cell `0868` is the last
  number of the range and **contested** (`t_76021c6a` holds an uncommitted `0868` record). The
  allocation is recorded there; this card consumes no number.
- **`t_a31e0548`** — the two-abort pin. It is a **characterization, not a RED**: §Out of scope
  records that `I17` aborts once, and the probe above measures that the shipped ordering already
  survives a second abort, so the case is green on arrival. It has since landed as PR #675
  (squash `e311b4e6`), as `I23` inside the same `describe` block.

### What later landed in this lane

A reader arriving after this record should not read §Evidence's `19 passed (19)` as the trunk's
case set. In order:

- `t_67919e68` (squash `c4ddaca1`) added `I24` — an event with **two** settled batches gets both
  summaries. It is the first case with room to spare (`requestedLimit: 50`) and exact ids, so it
  pins the per-row grouping's **completeness**; a last-batch-wins grouping reds it.
- `t_db7bf45a` (squash `62596df6`) corrected `I24`'s doc-comment, whose prose claimed no fixture
  ever made one event own two batches — measurably false, since `I21`/`I22` each put two of an
  event's three batches on the page at `limit: 2`, and a last-pair-wins grouping reds three cases
  rather than one. The same card added `I25` — one event with **three** settled batches, all
  three ids — which closes the only residual gap this review recorded (a grouping bounded to the
  last two batches per event scored `24 passed (24)` before it).
- `t_a609b659` (squash `c63f2e47`) retitled that block so the title covers both `I24` and `I25`.

### Hygiene and posture

The production diff carries no fixture-specific branch, no test-environment conditional, no lint
suppression, no new dependency and no `console` noise. This section appends to an existing
record: it **consumes no ADR number**, adds no index row and leaves `docs/adr/README.md`
byte-identical (`sha256 22d81888…ad9b1f` before and after, measured at this card's base
`06599bb6`; the `0867` index row, the lane note and the cells (`0877` lane, `0877` pool) keep
the values the trunk carries). The ledger moves only when a card mints a record, and the records
that follow this one belong to their own cards.
