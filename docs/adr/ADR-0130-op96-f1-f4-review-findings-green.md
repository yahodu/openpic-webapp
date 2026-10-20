# ADR-0130 — OP-96 follow-up GREEN: implement review findings F1–F4 (single-owner digest flush failure, bounded retry attempts and reads, no empty-body redelivery)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up (GREEN, `t_6a4943e8`) · **Parent:** `t_8423b7c1` (the RED pins) · **Reviewed:** PR #216
- **Implements / amends:** ADR-0129 (the RED pins — the authoritative contract), ADR-0127 (per-dispatch failure ownership), ADR-0120 (the OP-96 contract; A1 amended here) · **Evidence:** ADR-0128 §3 (the GREEN review sign-off, findings F1–F4)
- **Branch:** `OP-96-task-f1-f4-review-findings-red`, base `origin/main` `3958213` (the pins and this implementation ship together in PR #216)

## Context

The RED pins (ADR-0129) fix the contract for the four behaviour findings the
OP-96 GREEN review routed out; every one failed for the intended reason against
the pre-fix tree. This card turns them green without touching any test, mock,
fixture or factory, and without changing behaviour the pins do not cover. It
continues on the RED branch so the pins and the implementation merge as one PR.

## Decision

### F1 — the ledger row is the single owner of a digest-flush failure

`flushDueDigests` now marks a due bucket `flushed` **when the failure has been
durably recorded on the `notificationDispatches` ledger row**, mirroring
ADR-0127: `notification-dispatch-retry` is the single re-sender, so the flush
cron can never re-select the bucket and double-send the summary. To keep this
honest, `flushOneBucket` distinguishes two failure shapes:

- `failed_recorded` — the transport rejected the send and a retryable `failed`
  ledger row was written. The bucket is closed (`flushed`).
- `failed_unrecorded` — no ledger row exists (an unresolvable destination, or an
  unbuildable message). Nothing owns a retry, so the bucket stays `open` for a
  later flush; closing it here would silently drop the digest.

The pin (one delivered summary, one ledger row, bucket `flushed`, no call on the
second flush tick) is satisfied by the `failed_recorded` path.

> **Accepted consequence (review consideration #1).** Closing a bucket on a
> recorded failure means a provider outage during the digest window consumes the
> recipient's `notifications.maxDigestEmailsPerDay` allowance: `countFlushedToday`
> counts every `flushed` bucket since local midnight, including one whose ledger
> row later succeeds only via the retry cron. The pin pins the bucket status to
> the literal `"flushed"`, so a distinct `flushFailed` marker is not available,
> and joining the count against the ledger row would need a bucket→dispatch link
> the schema does not carry. This is consciously accepted and left for a future
> pin; the reviewer's preferred alternative (count only ledger-`sent` flushes) is
> recorded here as the next-cycle candidate rather than implemented unpinned.

### F2 — retry attempts are bounded by the settings seam

`retryDueDispatches` reads `platformSettings.pipeline.maxAttempts` through the
existing `getPlatformSettings({ db, clock })` seam (never a constant) and adds
`attempts: { $lt: maxAttempts }` to the selection filter, so a row that has
reached the cap is never selected. The row is left exactly as it is — `status:
"failed"`, `attempts` unchanged — which is what the pin asserts; it simply
leaves the sweep. No terminal marker is written because the pin asserts the row
is unchanged and no test covers a marker.

### F3 — the three sweeps bound the read, not just the work

`dispatch-retry.ts`, `quiet-hours-release.ts` and `digest.ts` each add
`.limit(limit + 1)` to the selection query and set
`hasMore = selected.length > limit`. The run never materialises more rows than
it can process, and `hasMore` reports a remaining backlog even when every send
fails (`affected: 0`), which is the widened semantics the pin fixes.

> **ADR-0120 A1 amended (review consideration #2).** A1 defined `hasMore` as "a
> due, within-cap item was left unprocessed because the limit was reached". The
> F3 pin asserts `hasMore: true` with `affected: 0`, so `hasMore` now means "more
> **selectable** rows exist beyond `limit`". A1 carries an addendum recording
> this. The existing I6/I9/I11 pins (backlog of `limit + 1`, successful sends)
> are unaffected — they assert only `affected`/`hasMore`/`outbox` and still hold.

### F4 — a body-less row is classified terminally, never re-sent empty

`buildRedeliveryMessage` now returns `null` for a `body: null` target instead of
substituting `""`, and the shared `redeliverDispatchRow` classifies a
`body: null` row with a terminal, non-retryable `lastError` (`code:
"unretained_body"`, `retryable: false`) — exactly like the existing
`no_destination` classification. A retried `retainBody:false` type
(`auth.otp.email.requested`) therefore makes no transport call, is never sent as
a subject-only email, and leaves the sweep forever. The fix lives in the one
shared redelivery path both crons use (ADR-0128 §2); no per-cron copy returns.

### F5 / F7 — consciously not implemented (no pin covers them)

The card offered to close the two Low findings "if your pins cover them cheaply".
They are **not** pinned: ADR-0129 §Consequences explicitly leaves F5
(`upsertDigestBucket` E11000 on a duplicate arrival) and F7
(`releaseDeferredDispatches` silent no-op) for the Test Author. Per this lane's
hard rule — behaviour changes come only from the RED pins — neither is changed
here. A retry-once in `upsertDigestBucket` or an explicit F7 outcome would be
untested behaviour; both are recorded as next-cycle RED candidates. The F3 read
bound did touch `quiet-hours-release.ts`, but its `skipped = 0` and its
`message === null` early return are left exactly as they were.

## Consequences

- F1 makes the ledger row the single re-sender of a failed digest; F2 bounds
  retries by the settings cap; F3 bounds all three sweep reads; F4 guarantees a
  secret type is never re-sent body-less.
- The over-limit `scanned` semantics of all three sweeps change: the read is now
  capped at `limit + 1` regardless of how many sends fail. `hasMore` widens to
  "more selectable rows beyond the limit" (ADR-0120 A1 addendum).
- A failed digest consumes the recipient's daily allowance (accepted, above).
- F5 and F7 remain open and unpinned.

## Alternatives considered

- **F1: leave the bucket `open` and let both the flush and retry crons own the
  retry.** Rejected by the pin (a second flush tick must make no call).
- **F1: mark the bucket `flushed` for every failure, including unrecorded ones.**
  Rejected: with no ledger row nothing would redeliver, so the digest would be
  lost. The `failed_recorded` / `failed_unrecorded` split keeps exactly one owner
  in every case.
- **F2: record a terminal marker on the capped row.** Rejected: the pin asserts
  the row is unchanged (`status: "failed"`, `attempts` unchanged) and no test
  observes a marker; the query bound is sufficient and minimal.
- **F4: exclude `retainBody:false` rows at selection time.** Rejected in
  ADR-0129 (needs the type catalogue at sweep time, leaves the row retryable
  forever); the terminal classification in the shared path is simpler and
  durable.
- **F5/F7: implement opportunistically.** Rejected — unpinned behaviour changes
  violate the lane's hard rule; routed to a future RED card instead.
