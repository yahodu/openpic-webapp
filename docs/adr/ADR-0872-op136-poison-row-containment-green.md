# ADR-0872 — OP-136 GREEN: a failing indexed-check row is contained, counted and named

- **Status:** Accepted (GREEN) · **Date:** 2026-11-18
- **Card:** OP-136 GREEN `t_6275f30a` (Low), implementing the decision of record `t_39d7b19f`
  (option **1 — contain per row**) and its pins `t_fba690f8` (ADR-0871).
  Branch `OP-136-task-poison-row-containment-green`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the pin head `7cc2b270`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — `limit`, `errors`, `scanned`,
  `hasMore`, idempotence, retry safety), notification design §4.7 (`upload.batch.completed`),
  schema §15.1 (the `events` counters cache), §16.2 / §16.3 (the sessions and join rows the OP-126
  arm reads).
- **Consumes:** [ADR-0871](ADR-0871-op136-poison-row-containment-pins.md) §1 (the five properties
  the pins fix) and §4 (the `I17`/`I23` vacuity arm the Test Author retired), and the records that
  pin the halves this change must not disturb:
  [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md) §1 (the triple is stamped after
  the row's arm work) and §2 (a discovery throw stamps nothing and retries the page),
  [ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md) §1 (the arm's work is
  retried by a later run), [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §1
  (the candidate window), [ADR-0869](ADR-0869-op136-indexed-check-grouped-discovery-pins.md) §1–§2
  (the grouped discovery), and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11
  items 18–21 (the pool draw and the ledger cells).
- **Consumers:** `apps/web/src/server/jobs/pipeline-indexed-check.ts` (the row loop cites §1).
- **Number allocation:** `0872`, the number ADR-0871 §Number allocation reserved for this card. The
  `OP-136 jobs lane` block `0849`–`0868` is exhausted (§11 item 18) and both its cell and the
  `unallocated (future lanes)` cursor read `0877` on this base, one above the highest record minted
  here, so **no cell moves**: §11 item 20 forbids repairing or lowering a cell. The sweep
  immediately before minting found `ADR-0877` in flight on open PR #688 and `ADR-0875`/`ADR-0876` as
  the highest records on the trunk and in sibling worktrees; `git rev-list --objects --all -- docs/adr`
  stops at `0877`, and no `ADR-0872` file or object exists on the trunk, in any `.worktrees/*` tree or
  on any open PR head. The block keeps its range (§11 item 21).

## Context

ADR-0867 §1 ordered a candidate row's work as announce, then that row's OP-126 batch arm, then the
checked triple, so a run that aborts in the arm leaves the row a candidate and a later tick retries
its §4.7 summary. The row loop also rethrew the first rejection **after** its chunk of
`ROW_CHECK_CONCURRENCY = 8` settled, and the §10.2 envelope hardcoded `errors: 0`
(`apps/web/src/server/jobs/pipeline-indexed-check.ts`, the row loop and the `return`). A row whose own
arm work throws deterministically — a poison row — therefore rejected every tick for as long as it
existed. The decision card `t_39d7b19f` and the probe recorded in ADR-0871 §Context corrected the
card's premise: the defect is a **permanent run failure plus a throughput cap of 7 rows per tick**,
not permanent head-of-line blocking, because the rows of the poison's own chunk run concurrently and
complete.

## Decision

### 1. Contain a row's own check, count it, name it, keep the page advancing

The row loop keeps the chunked `Promise.allSettled` at `ROW_CHECK_CONCURRENCY = 8` and stops
rethrowing. It walks each settled chunk **by index**, so a rejection can be attributed to the row it
belongs to: on `rejected` it increments a run-local `errors` counter and emits one `warn` —

```ts
logger.warn("pipeline indexed row check failed", {
  event: "pipeline.indexed_check.row_failed",
  eventId: row._id.toHexString(),
  error: outcome.reason,
});
```

— then continues with the remaining entries and the remaining chunks. The §10.2 envelope returns
`errors` instead of the hardcoded `0`; `scanned`, `hasMore`, `skipped` and `details` keep their
present meaning, and `defineCronJob` already reports a run with `errors > 0` at `error`
(`cron-job.ts`), which is why that file is untouched.

Counting and naming happen **per rejected row**, not per chunk: two rows that fail in one chunk are
two errors and two warns, each naming its own event id. The field that carries the thrown error is
`error`; the pins fix the event name and the id, not that key (ADR-0871 §1 item 4).

### 2. Nothing else moves

`derivePipelineStatus` stays the oracle, the latch stays `pipeline.indexedNotifiedAt` with the
injected clock, the dedupe key stays `pipeline.event.indexed:<eventId>`, the first announcement keeps
`notifyByEmail: true`, the announcement still precedes the marker, the row's own batches still run in
turn, and the checked triple is still stamped **last** for that row. A contained row's arm work did
not complete, so its triple stays unstamped and the next tick retries it —
[ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md) §1 and
[ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md) §1 are preserved, not
replaced by a skip. No summary is lost, only deferred until the row is fixed or the failure clears.

### 3. The discovery throw still aborts the run

The grouped batch-discovery aggregate runs before the row loop and is **not** wrapped: a throw there
stamps nothing and aborts the run, so the whole page retries next tick (ADR-0867 §2). Containment is
scoped to a row's own check; a page-level read failure stays fatal. `I22` pins that half.

### 4. The pins are carried byte-identically

`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` is copied unchanged from the pin
head `7cc2b270`: the diff's only test path is that file's own content, and the file reports
`29 passed (29)` — `I17`/`I23` on their retired vacuity arm (now the resolved envelope with
`errors: 1`), `I26` on containment, `I27` on the warn, `I28`/`I29` as the characterization and the
clean-page control, and `I1`–`I25` untouched. The GREEN edits no test.

## Consequences

- No 500 every five minutes from a poison row, a non-zero `errors` in the §10.2 envelope, an
  `error`-level `cron.pipeline-indexed-check.completed` line, one `warn` naming each failing row, and
  a page that keeps advancing past it in the same tick instead of at 7 rows per tick.
- The poison row's own §4.7 summary is still not emitted until its arm can run — true of every option
  the decision card considered, and the reason the retry property is preserved rather than replaced.
- `scanned` counts a contained row like any other, so `hasMore` is unaffected by containment.
- Known limit, measured: the follow-up card `t_3d67936e` exists because the shipped pins cannot tell
  per-row counting from per-chunk counting when the fails land in different chunks. This GREEN counts
  and names per row by construction; the measurement is in §Evidence.
- The warn's field name for the thrown error stays unpinned; a contract that fixes one needs a new
  pin.

### Evidence at the GREEN head

- The pin file: `29 passed (29)` (was `4 failed | 25 passed (29)` at `7cc2b270`), no test edit:
  `git diff --exit-code` on it is empty.
- Per-row counting and naming, measured in this worktree with a throwaway spec file that reuses the
  pin block's helpers (two poison rows in the **same** chunk of a ten-row page): the run resolved
  with `{"errors":2,"scanned":10,"warns":2,"warnedIdsMatch":true,"fired":2}` — two warnings, each
  naming one of the two poison events, each read actually attempting the injected failure. The same
  probe run against a throwaway **chunk-level** mutation of the production loop (count once per
  chunk, name `chunk[0]`) reddened the probe with
  `{"errors":1,"scanned":10,"warns":1,"warnedIdsMatch":false}` (`expected 1 to be 2`), so the probe is
  load-bearing and the per-row walk is what makes it pass. The probe file was deleted and the
  production file restored byte-identically (`sha256 fa4f0b91…a72b4`, `git status --short` showing
  only the three delivery paths).
- Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 on the touched paths;
  `prettier --check` clean; the six ADR guards green; `vitest run --project unit --project
integration` fully green; coverage above the configured thresholds.

## Alternatives

- **Option 2 — keep the stall and document it.** Rejected by the decision card: it keeps a 500 every
  tick and the 7-row/tick cap, and it still needs the `try`/`catch` a `warn` requires, so it is not
  the docs-only path the card assumed.
- **Option 3 — a durable per-row attempt counter.** Rejected: it adds state whose failure mode is a
  silently starved event (the class ADR-0860/0861 removed), and it does not recover the poison row's
  summary either, since no option emits it until the row is fixed.
- **Count once per chunk and name the chunk's first failing row.** Rejected: it under-reports a page
  with several poison rows (one error for two failures, one name for two events) and hides the second
  row from the operator's only signal. The walk is by index for exactly this reason.
- **Skip a row that fails.** Rejected: it would drop the row's §4.7 summary for good and retire the
  retry property ADR-0866 §1 / ADR-0867 §1 pin. Containment defers the work, it does not discard it.
- **Contain the discovery aggregate too.** Rejected: a page-level read that fails throws before any
  row is stamped, so retrying the same page next tick is already correct and cheap; containing it
  would only hide a broken read behind a permanent `errors` count.
