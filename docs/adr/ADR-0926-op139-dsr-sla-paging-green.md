# ADR-0926 — OP-139 GREEN: the DSR SLA check pages past the day's already-warned requests

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_4f24b078` (OP-139 GREEN, Medium — the GREEN of finding **F3** of the
  round-1 review of the GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md);
  the pins are [ADR-0925](ADR-0925-op139-dsr-sla-budget-paging-pins.md))
- **Branch:** `OP-139-task-dsr-sla-backlog-green` (cut from `origin/main` `895e5f85`, carrying the
  pins commit `60123e25` unchanged, so one squash lands the pins, this record and the change).
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4f24b078`
- **Touches:** one production file (`apps/web/src/server/jobs/dsr-sla-check.ts`: one day-window read,
  one exclusion predicate, one `hasMore` probe), this record and its ledger rows. **No test, factory,
  fixture or helper file is in the diff**; the pins (`dsr-sla-check.test.ts` +142) are carried from
  `bc442bf7` byte-identically.
- **ADR number:** `0926` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937` block,
  advanced to `0927`. The sweep is §6.
- **Consumes:** [ADR-0925](ADR-0925-op139-dsr-sla-budget-paging-pins.md) (the two paging pin cases
  and their measured RED), [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §4 (the delivered
  `dsrSlaCheck` read and the per-day `dedupeKey`) and **A13** (the run's day key is
  `dateKeyInTimeZone(clock.now(), "Asia/Kolkata")`),
  [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) **A15** (the inclusive 48-hour edge) and the
  daily-repeat property its `I5` cases pin, contract §10.2 (the job's per-run budget and `hasMore`),
  and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 item 23 (the number sweep).
- **Consumers:** `apps/web/src/server/jobs/dsr-sla-check.ts` (the doc comment on `dsrSlaCheck` and
  the comment above the day's-warnings read, §1). The pin spec cites `ADR-0925`, which is where the
  contract lives.

## 1. The change

`dsrSlaCheck` now reads the current IST day's already-emitted warnings **before** it spends the
budget, and excludes their subjects from the candidate query:

```ts
const { start, end } = dayWindowUtc(dateKey, ROLLUP_TIME_ZONE);
const todaysWarnings = await platformRepo(db)
  .collection(COLLECTIONS.domainEvents)
  .find(
    { eventKey: "admin.dsr.sla_risk", occurredAt: { $gte: start, $lt: end } },
    { projection: { subjectRef: 1 } }
  )
  .toArray();
const warnedIds = todaysWarnings
  .map((row) => hexOf(row.subjectRef?.id))
  .filter((id) => id !== null && ObjectId.isValid(id))
  .map((id) => new ObjectId(id));

const filter = {
  status: { $nin: [...CLOSED_STATUSES] },
  slaDueAt: { $lte: cutoff },
  ...(warnedIds.length > 0 ? { _id: { $nin: warnedIds } } : {}),
};
```

The read is over `dayWindowUtc(dateKey, ROLLUP_TIME_ZONE)` — the **same** day key the dedupe key
carries, and the half-open window `[start, end)` the rollup already ships — so the exclusion empties
at IST midnight and a still-at-risk request speaks again the next day (ADR-0925's next-day arm). The
`sort: { slaDueAt: 1 }` and the `limit` are untouched: the page still takes the earliest deadlines,
it now takes them **from the un-warned remainder**.

`hasMore` was `rows.length >= limit`, which stayed `true` for ever while the same prefix was re-read.
It is now honest:

```ts
const hasMore =
  rows.length >= limit && (await requests.countDocuments(filter, { skip: limit, limit: 1 })) > 0;
