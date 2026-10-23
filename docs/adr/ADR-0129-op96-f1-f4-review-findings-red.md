# ADR-0129 — OP-96 follow-up RED: pin the F1–F4 review findings (digest flush double-send, unbounded retry attempts, unbounded sweep reads, empty-body OTP redelivery)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up (RED, `t_8423b7c1`) · **Parent:** `t_a4cdff8f` (test reconciliation) · **GREEN card:** `t_6a4943e8` (gated on this one)
- **Implements / amends:** ADR-0120 (the OP-96 contract), ADR-0126 (the OP-96 GREEN), ADR-0127 (per-dispatch failure ownership) · **Evidence:** `ADR-0128` §3 (the review sign-off with findings F1–F4) and the inline comments on PR #203
- **Branch:** `OP-96-task-f1-f4-review-findings-red`, base `origin/main` `3958213` (post-merge #214) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_8423b7c1`

## Context

The OP-96 GREEN review (`t_609968cf`, PR #203, squash-merged as `bb70cef`) approved the
digest / retry / quiet-hours crons **with findings**. Four of them are behaviour
defects that no current pin covers, so per the pipeline they must be pinned RED
first; the GREEN card `t_6a4943e8` is gated on this card:

| #   | Severity | Defect                                                                                                                                                                |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Medium   | A failed digest flush leaves the bucket `open` **and** writes a retryable `failed` ledger row, so the flush cron and the retry cron can both re-send the same summary |
| F2  | Medium   | `retryDueDispatches` re-attempts every `failed && lastError.retryable:true` row forever; `pipeline.maxAttempts` is never read                                         |
| F3  | Medium   | All three sweeps `.toArray()` the whole selectable set; `limit` bounds only successes, so an all-failing run processes the entire backlog                             |
| F4  | Medium   | `buildRedeliveryMessage` maps `body: null` to `""`, so a retried `retainBody:false` type (`auth.otp.email.requested`) is re-sent as an empty-body email               |

This record fixes the **contract** the new pins establish and the design choices
taken where the card left two options open. No production code is changed by this
card (TDD RED); every new pin fails for the right reason against the current tree.

## Decision

### Modules and the design choices made under ambiguity

**F1 — one owner of a digest-flush failure (option (a)).** The pins select the
design in which a flush failure is **durably recorded on the `notificationDispatches`
ledger row and the bucket is marked `flushed`**, mirroring ADR-0127: the ledger row
owns the retry, and `notification-dispatch-retry` is the single re-sender. The
alternative (write the flush row non-retryable and let the bucket own the retry)
was rejected because it leaves **two** ledger rows for one bucket (a `failed` row
plus the later `sent` row), contradicting the card's "exactly one ledger row"
outcome.

> Ambiguity resolved: the card asks for "**exactly one transport call** and exactly
> one ledger row" across a _failure tick + retry tick + second flush tick_. A
> scripted failing transport that then succeeds necessarily calls the transport
> **twice** (the failed flush attempt, then the successful ledger retry); what must
> be exactly one is the **delivered message**. The pins assert one message accepted
> by the transport (`outbox`), one ledger row, the bucket `flushed`, and that the
> second flush tick makes **no further transport call**.

**F2 — `pipeline.maxAttempts` is the settings seam.** The retry sweep must stop
selecting a row once `attempts >= platformSettings.pipeline.maxAttempts` (read
through the existing `getPlatformSettings({db, clock})` seam, never a constant) and
leave `attempts` unchanged. The pin seeds a **non-default** `maxAttempts` (`2`) into
the `platformSettings` singleton so it never depends on the shipped default (`5`).

**F3 — a bounded read.** With a backlog of `N > limit` due rows, `scanned` must not
exceed `limit + 1` and `hasMore` must still be `true`. The implementation is free to
add `.limit(limit + 1)` or a cursor. This deliberately **changes the `scanned`
semantics** of the over-limit case (the current code reads the whole set and, when
every send fails, scans all `N` because `limit` bounds only `affected`).

> Conflict check (card requirement): the existing I6/I9/I11 pins assert only
> `affected` / `hasMore` / `outbox` for a backlog of 3 with `limit: 2` — i.e. exactly
> `limit + 1` rows — so they are **unaffected** by the tightened `scanned` contract.
> No conflicting assertion was found; nothing was loosened.

**F4 — a terminal, non-retryable classification.** Of the card's two acceptable
outcomes, the pins select: after a retryable OTP failure the row reaches a terminal,
distinct **non-retryable** classification (`lastError.retryable: false`) and the
retry sweep delivers **no** message for it. This keeps the fix in the shared
`redeliverDispatchRow` path (mirroring its existing `no_destination` classification)
and guarantees the row leaves the sweep forever, rather than the more complex
"never select `retainBody:false` rows" branch.

### New pins (integration, Mongo memory; driven through the real fan-out + real jobs)

| Pin | File                                                                           | Observable                                                                                                   |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| F1  | `apps/web/src/test/integration/notification-digest-flush-failure.test.ts`      | one delivered summary, one ledger row, bucket `flushed`, second flush makes no call                          |
| F2  | `apps/web/src/test/integration/notification-dispatch-retry-cap.test.ts`        | `attempts` below the cap retried; at the cap not selected, `attempts` unchanged, no call                     |
| F3  | `apps/web/src/test/integration/notification-bounded-sweeps.test.ts`            | retry / release / digest sweeps: `scanned <= limit + 1`, `hasMore: true` for a backlog of 10 with `limit: 2` |
| F4  | `apps/web/src/test/integration/notification-redelivery-body-retention.test.ts` | no empty-body redelivery; OTP row terminal non-retryable; no call                                            |

Each pin drives real production paths (`runNotificationFanOut`,
`sendTransactionalNow`, `flushDueDigests`, `retryDueDispatches`,
`releaseDeferredDispatches`) against a real `MongoMemoryReplSet` and the real seed
catalogue — never a hand-crafted row shape — and asserts only observable outcomes
(transport deliveries/calls, stored row status, `CronRunOutcome` counters).

Ambient hygiene: the pins call `invalidatePlatformSettings()` in `beforeEach`/`afterEach`
so a non-default `maxAttempts` seeded by the F2 spec can never leak into another
spec through the process-wide settings cache.

## RED evidence

- `pnpm test:int` → **4 files failed / 47 passed; 6 tests failed / 347 passed**. The
  only failures are the six new pins; every previously green integration test still
  passes (no regression).
- Each new pin fails for its intended reason:
  - F1 → `secondFlush.affected` is `1` (expected `0`): the open bucket was re-flushed.
  - F2 → `transport.calls` is `3` (expected `2`): the capped row was re-attempted.
  - F3 (×3) → `scanned` is `10` (expected `<= 3`): the whole backlog was materialised.
  - F4 → `retry.affected` is `1` (expected `0`): an empty-body email would be sent.
- `pnpm typecheck` clean; `eslint` on the four new files clean; `prettier --check` clean.

## Consequences

- The GREEN card `t_6a4943e8` can implement F1–F4 (and F5/F7) against an unambiguous,
  executable contract; it must continue on **this** branch
  (`OP-96-task-f1-f4-review-findings-red`) so the pins ship with the implementation.
- F1 fixes the double-send by making the ledger row the single owner; F2 makes retry
  bounded; F3 makes the sweeps read-bounded; F4 ensures a secret type is never
  re-sent body-less.
- The `scanned` semantics of the over-limit case change for all three sweeps; the
  existing I6/I9/I11 pins are unaffected (assert only `affected`/`hasMore`/`outbox`).
- F5 (`upsertDigestBucket` E11000 claim) and F7 (`releaseDeferredDispatches` silent
  no-op) remain unpinned by this card — the GREEN card closes them opportunistically.

## Alternatives considered

- **F1 option (b): write the flush ledger row non-retryable so only the bucket owns
  the retry.** Rejected: it produces two ledger rows per bucket on the eventual
  success, breaking the "exactly one ledger row" observable.
- **F1: assert a literal `transport.calls === 1`.** Rejected: a failure tick followed
  by a retry tick cannot deliver anything with a single call; the meaningful
  invariant is exactly one _delivered_ message.
- **F2: rely on the shipped default (`5`).** Rejected: the pin must prove the seam is
  honoured, so it seeds a non-default cap.
- **F3: bound the work (`affected`) instead of the read.** Rejected by the card: the
  point is that the _read_ is unbounded; `scanned <= limit + 1` makes that observable.
- **F4: exclude `retainBody:false` rows at selection.** Rejected: it needs the type
  catalogue at sweep time and leaves the row `failed && retryable` forever; the
  terminal classification in the shared redelivery path is simpler and durable.
