# ADR-0887 — OP-136 TEST: `errors` counts, and the `row_failed` warn names, **every** failing row

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
- **Number allocation:** `0887`, drawn from the pool. The `OP-136 jobs lane` block `0849`–`0868` is
  exhausted (§11 item 18). The sweep in the delivery run, at the trunk `efa034ff` (the run-time
  `origin/main`), found both `Next free` cells at `0886`, `ADR-0885` landed on the trunk through PR
  #748, `ADR-0886` in flight on PR #751 (the sibling OP-136 card's warn-serialisation pin),
  `git rev-list --objects --all -- docs/adr` — every fetched `refs/pull/*/head` included — stopping
  at `0886`, and no `ADR-0887` file, object or PR-head path on any surface. This record therefore
  takes the highest in-flight number plus one and advances **both** the `OP-136 jobs lane` cell and
  the `unallocated (future lanes)` cursor to `0888`, one above itself, so neither can re-mint it; the
  block keeps its range (§11 items 19–21). **The number moved during delivery, upward.** The record
  was first written as `0884` on the `acade549` trunk (cells `0882`, highest in-flight `0883`); by the
  delivery run `ADR-0885` had landed and the sibling card had taken `ADR-0886` in flight, so the
  re-sweep raised the draw to `0887` and the cells to `0888`. No test, assertion, seed or measurement
  changed with the number, and a cell is never lowered (§11 item 20). The row sits above `0885`,
  ascending.

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
page answers **`30 passed (30)`** on the `acade549` trunk — re-measured **`31 passed (31)`** at
`efa034ff` — under the chunk-level head. Only a chunk that holds **two**
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
(§Context: `30 passed (30)` on the `acade549` trunk and `31 passed (31)` at the delivered head, both
under the chunk-level head). The case therefore keeps the card's page
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
| positive control                                                      | shipped per-row loop                                                        | `31 passed (31)` (the 29 delivered cases + `ADR-0883`'s `I30` + `I31`)                                                                                                                                                     |
| **M1** chunk-level                                                    | count once per chunk, name `chunk[firstFailed]`, later chunks still run     | `1 failed \| 30 passed (31)` — `I31` alone, `AssertionError: three failing rows are three counted errors — the count is per row, not per chunk: expected 2 to be 3`                                                        |
| **M2** count per row, name the chunk's first failure                  | `errors += 1` per rejection, then `continue` unless `index === firstFailed` | `1 failed \| 30 passed (31)` — `I31` alone, `AssertionError: each failing row is named exactly once, as a warning — two of them in the same chunk: expected [ 'warn', 'warn' ] to deeply equal [ 'warn', 'warn', 'warn' ]` |
| **V1** card's literal shape (two poison rows, one per chunk) under M1 | chunk-level                                                                 | `31 passed (31)` — **vacuous**, the measurement that produced §3 (re-measured at the delivered head; first measured `30 passed (30)` on the `acade549` trunk, before `ADR-0883`'s `I30` landed)                            |

So the count arm and the name arm are each independently load-bearing, and the card's literal page is
not.

## Gates (run on the delivered head)

