# ADR-0877 — OP-132 GREEN: a confirm that spends its burst budget answers the settled activation

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-132 follow-up GREEN `t_41f06cb7` (Medium; finding raised by the review of the
  OP-135 test-infra card `t_e9340c72`). Branch `OP-132-bug-confirm-burst-attempt-budget`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_e9340c72`, cut from `origin/main` `1167db2d` and merged
  with `origin/main` `9931d702` (the OP-104 landing) — the ledger is the only conflicted path and
  resolves as a union.
- **Implements:** contract §6.3 / §6.4 (the confirm's seven-key envelope and its `status`), schema
  §15.3 (the profile row's `activeSelfieId`), §16.4.
- **Satisfies:** the pin of [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) — the F3.5 describe in
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts`, carried into this branch
  **unchanged** (`git diff` over the spec file is empty; no test, fixture, helper or mock is edited).
- **Amends:** [ADR-0823](ADR-0823-op132-confirm-burst-budget.md) §Consequences' known limit ("a
  storm wider than five still exhausts the budget and answers `500` after the activation") — the
  budget stays `5`, and the exhausted arm no longer answers `500` when a rival committed. The record
  itself is not edited.
- **Consumes:** `0877`.
- **Consumers:** `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts` — the
  `confirmOutcomeCommitted` wait, the `.catch` on the confirm's `withTransaction` call and the
  docblock paragraph that names this record.

## Context

[ADR-0823](ADR-0823-op132-confirm-burst-budget.md) sized the confirm's attempt budget at `5` from a
measured worst case: a burst of `N` confirms writes one profile document, so the unluckiest racer
spends one attempt per rival commit, and on that head the deepest attempt reached was `5` and it
committed. The budget was therefore **one conflict from exhausted**.

The OP-135 card `t_e9340c72` measured the other side of that edge. In one full `integration` run of
eight at `8f731fdb` (four vCPU, 7 GB RAM, three fork workers) the burst answered
`[200,200,200,500]`, and the `500` was the confirm's own
`TransactionRetryLimitError` — `transaction retry limit reached after 5 attempts` — after that
selfie had activated. The same run's `db.transaction.retry` lines show `attempt: 4, maxAttempts: 5`
five times and `attempt: 5, maxAttempts: 5` twice; a green burst on the same head spends
`attempt: 3` twelve times. So the pin's contract held only while the host was lightly loaded: under
CPU contention the writes conflict for longer and a racer loses all five attempts, and an attendee
whose selfie did activate reads a failure.

The route's own log line names the defect class [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md)
closed for the two-wide burst, resurfacing at the four-wide width.

## Decision

**A racer that spends its whole budget answers the outcome a rival committed, instead of answering
`500`.** The confirm's `withTransaction` call gains a `.catch`:

1. Anything that is not the wrapper's own exhausted-retry signal is rethrown unchanged
   (`isTransactionRetryLimitError`, the narrow test ADR-0667 introduced — never a broad `catch`).
2. On that signal only, the route waits **bounded** for the row to show **everything this request
   owed**: the activation pointer (`activeSelfieId` naming this selfie), the §6.4 cached `matchCount`
   this confirm computed, the §15.3 `status`, and — when it had something to announce — the §10.3.2
   `attendee.matches.new` row for its own `dedupeKey`. The wait is `waitForCommitted`
   (`@/server/db/retry-wait`, 25 ms poll, 1 s ceiling), the shared wait ADR-0667 and ADR-0669 gave
   the invitation accept and the member removal.
3. Once the row shows all of it the handler falls through to the same `selfieEnvelope` it answers on
   the ordinary path, so every arm returns the §6.3 seven-key envelope. A wait that runs out rethrows
   the original error, so a race **nobody** settled is still the documented `500`.

