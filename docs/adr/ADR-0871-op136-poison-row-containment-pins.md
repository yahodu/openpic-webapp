# ADR-0871 — OP-136 TEST: a persistently failing row is contained, counted and named

- **Status:** Accepted (TEST, RED by design) · **Date:** 2026-11-18
- **Card:** OP-136 TEST `t_fba690f8` (Low; finding **F2** of the round-1 review of the OP-136 GREEN
  `t_bf0ae9ae`, PR #670 / head `1b38307d` / squash `40b65309`), on the decision card `t_39d7b19f`
  (option **1 — contain per row**). Branch `OP-136-task-poison-row-containment-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`, cut from the trunk `cd89b275`.
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — `limit`, `errors`, `scanned`,
  `hasMore`, idempotence, retry safety), notification design §4.7 (`upload.batch.completed`),
  schema §15.1 (the `events` counters cache), §16.2 / §16.3 (the sessions and join rows the OP-126
  arm reads).
- **Consumes:** [ADR-0867](ADR-0867-op136-indexed-check-stamp-triple-after-arm.md) §1 (the triple is
  stamped after the row's arm work) and [ADR-0866](ADR-0866-op136-indexed-check-arm-retry-and-backpressure-pins.md)
  §1 (the arm's work is retried by a later run),
  [ADR-0861](ADR-0861-op136-indexed-check-scan-window-drain-green.md) §1 (the change-scoped candidate
  window this page is read from), [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) §1
  (the page must advance), [ADR-0869](ADR-0869-op136-indexed-check-grouped-discovery-pins.md) §1–§2
  and [ADR-0876](ADR-0876-op136-per-tenant-early-stop-pin.md) §1 (the grouped discovery the arm
  runs on), and [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (an
  exhausted block draws from the pool and keeps its range).
- **Consumers:** `apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` (the new block's
  header cites this record).
- **Number allocation:** `0871`, drawn from the pool. The `OP-136 jobs lane` block
  `0849`–`0868` is exhausted (§11 item 18), and its cell reads `0877` on this base, one above the
  highest record minted here — so **no cell moves**: §11 item 20 forbids repairing or lowering a
  cell, and `0871` was allocated to this card by `t_39d7b19f` below the cursor. The sweep
  immediately before minting found `ADR-0876` as the highest record on the trunk (both cells
  `0877`), `ADR-0877` in flight in `.worktrees/t_e9340c72` on open PR #688, `ADR-0875` in
  `.worktrees/t_01fd59cf`, `ADR-0868` still untracked in `.worktrees/t_0924f321`, and
  `git rev-list --objects --all -- docs/adr` stopping at `0877`; no `ADR-0871` or `ADR-0872`
  object exists on any surface, so the GREEN's `0872` stays free.

## Context

The OP-136 GREEN `t_bf0ae9ae` ordered a candidate row's work as: announce, then the row's OP-126
batch arm, then the checked triple (ADR-0867 §1). That made a row that aborts inside its arm stay a
candidate, so a later tick retries the arm's work — the property ADR-0866 §1 asked for. What it
also did, and what no pin or record covered, is make a row that fails **persistently** fatal for
every tick: the run drives its page in chunks of `ROW_CHECK_CONCURRENCY = 8` and rethrows the first
rejection **after** the chunk settles
(`apps/web/src/server/jobs/pipeline-indexed-check.ts:278-287`), and the outcome returns
`errors: 0` (`:299`). So a poison row — a batch whose join or session data makes
`checkUploadBatchTransition` throw deterministically, not the transient read `I17`/`I23` pin —
rejects every tick for as long as it exists.

The card `t_39d7b19f` stated that as permanent head-of-line blocking ("rows in later chunks and
every row of every later page are never reached"). The reviewer measured the truth in a probe at
`1b38307d` (one poison row as the lowest `_id`, ten healthy `indexed` events, `requestedLimit: 12`,
three ticks then cleared):

```
{"tick":0,"rejected":true,"announcedAfterTick":8}
{"tick":1,"rejected":true,"announcedAfterTick":11}
{"tick":2,"rejected":true,"announcedAfterTick":11}
afterPoisonCleared: { scanned: 1, announced: 11 }
control:            { scanned: 11, details: { indexed: 11, batches: 1 }, announced: 11 }
```

**The correction carried into this record and into the pins:** rows in the poison's own chunk run
concurrently with it and complete, so the defect is a **permanent run failure plus a throughput cap
of `ROW_CHECK_CONCURRENCY - 1` = 7 rows per tick** — which becomes a real stall only once the poison
row is the last candidate on the page. The cron still answers 500 on every tick (the billing route
returns the outcome unchanged), and `errors` cannot tell such a run from a clean one.

The decision of record (`t_39d7b19f`, taken on trunk `9bda367e`) is **option 1 — contain per row**:
count the failure in the §10.2 envelope, keep running the remaining rows and chunks, keep the row a
candidate so the next tick retries it, and name it in a `warn`. `defineCronJob` already logs the run
at `error` when `errors > 0` and never throws (`cron-job.ts:147-193`), so the framework needs no
change and the operator keeps an error-level signal every tick.

## Decision

### 1. The contract the pins fix

A row whose own OP-126 batch-arm work throws must not abort the run:

1. the failure is counted once in the §10.2 envelope (`errors += 1`, the field every job currently
   hardcodes to `0`), so the run resolves and `defineCronJob` reports it at `error`;
2. the remaining rows **and later chunks** keep running in the same run, so the page keeps advancing;
3. the failing row keeps its `pipeline.indexedCheckedCounters` triple unstamped, so it stays a
   candidate and the next tick retries the arm's work — ADR-0866 §1 / ADR-0867 §1 are unchanged, and
   no summary is lost, only deferred;
4. each failing row is named once in a `warn` with `event: "pipeline.indexed_check.row_failed"`,
   `fields.eventId` set to the failing event id, and the thrown error carried alongside;
5. `scanned`, `hasMore`, `skipped` and `details` keep their present meaning — the contained run is a
   normal §10.2 run with a non-zero `errors`.

### 2. The pins (`I26`–`I29` appended, and `I17`/`I23`'s vacuity arm retired)

The block is one `describe` at the end of
`apps/web/src/test/integration/job-pipeline-indexed-check.test.ts`, plus one module-level helper
(`failFindWhen`) that generalises the shipped `failNextFind` seam: it arms a
`Collection.prototype.find` failure on **every** call whose filter matches, so a failure persists for
the whole run instead of the single call `I17`/`I23` use, and it is scoped by the driver filter's
`eventId`, so no other row's arm sees it.

- **`I26` (RED)** — nine `_id`-ascending candidates (`requestedLimit: 12`, so `PAGE_SIZE` = 9 is one
  more than `ROW_CHECK_CONCURRENCY` = 8 and the ninth is alone in the run's **second** chunk). The
  lowest `_id` is the poison row: a settled two-file batch whose `event_images` read throws on every
  call. One run must resolve, report `scanned` = 9 and `errors` = 1, and announce **every** healthy
  row — the second chunk's included — in that same run.
- **`I27` (RED)** — the same page and the same poison row: exactly one log entry with
  `level: "warn"`, `event: "pipeline.indexed_check.row_failed"` and
  `fields.eventId` = the poison event's id, carrying the thrown error's message in some field (the
  field **name** is deliberately not fixed — the contract names the event and the id, not the key).
- **`I28` (characterization, green on arrival)** — two ticks with the injection armed leave the
  poison row's triple unset and emit no `upload.batch.completed` for its batch; a third tick after
  the injection is cleared emits exactly one, naming that batch id, its event and its uploader. This
  is the measured half the shipped ordering already gives (ADR-0867 §1), recorded as a
  characterization so a reviewer does not read it as new coverage.
- **`I29` (negative control, green on arrival)** — a clean page of the same size reports
  `errors: 0`, `scanned` = 9, names no failing row, and announces each row once with one summary per
  batch. Neither `errors` nor the warn can become a constant in either direction.

Every assertion is an observable: the run envelope, the outbox rows (`pipeline.event.indexed`,
`upload.batch.completed`), the event row's stored triple, and the run's own log lines. No case names
the chunking, the catch, the query or the sort, so any containment that keeps the four properties
above satisfies the block.

The same diff also retires the three `rejects.toThrow` arms of the shipped `I17`/`I23` (§4): those
arms assert the premise this decision retires, so the pin set cannot be green with them in place. No
other line of those two cases changes.

### 3. Case numbering: `I26`–`I29`, not `I20`–`I23`

The card said the file holds `I1`–`I19` and that these cases are `I20`–`I23`. That is stale by six
landings: at this base the file already carries `I1`–`I25`, and `I20`/`I21` (the grouped discovery
and its limit budget), `I22` (the per-tenant early stop) and `I23` (the two-abort retry) are taken.
Four cases appended as `I20`–`I23` would duplicate four live ids, so the block continues at `I26`.
Apart from the §4 retirement, no shipped case, helper, fixture or assertion is edited: the block's own
diff is the block, the one helper, and one extended import line.

### 4. `I17` and `I23`'s vacuity arm is retired here, not by the GREEN

`I17` and `I23` guarded their own seeds with
`await expect(runJobWithLimit(...)).rejects.toThrow("injected failure: find on event_images")` —
"the seeded read failure must abort the run, or the case proves nothing". That premise is exactly
what this decision retires: once a row failure is contained, the run **resolves** with `errors: 1`.
The three assertions are false under the new contract, and no containment can satisfy both them and
`I26` — measured in a throwaway probe worktree by applying only the near-fix (settle, count, warn
naming the event) to the production file: `2 failed | 27 passed (29)`, `I17` and `I23`, both
"promise resolved … instead of rejecting".

The retirement is a **test** change, so this card makes it: `docs/CONVENTIONS.md:22` — "Tests are
owned by the Test Author. Implementers and agents never edit, skip, weaken or delete a test to make
the suite pass" — and the GREEN card's own body forbids editing or renumbering a pin. The round-1
review of PR #690 rejected the earlier plan to route the retirement to the GREEN `t_6275f30a`, and
this record states the delivery as it is.

The retired arm asserts the **resolved envelope**, never a swallow:

```ts
await expect(
  runJobWithLimit(NOW, 50),
  "a row whose own arm work throws must be counted, not thrown out of the run"
).resolves.toMatchObject({ errors: 1 });
```

A bare `.catch(() => undefined)` was rejected because the reviewer measured that a degenerate
containment which still rethrows when the failing row is alone in its chunk — `if (chunk.length === 1)
{ throw outcome.reason; }`, otherwise count and warn — passes all 29 cases under that shape. The
resolved-envelope form kills it: `I17`'s page holds exactly one candidate, so its chunk has length
one. Every other line of `I17`/`I23` — the `fired() === 1` anchor that proves the arm was reached, the
empty-outbox assertion of the failed tick, and the "one summary for the batch" subject with its five
assertions — is unchanged, and both case titles plus the two "aborted run" assertion messages keep
the shipped word "abort" for the arm failure (the row's arm still fails; only the run now contains
it).

## Consequences

- The defect is gone once the GREEN lands: no 500 every five minutes, a non-zero `errors` in the
  §10.2 envelope, an `error`-level `cron.pipeline-indexed-check.completed` line (the framework's
  existing behaviour), a `warn` naming each failing row, and a page that keeps advancing past the
  poison row in the same tick instead of at 7 rows/tick.
- The poison row's **own** §4.7 summary is still not emitted until the row is fixed — true of every
  option the decision card considered, and the reason the retry property (item 3) is preserved
  rather than replaced by a skip.
- The warn's field name for the thrown error is unpinned by design; a later contract that fixes one
  needs a new pin.
- A contained run's `scanned` counts the failing row like any other, so `hasMore` is unaffected by
  containment.
- The pins are RED at this head by design (`I17`/`I23` on the resolved envelope containment does not
  yet give, `I26` on the run's rejection, `I27` on the missing warn), so the PR is a **draft** and is
  not merged: the GREEN closes it, as ADR-0864 / ADR-0866 did. The GREEN needs **no** test edit — the
  near-fix alone answers `29 passed (29)` (§Evidence).

### Evidence at the pin head (`17e8eff8`, base `cd89b275`)

- The pin file: `4 failed | 25 passed (29)`. `I17` and `I23` fail with
  "promise rejected \"Error: injected failure: find on event_images\" instead of resolving" — the
  replacement arm of §4, red because the head still rethrows; `I26` with "a row whose own arm work
  throws must not abort the run; it rejected with: Error: injected failure: find on event_images";
  `I27` with "a row whose own arm work throws must be named exactly once: expected [] to have a
  length of 1 but got +0". `I1`–`I16`, `I18`–`I25` and `I28`/`I29` pass.
- Satisfiability, in a throwaway probe worktree at this head with the near-fix applied to the
  production file alone (settle the chunk, count each rejection, warn with
  `event: "pipeline.indexed_check.row_failed"` and `fields.eventId`): **`29 passed (29)`**, so the
  GREEN `t_6275f30a` needs no test edit. The probe tree was restored byte-identically
  (`git status --short` empty, production file `sha256 0744e6b5…82112`) and removed.
- Gates at this head: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` on the changed file
  `0` issues; `prettier --check` clean on the three changed paths; the six `adr-*` guards
  `236 passed (236)`; the full `integration` project `1 failed | 141 passed (142)` files and
  `4 failed | 1500 passed (1504)` tests — the four are `I17`/`I23`/`I26`/`I27` by design.
- The round-1 review of PR #690 (head `437947d2`) measured the pre-retirement numbers this record
  used to carry: pin file `2 failed | 27 passed (29)`; near-fix alone `2 failed | 27 passed (29)`
  (`I17`/`I23` on the vacuity arm now retired in §4); near-fix plus the retired arms
  `29 passed (29)`. That review also measured a degenerate containment that still rejects a
  singleton chunk passing all 29 cases under a bare `.catch`, which is why §4 asserts the resolved
  envelope.

## Alternatives

- **Option 2 — keep the stall and document it.** Leaves a 500 every five minutes and the 7-row/tick
  cap, and still needs the `try`/`catch` a `warn` requires, so it is not the docs-only path the
  decision card assumed.
- **Option 3 — a durable per-row attempt counter.** Adds state whose failure mode is a silently
  starved event (the class ADR-0860/0861 removed) and does not recover the poison row's summary
  either, since no option emits it until the row is fixed.
- **Number the cases `I20`–`I23` as the card said.** Would duplicate four live ids and make the file
  ambiguous to both the reader and the next card.
- **Keep `I17`/`I23`'s vacuity arm and route its retirement to the GREEN.** Rejected in the round-1
  review of PR #690: the retirement is a test change, `docs/CONVENTIONS.md:22` forbids an implementer
  editing a pin, and the GREEN's own card says "Do not edit or renumber a pin". A pin set that cannot
  all be green is not a satisfiable handoff.
- **Retire the arm as a bare `.catch(() => undefined)`.** Rejected: the reviewer measured a
  containment that still rejects a singleton chunk passing all 29 cases under that shape. The
  resolved-envelope form in §4 is what bites.
