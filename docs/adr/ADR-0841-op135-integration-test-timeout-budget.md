# ADR-0841 — TEST-INFRA: the `integration` project runs on a measured 30 000 ms per-test budget

- **Status:** Accepted · **Date:** 2026-11-17 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_e9340c72` (OP-135 TEST-INFRA, Medium) · **Branch:**
  `OP-135-task-integration-timeout-budget-rebased` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_e9340c72` · **Base:** `e780e0a5` (#648, docs-only;
  the record was first written against `62874617`, and the ruleset's strict up-to-date check forced
  the rebase before merge)
- **Lane:** the OP-135 worker interface lane block `0829`–`0848` (row `OP-135 worker interface
lane`), whose `Next free` cell read **`0841`** at this base. There is **no `test-infra` lane row**
  in `docs/adr/README.md` (the ledger's thirty-two rows carry no such holder), so this record draws
  the number from the owning ticket's own cell rather than inventing a lane or a derived number:
  the sweep before minting found no `ADR-0841*` file in any of the
  `.worktrees/*/docs/adr` trees (their maxima ranged `0834`–`0859`), `git rev-list --objects --all
-- docs/adr` returning **`0859`** as the highest number on any object, and none of the open PR
  heads (`#645`, `#644`, `#631`, `#613` and their siblings) carrying `0841`. So this record takes
  **`0841`** and advances **only** the `OP-135 worker interface lane` cell to `0842`; the OP-136
  cell stays `0860`, the `OP-129 attendee identity lane` cell and the two `unallocated (future
lanes)` cells stay `0869`, and no range is re-cut.
- **Consumers:** `vitest.config.ts` (the `integration` project's `testTimeout` and, since
  §Amendment, its `hookTimeout` — the only file this record governs). The guard sweeps `apps/` and
  `packages/`, so this root-level config file is outside the citation population — the field is
  declarative here, exactly as the record states.
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

Measured on this card at `cbab1f0f` (the tree the card was dispatched at, worktree
`t_e9340c72`, `TMPDIR=/root/tmp-mongo`, `vitest run --project integration`, 139 files / **1452** cases):

- Run R1 — `4 failed | 1448 passed (1452)`, 245.73 s. Reds: `domain-events` I2 (timeout),
  `domain-events` I3 "two concurrent claimers" (timeout), `domain-events` "claim completion"
  (`AssertionError: expected [] to have a length of 1`) and `my-events` I3 (timeout).
- Run R2 (JSON reporter) — `2 failed | 1450 passed (1452)`, 231.08 s. Reds: `branding-upload` I1
  (5 024 ms) and `notification-digest-flush-daily-cap-redelivery` F1c-r2 (5 007 ms).
- The four red specs alone: green (`4 files passed (4)` per the parent card's focused runs; this
  card's two runs share no red case with either set the card names, nor with ADR-0838's set — a
  fifth disjoint set on the same class).

Re-measured at the **delivered base `e780e0a5`** — the head this record ships on, two further full
runs with the same command, nothing changed between them, logs `red2-1.log` / `red2-2.log`:

- Run E1 — `3 failed | 1452 passed (1455)` in `139` files, 229.76 s: `branding-upload` I7
  (timeout), the case _after_ it (`AssertionError: expected 1 to be +0`, the in-flight shape below)
  and `me-current-user` I1 (timeout).
- Run E2 — `4 failed | 1451 passed (1455)` in `139` files, 248.33 s: `plans-seed` I2 (timeout),
  `notification-digest-flush-claim-lease` (timeout) and `selfie-upload-collision` (timeout), plus
  `selfie-confirm-publication` round 8 with
  `the four simultaneous confirms answered [200,200,200,500]` — the retry-budget class of
  `t_41f06cb7`, not a timeout.

That is a **sixth** disjoint set, red on two runs of two at the shipped base, and the `1455` count
it prints is the same `1455` the fixed tree reports: the delivered change adds and removes no case.

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

The card's `1448` case count was measured at `6711993e`; the tree the measurement above was
taken on (`cbab1f0f`) reads **1452**, and the rebase base (`62874617`, after #644 added the
three batch-arm cases of ADR-0859) reads **1455**. This record counts the tree it measures rather
than deriving a delta, and the delivered change leaves that number identical — `1455` before and
`1455` after.

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
   **1455** before and **1455** after at the delivered base (the red measurement above was taken on
   `cbab1f0f`, which reads `1452`; the base moved through #644's three cases, and the delivered diff
   contains no test file at all).
4. **`hookTimeout` gets the same 30 000 ms ceiling, on the `integration` project only**
   (`INTEGRATION_HOOK_TIMEOUT_MS`, amendment below). It was **left at Vitest's 10 000 ms default**
   when this record first landed, on the ground that every measured red was inside a timed case
   rather than a hook, and every DB-backed `beforeAll` already passes an explicit
   `MONGO_READY_HOOK_TIMEOUT_MS` (35 000 ms) budget (ADR-0037 §Amendment), with the reservation that
   _"if a hook red is ever observed, it gets its own measurement."_ A hook red has since been
   observed, so §Amendment — the hook clock records the measurement and raises the hook timer to the
   case timer. Hooks that pass an explicit budget keep their own value; the `unit` project keeps the
   10 000 ms default.
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
runs at the delivered tree, each `139 files passed (139)` / `1455 passed (1455)`, no retry configured
anywhere in the harness (`retry` is absent from `vitest.config.ts`, and no spec sets it).

## Verification

Five consecutive full `integration` runs at `aa0f6356` — the config commit this record describes,
rebased onto `e780e0a5`; the commit carrying this record adds markdown only — with
`TMPDIR=/root/tmp-mongo` and `vitest run --project integration`, same head, nothing changed between
runs:

- run 1 `139 files passed (139)` / `1455 passed (1455)`, 223.52 s
- run 2 `139 files passed (139)` / `1455 passed (1455)`, 219.86 s
- run 3 `139 files passed (139)` / `1455 passed (1455)`, 231.80 s
- run 4 `139 files passed (139)` / `1455 passed (1455)`, 229.75 s
- run 5 `139 files passed (139)` / `1455 passed (1455)`, 224.58 s

Zero `Test timed out` lines in **all sixteen** post-fix full runs recorded for this card: the five
above at `aa0f6356`, six at `8f731fdb` (the same config content before the ruleset's strict check
forced the rebase onto #648) and five on the pre-rebase tree `0243a4eb`. Five consecutive at the
delivered head is the floor the card sets, because a single green run already happened by luck on
the flaky tree.

**One run of the `8f731fdb` set red a _different_ class, and that is recorded rather than hidden.**
It failed `selfie-confirm-publication.test.ts` round 8 with
`the four simultaneous confirms answered [200,200,200,500]`, logged as
`TransactionRetryLimitError: transaction retry limit reached after 5 attempts` — a production
retry-budget limit under host load, not a timeout (that run also contains zero `Test timed out`
lines). The pin is correct and untouched; the finding is routed to card `t_41f06cb7` for the backend
lane (the route's attempt budget vs a documented four-wide burst, ADR-0816 / ADR-0821). The same
class also appears in run E2 of the delivered base above. The `aa0f6356` set is a clean five of five,
with no such red.

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

## Amendment note — the hook clock (t_c053a028)

§Decision 4 left `hookTimeout` on Vitest's 10 000 ms default, because no hook red had been measured,
and promised that a hook red would get "its own measurement". One has now been observed, so this note
records the observation, the measurement it forced, and the amendment. **The case-timer decision above
is unchanged** — this record now bounds the hook timer with the same ceiling.

### The observed hook red

The review of this record's card ran two full runs of the identical tree (2026-11-18, detached
worktree at trunk `88d65749`, `TMPDIR=/root/tmp-mongo`, `vitest run --project integration`):

- run 1 — `1 failed | 1479 passed (1480)`, 141 files, 365.20 s, **zero** `Test timed out` and **one**
  `Error: Hook timed out in 10000ms` at `uploads-batch-status.test.ts:279`, which is that file's
  `beforeEach` (a 21-collection `deleteMany` sweep). Card `t_c053a028` carries the block verbatim; the
  file's `beforeAll` is not the hook that reddened, and it passes `MONGO_READY_HOOK_TIMEOUT_MS`.
- run 2 — `141 files passed (141)` / `1480 passed (1480)`, 262.57 s, zero timeout lines of either kind.
- `uploads-batch-status.test.ts` alone — `10 passed (10)` in 7.56 s.

That is the signature §Context records for case timeouts — red on one run, green on the next full run
of the same tree, green in isolation — on the other timer. **Rate at 10 000 ms: one hook red in two
full runs on this host**, against zero case timeouts in both.

### The measurement

Taken on card `t_c053a028` at `4d13bebb` (this branch rebased onto the trunk; 145 files / **1 530**
cases — the card's figures are at `88d65749` and the count moved with the trunk, so every figure below
is stated at the tree it was taken on), `TMPDIR=/root/tmp-mongo`,
`vitest run --project integration`:

- **The sweep is milliseconds, not seconds.** A throwaway probe timed the `uploads-batch-status.test.ts`
  `beforeEach` body in-hook across its ten cases: `15.2`, `23.4`, `28.0`, `29.7`, `30.6`, `35.9`,
  `36.9`, `37.6`, `40.5`, `41.6` ms (median 33.2 ms). The probe was reverted before the config
  commit, so the diff carries no test file.
- **A full run never needs more than 1 000 ms for any hook.** A full run with a throwaway
  `hookTimeout: 1_000` on the `integration` project was green — `145 files passed (145)` /
  `1530 passed (1530)`, 225.61 s, zero `Hook timed out` lines. A second full run with a throwaway
  `hookTimeout: 3_000` was green as well — `145 files passed (145)` / `1530 passed (1530)`, 225.11 s —
  and a third at the unchanged 10 000 ms default was green, `145 files passed (145)` /
  `1530 passed (1530)`, 229.79 s. Both throwaway configs were reverted before the commit.
- **The violation is a stall, not hook work.** A hook whose body is 15–42 ms cannot "gradually" reach
  10 000 ms; the red run spent 365.20 s on work the green run finished in 262.57 s, which is the
  descheduled-worker contention §Context measured for cases (3 fork workers over one
  `MongoMemoryReplSet`, suite 84 % CPU-bound). The 10 000 ms violation is therefore a **censored**
  measurement: it proves the tail crosses 10 s, not by how much.

### The amendment

`vitest.config.ts` gains `INTEGRATION_HOOK_TIMEOUT_MS = 30_000` beside `INTEGRATION_TEST_TIMEOUT_MS`,
and the `integration` project sets `hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS`. The `unit` project
keeps the 10 000 ms default, exactly as it keeps the 5 000 ms case default. Nothing else moves: no
test file, no case, no `it(` body, no hook body, no matcher, no retry, no skip. A hook that passes an
explicit budget keeps its own value — the DB `beforeAll`s at `MONGO_READY_HOOK_TIMEOUT_MS`
(35 000 ms) and `notification-seed.test.ts`'s `vi.setConfig` are unaffected — so the new value is the
default for the hooks that carry none, which are exactly the per-case collection sweeps and the
`afterAll` cleanups around them.

**Why the number is 30 000 ms.** The measurement above says the hook timer faces what the case timer
faces: a normally-millisecond hook that a stall can push past its clock, with the excess unbounded by
measurement. The case timer's contention ceiling, from §Sizing, is 30 000 ms, and a case and the sweep
hooks that bracket it are descheduled by the same host; two clocks that disagree about how long a
stall may last would only move the false red from the case to the hook, which is exactly what was
observed. 30 000 ms is also inside the 35 000 ms `MONGO_READY_HOOK_TIMEOUT_MS` the DB hooks already
use, so the harness gains **one** ceiling per direction rather than a new number of its own. The
`INTEGRATION_HOOK_TIMEOUT_MS` name exists even though the value equals the case budget, so the two
timers can move independently if a later measurement separates them, and so a reader of the config
sees which timer a change affects.

**The budget is load-bearing, and the raise is the only reason a slow hook passes.** A throwaway
probe (`4 000 ms` hook body, no per-hook timeout argument, never committed, deleted before the
commit) ran at two configs:

- at the delivered config — `1 passed (1)`;
- with a throwaway `hookTimeout: 3_000` — `1 failed (1)`, `Error: Hook timed out in 3000ms`.

**Verification.** Five consecutive full `integration` runs at the delivered tree (the config commit
`2277d50f`, rebased onto the trunk `750c0398`; it has since been replayed unchanged as `9c4bc8c7` onto
`14186080`, whose only new commit is a docs sign-off, and the commit carrying this record adds markdown
only — the shape ADR-0037's first amendment used), same head, nothing changed between runs,
`TMPDIR=/root/tmp-mongo`:

- run 1 — `145 files passed (145)` / `1532 passed (1532)`, 242.55 s
- run 2 — `145 files passed (145)` / `1532 passed (1532)`, 237.89 s
- run 3 — `145 files passed (145)` / `1532 passed (1532)`, 252.59 s
- run 4 — `145 files passed (145)` / `1532 passed (1532)`, 222.81 s
- run 5 — `145 files passed (145)` / `1532 passed (1532)`, 224.43 s

Zero `Hook timed out` lines and zero `Test timed out` lines in all five. Trunk moved twice while the
card was in flight (`#725`, then the OP-132 confirm fix `f7246b9d` and its release chore `750c0398`), so
the set above was run at the rebased head; the two earlier delivered trees recorded the same result —
five runs at `4d13bebb`'s successor read `145` files / `1 530` cases each (243.88, 287.73, 313.93,
223.46 and 227.64 s) and five at `2b9b1613` read `145` files / `1 532` cases each (234.35, 239.94,
241.23, 237.60 and 244.43 s), all with zero timeout lines of either kind. The case count is therefore
unchanged by the amendment at every base it was measured on: this branch's diff is
`vitest.config.ts` (+26/−0) and this record only, so a tree's case count is its trunk's. Those sets
also carry the load evidence — the slowest runs are 313.93 s and 252.59 s against the 262.57 s baseline
the case budget was sized on, and every one of them is green.

Gates at the same tree: `prettier --check .` clean, `tsc -p tsconfig.json --noEmit`,
`tsc -p packages/contracts/tsconfig.json --noEmit` and `tsc -p apps/web/tsconfig.json --noEmit` exit
`0`, `eslint .` exit `0`, and the six `adr-*` guards green.

### Alternatives rejected for the hook timer

1. **Pass `MONGO_READY_HOOK_TIMEOUT_MS` (35 000 ms) to the sweep hooks.** Rejected: it edits the ~38
   integration specs that carry the loop-shaped sweep to change a default, and the measured red set
   rotates — a per-file list is a list of today's victims, which is the argument §Alternatives 3
   already makes for cases. The project scope is the smallest scope that covers the class, and the
   delivered diff is one config file plus this record.
2. **`Promise.all` over the collection list in each sweep.** Measured and rejected: the whole sweep
   body is 15–42 ms, so parallelising it removes milliseconds from a hook whose cost is not the
   problem, and a descheduled worker stalls whether its round trips are sequential or concurrent. It
   would also edit the same ~38 test files for no measured gain.
3. **`retry`.** Still rejected (§Alternatives 4): a retry would hide the hook's first attempt and let
   a genuine intermittent defect through.
4. **Raising the hook timer only on the specs that reddened.** Rejected: the reddened spec is not
   special — its sweep is the same shape as the other 37, and it was green in isolation and on the
   next full run of the same tree.

## Review sign-off (round 1, artifact + execution lens) — APPROVED WITH FINDINGS

Reviewed head `f98e83db` (PR #654, already squash-merged as `78b70894` when this section was
written). This section consumes **no** ADR number, adds no index row, and leaves
`docs/adr/README.md` byte-identical — `sha256 1473e9b1245791fb55ef145473366b34f5b15924c37f8303daf7091af879f717`
at the base of this append and after it. It appends; nothing above is retracted.

### Delivery state

- PR #654 is `MERGED` (2026-11-17T15:41:57Z), squash `78b70894`, and `git merge-base --is-ancestor 78b70894 origin/main` → true.
- `git diff f98e83db 78b70894 -- vitest.config.ts docs/adr/ADR-0841-…md docs/adr/README.md` →
  **empty**: the reviewed bytes are the shipped bytes. Blob identity says the same — `vitest.config.ts`
  is `487f95a6…` at `f98e83db`, at `78b70894` **and** at `88d65749`, and this record is `3e2a75ee…`
  at all three. Squash numstat: `vitest.config.ts` +18/−0, this record +222/−0,
  `docs/adr/README.md` +41/−1. **No test file in the diff.**
- Three files differ between those two commits, and all three are trunk-owned commits that landed
  **before** the merge: `.husky/pre-commit` (`b71e942c`, #652) and two OP-136 sign-off records,
  `ADR-0850` (`34183b90`, #649) and `ADR-0852` (`20fcf119`, #651). The card said "an OP-136 ADR";
  the measured count is two.
- `main` CI on the squash is `success` — run `44117313347`, `push` event, head `78b70894`.
- At the trunk this append lands on (`7cc764c3`) the two blobs read `3065b890…`
  (`vitest.config.ts`) and `8688e74b…` (this record): §Decision 4's amendment landed after the
  merge, as card `t_c053a028` did. The reviewed bytes are unchanged by that; the file simply grew.

### Refactor log

**None.** The deliverable was already merged, so the reviewed SHA is frozen and no implementation
file may change. The round-1 review edited nothing in it; its writes were to a throwaway worktree
(removed afterwards) and to the reviewer's own scratch directory.

### Acceptance evidence, re-measured

Runs in a detached worktree at `88d65749` (the merged trunk of that window), `TMPDIR=/root/tmp-mongo`,
`vitest run --project integration`:

| Check                                  | Result                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| full run 1                             | `1 failed \| 1479 passed (1480)` in 141 files, 365.20 s — **zero** `Test timed out`, one `Error: Hook timed out in 10000ms.`                                                                           |
| full run 2                             | `141 files passed (141)` / `1480 passed (1480)`, 262.57 s, zero timeout lines of either kind                                                                                                           |
| the run-1 red, alone                   | `uploads-batch-status.test.ts` — `10 passed (10)`, 7.56 s                                                                                                                                              |
| the five delivered green logs, re-read | five × `139 files passed (139)` / `1455 passed (1455)`, zero `Test timed out`                                                                                                                          |
| gates at the merged tree               | `prettier --check` clean on the three changed files, `eslint vitest.config.ts` exit `0`, six `adr-*` guards `6 passed (6)` / `236 passed (236)`, `main` CI on the squash `success` (run `44117313347`) |

The hook red sits at `uploads-batch-status.test.ts:279` — that file's `beforeEach`, a `deleteMany({})`
sweep over **21** collections run one after another. §Amendment carries the block verbatim, and the
file's `beforeAll` is not the hook that reddened.

**Measured again for this section**, at `88d65749` in a throwaway worktree (removed afterwards) and at
the trunk `7cc764c3`:

- the reddening spec alone — `10 passed (10)` in 7.19 s, a third observation of that tree, green;
- one further full `integration` run at `88d65749` — `141 files passed (141)` / `1480 passed (1480)`,
  229.82 s, **zero** `Test timed out` and **zero** `Hook timed out` lines. That makes three full runs
  of this tree: two timeout-free, one carrying the single hook red above — the rate this record
  states, neither better nor worse;
- the six `adr-*` guards at `7cc764c3` — `6 passed (6)` / `236 passed (236)`;
  `prettier --check "docs/adr/**/*.md"` clean; `0841` unique among `400` records in `docs/adr/`, no
  duplicate `ADR-NNNN` basename, and the `OP-135 worker interface lane` `Next free` cell reads `0847`.

### Findings

**F1 — Medium (test reliability), routed to `t_c053a028`.** The case timer is bounded; the hook timer
was not. Run 1 above red on `Error: Hook timed out in 10000ms.` while the same tree was green on run 2
and green in isolation, which is this record's own §Context signature on the other timer. It is the
**same class** as the case timeout this record addresses, and §Decision 4 had already promised that a
hook red would "get its own measurement" — so the class was **partially** open when this record
merged: cases covered, hooks not. Routed to `t_c053a028` (test author) with the measurement obligation
§Decision 4 names; this sign-off was chained behind that card.

**F2 — Info, recorded only.** The two runs are cited with different SHAs — `cbab1f0f` in §Context,
`be3a6905` in the ledger row. `git diff --name-only cbab1f0f be3a6905 -- apps packages vitest.config.ts`
is **empty**, and the only path that differs between them at all is `docs/adr/README.md`, so both
citations describe the identical test tree. No accuracy defect; recorded so a later reader does not
read the pair as a contradiction.

**F3 — Info, recorded only.** The card pinned `1448` cases as "the current trunk". The delivered base
read `1455` and the review's trunk revision `1480`. The delivered diff contains no test file, so
"unchanged before and after at the same tree" holds at every base it was measured on, and the
delivery counted the tree it actually measured — correct; the card's figure is a snapshot of an older
trunk.

**F4 — Low (delivery hygiene).** PR #654 had been merged **without** the mandatory review comment: the
earlier review run crashed before posting it. The round-1 comment was posted on the merged PR by this
review — `issuecomment-6980967612` (2026-11-18T14:08:19Z), read back after posting. No file change
follows from it.

The implementation itself is honest: no fixture-specific hardcoding, no test-environment conditional,
no `@ts-ignore` or lint suppression, no new dependency, no test file and no skipped or `.only`-ed case
in the diff.

### Post-review status

Written after the fact, so the list above is a record and not a set of live defects.

- **F1 is closed on the trunk.** `t_c053a028` landed as PR #728, squash `da6ed432`: `vitest.config.ts`
  gains `INTEGRATION_HOOK_TIMEOUT_MS = 30_000` on the `integration` project only, and §Decision 4 was
  extended in place by that card's §Amendment, which carries the measurement (five consecutive full
  runs at `145` files / `1532` cases, zero hook and zero case timeouts) and its own 4 000 ms probe. This
  section therefore points at that amendment instead of restating it, and **no decision in §Decision is
  retracted**: §Decision 4's reservation is the clause that was honoured, not withdrawn.
- **F2 and F3 need no action** and stay as written; they are readings of the record, not defects.
- **F4 closed when the comment landed** on the merged PR; nothing outside this file changed for it.

No assertion was loosened, no case skipped or retried, and the change stayed project-scoped.
**APPROVED WITH FINDINGS.**
