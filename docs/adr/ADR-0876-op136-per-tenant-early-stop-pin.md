# ADR-0876 — OP-136 TEST: the per-tenant early stop of the indexed check's batch discovery

- **Status:** Accepted (characterization pin; green on arrival) · **Date:** 2026-11-18
- **Card:** OP-136 TEST `t_4fe23af4` (Low; finding **F2** of the round-1 review of the OP-136 pin
  card `t_b730389c`, PR #673 / squash `7e3f642d`, which landed
  [ADR-0869](ADR-0869-op136-indexed-check-grouped-discovery-pins.md)). Branch
  `OP-136-task-tenancy-budget-pin`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_4fe23af4`, cut from the trunk `7e3f642d`.
- **Implements:** contract §10.2 (the bounded-cron rules — the per-run `limit`, `hasMore`,
  idempotence), notification design §4.7 (`upload.batch.completed`), schema §16.2 / §16.3 (the
  session and join rows the discovery reads).
- **Consumes:** [ADR-0862](ADR-0862-op136-indexed-check-batch-arm-cost.md) §1–§2 (one grouped
  `event_images` aggregation **per tenant in the candidate page**, `$limit` = the run's remaining
  budget) and §Assumptions **A2** (no pin depends on which pairs win a truncated page);
  [ADR-0869](ADR-0869-op136-indexed-check-grouped-discovery-pins.md) §1–§2 (the `I20`/`I21` block
  this case is appended beside, and its two accepted gaps); [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md)
  §3 (`ROW_CHECK_CONCURRENCY` rows in flight, a row's own batches in turn).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (the appended
  block's header cites this record).
- **Number allocation:** the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor both
  read `0875` on the trunk `7e3f642d` (the cells ADR-0869 left), and the highest record **on** the
  trunk is `0869`. The sweep immediately before minting found **`ADR-0875-op137-delivery-receipts-red.md`
  in flight**, staged (uncommitted) in `.worktrees/t_01fd59cf` (`OP-137-task-delivery-receipts-red`),
  plus `ADR-0868` untracked in `.worktrees/t_0924f321`; `git rev-list --objects --all -- docs/adr`
  returns `0875` as its highest number and the three open PR heads (#674, #279, #272) stop at `0867`.
  The `0875` cursor value is therefore already held by another lane, so this record draws the highest
  in-flight number **plus one**, `0876`. The draw is a **pool draw** — the block `0849`–`0868` is
  exhausted — so [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 makes it
  advance **both** the lane cell and the cursor; both move to `0877`, one above this record, so the
  next draw of either cell cannot re-mint `0876`. Per §11 items 18–21 the exhausted block **keeps**
  its range `0849`–`0868`, no range is re-cut, and no foreign lane cell is touched (the
  `OP-129 attendee identity lane` cell `0869` stays as found: its range is `0780`–`0798`, so a cell past the
  end is item 19's encoding of "this block is exhausted", and item 20 forbids repairing it).

## Context

ADR-0862 replaced the per-event `event_images` read with one grouped aggregation **per tenant in the
candidate page**, and caps each tenant's read at the run's remaining budget
(`$limit: limit - pending.length`). The loop that walks the page's tenants is guarded by an early
stop that runs **before** each tenant's aggregate:

```ts
for (const [tenantKey, eventIds] of idsByTenant) {
  if (pending.length >= limit) {
    break;
  }
  … .aggregate([ … { $limit: limit - pending.length } ])
```

That stop is what keeps the next tenant's `$limit` **positive**. It is also the one arm of the budget
logic no case reached: ADR-0869's two pins (`I20`, `I21`) both put a **single** tenant on the page —
`I20`'s two events share one workspace, `I21`'s three batches share one event — so the loop never
arrived at a second tenant with the budget already spent.

The reviewer of `t_b730389c` measured the difference at the merged-pin head `e178da53` (production
file restored byte-identically, `0744e6b5…82112`):

- **control, two tenants A(3 settled batches) + B(1), `requestedLimit: 2`** → `details.batches: 2`,
  two summaries, no reject — the shape passes on arrival;
- **mutation M5, the early stop deleted** → the delivered spec stays `21 passed (21)` (nothing
  catches it) while the two-tenant page rejects with `MongoServerError: the limit must be positive`
  (`code: 15958`, `codeName: Location15958`).

So the failure mode is a **whole-run reject**: every candidate of the page loses its arm work, not
merely one extra batch. It was invisible to the suite.

## Decision

### 1. One characterization case, appended, on the only shape that reaches the second tenant

`I22` is appended at the end of `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` in
a new `describe` block, `+154/−0`. The nineteen original cases plus `I20`/`I21` are **byte-identical**
(the appended block adds three block-scoped helpers only: a fourth `runJobWithLimit`, plus
`seedEventForTenant` and `seedSettledOneFileBatch`, the shapes `I20`/`I21` already use).

- **Tenant A** — one changed event (`ALL_PROCESSED`) with **three** distinct worker-settled batches,
  one session and one `status: "done"` image each (case `I7`'s "the worker finished it" shape).
- **Tenant B** — one changed event with **one** such batch.
- **One run, `requestedLimit: 2`.** The candidate page is the two events in `_id` order, and A's
  event is seeded first, so A's tenant read runs first and its aggregate alone asks for more than the
  budget: `$limit: 2` returns two of A's three pairs, `pending` reaches `limit`, and the loop must
  stop before B's read.

Asserted, all from the run envelope and the outbox:

1. the run **settles** (a rejected run — B's aggregate sent with `$limit: 0` — fails the case with
   the driver's error, which is the pinned failure);
2. `run.details?.batches === 2`;
3. exactly **two** `upload.batch.completed` rows, one per distinct batch, **both** naming one of A's
   three seeded batch ids, both carrying A's `tenantId` and A's event id, and **none** naming B's
   batch.

### 2. What the case does not pin

- **Which of A's three batches win.** ADR-0862 §Assumptions **A2**: the count and the tenant the
  summaries belong to are the contract; the truncated page's winning pairs are not.
- **The mixed `ObjectId` / 24-hex-string batch-id form.** Unreachable under schema §16.3 (one form
  per batch); pinning it would freeze an implementation detail (ADR-0869 §2).
- **`scanned`, `skipped`, `hasMore`.** Declared elsewhere (ADR-0861, ADR-0866); the case asserts only
  the batch budget and the summaries it bought.

## Evidence

### The pin

`TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
→ `22 passed (22)` against the **unchanged** production file, on the first run — the card's
characterization expectation. The new case alone (`-t "I22"`) is `1 passed | 21 skipped (22)`, so the
22nd case is not a silently skipped sibling.

### Why the pin bites — the mutation the card names

One throwaway probe worktree (`git worktree add --detach` at the pin commit `82d54aa0`,
`node_modules` symlinked from the lane worktree), one mutation, the production file restored
afterwards and the worktree removed:

- **M5 — the early stop deleted.** Only the three lines `if (pending.length >= limit) { break; }` were
  removed from `pendingBatches` (a scripted replace, asserting exactly one occurrence; the file's hash
  moved `0744e6b5…82112` → `3d16d669…ab4e2c`) → **`1 failed | 21 passed (22)`**, `I22` alone:
  `MongoServerError: the limit must be positive` raised from `AggregationCursor._initialize`. Every
  other case stays green, which is the card's discrimination requirement.
- **The error code.** A throwaway spec in the same probe worktree ran `event_images.aggregate([{
$limit: 0 }])` and asserted the error's identity, so the code in this record is measured and not
  quoted: `name: "MongoServerError"`, `message: "the limit must be positive"`, `code: 15958`,
  `codeName: "Location15958"`.
- **Restore.** `git checkout -- apps/web/src/server/jobs/pipeline-indexed-check.ts` →
  `sha256 0744e6b55be34f328b92704fa64c335bbe8d94d5d079e4af8fe533f7aee82112` (the hash ADR-0867 and
  ADR-0869 record), `git status --porcelain` empty apart from the throwaway spec, probe worktree
  removed and pruned.

### Gates

- `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
  → `1 passed (1)` / `22 passed (22)`;
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
- `eslint` 0 issues and `prettier --check` clean on the touched paths;
- the six `adr-*` guards green;
- the coverage run above the configured branch threshold.

The diff is the one spec (append only), this record and the `docs/adr/README.md` bookkeeping — no
production file, no existing case, fixture, constant or helper edited, no `.only`, no skip, no
loosened matcher.

## Assumptions

- **A1 — the page's first candidate is the caller's first seed.** Candidates are read in `_id` order
  (`sort({ _id: 1 }).limit(limit)`), and `ObjectId`s minted in one process increase, so seeding A's
  event before B's makes A the tenant whose read spends the budget. The case asserts that
  precondition (`eventA.eventId < eventB.eventId`) with its own message, because if it ever failed
  the case would measure the other tenant and pass for the wrong reason.
- **A2 — one summary per settled batch.** Each seeded batch has one session (so `fileCount` is `1`),
  so the outbox row count is the batch count and the case can assert it directly.
- **A3 — a shared tenant is seeded by re-homing the event row.** `seedEvent` mints its own tenant per
  call and is frozen; `seedEventForTenant` writes through `seedEvent` and then moves the row's
  `tenantId` with the raw driver, exactly as `I20` does. `tenantRepo` prefixes the aggregate with the
  scope's `tenantId` `$match`, so the batch rows inherit the moved key through
  `seedBatchImage`/`seedCompletedSession` stamping `event.tenantKey`.
- **A4 — the case label is `I22`.** It continues the file's `I1`…`I21` sequence; the frozen cases may
  not be renumbered.
- **A5 — the number `0876` is a pool draw**, not the lane block's next number: the block
  `0849`–`0868` is exhausted, and the trunk cursor `0875` was already held in flight by the OP-137
  lane at minting time (see **Number allocation**).

## Out of scope

- **Which of A's three batches are summarised** (ADR-0862 §A2) and the mixed batch-id form (§16.3).
- **`hasMore`, `scanned`, `skipped`** — pinned or declared elsewhere (ADR-0866 §2, ADR-0861
  §Out of scope).
- **A read-count pin.** The early stop is observable only as "the run settles and the counters stay
  inside the budget"; a driver spy would freeze the per-tenant read ADR-0862 chose instead of the
  behaviour this case measures.
- **The budget's interaction with the events page size.** The case seeds exactly two events for a
  page of two, so it measures the tenant loop, not the candidate window.

## Alternatives

- **Pin a read per tenant (spy on the aggregate).** Rejected: it freezes ADR-0862's mechanism rather
  than the contract, and it would redden a legitimate refactor that keeps the observable behaviour.
  The mutation above shows the behavioural pin is the one that catches the removed guard.
- **Seed three events in tenant A with one batch each, `requestedLimit: 3`.** Rejected: the reader's
  measured control — and the card — use one event with three batches for A, which keeps the case on
  `I21`'s fixture shape and makes the single tenant's read, not the page, the thing that spends the
  budget.
- **Seed tenant B first.** Rejected: B's one batch would leave the budget unspent, A's read would run
  with `$limit: 1`, and both tenants would be summarised — the exact shape that stays green under the
  mutation, so the case would prove nothing.
- **Assert the summary set equals two named batches.** Rejected: ADR-0862 §A2 keeps the truncated
  page's winners unpinned; the case asserts the count, the tenant and the event instead.

## Consequences

- The per-tenant early stop is now pinned by behaviour: removing it reddens `I22` alone, loudly, with
  the driver's own error (`code 15958`) rather than silently shrinking the page's work.
- A future refactor that keeps the budget inside `limit` — batching the tenants, one aggregate over
  all of them, a `$limit` computed upstream — keeps this case green, which is the intent.
- `docs/adr/README.md` is the shared-ledger hotspot: this index row, its note and the two cells merge
  as a union keeping the higher values (`0877` lane and `0877` pool cursor).
- `0876` is a **pool draw**; the lane block keeps its range and draws from the pool on every further
  record (ADR-0300 §11 items 18–21). Merging the ledger takes the higher side of a union and never
  lowers a cell.

## Review sign-off (round 1, artifact lens) — APPROVED

Reviewed head `8d1dbb9d` (PR #676), already squash-merged as `53051b91` before the
review ran. `git diff --stat 8d1dbb9d 53051b91` is **empty**, so the reviewed bytes
are the shipped bytes and this section is appended to the record that landed. The
delivery is the one spec, append only, plus this record and the shared ledger: no
existing case, fixture, constant or helper is edited, there is no `.only` and no
skip, and no production file is touched.

### Evidence the reviewer reproduced

Every figure below was re-measured at the trunk `53051b91` in the lane worktree
`/root/openpic/openpic-webapp/.worktrees/t_4fe23af4`, not copied from the delivery's
handoff. Each probe mutated
`apps/web/src/server/jobs/pipeline-indexed-check.ts` (committed
`sha256 0744e6b5…82112`), ran the case filter on `I22` alone, and was reverted with
`git checkout --`; after every pass the file hashed back to `0744e6b5…82112` and
`git status --porcelain` was empty.

- **The spec is green as delivered** — `22 passed (22)` on the unchanged production
  file. The new case alone is `1 passed | 21 skipped (22)`, so the 22nd case is not
  a silently skipped sibling.
- **M1 — the early stop deleted.** Only the three lines
  `if (pending.length >= limit) { break; }` removed → `1 failed | 21 skipped (22)`,
  `I22` alone: `MongoServerError: the limit must be positive`.
- **M2 — the comparison moved from `>=` to `>`.** → the same
  `1 failed | 21 skipped (22)` and the same driver error, so the case pins the
  boundary and not only the guard's total removal.
- **M3 — the early stop deleted and `$limit` clamped.** With
  `{ $limit: Math.max(1, limit - pending.length) }` the driver no longer rejects and
  the run settles, yet the case still reddens, `1 failed | 21 skipped (22)`:
  `AssertionError: the page's work stays inside the run's limit: expected 3 to be 2`
  at `run.details?.batches`. The count assertion carries the pin on its own.
- **The gates, at `53051b91`** — the six `adr-*` guards `6 files / 236 passed (236)`;
  `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` exit `0` on the job and
  the spec; `prettier --check` clean on this record; all `14` gates on `8d1dbb9d`
  pass; and the trunk's `CI`, `CodeQL` and `Version Bump` runs are `success` at
  `53051b91`.

### Findings

#### Info — `I22` alone cannot separate "the early stop fired" from "the second tenant was never read"

A tenant-loop truncation probe (`[...idsByTenant].slice(0, 1)`, so the loop reads
only the page's first tenant) leaves `I22` **green**: A's own read returns the two
pairs the budget allows, and all three of the case's assertions hold. The suite still
discriminates, because the frozen `I11` reddens on the same mutation
(`1 failed | 21 passed (22)`, `expected [ { …(10) } ] to have a length of 2 but got 1`).
No action follows: `I22` is one characterization case on one behaviour, and
§Out of scope already declines the read-count pin that would separate the two arms.

#### Info — the new `describe` re-declares its own `runJobWithLimit`

The appended block carries a block-scoped `runJobWithLimit`, byte-identical to the
earlier blocks' declarations (`10` lines), instead of reaching for the file's first
one. The card asked for block-scoped helpers, so this follows the contract, and the
same duplication is already the file's pattern at three earlier blocks.

### Post-review status

This sign-off consumes **no ADR number**: `0876` is the record it appends to, no row
and no cell of `docs/adr/README.md` is touched (the ledger stays byte-identical), and
the two follow-ups the review raised are docs-only — this section, and the missing
sign-off on `ADR-0869` (card `t_a224dd6f`). No code change was requested and no
decision in §1–§2 is retracted. The only other change to this record is in the
**Number allocation** bullet, where one continuation line was moved into the list
indent and its inline code span joined onto that line; the wording is unchanged and
`prettier --check` is clean.
