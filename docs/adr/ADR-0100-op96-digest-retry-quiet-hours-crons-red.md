# ADR-0100 — OP-96 RED: digest buckets, dispatch retry and the quiet-hours release cron

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-96 phase 1 (RED, `t_bf539e5b`) · **Depends on:** OP-94 (ADR-0092 fan-out, ADR-0093 review finding Medium), OP-87 (ADR-0028 internal HMAC + bounded cron framework)
- **Design:** §5 (channel resolution / quiet hours), §6 (throttling, digests and aggregation), §19.5 (`notificationDispatches`), §19.6 (`notificationDigests`) · **Contract:** §9.10 (`platformSettings.notifications`), §10.2 (`notification-digest-flush`, `notification-dispatch-retry`, `quiet-hours-release`) · **GREEN card:** `t_609968cf`
- **Supersedes / amends:** none. Resolves the OP-94 Medium review finding (ADR-0093 §Findings).

## Context

OP-94 shipped the fan-out consumer, but three design §6/§19 behaviours were
explicitly de-scoped and one was found defective:

1. **Digest accumulation was a stub.** `dispatchOutbound` maps a `digest`
   decision to `writeDigestQueued`, which persists a `queued`
   `notificationDispatches` row per arrival. Design §6/§19.6 say occurrences
   accumulate in one `notificationDigests` bucket with a `flushAt` that the
   `notification-digest-flush` cron drains. Per-arrival `queued` rows are the
   wrong mechanism — the retry cron would re-send them and there is no bucket to
   render one summary from.
2. **No digest flush cron, retry cron or release cron existed.**
3. **A quiet-hours `defer` was persisted as a terminal `skipped` row**
   (`fan-out.ts` `defer` branch → `writeSkip(..., "quiet_hours_deferred")`) with
   no `until`; `runNotificationFanOut` then marked the outbox event `done`, so
   nothing could ever release the deferred send (ADR-0093 Medium).

This lane pins the three crons and the durable deferral. The RED tests define the
contract; the GREEN card implements it.

## Decision

### Module contract