- focused pin file: `31 passed (31)` (the 29 delivered cases + ADR-0883's `I30` + `I31`) on the
  delivered head, `efa034ff` merged in
- full `integration` project: `149 files / 1571 passed (1571)`, exit `0`, on the same head
- `tsc -p apps/web/tsconfig.json --noEmit`: exit `0`
- `eslint` on the changed spec: exit `0`, no issues
- `prettier --check` on the changed spec, this record and `docs/adr/README.md`: clean
- the six `adr-*` guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-consumers`,
  `adr-source-references`, `adr-inline-code-spans`): `6 files / 236 passed (236)`
- re-verified after each merge of `origin/main` (`41aec3b0`, `a5300714`, `efa034ff`): the focused
  file, the full `integration` project (the count grows with the trunk's own cases), `tsc`, `eslint`,
  `prettier` and the six guards again

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

## Review sign-off (round 1) — card t_3d67936e

Sign-off card `t_5caf2feb` records the round-1 review of the pin card `t_3d67936e`. The delivery was
merged by its own card's mandate before the review ran, so the review was a **post-merge
verification** of the bytes the trunk carries. Every figure below was measured by the reviewer at
the squash `c96c2d18` unless the sentence names another commit; the trunk figures were re-measured
at `f370cf5b`, the trunk this section lands on.

- **Verdict:** accepted, `APPROVED WITH FINDINGS` — posted as PR comment
  `issuecomment-7037390755`. The contract holds: one appended case, red alone under the chunk-level
  shape and under a per-row count that names only each chunk's first failure, additions only, and a
  record truthful apart from the ledger's numstat digit this sign-off corrects.
- **Post-merge identity.** `gh pr view 749` answers `MERGED`, `mergeCommit c96c2d18`, base `main`,
  head `7c8c1f43`; `git merge-base --is-ancestor c96c2d18 origin/main` prints true;
  `7c8c1f43^{tree}` and `c96c2d18^{tree}` both read
  `d3a2fb2c02f9286482debab97ce70d37d226759b`; `git diff 7c8c1f43 c96c2d18` is empty, because a
  squash keeps the branch tree. This record's own blob reads `16be20a5` at the squash and at
  `f370cf5b`. The whole-tree hash of the trunk has since moved (`69b3a9f4` at `f370cf5b`) with other
  lanes' landings, so tree identity is proved against the squash, not against today's head.
- **Gates at the review head `c96c2d18`.** Focused spec **`31 passed (31)`**; full `integration`
  **`149 files / 1571 passed (1571)`**, exit 0; the six `adr-*` guards
  **`6 files / 236 passed (236)`**; `tsc -p apps/web/tsconfig.json --noEmit` exit 0; `eslint` on
  the spec exit 0; `prettier --check` clean on the three touched paths; `docs/adr` basenames
  **411** with **0** duplicate `ADR-NNNN`. Re-measured at `f370cf5b`: the focused spec
  **`32 passed (32)`** (the spec has since gained PR #751's wire case as `I32` and other lanes'
  cases), the six guards **`6 files / 236 passed (236)`**, the basenames **413** with **0**
  duplicates.
- **Independent mutation replay**, in a throwaway worktree detached at `c96c2d18`, the production
  file restored byte-identically after each mutation
  (`sha256 fa4f0b917976721090e799b582fc52b754a028e7f90d5afcdceb7cdac39a72b4`, `git status --short`
  clean): **M1**, count once per chunk and name `chunk[firstFailed]` → `1 failed | 30 passed (31)`,
  `I31` alone, `expected 2 to be 3`; **M2**, count per row and name only each chunk's first
  failure → `1 failed | 30 passed (31)`, `I31` alone,
  `expected [ 'warn', 'warn' ] to deeply equal [ 'warn', 'warn', 'warn' ]`; **V1**, the card's
  literal page — two poison rows, one per chunk, `errors: 2` — under M1 → the case **passes**,
  probe printed `{"scanned":9,"errors":2,"warns":2,"levels":["warn","warn"]}`. Both mutations were
  replayed again at `f370cf5b`, where the row loop writes the reason under `err:` (PR #753 landed
  that rename) and the production file's sha256 is
  `81905bbee5a9cff2b4327ebdb0ab9bca118e6a0a11841597473e8c0e741e5f65`: M1
  `1 failed | 31 passed (32)` and M2 `1 failed | 31 passed (32)`, `I31` alone in both, with the same
  two assertion messages.
- **The deviation is measured, not preferred.** The card's literal page — two poison rows, one per
  chunk, `errors: 2` — is vacuous under M1, and §3's page adds a second failure inside chunk 1:
  the smallest page that separates a per-row containment from a per-chunk one. Accepted on that
  measurement.
- **Honesty audit of the delivery.** Additions only on the spec (`140 0`); no `.only`, no skip, no
  `@ts-ignore`, no lint suppression, no `TODO`, no `process.env`/`NODE_ENV`, no literal 24-hex id —
  every id derives from the seeds — and no production file touched by the PR.
- **Test-quality note (Info, no change requested).** `I31` opens with
  `expect(derivePipelineStatus(ALL_PROCESSED)).toBe("indexed")`, which asserts a pure helper against
  a constant and so says nothing about the run; it mirrors the block's existing style. The
  load-bearing arms are the `errors` count and the `warn` level plus the `fields.eventId` set, each
  proven above.
- **Case-id resolution.** At `f370cf5b` the spec carries 32 `it("I…` cases and no duplicate id: the
  multi-row case of this record is `I31` ("every failing row is counted and named") and PR #751's
  wire case is `I32` ("the warn the transport receives"), one line each — so GREEN card
  `t_6a41b383` did renumber its own case to `I32` before merging PR #751, as its pre-merge
  re-sweep required.
- **No retraction.** Nothing in §Context, §Decision, §Evidence, §Gates, §Consequences or §Id
  reconciliation is retracted, and every measurement they state stands, including the §Id
  reconciliation of `I30` to `I31`. Later cards' own records document what followed: the `err:`
  rename the mutation replay above meets is ADR-0886's fix through PR #753, and this record is not
  rewritten for it.
- **The ledger's numstat digit.** The `docs/adr/README.md` note for this record said the pin spec's
  `git diff --numstat` is `140 1`; measured on the squash it is `140 0`
  (`git diff --numstat c96c2d18^..c96c2d18` → `140 0` on the spec, `155 0` on this record, `5 2` on
  the ledger). This sign-off corrects that one character and changes no row, no cell and no other
  byte of the ledger. Both `Next free` cells read `0891` at `f370cf5b`, not the `0888` the card
  predicted — later lanes consumed the numbers above `0887`, and `ADR-0890` is the highest record on
  the trunk at that commit — so this card mints no number and moves no cell.
