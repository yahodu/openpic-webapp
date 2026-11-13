# ADR-0821 — OP-132 TEST: a burst of four simultaneous confirms answers `200` four times

- **Status:** Accepted (RED pin by design; no production change)
- **Consumers:**
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts` (the F3.5
  describe "when the same selfie is confirmed by a burst of four requests", its
  `BURST_CONFIRMS`/`BURST_ROUNDS` constants, and the file-level
  `confirmRaceGate` latch + `vi.mock` of `@/server/db/transaction` it reuses).
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool. Before minting, **both `Next free` cells read `0818`**, and the sweep
  found `0818`, `0819` and `0820` already in flight:
  `ADR-0818-op134-claim-endpoint-arms-pins.md` on
  `OP-134-task-claim-endpoint-arms-pins` (PR #573),
  `ADR-0819-op134-my-events-gallery-url-pin.md` on
  `OP-134-task-my-events-gallery-url-pin` (PR #574) and
  `ADR-0820-op132-confirm-transaction-failure-pin.md` on
  `OP-132-task-confirm-tx-failure-pin` (PR #575). The sweep covered every open PR
  head (`gh pr list --state open`), every `.worktrees/*/docs/adr`, and — because
  930 refs make a per-ref `ls-tree` loop noisy — `git rev-list --objects --all --
docs/adr`, which reaches every object of every ref and returned `0820` as the
  highest number anywhere. Nothing carries `0821`, so this record draws
  **`0821`** and both cells advance to `0822`. No lane row is minted.
- **Amends:** the "known limit" of
  [ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) §Consequences ("leans on
  `DEFAULT_TRANSACTION_MAX_ATTEMPTS` … one retry of headroom for the pinned pair,
  no burst measured") and the "not pinned here" clause of
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) §Consequences ("a
  storm of `N > 2`"). Neither record is edited; the pin is added beside them, and
  the pair case they own is untouched.
- **Consumes:** `0821`.

## Context

[ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) moved the confirmation's
dedupe read **inside** `withTransaction`. The loser of a **pair** now reads the
winner's committed outbox row on its first retry, answers `200` and emits
nothing — measured `5 passed (5)` on the merged trunk (`origin/main` `553a92f`,
squash `a49599c`), with the loser logging `db.transaction.retry` attempt 2.

That repair's headroom is exactly one retry. `DEFAULT_TRANSACTION_MAX_ATTEMPTS =
3` (`apps/web/src/server/db/transaction.ts:26`) means three attempts in total, so
a racer that loses a **four-way** contention needs its first retry to see the
winner's commit; if it does not, the third attempt spends itself on the same
collision, and the handler answers `500 internal_error` /
`TransactionRetryLimitError` at
`apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts:124`
— after the selfie did activate. That is the F3 defect class ADR-0816 closed for
the pair, at a width the retry budget does not cover.

The card (Medium, follow-up to `t_6e62ee84`) asks for the burst to be **measured
and pinned**: four `POST …/selfies/{selfieId}/confirm` for one selfie, fired at
the same instant through the latch case 5 already owns, all four answering `200`.

## Decision

1. **One new describe in the existing file, not a new file.** The burst needs the
   same fixture chain (`readyEvent` → `submitOne` → `runWorker`), the same readers
   (`profileRow`, `matchesNewRows`) and — decisively — the same file-local
   `confirmRaceGate` and `vi.mock` of `@/server/db/transaction`. Moving the case
   to a new file would duplicate the latch, and a second copy of a latch is a
   second thing to keep honest. The latch and its mock are **unchanged**; the
   only new machinery is two constants (`BURST_CONFIRMS = 4`, `BURST_ROUNDS`).
2. **The burst is four requests, each with its own `Idempotency-Key`.** The
   `confirmSelfie` helper mints a fresh one per call, so the idempotency-key store
   cannot answer any of the four: the guarantee has to come from the state the
   winner wrote.
3. **The assertion is the client-visible contract and nothing else.** Sorted (so
   the pin is order-independent) the four statuses are `[200, 200, 200, 200]`;
   the four bodies carry the seven §6.3 keys, name the submitted `selfieId`, hold
   `status: "ready"` and are deep-equal to one another; exactly **one**
   `attendee.matches.new` row exists carrying `payload.count = 3`; the profile's
   cached §6.4 `matchCount` is `3`. No assertion reads the latch, the retry log or
   the transaction.
4. **The round is repeated, because one round is not a pin on this tree.** The
   card's premise — that four simultaneous confirms answer `[200,200,200,500]`
   deterministically — did **not** reproduce here, and the deviation is measured,
   not argued (§Evidence). A single round answered all four `200` in **6 of 15**
   focused runs, and forty further round-samples put the one-round red rate at
   **~48 %**: a one-round case would report the defect as fixed on roughly every
   other run. The same assertion is therefore run over **ten** fresh rounds
   (`it.each(BURST_ROUNDS)`, a fresh database per round via the file's existing
   `beforeEach`), which is this repository's rule for race pins
   ([ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) §Decision 1 and
   the `concurrency-barrier-pins` reference: run a race pin N times with a fresh
   database, and record the failure count). At the measured per-round rate, ten
   rounds leave a ~1-in-600 chance that a whole-file run passes on the defect;
   an implementation that really answers four `200`s does so in every round, so
   the repetition cannot make a correct fix red.
5. **The mechanism is not named.** A per-profile serialiser in front of the
   transaction, an emit that upserts instead of colliding, or a wider attempt
   budget all satisfy the case. The card asks for the observable.

## Evidence — measured on the cut (`origin/main` `553a92f`)

- **The card's single-round shape is a coin flip.** Fifteen focused runs
  (`-t "burst of four"`) of the one-round case, same tree, same latch:

  ```
  [200,200,200,200]  × 6
  [200,200,200,500]  × 6
  [200,200,500,500]  × 3
  ```

  A temporary trace inside the latch recorded `PROBE-GATE-RELEASE 4 4` in every
  one of those runs and never an expiry, so the width is real: all four racers
  were parked at the transaction boundary and released together. The variance is
  the loser's first retry racing the winner's **commit**, not a degraded latch.
  The trace was removed before the commit (`git diff` carries no `console`).

- **With the ten rounds, the file is red on every run, and the message names the
  answers.** Four consecutive whole-file runs:

  ```
  Tests  4 failed | 11 passed (15)
  Tests  3 failed | 12 passed (15)
  Tests  4 failed | 11 passed (15)
  Tests  8 failed | 7 passed (15)
  ```

  That is **19 of 40 round-samples** red (~48 %), consistent with the focused
  single-round campaign above and the basis for the ten-round width: at ~48 %
  per round, a file run passes on the defect with probability ≈ 0.52¹⁰ ≈ 1.6 ×
  10⁻³. Every failure is the new case, with the card's text:

  ```
  AssertionError: the four simultaneous confirms answered [200,200,200,500]; all four must be 200:
    expected [ 200, 200, 200, 500 ] to deeply equal [ 200, 200, 200, 200 ]
  ```

  and each run logged the losing racer's refusal: `"status":500`,
  `"message":"transaction retry limit reached after 3 attempts"`,
  `"name":"TransactionRetryLimitError"` at `confirm/route.ts:124`. One run's retry
  sink counted sixteen `db.transaction.retry` attempt-2 lines and seven
  attempt-3 lines — the budget being spent, observed rather than inferred.

- **The five shipped cases are untouched and stay green.** The diff is additive
  (`125 insertions(+)`, zero deletions); in all four runs the repeat, the
  new-count, both late-publication and the pair case passed (`7 passed` in the
  heaviest run = 5 shipped + 2 clean burst rounds).
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` and
  `prettier --check` clean on the spec, the record and the ledger; the five ADR
  guards are `5 files / 218 passed`.
- Whole-file runtime stayed at ~7 s (`7.25`, `6.94`, `7.10`, `6.67`), so the ten
  rounds cost no measurable suite time.

## Consequences

- **A burst of four simultaneous confirms is now measured and pinned.** The
  contract it pins is the one §6.3 already promises every confirm: the seven-key
  `200`. An attendee with several open tabs, or a client that retries twice on
  timeout, no longer reads a failure after their selfie activated — once the
  GREEN lands.
- **Known limit — the pin is ~99.8 % red on the current tree, not 100 %.** The
  residual is the same commit-visibility race that makes a single round a coin
  flip: per round the current tree answers four `200`s by luck about half the
  time (19 of 40 measured round-samples red). Ten rounds reduce that to ~1 file
  run in 600. The pin is 100 % green on an implementation that serialises or that
  upserts, so the residual is on the bug, not on a correct fix.
- **Known limit — the burst is pinned at four and through the confirm's own
  transaction seam.** `N > 4`, and a future refactor that stops routing the
  confirm through `@/server/db/transaction`, are outside this record; a
  refactor of the seam leaves the latch unarmed and the case degrades to plain
  `Promise.all` (which was measured capable of passing on a defective tree, so
  that refactor owes this pin a new latch).
- **Known limit — a serialising GREEN pays the grace once per round.** Each busy
  round costs up to `CONFIRM_RACE_GRACE_MS` (250 ms); five rounds cost at most
  ~1.25 s of a voluntary wait, which is the price of not prescribing a mechanism.
- **The record is RED by design.** The GREEN card is `t_e0b862be`; it must carry
  this spec **unchanged** — assertions, the five rounds and the latch included —
  and the PR is a **draft** that must never be merged on its own: a squash would
  put a red `unit_test`/`ci` on the trunk.

## Alternatives

- **One round (the card's literal shape).** Rejected by measurement: 6 of 15 runs
  answered `[200,200,200,200]` on the defective tree — the precise failure mode
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) §Decision 1
  already rejected once for the pair.
- **Widen the burst instead of repeating it (six, eight, ten racers).** Rejected:
  the card fixes the width at four, and width does not buy determinism — the
  outcome stays a commit-visibility race per loser (the same measurement produced
  `[200,200,500,500]` at four). Repetition over fresh state is the method this
  repository's race pins already use.
- **Delay each transaction's commit from the test (`withTransaction` mocked to
  sleep after its callback).** Rejected: it would force every loser to exhaust
  its budget, which forbids a legitimate repair — a wider attempt budget — and
  thereby prescribes the serialiser. The pin must not pick the fix.
- **Assert on the retry sink (`db.transaction.retry` lines).** Rejected for the
  same reason as in
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) §Alternatives: a
  fix that serialises logs **zero** retries and would be red for being better.
- **Answer the unlucky racer a `4xx` (e.g. `409 already confirmed`).** Rejected:
  §6.3 promises the same seven-key `200` to a second confirm, and the shipped
  repeat-confirm case pins exactly that.

## Out of scope

- The GREEN's mechanism, its evidence and any change to `confirm/route.ts` (card
  `t_e0b862be`).
- Why `DEFAULT_TRANSACTION_MAX_ATTEMPTS` is 3, and whether the confirm (or the
  helper) should carry a per-route budget. This pin measures the consequence; the
  budget's value is the GREEN's decision, and if it changes, the attempt-cap pins
  owned by the F2 lane are the records to revisit.
- The confirm route's missing §0.11 limiter (ADR-0816 §Out of scope), the
  duplicate-key path itself (case 5 / ADR-0816) and the failing-transaction arm
  (case 6 / ADR-0820). This record adds one case and edits none of them.