| Module (specifier)                                 | Exports                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/notifications/digest` (new)              | `computeDigestFlushAt(input): Date`; `withinDigestDailyCap(sentToday, maxPerDay): boolean`; `flushDueDigests(options): Promise<CronRunOutcome>`; types `DigestFlushAtInput`, `DigestFlushOptions` |
| `@/server/notifications/dispatch-retry` (new)      | `retryBackoffMs(attempts): number`; `retryDueDispatches(options): Promise<CronRunOutcome>`; types `DispatchRetryOptions`                                                                          |
| `@/server/notifications/quiet-hours-release` (new) | `releaseDeferredDispatches(options): Promise<CronRunOutcome>`; type `QuietHoursReleaseOptions`                                                                                                    |

The job functions return the §10.2 `CronRunOutcome` shape
(`{ scanned, affected, skipped, errors, hasMore, details? }`) so the route wraps
them with the existing `defineCronJob`; each takes
`{ db?, clock?, transport, limit? }`.

Routes (new), each exporting `GET`/`POST` exactly like
`app/api/v1/internal/cron/sample/route.ts`, guarded by `internalAuthStage`, and
named to match the §10.2 table:

| Route (specifier)                                              | Job name                      | Default limit |
| -------------------------------------------------------------- | ----------------------------- | ------------- |
| `@/app/api/v1/internal/cron/notification-digest-flush/route`   | `notification-digest-flush`   | 1000          |
| `@/app/api/v1/internal/cron/notification-dispatch-retry/route` | `notification-dispatch-retry` | 500           |
| `@/app/api/v1/internal/cron/quiet-hours-release/route`         | `quiet-hours-release`         | 1000          |

### Digest buckets (`notificationDigests`)

The fan-out's `digest` branch **upserts one open bucket** instead of
`writeDigestQueued`; the `queued`-per-arrival dispatch row is removed. A bucket
is keyed by `{ userId, bucketKey, status: "open" }` with `bucketKey` the
`resolveChannel` value (`` `${typeKey}:${eventId ?? ""}` ``), and carries
`itemCount`, `sampleItems`, `firstItemAt`, `lastItemAt`, `flushAt`, `status` and
`expireAt` (schema §19.6).

`flushAt = min(lastItemAt + digestQuietMinutes, firstItemAt + digestHardFlushHours)`,
computed by `computeDigestFlushAt` from `platformSettings.notifications`
(`digestQuietMinutes` 15, `digestHardFlushHours` 6) — never a constant.

`flushDueDigests` selects `status: "open" && flushAt <= now`, renders one summary
per bucket from `sampleItems`, sends via the injected transport, writes the
`sent`/`failed` dispatch row and marks the bucket `flushed`. It respects
`maxDigestEmailsPerDay` (default 3) per recipient per local day: a due bucket
beyond the cap is **deferred** — it stays `open` (never dropped) — which is
`withinDigestDailyCap`'s decision.

**Collection name.** The tests reference the literal `"notificationDigests"`
(schema §12/§19.6). `COLLECTIONS` must gain a `notificationDigests` key with
that value; `INDEX_SPECS` should add the schema §19.6 indexes
(`{userId,bucketKey}` unique partial on `open`; `{status,flushAt}` partial on
`open`; TTL on `expireAt`).

### Dispatch retry (`notification-dispatch-retry`)

`retryBackoffMs` is base **60 s**, **×2** per attempt, capped at **5 min**
(the contract's "×2, capped" retry rule). `retryDueDispatches` selects
`status: "failed" && lastError.retryable: true` rows whose
`failedAt + retryBackoffMs(attempts) <= now`, re-attempts via the transport,
increments `attempts` and marks the row `sent` on success. A non-retryable
failure (`lastError.retryable: false`) is **never** selected or re-sent.

### Quiet-hours deferral + release (`quiet-hours-release`)

- `DispatchRow` gains `status: "deferred"` and an `until: Date | null`.
- The fan-out `defer` branch writes `{ status: "deferred", until: <window end> }`
  — **not** a terminal `skipped` row, and with no `skipReason`.
- `INDEX_SPECS` gains a partial index on `{status, until}` so the sweep is
  index-supported.
- `runNotificationFanOut` still marks the outbox event `done`: the deferred
  dispatch row is the durable pending intent (ADR-0093 decision).
- `releaseDeferredDispatches` selects `status: "deferred" && until <= now`,
  sends, and marks the row `sent`/`failed`, bounded by `limit` with `hasMore`.

## Assumptions (ambiguities resolved, none silently guessed)

1. **Retry backoff base is 60 s.** The design fixes the growth (`×2`) and the
   ceiling (5 min) but not the base; 60 s keeps a transient failure retryable on
   the 5-minute cron cadence without an immediate hammer. Pinned in U3.
2. **The digest quiet period and hard flush come from platform settings**
   (`digestQuietMinutes`, `digestHardFlushHours`), not from the type's
   `throttle.windowHours` (which is 6 for `attendee.matches.new` and coincides
   here). Settings are runtime tunables (CONVENTIONS §6).
3. **A digest arrival writes no dispatch row.** A per-arrival `queued` row would
   be re-sent by the retry cron; I1 asserts the ledger is empty before a flush.
4. **The daily cap is enforced per recipient per local day.** "A 4th digest email
   in a day deferred" is pinned as: three flushes in one day, the fourth bucket
   stays `open` and no fourth email is sent (I3). Cross-day rollover of the
   count is left to the implementation.
5. **`until` is a `Date` on the deferred row** (per the ADR-0093 decision); the
   spec asserts the instant, tolerating Date or ISO serialization.
6. **The retry/release re-attempt content is the implementation's concern.** The
   specs produce the failed/deferred rows through the real fan-out, so the
   implementation may persist whatever it needs (rendered copy or payload) to
   reconstruct the message; the assertions are on the observable transport call
   and the row transition, never on a stored field shape.

### Addendum — OP-96 follow-up RED pins (card `t_7a67b87d`)

The phase-1 RED review (ADR-0101, task `t_bf539e5b`) approved the contract but
found four coverage gaps. This addendum settles the two that needed a product
decision and records the pins that close all four. The pins live on the same RED
branch (`OP-96-task-digest-retry-quiet-hours-crons-red`) and the GREEN card
`t_609968cf` must satisfy them.

**A1 — Bounding and `hasMore` (all three crons).** Each job already returns the
§10.2 `CronRunOutcome`, but no phase-1 pin exercised `limit`/`hasMore`. The pins
(I6, I9, I11) fix the semantics: a run selects at most `limit` due rows, reports
`affected === limit` and `hasMore: true` **iff** an unselected due row remains;
when the backlog is smaller than `limit` the run drains it (`hasMore: false`).
`hasMore` is about _unprocessed due work_, not about the daily cap: a
cap-deferred digest bucket stays `open` and is **not** counted as `hasMore`.

**A2 — Idempotency (retry and release).** A row transitions to a terminal
`sent`/`failed` state, so a second consecutive run selects nothing: I10 and I12
pin `affected: 0` and no further transport call / outbox growth after a
successful retry or release, and I12 additionally pins that two deferred rows
for the same recipient are each sent exactly once.

**A3 — Digest daily-cap day boundary (resolves assumption 4).** The cap is
counted per **recipient per local day**, where "local" is the recipient's
configured time zone: `notificationPreferences.quietHours.timeZone` (the only
per-recipient zone in the schema; UTC when the preference row or the field is
absent). I7 pins that a bucket due after local midnight earns a fresh allowance
even while it is still the previous day in UTC. This forbids a server-local or
UTC-day implementation chosen by accident.

**A4 — Cap scope is per recipient, not per type (and not per event).** ADR-0100
assumption 4 ("per recipient per local day") is the approved reading, against
the GREEN card body's looser "per user per type" wording. I8 pins it: three
digests of one type exhaust the day's allowance for the recipient, so a due
bucket of a _different_ digest type the same day is deferred (`affected: 0`,
bucket stays `open`). Flagged for the orchestrator: design §6 / G3 phrase the
cap as "≤3 emails/day/event"; if product intends a per-type or per-event scope
instead, I8 must be updated **before** GREEN, never silently loosened.

**A5 — Partial `{status, until}` index.** The phase-1 I5 assertion accepted any
index whose key named `status` and `until`; it now requires a non-null
`partialFilterExpression` (ADR-0100 §Quiet-hours deferral) so the release sweep
is index-supported only for deferred rows.

## RED evidence

- `pnpm test:unit` → `Test Files 2 failed | 79 passed`; the two failures are
  `Cannot find package '@/server/notifications/digest'` and
  `.../dispatch-retry` (new modules). The 1444 existing unit tests pass.
- `pnpm test:int` → `Test Files 4 failed | 40 passed`; the four failures are the
  four new integration specs, each `Cannot find package` for its new module/route.
  The 297 existing integration tests pass (MongoMemoryReplSet global setup boots
  cleanly).
- `tsc -p apps/web/tsconfig.json --noEmit` reports **only** the 8 expected
  `TS2307` module-not-found errors for the new modules/routes; every spec is
  otherwise type-correct.
- `prettier --check` and `eslint` are clean on all six new files.

Base tree: `origin/main` `d261297` (OP-95 sign-off merged), worktree branch
`wt/t_bf539e5b`.

## Consequences

- The three de-scoped crons and the durable quiet-hours deferral are specified
  end-to-end; a regression in flush scheduling, the daily cap, retry
  classification or deferral release fails loudly.
- The OP-94 Medium finding is closed by the settle decision recorded here: a
  deferral is durable and selectable, not a terminal skip.
- `notificationDigests` is introduced as a first-class collection with its
  indexes; the fan-out no longer writes per-arrival `queued` rows for digest
  types.
- Digest flush, retry and release share one `CronRunOutcome` contract, so the
  routes are thin `defineCronJob` wrappers.

## Out of scope (deliberately not tested)

- The `/internal/cron/notification-fanout` route and the `after()` opportunistic
  trigger (the OP-94 cron-route lane; not this card).
- Cross-day rollover of the digest daily counter is pinned by the follow-up
  addendum A3/I7 (the recipient's local day, resolved above); the
  `notificationDigests` TTL/unique index _bodies_ remain out of scope (the
  collection name is pinned; the index specs are the GREEN card's to add and are
  asserted only structurally in I5 for the dispatches `{status,until}` index).
- Admin deliverability-forensics routes and suppression-list CRUD.
- Playwright e2e — the card's `e2e_api_playwright` list is empty.

## Alternatives considered

- **Keep `writeDigestQueued` and flush `queued` dispatch rows.** Rejected:
  design §6/§19.6 make `notificationDigests` the aggregation mechanism, and a
  `queued` row is indistinguishable to the retry cron from an unsent dispatch.
- **Release a quiet-hours deferral by re-deriving it from the outbox event.**
  Rejected: `runNotificationFanOut` marks the event `done`; the durable,
  selectable intent must live on the dispatch row (`status: "deferred", until`).
- **Retry every `failed` row regardless of `retryable`.** Rejected: a permanent
  provider/contract failure would be retried forever; I4 pins that a
  non-retryable row is untouched.
- **Enforce the daily cap by dropping the 4th bucket.** Rejected: the card says
  "deferred", so the bucket stays `open` for a later day.
