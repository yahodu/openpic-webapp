# ADR-0928 — OP-139 robustness: the nightly rollup writes in bulk and the isolation audit reads in bounded batches

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_516fb5e6` (OP-139 robustness — **F4** and **F5** of the round-1 review of the
  GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §8)
- **Branch:** `OP-139-task-nightly-jobs-scale`, cut from `origin/main` `45a571ba`.
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_516fb5e6`
- **Touches:** three production files — `apps/web/src/server/jobs/analytics-rollup.ts` (batched
  writes), `apps/web/src/server/jobs/tenant-isolation-audit.ts` (cursor sweep, bounded `$in`),
  `apps/web/src/server/repos/collection.ts` (the `RepositoryCollection` adapter gains `bulkWrite`)
  — this record and its ledger rows. **No test, factory, fixture or helper file is in the diff.**
- **ADR number:** `0928` — the OP-139 lane's own block (`0918`–`0937`), its `Next free` cell read
  `0928` on the trunk and is advanced to `0929`. The sweep is §6.
- **Consumes:** [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §8 (the two known-limit
  paragraphs closed here), [ADR-0924](ADR-0924-op139-rollup-revenue-green.md) (the rollup's write
  shape this record batches) and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 item
  23 (the number sweep).
- **Consumers:** the doc comments on `WRITE_BATCH_SIZE` (`analytics-rollup.ts`) and
  `PARENT_LOOKUP_BATCH_SIZE` (`tenant-isolation-audit.ts`).

## 1. F5 — the rollup writes one `bulkWrite` per chunk, not one `updateOne` per scope

The rollup wrote one row per scope with `await …updateOne(…, {upsert: true})` inside two `for`
loops plus the platform row, so a day cost `N + M + 1` **serial** round trips: `N` tenant rows,
`M` event rows, one platform row. At a few thousand scopes that is thousands of serial round trips
inside one invocation.

The same operations now travel in `bulkWrite` chunks of `WRITE_BATCH_SIZE = 1_000`:

```ts
// One `bulkWrite` per chunk: a day costs `ceil(scopes / 1_000)` round trips
// instead of one per scope (ADR-0919 §8, closed by ADR-0928).
let affected = 0;
for (let start = 0; start < scopeWrites.length; start += WRITE_BATCH_SIZE) {
  const chunk = scopeWrites.slice(start, start + WRITE_BATCH_SIZE);
  await platformRepo(db)
    .collection(COLLECTIONS.analyticsDaily)
    .bulkWrite(
      chunk.map(({ kind, id, metrics }) => ({
        updateOne: {
          filter: { "scope.kind": kind, "scope.id": id, dateKey },
          update: { $set: { metrics, computedAt } },
          upsert: true,
        },
      }))
    );
  affected += chunk.length;
}
```

| Decision                                    | Why                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same filter and the same `$set`         | The row identity `{scope.kind, scope.id, dateKey}` and the written fields are the contract; only the transport changes.                                    |
| Chunk at 1,000 operations                   | A very large day must not build an oversized command; `ceil(scopes / 1_000)` calls bound the latency and the document size together.                       |
| `affected += chunk.length`                  | `affected` stays "the number of scope rows written", exactly as the per-row counter was; a failed chunk still throws, as a failed `updateOne` did.         |
| Tenant rows, then event rows, then platform | The array is built in the shipped write order, so the ordered `bulkWrite` preserves it.                                                                    |
| `bulkWrite` on the repository adapter       | The adapter is the only path to a collection (`collection.ts:9-14`); a raw `db.collection(...)` write in a job would break that invariant.                 |
| The adapter refuses `bulkWrite` when scoped | A bulk command cannot be stamped per document, so a tenant-scoped handle refuses it (`refuseScope`) instead of writing rows it cannot scope. Not hit here. |

Round trips for one day: **before** `N + M + 1`; **after** `ceil((N + M + 1) / 1_000)`. A
1,000-scope day costs **one** `bulkWrite` where it cost **1,001** serial `updateOne`s.

## 2. F4 — the audit iterates cursors and batches the parent `$in`

**(a) Unbounded `$in`.** `eventIds` collected every distinct parent event id across a collection and
passed the whole list to `find({_id: {$in: [...]}})`. MongoDB rejects a query document near 16 MB —
roughly 1.2 M `ObjectId`s — so the nightly audit failed outright rather than degrading. The parents
are now resolved 1,000 ids per query and merged into the same `parentTenant` map:

```ts
const parentIds = [...eventIds].map((id) => new ObjectId(id));
// One `$in` per 1,000 parents: an unbounded list hits MongoDB's 16 MB cap.
for (let start = 0; start < parentIds.length; start += PARENT_LOOKUP_BATCH_SIZE) {
  for await (const parent of platformRepo(db)
    .collection(COLLECTIONS.events)
    .find(
      { _id: { $in: parentIds.slice(start, start + PARENT_LOOKUP_BATCH_SIZE) } },
      { projection: { tenantId: 1 } }
    ) as unknown as AsyncIterable<{ readonly _id?: unknown; readonly tenantId?: unknown }>) {
    /* merge eventId -> tenantId */
  }
}
```

**(b) Whole-collection `toArray()`.** Every tenant-scoped collection was materialised in full. Both
passes now iterate the driver cursor (`for await (const row of …find(…))`), and
`scannedByCollection`/`scanned` keep their meaning: `collectionScanned` counts the documents the
first pass examined, per collection and in total.

| Decision                                      | Why                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two cursor passes, not one buffered array     | The mismatch pass needs the complete `parentTenant` map first, so it cannot run in the same pass as the id collection; streaming twice keeps memory constant where buffering kept the rows. |
| `scanned` from the first pass only            | The second pass re-reads the same collection to evaluate it. Counting it too would change `scanned`, which the contract pins as documents **examined**.                                     |
| Batch size 1,000 for the parent lookup        | 1,000 `ObjectId`s is ~12 KB of query document — three orders of magnitude below the 16 MB cap — and keeps `$in` plans small.                                                                |
| Merge the batches into one `parentTenant` map | The mismatch test reads one map keyed by parent id; batching is invisible to it.                                                                                                            |

## 3. What stays unchanged

Findings, reasons (`missing_tenant` / `unresolved_tenant` / `tenant_mismatch`), payload key sets
(exactly `{collection, count, reason}`), dedupe keys, the summary log line, and
`scanned`/`affected`/`skipped`/`errors`/`hasMore` are byte-identical in behaviour. `vercel.json`,
the four cron routes, `platform-settings.ts`, `cron-job.ts`, the jobs' limits and thresholds are not
touched.

## 4. Measurement

| State                                                                      | Result                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| before the change — the four OP-139 integration specs                      | `4` files, `32 passed (32)`                              |
| before the change — `counter-reconcile-drift` + `analytics-rollup-buckets` | `2` files, `23 passed (23)`                              |
| after the change — the same four integration specs                         | `4` files, `32 passed (32)` — same counts, no case moved |
| after the change — the same two unit specs                                 | `2` files, `23 passed (23)`                              |
| whole `unit` project                                                       | `194` files, `3261 passed \| 3 skipped (3264)`           |
| whole `integration` project                                                | `159` files, `1692 passed (1692)`                        |
| the seven `adr-*` guards                                                   | `7` files, `248 passed (248)`                            |
| focused `analytics-rollup` / `analytics-rollup-buckets`                    | `10 passed (10)` / `11 passed (11)`                      |
| focused `tenant-isolation-audit`                                           | `9 passed (9)`                                           |
| `tsc -p apps/web/tsconfig.json --noEmit`                                   | exit `0`                                                 |

`git diff` on the two jobs shows only the batching: the removed `writeRollup` helper and its two
`await`ed loops, the removed `rows` array and its two loops, and the sequential `$in` + `toArray`
parent query. No assertion, fixture or factory is in the diff.

## 5. Consequences and residuals

- **ADR-0919 §8's audit paragraph is closed.** It read "the audit reads every tenant-scoped
  collection whole, and resolves parents with one `$in` query per collection … large collections
  want a paginated cursor" — both halves now hold.
- **The serial write cost was not recorded in ADR-0919 §8.** That section listed the audit's read
  limit but not the rollup's `N + M + 1` serial `updateOne`s; this record adds the limit and closes
  it in the same change. No §8 bullet is rewritten.
- **Residual:** the mismatch pass re-reads each collection that had a parent id. That is a second
  server-side scan per such collection (disk and cursor traffic, no client memory).
- **Residual:** `eventIds` still holds every distinct parent id (as strings) for the collection being
  audited. That is bounded by the number of distinct parents, not by the document count.
- **Residual:** the rollup still loads one day's source rows in memory (ADR-0919 §8's `shortcut`
  note). Untouched here.
