# ADR-0666 — OP-121 TEST: the concurrent accept pair is pinned at the transaction boundary, not left to the event loop

- **Status:** Accepted (RED pin — the draft PR that carries it must not merge on its own)
- **Consumers:**
  `apps/web/src/test/integration/event-invitation-decisions.test.ts` — the
  `invitationRaceGate` latch, its pass-through `vi.mock` of
  `@/server/db/transaction`, the `CONCURRENT_ACCEPTS` /
  `INVITATION_RACE_GRACE_MS` / `INVITATION_RIVAL_HOLD_MS` constants and the
  assumption **I-A6** that names this record.
- **Lane:** the **OP-120 invitations lane** block `0660`–`0679`, which is the
  block the two OP-121 records already draw from
  ([ADR-0664](ADR-0664-op121-invitation-decisions-green.md),
  [ADR-0665](ADR-0665-op121-invitation-decisions-red.md)). The lane's `Next free`
  cell read **`0666`** at this head, so this record draws **`0666`** and the cell
  advances to `0667`. The `unallocated (future lanes)` pool cell stays `0824`.
  The sweep behind that reading is in §Verification.
- **Relates to:** [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md)
  (§Decision 1 — the same latch shape on the confirm's pair),
  [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) (the same file's burst width)
  and [ADR-0823](ADR-0823-op132-confirm-burst-budget.md) (the fixed-budget
  repair this pin deliberately outlives), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the range policy
  this number is drawn under). No accepted record is edited.
- **Satisfies:** the routed review finding **Medium** of `t_e0b862be` (OP-132
  confirm burst budget, PR #581) — "the existing pair pin is nondeterministic" —
  which is card `t_6f2bc11c`; the pin it hardens is `I5` of
  `event-invitation-decisions.test.ts`.
- **Schema:** n/a · **Contract:** §2.3 (a decision is final and idempotent; a
  double click never errors).

## Context

`I5` fires two `POST /api/v1/me/invitations/{invitationId}/accept` calls for the
same invitation through `Promise.all` and requires `[200, 200]` plus one
`event_organizers` row and one `collab.invite.accepted` outbox row. It was
**nondeterministic**: the `ci` job of head `5e4feae` passed it, while
`test_coverage` (job `132092056139`, run `43485305859` attempt 1) answered

```
× I5: two concurrent accepts create exactly one membership row 422ms
route /api/v1/me/invitations/:invitationId/accept  event http.error  status 500
  "message": "transaction retry limit reached after 3 attempts"   (TransactionRetryLimitError)
  at decideInvitation (apps/web/src/server/collaboration/invitation-transition.ts:266)
  at .../me/invitations/[invitationId]/accept/route.ts:21
AssertionError: expected [ 200, 500 ] to deeply equal [ 200, 200 ]
```

and 12 of 12 isolated local runs of the file were green.
`Promise.all` alone is a coin flip: the second request's admission (session,
tenant stage, invitation read) costs several round trips, so by the time it opens
its transaction the winner has usually committed, its conditional
`findOneAndUpdate` matches nothing, and it answers `200 alreadyResolved: true`
without ever contending. The pair only reddens when the loser's transaction
overlaps the winner's — the shape ADR-0816 §Decision 1 already fixed for the
confirm's pair.

## Decision

1. **The pair meets at the transaction boundary.** `I5` arms
   `invitationRaceGate.close(CONCURRENT_ACCEPTS)` before `Promise.all`; the
   file's pass-through `vi.mock` of `@/server/db/transaction` holds every racer
   there, and the racer that meets a peer releases the pair. The grace
   (`INVITATION_RACE_GRACE_MS = 250`) releases a lone racer that no peer ever
   joins, so a **serialising** implementation — which never brings the second
   request to this line — is let through and answers `200`. The latch is armed
   only by this case; every other transaction in the file passes through
   untouched.
2. **Meeting was not enough, so the met pair is held past its writes.** Measured
   on the trunk with the boundary latch alone: **3 of 3 runs green**, the loser
   logging `db.transaction.retry` at `attempt: 2` and `attempt: 3` (5 ms apart)
   and then reading the row the winner had already committed. The margin is a
   clock, not a contract. The mock therefore wraps the transaction body: once a
   racer has met a peer, its callback result is held for
   `INVITATION_RIVAL_HOLD_MS = 100` before it returns, so the winner's commit
   lands after the loser has spent its budget. 100 ms is ~14× the measured 3
   attempts and is well inside the bounded-wait ceiling this file's member
   removal repair already uses (25 ms poll, 1 s ceiling), so a repair that waits
   for the settled row still answers in time.
3. **The shipped assertions are unchanged.** The case keeps
   `expect([first.status, second.status]).toEqual([200, 200])`, the two
   `status: "accepted"` payloads, exactly one `alreadyResolved: false`, one
   `event_organizers` row for the invitee, one `organizer` row and one
   `collab.invite.accepted` outbox row. No assertion text, no fixture and no
   helper is edited; the diff is additive.
4. **No production code is touched.** The accept route, `decideInApp` and
   `invitation-transition.ts` are byte-identical to `origin/main` `a9c6d59`. The
   repair is the separate GREEN card `t_ed6d5933`.
5. **A retry budget must be sized to the 100 ms hold, not to the pinned race,
   and a busy retry loop is not the shape this pin selects.** Measured on this
   spec at `b5a01dc`: `maxAttempts` `3`, `5` and `20` answer
   `1 failed | 49 passed (50)` (2 of 2 runs each), and `60` and `120` answer
   `50 passed (50)` (2 of 2 each), so the edge is about **57** attempts. A
   budget derived from the contention (one attempt per rival — 2 or 3) fails,
   and so does any small budget, because each attempt is one round trip and the
   met pair's commit is held 100 ms. A budget of 57 or more does pass, but it is
   a busy retry loop against a clock, not an answer from the settled row. So the
   pin still selects the settled re-read (or serialising the pair) — see
   §Consequences.

## Consequences

- **The pin is deterministic and red on the trunk.** 10 of 10 consecutive
  focused runs failed, every one with exactly one `200` and one `500`: six
  `expected [ 200, 500 ] to deeply equal [ 200, 200 ]`, four
  `expected [ 500, 200 ]`. The order of the two statuses flips with which racer
  wins the row's write lock; the multiset never does. The route log carries the
  same line the CI evidence carried — `event: http.error`, `status: 500`,
  `"transaction retry limit reached after 3 attempts"`, `TransactionRetryLimitError`
  raised at `transaction.ts:63`, through `decideInvitation`
  (`invitation-transition.ts:266`) and `accept/route.ts:21`.
- **A lone racer is still let through.** With the latch armed and only one
  accept fired, the request answered `200` in a case whose duration grew by the
  250 ms grace and **not** by the 100 ms hold, which is the measured proof that
  the serialising path neither hangs nor is held.
- **A retry budget must be sized to the 100 ms hold, not to the pinned race.**
  Measured on this spec at `b5a01dc`, whole file, two runs each: `maxAttempts`
  `3`, `5` and `20` answer `1 failed | 49 passed (50)`; `60` and `120` answer
  `50 passed (50)`, so the edge is about **57** attempts. Each attempt is one
  round trip and the met pair's commit is held 100 ms, so no rival-count budget
  (2 or 3) and no small budget carries the loser past the hold. A budget of 57
  or more does carry it, but that is a busy retry loop against a clock. The
  contract §2.3 asks for is that the loser answers from the invitation's settled
  state, and the repair shape this file already uses for the concurrent member
  removal (catch `isTransactionRetryLimitError`, wait bounded, re-read, answer
  the settled status) satisfies the pin; serialising the pair does too.
  ADR-0823's shape 1 (a rival-count budget) is not _forbidden_ by this pin — it
  is unsatisfiable at that size. This is the one constraint the GREEN card
  `t_ed6d5933` inherits — it is a decision of this record, not an oversight.
- **Cost.** The case pays one grace (250 ms) when an implementation serialises
  and one hold (100 ms) per met racer otherwise; the whole file stays at
  `1 failed | 49 passed (50)`.
- **Not weakened in the red direction.** The hold is bounded and short: it
  cannot make a _correct_ implementation fail, because a correct implementation
  answers the loser from the row the winner committed, and that row is committed
  within the hold.

## Alternatives

- **Retry the pair N times and assert every round** (ADR-0821's shape for the
  burst width). Rejected: each round is a fresh event loop and a fresh coin
  flip, so a red rate below 100 % stays a flaky pin, and ten rounds would cost
  ten fixtures to buy what one latch gives deterministically.
- **Stagger the pair with a timer.** Rejected — a time-based stagger is not a
  pin (ADR-0816 §Decision 1); it depends on the machine.
- **Force `maxAttempts: 1` in the mock so any conflict is a `500`.** Rejected as
  dishonest: it would make the RED by construction, would not measure the
  shipped budget, and would also legitimise a repair that is only a budget
  change.
- **Hold the winner until the loser settles.** Rejected: a repair that waits for
  the settled row would deadlock against the hold and fail a correct fix. The
  hold is time-bounded for that reason.

## Verification

Measured on `origin/main` `a9c6d59` (worktree
`/root/openpic/openpic-webapp/.worktrees/t_6f2bc11c`, branch
`OP-121-task-invitation-accept-race-pin`).

- **Before** (shipped `I5`, no latch): 3 of 3 focused runs green, `Tests 1 passed
| 49 skipped (50)`.
- **Boundary latch only**: 3 of 3 focused runs green, each logging one
  `db.transaction.retry` pair (`attempt: 2`, `attempt: 3`, ~3–5 ms apart) and
  `statuses 200 200`.
- **Boundary latch + rival hold**: 10 of 10 focused runs red, exactly one `200`
  and one `500` each.
- **Whole file**: `Test Files 1 failed (1)`, `Tests 1 failed | 49 passed (50)`,
  the only failure `I5`.
- **Full project**: `1 failed | 1341 passed (1342)` — the only failure `I5`. An
  earlier run of the same tree also timed out two unrelated files at the 5 s
  default (`index-bootstrap.test.ts` I6, `notification-otp-catalogue-fallback.test.ts`
  F2); both are green in isolation (`2 files / 11 passed`) and green in the next
  full run, so those were load flakes, not this change.
- **CI on the PR head**: `Test Files 1 failed | 308 passed (309)`, `Tests 1
failed | 4283 passed | 3 skipped (4287)`, the only failure `I5` with
  `AssertionError: expected [ 200, 500 ] to deeply equal [ 200, 200 ]` and the
  same `TransactionRetryLimitError` frames (`test_coverage` job `132147184617`
  on `20b3e68`, and identically `[500, 200]` in job `132150723455` on `79a7811`);
  the `ci` job's unit project is green (`178 files / 2938 passed | 3 skipped`)
  and its integration project is `1 failed | 1345 passed (1346)` (job
  `132150722419`). So the pin reddens on CI as well as locally, which is the
  property the case lacked.
- **Grace path**: an armed latch with a single racer answers `200`.
- **Fixed-budget bound.** Measured by the round-1 review of `t_6f2bc11c` in a
  throwaway worktree at `b5a01dc`, on this spec, two runs each; the probe set
  `withTransaction(fn, { maxAttempts: n })` at the accept transition's call site
  in `invitation-transition.ts` and was not committed. `maxAttempts` `3`, `5`
  and `20` → `1 failed | 49 passed (50)`; `60` and `120` → `50 passed (50)`.
  The edge is about `57` attempts.
- **ADR number sweep.** Both `Next free` cells read `0666` (OP-120 invitations
  lane) and `0824` (`unallocated (future lanes)`). Every open PR head was
  inspected — #584, #577, #575, #573, #570, #545, #539, #373, #369, #361, #336,
  #279, #278, #276, #272, #270 — and the highest ADR any of them adds is `0820`
  (PR #575). `git ls-tree` over every local and remote branch found **no**
  `ADR-0666`–`ADR-0679` on any ref, and `origin/main` `a9c6d59` carries at most
  `ADR-0665` in this block (`ADR-0823` overall). `0666` is therefore the lane
  row's own next free number, and the lane cell advances `0666` → `0667`; the
  pool cell is untouched because this lane still holds a reserved range
  (ADR-0300 §2).
