# ADR-0817 — OP-132 GREEN: the concurrent confirm re-reads its delivery row inside the transaction

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts` —
  the `newMatches` / `dedupeKey` / `alreadyPublished` / `willPublish` block inside
  `withTransaction`, and the two docblock paragraphs that name this record.
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md) and
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) precedent. At this
  head **both `Next free` cells read `0817`**, and the sweep found `0813` (PR
  #569), `0814`/`0815` (PR #565) and `0816` (this lane's pin, PR #570) in flight;
  no ref and no `.worktrees/*/docs/adr` carries `0817`, so this record draws
  **`0817`**. Both cells then read `0818`, but that is a **snapshot at this head,
  not a claim**: `0818` was in flight on the draft PR #573 when this record was
  cut, and it has since landed on the trunk as
  [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md) (PR #584, `5a0c8e05`),
  whose own revision the still-open PR #573 carries. The cells have moved past it
  since.
- **Amends:** [ADR-0806](ADR-0806-op132-confirm-publication-green.md) §Decision —
  its read-before-the-insert is replaced by a read inside the transaction. The
  record is not edited.
- **Consumes:** `0817`.
- **Satisfies:** the pin of
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) (case 5, "when the
  same selfie is confirmed twice at the same instant"), whose spec file is carried
  unchanged.

## Context

The confirmation decides whether to publish with one read:

```ts
const willPublish =
  newMatches > 0 &&
  (await platformRepo(db)
    .collection(COLLECTIONS.domainEvents)
    .countDocuments({ dedupeKey }, { limit: 1 })) === 0;
```

That read ran **before** `withTransaction`. Two simultaneous confirms for one
selfie both read `0`; the loser's insert collides on the outbox's unique partial
index on `dedupeKey`, the duplicate-key write aborts its transaction, and the
three attempts of `withTransaction` are spent on the same collision, so the
handler answers `500 internal_error` / `TransactionRetryLimitError` (measured
three runs in three by the review of `t_ed3785df`, and again at this branch cut,
§Evidence).

## Decision

1. **The dedupe read moves inside the transaction, with its session.** The
   callback derives `alreadyPublished` from
   `countDocuments({ dedupeKey }, { limit: 1, session })` and `willPublish` from
   it; the §15.3 watermark stamp and the `emitDomainEvent` call both hang off
   that one in-transaction value. An existing row is "already published": the
   racer emits nothing and still commits its state writes.
2. **The retry is what makes the second read see the truth.** The loser's
   transaction is aborted by the write the two racers share; the driver re-runs
   the callback, the new attempt's snapshot begins after the winner committed, so
   the re-read finds the row and the attempt commits without an emit. Both
   requests answer the same seven-key `200`, and the outbox holds one row.
3. **Nothing else moves.** The envelope, the five existing status codes, the
   `dedupeKey` shape, the unique partial index (still the arbiter), the
   watermark/outbox atomicity and the sequential repeat behaviour are unchanged.
4. **The duplicate-key collision is not caught.** The abandoned shape 2 (widen
   the catch around the transaction) was measured to leave the whole pin file
   **and** a genuine database failure green (`5 passed (5)`, 3/3 runs): the
   masked failure answers `200 status: "ready"` with no activation, no watermark
   and no notification. A narrow catch would have to give up the single atomic
   unit (watermark + state writes + outbox row) that ADR-0806 established, for no
   gain the re-read does not already provide.

## Consequences

- **What it trades away.**
  1. _The pre-filter is gone._ The publication decision can no longer be answered
     without opening the transaction, so one read now sits on the transaction's
     critical path instead of in front of it. The route already opened exactly
     one transaction per confirm, so no second transaction is added and the
     common sequential path pays one session-bound read where it paid one free
     read.
  2. _The repair leans on the retry budget._ One lost racer needs attempt 2 of
     `DEFAULT_TRANSACTION_MAX_ATTEMPTS` (3); the pin's shape is a pair, so one
     retry is the headroom used and nothing is left over for a burst. A storm of
     `N > 2` simultaneous confirms is not pinned and not measured here.
  3. _The collision itself remains._ The unique partial index still arbitrates
     the write; the change makes the loser's collision recoverable rather than
     impossible, so the design still depends on that index existing.
- A double-tap or a client timeout-retry now answers `200` with one
  `attendee.matches.new` row instead of a `500` that follows a successful
  activation.
- A repeat confirm still answers the same envelope and emits nothing, now because
  the in-transaction read finds the row (one read, no retry).
- The `db.transaction.retry` warn line that a concurrent pair produces is
  accepted, and deliberately not asserted on: a future fix that serialises the
  pair would produce none, and ADR-0816 §Alternatives already rejected pinning
  the retry taxonomy.

## Alternatives

- **Emit outside the transaction and let `{ deduped: true }` stand (card shape
  2).** Rejected: the watermark and the outbox row stop being one atomic unit,
  and a crash between the commit and the emit leaves an activation result that
  no publisher ever announces.
- **A narrow catch of the duplicate-key abort (card shape 2, narrowed).** Rejected
  for the same atomicity loss plus a second failure mode: the driver reports a
  duplicate-key write as a `MongoServerError` that a caller-side predicate has to
  distinguish from a real write failure, and getting that predicate wrong is the
  measured false-accept above.
- **A per-selfie `notifiedAt` stamp as the guard (card shape 3).** Not available:
  §16.4's `selfies` row carries no notification field, and §15.3's
  `firstMatchNotifiedAt` is per **profile**, so a conditional update on it would
  let the first selfie win and silently suppress the second selfie's delivery —
  which ADR-0805 case 2 pins as `count: 2`.
- **An in-process serialiser in front of the transaction.** Rejected: it is a
  per-process queue (the ADR-0804 shortcut), so two app instances still race, and
  it would buy latency in place of the storage's own arbitration.
- **Make `emitDomainEvent` upsert on `dedupeKey`.** Rejected: it changes the
  shared writer for one caller; every other publisher's dedupe semantics would
  move with it.

## Evidence — measured on this branch (`OP-132-task-concurrent-confirm-green`)

- **RED before the change**, at the pin's head `1030322`:
  `AssertionError: the two simultaneous confirms answered [200,500]; both must be
200`, `Tests 1 failed | 4 passed (5)`.
- **GREEN after the change**: `Tests 5 passed (5)` on three consecutive focused
  runs (`5.69 s`, `5.06 s`, `5.15 s` of wall time for the file) — the pair
  finishes through the retry path, not through the latch's 250 ms expiry.
- **The three shipped ADR-0805 cases and the ADR-0808 late-publication cases are
  untouched** and pass (`4 passed` beside the new case), and the five neighbouring
  integration files that drive the same route are `49 passed (49)`
  (`liveness-selfie-submit`, `selfie-reuse`, `selfie-reuse-attempt-cap`,
  `selfie-zero-match-and-reusable-pages`, `attendee-participation-status`).
- The spec file is carried byte-identically from `1030322` (`git diff` touches no
  test), and so is the [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md)
  record (`git diff 1030322 --` is empty for both).
- **CI on the head `ed24de6`**: all 14 checks of PR #571 pass — `unit_test`,
  `test_coverage` (the full unit + integration projects under the coverage
  thresholds) and the aggregate `ci` (integration, 9m09s) among them.
  `notify-discord` runs only after the merge, so it is not a gate. The head this
  sentence first named, `a9ec3f2`, was a **pre-rebase** head and is not an
  ancestor of the merge; `ed24de6` is the PR's `headRefOid`, and the whole-tree
  diff `git diff ed24de6 a49599c` is empty (see the sign-off below).
- **Local whole-suite caveat, measured rather than glossed.** The full
  unit + integration run passed `4202` tests before the rebase onto `main`
  `e322a92`; after it, two whole-suite runs on this loaded machine hit 5 s
  timeouts in eight files that this change does not touch
  (`notification-*`, `index-bootstrap`, `me-current-user`,
  `me-notification-preferences`); all of them pass in isolation (`6 files / 53
passed`), and CI's `test_coverage` run on the same head is clean. No failure
  was in the confirm route, the spec, or any file this branch edits.

## Review sign-off (OP-132 GREEN t_6e62ee84, round 1 — artifact + execution lens)

**Verdict: APPROVED WITH FINDINGS.** The delivery is PR #571, reviewed at head
`ed24de6` and merged as the squash `a49599c`. The whole-tree diff
`git diff ed24de6 a49599c` is empty, so every figure below holds at both commits.
The reviewer edited no production file, no test file, no fixture and no mock: the
reviewed SHA is the SHA that shipped. Nothing in §Context, §Decision,
§Consequences or §Alternatives is retracted. This section is an append, plus the
two in-place corrections below.

### The two corrections

1. **§Evidence named a head that never shipped.** The CI sentence read `a9ec3f2`.
   That is a **pre-rebase** head: `git merge-base --is-ancestor a9ec3f2 a49599c`
   is false. The branch's commits are `8dcb308` → `417f6e1` → `ed24de6`, the PR's
   `headRefOid` is `ed24de6`, and the fourteen checks pass there. The sentence
   now names `ed24de6`.
2. **§Lane read a snapshot as a claim.** The sentence said "both cells advance to
   `0818`". `0818` was the next free number **at this head**. It was not a
   reservation this record made: `ADR-0818` was in flight on the draft PR #573 at
   the cut and has since landed on the trunk (PR #584, `5a0c8e05`). The sentence
   now says so.

### What the review measured, at the reviewed head

- **The pin is green through the retry path, not around it.** The focused file
  `selfie-confirm-publication.test.ts` is `5 passed (5)` on **3 of 3 runs**, and
  each run logs `db.transaction.retry` at **attempt 2 / maxAttempts 3** (the
  default in `apps/web/src/server/db/transaction.ts:22`). The loser really runs
  its callback a second time.
- **The pin and ADR-0816 were carried, not rewritten.** `git diff 1030322 HEAD --`
  is empty for `selfie-confirm-publication.test.ts` and for
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md).
- **Full `unit`:** 178 files, **2938 passed / 3 skipped**, exit `0`.
- **Full `integration`:** **1 failed | 1321 passed**. The one failure is
  `notification-digest-flush-claim-lease.test.ts` › _honours a claim that is not
  yet stale…_, `Test timed out in 5007ms`. The same file is **4 passed (4) in
  isolation on 3 of 3 runs**. Two sibling worktrees ran integration suites at the
  same time, so the cause is load, not a regression. No case in the confirm
  route, in the pin, or in any file this delivery edits failed.
- **`tsc`, `eslint`, `prettier`:** clean.
- **The numbering guard:** `adr-numbering` **29 passed (29)**, and `0817` is
  unique across every ref and every `.worktrees/*/docs/adr`.
- **The merged trunk, re-checked at `a49599c`:** the same focused file is
  `5 passed (5)` and the same guard is `29 passed (29)`.

### Post-review status, routed and not retracted

§Consequences item 2 says a storm of `N > 2` simultaneous confirms "is not pinned
and not measured here". The reviewer has since measured it, with the pin's own
bounded-latch method (`confirmRaceGate.close(n)`, then `Promise.all`):

- burst **3** → `[200,200,200]`
- burst **4** → `[200,200,200,500]`
- burst **6** → `[200,200,200,200,500,500]`

Each `500` is a `TransactionRetryLimitError` (`transaction retry limit reached
after 3 attempts`) at the `withTransaction(` call site, `confirm/route.ts:124`.
The state stayed correct in every arm: one `attendee.matches.new` row, and
`matchCount` 3. The three runs gave identical results, 3 of 3. At this head the
repair has **one retry of headroom** (`DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3`), so
a burst of more than three racers can spend it.

The finding went to the TEST card `t_3032fa5a` and the GREEN card `t_e0b862be`.
Both cards have landed:

- `t_3032fa5a` pinned the width-four burst and minted
  [ADR-0821](ADR-0821-op132-confirm-burst-pin.md) (draft PR #578, closed as
  superseded).
- `t_e0b862be` set an explicit attempt budget at the confirm call site and
  minted [ADR-0823](ADR-0823-op132-confirm-burst-budget.md) (PR #581, squash
  `659c0edd`).

So the width-four burst that this record disclosed as unmeasured is pinned and
green on the trunk, and ADR-0823 gives its bound. Item 2 above stays as written,
because it was true at this head.

**No new ADR number.** This record already exists and consumes nothing. The
append only points at numbers other records hold, so `docs/adr/README.md` is
byte-identical to the trunk.
