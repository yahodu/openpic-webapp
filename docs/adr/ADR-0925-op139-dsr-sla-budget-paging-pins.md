# ADR-0925 — OP-139 TEST: the DSR SLA check pages past its per-run budget

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_3f90448c` (OP-139 TEST, Medium — finding **F3** of the round-1 review of the
  OP-139 GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md))
- **Branch:** `OP-139-task-dsr-sla-backlog-pins`. **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_3f90448c`
- **Touches:** one integration spec **appended** (`apps/web/src/test/integration/dsr-sla-check.test.ts`:
  one new docblock, two module-level deadline constants, one budgeted run helper, one warned-id
  reader, one three-request seeder and a new `describe` with **two** cases; the shipped four `I5`
  cases and every shipped helper are byte-identical), this record, its index row, the lane's
  `Next free` cell and one ledger paragraph. **No production code, no factory, no route, no
  contract document.**
- **ADR number:** `0925` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937` block,
  advanced to `0926`. The sweep is §6.
- **Consumes:** [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §4 (the delivered
  `dsrSlaCheck` candidate read and the per-day `dedupeKey`), A13 (the run's day key is
  `dateKeyInTimeZone(clock.now(), "Asia/Kolkata")`),
  [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) A15 (the inclusive 48-hour edge) and the
  daily-repeat property its `I5` cases pin, contract §10.2 (the job's per-run budget and
  `hasMore`) and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 item 23 (the
  number sweep).
- **Consumers:** `apps/web/src/test/integration/dsr-sla-check.test.ts` (the pins).

## 1. Context — the budget re-reads the head and the tail is never warned

The delivered job reads its candidates in one query
(`apps/web/src/server/jobs/dsr-sla-check.ts:76-82`):

```ts
.find(
  { status: { $nin: [...CLOSED_STATUSES] }, slaDueAt: { $lte: cutoff } },
  { sort: { slaDueAt: 1 }, limit }
)
```

No cursor, no exclusion of what this run (or an earlier run of the same IST day) already warned.
When the at-risk population is larger than the budget (`500` by default, `1000` maximum),
**every** run re-reads the same earliest-deadline prefix. The second run's `emitDomainEvent` calls
are collided by the outbox `dedupeKey` (`dsr.sla_risk:${requestId}:${dateKey}`) before any row is
written, so `affected` is `0` — but the read happened first, so the budget was already spent on
requests that had nothing left to say. The tail of the queue is never announced, and `hasMore`
(`rows.length >= limit`) reports `true` on every run, so the operator sees "more to do" while
nothing advances.

The round-1 review measured it at `468ab713` with two open requests (40 h and 47 h out),
`requestedLimit: "1"`, run three times (twice on the day, once the next day):

```
PROBE-RESULT {"run1":{"scanned":1,"warned":1,"hasMore":true},
              "run2":{"scanned":1,"warned":0,"hasMore":true},
              "run3nextDay":{"scanned":1,"warned":1,"hasMore":true},
              "warnedIds":["…257c","…257c"],
              "laterEverWarned":false}
```

The later request was **never** warned. A statutory-deadline warning that silently never fires is
exactly the failure this job exists to prevent, so the gap is a defect in the delivered behavior,
not a missing feature.

## 2. Measurement — the pins red on arrival for the intended reason

On the delivery cut (`origin/main` `4f4c4926`), with the new block appended:

```
× F3: with a budget of one, three same-day runs warn each of three at-risk requests exactly once, then the next day warns the earliest again
AssertionError: expected [ '6b043b1f57af56119d485772' ] to deeply equal [ '6b043b1f57af56119d485772', …(1) ]
 ❯ apps/web/src/test/integration/dsr-sla-check.test.ts:355:47

× F3: with a budget of two, the first run warns exactly two and the second run warns the third, with no same-day repeat
AssertionError: expected [ '6b043b2057af56119d48577b', …(1) ] to have a length of 3 but got 2
 ❯ apps/web/src/test/integration/dsr-sla-check.test.ts:396:23

      Tests  2 failed | 4 passed (6)
