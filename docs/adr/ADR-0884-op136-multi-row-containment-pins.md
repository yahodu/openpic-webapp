# ADR-0884 — OP-136 TEST: `errors` counts, and the `row_failed` warn names, **every** failing row

- **Status:** Accepted (TEST, characterization pin — green on arrival) · **Date:** 2026-11-20
- **Card:** OP-136 TEST `t_3d67936e` (Low; finding **F1-Low** of the round-2 review of the OP-136 RED
  `t_fba690f8`, draft PR #690 / pin head `7cc2b270`), chained behind the GREEN `t_6275f30a` and its
  review `t_05687f95`. Branch `OP-136-task-multi-row-containment-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `acade549`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — `limit`, `errors`, `scanned`,
  `hasMore`, idempotence, retry safety) and notification design §4.7 (`upload.batch.completed`).
- **Consumes:** [ADR-0871](ADR-0871-op136-poison-row-containment-pins.md) §1 (the decided contract:
  the failure is counted per row and **each** failing row is named once) and §4 (the vacuity arm the
  Test Author retired); [ADR-0872](ADR-0872-op136-poison-row-containment-green.md) §1 (the shipped
  row loop that walks each settled chunk by index); and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (an exhausted block
  draws from the pool, advances both cells and keeps its range).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (the appended
  case's doc-comment cites this record).
- **Number allocation:** `0884`, drawn from the pool. The `OP-136 jobs lane` block `0849`–`0868` is
  exhausted (§11 item 18). The sweep immediately before minting, at the trunk `acade549`, found both
  `Next free` cells at `0882`, `ADR-0882` (OP-137 delivery receipts GREEN, PR #743) and `ADR-0883`
  (OP-136 discovery-abort pin, PR #746) in flight, `git rev-list --objects --all -- docs/adr`
  stopping at `0883`, and no `ADR-0884` file, object or PR-head path on any surface. This record
  therefore takes the highest in-flight number plus one and advances **both** the `OP-136 jobs lane`
  cell and the `unallocated (future lanes)` cursor to `0885`, one above itself, so neither can
  re-mint it; the block keeps its range (§11 items 19–21). **Reconciled twice against a moving trunk:**
  the first merge of `origin/main` (`41aec3b0`, PR #743) found both cells at `0883` and kept this
  record's `0885`; the second (`a5300714`, which landed `ADR-0885` from another lane through PR #748)
  found both cells at `0886`, so the merged ledger keeps **`0886`** — higher than the value this record
  wrote — and `0884` is not renumbered, because a number is consumed once and a cell is never lowered
  (§11 item 20). The row sits between `0882` and `0885`, ascending.

## Context

The decided contract (card `t_39d7b19f`, option 1; ADR-0871 §1) says a row whose own arm work throws
is counted **per row** — `errors += 1` for that row — and named **per row**, one `warn` under
`pipeline.indexed_check.row_failed` carrying that row's own event id. ADR-0872 §1 implemented it that
way: the loop walks `chunk.entries()` and pairs each `settled.at(index)` with its own row.

The delivered pin set did not pin the granularity. `I26` and `I27` are the only cases that reach a
failing row, and both seed **exactly one** poison row (the lowest `_id` of a nine-row page). Measured
at the RED head `7cc2b270` in a throwaway probe worktree, with the production file alone patched to
the chunk-level shape — `const firstFailed = settled.findIndex(o => o.status === "rejected"); if
(firstFailed >= 0) { errors += 1; logger.warn(…, { eventId: chunk[firstFailed]._id, error:
settled[firstFailed].reason }) }`, later chunks still running — the then-29-case pin file answered
**`29 passed (29)`**, indistinguishable from the per-row near-fix, which also answered `29 passed
(29)`.

The card's own remedy — two poison rows, **one per chunk** (the lowest `_id` of chunk 1 and the
ninth, alone in chunk 2) — was measured while writing this case and is **also vacuous** against the
same mutation: a per-chunk count lands on the same total (`2`) and names the same two rows, so the
page answers **`30 passed (30)`** under the chunk-level head. Only a chunk that holds **two**
failures separates the two shapes. That measurement, not a preference, is why this record's page
differs from the card's literal shape (see §3).

## Decision

### 1. One appended case, `I31`: three failing rows, two of them in one chunk

`I31` — "every failing row is counted and named, including two in one chunk" — is appended to the
existing containment block of `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
(+140/−0; no existing case, helper, fixture, constant or assertion is edited). It seeds the block's
page (`PAGE_SIZE` 9 = `ROW_CHECK_CONCURRENCY` 8 + 1, `requestedLimit: PAGE_LIMIT` 12) `_id`-ascending
with **three** poison rows: rows 1 and 2 (chunk 1) and row 9 (chunk 2, alone). Both poison shapes are
armed through **one** `failFindWhen` injection whose predicate accepts any of the three event ids —
one injection, not three, because `failFindWhen` spies on the driver's `find` and a second armed spy
would stand in front of the first.

One run must:

1. **resolve** — the case asserts the resolved envelope through the block's `runPage`, which rethrows
   a rejection as the case's own assertion failure naming the shape that was expected;
2. report `scanned: 9` and `errors: 3` — one per failing row, and `3` is exactly what a per-chunk
   count cannot produce on a nine-row page whose two chunks hold 2 and 1 failures;
3. write exactly three `pipeline.indexed_check.row_failed` lines, every one at `warn`, whose
   `fields.eventId` set equals the three seeded event ids — so a head that names only each chunk's
   first failure names two and reds;
4. leave the six healthy rows announced once each (`pipeline.event.indexed`), and all three failing
   rows' `pipeline.indexedCheckedCounters` unstamped, in either chunk.

Every id is derived from the seeds (`row.event.eventId.toHexString()`); no literal id, no
secret-shaped string, no `.only`, no skip, no loosened matcher.

### 2. The record's granularity statement

- `errors` is a **per-row** count: one increment per rejected row, so a chunk holding two failures
  contributes two. A per-chunk count is a contract violation, not an optimisation.
- The `row_failed` warn is **per-row**: one line per failing row, at `warn`, carrying that row's own
  `eventId`. Naming a chunk's first failure and counting the chunk once leaves the operator unable
  to identify the second failing event.

### 3. Deviation from the card's literal shape, and why

The card specified two poison rows, one per chunk, `errors: 2`. That shape is measured **vacuous**
(§Context: `30 passed (30)` under the chunk-level head). The case therefore keeps the card's page
size, chunk boundaries, `requestedLimit`, run count, warn contract, "announced once" arm and
"unstamped" arm, and adds a **second failure inside chunk 1**: the page carries three failing rows
and `errors` expectation `3`, which is the smallest page that separates a per-row containment from a
per-chunk one. This is the pin's whole purpose; a pin that cannot red is not a pin.

## Evidence

Measured in a throwaway worktree detached at the trunk `acade549`
(`/root/.hermes/profiles/openpic-webapp-testcase-writer/cache/scratch/op136-multirrow/probe`), never
in the lane worktree, production file restored byte-identically after every mutation
(`sha256 fa4f0b917976721090e799b582fc52b754a028e7f90d5afcdceb7cdac39a72b4`, `git status --short`
empty after each restore):

| run                                                                   | shape                                                                       | result                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| positive control                                                      | shipped per-row loop                                                        | `30 passed (30)` (the 29 delivered cases + `I31`)                                                                                                                                                                          |
| **M1** chunk-level                                                    | count once per chunk, name `chunk[firstFailed]`, later chunks still run     | `1 failed \| 29 passed (30)` — `I31` alone, `AssertionError: three failing rows are three counted errors — the count is per row, not per chunk: expected 2 to be 3`                                                        |
| **M2** count per row, name the chunk's first failure                  | `errors += 1` per rejection, then `continue` unless `index === firstFailed` | `1 failed \| 29 passed (30)` — `I31` alone, `AssertionError: each failing row is named exactly once, as a warning — two of them in the same chunk: expected [ 'warn', 'warn' ] to deeply equal [ 'warn', 'warn', 'warn' ]` |
| **V1** card's literal shape (two poison rows, one per chunk) under M1 | chunk-level                                                                 | `30 passed (30)` — **vacuous**, the measurement that produced §3                                                                                                                                                           |

So the count arm and the name arm are each independently load-bearing, and the card's literal page is
not.

## Gates (run on the delivered head)

- focused pin file: `30 passed (30)`
- full `integration` project: see the PR handoff comment for the exact file/test counts on the head
  that was pushed
- `tsc -p apps/web/tsconfig.json --noEmit`: exit `0`
- `eslint` on the changed spec: `0` errors
- `prettier --check` on the changed paths: clean
- the six `adr-*` guards: `236 passed (236)`
- re-verified after each merge of `origin/main` (`41aec3b0`, `a5300714`): the focused file, the full
  `integration` project (`148 files / 1566 passed (1566)` on the merged tree; the count grows with the
  trunk's own cases), `tsc`, `eslint`, `prettier` and the six guards again

## Consequences

- The granularity of both halves of ADR-0871 §1 is now pinned by behaviour, at the envelope
  (`errors`) and at the log (`fields.eventId` set + level + count), so a future "count once per
  chunk" refactor of the row loop reds `I31` alone.
- The page is `_id`-ordering dependent by design: the case asserts its own page order before acting
  (`pageOrder` equals its sorted form), so a seeding change fails loudly instead of silently moving
  which rows are the first and ninth.
- Out of scope: the warn's **field name** for the thrown reason (the review finding that `error` is
  not serialised by the logging port is `t_3b30fc42`'s pin and the Implementer card behind it), the
  abort half of ADR-0867 §2 (the sibling `ADR-0883` card), and the delivery ordering of the outbox
  rows.

## Id reconciliation

`I31` was written and measured as `I30`. Before this branch could land, `origin/main` took
`efa034ff` (PR #746, the sibling card `t_b13a68d7` / ADR-0883), which appends its own case under the
same id in a _different_ block of the same spec. That card landed first, so its `I30` stands and this
case takes the next free id, `I31`: the id is a label, the assertions are unchanged, and the merged
file reads `31 passed (31)` (29 delivered + ADR-0883's case + this one). The mutation evidence in
§Evidence was measured under the earlier label and reds the same case, now `I31`.
