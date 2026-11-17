# ADR-0442 — OP-108 follow-up RED: an out-of-order concurrent projection is `ignored`

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-108 follow-up TEST/RED (`t_f3094679`) · **Branch:** `OP-108-task-webhook-inbox` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a297e850`
- **Relates to:** [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) (the RED contract this lane implements), [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the GREEN, and §"A harness hazard, not a contract" which routed this hazard here)
- **Contract:** §10.1 step 6 ("orders by the provider's `occurredAt`, never by arrival"), §10.1.2, §23 (money and access move together) · **Appendix A:** (none new)

## Context

`projectProviderWebhookEvent` reads the matched subscription and checks the
ordering watermark `lastProviderEventAt` **outside** `withTransaction`, then
applies an **unconditional** `$set` inside it. Two projections for the **same
subscription** that run concurrently therefore both read the pre-write row, both
pass the watermark check, and whichever transaction commits last wins — the
**older** event's patch can land last and regress `status` /
`lastProviderEventAt`. The route schedules each projection through `after()`, so
two near-simultaneous deliveries for one subscription produce two concurrent
projections in the same process. §10.1 step 6 is not honoured under concurrency.

ADR-0441 §"A harness hazard, not a contract" observed this while fixing the
suite's shared-DB isolation: an older `BANK_APPROVAL_PENDING` (occurredAt 30 min
ago) and a newer `CUSTOMER_CANCELLED` (10 min ago) drained through a
`Promise.all` left the row `incomplete` (the older patch won) in **2 of 2** full
integration runs — `expected { … } to match object { status: 'cancelled' }`,
received `'incomplete'`. That card made its drain **sequential** (it pins
delivery order and its watermark, a different property) and routed the
concurrent write race here.

## Decision

### 1. The executable contract this pin fixes

For one subscription, two concurrent projections must not apply out of order.
The pin asserts four observables, all of which must hold:

1. final `subscriptions.status === "cancelled"` (the newer event);
2. final `subscriptions.lastProviderEventAt` equals the **newer** event's
   `occurredAt`;
3. the **older** event's inbox row is `processResult === "ignored"`
   (out-of-order), not `"applied"`;
4. nothing from the older event's regression persists — no ledger row and no
   domain event written for it.

The fix the GREEN owes is an **atomic** guard on the subscription write: the
`$set` must be conditional on the watermark (or the row re-checked inside the
transaction) so an older event's write matches nothing and the projection
reports `ignored`. A non-atomic re-read followed by an unconditional write does
not satisfy this pin — see §2.

### 2. The deterministic interleaving technique

A bare `Promise.all` of two projections is a race that can pass by luck, so the
pin forces the losing interleaving on every run through the `{ db }` seam
`projectProviderWebhookEvent` already exposes. The spec passes the **older**
call a `Db` wrapper (`gatedSubscriptionDb`) whose `subscriptions.findOne`:

1. awaits the real read (capturing the pre-write row), then
2. **holds** before returning it.

The spec then awaits the gate's `read` signal (the older call has read the
pre-write row), runs the **newer** projection to completion against the plain
`app.db` (its transaction commits first), and only then releases the older call.
On the pre-fix head the older call's unconditional `$set` overwrites the newer
patch and the pin fails; once the write is guarded atomically the older call is
reported `ignored`.

**Why gate the read, not the write.** Gating the older call's _write_ would let
it enter its transaction and perform any in-transaction re-read _before_ the
newer commits, so a fix that re-reads-then-writes-unconditionally would still
overwrite and the pin would fail a fix that merely moved the check. Holding the
older call at its read means every step after the read — any re-read, the guard,
the write — happens **after** the newer transaction has committed, so the pin is
satisfied by exactly the atomic guard the contract requires and by nothing
weaker.

Only the `subscriptions` collection is gated, and only its `findOne`; every
other handle (the inbox, the ledger, the outbox, `platformSettings`) is the real
one, and the transaction session still comes from the shared client, so the
projection runs its real code path end to end.

### 3. Where the pin lives

`apps/web/src/test/integration/provider-webhook-inbox.test.ts`, case `I8`
(`describe "… — concurrent projections for one subscription"`), reusing the
file's harness (`app.db`, `seedSubscription`, `readSubscription`, `webhookRows`,
`ledgerRows`, the `beforeEach` collection clearing from `t_a756515d`). The
existing **sequential** `drainDeferredProjections()` and every existing pin are
left unedited: the sequential drain pins delivery order and its watermark, this
case pins the concurrent write race.

The harness gained one optional field (`SubscriptionRow.lastProviderEventAt`)
and the gate helpers; no existing assertion was touched.

### 4. The event pair, and what "no ledger row" means here

The pin uses the pair ADR-0441 observed: the older `BANK_APPROVAL_PENDING`
(normalizes to `mandate_pending`, `status: "incomplete"`) and the newer
`CUSTOMER_CANCELLED` (normalizes to `subscription_cancelled`,
`status: "cancelled"`), both id-less `SUBSCRIPTION_STATUS_CHANGED` bodies.

Neither status change carries a ledger transaction (`transactionFor` returns
`null` for `SUBSCRIPTION_STATUS_CHANGED`), so observable 4's ledger half is
asserted as an **empty** ledger, and the discriminating half is the outbox: the
pin asserts the only domain event written for the subscription is the newer
event's `billing.subscription.cancelled`, with none of the older event's
`billing.mandate.pending`. On the pre-fix head both are written (the older
event's emit commits with its regressing patch), so the assertion fails loudly.

## Consequences

- The concurrent-projection hazard is now pinned deterministically, not left to
  a load-dependent `Promise.all`: the pin fails on the pre-fix head every run
  and passes once the write is guarded atomically.
- A future refactor that reintroduces an unconditional subscription write (or
  drops the `ignored` outcome for an out-of-order concurrent event) breaks this
  pin loudly, with a failure message naming the regressed `status`.
- The pin is test-only; no production module, schema, index, fixture or factory
  is touched by this card.

## Evidence

| Gate                          | Result                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| the new pin (`I8`)            | **RED — 3/3 runs**: `expected { … } to match object { status: 'cancelled' }`, received `'incomplete'` |
| mutation probe (atomic guard) | whole file **16 passed (16)** — the guard turns the pin green                                         |
| production file restored      | `sha256` byte-identical to the pre-probe backup; `git diff` on it empty                               |
| `tsc -p apps/web`             | exit `0`                                                                                              |
| integration (full)            | this file the only failing one; the new pin the only failing case                                     |
| ESLint / `prettier --check`   | 0 problems / clean on the touched file                                                                |

The mutation probe implements the atomic guard the contract requires (a
conditional `updateOne` on `lastProviderEventAt`, throwing a sentinel the
applier maps to `ignored`). It is applied to a scratch copy, exercised, and
reverted; the production file's hash is verified unchanged.

## Alternatives considered

- **A bare `Promise.all` drain.** Rejected: a race that can pass by luck, and it
  would make the pin flaky rather than a deterministic pin.
- **Gating the older call's write.** Rejected: it does not force the older call's
  in-transaction re-read (if any) to happen after the newer commit, so a
  re-read-then-write-unconditionally "fix" would still overwrite and the pin
  would fail it — the pin must be satisfied by the atomic guard alone (§2).
- **A time-based stagger (`await sleep`).** Rejected: not a pin; the interleaving
  would depend on scheduling.
- **Pinning the ledger half with a transaction-carrying pair.** Rejected: the
  card's acceptance evidence requires the `expected 'cancelled'` / received
  `'incomplete'` failure, which is the status-change pair; neither such event
  carries a ledger transaction, so the ledger is asserted empty and the outbox
  carries the discrimination.
- **Fixing the projection here.** Out of scope: this is the RED card; the fix is
  the GREEN child this card releases.

## Number allocation

Lane range `0440`–`0459` (`docs/adr/README.md` row `OP-108 webhook inbox lane`).
This card consumes `0442`; the lane's `Next free` cell advances `0442` → `0443`.
No number outside `0440`–`0459` is touched.
