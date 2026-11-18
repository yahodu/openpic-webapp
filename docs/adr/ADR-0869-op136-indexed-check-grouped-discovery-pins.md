# ADR-0869 — OP-136 TEST: the indexed check's grouped batch discovery and its limit budget

- **Status:** Accepted (characterization pins; green on arrival) · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_b730389c` (Low; finding **F1** of the review of the OP-136 GREEN
  `t_eeb212c2`, PR #661 / squash `d28cddd1`, which shipped
  [ADR-0862](ADR-0862-op136-indexed-check-batch-arm-cost.md)). Branch
  `OP-136-task-grouped-batch-discovery-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `9bda367e`.
- **Implements:** contract §10.2 (the bounded-cron rules — the per-run `limit`, `hasMore`,
  idempotence), notification design §4.7 (`upload.batch.completed`), schema §16.2 / §16.3 (the
  session and join rows the discovery reads).
- **Consumes:** [ADR-0862](ADR-0862-op136-indexed-check-batch-arm-cost.md) §1–§2 (one grouped
  `event_images` aggregation per tenant in the page, `$limit` = the run's remaining budget) and
  §Assumptions **A2** (no pin depends on which pairs win a truncated page);
  [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §1 (the change-scoped
  candidate page); [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md) §3
  (`ROW_CHECK_CONCURRENCY` rows in flight, a row's own batches in turn).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (the appended
  block's header cites this record).
- **Number allocation:** the `OP-136 jobs lane` cell read `0868` on the trunk `9bda367e`, and the
  sweep immediately before minting found **`ADR-0868` already in flight, untracked, in the sibling
  worktree `/root/openpic/openpic-webapp/.worktrees/t_0924f321`** (`OP-136-task-requeue-warn-pins`,
  card `t_0924f321`, same lane) — nothing above `0867` on the trunk, in
  `git rev-list --objects --all -- docs/adr`, or on any open PR head. This record therefore takes
  the highest in-flight number **plus one**, `0869`. The draw is a **pool draw**, and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 makes a pool draw advance
  **both** the lane cell and the `unallocated (future lanes)` cursor; the allocator's sweep of this
  card (card `t_f21a0110`) fixes both cells at `0875`, because `0870` was retired unminted and
  `0871`/`0872` (poison chain) and `0873`/`0874` (sweep drain) are in flight above this record. Per
  §11 items 18–21 the exhausted block **keeps** its range `0849`–`0868` and draws from the pool: an
  exhausted cell is not licence to re-cut a range, and no renumber of this record is needed. The
  `OP-129 attendee identity lane` cell `0869` is **not** stale: its range is `0780`–`0798`, so a
  cell beyond the end is item 19's encoding of "this block is exhausted", and item 20 forbids
  repairing a foreign cell.

## Context

ADR-0862 replaced the per-event `event_images` read with one grouped aggregation per tenant in the
candidate page — `$match` on the page's event ids with a non-null `uploadBatchId`, `$group` on
`(eventId, uploadBatchId)`, `$sort` for a stable truncated selection and `$limit` of the run's
remaining budget — and the arm stops collecting at `limit`. Measured at the merged head `d28cddd1`
in a reviewer probe worktree, both of the shapes that distinguish it are green:

- two changed events of **one** tenant, one settled batch each → both summaries,
  `details.batches: 2`;
- one event, three settled batches, `requestedLimit: 2` → `details.batches: 2`, two summaries.

No case in `job-pipeline-indexed-check.test.ts` could see either. Its nineteen cases assert
**emitted summaries**, and every one of their fixtures gives each event its own tenant — `seedEvent`
mints a fresh `tenantId` per call — so the grouping only ever ran with a one-event `$in`, and no
case asked `details.batches` to stay inside `limit`. The card's own gap statement names the limit
of that: **no pin counts reads**, so a faithful revert to the per-event read cannot be caught by a
behaviour pin at all.

## Decision

### 1. Two characterization cases, appended, on the two shapes the grouped read exists for

Both are appended at the end of `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
in a new describe block, `+171/−0`. The nineteen existing cases, their fixtures, constants and
helpers are **byte-identical** (the first 1181 lines hash to `2174e452…0fc216`, the hash the review
of the GREEN recorded); the block adds three block-scoped helpers only — a fourth
`runJobWithLimit` (the same five lines the three existing blocks already carry), `seedEventForTenant`
and `seedSettledOneFileBatch`.

- **`I20` — two changed events of one tenant are both discovered on one page.** Two events are
  seeded into one tenant key, each with one worker-settled batch (`seedCompletedSession` ×1 and
  `seedBatchImage(status: "done")` ×1 — case `I7`'s "the worker finished it" shape, one file
  instead of two), and one run is asked for room for both. Asserted: `details.batches` is `2`, and
  the outbox holds exactly two `upload.batch.completed` rows whose own `batchId`, `tenantId`,
  `eventId`, uploader subject and `fileCount` name their own event. This is the only shape that
  reddens when the grouping drops a tenant's later event or narrows its `$in` to one id.
- **`I21` — the discovery is bounded at the run's `limit`.** One event carries three distinct
  worker-settled batches and the run is asked for `requestedLimit: 2`. Asserted:
  `details.batches === 2` and exactly two `upload.batch.completed` rows, both naming a seeded batch
  and the event, with no batch summarised twice. This reddens when the budget — the `$limit`, the
  early stop, or the counter that reports them — regresses to counting every pair.

### 2. What neither case pins

- **Which pairs win a truncated page.** ADR-0862 §Assumptions **A2** records that no pin depends on
  it; `I21` asserts the count and that each summary names a seeded batch, never which batch a later
  page carries. (The reviewer's measured divergence — the grouped collection picking `E1,E1,E3`
  where the old slice picked `E1,E1,E2` — belongs to `t_488f057b` → `t_bf0ae9ae`.)
- **The number of reads.** `I20`/`I21` are behaviour pins: a discovery that reads once per tenant and
  one that reads once per event are indistinguishable in the outbox when both are correct, which is
  what the probes below measure.
- **The mixed `ObjectId` / 24-hex-string batch-id form.** Unreachable under schema §16.3 (one form
  per batch), so pinning it would freeze an implementation detail.

## Evidence

### The pins

The frozen cases plus the two new ones: `21 passed (21)` against the unchanged production file, on
the first run — the card's **characterization** expectation. Neither case was RED, so nothing had to
be stopped and reported.

### Why the pins bite — three throwaway mutations

One probe worktree (`git worktree add --detach` at the pin commit, `node_modules` symlinked from the
lane worktree), one mutation at a time, the production file restored with `git checkout --` between
them and the worktree removed afterwards. The restored file hashes to
`0744e6b55be34f328b92704fa64c335bbe8d94d5d079e4af8fe533f7aee82112`, the hash ADR-0867 records, and
`git status --porcelain` is empty:

- **M1 — the faithful revert.** The pre-0862 read, lifted verbatim from `d28cddd1^`
  (`batchesOfEvent`: `find({ eventId: row._id, uploadBatchId: { $ne: null } }).limit(limit)` per
  event, deduped into a `Set`) → **`21 passed (21)`**. Nothing reddens, which is the measurement the
  card's own gap statement predicts and which contradicts its §Acceptance expectation (a): the two
  new cases pin **behaviour**, and a cost-only revert preserves behaviour.
- **M2 — the grouping narrowed.** The same aggregate, `$in: eventIds.slice(0, 1)` → **`1 failed |
20 passed (21)`**, `I20` alone: `AssertionError: expected 1 to be 2`, at
  `expect(run.details?.batches).toBe(2)`. The second event's batch is never discovered, so its
  summary never exists.
- **M3 — the budget dropped.** `$limit` removed from the aggregate, the early stop removed,
  `pending.slice(0, limit)` restored for the checks and `details.batches` set to the unbudgeted
  length → **`1 failed | 20 passed (21)`**, `I21` alone: `AssertionError: expected 3 to be 2`.
  M3 ships three summaries and reports three; the two-summary assertion would redden next, so the
  counter is pinned independently of the outbox.

### Gates

- `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`
  → `1 passed (1)` / `21 passed (21)`;
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
- `eslint` 0 issues and `prettier --check` clean on the touched paths;
- the six `adr-*` guards green: `6 files / 236 passed (236)`;
- the full suite with coverage, `--project unit --project integration --coverage`: `326 files / 4585
passed | 3 skipped (4588)`, exit `0`, branches `80.45 %` (gate 80), statements `91.7 %`, functions
  `95.95 %`, lines `91.83 %`.

The diff is the one spec (append only), this record and the `docs/adr/README.md` bookkeeping — no
production file, no existing case, fixture, constant or helper edited, no `.only`, no skip, no
loosened matcher.

## Assumptions

- **A1** — a shared tenant is seeded by re-homing the event row. `seedEvent` mints its own tenant
  per call and is frozen, so `seedEventForTenant` writes the row through `seedEvent` and then moves
  its `tenantId` to the caller's key with the raw driver. The batches then land in that tenant too,
  because `seedBatchImage` and `seedCompletedSession` stamp `event.tenantKey`. This matters
  mechanically: `tenantRepo` prefixes an aggregate with the scope's `tenantId` `$match`, so a join
  row left in another tenant would be invisible to the discovery.
- **A2** — one summary per settled batch. Each seeded batch has one session (so `files.total` is
  `1`, which is what `fileCount` carries) and one uploader (`uploaders` is the distinct set of
  `upload_sessions.createdByUserId`), so the outbox row count is the batch count and the cases can
  assert it directly.
- **A3** — `details.batches` is the discovery's size, not the number of rows, which is why `I21`
  reads it as the budget's observable (mutation M3 reddens exactly there).
- **A4** — the case labels are `I20`/`I21`, not the card's `I17`/`I18`: those two numbers were
  already taken by ADR-0866's arm-retry and backpressure cases at this head, and the frozen cases
  may not be renumbered. The card's identifiers are read as labels, not as an ordering constraint.

## Out of scope

- **A read-count pin** — the per-tenant call count is not observable from the outbox or the run
  envelope, and mutation M1 shows a cost-only revert staying green.
- **Which pairs win a truncated page** (ADR-0862 §A2) and the mixed batch-id form (§2 above).
- **`hasMore`, `scanned`, `skipped`** — pinned or declared elsewhere (ADR-0866 §2, ADR-0861
  §Out of scope).
- **The `limit`'s interaction with the events page** — `I21` seeds one event, so the assertion is
  about the batch budget alone.

## Alternatives

- **A read-count pin** — spy on the driver and require one `eventImages` read per tenant. Rejected: it
  freezes the mechanism ADR-0862 chose rather than the behaviour, reddens a legitimate refactor that
  keeps the cost, and mutation M1 shows why a behaviour pin cannot replace it (the two are different
  questions, and only the behaviour one is a contract).
- **Pinning the truncated page's winning pairs** — rejected by ADR-0862 §A2: the grouped `$sort` and
  the old slice order legitimately disagree (`E1,E1,E3` versus `E1,E1,E2`), and that window belongs to
  `t_488f057b` → `t_bf0ae9ae`.
- **Pinning the mixed `ObjectId` / 24-hex batch-id form** — rejected: unreachable under schema §16.3,
  so the case would freeze an implementation detail rather than a behaviour.
- **Renumbering this record into the lane's range** — rejected by the allocator (card `t_f21a0110`):
  ADR-0300 §11 items 18–21 keep an exhausted block's range and draw from the pool.

## Consequences

- The grouped discovery is now pinned in the two directions its code can be wrong: too narrow (a
  tenant's later event dropped, `I20`) and unbounded (the budget ignored, `I21`).
- A future **performance** refactor back to per-event reads keeps these cases green by design; the
  protection there is ADR-0862's measurement, not this file.
- `docs/adr/README.md` is the shared-ledger hotspot: this index row, its note and the two cells merge
  as a union keeping the higher values (`0875` lane and `0875` pool cursor).
- `0869` is a **pool draw**: the lane block `0849`–`0868` was exhausted, calls from it keep its range
  and draw from the pool (ADR-0300 §11 items 18–21), so the draw advances **both** the lane cell and
  the `unallocated (future lanes)` cursor — both land on `0875` after the allocator's sweep of this
  card (card `t_f21a0110`: `0870` retired unminted, `0871`–`0874` in flight). Merging the ledger
  takes the higher side of a union and never lowers a cell.

## Review sign-off (round 1, artifact lens) — APPROVED

Reviewed head `e178da53` (PR #673), already squash-merged as `7e3f642d` before the review
ran. The PR's own paths — the spec and this record — are byte-identical between the reviewed
head and the squash, so the reviewed bytes are the shipped bytes. The only tree delta in that
window is main's own `ADR-0316` landing (card `t_8f0c9915`): its record file, plus the
`+7/−3` row it added to `docs/adr/README.md`. No production file, existing case, fixture,
constant or helper is touched, there is no `.only`, no skip and no loosened matcher.

### Evidence re-measured at the merged trunk

Re-measured by the reviewer at `7e3f642d` in a throwaway worktree, not copied from the
delivery's handoff. The production job file hashes to `0744e6b5…82112` there and on today's
trunk, so the pins and the probes below ran against the bytes this record describes.

- **The spec is green as delivered** — the whole file, on unchanged production code:
  `21 passed (21)`.
- **M2 — the grouping narrowed.** `$in: eventIds` → `eventIds.slice(0, 1)` reddens `I20`
  alone with `1 failed | 20 passed (21)`: `AssertionError: expected 1 to be 2` at
  `details.batches`, because the tenant's second event and its summary are gone.
- **M3 — the budget dropped.** With the `{ $limit: limit - pending.length }` stage removed,
  `I21` alone reddens with `1 failed | 20 passed (21)`: `AssertionError: expected 3 to be 2`.
- **M5 — the counter off by one.** `details.batches` raised by one reddens with
  `2 failed | 19 passed (21)` — exactly `I20` and `I21`, both `expected 3 to be 2` — so the
  count assertion carries its own pin and is not merely implied by the two summaries.
- **Production restored byte-identically.** After each probe the file hashed back to
  `0744e6b5…82112` and `git status --porcelain` was empty.

### Gates at the merged trunk

- the pin spec → `21 passed (21)`, whole file;
- the full suite → `326 files / 4585 passed | 3 skipped (4588)`, exit `0`;
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 problems on the spec, and
  `prettier --check` clean on the spec, this record and the ledger;
- the six `adr-*` guards → `6 files / 236 passed (236)`;
- the ledger at `7e3f642d`: `373` `ADR-*` records, every number appearing once — no duplicate,
  and `ADR-0869` present;
- the delivery's own fourteen checks were green on `e178da53`.

### Findings

#### Low (additive, since closed) — the per-tenant early stop was unpinned

Deleting `if (pending.length >= limit) break;` leaves this record's cases fully green
(`21 passed (21)`), while a page whose first tenant fills the budget then rejects the tick
with `MongoServerError: the limit must be positive` (`code 15958`). The gap is additive, so
it could not change this delivery's verdict: it was routed to the Test Author as
`t_4fe23af4`, and the case `I22` it produced — beside `I20` and `I21` — is recorded in
[ADR-0876](ADR-0876-op136-per-tenant-early-stop-pin.md).

#### Info — the lane worktree was reaped mid-review

`/root/openpic/openpic-webapp/.worktrees/t_16239628` was deleted while the review ran
(dispatcher reap), and it and the gated follow-up's worktree were rebuilt detached at
`7e3f642d`. No action follows for this record: the reaper is owned by `t_f4a1695b` (OPS,
done).

### Post-review status

This sign-off consumes **no ADR number**: `0869` is the record it appends to, no row and no
cell of `docs/adr/README.md` is touched, and the ledger therefore stays byte-identical. No
decision in §Decision is retracted — §1's two cases and §2's three declared gaps stand — and
the further arm the review measured is now pinned beside them in ADR-0876 as `I22`. No code
change was requested and no case was weakened.
