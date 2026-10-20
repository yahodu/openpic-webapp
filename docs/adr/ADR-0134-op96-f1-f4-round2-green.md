# ADR-0134 — OP-96 follow-up round 2 GREEN: implement F1b/F2b/F1c (digest-flush failure ownership, capped-row terminal marker, delivered-only daily cap) and settle F5/F7/#6 as docs-only

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-96 follow-up round 2 (GREEN, `t_6163c787`) · **Parent:** `t_1e598454` (the round-2 RED pins) · **PR:** #217 (draft until this lands)
- **Implements / amends:** ADR-0133 (the round-2 RED pins — the authoritative contract), ADR-0130 (the F1–F4 GREEN; A4 accounting amended here), ADR-0127 (per-dispatch failure ownership), ADR-0120 (the OP-96 contract; A4 amended here) · **Evidence:** ADR-0133 §"Review sign-off (round 1, artifact lens)"
- **Branch:** `OP-96-task-f1-f4-round2-red` (the RED pins and this implementation ship together in PR #217; the branch is **not** rebranched from `main`) · **Base:** `origin/main` `37a82d0` (post-merge #216) · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_6a4943e8`

## Context

The round-1 review of the OP-96 F1–F4 GREEN (ADR-0130 §"Review sign-off") was
**APPROVED WITH FINDINGS**. Findings F1b/F2b/F1c were pinned RED by ADR-0133
(`pnpm test:int` → 3 failed / 353 passed on `e73cfbb`); F5, F7 and the stale
comment (#6) were analysed as **not** deterministically pin/gate-able and routed
to this card as unpinned items. This record turns the three pins green without
touching any test, mock, fixture or factory, and without changing behaviour the
pins do not cover.

## Decision

### F1b — a bucket is closed only when the recorded failure has an owner

`flushOneBucket` (`digest.ts`) now classifies a recorded transport failure by
whether anything will redeliver it:

| Outcome             | When                                                                          | Bucket       | Daily allowance  |
| ------------------- | ----------------------------------------------------------------------------- | ------------ | ---------------- |
| `sent`              | the transport accepted the summary                                            | `flushed`    | consumed         |
| `failed_retryable`  | recorded failure with `lastError.retryable: true` — the ledger row owns it    | `flushed`    | **not** consumed |
| `failed_terminal`   | recorded failure with `retryable: false` — no cron re-selects it              | stays `open` | not consumed     |
| `failed_unrecorded` | no ledger row at all (no destination / unbuildable message) — nothing owns it | stays `open` | not consumed     |

This is the pin's **option (a)**: the bucket stays selectable and a later flush
tick re-attempts the summary — a _delivery-based_ observable, not an
observability-only one — and the F1 single-owner rule stays coherent (the bucket
is closed only where the ledger genuinely owns the redelivery).

> **Accepted consequence (reviewer finding F1b-r2, routed).** A _permanently_
> non-retryable failure (a provider `400` for a bad destination) is therefore
> re-attempted on every subsequent flush tick, inserting a fresh `attempts: 1`
> `failed` ledger row per attempt until the bucket's `expireAt` TTL retires it.
> The pin scripts one failure then recovery, so it bounds nothing here. Bounding
> it is **not** implemented: no pin covers it, and the round-3 TEST card
> `t_b6540886` (gated after this card) exists precisely to pin the boundary. The
> unbounded repeat is unchanged-and-unfixed, not silently accepted.

### F2b — a capped row is observably terminal, written by the sweep that owns the cap

`retryDueDispatches` keeps reading `platformSettings.pipeline.maxAttempts`
through the `getPlatformSettings({ db, clock })` seam, but its selection no
longer hides capped rows: it reads
`{ status: "failed", "lastError.retryable": true }` (still bounded by
`.limit(limit + 1)`) and, for a row with `attempts >= maxAttempts`, records the
terminal marker instead of re-attempting it:

```js
lastError: { retryable: false, code: "attempts_exhausted" }
```

`attempts` is left unchanged, no transport call is made, and the row leaves the
sweep forever (its `lastError.retryable` is now `false`). `errors` reports it;
`affected` stays 0, so a backlog metric keyed on `retryable` can no longer
report a permanent queue.

Why the sweep observes and classifies, rather than the attempt that exhausts the
budget writing its own marker:

- it is the only place that can hold the invariant for **every** path — a row
  that reached the cap before this shipped, or via a fan-out attempt under a
  `maxAttempts: 1` setting, is reconciled on the next tick too;
- it keeps one bounded read per tick (ADR-0130 F3) with no second query and no
  change to the existing `scanned`/`hasMore` semantics;
- the ledger state machine stays linear: an attempt never reports two different
  classification kinds at once.

> **Accepted consequence.** The terminal marker supersedes the last transport
> error's own classification on that row (`code: "http"`, `status: 503` are not
> retained alongside it). `attempts`, `failedAt` and the prior attempts' history
> are untouched, and the marker is what makes "will retry" distinguishable from
> "gave up" — which is the finding. Preserving the transport code inside a
> terminal marker would need a shape no document defines; it is left out rather
> than invented.

### F1c — only a delivered flush consumes the daily allowance

A closed bucket now records **why** it closed, in a field distinct from
`status` (`digest.ts`):

```js
{ status: "flushed", flushOutcome: "sent" | "failed", flushedAt: <now> }
```

`countFlushedToday` counts `{ userId, status: "flushed", flushOutcome: "sent",
flushedAt: { $gte: localMidnight } }`, and the in-run `sentByUser` accumulator is
incremented on a `sent` flush only. A provider outage during the digest window
therefore no longer burns a recipient's allowance for a digest that never
arrived.

> **ADR-0120 A4 amended.** A4 read "the count is the recipient's `flushed`
> buckets since local midnight"; it is now "…the recipient's flushes that were
> actually **sent** (`flushOutcome: "sent"`)…". The reviewer's earlier note that
> "a distinct marker is not available" (ADR-0130 §F1) was correct to be
> challenged: the F1 pin asserts only `status`, so a separate field is available
> — and is what this implements. `docs/Notification and Database Design.md`
> §19.6 gains `flushOutcome` on the bucket shape so the authoritative schema
> matches the code.
>
> **Deploy edge.** A bucket flushed by the previous version carries no
> `flushOutcome`, so it stops counting for the remainder of that local day. The
> effect is an _under_-count (at most one day of extra digest allowance),
> never an over-send of the cap, and it is bounded by the bucket TTL.

### F5 — doc-comment narrowed, no behaviour change (no pin)

`upsertDigestBucket` keeps its single atomic pipeline upsert. Its doc comment no
longer promises a dedupe it cannot provide: two arrivals whose query phases both
miss the `{userId, bucketKey, status: "open"}` filter both attempt the insert,
the loser raises `E11000` on `notification_digests_user_bucket_open_unique`, and
per-recipient isolation records that as a fan-out failure leaving the event
claimable — so a later sweep re-processes it and the arrival is counted then.
Never lost, transiently uncounted, now stated. A retry-once on the duplicate-key
error (the other option the card offers) is **not** implemented: it is
production behaviour no pin gates, which the lane's hard rule forbids. It
remains the recorded candidate if ADR-0133 §F5's race is ever made pinnable.

### F7 — no behaviour change; the premise is corrected in place (no pin)

`releaseDeferredDispatches` keeps `skipped = 0`, now with a comment stating why
it is structural: every selected deferred row is either released (`sent`) or
recorded as a terminal `failed` row with a classified `lastError`
(`unretained_body` / `no_destination` / the transport's classification) and
counted in `errors`. `redeliverDispatchRow` has no path that returns without
writing the row — ADR-0133 §F7's accepted analysis (independently verified in
ADR-0133's sign-off) — so "a deferred row silently left `deferred` forever" does
not exist and forcing `skipped > 0` would re-classify a non-defect.

### #6 — the stale comment is corrected (docs-only)

`fan-out.ts`'s `writeDeferred` catch comment claimed release "falls back to a
metadata-only message". After F4 (ADR-0130) no such fallback exists: a `body:
null` row is classified terminally as `unretained_body` in the shared path. The
comment now says exactly that, and why a subject-only send is deliberately not
used.

## Consequences

- A non-retryable digest-flush failure no longer drops the summary (the bucket
  stays selectable); a retryable one is still owned solely by
  `notification-dispatch-retry` (F1/ADR-0130 unchanged).
- A row at `pipeline.maxAttempts` leaves the sweep with an observable terminal
  classification, including rows that were already at the cap when this shipped.
- A failed digest flush no longer consumes the recipient's daily allowance; the
  bucket shape gains `flushOutcome` (documented in the schema §19.6).
- F5 is now truthfully documented (still collision-prone, self-healing); F7 needs
  no change; the `fan-out.ts` release comment matches F4.
- F1b-r2 (unbounded re-attempt of a permanently non-retryable failure) is
  **open** and pinned by the round-3 TEST card `t_b6540886`.

## Alternatives considered

- **F1b option (b): record a distinct owned terminal state and close the
  bucket.** Rejected by the pin (ADR-0133 §F1b): it makes the drop observable
  while the summary is still never delivered, and weakens the single-owner rule.
- **F2b: write the marker from the attempt that exhausts the budget.** Rejected:
  it cannot reconcile rows that are already at the cap (including rows that
  reached it before this shipped), and it puts cap knowledge in a path used by
  both redelivery crons (the release sweep does not read `maxAttempts`).
- **F2b: a second bounded reconciliation query.** Rejected: it doubles the
  sweep's read and would either exceed the ADR-0130 F3 `scanned <= limit + 1`
  bound or silently under-report scanned rows.
- **F2b: keep the transport's `code`/`status` inside the terminal marker.**
  Rejected: no document defines that shape; the pin fixes `code:
"attempts_exhausted"`, and inventing a composite `lastError` is a schema
  change with no consumer.
- **F1c: count only ledger-`sent` flushes.** Rejected: the bucket→dispatch link
  it needs is not in the schema (ADR-0130 §F1), and a ledger row for the same
  user/type does not prove it was the digest summary.
- **F5: retry the bucket upsert once on a duplicate-key error.** Not adopted —
  unrequested behaviour with no pin (see §F5).
- **#6: implement the metadata-only release fallback instead of correcting the
  comment.** Rejected: F4 removed it deliberately (a subject-only send delivers
  empty copy); no pin asks for it back.

## Review sign-off (round 2 GREEN, artifact lens)

_Pending — to be recorded here by `openpic-webapp-reviewer` on PR #217, in place,
so the lane does not consume a second ADR number (the convention the round-1
GREEN lane used inside ADR-0130)._
