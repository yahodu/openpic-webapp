# ADR-0443 — OP-108 follow-up GREEN: the projection watermark guard is atomic with the write

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-108 follow-up GREEN (`t_bd4d7286`) · **Branch:** `OP-108-task-webhook-inbox` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a297e850`
- **Relates to:** [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) (the RED contract), [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the applier and the watermark), [ADR-0442](ADR-0442-op108-concurrent-projection-ordering-red.md) (the pin this record turns green)
- **Contract:** §10.1 step 6 ("orders by the provider's `occurredAt`, never by arrival"), §10.1.2, §23 (money and access move together) · **Appendix A:** (none new)

## Context

`projectProviderWebhookEvent` reads the matched subscription and checks the
ordering watermark `lastProviderEventAt` **outside** `withTransaction`, then
applies an **unconditional** `$set` inside it (ADR-0441). Two projections for
one subscription that run concurrently therefore both read the pre-write row,
both pass the watermark check, and whichever transaction commits last wins — so
the **older** event's patch can land last and regress `status` /
`lastProviderEventAt`. The route schedules each projection through `after()`, so
two near-simultaneous deliveries for one subscription produce exactly this
concurrency in one process. ADR-0442 pins the observable outcome deterministically
(`I8`): the newer `CUSTOMER_CANCELLED` must win, the older `BANK_APPROVAL_PENDING`
must be reported `ignored`, and nothing from the older event may persist.

## Decision

### 1. The guard is the write, not the read

When `reduceProviderEvent` returned a `subscriptionPatch`, the
`subscriptions.updateOne` **inside** the transaction is now **conditional** on the
stored watermark:

```js
{
  _id: subscription._id,
  $or: [
    { lastProviderEventAt: { $exists: false } },
    { lastProviderEventAt: null },
    { lastProviderEventAt: { $lt: eventAt } },
  ],
}
```

The three branches are needed because MongoDB brackets comparisons by BSON type:
`$lt: <Date>` matches only dates, so a stored `null` (and a missing field) has to
be admitted explicitly. The patch is applied in the same `$set` that advances
`lastProviderEventAt` to this event's instant, so "may this event apply?" and
"record that it applied" are one atomic decision — there is no window between
them in which a second transaction can interleave.

### 2. Zero match aborts the transaction

`updateOne` returning `matchedCount === 0` means the watermark already sits at or
past this event's instant: a newer projection for the same subscription
committed first. The callback throws an `OutOfOrderProjectionError` **sentinel**
at that point — deliberately **before** the ledger insert and before any
`emitDomainEvent` — so `session.withTransaction` aborts and the loser persists
**nothing**: no ledger row, no outbox row, no subscription write. The sentinel is
caught immediately around `withTransaction` in `applyDecision`, which returns
`"ignored"`; `applyProjection` maps that to the existing `ignore(row,
"out_of_order")` path, so the inbox row is recorded `processResult: "ignored"`
exactly as the pre-existing out-of-order branch reports it.

The sentinel carries no `TransientTransactionError` label, so the driver does not
retry it — the abort is final and reported, not looped. A genuine transient
conflict (a write conflict between two concurrent transactions) _is_ retried by
`withTransaction`, and on the retry the conditional filter is re-evaluated
against the newly committed row — which is precisely what closes the race.

### 3. Why the outside read was not enough

The pre-transaction read is a **cheap short-circuit**, kept because it avoids
opening a transaction for an event that is already known stale in the common
sequential case. It cannot be the guard: the read and the write are separated by
the whole decision computation and the transaction open, and two callers can both
read the same pre-write row. Moving the check _inside_ the transaction without
making the write conditional would not help either — a re-read-then-write is
still two operations with a window between them (ADR-0442 §"Why gate the read,
not the write"). Only fusing the predicate into the write makes the loser match
zero documents.

### 4. The no-write decisions are unchanged

`refund_processed` (and any future decision with `subscriptionPatch === null`)
moves money only: there is no subscription write and no watermark advance, so no
ordering guard applies to it and the ledger's unique `idempotencyKey` remains its
replay guard. The guard is intentionally scoped to decisions that write the
subscription.

### 5. The seam is unchanged

`reduceProviderEvent` is untouched (still pure). The exported seam
`projectProviderWebhookEvent(eventId, { db?, clock? })` keeps its signature and
its `Promise<void>` result — OP-111's sweep calls it unchanged — and the failure
path is unchanged: an unexpected throw still leaves `processedAt: null` with
`processResult: "error"`. Only the TSDoc now states that the watermark is
enforced **inside** the transaction.

## Consequences

- §10.1 step 6 now holds under concurrent projection, not only under sequential
  delivery: the last commit can no longer be the older event's patch.
- The conditional filter is the single place the ordering rule lives, so a future
  edit that drops it breaks `I8` loudly rather than silently regressing state.
- The "guarded write matched nothing" outcome is indistinguishable, by design,
  from the sequential out-of-order outcome: same `ignored` / `out_of_order`
  reporting, same log line. Operators see one reason, not two.
- A subscription document whose `lastProviderEventAt` was written by some other
  path with a coarser type (a string instead of a `Date`) would not match the
  `$lt` branch. No such writer exists today (the field is written only here), and
  the schema check on read already rejects a non-date value before the decision.

## Evidence

| Gate                                | Result                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `I8` (the ADR-0442 pin)             | **passed** — via the atomic guard, not the outside read |
| whole `provider-webhook-inbox` file | **16 passed (16)**                                      |
| integration project (full)          | green                                                   |
| unit project (full)                 | green                                                   |
| `pnpm --filter @openpic/web build`  | exit `0`                                                |
| `tsc -p apps/web`                   | exit `0`                                                |
| coverage                            | every threshold above its floor                         |
| ESLint / `prettier --check`         | 0 problems / clean                                      |
| `adr-numbering` guard               | green                                                   |
| e2e `E1`                            | passed                                                  |

The pin is satisfied by the guard alone: with the pre-fix unconditional `$set`
restored it fails 3/3 (ADR-0442 §Evidence), and the pin's read gate means every
step after the older call's read happens after the newer transaction commits.

## Alternatives considered

- **Re-read the subscription inside the transaction, then write
  unconditionally.** Rejected: still two operations with a window; the pin was
  built to fail exactly this shape (ADR-0442 §2).
- **Make the subscription write a pipeline update that compares the watermark in
  the same statement.** Equivalent in effect, but a `$cond`-guarded aggregation
  pipeline obscures the predicate and the "matched nothing" signal; the plain
  filter states the rule readably and gives `matchedCount` for free.
- **Serialise projections per subscription with a lock/lease.** Rejected as
  heavier than needed: the database already provides the atomicity, and a lock
  would add a new failure mode (lease expiry) for a single-document decision.
- **Drop the outside read entirely.** Rejected: it is a useful, cheap
  short-circuit for the common sequential case, and it keeps the existing
  behaviour for events already known to be stale before a transaction is opened.
- **Advance the watermark only when `eventAt` is later (a bare `$max`).**
  Rejected: it would still apply the stale patch's other fields (`status`,
  `mandateStatus`) to the newer row — the regression the pin asserts against.

## Number allocation

Lane range `0440`–`0459` (`docs/adr/README.md` row `OP-108 webhook inbox lane`).
This card consumes `0443`; the lane's `Next free` cell advances `0443` → `0444`.
No number outside `0440`–`0459` is touched.
