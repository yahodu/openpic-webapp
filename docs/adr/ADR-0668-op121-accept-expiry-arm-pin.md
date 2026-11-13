# ADR-0668 — OP-121 TEST: the accept route's expired rival wait answers `500 internal_error` and writes nothing

- **Status:** Accepted (characterization pin — green on arrival, no GREEN sibling)
- **Consumers:**
  `apps/web/src/test/integration/event-invitation-decisions.test.ts` — the
  `nonDecisionWrite` helper and case `E1` of the appended
  `POST /api/v1/me/invitations/{invitationId}/accept — the exhausted rival wait
(F1)` describe.
- **Lane:** the **OP-120 invitations lane** block `0660`–`0679`, the block the
  OP-121 records and pins draw from
  ([ADR-0664](ADR-0664-op121-invitation-decisions-green.md),
  [ADR-0665](ADR-0665-op121-invitation-decisions-red.md),
  [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md),
  [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md)). At this head
  the lane's `Next free` cell read **`0668`**, so this record draws **`0668`**
  and the cell advances to `0669`. Both `unallocated (future lanes)` cells stay
  at `0829`: the lane still holds a reserved range, so nothing is drawn from the
  pool ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §2). The
  sweep behind that reading is in §Verification.
- **Relates to:** [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md)
  (the bounded wait and rethrow this pin measures),
  [ADR-0666](ADR-0666-op121-invitation-accept-race-pin.md) (the `I5` pair pin
  whose repair ADR-0667 is), and
  [ADR-0664](ADR-0664-op121-invitation-decisions-green.md) §Amendment (the
  concurrent member removal, whose `R2` already pins the symmetric arm on the
  same spec file). No accepted record is edited.
