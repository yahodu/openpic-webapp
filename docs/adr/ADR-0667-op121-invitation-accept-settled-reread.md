# ADR-0667 — OP-121 GREEN: a loser of the accept race answers from the settled invitation after a bounded wait

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/server/collaboration/invitation-transition.ts` — the
  `RIVAL_COMMIT_TIMEOUT_MS` / `RIVAL_COMMIT_POLL_MS` constants, the
  `rivalDecisionCommitted` wait, the retry-limit branch of `decideInvitation` and
  the docblock paragraphs that name this record.
- **Lane:** the **OP-120 invitations lane** block `0660`–`0679`, the block this
  lane's two shipped records and the pin draw from
  ([ADR-0664](ADR-0664-op121-invitation-decisions-green.md),
  [ADR-0665](ADR-0665-op121-invitation-decisions-red.md),
  [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md)). At this head the
  lane's `Next free` cell read **`0667`** — the pin consumed `0666` — and the
  sweep in §Verification found `0667` on no ref, no `.worktrees/*/docs/adr` and
  no open PR head, so this record draws **`0667`** and the cell advances to
  `0668`. Both `unallocated (future lanes)` cells stay at their merged value
  `0828`: the lane still holds a reserved range, so nothing is drawn from the
  pool ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §2).
- **Amends:** [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md)
  §Decision 5 and §Consequences — the pin's statement of the repair it selects
  (settled re-read, or serialising the pair) and of what a raised budget costs.
  The record is not edited; this one is the repair it asked for.
- **Satisfies:** the pin of
  [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md) — case `I5` of
  `apps/web/src/test/integration/event-invitation-decisions.test.ts`, carried
  into this branch **unchanged** (`git diff 6a7e828 -- <spec>` is empty).
- **Relates to:** [ADR-0664](ADR-0664-op121-invitation-decisions-green.md)
  §Amendment (the concurrent member removal, whose bounded wait this shape
  copies), [ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) (the same
  defect class on the confirm's pair) and
  [ADR-0823](ADR-0823-op132-confirm-burst-budget.md) (the budget shape this
  record rejects for this endpoint, and why).
- **Consumes:** `0667`.
- **Schema:** n/a · **Contract:** §2.3 (a decision is final and idempotent; a
  double click never errors) and §0.7 (an already-terminal transition is
  success).

## Context

`I5` fires two `POST /api/v1/me/invitations/{invitationId}/accept` calls for one
invitation and requires `[200, 200]`, exactly one `alreadyResolved: false`, one
`event_organizers` row for the invitee and one `collab.invite.accepted` outbox
row. With the pin's latch the pair meets at its transaction boundary and the
met winner's commit is held for `INVITATION_RIVAL_HOLD_MS = 100` before it
commits. On this branch's cut (`6a7e828`) the case was **red**: the loser spent
all three attempts of `withTransaction` inside the winner's hold and threw

```
TransactionRetryLimitError: transaction retry limit reached after 3 attempts
  at decideInvitation (apps/web/src/server/collaboration/invitation-transition.ts:266)
```

which the accept route answered as `500` — after the winner had already created
the membership. Reproduced here before the change: `1 failed | 49 passed (50)`,
`expected [ 500, 200 ] to deeply equal [ 200, 200 ]`.

The cause is structural, not a width: the loser's failure is an exhausted
budget, and a budget is spent in round trips (~1–2 ms each), while the winner's
commit is a wall-clock hold. Card shape 1 (raise `maxAttempts`) was measured at
the pin head: `3`, `5` and `20` stay red (2 of 2 runs each), `60` and `120` are
green, so the edge is about **57** attempts. That passes, but it is a busy
retry loop sized to the pin's hold, and a peer that commits later defeats it
again — [ADR-0823](ADR-0823-op132-confirm-burst-budget.md)'s derivation (one
attempt per rival commit) does not reach it, because the loser here loses to a
**clock**, not to a count of rivals.

## Decision

1. **Recognise the race abort narrowly and finish with a state-only read (card
   shape 2).** The predicate is `isTransactionRetryLimitError` — the wrapper's
   **own** exhausted-budget signal, which `transaction.ts` raises only after its
   attempt cap is spent and which is deliberately not a driver error. It cannot
   mistake a real write failure for a collision: a genuine callback failure is
   not that error, so it propagates unchanged. Nothing is caught broadly; the
   measured false accept of `t_6e555aa3` (a `200` with no activation, no
   watermark, no notification) stays impossible. A duplicate-key predicate is
   not used because the colliding write here is a `findOneAndUpdate` on one
   document, which aborts as a write conflict, not a duplicate key.
2. **The wait is bounded, and copied from the shape this domain already ships.**
   A loser polls the invitation every `RIVAL_COMMIT_POLL_MS = 25` for at most
   `RIVAL_COMMIT_TIMEOUT_MS = 1_000` and answers once the row is no longer
   `pending` — the same 25 ms / 1 s pair, and the same reasoning, as the
   concurrent member removal ([ADR-0664](ADR-0664-op121-invitation-decisions-green.md)
   §Amendment, `members/[userId]/route.ts`). The ceiling is 10× the pin's hold.
   When the wait runs out and the row is still `pending`, the **original**
   failure is rethrown: a race nobody settled stays a `500`, never a fabricated
   success.
3. **The loser writes nothing and answers the winner's row.** Its transaction
   was aborted, so no membership, no affordance stamp and no outbox row can come
   from it; the answer is built by the shipped `answerTerminal` / `decisionBody`
   path, which is the same body a replayed accept already answers. One
   membership row, one `collab.invite.accepted`, exactly one
   `alreadyResolved: false`; the loser reports `alreadyResolved: true`.
4. **Nothing else moves.** `DEFAULT_TRANSACTION_MAX_ATTEMPTS` stays `3` and this
   transaction does not override it; every write of one accept is still one
   atomic unit; the `RACE_ATTEMPTS` re-read loop, the `410 invitation_revoked` /
   `410 invitation_expired` arms, the `409 conflict` arm and the **sequential**
   repeat accept (a second accept after a commit matches nothing, reads the
   settled row and answers `alreadyResolved: true`, one row, no second emit) are
   unchanged.

## Consequences

- **The pin is green, repeatedly.** Five consecutive whole-file runs after the
  change: `50 passed (50)` each (`16.76 s`, `16.79 s`, `15.55 s`, `16.61 s`,
  `17.11 s`), focused `I5` green before them. The loser's own trace in the
  focused run is the mechanism in one line: `db.transaction.retry` at
  `attempt: 2` and `attempt: 3` 4 ms apart (inside the winner's hold), then
  `invitation.resolved … alreadyResolved: true` 106 ms later, i.e. after the
  winner's commit became visible — not from a spent budget.
- **What the bound covers.** A rival decision whose commit is visible within
  1 s of the loser's abort. In this pin that is a 100 ms hold, so the ceiling is
  10× the measured worst case.
- **What it does not cover.** A winner whose transaction stays open longer than
  the ceiling (a loaded primary, a majority write concern under contention)
  still answers the original `500`. That is a deliberate, bounded regression
  compared with an unbounded wait, and it is the same limit the removal route
  documents as a `shortcut:` comment. It also does not serialise the pair: both
  requests still open transactions and contend; only the loser's **answer**
  changes. Upgrading to a shared per-invitation decision lock would bound the
  wait to one round trip, at the cost of a cross-request queue this endpoint
  does not need yet.
- **Latency.** A loser answers up to `RIVAL_COMMIT_TIMEOUT_MS` late in the worst
  case and one poll interval (`25 ms`) late in the pin's case. A request that
  never races (every sequential call, every repeat accept) pays nothing — the
  catch is not entered.
- **The rejected shape, on the record.** Card shape 1 (`maxAttempts` ≳ 57) is
  measurably green on this spec and is not forbidden by the pin, but it buys the
  same answer with a busy loop, scales with the peer's slowness rather than with
  the contention, and leaves every other transaction in the process paying the
  default budget unchanged. [ADR-0823](ADR-0823-op132-confirm-burst-budget.md)
  chose shape 1 for the confirm because there the rivals are **countable**
  (`N = 4` burst, `maxAttempts = 5`, deepest attempt measured); here the rival
  count is not what the loser loses to.
- **The pin cannot tell a narrow catch from a broad one.** A degenerate broad
  catch also measured `50 passed (50)` × 3 at the pin head, so this record's
  first decision is enforced by review, not by `I5`. Stated here so the next
  reader does not mistake the green pin for a proof of the predicate.

## Verification

- **Red before, at this branch's cut `6a7e828`:** whole file
  `1 failed | 49 passed (50)`, `expected [ 500, 200 ] to deeply equal [ 200, 200 ]`.
  **Green after:** five whole-file runs, `50 passed (50)` each; one focused
  run's transition trace as recorded in §Consequences.
- **The spec is carried unchanged:** `git diff 6a7e828 -- apps/web/src/test/integration/event-invitation-decisions.test.ts`
  is empty; against `origin/main` it is `139 additions, 0 deletions`.
- **Static gates:** `tsc -p apps/web/tsconfig.json --noEmit`, `eslint` and
  `prettier --check` clean on the touched paths.
- **ADR guards:** `adr-numbering` and `adr-record-links` green, the ledger table
  strictly ascending.
- **Suite:** full `unit` and full `integration` green (counts in the handoff).
- **Number sweep for `0667`:** both cells re-read after the merge with
  `origin/main` (lane `0667`, pool `0828`); `git rev-list --objects --all -- docs/adr`
  returns nothing above `0827`; `git ls-tree` over every local and remote branch
  and every `.worktrees/*/docs/adr` carries no `ADR-0667`; the sixteen open PR
  heads stop at `0666` on PR #589 (this branch's pin) and `0825` on the pool.

## Alternatives

- **Raise `maxAttempts` to 57+ (card shape 1).** Measured green, rejected: a
  busy retry loop against a clock — see §Consequences.
- **Serialise the two accepts before their transactions** (a per-invitation
  `runExclusive` queue, as the checkout claim uses). Measured green at the pin
  head and it bounds the wait to one round trip, but it introduces a
  cross-request queue for an endpoint whose sequential behaviour already needs
  no ordering, and it would not help the cross-process case (a second instance
  holds its own queue). Rejected as more machinery than the contract asks for.
- **Move the decision read inside the transaction and rely on the retry**
  (ADR-0817's shape). Not applicable: the loser's retry budget is already spent
  before the winner commits, so no attempt of it can read the settled row.
- **Catch broadly and answer from whatever the row says.** Forbidden by the
  card and by the measured false accept of `t_6e555aa3`; a write failure would
  be reported as a success.

## Review sign-off (round 1 — artifact + execution lens, card t_ed6d5933, PR #597, squash e8a1fd3)

**Verdict: APPROVED WITH FINDINGS, and the deliverable landed exactly as reviewed.** PR #597 was reviewed at head
`ceec554` and squash-merged as `e8a1fd3`. The reviewer edited nothing in the deliverable, and the scoped diff
`git diff ceec554 e8a1fd3` over the PR's five paths — `invitation-transition.ts`, the
`event-invitation-decisions` spec, this record, ADR-0666 and `docs/adr/README.md` — is empty, so every number
below was measured on the tree the trunk now carries. This section is the record's first change since then and
retracts nothing: **no part of §Decision, §Consequences, §Alternatives or §Verification is retracted.**

### Acceptance evidence, re-measured at `ceec554`

- `event-invitation-decisions.test.ts` whole file, five consecutive runs: **50 passed (50)** each (`17.29 s`,
  `15.62 s`, `16.92 s`, `17.43 s`, `16.26 s`), exit `0` on all five — the pin is green repeatedly, not once.
- full `unit`: **178 files, 2938 passed | 3 skipped (2941)**, exit `0`.
- full `integration`: **131 files, 1353 passed (1353)**, exit `0`. Two unrelated specs
  (`me-notification-preferences`, `tenant-provisioning-and-routes`) hit this host's 5 s ceiling on the first pass
  on a loaded machine and were green on their own re-run (`2 files, 33 passed`), so the two timeouts are host load,
  not this change.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` exit `0` with no error (the 187 warnings are the
  repo's standing `security/*` advisories in test and script files), `prettier --check` clean.
- the four `adr-*` guards this card names — `adr-numbering`, `adr-record-links`, `adr-consumers`,
  `adr-lane-ranges` — **4 files, 195 passed (195)**; the tree's fifth guard, `adr-source-references`, is green
  too (`23 passed`).
- `gh pr checks 597`: **14 of 14 gates pass** at `ceec554`. The rollup lists fifteen entries only because the
  close side-effect run `notify-discord` is not a gate.
- **the spec is the pin's own.** One blob, `636aecda`, is the spec at the branch's `6a7e828`, at the reviewed head
  `ceec554`, at the squash `e8a1fd3` and on `origin/main`: `I5` reached the trunk exactly as the pin wrote it.
  Against the branch cut the spec is `139 additions, 0 deletions` (commit `20b3e68f`).

### The four findings and where each was routed

All four are Low or Info, none of them blocks the decision above, and each is routed by card id: no follow-up
record number exists yet, so none is named here.

- **F1 (Low) — the wait-expiry arm is unmeasured.** Focused coverage of the spec over
  `invitation-transition.ts` reports line `100`, the `return false` of `rivalDecisionCommitted`, as uncovered, so a
  regression on that arm — including a fabricated success once the wait runs out — stays green. The symmetric arm
  is already pinned for the member removal as case `R2` at `event-invitation-decisions.test.ts:2415`. Routed to
  `t_5025a7cc`.
- **F2 (Low) — the bounded wait is duplicated verbatim.** `RIVAL_COMMIT_TIMEOUT_MS`, `RIVAL_COMMIT_POLL_MS`,
  `sleep` and the poll loop exist twice: `invitation-transition.ts:54-101` and
  `members/[userId]/route.ts:69-109`. Routed to `t_b4750d70`, which either extracts one helper or records why the
  pair stays copied.
- **F3 (Info) — the ceiling is 1 025 ms, not the documented 1 000 ms.** The loop sleeps once more after its last
  poll, so `RIVAL_COMMIT_TIMEOUT_MS = 1_000` bounds the polls rather than the wait: 41 polls of 25 ms. Routed with
  F2 to `t_b4750d70`, for the loop shape and the wording together.
- **F4 (Low) — the failure path multiplies reads.** The wait is entered on every `isTransactionRetryLimitError`,
  so a saturated primary with no rival decision costs up to 41 sequential `findOne` calls (`1_000 / 25 + 1`)
  before the original `500`. §Consequences records that path's latency, not its read cost. Routed to
  `t_b4750d70`.

### Where the narrow-catch property is enforced

§Consequences already states that the pin cannot tell a narrow catch from a broad one, and round 1 confirmed it
instead of assuming it: a degenerate broad catch measured `50 passed (50)` three times at the pin head. The
predicate is therefore `isTransactionRetryLimitError` alone, and review is what keeps it that way — `I5` cannot.
A future change to the catch is a change to §Decision 1 and needs its own pin, not a green run of this one.

This section adds a verdict and four routed findings around a decision that stands. It adds no executable claim
and changes no test, helper, fixture or production file, and it consumes no ADR number: `docs/adr/README.md` is
byte-identical to the trunk this append was cut from and the lane's `Next free` cell is untouched.
