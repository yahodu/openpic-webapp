# ADR-0878 — OP-132 TEST: the confirm's exhausted-budget arm pinned at all four outcome conditions

- **Status:** Accepted (characterization pins; green on arrival) · **Date:** 2026-11-19
- **Card:** OP-132 TEST `t_693d16f7` (Low; finding **F1** of the OP-132 GREEN review `t_41f06cb7`,
  PR [#688](https://github.com/yahodu/openpic-webapp/pull/688) / squash `f7246b9d`, which landed
  [ADR-0877](ADR-0877-op132-confirm-burst-settled-reread.md)). Branch
  `OP-132-task-confirm-exhausted-arm-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_693d16f7`, cut from the trunk `750c0398` (the release
  bot's commit after that squash).
- **Implements:** contract §6.3 / §6.4 (the confirm's seven-key envelope, `status` and the cached
  `matchCount`), §7.7 ("every notification originates from a `domainEvents` row", so the row count is
  the notification count), §10.3.2 (the delivery identity), §0.7 (an unhandled throw is `500
internal_error`, never a leaked internal); schema §15.3, §16.4.
- **Satisfies:** ADR-0877 §Consequences' recorded gap — the exhausted arm was shipped with no case
  reaching it, deferred "to the pin author, not this card".
- **Consumes:** ADR-0877 §Decision 1–3 (the narrow `isTransactionRetryLimitError` test, the
  `confirmOutcomeCommitted` predicate over all four conditions, the `500` when the wait expires) and
  §Evidence (the mutation table and the three probe controls: pointer-only, other-selfie, full
  outcome); [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) (the burst describe the new file sits
  beside, whose contract assertion and `confirmRaceGate` latch are untouched);
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) (the pair-wide race);
  [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) /
  [ADR-0808](ADR-0808-op132-late-match-publication-ownership.md)
  (the file docblock conventions this record follows); ADR-0667 / ADR-0669 (the shared
  `waitForCommitted` wait); ADR-0300 §11 item 18 (the pool draw below).
- **Consumers:** `apps/web/src/test/integration/selfie-confirm-exhausted-budget.test.ts` — the new
  spec, whose docblock names this record.
- **Number allocation:** `docs/adr` on the trunk `750c0398` ends at `0877`, both `Next free` cells
  read `0878` (the values ADR-0877 left), and the sweep immediately before minting found no
  `ADR-0878*` on the trunk, in any `.worktrees/*/docs/adr` tree, in
  `git rev-list --objects --all -- docs/adr` (highest `0877`) or on either open PR head (#726, #690).
  The block `0849`–`0868` is exhausted, so this is a **pool draw**: §11 item 18 advances **both**
  the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to `0879`, one above this
  record, so neither can re-mint it. The block keeps its range (§11 items 18–21) and the `OP-129
attendee identity lane` cell `0869` is left as found (item 19's exhausted-block encoding).

## Context

[ADR-0877](ADR-0877-op132-confirm-burst-settled-reread.md) gave `POST …/selfies/{selfieId}/confirm`
an exhausted-budget arm: when `withTransaction(…, { maxAttempts: 5 })` rejects with the wrapper's own
retry-limit signal, the route polls `waitForCommitted` (25 ms, 1 s ceiling) for the row to show the
activation pointer, the §6.4 cached total, the §15.3 status and — when it had something to announce —
its own §10.3.2 outbox row, then falls through to the ordinary `selfieEnvelope`; a wait that expires
rethrows the original error. It shipped with **no** case that reached the arm. The TDD pipeline's
burst pin only reds when the budget is **smaller** than the burst width, so at the delivered
`CONFIRM_MAX_ATTEMPTS = 5` a green run stops at `attempt: 4/5` and the `.catch` body never executes;
coverage at the reviewed head was `route.ts` **79.48 % statements / 63.63 % branch** and the uncovered
lines were exactly this arm (ADR-0877 §Consequences).

The review of that GREEN measured the arm by mutation in a throwaway worktree: forcing the budget to
`1` answers `[200,200,200,200]` for the four-wide burst, replacing the `.catch` with a plain rethrow
answers `[200,500,500,500]`, and breaking the predicate's `matchCount` term answers the same. The arm
is load-bearing and nothing shipped measured it.

A shipped spec **cannot** edit `CONFIRM_MAX_ATTEMPTS`, and a burst cannot be made to exhaust a budget
of five on demand: how deep a racer goes is a property of the host's commit timing, which is why the
burst pin itself repeats ten fresh rounds (ADR-0821 §Evidence). Reaching the arm therefore needs a
seam, and the seam must not weaken the constant or the sibling spec.

## Decision

**Pin the arm with one new integration spec, `selfie-confirm-exhausted-budget.test.ts`, whose seam is
the wrapper itself: on the armed call the route is handed the wrapper's own
`TransactionRetryLimitError`, produced by the real wrapper from a zero-attempt budget and thrown
before the callback runs, so the loser's transaction writes nothing — the state the production arm
exists to answer.**

1. **The seam.** The spec `vi.mock`s `@/server/db/transaction` (the same module boundary
   `selfie-confirm-publication.test.ts` already mocks for its gate, but **file-scoped**, so the
   sibling's latch, cases and block bodies are byte-identical and untouched). When armed, one call is
   diverted to `actual.withTransaction(() => Promise.resolve(undefined), { maxAttempts: 0 })`; the
   wrapper increments its attempt counter to `1 > 0` and throws its **own** private
   `TransactionRetryLimitError`, so `isTransactionRetryLimitError` is true for the genuine class and
   the production constant, the route, every fixture, helper and mock are unedited.
2. **One-shot, and provably fired.** The arm serves exactly one call and the spec asserts the request
   under test made exactly one wrapper call (`expectTheArmFired`), so a case can neither pass by
   missing the seam nor by leaving it armed for a later transaction. A case whose arm did not fire is
   a red case, not a silent pass on the ordinary path.
3. **Rival work at the lost boundary.** The arm optionally carries a callback that runs after the
   request has read its inputs and before the signal is raised, so a rival can commit while this
   request is spending its budget. That is the only way to reach a row that disagrees on `status`
   alone (see F1.7), and it is a real interleaving: the client confirm and a finishing worker are
   concurrent requests. The rival's own wrapper calls are excluded from the one-call guard.
4. **Seven cases, one behaviour each** — the settled answer, the wait-expired rethrow, and one refusal
   per condition of the predicate:

   | Case                          | Setup (real request or harness state)                                                                                                                                                                   | Asserted                                                                                                                 |
   | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | **F1.1** settled              | a rival request commits the whole outcome first; the loser is armed                                                                                                                                     | `200`, the §6.3 seven keys, the **same** body the rival answered, one `attendee.matches.new` row, cached total unchanged |
   | **F1.2** wait expired         | a publishable selfie, nothing committed, the loser armed                                                                                                                                                | `500 internal_error`, `activeSelfieId` still `null`, `matchCount` `0`, no outbox row — the arm is not a blanket `200`    |
   | **F1.3** pointer only         | the I9b confirm activated the row pre-worker; the late result landed; the notification never did                                                                                                        | `500`, row still `processing`/`0`, still no outbox row — ADR-0877's measured control                                     |
   | **F1.4** stale total          | both selfies submitted, the first committed (ready/3), the second's worker run adds two matches; only a confirm moves the cached total                                                                  | `500`, row still `ready`/`3`, one outbox row                                                                             |
   | **F1.5** other selfie         | the first selfie committed (ready/3), the newer selfie's worker run finds **zero** photos (its outcome is ready/3 with nothing to announce)                                                             | `500`, the first selfie still active, one outbox row                                                                     |
   | **F1.6** dropped announcement | the rival's commit is real, then its outbox row is removed — the state a lost notification leaves                                                                                                       | `500`, pointer/status/total all already true, no outbox row written by the refusal                                       |
   | **F1.7** stale status         | the loser reads the selfie before the worker writes the vector (its own outcome is `processing`/`0`); at the lost boundary a rival's worker run finishes with zero photos and a rival commits ready/`0` | `500`, row `ready`/`0` with this selfie active — only the status disagrees                                               |

   F1.1 through F1.5 need no timing: the rival work is finished before the armed request starts, so
   the loser's own pre-read computes the outcome the asserted condition turns on. F1.7 uses the
   boundary hook because a `ready` row with a `processing` outcome is reachable only across the
   worker's write. Each refusal spends the shared 1 s ceiling, so the file runs in ~13 s.

**The seam is a stub of the wrapper, not of the route**, and the assertion surface is the HTTP
response and the stored rows: status, the seven-key envelope, the profile row and the outbox count.
No case reads a private function, a call count of an internal collaborator, or a class name. The
negative control ADR-0877 §Consequences asks for is reproduced below: replacing the `.catch` with a
plain rethrow reds the settled case.

## Evidence

Green on arrival at the branch head (`7 passed (7)`; with `selfie-confirm-publication.test.ts` and
`liveness-selfie-submit.test.ts`, `3 files / 52 passed (52)`). Coverage of the confirm route by
**this spec alone**, measured with `--coverage.include` narrowed to that file:
`94.87 % statements / 90.9 % branch / 100 % functions`, uncovered lines `151` and `172` (the two
`not_found` arms for a malformed or foreign selfie id, which other specs own) — against the reviewed
head's `79.48 / 63.63`, whose uncovered lines were this arm.

Nine single-anchor mutations of `confirm/route.ts`, each applied alone in this worktree, restored
byte-identically with `git checkout --` (`git status --porcelain` then lists only the new spec):

| Probe  | Mutation                                                                                           | Result                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | the `.catch` always rethrows (`true \|\|` in place of `!isTransactionRetryLimitError(error) \|\|`) | `1 failed \| 6 passed (7)` — **F1.1** alone, `a confirm that spent its budget after a rival committed the same outcome answered 500; it must answer 200`                                                                   |
| **M2** | predicate `activation.matchCount === outcome.matchCount` → `+ 1`                                   | `1 failed \| 6 passed (7)` — **F1.1** alone, same message                                                                                                                                                                  |
| **M3** | the predicate made pointer-only (ADR-0877's rejected shape)                                        | `4 failed \| 3 passed (7)` — **F1.3, F1.4, F1.6, F1.7**, each `answered 200; it must keep its 500`. F1.1, F1.2 and F1.5 stay green: they do not depend on the dropped terms, which is the discrimination ADR-0877 measured |
| **M4** | the announcement term dropped                                                                      | `1 failed \| 6 passed (7)` — **F1.6** alone                                                                                                                                                                                |
| **M5** | the status term dropped                                                                            | `1 failed \| 6 passed (7)` — **F1.7** alone                                                                                                                                                                                |
| **M6** | the cached-total term dropped                                                                      | `1 failed \| 6 passed (7)` — **F1.4** alone, `matchCount 3 for a computed 5 … answered 500` inverted                                                                                                                       |
| **M7** | the activation-pointer term dropped                                                                | `1 failed \| 6 passed (7)` — **F1.5** alone                                                                                                                                                                                |
| **M8** | the whole `.catch` removed (the pre-ADR-0877 shape)                                                | `1 failed \| 6 passed (7)` — **F1.1** alone                                                                                                                                                                                |
| **M9** | the catch answers without waiting (`false` in place of the `confirmOutcomeCommitted` call)         | `6 failed \| 1 passed (7)` — every refusal case plus F1.2 red; **F1.1** is the one case that still passes, because its row was already settled                                                                             |

So each of the four conditions is refuted by exactly one case, the settle-vs-`500` split is pinned in
both directions, and no probe leaves the suite green. Gates: `tsc -p apps/web/tsconfig.json --noEmit`
exit `0`, `eslint` 0 on the new file, `prettier --check` clean on every touched path, and the `adr-*`
guards green for this record and its ledger row.

## Consequences

- **The arm now has a shipped pin.** A future edit that widens the `catch` into a blanket success, that
  drops any one term of the outcome predicate, that removes the wait, or that restores a plain rethrow
  reds a case whose message names the response the confirm owed.
- **The real exhaustion path stays where it was.** This record pins the arm's behaviour, not the
  retry budget: how deep a racer goes under contention is still measured by ADR-0821's ten-round burst
  and by the `db.transaction.retry` lines the wrap logs, and no case here asserts an attempt count.
- **Known limits, recorded rather than hidden.** (1) The seam stubs the wrapper, so a future change to
  `withTransaction`'s exhausted signal (a renamed class, a code instead of `instanceof`) would make the
  arm stop firing; `expectTheArmFired` then reds every case loudly instead of letting them pass on the
  ordinary path. (2) The refusal cases cost the shared 1 s ceiling each (~4 s of the file's ~13 s) and
  that ceiling is ADR-0877's `RIVAL_COMMIT_TIMEOUT_MS`; raising it lengthens this file. (3) F1.6
  produces "activation committed, notification missing" by deleting the outbox row, because no shipped
  path produces it — which is exactly why the arm must be seen refusing it. (4) F1.7's rival is
  scheduled at the lost transaction boundary by the harness; it models a real client-versus-worker
  interleaving but is not itself a race measurement.
- **Rejected alternatives.** Editing or exporting `CONFIRM_MAX_ATTEMPTS` (a production change, and the
  card is tests-only); holding a real rival transaction open until the confirm's own transaction
  exhausts (ADR-0877's probe technique — machine-dependent, and it measures the budget rather than the
  arm); appending to `selfie-confirm-publication.test.ts` (it would require editing that file's frozen
  mock and gate, which the card forbids, for no assertion the new file cannot make); a `unit`-project
  arm over a fake DB (it would duplicate the HTTP surface and the §6.3 envelope the integration harness
  already drives, and would assert the handler's return value instead of the response body).

## Review sign-off — OP-132 TEST (round 1, reviewer `openpic-webapp-reviewer`)

This is the append-only record of the round-1 review of PR
[#727](https://github.com/yahodu/openpic-webapp/pull/727), posted on the PR as comment
`#issuecomment-7009718606` and written up here by card `t_12d4675d`. It consumes **no** ADR number,
appends no index row, moves no ledger cell and leaves `docs/adr/README.md` byte-identical.
**Verdict: APPROVED** — artifact lens, then an independent execution and mutation pass; one review
round, no `changes_requested`. The delivery had already merged when the review finished
(`2026-11-19T12:55:22Z`, squash `187eafb8`), so what was reviewed is the merged bytes. Every figure
below was re-measured by the reviewer, none is quoted from the handoff.

**Tree identity.** `187eafb8^{tree}` reads `a4e2c4c0…`, which is exactly what
`git merge-tree --write-tree 187eafb8^ bd212bc4` writes from the reviewed head `bd212bc4` onto the
trunk `da6ed432`, so the squash carries the reviewed tree and nothing else. This record's own blob and
its ledger row are byte-identical on the trunk this sign-off is cut from (`228845cf`), whose later
ledger edits add only other cards' rows (`0845`, `0846`, `0879`, `0880`); the spec has since gained
the F1 pin's two cases (below), the only change to a path this record names.

**Scope, measured rather than transcribed.** `git diff --numstat 187eafb8^ 187eafb8` is exactly three
paths, `906 insertions(+), 2 deletions(-)`: the spec `+743/−0`, this record `+160/−0`, and
`docs/adr/README.md` `+3/−2` (one row and both `Next free` cells `0878` → `0879`). No production
file, no `vitest.config.ts`, no fixture, helper or mock. The sibling
`selfie-confirm-publication.test.ts` hashes `be912e85…` (`sha256`) and blob `340ba06e…` — identical
to `origin/main`, so its `confirmRaceGate` and burst assertion are carried byte-for-byte.

**Execution.** At the reviewed head `bd212bc4`: the focused spec `7 passed (7)`, run twice; with the
sibling `2 files / 26 passed (26)`, and the same `2 files / 26 passed (26)` at the squash
`187eafb8`. Six `adr-*` guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
`adr-consumers`, `adr-source-references`, `adr-inline-code-spans`) `236 passed (236)`.
`tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` exit `0` on the new spec,
`prettier --check` clean on all three paths. PR #727 carried fourteen pre-merge check runs, every one
`SUCCESS` including `ci` (concluded `12:37:38Z`); the fifteenth row, `notify-discord` at
`12:55:31Z`, is the merge's own side effect.

**The mutation table, re-measured.** In a throwaway probe worktree at `bd212bc4`, each of the nine
mutations of `confirm/route.ts` was applied alone, run, and restored byte-identically —
`sha256 c37b7233…` before and after every run, `git status --porcelain` clean between them:

- baseline, unmutated: `7 passed (7)`.
- **M1** the `.catch` always rethrows: `1 failed | 6 passed (7)`, **F1.1** alone.
- **M2** `activation.matchCount === outcome.matchCount + 1`: `1 failed | 6 passed (7)`, **F1.1** alone.
- **M3** the predicate made pointer-only: `4 failed | 3 passed (7)` — **F1.3, F1.4, F1.6, F1.7**.
- **M4** the announcement term dropped: `1 failed | 6 passed (7)`, **F1.6** alone.
- **M5** the status term dropped: `1 failed | 6 passed (7)`, **F1.7** alone.
- **M6** the cached-total term dropped: `1 failed | 6 passed (7)`, **F1.4** alone.
- **M7** the activation-pointer term dropped: `1 failed | 6 passed (7)`, **F1.5** alone.
- **M8** the whole `.catch` removed: `1 failed | 6 passed (7)`, **F1.1** alone.
- **M9** the catch answering without the wait: `6 failed | 1 passed (7)`, **F1.1** the only pass.

Every count and every failing case set matches §Evidence, so the table reproduces under the
reviewer's own anchors rather than being taken on trust.

**Ledger.** `0878` was unique when it was drawn: the trunk it was cut from (`da6ed432`) stops at
`0877` among its `docs/adr/ADR-*.md` paths, and the delivery's number-allocation note records the
sweep over every worktree tree, `git rev-list --objects --all -- docs/adr` and both open PR heads
finding nothing at `0878` or `0879`. The ledger half of the diff is one row plus **both** `Next free`
cells `0878` → `0879`, per ADR-0300 §11 item 18 — re-read from the squash's own README diff. No
number collides downstream: `ADR-0879` and `ADR-0880` (the OP-136 lane) were minted on the trunk
after this record, above it.

**F1 (Low), measured then closed.** The catch's _recognition_ term is unpinned at `bd212bc4`:
replacing `!isTransactionRetryLimitError(error) ||` with `false ||` leaves `7 passed (7)`, and
replacing it with `!(error instanceof Error) ||` leaves the same (both re-run by the reviewer, route
restored byte-identically); round 1 also ran the **full** `integration` project under `false ||` →
`146 files / 1539 passed (1539)`, so a catch widened out of its narrowness passed the whole suite.
That qualifies §Consequences' claim that "a future edit that widens the `catch` into a blanket
success … reds a case": true for the predicate half, false for the class half. The finding was
routed to card `t_c7528e37`, which pinned the class term in the same spec (PR
[#731](https://github.com/yahodu/openpic-webapp/pull/731), squash `e0032a61`). Re-measured by the
reviewer at the merged trunk `228845cf`: the spec plus the sibling reads `2 files / 28 passed (28)`,
and each of the two mutations above now reds **one** case alone — `1 failed | 8 passed (9)`,
`keeps its 500 even though a rival already committed the outcome` — with the route restored
byte-identically after each run. The claim therefore holds for **both** halves of the `catch`, and
nothing in this review is left open.

**Two Info corrections, recorded and not applied to the frozen text.** (1) The `docs/adr/README.md`
row for this record prints the spec as `+741/−0`; the measured numstat for that path is `743 0`. The
row merged with that figure and stays as it is — the correction lives here, not in the ledger.
(2) §Decision's sentence "No case reads a private function, a call count of an internal collaborator,
or a class name" is inaccurate as written: `expectTheArmFired` asserts `{ calls: 1 }` on the
`withTransaction` stub, which **is** a call count on an internal collaborator (the seam's own). The
private-function and class-name halves hold, the seam is still the wrapper and the assertion surface
is still the response and the stored rows — so **nothing in §Decision is retracted**; the sentence
overstates the absence of one guard.

**Post-review status.** `t_c7528e37` closed F1 (PR #731, squash `e0032a61`) with no production
change, no `docs/adr` change and no ledger cell of its own. Nothing else is routed from this review.
§Context, §Decision, §Evidence and §Consequences stand as written; this append adds one section and
touches no other file.
