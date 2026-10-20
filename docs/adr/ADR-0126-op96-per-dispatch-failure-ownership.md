# ADR-0126 — OP-96: per-dispatch failure ownership (the retry cron owns redelivery)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 phase 1 (`t_609968cf`) · **Supersedes in part:** ADR-0092 §1 §I5 (event-level retry for a per-dispatch failure) · **Related:** ADR-0119 (the OP-96 contract), ADR-0125 (the OP-96 GREEN implementation), ADR-0090/0092 (OP-94 fan-out), ADR-0028 (`defineCronJob`)

## Context

ADR-0092 (OP-94 GREEN) made a **per-recipient, per-dispatch** failure an
**event-level** failure: `runNotificationFanOut` returned `retryableFailure:
true`, so the outbox row was left `dispatch.notifications: "pending"` via
`markFailed` and would be re-claimed by the next fan-out run. That was pinned by
OP-94's `notification-fan-out.test.ts` I5.

ADR-0119 (OP-96 RED) introduces `notification-dispatch-retry`, a cron that
re-sends a **failed-retryable `notificationDispatches` row** from the durable
ledger (ADR-0119 §3). Its pins (`notification-dispatch-retry.test.ts` I4/I9/I10)
require that a failed dispatch is redelivered by that cron and **only** by it:
I9 drives three fan-out failures and asserts `transport.calls === 3` before the
retry sweep, which is only true if the fan-out did not leave the events
claimable; I10 asserts a second sweep is a no-op.

The two pins are therefore mutually exclusive, and both are satisfiable only by
one of two designs:

1. **Event-level retry retained** (ADR-0092): the fan-out leaves the event
   `pending`. The next fan-out run re-claims it and re-fans the whole event
   while the retry cron also re-sends the failed ledger row — a double send
   (the fan-out's re-insert is deduped by the unique `dedupeKey` index only when
   the type has one, so the duplicate is not reliably suppressed).
2. **Dispatch-level retry** (OP-96): the failure is recorded on the dispatch
   row, the outbox event is marked `done`, and the retry cron owns redelivery.

ADR-0119 did not flag the collision ("Supersedes/amends: none").

## Decision

**A per-dispatch failure is owned by the dispatch row; the outbox event is
marked `done`.**

`runNotificationFanOut` marks the event `done` after a recorded per-dispatch
failure — render error, no deliverable destination, or transport failure. The
failure is durable on the `notificationDispatches` row (`status:"failed"`,
`lastError.retryable`, `attempts`), and `notification-dispatch-retry`
(ADR-0119 §3) re-sends it with backoff. Only an **unexpected** per-recipient
error that produced **no** dispatch row still leaves the event claimable via
`markFailed` — the at-least-once guarantee ADR-0092 §1 wanted is preserved, just
anchored on the dispatch row instead of the outbox row.

This retires ADR-0092's event-level retry for the per-dispatch failure case and
supersedes ADR-0092 §1 and the OP-94 `notification-fan-out.test.ts` I5
expectation (`pending` → `done`). ADR-0092 remains in force for everything else
(claiming, dedupe-by-unique-index, per-recipient isolation, in-app feed writes).

Two further, smaller amendments to ADR-0092 recorded here:

- **The dispatch row now persists `subject`/`body`** (the body gated by the
  type's `retainBody`), which ADR-0092 listed as rejected ("schema §19.5 has no
  `body` field"). The redelivery crons cannot re-render from the ledger alone
  (the ledger keeps only `contactHash`, never the destination), so the rendered
  copy must be persisted at fan-out time. The `retainBody:false` guarantee for
  secret types (e.g. OTP) is preserved — OP-94 I6 still passes.
- **`DispatchRow.status` gains `"deferred"`** (plus `until`) so a quiet-hours
  deferral is a durable, selectable intent instead of a terminal `skipped` row
  (ADR-0119, ADR-0093). ADR-0092 enumerated `queued | sent | failed | skipped`.

## Consequences

- The retry cron is the single owner of redelivery; the fan-out never re-fans a
  failed event, so there is no fan-out/retry double-send.
- Sequential re-runs are idempotent (OP-96 I10); the OP-94 I5 pin is stale and
  is updated by the OP-96 test-reconciliation card to expect `done`.
- The in-app feed rows written before a later dispatch failure are unaffected;
  only the failed channel leg is retried.
- Coverage gap (not pinned, carried to the Test Author): overlapping
  `notification-dispatch-retry` runs issue a read-then-send with no atomic claim
  / lease, so a concurrent run can re-send a row between its selection and its
  `sent` write. The differentiator is the scheduler's single-flight assumption;
  hardening it needs a lease design no current pin demands.

## Alternatives considered

- **Keep the outbox event `pending` (ADR-0092) and dispute OP-96 I9.** Rejected:
  the fan-out and the retry cron would both redeliver a failed dispatch, and I9's
  arithmetic (three fan-out failures ⇒ three transport calls) is unsatisfiable.
- **Delay the event re-claim with backoff instead of retiring it.** Rejected:
  deferred duplication is still duplication, and it would need a new
  `dispatch.notifications` state no pin defines.
- **Leave the collision for the reviewer to arbitrate.** Rejected: the two ADRs
  are both Accepted and pin opposite behaviour, so one must be explicitly
  superseded; this record is that supersession.
