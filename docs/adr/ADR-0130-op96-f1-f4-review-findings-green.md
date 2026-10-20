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

## Review sign-off (round 1, artifact lens) — APPROVED WITH FINDINGS

Reviewed head `cbe546a` (PR #216, base `origin/main` `3958213`). The reviewer
independently reproduced the whole suite in the lane worktree
(`/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`): `pnpm test:unit`
**85 files / 1477 passed**, `pnpm test:int` **51 files / 353 passed** (the four
F1–F4 pin files: 4 files / 6 tests passed), `tsc` ×3 exit 0, `eslint` 0 errors
(42 pre-existing warnings), `prettier --check` clean, `pnpm --filter
@openpic/web build` succeeds, and every PR check green on `cbe546a`. Diff scope
is 4 production files + 4 pin specs + 3 ADR files; the implementation commit
(`d5c8dff`) touches **no** test, mock, fixture or factory. The honesty audit is
clean (no `.only`/`.skip`, no `process.env`/`NODE_ENV` branch, no
`@ts-ignore`/`eslint-disable`, no `console.*`, no TODO, no dependency change).

The pinned contract (ADR-0129) is met and the two non-blocking considerations
raised on the RED card are answered: consideration #2 (`hasMore` widening) is
amended into ADR-0120 A1, and consideration #1 (the failed digest consuming the
daily cap) is consciously accepted and recorded above. The verdict is
**APPROVED WITH FINDINGS** — nothing found is a blocker, and every finding below
is a coverage gap or a hygiene item that needs its own RED pin (or metadata fix)
rather than a change to this delivery.

### Findings routed to a next-cycle RED pin (Test Author)

1. **F1b (Medium) — a non-retryable digest-flush failure closes the bucket with
   no owner.** `flushOneBucket` returns `failed_recorded` for _any_ transport
   failure (`digest.ts:322-348`), but the ledger row it writes carries
   `lastError: outcome.failure` — the transport's own classification — and
   `retryDueDispatches` only selects `lastError.retryable: true`
   (`dispatch-retry.ts:114`). So on a **non-retryable** failure the bucket is
   marked `flushed` (`digest.ts:459-464`) while the row is never re-selected:
   nothing redelivers the summary and it is silently dropped. The §F1 decision
   above describes the recorded row as "a retryable `failed` ledger row", which
   the code does not guarantee. The F1 pin
   (`notification-digest-flush-failure.test.ts:215`) scripts a retryable failure
   only. Pin the non-retryable branch (close only when the recorded failure is
   retryable, otherwise leave the bucket selectable or record a distinct owned
   terminal state).
2. **F2b (Medium) — a capped row keeps `lastError.retryable: true` forever.**
   The card asked the retry sweep to "record a terminal state so the row leaves
   the sweep"; the query bound (`dispatch-retry.ts:114`) does remove the row
   from the sweep but leaves the ledger asserting `status:"failed",
lastError.retryable:true` — indistinguishable from a row still awaiting its
   backoff. Any backlog/alert metric keyed on `retryable: true` therefore reports
   a permanent, growing queue, and an operator cannot tell "will retry" from
   "gave up". The F2 pin asserts the row is _unchanged_
   (`notification-dispatch-retry-cap.test.ts:271-273`) via `toMatchObject`, which
   permits (does not require) a marker. Pin a terminal marker (e.g.
   `lastError.code: "attempts_exhausted"`, `retryable: false`).
3. **F1c (Low) — a failed digest consumes the recipient's daily allowance.**
   Accepted above, but note the claim that a distinct marker "is not available"
   is too strong: the F1 pin asserts only `status` on the bucket, so a separate
   `flushOutcome` field (or counting only ledger-`sent` flushes) remains
   available. Pin "a failed flush does not consume `maxDigestEmailsPerDay`".
4. **F5 (Low) — `upsertDigestBucket`'s concurrency claim is not honoured.**
   The doc-comment (`fan-out.ts:727-734`) promises a concurrent arrival "can
   never reset the bucket's `firstItemAt` or lose a count", but the atomic
   pipeline upsert against the unique-open partial index can still raise
   `E11000` on a duplicate arrival. Unpinned and unchanged here, as recorded
   above.
5. **F7 (Low) — a deferred row can stay `deferred` forever.** `releaseDeferredDispatches`
   hard-codes `skipped = 0` (`quiet-hours-release.ts:90`) and
   `redeliverDispatchRow` returns `"error"` without writing a row when the
   message cannot be rebuilt (`dispatch-redelivery.ts:225`), so a deferred row
   whose channel is not outbound is never released and never recorded. Unpinned
   and unchanged here, as recorded above.

### Findings for the Implementer (comment accuracy, no behaviour change)

- `fan-out.ts:836-839` still says a render failure means "release falls back to a
  metadata-only message". After F4 that fallback no longer exists: a `body: null`
  row is classified terminally in the shared path. The comment should say so (or
  the fallback should be pinned). Non-blocking.

### Delivery-hygiene finding (fixed by the reviewer before merge)

- PR #216 still carried the **RED** title
  (`test(notifications): OP-96 pin the F1-F4 review findings (RED)`) and a body
  declaring "DRAFT — RED by design … Do not merge this branch on its own (CI is
  red by design)" although the branch now carries the GREEN implementation and CI
  is green. Since a squash merge takes the PR title as the commit subject, the
  release would have been mis-tagged (`test` → no version bump for production
  code) and main's history would have carried a false "do not merge" note. The
  reviewer corrected the title and body as part of this sign-off; the
  implementation commits themselves are untouched.

### Cross-lane finding (card created for the OP-97 lane)

- **ADR number collision (Medium, integration hygiene).** This branch claims
  `ADR-0129` + `ADR-0130`; the still-open OP-97 branch
  (`OP-97-task-in-app-feed-read-state-red`, PR #215) independently claims
  `ADR-0129` (`…op97-in-app-feed-read-state-unread-count-red`) and `ADR-0130`
  (`…op97-red-review-signoff`). OP-96 merges first, so the OP-97 lane must
  renumber `0129/0130 → 0131/0132` before its GREEN card `t_58825ec3` lands. A
  card is created for that lane and linked as a prerequisite of `t_58825ec3`.
  For the same reason this sign-off is a section of ADR-0130 rather than a new
  `ADR-0131`, which would have widened the collision.
