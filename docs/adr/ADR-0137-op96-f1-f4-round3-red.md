# ADR-0137 — OP-96 follow-up round 3 RED: bound the repeated non-retryable digest-flush failure (F1b-r2)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 3 (RED, `t_b6540886`) · **Parent:** `t_6163c787` (the round-2 GREEN + its review sign-off) · **GREEN card:** created by this card (`openpic-webapp-backend-coder`, gated on this one)
- **Implements / amends:** ADR-0134 §"Accepted consequence (reviewer finding F1b-r2, routed)" (the unbounded repeat it leaves open), ADR-0133 §"F1b — the design choice" (the option-(a) contract it bounds), ADR-0120 (the OP-96 contract, §10.2 `notification-digest-flush`) · **Evidence:** ADR-0133 §"Review sign-off (round 1, artifact lens)" §Findings §F1b-r2
- **Branch:** `OP-96-task-f1-f4-round3-red`, base `origin/main` `91d1101` (post-merge #217 `2c779b3`) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

The round-1 (artifact-lens) review of the OP-96 round-2 RED pins (`t_1e598454`, ADR-0133) was
**APPROVED with one non-blocking finding, F1b-r2 (Low)**. The round-2 F1b contract chose **option
(a)**: after a **non-retryable** digest-flush failure the bucket stays `open` and a later flush tick
re-attempts it (ADR-0134). That is correct for the _transient_ case the F1b pin scripts (one failure,
then a recovery), but it leaves this boundary unpinned:

> a **permanently** non-retryable failure — e.g. a provider `400` for a bad destination — leaves the
> bucket `open` and is therefore re-attempted on **every** subsequent flush tick, calling the
> transport again and inserting a fresh `attempts: 1` `failed` ledger row each time, until the
> bucket's `expireAt` TTL retires it. In a system where `retryable: false` means "never retry", an
> unbounded retry loop of a non-retryable failure is a contradiction.

This card writes the RED pin for that boundary. It is gated after the round-2 GREEN (`t_6163c787`)
so it is written against the F1b implementation (`failed_terminal` present on `origin/main`), not the
pre-F1b behaviour — before F1b a non-retryable flush failure **closed** the bucket, so the
unbounded-repeat premise only exists after PR #217 landed. No production code is changed by this
card; the new pin fails for the right reason against `origin/main` `91d1101`.

## Decision

### New pin (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin    | File                                                                                  | Observable                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1b-r2 | `apps/web/src/test/integration/notification-digest-flush-non-retryable-bound.test.ts` | a permanently non-retryable transport calls the transport at most `N` times across `N + 2` flush ticks, the bucket goes terminal, no `failed` ledger rows accumulate beyond `N`, and the summary is never delivered |

The pin drives the real production paths (`runNotificationFanOut`, `flushDueDigests`) against a real
`MongoMemoryReplSet` and the real seed catalogue, and asserts only observable outcomes (transport
calls/deliveries, stored bucket/ledger state, `CronRunOutcome` counters).

### The bounded, terminal contract

Of the card's two listed shapes, this pin selects the **terminal-state** shape (the card's first
option): after a bounded number of non-retryable flush failures the bucket reaches a terminal
classification and leaves the selectable set the flush cron reads (`status: "open"`).

Concretely, the contract the pin establishes:

1. **Bound = the existing attempt ceiling.** A digest bucket is re-attempted after a non-retryable
   flush failure at most `platformSettings.pipeline.maxAttempts` times — the app's single "attempts
   before giving up" knob, read through the same `getPlatformSettings({ db, clock })` seam
   `flushDueDigests` already uses. The sibling F2b pin bounds the dispatch retry sweep by the same
   setting, so the two bounded-retry surfaces share one ceiling rather than inventing a second
   tunable (and a second `platformSettings` schema field, which would be an OP-82 contract change).
2. **Terminal marker.** When the number of non-retryable flush failures reaches the ceiling the
   bucket is closed with `status: "flushed"` and `flushOutcome: "failed"` — reusing the field the
   round-2 F1c closure introduced (ADR-0134) rather than inventing a second one. `status` stops
   being `"open"`, so the flush cron's `find({ status: "open", flushAt: { $lte: now } })` no longer
   selects it.
