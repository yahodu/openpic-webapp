# ADR-0853 — OP-136 TEST: a failed sweep step must not lose the outbox row

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_535ab5d2` (High; finding **F3** of the review of the
  GREEN `t_d18a6e9e`; branch `wt/t_535ab5d2`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_535ab5d2`). The GREEN that carries
  these pins forward is `t_8901d758`.
- **Implements:** contract §10.2 (the `account-deletion-purge`,
  `verification-nudge`, `invitation-expiry` and `event-window-sweep` rows), §1.4,
  §12 (the completion receipt is _addressed to the last known email_, resolved
  from the retained tombstone), §2.3, §4.5; schema §13.2, §18.3.
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §5 (the sweeps' shapes),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (what shipped, and the review's F3
  measurement), [ADR-0851](ADR-0851-op136-usage-latch-scoped-to-period.md).
- **Consumers:** `apps/web/src/test/integration/job-sweep-failure-windows.test.ts`
  (the four pins) and the four modules they constrain —
  `apps/web/src/server/jobs/account-deletion-purge.ts`,
  `…/verification-nudge.ts`, `…/invitation-expiry.ts`,
  `…/event-window-sweep.ts` — plus the frozen sibling specs those modules
  already answer to (`job-account-lifecycle.test.ts`,
  `job-usage-and-invitations.test.ts`, `job-event-window-sweep.test.ts`).
- **Number allocation:** the `OP-136 jobs lane` row read `` `0852` `` on this
  head, but **`0852` is deliberately left free**: the sibling TEST card
  `t_7e31328b` (findings F1/F2, the same lane, dispatched from the same parent
  by the same review, and running concurrently in
  `/root/openpic/openpic-webapp/.worktrees/t_7e31328b`) carries the same
  `` `Next free: 0852` `` cell in its body and had not minted a record when this
  one was written. This record takes `0853` and advances that cell to
  `` `0854` ``; `0852` stays available for that card, so the two heads cannot
  land the same number. A gap is the sanctioned answer here — ADR-0300 §2 says
  gaps inside a range "are expected and cheap: a number is consumed once and is
  never reissued to another lane" — and it is much cheaper than a duplicate that
  the `adr-numbering` guard (invariant (i)) would fail after both merges. The
  sweep: no `ADR-0852*`/`ADR-0853*` file in any other `.worktrees/*/docs/adr`,
  `git rev-list --objects --all -- docs/adr` returning `ADR-0851` as the highest
  number on any object, and the lane's three records (`0849`, `0850`, `0851`) as
  its high-water mark. Both `unallocated (future lanes)` cells stay `0869`, and
  the stale `OP-129 attendee identity lane` cell stays as found. No number
  outside `0849`–`0868` is consumed.

## Context

Every OP-136 sweep writes its state change **before** it writes the outbox row,
with no transaction. One failed write therefore destroys the only record that
the announcement is still owed, and the candidate predicate stops selecting the
row, so no later run can repair it.

The review of the GREEN measured this on the trunk with one injected failure of
the `accountDeletionTombstones` `updateOne` (ADR-0850 records the probe):

```
{"firstScanned":1,"firstAffected":0,"firstErrors":1,"profileStatus":"deleted",
 "purgeStartedAtStamped":true,"tombstoneRows":0,"completionAfterFailure":0,
 "retryScanned":0,"retryAffected":0,"completionAfterRetry":0}
```

The account is `deleted` with `purgeStartedAt` stamped, there is no retained
contact, no `account.deletion.completed`, and the candidate predicate
(`status: "deletion_pending"`) can never re-select it: the deletion and its
receipt are lost permanently, though contract §12 requires the receipt to reach
the last known email _through that tombstone_. The same write-then-emit shape
sits in three siblings with a smaller blast radius: `verification-nudge` (the
emit lands, the counter increment fails, and the next run's emit is deduped by
`account.verification.incomplete:<userId>:t+24h`, so the ladder never reaches
`t+72h`), `invitation-expiry` (`reminderSentAt` is latched before
`collab.invite.reminder`), and `event-window-sweep` (the status moves to `ended`
before `event.ended`, and an `ended` row leaves the candidate set).