- **Satisfies:** review finding **F1 (Low)** of `t_ed6d5933` (OP-121 GREEN,
  PR #597, squash `e8a1fd3` on `main`) — "the wait-expiry arm is unmeasured" —
  which is card `t_5025a7cc`.
- **Consumes:** `0668`.
- **Schema:** n/a · **Contract:** §2.3 (a decision is final and idempotent; a
  double click never errors) and §0.7 (an already-terminal transition is
  success).

## Context

`decideInvitation` (`apps/web/src/server/collaboration/invitation-transition.ts`)
catches the wrapper's own exhausted-retry signal and waits, bounded, for a rival
decision to commit:

```ts
if (
  !isTransactionRetryLimitError(error) ||
  !(await rivalDecisionCommitted(invitations, invitationId))
) {
  throw error;
}
performed = false;
```

The focused coverage measurement at the merged trunk `e8a1fd3` left statement
`100-100` — the `return false` of `rivalDecisionCommitted` — and branch `251-252`
uncovered, so the branch was exercised only on its **true** side (a rival that
settles). A regression that answered `200` (a fabricated success, or a second
outer attempt that matched the still-pending row once the rival's lock was
released) or fell through to the `409 conflict` arm after the 1 s wait expired
would keep the whole suite green.

The symmetric arm is already pinned for the member removal, in this very spec
file: `R2` at `event-invitation-decisions.test.ts:2415` — _"answers 500
internal_error when the loser's spent retry budget finds no committed removal"_ —
which holds a rival transaction that writes the row **without** deciding it.
Nothing pinned the analog for accept.

## Decision

1. **One appended characterization case, and no existing case is touched.** The
   case is a new `describe`/`it` at the end of the file; the diff against
   `origin/main` is additions only (`79+/0-`), and no existing case, helper,
   fixture, mock or assertion is edited. It adds one file-local helper,
   `nonDecisionWrite(invitationId, session)`, and reuses the file's own
   `seedEvent`, `signInVerified`, `invite`, `userInvite`, `acceptInApp`,
   `inAppDecision`, `holdRivalTransaction`, `latch`, `captureLogs`,
   `waitForTransactionRetries` and `pause`.
2. **The rival holds the invitation document's lock, not the decision.** A rival
   `withTransaction` performs `$set: { updatedAt }` on the invitation inside its
   own session — the `nonRemovalWrite` shape `R2` uses, adapted to the
   `invitations` collection — opens the `locked` latch and keeps the transaction
   open. It is released only after the loser has spent its three-attempt budget
   (two `db.transaction.retry` lines, which the case asserts exactly, plus the
   file's 150 ms conflict round-trip grace), so the write it commits is never a
   decision and the invitation still reads `pending`.
3. **The expiry is pinned at its observable outcome.** The case requires the
   accept to answer `500` with `code: "internal_error"` — not the `200` of a
   settled decision and not the `409` of the live-row fall-through — and that the
   loser wrote nothing: no `event_organizers` row for the invitee, the invitation
   still `pending`, zero `collab.invite.accepted` outbox rows, and no
   `invitation.resolved` log entry carrying `alreadyResolved: true`.
4. **It is a pin, not a repair.** The arm ships at `e8a1fd3`, so the case is
   green on arrival; no GREEN sibling is created and the PR is a normal
   non-draft test PR. The production file is not changed.

## Consequences

- **The expiry arm is measured, not read.** The focused coverage run after the
  case reports the file's uncovered lines as `286, 339, 355, 372`; line `100`
  (the `return false`) is no longer among them. The lines that remain are
  pre-existing `404 not_found` arms of the same module, not this branch.
- **What the pin bites.** Deleting the `throw error` of the expiry branch makes
  the case red with `expected 200 to be 500`: after the wait expires, the next
  outer attempt matches the now-unlocked `pending` row and fabricates a
  success. That is precisely the regression the finding named.
- **What it does not pin.** The 1 s ceiling (its effective `1 025 ms` and the
  loop shape are finding **F3**, routed to `t_b4750d70`), the read cost of the
  wait (**F4**, same card), and the narrowness of the catch: a degenerate broad
  `catch` also answers `500` here, exactly as [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md)
  §Consequences already records for `I5`. The predicate stays enforced by review
  and by ADR-0667 §Decision 1, not by this pin.
- **Cost.** The case spends the real bounded wait (`1 000 ms` plus one poll), so
  it runs about `1.5 s`; the file grows from 50 to 51 cases.
- **Residual risk.** A single-server class cannot hold a rival transaction open
  across processes, so the pin uses the app's own `withTransaction` inside the
  test process — the same mechanism `R1`/`R2` use, and the only one that gives
  the loser a real write conflict rather than a simulated one.

## Verification

- **The pin is green on arrival:** the whole file `51 passed (51)` (it was 50
  cases before the case), focused `E1` green inside it.
- **Coverage proof after the case:** `vitest run --project integration <spec>
--coverage --coverage.include='apps/web/src/server/collaboration/invitation-transition.ts'`
  → `94.02 % statements`, `Uncovered Line #s 286,339,355,372`; statement `100`
  is covered (it was the uncovered `100-100` in the finding's measurement at
  `e8a1fd3`).
- **Mutation probe:** deleting the `throw error` of the expiry branch and
  running the focused case gives `1 failed | 50 skipped`, `AssertionError:
expected 200 to be 500` in `1547 ms`; the production file was restored
  byte-identically (`sha256 05e2051f493ec2d99d10935c5be5d535dfe8208219e734cf7b86f7aa791f6c20`
  before and after, `git status` clean apart from the spec).
- **Static gates:** `pnpm typecheck` exit `0`; `eslint` on the touched spec exit
  `0`; `prettier --check` clean.
- **Suites:** full `unit` **179 files, 2965 passed | 3 skipped (2968)**; full
  `integration` **131 files, 1356 passed (1356)**.
- **ADR guards:** `adr-numbering`, `adr-record-links`, `adr-consumers`,
  `adr-lane-ranges` and `adr-source-references` — **5 files, 218 passed (218)**.
- **Number sweep for `0668`:** the lane cell and both pool cells re-read on
  `origin/main` `872fd046` as `0668` and `0829`; `git rev-list --all --objects`
  carries no `ADR-0668` on any branch or reachable object; no
  `.worktrees/*/docs/adr` carries it; the three remote `OP-121` heads
  (`OP-121-task-invitation-accept-race-pin`, `OP-121-task-lane-tip-preserved`,
  `OP-121-task-removal-edge-pins`) carry only `ADR-0666`; and the fifteen open
  PR heads add no `ADR-0668`–`ADR-0679` file.

## Alternatives

- **Unit-test `rivalDecisionCommitted` directly.** Rejected: the function is
  module-private, so a unit test would have to assert an internal, and the
  contract that matters is the route's answer.
- **Shrink the ceiling in a probe instead of holding the lock.** Rejected: it
  would change production behaviour to make a test cheap, and it measures a
  different constant.
- **Wait a fixed `1 200 ms` instead of gating on the retry lines.** Rejected:
  the retry-line gate is the file's measured, non-flaky mechanism (`R1`/`R2` use
  it) and the fixed sleep would be a guess that can degrade into a case that no
  longer exercises the branch.
- **Pin only the status, not "nothing written".** Rejected: a fabricated
  `alreadyResolved: true` body with a membership row and an accept emit is the
  failure mode the card names, so the side-effect assertions are the point.
