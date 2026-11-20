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
scoped to a row's own check; a page-level read failure stays fatal. That half is **not** pinned in
the suite: `I22` is the case of [ADR-0876](ADR-0876-op136-per-tenant-early-stop-pin.md) and it pins
the **per-tenant early stop** of the grouped batch discovery (`pendingBatches`' `break` and its
`$limit` budget), not the abort. No case in the suite makes the grouped `event_images` aggregate
throw, so ADR-0867 §2's abort half stays unpinned today; the round-1 reviewer measured it out of
band with a throwaway probe (see §Review — round 1). The follow-up card _OP-136 TEST — pin that a
throwing grouped discovery aborts the whole indexed-check run and stamps nothing (ADR-0867 §2)_ owns
the missing pin.

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

## Review — round 1 (post-merge verification at `b3f63308`)

**Verdict: APPROVED WITH FINDINGS on PR #741.** One Medium finding and one Low finding are routed
to other cards, and one Low citation finding (**F2**) is settled by the §3 correction above. The
delivery is PR #741, reviewed at head `7f0de8de` and squash-merged as `b3f63308` before this append
was written, so this section checks the landed bytes and is not a merge request. The reviewer made
**zero edits** to the delivery — no test, fixture, helper or production line moved. Nothing in
§Decision is retracted: §Context, §Decision 1, 2 and 4, §Consequences, §Evidence and §Alternatives
stand as written, and §3 carries the one corrected citation.

### The pins that landed are the pins that ran

- The pin spec `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` is one git object
  (`5fe966bc…add3a`, `sha256 5d4b9b1c…61a4`) at the RED head `7cc2b270`, at the reviewed head
  `7f0de8de`, at the branch head `9bbadcfe`, at the squash `b3f63308` and on `origin/main`.
- `docs/adr/ADR-0871-op136-poison-row-containment-pins.md` is likewise one object
  (`a59cba03…6ef8`, `sha256 c859be63…cf6a`) across the same commits.
- The spec reports `29 passed (29)` at the reviewed head and again on `b3f63308`. The delivery's five
  paths hold no other test file, so the GREEN edits no test.

### The containment is load-bearing — three mutations, all reverted

Each mutation was applied to `apps/web/src/server/jobs/pipeline-indexed-check.ts`, run, and reverted
with `git checkout --`. The file came back at `sha256 fa4f0b91…a72b4` after every arm, and
`git status --short` was clean.

| Mutation                                             | sha256 of the mutated file | Result                                                                          |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Rethrow after the chunk settles (the pre-GREEN file) | `0744e6b5…2112`            | `4 failed \| 25 passed` — `I26`, `I27` and the retired vacuity arms `I17`/`I23` |
| Count kept, `warn` dropped                           | `9ab65e26…3d0f`            | `1 failed \| 28 passed` — `I27` alone                                           |
| `warn` kept, count dropped                           | `5772abd9…9e25`            | `3 failed \| 26 passed` — `I26` on `expected +0 to be 1`, plus `I17`/`I23`      |

The red sets separate counting from naming: `I27` is the only case that sees the `warn` go, and
`I26` is the only case that sees the count go. Neither half rides on the other.

### The abort half (ADR-0867 §2) holds — measured out of band

No case in the suite makes the grouped `event_images` aggregate throw. This review therefore
measured the property with a throwaway spec: a `Collection.prototype.aggregate` spy that throws on
`event_images` makes the run **reject**. No row then carries `pipeline.indexedCheckedCounters` or
`pipeline.indexedNotifiedAt`, `domain_events` stays empty, and the next tick over the same page
resolves `scanned: 3`, `errors: 0` with one announcement per row. Containment did not swallow a
page-level read failure. The probe file was deleted and the tree was clean afterwards. §3 above now
states that the suite does not pin this half, and names the follow-up card that owns the pin.

### Gates, all on the merged tree

- `vitest run --project unit --project integration --coverage` — 335 files,
  `4713 passed | 3 skipped (4716)`, exit `0`; statements 92.27, branches 81.18, functions 96.49,
  lines 92.40 (branch gate 80).
- `tsc -p apps/web/tsconfig.json --noEmit` — exit `0`.
- `eslint .` — exit `0`, 0 errors, 188 pre-existing warnings.
- `prettier --check` — clean.
- The six ADR guards — 6 files, `236 passed (236)`.

### Numbers

- `ADR-0871` and `ADR-0872` are unique on the merged tree and on every open PR head, and the rows
  ascend (`0867`, `0869`, `0871`, `0872`, `0876`).
- Both ledger cells read `0882` on the merged tree. The trunk advanced them past the card's `0873`
  and the orchestrator's `0875`; the union rule keeps the highest value, so no cell was lowered.
- `ADR-0868` is still unminted on every ref.

### Scope

`git diff bffcc881..9bbadcfe --stat`, the trunk at review time, names five paths and no production
path beyond the one job file:

- `apps/web/src/server/jobs/pipeline-indexed-check.ts` (+18/−9)
- `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (carried, see above)
- `docs/adr/ADR-0871-op136-poison-row-containment-pins.md` (+227)
- `docs/adr/ADR-0872-op136-poison-row-containment-green.md` (+142)
- `docs/adr/README.md` (+2 rows)

The decision matches the decision card `t_39d7b19f` option 1 **plus** the `warn`. There is no
option-2 or option-3 artefact, no dependency change, no route change and no contract change. The
honesty audit is clean: no fixture-shaped logic, no test-environment conditional, no `@ts-ignore`,
no new dependency and no TODO.

### Landing, against the §9.1 gate (ADR-0318)

G1 `MERGEABLE`/`BLOCKED` (the one-review rule, satisfied by the review comment posted before the
merge) · G2 14 of 14 checks `COMPLETED`/`SUCCESS`, `audit` included at `07:21:48Z` · G3 all eleven
gating names present · G4 empty range · G5 pass. The squash is `b3f63308`; the branch tree
`76382864…` equals the squash tree; the squash is an ancestor of `origin/main`; local `main` equals
`origin/main`.

### Findings, routed

- **F1 (Medium) — the `warn` passes the failure reason under a field the logging port drops.** The
  `warn` passes the reason as `error`, but the port serializes only `err` (`serializeError`), so a
  bare `Error` reaches the transport as `{}`. §1's snippet shows that shape, and `I27` hides the gap
  with its own error-to-message replacer. Route: the Test Author pins the wire shape through the
  real logger, then the Implementer renames one key and corrects §1's snippet. Owner card: _OP-136
  TEST — pin that the contained-row warn carries the failure reason through the real logger (the
  `error` field is dropped)_.
- **F2 (Low) — this record's §3 cited `I22` for the abort half.** `I22` pins the per-tenant early
  stop of the grouped discovery, not the abort. Corrected above, in place.
- **F3 (Low) — ADR-0867 §2's abort half is unpinned.** The behaviour holds, measured out of band
  here; the suite does not hold it. Route: the Test Author. Owner card: _OP-136 TEST — pin that a
  throwing grouped discovery aborts the whole indexed-check run and stamps nothing (ADR-0867 §2)_.

Nothing else is left unrouted, and no finding needs a change in this record beyond the §3 sentence.