**The pointer alone was rejected on measurement, not taste.** A confirm whose selfie is _already_
`activeSelfieId` — a repeat confirm, the late-worker-result recovery confirm, or a selfie the claim
adopted — can exhaust its budget while owning no write at all: its `matchCount`/`status` refresh and
its `attendee.matches.new` row are still pending. A predicate that tested only the pointer answered
`200 ready` on the probe's pointer-only arm with **no** announcement written — a dropped notification
reported as success. The outcome predicate answers `500` there, which is the honest answer.

The transaction body, the atomic unit (the §15.3 watermark, the `activeSelfieId` / `status` /
`matchCount` writes and the `attendee.matches.new` insert), `CONFIRM_MAX_ATTEMPTS = 5`, the dedupe
read inside the transaction and `DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3` are all unchanged. The loser
writes nothing, so one activation is still announced once.

## Evidence

A throwaway probe was deleted before the commit (`git status --porcelain` then lists only the route
file). It seeds one event, one submitted selfie and three matches, opens a rival transaction that
writes the profile and holds it open until the confirm's own transaction rejects with the exhausted
signal — releasing on that signal rather than after a fixed delay, because the confirm's route
startup is machine-dependent and its settled wait is bounded at 1 s. Three fresh rounds per run:

- **RED before the change**, at this branch's cut `1167db2d`: `Tests 1 failed (1)`,
  `expected 500 to be 200`, with the confirm logging
  `http.error status 500 TransactionRetryLimitError … after 5 attempts` and
  `db.transaction.retry attempt 2…5 maxAttempts 5`.
- **The pointer-only predicate measured wrong**: with `activeSelfieId` alone as the test, the probe's
  two controls answered `200` where they had to answer `500`
  (`Tests 2 failed | 1 passed (3)`), and the `200` carried `status: "ready"` with no
  `attendee.matches.new` row written.
- **GREEN after the outcome predicate**: `Tests 3 passed (3)` — a rival that commits the whole
  outcome (pointer, `status`, `matchCount` and the dedupe row) answers `200 ready`; a rival that moves
  only the pointer answers `500`; a rival that activates another selfie answers `500`.
- **Focused specs**: `selfie-confirm-publication.test.ts`, `liveness-selfie-submit.test.ts` and
  `selfie-zero-match-and-reusable-pages.test.ts` → `3 files / 48 passed (48)`.
- **Full `integration` run at this head**: `141 files passed (141)` / `1480 passed (1480)`,
  0 `Test timed out`, 0 confirm `500`s, and the burst's deepest retry line was
  `attempt: 4, maxAttempts: 5` — i.e. a green run still spends four of the five attempts, which is
  why the exhausted arm is load-bearing rather than theoretical.
- **Whole suite with coverage**, on the merged tree (`origin/main` `9931d702` merged in; run with
  `--project unit --project integration --coverage`): `328 files passed (328)` /
  `4627 passed | 3 skipped (4630)`, exit `0`, 0 confirm `500`s, 0 timeouts, and all four global
  thresholds green (lines `91.75`, branches `80.54`, functions `95.85`, statements `91.86`). The
  route file reads `79.48` stmts / `63.63` branch, the exhausted arm itself uncovered — the gap
  below.

## Alternatives

