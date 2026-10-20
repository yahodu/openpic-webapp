# ADR-0138 — OP-96 follow-up round 3 RED: bound the repeated `failed_unrecorded` digest-flush re-attempt (F1)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 RED pin (`t_c9e903c5`) · **Parent:** `t_4e4f0239` (the round-3 GREEN + its review sign-off) · **GREEN card:** created by this card (`openpic-webapp-backend-coder`, gated on this one)
- **Implements / amends:** ADR-0137 §"Review sign-off (round 1 GREEN, artifact lens)" §Findings §F1 (the unbounded re-attempt it routes), ADR-0137 §Decision (the bound this pin mirrors), ADR-0134 §"F1b — the design choice" (`failed_unrecorded` left `open`), ADR-0120 (the OP-96 contract, §10.2 `notification-digest-flush`)
- **Branch:** `OP-96-task-failed-unrecorded-bound-red`, base `origin/main` `509b559` (the merged round-3 GREEN) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red`

## Context

The round-1 (artifact-lens) review of the OP-96 round-3 GREEN (`t_4e4f0239`, PR #218, squash-merged as
`509b559`) returned **APPROVED WITH FINDINGS**. The round-3 GREEN bounded the **transport** variant of
a permanent digest-flush failure: `failed_terminal`, counted in `nonRetryableFailures` and capped at
`platformSettings.pipeline.maxAttempts` (ADR-0137). Finding **F1 (Low, coverage gap)** records the
asymmetry that bound makes visible:

> `flushOneBucket` returns `failed_unrecorded` when the destination cannot be resolved
> (`apps/web/src/server/notifications/digest.ts` — `resolveDestination(...) === null`) or the message
> cannot be built (`buildRedeliveryMessage(...) === null`). `flushDueDigests` deliberately leaves such
> a bucket **`open`** and counts `errors += 1`. Nothing bounds it: no terminal classification, no
> counter, no owner — only the bucket's `expireAt` TTL retires it.
>
> Those conditions are effectively **permanent** for a given `{recipient, channel}`: a user with no
> address for the channel never gains one. So the flush cron re-selects the bucket on **every** tick,
> re-resolving the destination and re-rendering the summary, counting an error each time, until TTL.

A permanently non-retryable _transport_ failure is now bounded at `N`; a permanently _unrecorded_
failure is unbounded — the same "never retry means never retry" contradiction, plus a permanently
non-zero `errors` (alert noise) for that recipient. The condition is unpinned, so this card writes the
RED pin first. No production code is changed by this card; the new pin fails for the right reason
against `origin/main` `509b559`.

## Decision

### New pin (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin | File                                                                               | Observable                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `apps/web/src/test/integration/notification-digest-flush-unrecorded-bound.test.ts` | a permanently unrecorded flush failure stops being re-attempted after `N` ticks: the bucket is still `open` after the first failure, terminal after the `N`th, the two trailing ticks select nothing, and no attempt ever calls the transport or writes a ledger row |

The pin drives the real production paths (`runNotificationFanOut`, `flushDueDigests`) against a real
`MongoMemoryReplSet` and the real seed catalogue, and asserts only observable outcomes (transport
calls/deliveries, stored bucket state, stored ledger rows, `CronRunOutcome` counters). The only
scripted seam is the transport — which this scenario never reaches.

### The failure this pin creates (why `failed_unrecorded`, deterministically)

The digest type this pin drives (`attendee.matches.new`, throttle `digest`) buckets to the **`email`**
group, so the bucket's `channel` is `email` and its destination is the recipient's `user.email`. The
routing decision that creates the bucket requires a verified contact, so the bucket can only exist
while the address does; the pin therefore removes the address (`user.email = null`) **after the
fan-out** and before the flush. `resolveDestination(db, userId, "email")` then returns `null` on every
tick, `flushOneBucket` returns `failed_unrecorded`, and — because that result touches the ledger only
after a successful send — no ledger row is written and the transport is never called. This is the
faithful encoding of the finding's own words: "a user with no address for the channel never gains one".

The card's illustrative suggestion (`notificationPreferences.global = { in_app: "off", email: "off",
mobile: "off" }`) does **not** produce this state: the flush path never re-reads preferences, so
preferences cannot make `resolveDestination` return `null`; and an all-off recipient never gets a
bucket in the first place (the fan-out skips it as `user_opt_out`). Removing the address is the
deterministic route to the same condition.

### The bounded, terminal contract (option (a))

Of the card's two listed shapes this pin selects the **terminal-state** shape — option (a), the
reviewer's recommendation — so the two permanent-failure paths share one rule:

1. **Bound = the existing attempt ceiling.** A digest bucket is re-attempted after an unrecorded flush
   failure at most `platformSettings.pipeline.maxAttempts` times — the same "attempts before giving
   up" knob ADR-0137's transport bound reads, through the same `getPlatformSettings({ db, clock })`
   seam `flushDueDigests` already uses. One bounded-retry knob, not a second `platformSettings` field
   (which would be an OP-82 contract change).
2. **Terminal marker.** When the number of unrecorded flush failures reaches the ceiling the bucket is
   closed with `status: "flushed"` and `flushOutcome: "failed"` — reusing the field the round-2 F1c
   closure introduced rather than inventing a second one. `status` stops being `"open"`, so the flush
   cron's `find({ status: "open", flushAt: { $lte: now } })` no longer selects it. The pin asserts
   only these two stored fields, so the counter the GREEN chooses (a new field, or the existing
   `nonRetryableFailures`, or an in-row tally) is not over-specified.
3. **Bounded cost.** `failed_unrecorded` is resolved _before_ the transport is called, so the pin also
   asserts the per-attempt cost stays zero: `transport.calls === 0`, empty outbox, zero ledger rows,
   zero `status: "sent"` rows — before _and_ after the bound. The bound therefore removes the
   permanent `errors: 1` alert noise without introducing any transport or ledger cost.

`N` is seeded to the **non-default** value `2`, so no assertion depends on the shipped default (`5`).
The pin drives `N + 2 = 4` flush ticks and asserts:

- after tick 1 (`errors: 1`): the bucket is still `open`, with no `flushOutcome` — the bound is `N`,
  not `1`;
- after tick `N` (tick 2): the bucket is terminal (`status: "flushed"`, `flushOutcome: "failed"`) —
  the bound is the seeded `N`, not the default;
- ticks 3 and 4: `scanned: 0` and `errors: 0`;
- throughout: `transport.calls === 0`, empty outbox, zero ledger rows.

### Why (a) and not (b)

Option (b) (an explicit exemption: `failed_unrecorded` is re-attempted every tick by design) is
rejected. Its only argument is that a later tick could resolve an address that appears later — but the
fan-out can only have bucketed the arrival while the address existed, so the "recovery" is not the
address appearing, it is the address _returning_, which the same argument would grant to the bounded
transport path this pin mirrors. Unbounded re-selection is also exactly the defect class the round-3
GREEN just fixed on the sibling path, and it makes `errors` permanently non-zero for that recipient.
Choosing (a) keeps one contract for permanent flush failures: bounded, terminal, and free of transport
or ledger cost.

## RED evidence

- `pnpm test:int` (`TMPDIR=/root/tmp-mongo`) → **1 file failed / 54 passed (55); 1 test failed / 357
  passed (358)**. The only failure is the new pin; every previously green integration test (the merged
  F1–F4, round-2 F1b/F2b/F1c and round-3 F1b-r2 pins, and the OP-94/95/96 I1–I12 pins) still passes —
  no regression. Baseline on `509b559` was 54 files / 357 tests.
- The pin fails for its intended reason — the bucket never leaves the selectable set — and the cheap
  observables (no transport call, no ledger row) are asserted _before_ it, so the failure isolates the
  missing bound rather than the scenario:

  ```
  AssertionError: expected 'open' to be 'flushed' // Object.is equality
   ❯ apps/web/src/test/integration/notification-digest-flush-unrecorded-bound.test.ts:365:32
     365|       expect(terminal?.status).toBe("flushed");
  ```

  i.e. all four ticks reported `{ scanned: 1, affected: 0, errors: 1 }` with the bucket still `open`
  (the flush log confirms four consecutive `errors: 1` and zero `affected`).

- `pnpm exec prettier --check` clean on the new spec.

## Consequences

- The GREEN card turns the pin green by reading `pipeline.maxAttempts` in `flushDueDigests` and
  tracking the bucket's unrecorded flush-failure count, closing the bucket terminally when the count
  reaches the ceiling. It continues on **this** branch
  (`OP-96-task-failed-unrecorded-bound-red`) so the pin ships with the implementation, and in **this**
  worktree (`/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red`).
- A permanently unrecorded digest flush failure is now bounded and observably terminal instead of an
  unbounded re-attempt loop — the asymmetry F1 identified is closed.
- If the GREEN reuses `nonRetryableFailures` as the counter, a permanently unrecorded failure and a
  permanently non-retryable transport failure then share one field; that is acceptable (both are
  "unrecoverable flush failures") but the ADR records it so a future round does not mistake it for a
  bug. The pin deliberately does not assert the counter's field name.

## Alternatives considered

- **Option (b): an explicit exemption, pinning the deliberate re-selection with positive observables.**
  Rejected (rationale in §Decision). It would also require pinning a bounded per-tick cost and would
  leave the two permanent-failure paths with two contracts.
- **Bound `N = 1` (an unrecorded failure is terminal immediately).** Rejected for symmetry with
  ADR-0137, and because a single transient address-resolution blip would then silently strand a
  deliverable summary. The bound is `pipeline.maxAttempts`.
- **Assert the counter's stored field name.** Rejected: it over-specifies the GREEN's implementation.
  The pin asserts the terminal state (`status` + `flushOutcome`) and the cost boundary (calls / rows /
  deliveries) instead.
- **Create the failure by clearing the recipient's preferences.** Rejected: preferences are not read
  by the flush path (it re-resolves from the `user` document), and an all-off recipient never gets a
  bucket — the scenario would not construct the state at all.
- **Seed the bucket document directly instead of via the fan-out.** Rejected: the card requires the
  real production paths, and a hand-seeded bucket would not prove the real fan-out can create the
  state this bound has to retire.

## Assumptions & open questions

- **The bound is `pipeline.maxAttempts`.** The card left the source of `N` to the pin author. This pin
  resolves it to the existing attempt ceiling ADR-0137 already established. If the team prefers a
  dedicated digest-specific ceiling, the observables the pin asserts (`open` after one failure,
  terminal after `N`, trailing `scanned: 0`, zero transport/ledger cost) are unchanged — only the
  setting the GREEN reads, and the value the pin seeds, move.
- **The terminal marker is `status: "flushed"` + `flushOutcome: "failed"`.** Chosen to reuse the
  round-2 F1c field, exactly as ADR-0137 did. If a distinct marker is preferred, the pin's
  `flushOutcome` assertion is the single line to update.
- **The failure is created by removing the recipient's address after the fan-out.** Recorded above;
  this is the only deterministic construction of a _permanent_ `resolveDestination === null` state
  that still exercises the real fan-out. The other `failed_unrecorded` trigger
  (`buildRedeliveryMessage === null`, i.e. an undeliverable channel) behaves identically and is not
  separately pinned — the observable contract is the same entry point.
- **The card body names a worktree/branch the dispatcher did not use.** The card body directs
  `/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red` on `OP-96-task-failed-unrecorded-bound-red`
  (both pre-created, both still checked out there); the dispatcher materialised a second worktree
  `/root/openpic/openpic-webapp/.worktrees/t_c9e903c5` on `wt/t_c9e903c5`. This card worked in the
  **card-designated** worktree/branch, because the branch name must satisfy CI `validate-branch-name`
  (`^OP-[0-9]+-(feature|bug|task)-[a-z0-9_-]+$`), which `wt/t_c9e903c5` does not. The GREEN should use
  the card-designated worktree/branch too.

## Out of scope

- No production code, mock, fixture, factory or existing test is touched by this card. The delivered
  change is the new spec, this ADR and the `docs/adr/README.md` row/allocation note.
- The F2 round-3 finding (two overlapping flush invocations double-deliver a summary, Medium) is a
  **separate** card (`t_e3369a9e`, ADR 0139) and is not pinned here.
- The F1c-r2 coverage gap (a retry-redelivered digest is never counted against
  `maxDigestEmailsPerDay`) is a **separate** card (`t_92c086f5`) and is not pinned here.
