# ADR-0841 — TEST-INFRA: the `integration` project runs on a measured 30 000 ms per-test budget

- **Status:** Accepted · **Date:** 2026-11-17 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_e9340c72` (OP-135 TEST-INFRA, Medium) · **Branch:**
  `OP-135-task-integration-timeout-budget` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_e9340c72` · **Base:** `be3a6905` (#643)
- **Lane:** the OP-135 worker interface lane block `0829`–`0848` (row `OP-135 worker interface
lane`), whose `Next free` cell read **`0841`** at this base. There is **no `test-infra` lane row**
  in `docs/adr/README.md` (the ledger's thirty-two rows carry no such holder), so this record draws
  the number from the owning ticket's own cell rather than inventing a lane or a derived number:
  the sweep before minting found no `ADR-0841*` file in any of the
  `.worktrees/*/docs/adr` trees (their maxima ranged `0834`–`0859`), `git rev-list --objects --all
-- docs/adr` returning **`0859`** as the highest number on any object, and none of the open PR
  heads (`#645`, `#644`, `#631`, `#613` and their siblings) carrying `0841`. So this record takes
  **`0841`** and advances **only** the `OP-135 worker interface lane` cell to `0842`; the OP-136
  cell stays `0859`, the `OP-129 attendee identity lane` cell and the two `unallocated (future
lanes)` cells stay `0869`, and no range is re-cut.
- **Consumers:** `vitest.config.ts` (the `integration` project's `testTimeout`, and the only file
  this record governs). The guard sweeps `apps/` and `packages/`, so this root-level config file is
  outside the citation population — the field is declarative here, exactly as the record states.
- **Consumes:** [ADR-0037](ADR-0037-integration-spec-ci-readiness-budget.md) §Decision 3 (the
  `INTEGRATION_TEST_TIMEOUT_MS = 30_000` budget two specs already pin for themselves) and its
  §Alternatives (raising `testTimeout` **globally** was rejected there; this record raises it for
  the `integration` project only, and leaves the `unit` project on the default),
  [ADR-0839](ADR-0839-op135-pointer-race-failed-verdict-pin.md) §Evidence (the un-reproducible
  failure figures this class forced into a shipped record), and
  [ADR-0840](ADR-0840-op135-discard-log-field-set-pin.md) §Evidence (a full run that reddened
  **eight** cases of the same class, in seven specs, each green when run alone).
- **Findings:** the **Medium** test-reliability finding of the review of the OP-135 DOCS card
  `t_e074e3a8` (PR #642, squash `718166ec`), routed to this card.
- **Scope:** test infrastructure only — one config value, one constant and its documentation. No
  assertion, case, seed, fixture, helper, factory or production file is touched, and the case count
  is identical before and after.

## Context

A full `integration` run reddens a **rotating, disjoint** set of cases on the harness's 5 000 ms
default `testTimeout`, on the same tree, with no change in between. The failure text is always
`Error: Test timed out in 5000ms.` The class is old and it is what forced ADR-0838 and ADR-0839 to
publish failure figures that could not be reproduced (the ADR-0839 correction is PR #642).

Measured on this card at the base tree (`be3a6905`, worktree `t_e9340c72`,
`TMPDIR=/root/tmp-mongo`, `vitest run --project integration`, 139 files / **1452** cases):

- Run R1 — `4 failed | 1448 passed (1452)`, 245.73 s. Reds: `domain-events` I2 (timeout),
  `domain-events` I3 "two concurrent claimers" (timeout), `domain-events` "claim completion"
  (`AssertionError: expected [] to have a length of 1`) and `my-events` I3 (timeout).
- Run R2 (JSON reporter) — `2 failed | 1450 passed (1452)`, 231.08 s. Reds: `branding-upload` I1
  (5 024 ms) and `notification-digest-flush-daily-cap-redelivery` F1c-r2 (5 007 ms).
- The four red specs alone: green (`4 files passed (4)` per the parent card's focused runs; this
  card's two runs share no red case with either set the card names, nor with ADR-0838's set — a
  fifth disjoint set on the same class).

R1 also shows a second, worse shape of the same defect: the case _after_ a timed-out case failed on
an **assertion** (`expected [] to have a length of 1` at `domain-events.test.ts:261`), because the
timed-out case's work was still in flight against the shared client when the next case seeded its
own database. A reviewer reading `expected 1, received 0` cannot tell noise from a regression
without a second full run — which is the cost this card exists to remove.

Duration distribution of the 1 450 cases that **passed** in R2 (`assertionResults[].duration`):

- p50 **166 ms**, p90 **738 ms**, p95 **1 343 ms**, p98 **1 641 ms**, p99 **1 905 ms**,
  maximum **3 953 ms** (`notification-digest-flush-non-retryable` F1b).
- 231 cases ≥ 500 ms, 113 ≥ 1 000 ms, 13 ≥ 2 000 ms, 3 ≥ 3 000 ms, none ≥ 4 000 ms.

The 5 000 ms default therefore sat **1.26x** above the slowest case that survived it. That sample
is censored — every case over 5 000 ms is the red we are measuring — so the true tail is longer
than 3 953 ms, by an unknown amount.

Harness facts that make the tail long rather than the specs slow:

- 139 files are spread over `availableParallelism()` − 1 = **3** fork workers on a 4-vCPU host.
- One `MongoMemoryReplSet` (single node) serves every worker; each worker builds its own lazily
  connected client (ADR-0037 §Amendment), so contention is per-worker Mongo round-trip latency, not
  a shared in-process queue.
- The suite is CPU-bound (`Duration … tests 84 %`), so a worker that is descheduled pays the
  latency inside whichever timed case happens to be running. That is why the red set moves.

The card's `1448` case count was measured at `6711993e`; three merges later (`#640`, `#641`,
`#643`) the base of this card reads **1452**. This record counts the base rather than deriving the
delta, and the delivered change leaves that number identical.

## Decision

1. **`vitest.config.ts` gains one named constant, `INTEGRATION_TEST_TIMEOUT_MS = 30_000`**, with a
   TSDoc block carrying the measurement this record cites. The constant sits beside the file's other
   declared constant (`webSrc`), not inline in the project object, so the number has one name.
2. **`testTimeout: INTEGRATION_TEST_TIMEOUT_MS` is set on the `integration` project only.** The
   `unit` project keeps Vitest's 5 000 ms default: no unit case touches Mongo, and a 5 s budget
   there is a real guard against a runaway pure unit.
3. **Nothing else moves.** No case, `it(` body, hook, seed, fixture, helper, factory or production
   file is edited; no case is skipped or marked `.only`; no matcher is loosened. The delivered diff
   is this record, its `docs/adr/README.md` row/cell/note, and the config file — the case count is
   **1452** before and **1452** after.
4. **`hookTimeout` is left at its default (10 000 ms).** The measured reds are all inside timed
   cases, not hooks, and every DB-backed `beforeAll` already passes an explicit
   `MONGO_READY_HOOK_TIMEOUT_MS` (35 000 ms) budget (ADR-0037 §Amendment). Raising an unmeasured
   budget would be the guess this card forbids; if a hook red is ever observed, it gets its own
   measurement.
5. **Concurrency is left alone** (see §Alternatives 1).

### Sizing

30 000 ms is **15.7x p99** (1 905 ms) and **7.6x** the slowest case that passed (3 953 ms), on a
censored sample whose true maximum is larger. It is not a new number in this harness: it is the
exact budget the two specs that already pin their own ceiling use
(`INTEGRATION_TEST_TIMEOUT_MS = 30_000` in `notification-seed.test.ts` and
`identity-hooks.test.ts`, both from ADR-0037), so the harness now has **one** integration budget
instead of "30 s in two files, 5 s everywhere else". A case that doubles from 200 ms to 400 ms
passes under either budget, so this value was never the performance gate; it is a ceiling for
contention.

## Evidence

**The budget is load-bearing and project-scoped** — a throwaway probe (`7 000 ms` body, no
per-case timeout argument, never committed, deleted before the commit), run twice at the delivered
config:

- under the project budget: `1 passed (1)` (8.72 s total);
- under an explicit `--testTimeout=5000` override: `1 failed (1)` — `Test timed out in 5000ms`.
  So a 7 s case is inside the shipped `integration` budget and outside the old default, and the
  raise is the only reason the first run passed.

**The flake is removed, not retried** — see §Verification below: five consecutive full `integration`
runs at the delivered tree, each `139 files passed (139)` / `1452 passed (1452)`, no retry configured
anywhere in the harness (`retry` is absent from `vitest.config.ts`, and no spec sets it).

## Verification

Five consecutive full `integration` runs at `0243a4eb` — the config commit this record describes;
the commit carrying this record adds markdown only — with `TMPDIR=/root/tmp-mongo` and
`vitest run --project integration`, same head, nothing changed between runs:

- run 1 `139 files passed (139)` / `1452 passed (1452)`, 275.90 s
- run 2 `139 files passed (139)` / `1452 passed (1452)`, 243.64 s
- run 3 `139 files passed (139)` / `1452 passed (1452)`, 241.31 s
- run 4 `139 files passed (139)` / `1452 passed (1452)`, 238.12 s
- run 5 `139 files passed (139)` / `1452 passed (1452)`, 232.59 s

Zero `Test timed out` lines in any of the five logs, which are attached to card `t_e9340c72`.
Five is the floor the card sets, because a single green run already happened by luck on the flaky
tree.

Gates at the same tree: `prettier --check .` clean, `tsc -p tsconfig.json --noEmit`,
`tsc -p packages/contracts/tsconfig.json --noEmit` and `tsc -p apps/web/tsconfig.json --noEmit` all
exit `0`, `eslint .` exit `0`, the six `adr-*` guards `6 passed (6)` files / `236 passed (236)`,
and the full `unit` project `184 passed (184)` files / `3077 passed | 3 skipped (3080)`.

## Consequences

- An unrelated change can no longer red a PR on a 5 s budget: the observed contention tail
  (1.26x the 5 s default at its **surviving** maximum) now has 7.6x headroom, and a reviewer no
  longer needs a second full run to call a red noise.
- A genuine hang in an integration case now takes 30 s to fail instead of 5 s. That is the
  intended trade: the class this card fixes produces **false** reds at 5 s far more often than it
  produces true ones, and a true hang still fails loudly with the same message.
- A case that becomes pathologically slow (>30 s) still reds. The budget is not an escape from a
  seed or routing regression, which fail on their own assertions long before the ceiling.
- The 5 s budget remains in force for the `unit` project, where it is a real guard.
- The false-assertion shape R1 recorded (`expected [] to have a length of 1`, caused by a
  timed-out case's in-flight work) disappears with the timeout class that produced it; if it
  reappears on a green suite it is a genuine defect and reads as one.

## Alternatives

1. **Cap the `integration` concurrency (`maxWorkers` 3 → 2, or `poolOptions`).** Rejected: it
   lengthens every run by roughly a third (139 files, suite already 84 % test time) and does not
   bound a **single** case's latency — the tail we measured is one worker's Mongo round-trip under
   CPU contention, and two workers still contend. A timeout is the direct instrument for a
   per-case latency budget; concurrency is an indirect one that also costs everyone's CI minutes.
2. **Raise `testTimeout` for both projects (or via `--testTimeout` in the scripts).** Rejected:
   ADR-0037 §Alternatives already rejected the global scope, and it would weaken the `unit`
   project's guard for no measured reason (no unit red of this class exists). A CLI flag in
   `package.json` would also hide the number from the config the harness is read from.
3. **Per-file or per-case budgets on the offending specs.** Rejected: the red set rotates across
   at least five disjoint sets (ADR-0838, both card sets, and this card's two runs), so a per-file
   list would be a list of today's victims, stale the moment the scheduler picks differently. The
   project scope is the smallest scope that covers the class.
4. **`retry: 1`.** Rejected (ADR-0037 §Alternatives): a retry hides the first-attempt failure and
   lets a genuine intermittent defect through, and it would double the cost of every red.
5. **Speed the slow specs up (fewer sequential awaits, shared setup).** Rejected for this card: it
   means editing `it(` bodies and shared setup, which the card scopes out unless a case provably
   does avoidable serial work. The measured p99 is 1.9 s and 1 337 of 1 450 cases finish under
   500 ms — the suite is not doing avoidable serial work, it is being scheduled against 3 workers
   on 4 vCPUs.
6. **Fix the harness's cold-connect cost instead.** Already done — ADR-0037's readiness probe and
   per-worker `waitForMongoReady` keep connection setup in hooks. The remaining tail is steady-state
   contention, which is what a per-test ceiling is for.