3. **Bounded rows.** Each attempt still durably records its own `failed` ledger row (the failure
   stays on the ledger exactly as F1b requires); the row count is therefore bounded by the ceiling
   too. The pin asserts `1 <= rows <= N`, so it also tolerates an implementation that records the
   repeated failures on a single upserted row (the card's second listed shape) instead of one row per
   attempt.
4. **Never delivered.** The summary is never delivered (no outbox message, no `status: "sent"` ledger
   row), and the trailing ticks select nothing (`scanned: 0`).

`N` is seeded to the **non-default** value `2` in the pin, so the assertion never depends on the
shipped default (`5`). The pin drives `N + 2 = 4` flush ticks.

### Why `N >= 2` is required (preserving the round-2 F1b pin)

The round-2 F1b pin requires the bucket to stay `open` after the **first** non-retryable failure and
to be re-attempted and delivered on a later flush tick. A bound of `N = 1` (terminal on the first
failure) would break that pin (`recoveryFlush.affected` would be `0`, not `1`). The chosen bound is
read from `pipeline.maxAttempts`, whose default (`5`) keeps the F1b scenario well inside the bound.
Both pins stay green together.

### Semantics note (F1b synthetic recovery), folded in

The round-2 F1b pin's scripted transport makes a `retryable: false` error **succeed** on its second
call, so the recovery it asserts is **synthetic**: the pin proves failure _ownership_ (the bucket
stays selectable and the retry cron is not a second owner), not that a non-retryable failure actually
recovers. This is recorded in the new spec's doc comment; the new pin deliberately drives a
_permanent_ non-retryable rejection so the unbounded-repeat boundary is what is measured.

## RED evidence

- `pnpm test:int` → **1 file failed / 53 passed (54); 1 test failed / 356 passed (357)**. The only
  failure is the new pin; every previously green integration test (including the merged F1–F4 and
  round-2 F1b/F2b/F1c pins, and the OP-94/95/96 I1–I12 pins) still passes — no regression.
- The pin fails for its intended reason at the call bound:

  ```
  AssertionError: expected 4 to be 2 // Object.is equality
   ❯ apps/web/src/test/integration/notification-digest-flush-non-retryable-bound.test.ts:340:31
       expect(transport.calls).toBe(MAX_FLUSH_ATTEMPTS);
  ```

  i.e. the transport was called on **all four** flush ticks (one `failed` ledger row per tick, bucket
  still `open`) instead of being bounded to `N = 2`.

- `pnpm typecheck` clean; `pnpm exec eslint` on the new spec clean; `pnpm exec prettier --check`
  clean.

## Consequences

- The GREEN card turns the pin green by reading `pipeline.maxAttempts` in `flushDueDigests` and
  tracking the bucket's non-retryable flush-failure count, closing the bucket terminally when the
  count reaches the ceiling. It continues on **this** branch (`OP-96-task-f1-f4-round3-red`) so the
  pin ships with the implementation, and in **this** worktree
  (`/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`).
- A permanently non-retryable digest flush is now bounded and observably terminal instead of an
  unbounded re-attempt loop — the contradiction F1b-r2 identified is closed.
- The terminal marker (`status: "flushed"`, `flushOutcome: "failed"`) is field-identical to the
  round-2 retryable-failure closure. This is deliberate (no second field) but means the two are only
  distinguishable through the ledger row's `lastError`; the ADR records it so a future round does not
  mistake the identity for a bug. A distinct value for the existing `flushOutcome` field (e.g.
  `"failed_terminal"`) is a possible follow-up if an operator needs to separate "will be retried by
  the retry cron" from "gave up" at a glance.
- The `notificationDigests` shape gains a per-bucket non-retryable-failure counter; the authoritative
  schema in `docs/Notification and Database Design.md` §19.6 must be updated by the GREEN card so the
  document matches the code.

## Alternatives considered

- **Bound `N = 1` (a non-retryable failure is terminal immediately).** Rejected: it breaks the
  round-2 F1b pin, which requires the bucket to stay selectable after the first non-retryable failure
  and to be re-attempted (the synthetic-recovery scenario the pin scripts). The bound must be `>= 2`.
- **A new dedicated setting (`notifications.digestMaxFlushAttempts`).** Rejected: it adds a
  `platformSettings` schema field, default and bounds (an OP-82 contract change) for a ceiling that
  already exists. Reusing `pipeline.maxAttempts` keeps one bounded-retry knob and matches the sibling
  F2b pin.
- **A hard-coded constant `N` in `flushDueDigests`.** Rejected: a magic number no operator can tune
  without a deploy, and it would not let the pin seed a non-default bound.
- **Pin only the ledger-row shape (the card's second option) without a terminal state.** Rejected: it
  bounds the _rows_ but not the _transport calls_ or the re-selection — the bucket would still be
  re-attempted on every tick, so the unbounded loop would remain. The terminal-state shape is what
  stops re-selection; the row bound is asserted alongside it.
- **Assert exactly `N` `failed` ledger rows.** Rejected: it would over-specify "one row per attempt"
  and fail an equally-valid single-upserted-row implementation, which the card explicitly lists as an
  acceptable shape. The pin asserts `1 <= rows <= N`.

## Assumptions & open questions

- **The bound is `pipeline.maxAttempts`.** The card left the source of `N` to the pin author. This pin
  resolves it to the existing attempt ceiling (rationale above). If the implementation team prefers a
  dedicated digest-specific ceiling, the observable the pin asserts (`<= N` calls, terminal after `N`
  failures) is unchanged — only the setting the GREEN reads, and the value the pin seeds, move.
- **Terminal marker is `status: "flushed"` + `flushOutcome: "failed"`.** Chosen to reuse the round-2
  F1c field per the reviewer's hint ("without inventing a second field"). If a distinct marker is
  preferred, the pin's `flushOutcome` assertion is the single line to update.

## Out of scope

- No production code, mock, fixture, factory or existing test is touched by this card.
- The F1c-r2 coverage gap (a retry/redelivery-path digest delivered `flushOutcome: "failed"` is never
  counted against `maxDigestEmailsPerDay`) is a **separate** round-3 card (`t_92c086f5`) and is not
  pinned here.
