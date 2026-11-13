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
  **`0817`** and both cells advance to `0818`.
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
  test).