- **Raise `CONFIRM_MAX_ATTEMPTS` alone** (card shape 1, ADR-0823's option). Rejected on measurement:
  no fixed budget above four is a bound on the contention, only a bigger constant — the probe above
  exhausts _any_ budget that is smaller than the rivals' commit window, and ADR-0667 already measured
  and rejected this shape for the invitation accept (a busy loop against a clock; `57` was the
  measured edge). The settled arm bounds the loser's **latency** (1 s) instead of its attempt count.
- **The activation pointer alone as the settled test.** Rejected on the probe above: it answers `200`
  for a request whose `matchCount`/`status` write and announcement never landed.
- **A broad `catch` that answers the current row.** Rejected as ADR-0817 recorded: it turns a genuine
  database failure into a `200 ready`. The `.catch` here rethrows everything that is not the wrapper's
  own exhausted-retry signal, and even then answers only when the row shows the owed outcome.
- **A pre-transaction read of the profile.** Rejected: the loser's read happens before the winner's
  commit, which is exactly the window the burst pin closes.

## Consequences

- **Known limit:** the wait is bounded at 1 s (`RIVAL_COMMIT_TIMEOUT_MS`); a winner still uncommitted
  at the ceiling keeps the original `500`. The loser pays up to 41 extra reads on this arm only, and
  only when it spent all five attempts.
- **Coverage gap (for the pin author, not this card):** no shipped case forces the exhausted arm, so
  `confirmOutcomeCommitted`'s arms — the settled answer, the three outcome conditions and the
  wait-expired rethrow — are exercised only by the probe above. A future TEST card can pin them the
  way ADR-0668 pinned the invitation accept's expiry arm.
- The endpoint now absorbs a burst of any width whose winner settles, which is what §6.3's
  "same seven-key envelope to every one of them" means for a client with several open tabs.
- The wait reads the outbox as well as the profile only when the confirm had something to announce,
  so the cheapest arm (nothing to publish) stays one read per poll.

## Review sign-off (round 1, artifact lens + execution pass)

The round-1 review of this GREEN was posted on PR
[#688](https://github.com/yahodu/openpic-webapp/pull/688) as comment `#issuecomment-7007750723`. This
sign-off is card `t_2eb51c90`: it consumes **no** ADR number, moves no ledger cell and leaves
`docs/adr/README.md` byte-identical. **Verdict: APPROVED.** The deliverable had already merged when
the review finished (`gh pr merge 688 --squash --admin`, `2026-11-19T11:45:41Z`, squash `f7246b9d`),
so the review verifies **the merged bytes**, not a proposed head.

**Tree identity — the review measures what shipped.** Whole-tree identity holds between the final PR
head and the squash: `d8a10754^{tree}` == `f7246b9d^{tree}` ==
`98e31ed8b559c67888fbacbf2224b3690f45862c`, which was `origin/main^{tree}` at merge time (the trunk
then stood at `f7246b9d`). The blind spot the lane's merges of `origin/main` create is closed with
blob identity instead: the reviewed head `a0668d4e`, the final head `d8a10754`, the squash `f7246b9d`
and the trunks that followed up to `187eafb8` all carry `6f48ab5f` for the confirm route, `340ba06e`
for `selfie-confirm-publication.test.ts` and `c5ce4fc1` for this record. So every number below was
measured on the bytes `main` carries. The trunk advanced after the merge (`14186080`, this record's
sibling DOCS landing #726 with release `1.66.7` at `750c0398`, then `da6ed432`, then the F1 pin
`187eafb8`), and none of those landings edits a line of the three blobs above.

**Scope measured, not transcribed.** `git diff --stat f7246b9d^ f7246b9d` is exactly three paths —
`3 files changed, 226 insertions(+), 9 deletions(-)`: the confirm route `+97/−9`, this record `+131`
new and `docs/adr/README.md` `+7/−2` (one row, one prose note, both `Next free` cells `0877` →
`0878`). No test, fixture, helper or mock is in the diff; the burst pin this record says it carries
unchanged is one blob on both sides.

**Checks.** At the reviewed head `a0668d4e`: the focused `selfie-confirm-publication` +
`liveness-selfie-submit` + `selfie-zero-match-and-reusable-pages` run → **3 files / 48 passed (48)**;
the full `integration` project → **142 files / 1500 passed (1500), exit 0**, with 0 `Test timed out`
and 0 confirm `http.error` 500s. Gates on the same head: `tsc -p apps/web/tsconfig.json --noEmit`
clean, `eslint` exit `0`, `prettier --check` clean on all three paths. PR #688 reads **14/14 pass** on
each of its two heads (`303f5374`, then `d8a10754`) — fourteen gates, the fifteenth `check-runs` row
being the `notify-discord` close side-effect. Re-measured at this sign-off's base `14186080`:
`selfie-confirm-publication` **19 passed (19)** and the `adr-numbering` guard **29 passed (29)**, the
figures the review recorded, unchanged because the blobs they measure are unchanged.

**The arm is load-bearing — mutation table.** The delivered budget of `5` means a lightly loaded run
never reaches the new `.catch`, so a green suite alone proves nothing about it. In a throwaway probe
worktree at `a0668d4e`, each mutation restored with `git checkout --` before the next:

- **Delivered** (`CONFIRM_MAX_ATTEMPTS = 5`): the burst's ten rounds are green and the arm is never
  reached.
- **`CONFIRM_MAX_ATTEMPTS = 1`** (three of the four racers exhaust every round):
  `10 passed | 9 skipped (19)` — every round answers `[200,200,200,200]`, because the settled re-read
  converts each loser.
- **The same mutation plus a `.catch` that always rethrows**: `10 failed | 9 skipped (19)`, with
  `[200,500,500,500]` in every round — the pre-fix answer this record removes.
- **The same mutation plus `activation.matchCount === outcome.matchCount + 1`** (a `matchCount` term
  nothing can satisfy): `10 failed | 9 skipped (19)`, the same `[200,500,500,500]`.

So the settled re-read converts exactly the losers the pre-fix code answered `500`, and its
`matchCount` term discriminates instead of decorating the predicate.

**The ledger is the only hotspot, and it merges as a union.** `origin/main` was merged into the lane
twice while the PR was open: `303f5374` carried `e4273dd7` (the #724 OP-104 sign-off, which had
already absorbed `cd89b275`) and `d8a10754` carried `4ba8c1fc` (PR #725, the ADR-0844 sign-off).
Each time `docs/adr/README.md` was the only conflicted path, and each resolution was index-only. The
merged tree carries both sides: the trunk's own newer material (`0319` board-wide, `0288` OP-101,
`0372` OP-104, the `0282`–`0287` and `0318` rows, `0843`, `0844`, and the OP-135 lane cell at `0845`)
**and** this lane's `0877` row, its prose note, and the `OP-136` lane cell and pool cursor at `0878`.
No number is re-minted: the sweep over every `ADR-NNNN` path on the merged tree returns no name twice,
and the tree holds 397 records at `d8a10754` and at `f7246b9d`. Records minted after the merge are
other cards' (`ADR-0878` is the F1 pin's, below); this append adds none and touches no ledger cell. One
merge of `origin/main` (`187eafb8`) carries that pin onto this sign-off's branch, conflicts with
nothing, and continues the same union.

**Findings and their post-review routing.** **F1 (Low)** — no shipped case forces the exhausted arm:
the confirm route reads `79.48 %` statements and `63.63 %` branches, and the uncovered lines are this
arm, so its settled `200`, its three outcome conditions and its wait-expired `500` rest on the probe
above alone. Routed to the test card `t_693d16f7`, and that pin landed after the merge as PR #727
(squash `187eafb8`, recorded by `ADR-0878`): `selfie-confirm-exhausted-budget.test.ts` covers the
settled `200`, the outcome conditions and the wait-expired `500`, reading **7 passed (7)** when this
sign-off re-ran it at the merged trunk, so the gap measured here is now covered on `main`. **F2
(Info, accepted)** — the wait ceiling is the shared fixed `RIVAL_COMMIT_TIMEOUT_MS = 1_000`, so a
winner still uncommitted at the ceiling keeps its `500`. §Consequences already states that limit and
its upgrade path (the per-resource lock ADR-0667 and ADR-0669 would need), no measured run's wait
expired, and the green runs' deepest burst attempt is `attempt: 4, maxAttempts: 5`. **F3 (Info)** —
the branch is a **pool draw** above the exhausted `0849`–`0868` block, which follows the ADR-0300 §11
item 18 precedent ADR-0869 and ADR-0876 set (both cells advance, one above the record); `0877` was
unique in flight, so nothing outside it is consumed.

**Nothing above is retracted.** §Context, §Decision, §Alternatives, §Evidence and §Consequences stand
as written: this sign-off changed no decision, consumed no number and touched no other file. F1's
outcome belongs to `t_693d16f7`, and nothing in §Decision, §Alternatives or §Consequences is
withdrawn by it.