```

A full page is "more" only when an un-warned at-risk row sits beyond it. The probe costs one
`countDocuments` and only runs on a full page.

Reasons, one per decision:

| Decision                                       | Why                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the outbox, not a new cursor document     | The event the run needs also to suppress is already stored, with the day in its `occurredAt` and the request in its `subjectRef`; a cursor would duplicate it. |
| Exclude before the read, not after             | The defect is that the budget is **spent** on requests with nothing left to say; the outbox `dedupeKey` collides only after the read.                          |
| Window on `occurredAt`, the IST day            | Day-scoping is what keeps the shipped daily repeat: an unbounded exclusion reds both the next-day arm and `I5` (ADR-0925 §1).                                  |
| `_id: { $nin: warnedIds }` only when non-empty | The first run of a day must build exactly the shipped predicate; an empty `$nin` would be a needless restriction to keep in the query shape.                   |
| `countDocuments(skip, limit: 1)` for `hasMore` | The alternative — reporting `rows.length >= limit` — is the dishonest flag ADR-0925 §1 measured.                                                               |

## 2. What stays unchanged

The status filter (`$nin` the closed set), the inclusive 48-hour cutoff, the candidate `sort` and
`limit`, the payload key set exactly `{requestId, requestType, slaDueAt}`, the dedupe key
`dsr.sla_risk:<requestId>:<dateKey>`, the event key, the actor and subject refs, the tenant address
(the first `scope.tenantIds` entry), the per-request `try`/`catch`, the summary log line
(`scanned`/`warned`/`dateKey`) and the job's `defaultLimit`/`maxLimit`. `skipped` keeps its meaning: a
row with no resolvable tenant or no `slaDueAt`. No route, `vercel.json` entry, setting or other job is
touched.

## 3. Measurement

| State                                         | Result                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| pins head before the change (the RED)         | `2 failed \| 4 passed (6)` — both F3 cases missing a `requestId` |
| focused `dsr-sla-check` spec after the change | `6 passed (6)` — the shipped four `I5` cases stay green          |
| whole `unit` project                          | `194` files, `3261 passed \| 3 skipped (3264)`                   |
| whole `integration` project                   | `158` files, `1687 passed (1687)`                                |
| `tsc`                                         | exit `0`                                                         |
| `eslint`                                      | 0 errors                                                         |
| `prettier --check`                            | clean                                                            |

The two RED arms are `expected [ '…772' ] to deeply equal [ '…772', …(1) ]` at
`dsr-sla-check.test.ts:355` and `expected [ '…77b', …(1) ] to have a length of 3 but got 2` at `:396`
— each a **missing** `requestId`, not a harness error, with the shipped `I5` four green in the same
run.

## 4. Alternatives rejected

1. **An in-process `Map<dateKey, Set<requestId>>` cursor.** Smaller, but it dies with the process:
   the shipped cron runs in a fresh serverless invocation each time, so after a cold start the map is
   empty and the tail is skipped again. (The finding `F1` of the review, routed to the cold-start pin
   card `t_88ee8e84`, measures exactly that.) The outbox is durable and already written.
2. **A persisted cursor document.** It would need its own collection, its own schema section, its own
   reset-at-midnight rule, and it would still duplicate the day+request pair the outbox already
   stores. Rejected as more state for the same answer.
3. **Drop the `limit`.** Rejected: the overdue set is unbounded, and the pins measure that dropping
   it reds both paging cases (ADR-0925 §1).
4. **Rely on the outbox dedupe alone.** Rejected: the dedupe collides inside `emitDomainEvent`,
   after the candidate read has already spent the budget — `affected: 0` is the symptom, not a fix.
5. **An unbounded exclusion (no day window).** Rejected: it suppresses the next IST day's warning
   too, reddening the paging next-day arm and the shipped `I5` daily-repeat case.
6. **A UTC-day window.** Benign at the shipped `02:45Z` cron, where UTC day and IST day agree (the
   review's finding `F3`), but the job's own day key is IST (A13) and the dedupe key would disagree
   with the window outside that hour. The shipped `dayWindowUtc(dateKey, …)` costs nothing.

## 5. Consequences and residuals

- A backlog larger than the budget now drains over successive runs, and the operator's `hasMore`
  answers whether anything un-warned is left after this page.
- **Residual:** the day's warning read is unbounded. It is bounded in practice by the at-risk
  population — one row per request per IST day — so it cannot grow without a matching backlog, and
  it is the same order as the backlog the job must drain.
- **Residual:** two concurrent runs of the same day can both read an empty exclusion, both warn the
  same page, and have the outbox dedupe keep one row. The budget is then spent on a race; the next
  run pages past the survivors. Convergence is preserved, throughput is not.
- **Residual:** the exclusion compares `ObjectId`s, so it assumes a `dataSubjectRequests._id` is an
  `ObjectId` (schema §20.3) and a `subjectRef.id` that is not 24-hex is ignored rather than matched.
- **Residual:** no pin asserts the `limit` argument of the candidate query itself (the review's
  finding `F4`); the budget is pinned through run-1 exactness.

## 6. Number allocation and sweep

Draws **`0926`**, the OP-139 lane's `Next free` cell (block `0918`–`0937`), and advances it to
**`0927`**. No other cell moves, no cell is lowered and no range is re-cut; the `OP-136 jobs lane`
cell and the `unallocated (future lanes)` cursor stay at `0962`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `895e5f85`: highest record `ADR-0943` (the OP-140 lane, outside this block); no
  `ADR-0926`–`ADR-0937` path on the trunk;
- every `.worktrees/*/docs/adr` tree on this host: highest `ADR-0943`; no `ADR-0926` file anywhere;
- the open PR heads #816, #815 (the pins, this record's base), #755, #743, #272: none carries a
  `ADR-0926`–`ADR-0937` path;
- `git rev-list --objects --all -- docs/adr`: no `ADR-0926` object.

Re-swept immediately before the push: no surface resolved `ADR-0926`.
