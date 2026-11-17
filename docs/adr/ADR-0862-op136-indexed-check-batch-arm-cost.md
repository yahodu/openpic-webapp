# ADR-0862 — OP-136 GREEN: the indexed check's OP-126 arm reads the page in groups, not per event

- **Status:** Accepted (GREEN, performance) · **Date:** 2026-11-17
- **Card:** OP-136 GREEN `t_eeb212c2` (Medium; finding **M1** of the review of the OP-136 GREEN
  `t_16239628`, PR #635). Branch `OP-136-task-indexed-check-batch-arm-cost`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `60edffb0` (which carries
  the parent's squash `848b1d54`).
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row's bounded-cron rules — `limit`,
  idempotence), notification design §4.7 (the `upload.batch.completed` summary), schema §16.3 (the
  `event_images` join row and its `uploadBatchId` form).
- **Consumes:** [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §2 (one page
  drives both arms) and its §Out of scope, which routed the arm's cost to this card;
  [ADR-0855](ADR-0855-op136-indexed-check-derive-latch-batch-arm-green.md) §2 (the arm as built);
  [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this cron is the named caller of
  `checkUploadBatchTransition`).
- **Consumers:** `apps/web/src/server/jobs/pipeline-indexed-check.ts` (the `pendingBatches` docstring
  and the chunked check loop cite this record in place).
- **Number allocation:** the `OP-136 jobs lane` row's `Next free` cell read `0862` on this base
  (`60edffb0`). The sweep immediately before minting found the newest record anywhere to be
  `ADR-0861`: the trunk's newest is `0861`, `git rev-list --objects --all -- docs/adr` holds no
  `ADR-0862*` object, every `.worktrees/*/docs/adr` tree tops out at `0861`, and every fetched
  `refs/heads/*` head (the twenty open PRs included) tops out at `0861`. This record therefore takes
  `0862` and advances **only** the `OP-136 jobs lane` cell to `0863`; both
  `unallocated (future lanes)` cells stay `0869`. No number outside `0849`–`0868` is consumed.

## Context

ADR-0861 §1 makes an event a candidate only until its counters move, so the arm's _scope_ is now the
handful of events that changed on the tick. Its _cost per candidate_ was untouched, and the review of
`t_16239628` measured three parts of it (finding **M1**):

1. `batchesOfEvent` issued one `event_images` read **per candidate event**, each capped at `limit`
   documents — with the shipped `defaultLimit: 500` a full page could move 500 × 500 join documents
   to learn a few dozen batch ids.
2. `pending` was materialised for every event and only then cut with `pending.slice(0, limit)`, so the
   allocation was O(events × limit) while the work was bounded by `limit`.
3. `for (const batch of batches) await checkUploadBatchTransition(...)` serialised up to `limit`
   round-trip chains (three reads per batch) into one run.

The card is verify-first. Measured first, on a throwaway probe spec (untracked, deleted before the
commit; the production file restored byte-identically for the "before" column), counting
`event_images` documents returned and `upload_sessions` reads (one per `checkUploadBatchTransition`)
per run through driver-level spies. Three fixtures:

- **A — steady state** (the shape ADR-0861 produced): 20 worker-settled events already drained by a
  warm-up tick, then **one** event whose counters moved. `limit` 500.
- **B — busy page**: 40 changed events, each with 400 `event_images` in 2 batches. `limit` 500.
- **C — one page of 120 batch checks**: one event, 240 images across 120 batches. `limit` 500; the
  number is the arm's wall clock around `run()`.
- **D — more pairs than the limit**: 20 changed events × 5 batches, `requestedLimit: 20`, i.e. 100
  pairs against a page of 20 events.

| Fixture                  | Before                                | After                                 |
| ------------------------ | ------------------------------------- | ------------------------------------- |
| A discovery              | 1 read / **2** docs                   | 1 read / **1** doc                    |
| A checks                 | 1                                     | 1                                     |
| B discovery              | 40 reads / **16 000** docs            | 40 reads / **80** docs                |
| B checks                 | 80 (snapshots 80 reads / 16 000 docs) | 80 (snapshots 80 reads / 16 000 docs) |
| C wall clock, 120 checks | **558 ms** (serial)                   | **230 ms** (chunked 8)                |
| C discovery              | 1 read / 240 docs                     | 1 read / 120 docs                     |
| D pending                | **100** allocated, sliced to 20       | **20** (never more than `limit`)      |
| D discovery              | 20 reads / 100 docs                   | 4 reads / 20 docs                     |

Two readings of the table are honest to state up front. The drain of ADR-0861 already removed the
"per run for the life of every event" cost: a steady-state tick reads one event (A). What still scaled
with the _page_ was the per-event read and the serialisation (B, C), and the per-event read wasted
200 documents for every pair it found on B — worse as one event holds more photos, since the read is
capped at `limit`, not at the number of batches. The B **call** count does not move because that
fixture seeds one tenant per event; the call bound is now one per **tenant** in the page, and D shows
the aggregate stopping as soon as the run's budget is met (4 of 20 tenants).

## Decision

### 1. One grouped discovery read per tenant in the page

`pendingBatches(candidates, db, limit)` groups the page's event ids by tenant and runs, per tenant,

```ts
tenantRepo(tenantKey, db)
  .collection(COLLECTIONS.eventImages)
  .aggregate([
    { $match: { eventId: { $in: eventIds }, uploadBatchId: { $ne: null } } },
    { $group: { _id: { eventId: "$eventId", batchId: "$uploadBatchId" } } },
    { $sort: { "_id.eventId": 1, "_id.batchId": 1 } },
    { $limit: limit - pending.length },
  ]);
```

so the join documents stay in the database and only distinct `(event, batch)` pairs cross the wire.
`tenantRepo` is kept — the handle prefixes its own `tenantId` `$match` — because it is the only
sanctioned door to a tenant-scoped collection; the aggregation is per tenant for exactly that reason.
The same `String(...)` conversion of the stored `uploadBatchId` (ObjectId for a 24-hex id, raw string
otherwise, schema §16.3 `batchIdValue`) yields the batch id the arm passes on, unchanged.

### 2. The collection is bounded at the run's limit, by construction

`$limit: limit - pending.length` after the `$group` caps the pairs at the run's remaining budget, and
the tenant loop breaks once `pending.length === limit`. There is no full materialisation followed by
`slice`: the allocation is bounded by the same `limit` that bounds the work.

### 3. The batch checks run a chunk at a time

`BATCH_CHECK_CONCURRENCY = 8`; `Promise.all` per chunk. A failure still rejects the run — the arm's
error semantics are unchanged (the run aborts, and the pins of `t_488f057b` measure that window).
Eight was chosen as a small fixed chunk: each check is three reads against the same database, and the
page is one wave of chunks rather than `limit` serialised chains.

### Unchanged

The emitted event shapes, the outbox `(batch, uploader)` dedupe keys, `details.batches`, the
`upload.batch.completed` / `..._with_errors` payloads, the candidate page and its order, and the
absent per-batch marker. `readBatchSnapshot`'s own two reads per batch are untouched.

## Consequences

- A run reads **distinct pairs**, not join rows: 16 000 documents became 80 on the measured busy page,
  and 240 became 120 on a single-event page (C). The saving grows with photos per batch, which is the
  direction events actually grow.
- Discovery calls are now one per **tenant** in the page rather than one per event. On a page of
  single-tenant events (the probe's B and the integration fixtures' shape) the call count is
  unchanged; on a page with several events per tenant it drops.
- The arm's allocation cannot exceed `limit` any more, so a page of large events costs one bounded
  structure, not one per event.
- The checks overlap: 120 checks went from 558 ms to 230 ms locally. The absolute numbers are a local
  Mongo; the ratio is the claim, not the milliseconds.
- A page that holds more pairs than `limit` still checks only `limit` of them, exactly as the slice
  did; the rest wait for the next counter move. That is the window `t_488f057b` → `t_bf0ae9ae` owns,
  not this record.
- `docs/adr/README.md` is the lane's hotspot: this index row, this lane cell and this note merge as a
  union keeping the higher cell (`0863` lane, `0869` pool).

## Alternatives

- **Bound the collection and chunk the awaits, keep the per-event read.** Half the code, and the
  measurement says it leaves the largest term in place: the per-event read moves up to `limit`
  documents to learn the event's distinct ids (B: 16 000 documents for 80 pairs).
- **One raw cross-tenant aggregation on `db.collection("event_images")`.** One read for the whole
  page, but it bypasses `tenantRepo` — the only sanctioned door to a tenant-scoped collection — and
  would be the first place in the codebase to reach one without a scope. Rejected: the per-tenant
  loop is the pattern the layer exists for, and its cost is bounded by the tenants in one page.
- **A per-batch marker field**, so an already-summarised batch is never re-read. Forbidden by the
  card: ADR-0861's event-level `pipeline.indexedCheckedCounters` is the only new marker in this lane,
  and the outbox dedupe key already keeps the emissions correct.
- **A configurable chunk size / a concurrency helper.** No caller needs to tune it and the repo has no
  concurrency helper to reuse; a constant and a loop are the whole change.

## Assumptions

- **A1** — `$group` over `(eventId, uploadBatchId)` names exactly the pairs the per-event `Set` named:
  the same predicate (`uploadBatchId: { $ne: null }`, which excludes a missing field) and the same
  `String(...)` normalisation. The pins `I7`–`I11`, `I14` read the emitted summaries, not the
  discovery, and stay green.
- **A2** — no pin depends on _which_ pairs win a truncated page. The `$sort` keeps a truncated page's
  selection deterministic across runs; the mixed ObjectId/string batch ids still sort in a total BSON
  order.

## Evidence

- **Pins.** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` — ADR-0852's eight,
  ADR-0859's `I9`–`I11`, ADR-0860's `I12`–`I16` — is `16 passed (16)` at this head, unedited.
- **The measurement** is the table in §Context, produced by a throwaway probe spec (untracked,
  deleted before the commit) with driver-level spies on `find`/`aggregate`; the "before" column was
  taken by stashing the one production file and re-running the same probe.
- **Gates.** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 issues and
  `prettier --check` clean on the touched paths; the six ADR guards green; the full
  `unit` + `integration` suite with `--coverage` above the branch threshold.
- **Diff.** One production file (`apps/web/src/server/jobs/pipeline-indexed-check.ts`, +68/−31), this
  record, and the `docs/adr/README.md` bookkeeping. No test, fixture, helper or pin edited.

## Out of scope

- The ordering of the checked-triple stamp against the arm (**M2**, pinned by `t_488f057b`, fixed by
  `t_bf0ae9ae`).
- `readBatchSnapshot`'s own reads per batch (three when a batch has failures) — the arm calls it once
  per pair, and narrowing it is a change to the OP-126 seam, not to this cron.
- The indexable refinement of the candidate filter (`counters.pipelineRevision`, `t_3072cd38`).