## Decision

### 1. One new spec file, not three appended blocks

`apps/web/src/test/integration/job-sweep-failure-windows.test.ts` holds all four
pins. The card allowed appending to the three lifecycle specs; a single file is
better because the four cases share exactly one thing — the failure-injection
harness — and because appending would have meant editing three existing files'
import lines and duplicating the harness three times. No existing spec,
assertion, helper, fixture or mock is touched, so "no existing assertion edited"
is true by construction rather than by inspection.

### 2. The injection is a `Collection.prototype` spy, armed for one call

Each job reads its handle per call (`platformRepo(db).collection(name)` →
`db.collection(name)`), which returns a **fresh** `Collection` instance, so an
instance spy intercepts nothing. The pins therefore spy on the prototype and
gate on `this.collectionName`:

- `failNextUpdateOne(collectionName)` — used by the purge (`accountDeletionTombstones`)
  and the nudge (`userProfiles`);
- `failNextInsertOne(collectionName, eventKey)` — used by the two outbox pins
  (`domain_events`, gated further on the document's own `eventKey`, so a run
  that emits several messages fails exactly the named one).

Three properties make the injection honest:

- the real method is captured **once at module load, off the property
  descriptor** (`Object.getOwnPropertyDescriptor`); reading the property at call
  time finds the spy and recurses, which is the known way to fake a pass;
- the error carries `code: 91` (a replica-set election), never `11000`, so no
  caller can mistake it for the dedupe collision the outbox relies on;
- the armed count is asserted (`expect(injection.fired()).toBe(1)`) before any
  outcome assertion, so a mis-targeted spy fails **loudly** instead of letting
  the case pass on an unimpeded run, and it is removed in a `finally` so no
  later case can see it.

### 3. Four pins, all outcome-only

1. **The account purge survives a failed step.** One injected
   `accountDeletionTombstones` failure; run 1 reports `errors: 1`; with the
   failure gone, run 2 must leave one tombstone row holding the **last known
   email** and one `account.deletion.completed` whose `payload` is `{ userId }`
   and nothing else.
2. **The nudge counter is not lost.** One injected `userProfiles` write failure;
   run 1 reports the failure; the next run must still deliver the same rung
   **once** (the counter reads 1 and the outbox holds exactly the `t+24h` key),
   and the run after that must deliver `t+72h` (the counter reads 2).
3. **The reminder is not lost.** One injected `domain_events` insert for
   `collab.invite.reminder`; after the retry (and one more tick, so a double
   delivery is caught too) the invitation holds exactly one
   `collab.invite.reminder`.
4. **The ended announcement is not lost.** One injected `domain_events` insert
   for `event.ended`; after the retry exactly one `event.ended` exists and the
   event is `ended`.

The pins name **no mechanism**. A `withTransaction`, an emit-first order, or a
resume marker all satisfy them; the RED and the GREEN are free to differ in
shape as long as the observable outcome holds.

### 4. The failure's _shape_ is not prescribed either

