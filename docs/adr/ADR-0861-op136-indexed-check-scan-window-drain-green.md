# ADR-0861 — OP-136 GREEN: the indexed check's scan window drains on the pipeline input

- **Status:** Accepted (GREEN) · **Date:** 2026-11-17
- **Card:** OP-136 GREEN `t_6a0e3e55` (High; finding **H1** of the review of the OP-136 GREEN
  `t_16239628`, PR #635 / squash `b62256b8`; carrying the pins of `t_07d09535` / ADR-0860 at
  `4ec78c79` byte-identically). Branch `OP-136-feature-indexed-check-scan-window-drain`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the pin head `4ec78c79` so the
  sixteen pins ride along.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row's bounded-cron rules — `limit`,
  `hasMore`, idempotence), §4.1 (the pipeline-status table), notification design §4.7 (the
  `pipeline.event.indexed` and `upload.batch.completed` lines), schema §15.1 (the `events`
  document and its `counters` cache).
- **Consumes:** [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) §1–§3 (the decision of
  record: the change-scoped `$expr` filter, `.sort({ _id: 1 })`, one page for both arms),
  [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md) §1–§2
  (`derivePipelineStatus` as the single oracle; the `pipeline.indexedNotifiedAt` latch; the
  OP-126 arm), [ADR-0856](ADR-0856-op136-sweep-failure-windows-resume.md) §2 (emit before the
  marker it feeds), and [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this
  cron is the named caller of `checkUploadBatchTransition`).
- **Consumers:** `apps/web/src/server/jobs/pipeline-indexed-check.ts` (§1's filter and §2's two
  marker arms cite this record in place).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read `0861` on this base
  (`4ec78c79`, the pin head that carries ADR-0860). The sweep immediately before minting found
  `ADR-0860` on exactly two surfaces — open PR #653, which is this branch's own base, and this
  lane worktree — the trunk's newest record `ADR-0859` (its cell reads `0860`), the highest record
  on each of the seventeen open PR heads `0860` or below, every `.worktrees/*/docs/adr` tree
  `0860` or below, and `git rev-list --objects --all -- docs/adr` with zero `ADR-0861` objects. This record therefore
  takes `0861` and advances **only** the `OP-136 jobs lane` cell to `0862`; both
  `unallocated (future lanes)` cells stay `0869`. No number outside `0849`–`0868` is consumed.

## Context

The shipped job (ADR-0855) selects its candidates with a fixed first-`limit` slice,

```ts
const raw: unknown = await events
  .find({ "counters.imageCount": { $gt: 0 } })
  .limit(limit)
  .toArray();
```

and applies the per-event latch only **inside** the loop. Nothing the loop writes removes a row
from that page, so a latched row holds its slot for ever, and a `delayed` / `partial_failure` row
never latches and holds one too. Every event ordered after the first `limit` rows is starved:
never announced, and never handed to the OP-126 arm, so a worker-settled batch on it is never
summarised. `hasMore` then reports `true` for ever while nothing can be drained — the opposite of
the backpressure signal §10.2 promises. ADR-0860 §Context measured it (`3e6d7e1e` probe: three
`indexed` events, `requestedLimit: 2`; run 2 reports `details.indexed: 0` and the third event keeps
zero rows) and recorded the shape that drains; the pins `I12`–`I16` are that shape's contract.

## Decision

### 1. The candidate page is change-scoped on the pipeline INPUT

A row is a candidate iff `counters.imageCount > 0` **and** its live
`(imageCount, processedImageCount, failedImageCount)` triple differs from
`pipeline.indexedCheckedCounters` — the triple this job stored when it last evaluated the row:

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

plus `.sort({ _id: 1 }).limit(limit)`, so the page is deterministic. Every evaluated row leaves the
window until its counters move again, which is what makes `hasMore: scanned >= limit` drain.

### 2. One page drives both arms; the latch is not the filter

- **Announcement arm:** the oracle derives `indexed` **and**
  `pipeline.indexedNotifiedAt == null` → `emitDomainEvent`, **then** one `updateOne` that stamps
  the latch **and** the checked triple (emit before marker — ADR-0856 §2).
