# ADR-0823 — OP-132 GREEN: the confirmation's transaction budget covers a burst of four

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts` —
  the `CONFIRM_MAX_ATTEMPTS` constant, the `{ maxAttempts: CONFIRM_MAX_ATTEMPTS }`
  option on the confirm's `withTransaction` call, and the docblock paragraph that
  names this record.
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md),
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) and
  [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) precedent. At this head **both
  `Next free` cells read `0822`**, and the sweep found `0822` in flight:
  `ADR-0822-op134-my-events-gallery-url-green.md` on
  `OP-134-task-me-events-gallery-url-empty` (PR #579), which is also the highest
  number carried by any object of any ref
  (`git rev-list --objects --all -- docs/adr`), the highest in any
  `.worktrees/*/docs/adr`, and the highest on any open PR head (`#573`–`#580`
  inspected). `0823` is carried by nothing, so this record draws **`0823`** and
  both cells advance to `0824`. No lane row is minted.
- **Amends:** the "known limit" 2 of
  [ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) §Consequences ("the
  repair leans on the retry budget … a storm of `N > 2` … is not pinned and not
  measured here") and the "known limit" of
  [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) §Consequences (the burst is
  pinned and red). Neither record is edited.
- **Satisfies:** the pin of
  [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) — the F3.5 describe in
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts`, carried into
  this branch **unchanged** (`git diff 4b4203d -- <spec>` is empty).
- **Consumes:** `0823`.

## Context

[ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) moved the confirm's
dedupe read inside `withTransaction`, so a racer that loses the shared write is
retried whole and its next attempt reads the winner's committed outbox row and
commits without emitting. That recovered the **pair** with exactly one retry of
headroom: `DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3`
(`apps/web/src/server/db/transaction.ts:26`) means three attempts in total.

The burst pin measured the width that budget does not cover. On the pin's branch
tip `4b4203d` this branch reproduced it before the change: **5 of 10** burst
rounds failed with
`the four simultaneous confirms answered [200,200,200,500]; all four must be 200`
— `Tests 5 failed | 10 passed (15)`, the five shipped cases green. The `500` is
`TransactionRetryLimitError` raised at the confirm's `withTransaction` after the
selfie did activate, which is the F3 defect class (an attendee reads a failure
after their selfie succeeded).

## Decision

1. **Raise the attempt budget for this one transaction (card shape 1).** The
   confirm calls `withTransaction(fn, { maxAttempts: CONFIRM_MAX_ATTEMPTS })` with
   `CONFIRM_MAX_ATTEMPTS = 5`, using the option `transaction.ts` already
   documents. `DEFAULT_TRANSACTION_MAX_ATTEMPTS` stays `3`: the default is the
   budget of every other transaction in the app, and raising it globally would
   pay this route's worst case on queues, billing and fan-out that no test
   measures.
2. **`5` is derived, not tuned to the fixture.** A burst of `N` confirms for one
   selfie costs the unluckiest racer one attempt per rival commit, so `N - 1`
   losses; the pinned burst is `N = 4`, which needs 4 attempts, and the fifth
   absorbs an abort that produces no commit at all — two rivals aborting each
   other make no progress, so that attempt is spent without a rival committing.
   Measured on this head: the deepest attempt reached over 15 rounds was
   **attempt 5** and it committed, so a budget of four would have answered `500`
   in that sample; attempt `4` was reached in 5 of 55 retry lines.
3. **Nothing else moves.** The single atomic unit of ADR-0806 survives — the
   §15.3 `firstMatchNotifiedAt` stamp, the `activeSelfieId`/`status`/`matchCount`
   writes and the `attendee.matches.new` insert still commit together or not at
   all. No error is caught, no collision is swallowed, the envelope, the five
   status codes, the `dedupeKey` shape and the sequential repeat behaviour are
   unchanged.

## Consequences

- **What the bound covers.** Up to five simultaneous confirms for one selfie (the
  worst case needs `N` attempts) answer `200`; the pinned burst of four answers
  four `200`s and one notification over every round measured. The five shipped
  cases — the repeat, the two ADR-0805 cases, the ADR-0808 pair and the ADR-0816
  pair — stay green **unedited**.
- **What it trades away.** A storm **wider than five** simultaneous confirms still
  exhausts the budget and answers `500` for the unluckiest racer, after the
  activation succeeded; the bound moved, it did not disappear. A racer that loses
  can also spend up to four extra attempts (four `db.transaction.retry` warn
  lines and its state writes replayed), which is request latency only — this route
  writes no side effect outside the transaction.
- **No new failure mode.** Every attempt runs the identical callback behind the
  same unique partial index, so an exhausted budget still means "this racer never
  committed", never "this racer answered `200` without publishing" — the
  false-accept shape 2 below was rejected for.
- **Sequential behaviour is untouched**: a repeat confirm still opens one
  transaction, takes no retry and emits nothing.

## Alternatives

- **Recognise the duplicate-key abort narrowly inside the callback (card
  shape 2).** Rejected on measurement, not taste: the broad form is the
  false-accept of `t_6e555aa3` — the file **and** a genuine database failure stay
  green while the handler answers `200 status: "ready"` with no activation, no
  watermark and no notification. A predicate narrow enough to be safe would have
  to distinguish the outbox index's duplicate key from every other write failure
  in the same callback, and it would still give up the single atomic unit.
- **A per-selfie conditional stamp (card shape 3).** Not available: §16.4's
  `selfies` row carries no notification field, and §15.3's `firstMatchNotifiedAt`
  is per **profile**, so a conditional update on it would let the first selfie win
  and suppress the second selfie's `count: 2` delivery (ADR-0805 case 2).
- **A per-process serialiser in front of the confirm.** Rejected: it is the
  ADR-0804 shortcut — two app instances still race, and it buys latency in place
  of the storage's own arbitration.
- **Make `emitDomainEvent` upsert on `dedupeKey`.** Rejected: it moves the shared
  writer's dedupe semantics for one caller, and a colliding insert inside a
  transaction aborts the transaction either way.

## Evidence — measured on this branch (`OP-132-task-confirm-burst-budget`, base `4b4203d`)

- **RED before the change**: `Tests 5 failed | 10 passed (15)` on the burst file,
  five rounds answering `[200,200,200,500]`, the five shipped cases green.
- **GREEN after the change**: `Tests 15 passed (15)` on **five consecutive
  focused runs** (50 burst round-samples, all four `200`s), and a sixth run used
  for the attempt histogram (`2`×31, `3`×18, `4`×5, `5`×1 retry lines).
- The burst spec is byte-identical to the pin head (`git diff 4b4203d -- <spec>`
  empty), and the five shipped cases are unedited.
- Full `unit` + `integration` suites, `tsc`, `eslint` and `prettier` were run at
  this head; see the card handoff for the counts.
