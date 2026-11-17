# ADR-0863 — OP-136 follow-up: the sweep's enqueue warn, the ack grace's budget, and one entitlement read per key per run

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 follow-up (Low) `t_bc01c854` (findings **F4** + **F5** of the
  review of the GREEN `t_d18a6e9e`, parent `t_d18a6e9e`; branch
  `OP-136-task-sweep-observability-and-entitlement-cache`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_bc01c854`).
- **Implements:** contract §10.2 (`pipeline-sweep`, `usage-threshold-check`),
  §9.10, §18.1; schema §18.2.
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §5 (the sweeps' shapes),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the shipped jobs),
  [ADR-0854](ADR-0854-op136-usage-elapsed-period-pins.md) (the elapsed-period
  guard this record leaves untouched).
- **Consumers:** `apps/web/src/server/jobs/pipeline-sweep.ts`,
  `apps/web/src/server/jobs/usage-threshold-check.ts`.
- **Number allocation:** the `OP-136 jobs lane` row read `` `0862` `` when this
  record was minted (`origin/main` `c91e3212`), and `ADR-0862*`
  (`ADR-0862-op136-indexed-check-batch-arm-cost.md`) was in flight on the lane
  branch that has since merged it as `d28cddd1`; no `ADR-0863*` exists on the
  trunk, in any `.worktrees/*/docs/adr` tree or in
  `git rev-list --objects --all -- docs/adr`, so this record takes `0863` and
  advances only the `OP-136 jobs lane` cell to `` `0864` ``; both
  `unallocated (future lanes)` cells stay `0869`. No frozen record is edited.

## Context

Two Low findings from the review of the GREEN, both in the jobs lane.

**F4a.** `pipeline-sweep` called `enqueueWork` with no `logger`. `enqueue-work.ts`
writes its only failure line as `options.logger?.warn("…", { event:
"queue.enqueue_failed", … })`, so a broker refusal was silent — although §18.1
makes that warn the operator's only signal. Both calls in the module were blind:
the shared `reenqueue` helper (steps 1 and 2) and the step-4
`match_incremental` enqueue.

**F4b.** Step 2 ("`queued` past the ack grace with no broker ack") re-enqueued
without advancing `processing.attempts`, while its own candidate filter reads
`attempts < settings.pipeline.maxAttempts`. Nothing therefore ever moved such a
row toward step 3's `attempts >= maxAttempts` arm: an item the broker never
accepted was re-enqueued every two minutes for ever. The two steps contradicted
each other — step 2 looked like it respected a budget it never spent.

**F5.** `usage-threshold-check` called `checkEntitlement` once per counter row
inside a loop over up to 4000 candidates, hourly. Each call resolves the
tenant's plan, its overrides and its grants, and the counter rows of one key
share all three.

## Decision

### 1. Both enqueue paths pass the run's own logger

`reenqueue()` and the step-4 `match_incremental` call now forward `logger`. A
refused enqueue is one `queue.enqueue_failed` warn per attempt, with the run's
`queueKey`, `kind` and error — the §18.1 signal, at both call sites, without
touching `enqueue-work.ts` (whose optional logger is the seam that let the
caller decide).

### 2. The ack grace is unbounded, and it must be: the budget counts claims

Step 2 keeps its filter and does **not** increment `processing.attempts`. The
budget is defined by schema §18.2's claim, which is the only place `attempts`
moves (`$inc: { "processing.attempts": 1 }` on the worker's claim). Step 2's
case is the opposite kind of failure: the broker never accepted the message, no
worker ever saw the item, and no attempt happened. Counting a re-enqueue would
make `attempts` stop meaning "worker claims", and it would terminally fail
images with `max_attempts_exceeded` after `maxAttempts × 2 min` (ten minutes at
the shipped `maxAttempts: 5`) of a broker outage — data loss caused by an
infrastructure transient, and a `pipeline.image.failed` event that tells the
organizer an image failed when nothing was ever attempted.

So the intent is now explicit in the module docblock and here: an item the
broker has not yet accepted is re-enqueued every tick until it is accepted, and
each refusal is a warn (decision 1) — the operator's signal, and the action that
ends the loop. Step 2's `attempts < maxAttempts` filter is unchanged and still
correct: it keeps a row that already spent its budget out of the re-enqueue path,
where step 3 owns it. The two steps no longer overlap — an item the broker
accepted is claimed (which is where the budget is spent) and a claim leaves
`queued`, so it leaves step 2's candidate set entirely; only steps 1 and 2, where
no claim happened, ever sit in the unbounded grace, and they are bounded by the
operator's attention to the warn instead of by a counter.

Rejected: incrementing `attempts` on the re-enqueue (above); and deleting step
2's `attempts` filter to make the contradiction disappear — that would re-enqueue
budget-exhausted rows and race step 3's failure write.

### 3. One entitlement verdict per `(tenantId, entitlementKey)` per run

`usage-threshold-check` keeps a `Map<string, EntitlementVerdict>` for the
duration of one run. The verdict is a pure function of the tenant's plan, its
overrides, its grants, the key and the injected clock, and the loop mutates none
of them — it writes only `usageCounters.thresholdsNotified` — so a cached
verdict is the same object the next call would have produced. The counter rows of
one key already sit in distinct rows (`{ tenantId, entitlementKey, periodKey }`),
so the map collapses up to 4000 resolutions to at most one per key the run reads.

The elapsed-period guard (`verdict.periodKey !== row.periodKey`) is byte-identical
and still evaluated per row: the verdict carries the key's **current** period,
and the guard compares it with the row's own, so the shared verdict decides each
row exactly as before. The one-minute-to-hourly tick cadence is the invalidation
window, unchanged from the shipped design's own re-resolution.

## Evidence

- `apps/web/src/test/integration/job-pipeline-sweep.test.ts` and
  `…/job-usage-and-invitations.test.ts` (the OP-136 specs, untouched):
  `Test Files 2 passed (2)` / `Tests 11 passed (11)`.
- Full `pnpm test:coverage`: `325 passed (325)` files, `4575 passed | 3 skipped
(4578)` tests, statements 91.6 %, branches 80.34 %, functions 95.95 %,
  lines 91.72 %, exit `0`. The two touched modules read `pipeline-sweep.ts`
  76.19 % lines / 57.81 % branches (both unchanged by this diff) and
  `usage-threshold-check.ts` 92.3 % lines / 81.25 % branches, with the new
  `verdictFor` cache arm measured taken **2** times and missed 8
  (`if (cached !== undefined)`, line 89), so the hit path is live.
- The six `adr-*` guard specs: `Test Files 6 passed (6)` / `Tests 236 passed
(236)`, the numbering, lane-range, consumer, record-link, inline-code-span
  and source-reference guards included.
- `pnpm typecheck` exit `0`, `eslint` 0 on the two touched files,
  `prettier --check` clean on all four.
- No new pin: both changes are behaviour-preserving or observability-only, and
  the existing specs already drive the cache's hit path (two rows of one key in
  one run) and the loop's `attempts` filter.

## Consequences and known limits

- A broker outage now prints one warn per refused enqueue per tick. That is the
  intended operator signal, and the volume is bounded by the job's `limit`
  (default 2000, max 4000).
- The cache is per run and deliberately not invalidated: a plan or grant change
  that lands mid-run is seen by the next run, not by the rows after the change.
  The previous per-row read had a sub-second window on the same class of change;
  the latch, not the verdict, is what keeps a warning at once per period.
- The step-2 loop is still unbounded in wall-clock terms while the broker refuses
  every enqueue, which is the accepted trade recorded in decision 2.