- **Every other candidate** (latched, `indexing`, `delayed`, `partial_failure`) → one `updateOne`
  that stamps the checked triple only, and the row still counts in `skipped`.
- **Batch arm:** unchanged code, iterating _the same page_. A latched event whose counters moved
  is still swept, which is exactly why the latch cannot be the candidate filter.

### 3. Why this drains and does not re-litigate the oracle

- A transition to `indexed` can only come from a counter change (the oracle reads nothing else), so
  such an event is in the page on the very next run (≤ 5 min). A latched event is never
  re-announced — the announcement still requires an unset latch. A new batch always moves
  `imageCount` or `processedImageCount`, so its sweep lands on that change.
- The filter compares **inputs**, never the derived status, so `derivePipelineStatus` stays the one
  oracle (ADR-0855 §1).
- Neither rejected shape is adopted: latching every evaluated row reds `I15` alone, and making the
  latch the candidate filter reds `I16` alone (ADR-0860 §Evidence, re-measured by the reviewer at
  `4ec78c79`).
- **Known limit:** `$expr` is not index-served, so a run still scans the
  `counters.imageCount > 0` set. The indexable refinement (a `counters.pipelineRevision` bumped by
  the counter writer) belongs to the OP-135 counters lane, as ADR-0860 §3 records.

## Evidence

### RED at the pin head, green now

At the pin head `4ec78c79` the sixteen cases are `4 failed | 12 passed (16)`, the four failures
being `I12`, `I13`, `I14` and `I16` at assertion level. With this change the same file is
**`16 passed (16)`** — ADR-0852's frozen eight, ADR-0859's `I9`–`I11`, `I15` and the five new
pins on one implementation.

### The pin file is carried, not edited

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` is byte-identical to
`4ec78c79`; the diff against `origin/main` is that file (the pins), ADR-0860, this record and the
lane bookkeeping — plus **one** production file, `apps/web/src/server/jobs/pipeline-indexed-check.ts`.
No test, fixture, helper, mock or frozen pin is touched, and the sibling jobs
(`upload-session-sweep`, `attendee-no-match-check`, `retention-warnings`) are untouched.

### Gates

`vitest run --project unit --project integration` green (`TMPDIR=/root/tmp-mongo` for the
integration project), `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 and
`prettier --check` clean on the touched paths, the six ADR guards green, and the repo's own
`--coverage` run above the global 80 % branch threshold. The exact figures are in the card
handoff.

## Assumptions

- **A1** — the marker field is `pipeline.indexedCheckedCounters`, job-private: `grep` over `apps`
  and `packages` (tests excluded) finds no schema or validator that registers the `pipeline`
  block, and `pipeline.indexedNotifiedAt` appears only in this job, so the new field needs no
  schema change.
- **A2** — `_id` order is the page order. The pins assert only counts and the observable rows
  (`I12`/`I13`), or that a specific event is reached at all (`I14`/`I16`), never which run reached
  it, so any deterministic drain order satisfies them.

## Out of scope

- **The arm's cost.** The per-event `event_images` reads, the O(limit²) `pending` allocation and
  the sequential batch awaits are `t_eeb212c2` (M1); this record adds neither a per-batch marker
  nor a second query.
- **`hasMore` as a contract assertion.** The pins never read `scanned`, `skipped` or `hasMore`; the
  drain makes the signal true in principle, but no case pins it.
- **The sibling sweeps** that share the fixed-page shape (`t_c32ed838`) and the indexable
  refinement of the filter (`counters.pipelineRevision`).

## Consequences

- An event behind the first page is reached: it is announced once when it derives `indexed`, and
  its worker-settled batches are summarised by the OP-126 arm on the run that sees it.
- Every evaluated row leaves the window until its input moves again, so a latched, `delayed` or
  `partial_failure` row can no longer hold a slot for ever.
- The filter costs a scan of the `counters.imageCount > 0` set (`$expr` is not index-served) —
  unchanged from today's read, and named as the known limit above.
- The marker makes the job's own reads self-limiting: an unchanged event is read once per input
  change rather than once per five minutes, which is the input `t_eeb212c2` measures.
- `docs/adr/README.md` is the lane's hotspot: this index row, this lane cell and this note merge as
  a union keeping the higher cell (`0862` lane, `0869` pool).
