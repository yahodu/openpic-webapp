# ADR-0141 — OP-96 follow-up round 3 GREEN: bound the repeated `failed_unrecorded` digest-flush re-attempt (F1)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 GREEN (`t_cedd4e37`) · **Parent / RED pin:** `t_c9e903c5` (ADR-0138) · **Review of the RED:** ADR-0138 §"Review sign-off (round 1, artifact lens)"
- **Implements:** ADR-0138 §Decision (the terminal-state contract, option (a)), mirroring ADR-0137 §Decision (the merged transport bound) · **Amends:** ADR-0134 §"F1b — the design choice" (`failed_unrecorded` left `open`), ADR-0120 (the OP-96 contract, §10.2 `notification-digest-flush`)
- **Branch:** `OP-96-task-failed-unrecorded-bound-red`, base `origin/main` `509b559` (the merged round-3 GREEN) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t-unrecorded-red`

## Context

The round-3 RED pin (`t_c9e903c5`, ADR-0138) is RED on this branch: a digest bucket whose flush is
**always** `failed_unrecorded` (`resolveDestination(...) === null`, or `buildRedeliveryMessage(...)
=== null`) is left `open` and re-selected on **every** flush tick. Each tick re-resolves the
destination, re-renders the summary and counts `errors: 1`, until the bucket's `expireAt` TTL retires
it — an unbounded re-attempt loop of a permanent failure, and permanent `errors: 1` alert noise.

The merged round-3 GREEN (`509b559`, ADR-0137) bounded the **transport** variant of a permanent flush
failure (`failed_terminal`, counted in `nonRetryableFailures`, capped at
`platformSettings.pipeline.maxAttempts`). ADR-0138 §Decision selected the **terminal-state** shape
(option (a)) for the unrecorded variant so the two permanent-failure paths share one rule. The RED pin
asserts only observable outcomes (stored bucket state, `CronRunOutcome` counters, transport calls,
ledger rows) and deliberately does **not** assert the counter's field name.

## Decision

### The bound

`flushDueDigests` already reads `platformSettings.pipeline.maxAttempts` through
`getPlatformSettings({ db, clock })` for the transport bound (ADR-0137). The `failed_unrecorded`
branch now uses the **same** ceiling and the **same** counter:

1. **Same counter, same ceiling — `nonRetryableFailures`.** On a `failed_unrecorded` result the flush
   records one **unrecoverable** flush failure via the existing atomic `$inc` helper (renamed
   `recordNonRetryableFailure` → `recordUnrecoverableFailure`) and, when the resulting count reaches
   `maxAttempts`, closes the bucket terminally with `status: "flushed"` and `flushOutcome: "failed"`
   — the same marker ADR-0137's transport bound uses. No new `platformSettings` field, no second
   marker, no second counter.
2. **Below the ceiling the bucket stays `open`.** The RED pin asserts the bucket is still `open` with
   no `flushOutcome` after the first failure — the bound is `N`, not `1`.
3. **The per-attempt cost stays zero.** `failed_unrecorded` is returned **before** any transport call
   and writes **no** ledger row, before and after the bound, so the bound removes the permanent
   `errors: 1` noise without adding any transport or ledger cost.

### Why one counter rather than a distinct `unrecordedFailures` field

Reusing `nonRetryableFailures` (explicitly permitted by ADR-0138 §Consequences and flagged as
acceptable in ADR-0138 §"Review sign-off" §F1-r1-L2) is the more robust choice, not merely the smaller
one. A bucket can alternate failure classes across ticks (a transient transport failure one tick, a
destination that has gone away the next). With one shared counter, whichever combination accumulates
to `maxAttempts` closes the bucket. With two independent counters, a bucket that alternates would let
each counter stall below the ceiling and the re-attempt loop would remain unbounded — the very defect
this ADR closes. The field therefore means "unrecoverable flush failures" (both permanent classes);
its doc comment, the module header and the §19.6 schema comment in
`docs/Notification and Database Design.md` are updated to say so.

## Consequences

- A permanently unrecorded digest flush failure is now bounded and observably terminal
  (`status: "flushed"`, `flushOutcome: "failed"`) instead of re-selecting on every tick until TTL —
  the asymmetry F1 identified is closed, and the flush cron's `errors` is bounded by the ceiling.
- A permanent unrecorded failure and a permanent non-retryable transport failure now share one field
  and one ceiling. That is intentional (both are "unrecoverable flush failures" that nothing will
  ever retry) and recorded here so a future round does not read the shared field as a bug. The two
  remain distinguishable on the ledger: a non-retryable transport failure writes a `failed` row, an
  unrecorded failure writes nothing.
- No schema field was added, so §19.6 of `docs/Notification and Database Design.md` keeps its shape;
  only the field's describing comment is broadened to the two failure classes.
- The behaviour is pinned only through the `resolveDestination(...) === null` trigger (ADR-0138
  §Assumptions F1-r1-L1). The sibling `buildRedeliveryMessage(...) === null` trigger returns from the
  same `FlushOne` member, so the same branch — and therefore the same bound — covers it.

## Alternatives considered

- **A distinct `unrecordedFailures` counter.** Rejected: it needs a new schema field and, more
  importantly, a bucket alternating between the two permanent classes would keep each counter below
  the ceiling and stay unbounded (see §Decision).
- **Bound `N = 1`.** Rejected for symmetry with ADR-0137 and because a single transient
  address-resolution blip would silently strand a deliverable summary (ADR-0138 §Alternatives).
- **Leave `failed_unrecorded` unbounded (option (b)).** Rejected by ADR-0138 §Decision; not revisited
  here.

## Evidence (GREEN)

- `TMPDIR=/root/tmp-mongo pnpm vitest run --project integration
apps/web/src/test/integration/notification-digest-flush-unrecorded-bound.test.ts` → **1 passed (1)**.
  The four flush ticks log `{scanned: 1, errors: 1}`, `{scanned: 1, errors: 1}`, `{scanned: 0,
errors: 0}`, `{scanned: 0, errors: 0}` — the bucket is terminal after the seeded `N = 2` and the
  two trailing ticks select nothing.
- Full suite and static gates recorded in the GREEN card handoff (`t_cedd4e37`).

## Out of scope

- No test, mock, fixture or factory is modified. The RED pin (ADR-0138) is untouched.
- The F2 round-3 finding (overlapping flush invocations double-deliver a summary) is a separate card
  (`t_e3369a9e`, ADR-0139); the F1c-r2 coverage gap is a separate card (`t_92c086f5`, ADR-0140).
