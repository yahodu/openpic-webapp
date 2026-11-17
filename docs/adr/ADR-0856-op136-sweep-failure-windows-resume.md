# ADR-0856 — OP-136 GREEN: a sweep's state change and its outbox row are one unit

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 GREEN `t_8901d758` (High; finding **F3** of the review of the
  GREEN `t_d18a6e9e`, parent TEST `t_535ab5d2`; branch
  `OP-136-bug-sweep-failure-windows-resumable`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_8901d758`). This record turns
  [ADR-0853](ADR-0853-op136-sweep-failure-windows-pins.md)'s four pins green and
  leaves that record and the pin spec byte-identical.
- **Implements:** contract §10.2 (`account-deletion-purge`,
  `verification-nudge`, `invitation-expiry`, `event-window-sweep`), §1.4, §12
  (the completion receipt addresses the last known email, resolved from the
  retained tombstone), §2.3, §4.5; schema §13.2, §18.3.
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §5 (the sweeps' shapes),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the shipped jobs and the measured
  window), [ADR-0853](ADR-0853-op136-sweep-failure-windows-pins.md) (the four
  pins), [ADR-0851](ADR-0851-op136-usage-latch-scoped-to-period.md).
- **Consumers:** `apps/web/src/server/jobs/account-deletion-purge.ts`,
  `…/verification-nudge.ts`, `…/invitation-expiry.ts`,
  `…/event-window-sweep.ts` (the four modules this record orders), plus
  `apps/web/src/test/integration/job-sweep-failure-windows.test.ts` (the pins
  they answer) and the frozen sibling specs
  `job-account-lifecycle.test.ts`, `job-usage-and-invitations.test.ts`,
  `job-event-window-sweep.test.ts`.
- **Number allocation:** the `OP-136 jobs lane` row read `` `0855` `` on this
  head (branch = the pin head `03221f54` merged with `origin/main` `20fb29a1`,
  which already carries `0854`). The sweep before minting found `ADR-0855*` on
  the open PR #635 head (`OP-136-task-indexed-check-matrix-latch-batch-green`,
  worktree `.worktrees/t_7e31328b`) and `ADR-0856*` nowhere —
  `git rev-list --objects --all -- docs/adr` tops out at `ADR-0855`. So this
  record takes `0856`, the first number above the highest consumed one, and
  advances only the `OP-136 jobs lane` cell to `` `0857` ``; both
  `unallocated (future lanes)` cells stay `0869`. No number outside
  `0849`–`0868` is consumed, and no frozen record is edited.

## Context

Every OP-136 sweep wrote its state change **before** its outbox row, with no
transaction. That order is safe only while both writes succeed: the moment the
state change commits, the candidate predicate stops selecting the row, so a
later failure destroys the only record that the announcement is still owed.
ADR-0853 pinned the four outcomes on the trunk and measured them RED; the
account purge was the severe one (`tombstoneRows: 0`,
`completionAfterFailure: 0`, `retryScanned: 0` — the deletion is unrecoverable).

The pins deliberately name no mechanism, so this record had to choose one per
job and say why. The rule applied: **the state change and the notice are one
unit where a transaction is available, and otherwise the notice is written
before the latch it feeds.**

## Decision

### 1. `account-deletion-purge` — one `withTransaction` per account

The claim (`findOneAndUpdate` on the `deletion_pending` + `deletionScheduledAt <=
now` filter), the contact read, the anonymize, the session delete, the tombstone
upsert and the `account.deletion.completed` emit now all join **one** session
(`withTransaction` from `@/server/db/transaction`, and `emitDomainEvent`'s own
`EmitDomainEventOptions.session` seam). A failure at any step aborts the
transaction, which rolls the claim back, so the row is still
`deletion_pending` when the next run's candidate query runs, and that run
finishes the whole deletion — including the email, which is still readable
because the anonymize rolled back too. The per-record `catch` keeps
`errors += 1`, and the conditional-write idiom is intact: the expected prior
state stays in the claim filter, so a second successful run scans 0 and purges 0.

Rejected the alternative the card offered (an intermediate
`deletion_purging` status with a stamp): it adds a state to a contract §1.4
lifecycle that names `deletion_pending` / `deleted`, it needs a second predicate
to re-select the intermediate state, and a crash _before_ the intermediate write
still leaves the row unpurging and unclaimed while a crash after it needs a
staleness rule. The transaction needs none of that and covers every post-claim
step in one mechanism, not just the tombstone one the pin drives.

### 2. `verification-nudge` — emit first, and count the rung even when deduped

The outbox row is written before the counter moves, and the `$inc` now runs
unconditionally (the dedupe hit only stops `nudged` from counting a new
delivery). Two windows close at once: an emit failure leaves the counter
untouched, so the rung is retried instead of skipped; and a rung whose outbox
row already exists still advances the counter, so an increment lost in an
earlier run can no longer sit behind its own dedupe key for ever. The ladder's
`max two ever` cap keeps reading the counter.

### 3. `invitation-expiry` — emit the reminder before the latch

`collab.invite.reminder` is emitted first; only then does the conditional
`findOneAndUpdate` stamp `reminderSentAt`. A failed insert now leaves the latch
unset, so the next hourly run re-emits (and the outbox's dedupe key keeps the
retry at exactly one row); the latch filter is unchanged, so a second run is
still a no-op.

### 4. `event-window-sweep` — announce `event.ended` before the status write

`event.ended` is emitted before the conditional `findOneAndUpdate` that moves
`published`/`live` to `ended`, so a failed insert leaves the row in the
candidate set and the next hourly run announces it and then moves it. The status
filter still carries the prior status, and the `ended` counter stays gated on the
write landing, so a concurrent run that already moved the row announces nothing
twice.

### 5. What did not change

The three other emits this family makes (`event.upload_window.closing`,
`event.upload_window.closed`, `event.starting_soon`), `invitation-expiry`'s
expiry arm (`collab.invite.expired`) and `retention-purge`'s step markers are
untouched: the review's F3 and the card name four windows, and those arms have
no coupled state write whose loss the same failure would cause (the closing and
starting-soon messages are pure announcements whose whole latch is the dedupe
key). They stay recorded as known-unpinned in ADR-0853.

## Evidence

The pin spec carried byte-identically from `03221f54` (`git diff 03221f54 HEAD`
on the two pin files is empty), no existing spec, assertion, fixture, helper or
mock edited.

- RED before the change, same file at this head: `Tests 4 failed (4)`, every
  case assertion-level and reached only after `fired() === 1`.
- GREEN: the pin spec `Test Files 1 passed (1)` / `Tests 4 passed (4)`.
- The three post-claim purge windows the pin does not drive (a failed `session`
  `deleteMany`, a failed `user` anonymize `updateOne`, a failed
  `account.deletion.completed` insert) were proven resumable by a throwaway
  probe (three cases, one injection each, deleted before the commit):
  `Test Files 1 passed (1)` / `Tests 3 passed (3)` — run 1 reports `errors: 1`,
  run 2 finishes with the profile `deleted`, the tombstone holding the last
  known email, one receipt and zero sessions. That is the measurement the
  review's F3a called out and the follow-up TEST card will pin.
- The five frozen sibling integration specs
  (`job-pipeline-sweep`, `job-retention-purge`, `job-account-lifecycle`,
  `job-event-window-sweep`, `job-usage-and-invitations`): `Test Files 5 passed
(5)` / `Tests 31 passed (31)`; `sweep-decisions` unit `Tests 76 passed (76)`.
- Full gate: `pnpm test:coverage` → `Test Files 322 passed (322)`, `Tests 4516
passed | 3 skipped (4519)`, statements 91.32 %, branches 80.11 %, functions
  95.79 %, lines 91.42 % (no threshold error).
- `pnpm typecheck` exit `0`; `pnpm lint` 0 errors (187 pre-existing warnings);
  `prettier --check` clean on all four modules; the six `adr-*` guard specs
  green.

## Consequences and known limits

- The purge now opens one transaction **per account**, bounded by the job's
  `limit` (default 50, max 100); the wrapper's own budget is 3 callback
  attempts. A replica-set member set is already required by the app (the
  transaction helper ships it), and the integration suite runs on a
  `MongoMemoryReplSet`, so the job's own test bed proves the path.
- The purge transaction makes the cancel window and the purge mutually
  exclusive by the claim filter, which the previous order did not.
- The nudge's unconditional count is a deliberately accepted trade: two runs
  that race on the same rung can both increment for the one delivery the dedupe
  key allowed, which spends a rung rather than stranding the ladder. The cap of
  two keeps the damage to one skipped email.
- A transaction's write conflicts are retried by `withTransaction`; if the
  budget is spent the record is caught per account and surfaces as `errors`,
  exactly like any other failed step.