- **Residual:** no pin asserts the batching itself — the change is behaviour-preserving, so the
  existing 32 integration cases are the guard on its output, and the transport is proven by the
  `git diff` above rather than by a test.
- **Residual:** `bulkWrite` on a tenant-scoped `RepositoryCollection` throws
  `TenantScopeViolation`. No caller needs it; the refusal exists so the adapter's scope invariant
  cannot be bypassed by a bulk command.

## 6. Number allocation and sweep

Draws **`0928`**, the OP-139 lane's `Next free` cell inside its `0918`–`0937` block
(`ADR-0927`, the cold-start pin PR #820, consumed `0927` and left the cell at `0928`), and advances
the `OP-139 jobs & compliance lane` cell to **`0929`**. No other cell moves, no cell is lowered and
no range is re-cut.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `45a571ba`: highest record `ADR-0944` (the OP-140 lane, outside this block); no
  `ADR-0928`–`ADR-0937` path on the trunk;
- every `.worktrees/*/docs/adr` tree on this host: highest `ADR-0944`; no `ADR-0928` file in any
  tree;
- the open PR heads #821, #755, #743, #272: none carries an `ADR-0928`–`ADR-0937` path;
- `git rev-list --objects --all -- docs/adr`: no `ADR-0928` object.

Re-swept immediately before the push.
