# ADR-0923 — OP-139 TEST: `revenueMinor` is the day's settled INR `billing_transactions` total

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_0555c437` (OP-139 TEST, Medium — finding **F2** of the round-1 review of the
  OP-139 GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md))
- **Branch:** `OP-139-task-rollup-revenue-pins`. **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_0555c437`
- **Touches:** one integration spec **appended**
  (`apps/web/src/test/integration/analytics-rollup.test.ts`: one new docblock and one new
  `describe` with **one** case; the shipped `I1`/`I6`/`I7`/`I8`/`I9` cases and every helper are
  byte-identical), one **new builder** in the test-support factory
  `apps/web/src/test/factories/rollup-jobs.ts` (`makeBillingTransactionRow`), this record, its
  index row, the lane's `Next free` cell and one ledger paragraph. **No production code, no
  helper, no second spec, no contract document.**
- **ADR number:** `0923` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937` block,
  advanced to `0924`. The sweep is §6.
- **Consumes:** [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) **A16** (the five metrics
  pinned by presence and integrality only — superseded here **for `revenueMinor` only**), **A17**
  (a row counts on its own day field: `occurredAt` for `domainEvents`, `createdAt` for the
  collections) and **A6** (a platform row exists only when the day has activity),
  [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md) §8 (the five metrics the job writes as
  `0`), contract §10.2 (the rollup's source list), schema §14.4 (the `billing_transactions` row)
  and §20.1 (the twelve metrics), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 item 23 (the number sweep).
- **Consumers:** `apps/web/src/test/integration/analytics-rollup.test.ts` (the pin) and
  `apps/web/src/test/factories/rollup-jobs.ts` (the ledger-row builder it seeds with).

## 1. Context — `revenueMinor` is not unlineaged, it is unwritten

The lane's card lists the rollup's sources as "`domainEvents` plus counts from `eventImages`,
`faceMatches`, `selfies`, `notificationDispatches` **and `billingTransactions`**" (contract §10.2).
The delivered job reads **four** of those five: `billingTransactions` appears zero times in
`apps/web/src/server/jobs/analytics-rollup.ts`, so `metrics.revenueMinor` is written as `0` on
every tenant, event and platform row, forever.

The operator's dashboard does not know that. `apps/web/src/server/analytics/totals.ts:84` sums
`revenueMinor` across the served days, so the revenue figure an operator reads is always `0`.

ADR-0918 **§A16** recorded `revenueMinor` as one of the five metrics whose "lineage is not stated
by the card", pinned by presence and integrality only. That reading is not accurate. The lineage is
stored: `billing_transactions` carries `tenantId`, `amountMinor`, `currency`, `occurredAt`,
`settledAt` and `status` — written by `insertPendingCharge`
(`apps/web/src/server/billing/one-time-charge.ts:92-110`, `status: "pending"`, `settledAt: null`)
and moved to `status: "succeeded"` with a `settledAt` by the projection's `settleIntent`
(`apps/web/src/server/billing/webhook-projection.ts:630-631`). The rollup simply never reads the
collection.

**This record supersedes ADR-0918 §A16 for `revenueMinor` only.** `uniqueAttendees`,
`storageBytesAdded`, `downloads` and `p95ProcessingMs` stay pinned by presence and integrality
only, and stay `0` in the job — A16 continues to bind those four, and nothing here invents a source
for them.

## 2. Measurement — the pin reds on arrival for the intended reason

On the delivery cut (`origin/main` `895d368c`), with the spec and the factory builder appended:

```
× F2: the day's revenue is the settled INR total of each scope, and a rerun is unchanged
AssertionError: expected +0 to be 4500 // Object.is equality
 ❯ apps/web/src/test/integration/analytics-rollup.test.ts:610:42
      Tests  1 failed | 9 passed (10)
