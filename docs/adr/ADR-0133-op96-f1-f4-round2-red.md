# ADR-0133 — OP-96 follow-up round 2 RED: pin F1b/F2b/F1c (non-retryable digest-flush owner, capped-row terminal marker, failed-flush daily-cap accounting); F5/F7 analysed as not deterministically pinnable

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 2 (RED, `t_1e598454`) · **Parent:** `t_6a4943e8` (round-1 GREEN + review sign-off) · **GREEN card:** `t_6163c787` (gated on this one)
- **Implements / amends:** ADR-0120 (the OP-96 contract), ADR-0126 (OP-96 GREEN), ADR-0127 (per-dispatch failure ownership), ADR-0130 (F1–F4 GREEN + round-1 review sign-off) · **Evidence:** ADR-0130 §"Review sign-off (round 1, artifact lens)"
- **Branch:** `OP-96-task-f1-f4-round2-red`, base `origin/main` `37a82d0` (post-merge #216) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

The round-1 (artifact-lens) review of the OP-96 F1–F4 GREEN card (`t_6a4943e8`, PR #216,
squash-merged as `fde586b`) was **APPROVED WITH FINDINGS**. Findings F1b, F2b, F1c, F5 and F7 are
unpinned behaviour gaps / hygiene items, so they must be pinned RED before any implementation
change. This record is the RED contract; the GREEN card `t_6163c787` is gated on it.

| #   | Sev    | Finding                                                                                                                                                                        | Pinned?               |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| F1b | Medium | A **non-retryable** digest-flush failure closes the bucket while the ledger row keeps `retryable:false`, so the retry cron never re-sends it — the summary is silently dropped | **Yes**               |
| F2b | Medium | A row at `pipeline.maxAttempts` keeps `status:"failed", lastError.retryable:true` forever — no observable terminal state, so a backlog metric keyed on `retryable` lies        | **Yes**               |
| F1c | Low    | A **failed** digest flush consumes the recipient's `notifications.maxDigestEmailsPerDay` allowance                                                                             | **Yes**               |
| F5  | Low    | `upsertDigestBucket`'s "a concurrent arrival can never … lose a count" doc claim is false (`E11000` on a duplicate arrival)                                                    | No — see §F5          |
| F7  | Low    | `releaseDeferredDispatches` "can leave a row `deferred` forever" (`skipped` hard-coded 0; `dispatch-redelivery.ts:225`)                                                        | No — see §F7          |
| #6  | Low    | Stale `fan-out.ts:836-839` comment claiming a metadata-only release fallback F4 removed                                                                                        | No — no pin covers it |

No production code is changed by this card; every new pin fails for the right reason against
`origin/main` `37a82d0`.

## Decision

### New pins (integration, real `MongoMemoryReplSet` + real seed catalogue)

| Pin | File                                                                               | Observable                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1b | `apps/web/src/test/integration/notification-digest-flush-non-retryable.test.ts`    | after a non-retryable flush failure the bucket stays `open`, the retry sweep makes **no** call, a later flush delivers the summary, and no path double-sends |
| F2b | `apps/web/src/test/integration/notification-dispatch-retry-cap.test.ts` (extended) | a row at the cap reaches `status:"failed", lastError:{retryable:false, code:"attempts_exhausted"}`, is not selected, `attempts` unchanged, no transport call |
| F1c | `apps/web/src/test/integration/notification-digest-flush-daily-cap.test.ts`        | with `maxDigestEmailsPerDay: 1`, a failed flush still lets the recipient's next digest go out (two due buckets both attempted)                               |

Each pin drives real production paths (`runNotificationFanOut`, `flushDueDigests`,
`retryDueDispatches`) and asserts only observable outcomes (transport calls/deliveries, stored
bucket/ledger state, `CronRunOutcome` counters).

#### F1b — the design choice under the card's two options

The card allows either "the bucket stays selectable" or "the row reaches a distinct terminal state
that is durably observable". The pin selects **option (a): the bucket stays selectable**. Rationale:
option (a) yields a _delivery-based_ observable (the summary is eventually delivered exactly once
once the provider recovers) rather than an observability-only one, and it keeps the failure
ownership rule coherent — the bucket is closed only when the recorded failure actually has an owner
(a **retryable** transport failure → the ledger row owns the redelivery, exactly as the F1 pin
fixes). The pin also proves the retry cron is _not_ an owner for the non-retryable row (no second
transport call), so "no path double-sends" is verified, not assumed.

> Ambiguity resolved: the bucket for a non-retryable flush failure is left `open` _and_ a `failed`
> non-retryable ledger row is still recorded. A later successful flush therefore leaves **two**
> ledger rows (the failed one plus the `sent` one) for the same bucket; the pins assert exactly one
> _delivered_ message, not one ledger row.

#### F2b — the cap is read through the settings seam

The pin seeds a **non-default** `pipeline.maxAttempts: 2` into the `platformSettings` singleton (as
the F2 pin does) so it never depends on the shipped default. It asserts the terminal marker on the
tick at which the sweep observes the capped row, so it holds whether the implementation writes the
marker when `attempts` reaches the cap or when the sweep next sees the capped row. The `code` is
pinned to `"attempts_exhausted"` and `retryable` to `false`, per the card. The existing F2
assertions ("not selected, `attempts` unchanged, no transport call") are preserved untouched; the
new case is an additional `it`.

#### F1c — an observable delivery, not a private counter

Rather than inspect an internal `sentByUser` map, the pin seeds a **non-default**
`maxDigestEmailsPerDay: 1` and gives the recipient two due buckets whose first send fails
retryably. If the failed flush consumed the allowance the second bucket is deferred
(`affected: 0, skipped: 1, transport.calls: 1`); if it did not, the second digest is sent
(`affected: 1, errors: 1, transport.calls: 2`). Both the bucket-`flushOutcome`-marker design and
the "count only ledger-`sent` flushes" design satisfy it.

### F5 — analysed, deliberately **not** pinned (not deterministically reproducible)

`upsertDigestBucket` (`fan-out.ts`) uses one pipeline upsert against the unique partial index
`notification_digests_user_bucket_open_unique`. Two _truly concurrent_ arrivals that both miss the
filter both attempt the insert; one inserts, the loser gets `E11000`, which the per-recipient
isolation turns into `markFailed` — the outbox event stays claimable and that arrival is uncounted
until a later sweep re-processes it.

The RED hypothesis ("two concurrent arrivals for the same `{userId, bucketKey}` must record one
bucket with `itemCount: 2` and leave no event claimable") was driven empirically through the real
fan-out + real index against `MongoMemoryReplSet`:

- Plain `Promise.all` of two separate fan-out runs over two events sharing one `payload.eventId`:
  the collision is **intermittent** (observed ≈1 in 24 concurrent upserts) — the second upsert
  usually matches the first's insert instead of colliding.
- A `Db` proxy that rendezvouses the two `notificationDigests.updateOne` calls so both reach the
  driver in one tick made the collision **reliably** reproducible in isolation (4/4 runs RED, with
  a real `E11000 duplicate key error` on the unique index and `itemCount: 1`), **but the same spec
  passed under a full `pnpm test:int` run** (55 files, parallel workers) — i.e. the harness that
  forces the race is itself load-sensitive.

A pin that is RED in isolation and green under the full suite is a flaky test, which the pipeline's
rules forbid delivering. There is no deterministic black-box reproduction: `E11000` requires the two
upserts' query phases to overlap, and no production seam sits between the upsert's filter match and
its insert. **Decision: not pinned.** F5 is routed to the GREEN card `t_6163c787` as an _unpinned_
hardening item — retry the bucket upsert once on a duplicate-key error (making the doc claim true),
or narrow the `upsertDigestBucket` doc comment to acknowledge the transient collision. No test
asserts it, so the GREEN card must not treat it as gated by a pin.

### F7 — analysed, deliberately **not** pinned (the identified path is unreachable)

`redeliverDispatchRow` (`dispatch-redelivery.ts`) returns `"error"` without writing a row only at
line 225, where `buildRedeliveryMessage` returns `null`. That happens iff the channel is not
`email`/`sms`/`whatsapp`, or `userId` is `null`, or `body` is `null`. All three are handled _earlier_
in the same function: `body === null` records `unretained_body` (F4), and both a non-outbound
channel and a `null` `userId` make `resolveDestination` return `null` first, which records
`no_destination`. Line 225 is therefore dead code, and no deferred row is ever left `deferred`
silently. Empirically, seeding three `deferred` rows that "cannot be rebuilt" (an `in_app`-channel
row, a `null`-`userId` row, and an `email` row to a user with no destination) and running the real
`releaseDeferredDispatches` yields `{scanned:3, affected:0, skipped:0, errors:3}` with every row at
`status:"failed", lastError:{retryable:false, code:"no_destination"}` — i.e. every unbuildable row
already reaches a recorded terminal state (the card's first acceptable observable), and the release
outcome already reports a non-zero `errors` counter (the card's second acceptable observable).

**Decision: not pinned.** The card's fallback ("decide and pin one") has no RED-able option: both
listed observables already hold. F7 is routed to the GREEN card as _no behavioural change required_
— the reviewer premise should be corrected (and the `skipped = 0` hard-code left as-is, or a comment
added explaining that `errors` reports it).

### #6 — stale comment

No pin above covers the render-failure path in `writeDeferred` (`fan-out.ts:836-839`), so per the
card the comment correction is left to the GREEN card as a docs-only change (a comment cannot carry
a RED pin).

## RED evidence

- `pnpm test:int` → **3 files failed / 50 passed (53); 3 tests failed / 353 passed (356)**. The only
  failures are the three new pins; every previously green integration test (including the merged
  F1–F4 pins and the original F2 case) still passes — no regression.
- Each new pin fails for its intended reason:
  - **F1b** → `(await theBucket(db))?.status` is `"flushed"` (expected `"open"`): the non-retryable
    failure closed the bucket with no owner.
  - **F1c** → `transport.calls` is `1` (expected `2`): the failed flush consumed the cap of one and
    the recipient's second digest was deferred.
  - **F2b** → `lastError` is `{retryable:true, code:"http"}` (expected `{retryable:false,
code:"attempts_exhausted"}`): the capped row has no terminal state.
- `pnpm typecheck` clean; `pnpm exec eslint` on the three files clean; `pnpm exec prettier --check`
  clean.

## Consequences

- The GREEN card `t_6163c787` can implement F1b/F2b/F1c against an unambiguous, executable contract;
  it must continue on **this** branch (`OP-96-task-f1-f4-round2-red`) so the pins ship with the
  implementation.
- F1b makes the non-retryable flush failure owned (the bucket stays selectable) instead of silent;
  F2b gives the capped row a terminal, non-retryable classification; F1c stops a failed flush from
  burning a recipient's daily digest allowance.
- F5 and F7 carry **no RED pin**; the GREEN card must treat them as unpinned (doc/narrowing) items,
  not as gated behaviour. This is recorded here so a future round does not mistake the "absence of a
  failing test" for "the reviewer's finding was retracted".
- The F1b pins assert one _delivered_ message across a bucket's failed-then-successful flush, and
  therefore tolerate two ledger rows for that bucket.

## Alternatives considered

- **F1b option (b): record a distinct owned terminal state and close the bucket.** Rejected: it
  makes the drop _observable_ but the summary is still never delivered, and it weakens the F1
  single-owner rule (the ledger row would become a second kind of owner).
- **F1c: assert the release/flush `skipped` counter only.** Rejected: asserted a delivery
  (the second digest going out) so the pin cannot be satisfied by a counter-only implementation that
  still fails to deliver.
- **F2b: pin the marker only on the following tick.** Rejected: pinning it on the tick at which the
  sweep observes the capped row accepts both "write it when `attempts` reaches the cap" and "write
  it on the next sweep" implementations.
- **F5: ship the rendezvousing `Db`-proxy harness as a RED pin.** Rejected: it is RED in isolation
  but passed under a full parallel `pnpm test:int` run, i.e. it flakes — see §F5.
- **F5: fault-inject a synthetic `E11000` at the driver boundary.** Rejected: it would pin the
  catch-and-retry implementation specifically and break under the equally-valid "make the pipeline
  idempotent" fix, and it asserts on an internal call rather than the real race.
- **F7: seed an unbuildable `deferred` row and assert `skipped > 0`.** Rejected: the only
  reachable unbuildable cases already record a terminal `no_destination` and are reported in
  `errors`; forcing `skipped` would impose an arbitrary re-classification of a non-defect.
