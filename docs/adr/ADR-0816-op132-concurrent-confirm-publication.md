# ADR-0816 — OP-132 TEST: two simultaneous confirms answer `200` twice and notify once

- **Status:** Accepted (RED pin by design; no production change)
- **Consumers:**
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts` (case 5,
  "when the same selfie is confirmed twice at the same instant", with its
  file-level `confirmRaceGate` latch and the `vi.mock` of
  `@/server/db/transaction` that drives it).
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)
  precedent. Before minting, **both `Next free` cells read `0813`**, and the sweep
  found every number from `0813` upward already claimed:
  `ADR-0813-op132-attendee-retention-gate.md` is committed on
  `OP-132-task-attendee-retention-gate-pins` (PR #569, on `origin`); the OP-134
  lane's committed pair is `ADR-0813-op134-attendee-claim-red.md` /
  `ADR-0814-op134-attendee-claim-green.md` (PR #565), and its worktree
  `t_63619ef7` is mid-renumber with `0814`/`0815` on disk. No ref under
  `refs/heads` or `refs/remotes` and no `.worktrees/*/docs/adr` carries `0816`,
  so this record draws **`0816`** and both cells advance to `0817` (skipping the
  three in-flight numbers rather than colliding with them — the
  [ADR-0810](ADR-0810-op132-reusable-listing-page-bound.md) and
  [ADR-0811](ADR-0811-op132-attendee-selfie-upload-window.md) precedent). No lane
  row is minted.
- **Amends:** [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) §Decision 1 —
  the repeat-confirm pin, which fixes the **sequential** repeat only — and
  [ADR-0806](ADR-0806-op132-confirm-publication-green.md) §Consequences, whose
  read-before-insert is the measured cause of the defect pinned here. Neither
  record is edited.
- **Consumes:** `0816`.

## Context

The confirmation's publication dedupe (`route.ts:113-122` at the cut) is a
**read outside the transaction**:

```ts
const willPublish =
  newMatches > 0 &&
  (await platformRepo(db)
    .collection(COLLECTIONS.domainEvents)
    .countDocuments({ dedupeKey }, { limit: 1 })) === 0;
```

`dedupeKey` is `attendee.matches.new:<eventId>:<profileId>:<selfieId>` and the
outbox carries a unique partial index on it, so the read is an optimisation in
front of the real guard. Two requests that both read `0` both try to emit; the
loser's insert collides, and a duplicate-key write inside a transaction **aborts**
it (no matter that `emitDomainEvent` catches the driver error), so `withTransaction`
spends its three attempts on the same collision and the handler answers
`500 internal_error` / `TransactionRetryLimitError`.

Measured by the review of `t_ed3785df` (PR #557, head `ef8a6d3`), three runs, same
result:

```
PROBE_RESULT {"statuses":[200,500],"rows":1,"payloads":[{"count":3}],"matchCount":3}
```

[ADR-0805](ADR-0805-op132-confirm-publication-pins.md) §Decision 1 asks that a
**second confirm** answer the same `200` envelope. A double-tap or a client
timeout-retry is that second confirm, and it currently receives a `5xx` after the
selfie did activate. The three shipped cases cannot see it: they await the first
confirm before issuing the second, so the second reads the row the first one
already committed.

## Decision

1. **The race is made deterministic, because it is not deterministic by itself.**
   The card's shape is `Promise.all` of two `confirmSelfie` calls with a fresh
   `Idempotency-Key` each, and that shape was **measured passing on the defect**:
   with the pair fired plainly, one run answered `[200,200]` — the two handlers had
   drifted far enough apart that the second read the committed row. A pin that can
   pass on the bug is not a pin. Every racer therefore passes a latch at the
   transaction boundary **after** it has decided whether to publish and **before**
   its transaction opens (`confirmRaceGate`, a `vi.hoisted` counter plus a
   pass-through `vi.mock` of `@/server/db/transaction`), so both decisions are
   taken before either write can commit — precisely the window the
   read-outside-the-transaction check cannot close.
2. **The latch is bounded, so it does not prescribe a fix.** It releases when the
   racers have arrived or after `CONFIRM_RACE_GRACE_MS` (250 ms). An implementation
   that serialises confirms _before_ their transactions never brings the second
   racer to the latch and is released by the expiry — proven by measurement, not
   by argument (§Evidence). A fix that keeps both racers racing and re-reads
   inside the transaction never waits at all.
3. **The case asserts what the client sees, and nothing about the latch.** Sorted,
   the two statuses are `[200, 200]` (order is the event loop's business; the
   sorted comparison is what makes the pin order-independent and its red message
   name both statuses); each body carries the seven §6.3 keys with the same
   `selfieId` and `status: "ready"`; the two bodies are equal (one activation
   result, one answer); exactly **one** `attendee.matches.new` row exists with
   `payload.count` equal to the worker's three matches; the profile's cached
   §6.4 `matchCount` is `3`.
4. **The mechanism is not named.** Any repair that leaves one announcement and one
   answer satisfies the case: a dedupe re-read inside the transaction, a
   per-profile serialiser in front of it, or an emit that upserts. The card asks
   for the observable, and the GREEN picks the mechanism.
5. **No production code, fixture, helper or existing case is touched.** The latch
   and its mock are file-local to the spec; the four shipped cases pass through
   the latch untouched (`Tests 4 passed` beside the new case, measured).

## Evidence — measured at the branch cut (`origin/main` `e0cf073`)

- **The new case is RED, stably, with the card's failure text.** Five consecutive
  `-t "at the same instant"` runs, all identical:

  ```
  AssertionError: the two simultaneous confirms answered [200,500]; both must be 200:
    expected [ 200, 500 ] to deeply equal [ 200, 200 ]
  Tests  1 failed | 4 skipped (5)
  ```

  Each run also logged the loser's own refusal:
  `"status":500 … "message":"transaction retry limit reached after 3 attempts",
"name":"TransactionRetryLimitError"` at
  `route.ts:127` (the `withTransaction` call) — the root cause, observed rather
  than inferred. The status pair was `[200,500]` in every run.

- **The latch is load-bearing.** The same case with `confirmRaceGate.close(...)`
  removed (plain `Promise.all`, the card's literal shape) answered
  `[200,200]` on the defective tree — one run of one, i.e. it passed on the bug.
  That is why the latch is in the pin and why this record states the deviation
  from "fire two with `Promise.all`" loudly: the pair is still fired with
  `Promise.all`, with both requests held at their transaction boundary.
- **Two throwaway repairs, both green, neither in the diff.**
  1. _Re-read inside the transaction_: the emit is guarded by a
     `countDocuments({ dedupeKey }, { session })` inside the callback, so the
     driver's retry (attempt 2) sees the winner's row and skips the emit →
     `Tests 5 passed (5)`.
  2. _Serialise in front of the transaction_: the same re-read plus an in-process
     queue around the `withTransaction` call, so the second racer never reaches
     the latch → the case is green **through the 250 ms expiry path**, which is
     the property that keeps a serialising GREEN satisfiable.
     The route was restored byte-identically after each probe
     (`sha256 9660e7acdd2e95500cf37d73340f701b3051c015e0f84748353ce9d3415c9c43`
     before and after, `git status --short` shows only the spec).
- **The shipped cases cannot see the defect.** Under the same tree the file's four
  existing cases were `4 passed (4)` — measured before the new case was added and
  again as `4 passed` with the new one deselected.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint --max-warnings=0` and
  `prettier --check` clean on the spec.

## Consequences

- A double-tap, a client timeout-retry and two tabs confirming at once can no
  longer be answered with a `500` that follows a successful activation, and the
  one-notification rule now holds for the **concurrent** pair as well as the
  sequential one.
- **Known limit — the latch depends on the route's transaction seam.** It wraps
  `withTransaction` from `@/server/db/transaction`, which is the only transaction
  the confirm path opens. If a future refactor stops using that helper, the latch
  never arms and the case degrades to plain `Promise.all` (which was measured
  capable of passing on a defective tree). It cannot produce a false red.
- **Known limit — a serialising fix pays the grace.** Such a fix costs the case
  `CONFIRM_RACE_GRACE_MS` (250 ms) of wall time; that is the price of not
  prescribing the mechanism.
- **Known limit — two is the pinned shape.** A burst of `N > 2` confirms, and the
  interaction with the `selfie.submit` limiter, are not pinned here; the pair is
  what a double-tap and a retry produce.
- The record is **RED by design**: the card's GREEN is `t_6e62ee84`, which must
  not touch this spec.

## Alternatives

- **Plain `Promise.all` with no latch (the card's literal wording).** Rejected by
  measurement: one run of the defective tree answered `[200,200]`. Keeping it
  would ship a pin that reports the bug as fixed one run in three.
- **Assert on the retry log (`db.transaction.retry` sink lines, the OP-121
  shape).** Rejected: it pins the retry taxonomy, so a fix that avoids the
  collision by serialising (zero retry lines) would be red for being _better_.
  The client's statuses are the contract.
- **Park each racer on the `systemClock` port instead.** Rejected: the clock is
  read in `requireAttendeeScope` before the profile and selfie reads, and on the
  route's own line 100 — parking there leaves the read-to-commit drift intact,
  which is exactly the drift that let a defective tree pass.
- **Answer the loser `4xx` (a `409` "already confirmed").** Rejected: §6.3 says a
  second confirm answers the same seven-key `200`; a `409` is a different contract
  and would fail the shipped repeat-confirm case.
- **Assert the loser's error code.** Rejected: it makes the `500` a documented
  answer instead of the defect, and the card asks for two `200`s.

## Out of scope

- The GREEN's mechanism, its record, and any change to `route.ts` (card
  `t_6e62ee84`).
- A storm of `N > 2` simultaneous confirms, and whether the confirm route should
  mount the §0.11 limiter its sibling selfie writes do (owner: the contract's
  rate-row owner, not this pin).
- The pipeline's own publisher (`POST /api/v1/internal/domain-events`, OP-135):
  the `withTransaction` seam this pin uses is the confirmation's, and the shared
  delivery identity is already pinned by
  [ADR-0808](ADR-0808-op132-late-match-publication-ownership.md) §3.