```

The failure is the pin's **first** assertion on the stored tenant row — `expected +0 to be 4500`,
not a harness error and not a missing module — and the shipped nine cases are green in the same
run, so the seed, the harness and the shipped contract are all sound.

## 3. Decision — the four readings the pin fixes, and what it does not touch

The card pre-made four decisions; this record records them and does not re-litigate them.

### 3.1 `status: "succeeded"` only

`pending` is an intent the provider has not settled and `failed` is money never taken. Neither is
revenue. The pin seeds both shapes inside the window (9900 and 7700) so an implementation that
drops the status predicate answers `22100`, not `4500`.

### 3.2 `currency: "INR"` only

`revenueMinor` is a single minor-unit scalar per scope per day, so summing mixed currencies would
add paise to cents. Non-INR rows are **excluded by decision**, and the exclusion is recorded as a
decision, not an oversight: the shipped billing fixtures are INR
(`apps/web/src/server/billing/webhook-projection.test.ts`'s 49 900 INR charge). The pin seeds one
`USD` row (1200) inside the window, so an implementation without the currency predicate answers
`5700`.

### 3.3 `occurredAt`, not `settledAt`

Every other metric in the rollup buckets by the row's own creation instant (`createdAt` /
`occurredAt`, ADR-0918 A17). Bucketing revenue by the settlement instant would put a late
settlement into a different day than the charge, and would make a same-day rerun non-idempotent
exactly when the provider settles after the run — the one thing the lane's idempotency criterion
forbids. The pin seeds row D charged on the **previous** IST day with `settledAt` **inside** the
rolled-up day, so a `settledAt` bucket answers `7800`.

### 3.4 No event scope, and no other counter

`billing_transactions` rows carry no `eventId`, so revenue cannot be attributed to an event. The
pin requires the tenant's **event** row (which exists, because the seeded `event.created` row
creates that bucket) to keep `revenueMinor: 0`. It also requires `eventsCreated` to stay `1` and
`notificationsSent` to stay `0`, so a rollup that starts counting ledger rows into another bucket
is caught.

`revenueMinor` is the **only** one of the five previously-zero metrics this change touches.
`uniqueAttendees`, `storageBytesAdded`, `downloads` and `p95ProcessingMs` stay at `0`. In
ADR-0919 §8's sentence "the five unlineaged metrics are written as `0`", **five becomes four** —
the GREEN record (`t_e704435e`) carries that correction next to the implementation.

## 4. The contract the pin encodes

One `describe`, one case: one tenant, one `published` event, one `event.created` domain row, and
five `billing_transactions` rows seeded through the new `makeBillingTransactionRow` builder.

| row | `status`  | `currency` | `occurredAt`         | `amountMinor` | `settledAt`           | the wrong reading it rules out |
| --- | --------- | ---------- | -------------------- | ------------- | --------------------- | ------------------------------ |
| A   | succeeded | INR        | inside the window    | 4500          | inside                | — this row is the pin          |
| B   | pending   | INR        | inside               | 9900          | `null`                | an unsettled intent            |
| C   | failed    | INR        | inside               | 7700          | `null`                | money never taken              |
| D   | succeeded | INR        | the previous IST day | 3300          | **inside** the window | a settlement-instant bucket    |
| E   | succeeded | USD        | inside               | 1200          | inside                | a mixed-currency sum           |

The window is the shipped one: `2026-11-17` in `Asia/Kolkata` is
`[2026-11-16T18:30:00.000Z, 2026-11-17T18:30:00.000Z)`, and `ACTIVITY_AT` is `2026-11-17T06:00Z`.

After one run for `2026-11-17` the case requires:

| Assertion                                                         | Wrong answer it catches                      |
| ----------------------------------------------------------------- | -------------------------------------------- |
| tenant row `metrics.revenueMinor === 4500`                        | `0` (today), 22100, 7800, 5700, 26000        |
| platform row `metrics.revenueMinor === 4500`                      | a tenant-only fold                           |
| platform `revenueMinor` equals the day's tenant rows' sum         | a platform bucket that diverges from tenants |
| event row `revenueMinor === 0`                                    | an invented event attribution                |
| tenant `eventsCreated === 1`, `notificationsSent === 0`           | ledger rows leaked into another counter      |
| a second run of the same day leaves every document byte-identical | a per-run value (a `Date`, a counter reset)  |

The idempotency arm reuses the shipped `canonicalRows()` read, so it compares the whole
`analyticsDaily` collection, not only the day's rows.

## 5. Evidence

Measured in this card's worktree (`vitest` 5.0.3, `MongoMemoryReplSet` through the shipped harness).

| State                                                                            | Result                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| delivery cut `895d368c`, spec appended (the RED)                                 | `1 failed \| 9 passed (10)` — `expected +0 to be 4500` |
| throwaway near-fix reading `{succeeded, INR, occurredAt}` into tenant + platform | `10 passed (10)`                                       |
| whole `unit` project                                                             | see §5.1                                               |
| `tsc -p apps/web/tsconfig.json --noEmit`                                         | exit `0`                                               |
| `eslint` on the two touched files                                                | exit `0`, no issues                                    |
| `prettier --check` on the two touched files                                      | `All matched files use Prettier code style!`           |

The near-fix was written into `apps/web/src/server/jobs/analytics-rollup.ts`, run, and restored
with `git checkout --`; `git status` carries the spec, the factory, this record and the ledger rows
only. Five single-change variants of it were each run against the same spec, which is what makes
each arm load-bearing rather than merely unsatisfied:

| Variant of the near-fix                        | Tenant `revenueMinor` | Failing message                                                                  |
| ---------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| the decision itself (§3)                       | 4500                  | none — `10 passed (10)`                                                          |
| no `status` predicate (all statuses)           | 22100                 | `expected 22100 to be 4500`                                                      |
| no `currency` predicate (all currencies)       | 5700                  | `expected 5700 to be 4500`                                                       |
| the window on `settledAt`                      | 7800                  | `expected 7800 to be 4500`                                                       |
| no day window at all                           | 7800                  | `expected 7800 to be 4500`                                                       |
| platform total only (no tenant bucket)         | 0                     | `expected +0 to be 4500`                                                         |
| the correct read **plus** `eventsCreated += 1` | 4500                  | `expected 2 to be 1` at the counter arm, i.e. every revenue arm passed before it |

The last row proves the counter arm is reached, not shadowed: with revenue correct and only the
counter wrong, the case fails at `analytics-rollup.test.ts:628` on `eventsCreated`.

### 5.1 Whole-suite gates

| Run                                                                | Result                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| whole `unit` project, head with the spec, factory, record and rows | `193` files, `3233 passed \| 3 skipped (3236)`                                                                           |
| the seven `adr-*` guards (this record and its ledger rows in tree) | `7` files, `248 passed (248)`                                                                                            |
| whole `integration` project                                        | `157` files, `1 failed \| 1668 passed (1669)` — the failure is **this** case alone, so no shipped integration spec moved |
| focused `analytics-rollup` spec                                    | `1 failed \| 9 passed (10)`                                                                                              |

The whole `integration` run is quoted as delivered rather than as green: this branch is a
RED-by-design pin pack, so the suite's single red is the pin's own `expected +0 to be 4500`. The
GREEN (`t_e704435e`) is where that project goes green.

## 6. Number allocation and sweep

Draws **`0923`**, the `OP-139 jobs & compliance lane` row's `Next free` cell (block `0918`–`0937`),
and advances that cell to **`0924`**. No other cell moves, no cell is lowered and no range is
re-cut; `unallocated (future lanes)` stays `0942` and the `OP-136 jobs lane` cell stays `0942`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `895d368c`: highest records `ADR-0939`–`ADR-0941` (the OP-136 lane) on the trunk,
  whose OP-139 cell reads `0923`; no `ADR-0923` path, and the file's own text carries no
  `ADR-0923` token;
- every `.worktrees/*/docs/adr` tree on this host: highest
  `ADR-0942-op140-notification-action-endpoint-red.md` (an OP-140 cut **outside** this block), no
  `ADR-0923` path;
- the open PR heads — #810 and #806 (`OP-140`, both carrying `ADR-0942`), #755, #743, #272: no
  `ADR-0923`;
- `git rev-list --objects --all -- docs/adr`: the highest object is `ADR-0942`; no `ADR-0923`.

The card's own sweep sentence ("draw from the pool") is read as the §12 item 23 _enumeration_, not
as a pool draw: the lane holds a live reservation (`0918`–`0937`) whose cell is `0923`, and the
block is exclusive to its holder, gaps included. Taking the pool high-water `0943` would mint
outside the lane's reservation and collide with the OP-140 block's next draw. The cell is the
number.

**Re-swept immediately before the push** — see the handoff's `adr.sweep` field; `origin/main` moved
only by release chores (`1.75.0`) and no surface resolved `ADR-0923`.

## 7. Alternatives rejected

1. **Leave `revenueMinor` unlineaged and delete the field's claim.** Rejected: the read model
   already sums it, so a permanently-zero writer is a dashboard bug, not a missing feature; and the
   lineage is stored and unambiguous.
2. **Count `pending` rows on `settledAt` and `succeeded` rows on `occurredAt`.** Rejected: that is
   a two-clock bucket, so a same-day rerun's answer depends on when the provider settles, and the
   lane's idempotency criterion is exactly that a rerun of the same day is byte-identical.
3. **Sum every currency and store the total in `revenueMinor`.** Rejected: minor units of different
   currencies are not addable, and `revenueMinor` has no currency field to disambiguate the sum.
   A multi-currency rollup needs a per-currency map, which schema §20.1 does not have.
4. **Attribute revenue to the event scope by looking up the tenant's single event.** Rejected: the
   ledger row names no event, and inferring one would attribute an add-on purchase to whichever
   event happened to exist — an invented relationship, not a source.
5. **Assert only the tenant row and let the platform row follow.** Rejected: the platform total is
   computed separately in the job (`totals.platform`), so it can drift from the tenants' rows; the
   pin compares both, and the sum assertion catches the drift even if both are individually right
   for the wrong reason.
6. **Skip the second run and rely on the shipped `I1` case.** Rejected: `I1` seeds no billing rows,
   so it cannot catch a revenue write that is not idempotent (a `computedAt`-derived or
   settlement-time value).

## 8. Consequences and residuals

- The GREEN child (`t_e704435e`, `parents=[t_0555c437]`) adds the `billing_transactions` read and
  the fold into the tenant and platform buckets; **no test, factory or fixture file is its to
  edit**, and the shipped nine cases must stay green because they assert presence and integrality,
  never a value, for the unlineaged metrics.
- The `unit` project cites `ADR-0923` from the spec's docblock, so the `adr-source-references` and
  `adr-consumers` guards need this record in the **same** delivery: the record's `Consumers:` field
  names both touched files.
- **Residual:** the pin uses one tenant. A platform total that added only the _first_ tenant's
  revenue would be indistinguishable here; the shipped `I7` case covers the per-tenant split for
  the other counters, and this pin's platform arm covers one tenant exactly.
- **Residual:** the event-scope arm is a control. No plausible implementation can attribute these
  rows to an event (`eventId` is absent), so only an implementation that invented an association
  would red it; it exists to state the absence, not to catch a likely bug.
- **Residual:** the currency decision is pinned with one foreign currency (`USD`). A predicate that
  accepted `INR` **and** `EUR` would pass; the decision is "INR only" and the single counter-example
  is what the fixture can carry without inventing a multi-currency contract.
- **Residual:** negative `amountMinor` values (refunds) are not exercised. `kind: "refund"` rows
  exist in the ledger, and whether they should net revenue out is a decision this card does not
  make; the predicate is status- and currency-based, so a `succeeded` INR refund would currently
  add its `amountMinor` as stored.