```

Both reds are the missing-warning shape the card named — a `requestId` that is absent, never a
duplicate and never a harness error — and the first case's first two assertions pass, so the seed,
the fixture clock, the tenant address and the shipped budgeted read all work. The shipped four `I5`
cases are green in the same run: the 48-hour edge, the closed and out-of-window arms, the open
statuses, and the shipped single-request same-day-silent / next-day-speaks property.

## 3. Decision — the queue must advance, and the day boundary must reopen it

The card pre-made this decision; this record records it and does not re-litigate it.

**Preferred shape.** Before rendering warnings, read the **current IST day's** `admin.dsr.sla_risk`
events — `domainEvents`, `eventKey: "admin.dsr.sla_risk"`, `occurredAt` inside
`dayWindowUtc(dateKey, "Asia/Kolkata")` — collect their `subjectRef.id`s and exclude those requests
from the candidate query (`_id: { $nin: warnedIds }`). The `limit` window then slides onto un-warned
requests: run 1 warns the earliest deadline, run 2 the next, and so on until the day's queue is
drained. Because the day window moves at IST midnight, the exclusion is **empty** on the next day,
so an already-warned-and-still-at-risk request warns again — the shipped daily-repeat property is
preserved by construction, not by a special case.

**Accepted alternative.** A persisted cursor document is acceptable, provided it still reopens the
already-warned requests on a new IST day (the daily repeat is a settled behavior, not a free
choice). The pins do not inspect how the fix pages; they inspect that it pages.

**Not acceptable.** Dropping the `limit` (the "all overdue" set is unbounded — the per-run budget
is the whole reason the query has one), or claiming that the outbox dedupe already handles it (it
does not: the candidate read happens before the dedupe, which is why the budget is wasted on
already-warned rows).

The pins are written so that the **next-day arm** distinguishes the two: a fix that excludes
already-warned requests **forever** (no day window) satisfies the same-day paging arms and reds the
fourth warning — measured in §5.

## 4. The contract the pins encode

One append, one new `describe`, two cases, three open requests for one live tenant, all inside the
48-hour window, with distinct `slaDueAt`s (`ACTIVITY_AT` is `2026-11-17T06:00:00.000Z`):

| request | status        | `slaDueAt` | hours out | requestType   |
| ------- | ------------- | ---------- | --------- | ------------- |
| first   | `received`    | 40 h       | 40        | `access`      |
| second  | `in_progress` | 44 h       | 44        | `erasure`     |
| third   | `verifying`   | 47 h       | 47        | `portability` |

All three statuses are open per schema §20.3, so the pin cannot be satisfied by a fix that also
filters statuses. Distinct deadlines make the queue order unambiguous.

### 4.1 The paging case (`requestedLimit: "1"`)

| Step                             | Required assertion                                                                                                 | Wrong behavior it catches                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| run 1, same day                  | `warnedRequestIds()` equals `[first]`                                                                              | a read that ignores the deadline order                    |
| run 2, same day                  | the warned set equals `{first, second}`                                                                            | **today's bug**: the head is re-read, `second` is missing |
| run 3, same day                  | the warned set equals `{first, second, third}` — the **set**, so a count of three with one id repeated cannot pass | a budget spent on already-warned rows                     |
| run 4, **next** day (24 h later) | four events in total, the fourth naming `first` (the earliest, still at risk)                                      | an exclusion that never expires (a forever-cursor)        |

### 4.2 The control case (`requestedLimit: "2"`)

| Step            | Required assertion                                                                     | Wrong behavior it catches                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| run 1, same day | the warned set equals `{first, second}` — the budget is fully spent, in deadline order | a budget that stops one short, or pages out of order                                                                              |
| run 2, same day | three events; the **only** id not in run 1's set is `third`                            | a same-day repeat that still reaches the tail (impossible under the dedupe, but the arm states it) and a run 2 that warns nothing |

Both cases read `payload.requestId` (not `subjectRef.id`, not a count) so the assertion names the
requests the operator would have been warned about.

## 5. Evidence

Measured in this card's worktree (`vitest` 5.0.3, `MongoMemoryReplSet` through the shipped harness),
on `origin/main` `4f4c4926`.

| State                                                                           | Result                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delivery cut, spec appended (the RED)                                           | `2 failed \| 4 passed (6)` — `expected [ '…772' ] to deeply equal [ '…772', …(1) ]` and `expected [ '…77b', …(1) ] to have a length of 3 but got 2`                                                               |
| throwaway near-fix: the day-window exclusion of §3                              | `6 passed (6)`                                                                                                                                                                                                    |
| variant: the same fix with the exclusion **unbounded** (no `occurredAt` window) | `2 failed \| 4 passed (6)` — the F3 next-day arm (`expected [ '…', …(2) ] to have a length of 4 but got 3`) **and** the shipped `I5` daily-repeat case (`expected [ { …(10) } ] to have a length of 2 but got 1`) |
| restored production file                                                        | `git checkout --`; `sha256 bbf47dec…c404f` before and after, `git status` carries the spec only                                                                                                                   |
| `tsc -p apps/web/tsconfig.json --noEmit`                                        | exit `0`                                                                                                                                                                                                          |
| `eslint` on the touched spec                                                    | exit `0`                                                                                                                                                                                                          |
| `prettier --check` on the touched spec and this README                          | clean                                                                                                                                                                                                             |
| the seven `adr-*` guards with this record and its ledger rows in tree           | green (§5.1)                                                                                                                                                                                                      |

The variant row is what makes the day-window arm load-bearing rather than merely unsatisfied: the
same-day paging arms pass on a forever-cursor, and only the next-day warning reds. The near-fix and
the variant were written into `apps/web/src/server/jobs/dsr-sla-check.ts`, run, and restored with
`git checkout --`; no production file is in the delivery.

### 5.1 Whole-suite gates

| Run                                    | Result                                               |
| -------------------------------------- | ---------------------------------------------------- |
| focused `dsr-sla-check` spec (the RED) | `2 failed \| 4 passed (6)` — the two new cases alone |
| whole `unit` project                   | §5.2                                                 |
| whole `integration` project            | §5.2                                                 |
| the seven `adr-*` guards               | §5.2                                                 |

### 5.2 Post-delivery gates

Recorded in the handoff's `gates` field, measured after the README rows and this record landed:
whole `unit`, whole `integration`, the seven `adr-*` guard files, `tsc`, `eslint` and
`prettier --check`. The integration project is quoted **as delivered**, not as green: this branch
is a RED-by-design pin pack, so its single red file is this spec.

## 6. Number allocation and sweep

Draws **`0925`**, the `OP-139 jobs & compliance lane` row's `Next free` cell (block `0918`–`0937`),
and advances that cell to **`0926`**. No other cell moves, no cell is lowered and no range is
re-cut: `unallocated (future lanes)` and the `OP-136 jobs lane` cell stay `0962`, the
`OP-140 notifications lane` cell stays `0943`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `4f4c4926` (the `1.77.0` release chore): highest records `ADR-0942` (OP-140) and
  the OP-136 lane's `0938`–`0941`; the OP-139 cell reads `0925`; no `ADR-0925` path;
- every `.worktrees/*/docs/adr` tree on this host (`60` trees): highest `ADR-0943` (OP-140), no
  `ADR-0925` path;
- the open PR heads (#755, #743, #272 and the sibling OP-139/OP-140 PRs): no `ADR-0925`;
- `git rev-list --objects --all -- docs/adr`: highest `ADR-0943`; no `ADR-0925` object.

The card's "draw from the pool" sentence is read as the §12 item 23 _enumeration_, not as a pool
draw: the lane holds a live reservation (`0918`–`0937`) whose cell is `0925`, and the block is
exclusive to its holder, gaps included. The pool high-water (`0943`) belongs to the OP-140 block.

**Re-swept immediately before the push** — the handoff's `adr.sweep` field records the surfaces and
their heads at that moment.

## 7. Alternatives rejected

1. **Pin only the count of three warnings.** Rejected: the measured bug can produce a count of three
   by warning the earliest request three times if the dedupe were ever removed or keyed differently,
   and a count tells the operator nothing about _which_ deadline went unwarned. Both cases assert the
   set of `payload.requestId`s.
2. **Pin `hasMore` instead.** Rejected: `hasMore` is `true` on every run today **because** the budget
   is saturated, so pinning it would enshrine the bug's symptom. The behavior that matters is which
   requests were warned.
3. **Pin a cursor document's shape.** Rejected: the card admits a persisted cursor as an alternative,
   and a pin on the store would forbid it. The pins are behavioral: the queue advances, and the day
   boundary reopens it.
4. **Pin with the default budget (500) and 501 rows.** Rejected: 501 seeded requests make the case
   slow and its failure message unreadable, and the defect is the budget being consumed by
   already-warned rows — visible at a budget of 1. The per-run budget is injected
   (`requestedLimit`), so the small budget is the same code path.
5. **Let the GREEN decide whether the next day re-warns.** Rejected: the daily repeat is shipped
   behavior pinned by the shipped `I5` case (`the next day's run emits again`), and the fix must not
   regress it. The arm is in the new case because a forever-cursor fix would otherwise pass.
6. **Assert `scanned` or `affected` per run.** Rejected: `scanned` counts rows read (a fix may read
   the day's events as an extra query) and `affected` counts inserted rows, so both are
   implementation-adjacent counters. The outbox rows are the observable the operator consumes.

## 8. Consequences and residuals

- The GREEN child `t_4f24b078` (`parents=[t_e704435e, t_3f90448c]`) implements §3 and makes these
  two cases green; **no test file is its to edit**, and the shipped four `I5` cases must stay green.
- **Residual:** one tenant. The event is addressed to `scope.tenantIds[0]`; a fix that paged per
  tenant instead of globally would still pass these pins, which is acceptable (the budget is
  global, so per-tenant paging under one tenant is indistinguishable). A multi-tenant paging arm is
  not pinned.
- **Residual:** the exclusion source is the day's `admin.dsr.sla_risk` events. A fix that keyed the
  exclusion on `payload.requestId` instead of `subjectRef.id` would pass (both are the same id); a
  fix that keyed it on `dedupeKey` would also pass. The pins do not choose the store shape.
- **Residual:** a request whose `slaDueAt` leaves the 48-hour window between two same-day runs is not
  exercised. `slaDueAt` is fixed per request (OP-138 stamps it once), so only a clock jump can move
  it and the window is computed from the injected clock.
- **Residual:** no arm asserts the query's own `limit` argument; the budget is enforced through the
  run-1 exactness assertions of **both** cases. A fix that drops the `limit` warns all three at-risk
  requests in its first run, so case 1 reds at `dsr-sla-check.test.ts:349`
  (`expected [ id, …(2) ] to deeply equal [ id ]`) and case 2 reds at `:388`
  (`expected [ id, …(2) ] to deeply equal [ id, …(1) ]`) — `2 failed | 4 passed (6)`, measured at
  `a371ac65` with `limit` removed from the candidate `find` and no other change. The card still
  forbids dropping the `limit`; §3 records it as **not acceptable**, and the pins reject it through
  those two run-1 assertions, not through an assertion on the query object.
