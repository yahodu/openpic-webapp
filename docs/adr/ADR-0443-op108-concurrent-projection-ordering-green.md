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

## Review sign-off — 2026-10-25 (card `t_c6e73ade`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of this delivery — the REVIEW/LAND card
`t_c6e73ade`, which reviewed the GREEN `t_bd4d7286` and landed PR
[#311](https://github.com/yahodu/openpic-webapp/pull/311) — returned
**APPROVED**: zero changes requested to the deliverable and **zero reviewer
edits** to the fix, the pins or this record beyond the sign-off section itself.

**Evidence reproduced independently at the reviewed head `0c8bf86`** (the sheet
was checked out **detached** at the handoff SHA, never at the moving branch tip,
and every gate was re-run on that tree by the reviewer — nothing was copied from
the handoff):

- **The pin is deterministic.** The pre-fix head `84445e2` fails
  `provider-webhook-inbox.test.ts` in **3 runs out of 3**, always the same way
  (`1 failed | 15 passed (16)`, `AssertionError: expected { …(20) } to match
object { status: 'cancelled' }`), and the fix head is green **3/3**
  (`16 passed (16)`).
- **The guard is inside the transaction.** `webhook-projection.ts:663-683` is a
  single conditional `subscriptions.updateOne` _within_ `withTransaction`
  (`{_id, $or:[{$exists:false}, null, {$lt: eventAt}]}`, patch and watermark
  advance in one `$set`), with `matchedCount === 0` throwing the
  `OutOfOrderProjectionError` sentinel **before** the ledger insert (`:685`) and
  the emits (`:691`). The pre-transaction read (`:543-548`) is only the
  short-circuit. The sentinel carries no `TransientTransactionError` label and
  `withTransaction` (`server/db/transaction.ts:61`) delegates to the driver's
  `session.withTransaction`, which retries only labelled errors — the abort is
  final and reported, and a genuine write conflict is still retried against the
  freshly committed row.
- Full unit **110 files / 1915 passed | 3 skipped**; `adr-numbering` guard
  **29 passed (29)**; full integration **79 files / 575 passed**
  (`TMPDIR=/root/tmp-mongo`); coverage exit `0` — statements 92.48 %, branches
  **81.32 %**, functions 96.37 %, lines 92.94 % (floor 80 %);
  `pnpm --filter @openpic/web build` exit `0` with
  `/api/v1/webhooks/[provider]` in the route table;
  `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint **0 errors** /
  105 pre-existing warnings; `prettier --check` clean on all 14 changed files;
  e2e `E1` **1 passed** on a real `next start` with the memory provider.
- The ten pins repaired by `5c6f87b` (card `t_a756515d`) and `I7` are green in
  the full integration run, and the sequential `drainDeferredProjections()` pin
  is unmodified: `git diff --name-only 84445e2 0c8bf86` is **3 files** — the
  production module, this ADR and `docs/adr/README.md` — with no test, mock,
  fixture or factory in the follow-up diff.
- CI on the PR head: `ci`, `audit`, `secret-scan`, `test_coverage`,
  `unit_test`, `lint`, `env-changes`, `validate-branch-name`,
  `validate-pr-title` and CodeQL all pass; `audit-dev` fails and is
  `continue-on-error` (ADR-0301) while `audit` passes.

**Finding (Low, routed to a card — not a blocker).** At the reviewed head the
coverage data (`coverage-final.json` per-branch zero-counts) reports four
defensive branches of this module **never taken**: `:657`'s false side (a
decision with `subscriptionPatch === null`, the `refund_processed` path §4 above
makes a claim about), `:519` (`unregistered_provider`), `:525`
(`no_subscription_ref`) and `:557` (`nothing_to_apply`). Global branch coverage
sits above its floor, so this is an unpinned-behaviour gap rather than a gate
failure; §4's scoping claim is the one with written weight behind it. A **TEST**
characterization-pin card — `t_2f62897a`, no ADR number of its own and no GREEN
sibling unless a pin genuinely fails — is created and gated behind the review
card.

**Merge and number.** The delivery shipped as PR
[#311](https://github.com/yahodu/openpic-webapp/pull/311), **squash-merged as
`7d39082`** (`git merge-base --is-ancestor 7d39082 origin/main` holds; the
branch was auto-deleted). The squash keeps the reviewed bytes: the only PR path
that differs between the reviewed head and the squash is `docs/adr/README.md`,
and that difference is `origin/main`'s own intervening OP-105 ledger rows and
`Next free` cell (`0388`–`0393`, cell `0394`) which the branch predated — an
index-only union, no ADR number collision (`ADR-044[0-3]` unique). **No ADR
number is asserted here:** this sign-off consumes none, and the lane's
`Next free` cell stays `0444`.