Run 1 of the purge reports `errors: 1` (the job's own per-record `catch`), but
the three siblings currently let the error escape `job.run`. The pins accept
either: `runReporting()` records `{ scanned, errors, reported }`, where
`reported` is true for a throw **or** a non-zero `errors`. That is the card's own
word ("the run reports an error") without inventing a result shape the GREEN
might reasonably choose differently.

### 5. One assertion goes beyond the card's words, and why

Pin 1 asserts the tombstone's `email` equals the seeded address. The card asks
for "one tombstone row", which a retry could satisfy with a contact-less row —
and today's order anonymizes the Better Auth `user` row **before** the tombstone
write, so a resume that merely re-reads the user row would store no email and
the §12 fan-out would have no recipient. The assertion is the contract's, not a
mechanism's: it only requires the contact to be captured before it is destroyed.
Everything else is the card's own list.

### 6. The pins are satisfiable, and they do not collide with the frozen specs

A throwaway worktree (`/.worktrees/probe-t535ab5d2`, detached at `7d986972`,
removed afterwards) carried the smallest near-fix each pin admits: the purge
retained the contact **before** anonymizing and resumed on
`{ status: "deleted", purgeStartedAt: { $ne: null }, deletionCompletedAt: null }`
with the completion stamp; the nudge advanced the counter before the emit; the
reminder was emitted before the latch; and `event.ended` was emitted before the
status write. Result: `Test Files 4 passed (4)`, `Tests 20 passed (20)` — the
four pins **and** all sixteen frozen cases of the three sibling specs, `tsc`
exit `0`. So no pin contradicts an existing assertion, and none is
unsatisfiable.

## Evidence

RED on the trunk `7d986972` (the delivered file, `prettier --write` applied):

```
 × the account purge finishes the deletion on the next run after a failed tombstone write
 × the verification nudge counter survives a failed increment, so the ladder still reaches t+72h
 × the invitation reminder survives a failed outbox write
 × the ended announcement survives a failed outbox write
Tests  4 failed (4)
```

the four messages verbatim:

```
AssertionError: run 2 must finish the deletion the failed tombstone write left unfinished (run 2 reported scanned: 0, errors: 0): expected { tombstones: +0, receipts: +0 } to match object { tombstones: 1, receipts: 1 }
AssertionError: the T+24h rung must still advance the counter: expected +0 to be 1 // Object.is equality
AssertionError: the reminder must survive the failed write and must not double: expected [] to have a length of 1 but got +0
AssertionError: the ended announcement must survive the failed write: expected [] to have a length of 1 but got +0
```

Every one is an assertion-level failure reached **after** the injection armed
and fired (`fired() === 1`) and after run 1 was seen to report the failure —
never a load, harness or `Cannot find module` error. `tsc -p
apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 issues; `prettier --check`
clean; no production file touched (`git status --short` lists the new spec, this
record and the two ledger edits only).

## Alternatives

- **Append the four cases to the three lifecycle specs** — rejected: three
  copies of the injection harness, three existing import blocks edited, and the
  "no existing assertion edited" guarantee becomes something a reviewer has to
  verify instead of something the diff shows.
- **`vi.mock` of `@/server/domain/domain-events`** — rejected: the outbox writer
  is the seam under test; mocking it would delete the very write whose loss is
  the finding. The driver-level injection exercises the real writer end to end.
- **Assert `scanned >= 1` on the purge retry** — rejected: that prescribes that a
  resumed account is counted in `scanned`, which a resume path may legitimately
  do differently. The run's own value is carried in the assertion **message**
  instead, so the RED still quotes `scanned: 0` without pinning a counter shape.
- **Inject a failure on `userProfiles` for the purge case** (the anonymize step)
  — rejected: it is a different window, and it would leave the email readable.
  The named window is the tombstone write.
- **Pin every emit-failure arm** (`upload_window.closed`, `starting_soon`,
  `collab.invite.expired`, the retention warnings) — rejected: the card names
  four windows, and this is a pin card, not a sweep of the whole sweep family.

## Out of scope

- The mechanism the GREEN chooses (§3), and the counters it reports for a
  resumed row beyond the four named observables.
- The sibling failure windows the card did not name: `event.upload_window.closed`,
  `event.starting_soon`, `collab.invite.expired`, `retention-warnings`,
  `retention-purge`'s step markers. They share the shape and are recorded here as
  known-unpinned.
- Findings F1, F2, F4, F5, F6, F7 of the same review — each has its own card.
- Playwright: no user journey is involved; the sweeps are cron jobs driven
  directly by the integration harness.
- Every production module of OP-136; ADR-0850 stays the record of what shipped.
