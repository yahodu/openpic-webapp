# ADR-0106 — OP-96 GREEN: digest buckets, dispatch retry, quiet-hours release

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 phase 1 (GREEN, `t_609968cf`) · **Depends on:** OP-94 (ADR-0090/0092), OP-87 (ADR-0028), OP-93 (ADR-0085)
- **Contract:** ADR-0100 (`docs/adr/ADR-0100-op96-digest-retry-quiet-hours-crons-red.md`) · **Supersedes / amends:** ADR-0092 §I5 (event-level retry for a per-dispatch failure)

## Context

ADR-0100 pinned six RED specs for the three de-scoped §6/§19 behaviours and the
durable quiet-hours deferral. This ADR records the GREEN implementation and one
design decision the implementation had to make that ADR-0100 left implicit.

## Decision

### Modules, routes and the cron job wrapper

- `@/server/notifications/digest` — `computeDigestFlushAt`,
  `withinDigestDailyCap`, `flushDueDigests`.
- `@/server/notifications/dispatch-retry` — `retryBackoffMs`,
  `retryDueDispatches`.
- `@/server/notifications/quiet-hours-release` — `releaseDeferredDispatches`.
- `@/server/notifications/dispatch-redelivery` (internal, untested-by-contract)
  — re-resolves a redelivery destination from the `user` row (the ledger keeps
  only `contactHash`), rebuilds the message from the persisted `subject`/`body`,
  and classifies the send. Shared by retry and release.
- `@/server/services/notification-cron-jobs` wraps each job in
  `defineCronJob` and supplies the database, clock and config-driven transport;
  the route handlers under `app/api/v1/internal/cron/**` import the service
  (an app route may not import an adapter directly) via the shared
  `_lib/run-cron-route` helper, so each route is a `GET`/`POST` one-liner
  mirroring `cron/sample/route.ts`.

### Digest accumulation is bucket-only

The fan-out `digest` branch now upserts **one open `notificationDigests`
bucket** per `{userId, bucketKey}` via an atomic pipeline upsert (so a
concurrent arrival cannot reset `firstItemAt` or lose a count); no per-arrival
`queued` dispatch row is written (ADR-0100 assumption 3, pinned by I1).
`sampleItems` keeps the last five arrivals; `flushAt` = `min(lastItemAt +
digestQuietMinutes, firstItemAt + digestHardFlushHours)`.

`flushDueDigests` selects `status:"open" && flushAt <= now`, renders one summary
per bucket (the type's email template plus the item count), sends, writes the
`sent`/`failed` dispatch row and marks the bucket `flushed`. The daily cap is
**per recipient per local day, shared across digest types** (ADR-0100 A4): it
counts the recipient's `flushed` buckets since local midnight in
`notificationPreferences.quietHours.timeZone` (UTC fallback, A3); a due bucket
beyond the cap stays `open` and is not counted as `hasMore`.

### Quiet-hours deferral is durable

`DispatchRow` gains `status:"deferred"`, `until` and the persisted
`subject`/`body`; the fan-out `defer` branch writes
`{status:"deferred", until:<window end>, skipReason:null}` (ADR-0100, ADR-0093).
`releaseDeferredDispatches` selects `status:"deferred" && until <= now`, sends
and marks `sent`/`failed`. `INDEX_SPECS` gains the partial
`{tenantId, status, until}` index scoped to `deferred`, the `notificationDigests`
`{userId,bucketKey}` unique-open / `{status,flushAt}` open / TTL indexes, and
`COLLECTIONS.notificationDigests`.

### A per-dispatch failure does not leave the outbox event pending (amends ADR-0092 I5)

OP-96 introduces the `notification-dispatch-retry` cron, which owns redelivery
of a failed dispatch **from its durable `notificationDispatches` row**. The
fan-out therefore no longer treats a recorded per-recipient failure (render,
no-destination, transport) as an event-level retryable failure: it marks the
outbox event `done`. Only an **unexpected** per-recipient error (which produced
no dispatch row) still leaves the event claimable via `markFailed`.

This retires the OP-94 event-level retry, which would otherwise re-fan the whole
event and double-send alongside the retry cron. ADR-0092 §I5 pinned the old
behaviour ("a retryable failure leaves the event claimable"); its rationale
(at-least-once delivery) is now satisfied by the reclaimable dispatch row, so
the pin is **stale**. ADR-0100's author did not flag the collision.

**Disputed test.** `apps/web/src/test/integration/notification-fan-out.test.ts`
(I5, line 586) asserts `dispatch.notifications === "pending"` after a retryable
transport failure. It is left **red** by this GREEN change and must be updated
to `"done"` by the Test Author. The alternative — keeping the event pending —
makes `notification-dispatch-retry.test.ts` I9/I10 red (its arithmetic requires
that a per-dispatch failure is **not** re-fanned) and leaves a real double-send
race in production. See the card comment for the full dispute.

## Alternatives considered

- **Keep the outbox event pending (ADR-0092) and dispute OP-96 I9.** Rejected:
  the retry cron and the fan-out would both redeliver a failed dispatch
  (duplicate sends), violating OP-96's "retries are idempotent" criterion.
- **Delay (backoff) the event re-claim instead of retiring it.** Rejected:
  merely deferring the duplicate send does not remove it.
- **Store the plaintext destination on the deferred dispatch row.** Rejected:
  schema §19.5 deliberately keeps only `contactHash`; the destination is
  re-resolved from the `user` row at redelivery time.

## Consequences

- The six OP-96 specs (unit U1–U3; integration I1–I12 + the route wiring) are
  green; `notification-fan-out.test.ts` I5 is the one explicitly disputed red.
- Digest, retry and release share the `CronRunOutcome` contract, so the routes
  stay thin `defineCronJob` wrappers.
- The digest flush writes a dispatch row whose `providerRef.env` comes from the
  injected config (`getAppEnv()`), never a constant.
