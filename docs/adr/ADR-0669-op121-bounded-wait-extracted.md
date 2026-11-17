# ADR-0669 — OP-121 refactor: one bounded wait, an exact ceiling, and the read cost on the record

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/server/db/retry-wait.ts` — the `RIVAL_COMMIT_TIMEOUT_MS` /
  `RIVAL_COMMIT_POLL_MS` constants, the `sleep`, the `waitForCommitted` loop and
  the docblocks that name this record.
- **Lane:** the **OP-120 invitations lane** block `0660`–`0679`. At this head the
  lane's `Next free` cell read **`0669`**; the sweep in §Verification found
  `0669` on no ref, no `.worktrees/*/docs/adr` and no open PR head, so this
  record draws **`0669`** and the cell advances to `0670`. Both
  `unallocated (future lanes)` cells stay at their merged value `0828`: the lane
  still holds a reserved range, so nothing is drawn from the pool
  ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §2).
- **Amends:** [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md)
  §Decision 2 and §Consequences — the bounded wait that record specifies now has
  **one** implementation and a ceiling that equals the one it documents. The
  decision itself is unchanged and nothing in that record is retracted.
  [ADR-0664](ADR-0664-op121-invitation-decisions-green.md) §Amendment's copied
  loop moves into the same module.
- **Relates to:** [ADR-0668](ADR-0668-op121-accept-expiry-arm-pin.md) — the pin
  that measures this wait's expiry arm, which is the arm the exact ceiling moves
  by 25 ms.
- **Consumes:** `0669`.
- **Schema:** n/a · **Contract:** §2.3 (a decision is final and idempotent) and
  §0.7 (an already-terminal transition is success) — both unchanged.

## Context

The round-1 review of the OP-121 GREEN (`t_ed6d5933`, PR #597, squash
`e8a1fd3`) routed three findings about the bounded wait the GREEN had added, and
none of them is a behaviour defect:

- **F2 (Low) — the wait was duplicated verbatim.** `RIVAL_COMMIT_TIMEOUT_MS`,
  `RIVAL_COMMIT_POLL_MS`, `sleep` and the poll loop existed twice:
  `invitation-transition.ts:54-101` (`rivalDecisionCommitted`) and
  `members/[userId]/route.ts:69-109` (`rivalRemovalCommitted`). A change to the
  ceiling or the interval had to touch two files, and the two copies could
  drift.
- **F3 (Info) — the documented ceiling was 25 ms optimistic.** The loop was
  `for (let waited = 0; waited <= RIVAL_COMMIT_TIMEOUT_MS; waited += 25)` with a
  25 ms `sleep` at the end of **every** iteration, so after the poll at
  `waited = 1_000` it slept once more: 41 sleeps of 25 ms (`1 025 ms` of sleep,
  computed from the loop) plus query time, while the docblock and
  [ADR-0667](ADR-0667-op121-invitation-accept-settled-reread.md) §Decision 2 say
  "at most `RIVAL_COMMIT_TIMEOUT_MS`".
- **F4 (Low) — the failure path multiplies reads, and the ADR recorded only its
  latency.** The wait is entered on **every** `isTransactionRetryLimitError`,
  including a primary that is genuinely saturated with no rival decision: up to
  41 sequential `findOne` round trips before the original `500` surfaces.
  §Consequences of ADR-0667 records that path's latency, not its read cost.

## Decision

1. **One wait, one pair of constants.** The two constants, the `sleep` and the
   loop move into `@/server/db/retry-wait` as
   `waitForCommitted(read, isSettled)`. Both call sites delegate to it and keep
   their predicates byte-for-byte: `status !== "pending"` for the invitation and
   `revokedAt !== null && revokedAt !== undefined` for the member row. The
   per-site functions (`rivalDecisionCommitted`, `rivalRemovalCommitted`) stay,
   so each call site keeps the docblock that names the race it answers and the
   record that explains it.
2. **The ceiling bounds the wait, not the poll count.** A poll is taken at
   `0, 25, … 1_000` ms and the loop sleeps only when another poll will follow,
   so the last check lands **at** the ceiling instead of one interval past it.
   The read count is unchanged at 41; only the trailing 25 ms sleep is gone, so
   the documented `1_000 ms` is now the measured bound.
3. **The poll stays linear, and the read cost is recorded rather than engineered
   away.** A backoff would keep the same ceiling but lengthen the answer for a
   winner that commits late — and the pinned pair's hold is 100 ms, one quarter
   of the wait, so the answer must stay within one interval of the commit. The
   worst case is therefore stated instead: **41 sequential reads** across one
   second, paid only by the loser of a race that no winner settles (a saturated
   primary, where the original `500` is the answer anyway).
4. **Nothing else moves.** The invitation-accept pair, the member removal, the
   `410 revoked` / `410 expired` arms, the `409 conflict` arm, the sequential
   repeat and every atomic unit are untouched, and the pin spec
   `apps/web/src/test/integration/event-invitation-decisions.test.ts` is not
   edited.

## Consequences

- **The documented ceiling is the measured one.** A never-settled read against
  the extracted helper measured `41` reads in `1 009 ms`; a read that settles on
  its third poll measured `3` reads in `51 ms`. The previous loop slept a 41st
  time, so it cost `≈1 025 ms` of sleep for the same 41 reads.
- **The read cost is now on the record.** 41 sequential `findOne` calls are the
  ceiling of the failure path (`1_000 / 25 + 1`). They are paid only when the
  wait is entered — a request that never races pays nothing, because the catch
  is not entered — and only by a caller whose answer is the original `500`
  unless a rival does commit within the second.
- **Both arms of the helper are pinned by tests that already ship.** `E1`
  (ADR-0668) drives the never-settled arm to `return false` after the full
  41-poll wait, `I5` (ADR-0666) drives the settled arm at the first or second
  poll, and `R2` drives the member-removal arm. The refactor adds no new pin and
  none is needed: the helper has no branch the shipped specs do not reach.
- **What it still does not cover.** A winner whose transaction stays open longer
  than the ceiling keeps its original `500`, as ADR-0667 §Consequences states and
  as the `shortcut:` comment on the constants repeats. A shared per-resource
  lock would bound the wait to one round trip, at the cost of a cross-request
  queue this endpoint does not need yet.

## Verification

- **The pin spec is carried unchanged:** no diff on
  `apps/web/src/test/integration/event-invitation-decisions.test.ts`; the focused
  file ran `51 passed (51)` (`17.99 s`).
- **The ceiling probe** (a throwaway `node --experimental-strip-types` script
  against the extracted module, deleted after the run): `{settled: false, reads:
41, elapsedMs: 1009}` for a read that never settles and `{settled: true, reads:
3, elapsedMs: 51}` for one that settles on its third poll.
- **Static gates:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint
  and `prettier --check` clean on the three touched source paths.
- **Suites:** full `unit` green, full `integration` green (counts in the
  handoff).
- **ADR guards:** the `adr-*` files green after the record and the ledger row
  were added.
- **Number sweep for `0669`:** the lane cell read `0669`; `git rev-list
--objects --all -- docs/adr` carries no `ADR-0669`; every
  `.worktrees/*/docs/adr` and the five open OP-13x PR heads were swept and carry
  none.

## Alternatives

- **Keep the two copies and record why (F2's other branch).** Rejected: the two
  copies had already drifted in wording, and the card's acceptance asks for one
  implementation and one pair of constants.
- **Keep the trailing sleep and change the wording to "at most
  `RIVAL_COMMIT_TIMEOUT_MS` + one poll interval".** Rejected: it makes a
  documented bound a two-term expression for no behaviour, when deleting one
  `sleep` makes the constant the whole truth.
- **Exponential backoff inside the same ceiling.** Rejected: it spends the
  ceiling on fewer, later polls, so a winner that commits at 900 ms is answered
  later than it is today — the wrong trade for a 100 ms hold.
