# ADR-0924 — OP-139 GREEN: `analyticsRollup` reads the day's settled INR `billing_transactions`

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_e704435e` (OP-139 GREEN, Medium — the GREEN of finding **F2** of the round-1 review of
  the GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md); the pins are
  [ADR-0923](ADR-0923-op139-rollup-revenue-pins.md))
- **Branch:** `OP-139-task-rollup-revenue-green` (cut from the pins head `b92583d4`, so one squash
  carries the pins and this GREEN). **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e704435e`
- **Touches:** one production file (`apps/web/src/server/jobs/analytics-rollup.ts`: one row interface,
  one read, one fold), this record and its ledger rows. **No test, factory, fixture or helper file is
  in the diff**; the pins (`analytics-rollup.test.ts` +131, `factories/rollup-jobs.ts` +54) are
  carried from `b92583d4` byte-identically.
- **ADR number:** `0924` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937` block,
  advanced to `0925`. The sweep is §6.
- **Consumes:** [ADR-0923](ADR-0923-op139-rollup-revenue-pins.md) (the pin and its four decisions),
  [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) **A6** (a platform row exists only when the
  day has activity) and **A17** (a row counts on its own day field), contract §10.2 (the rollup's
  source list), schema §14.4 (the `billing_transactions` row) and §20.1 (the twelve metrics), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 item 23 (the number sweep).
- **Consumers:** `apps/web/src/server/jobs/analytics-rollup.ts` (the comment above the read, §1).
  The pin spec cites `ADR-0923`, which is where the contract lives.

## 1. The change

`analyticsRollup` gains one read of `COLLECTIONS.billingTransactions` over the same `inWindow` the
other reads use, and folds `amountMinor` into the counters it already keeps:

```
find({ status: "succeeded", currency: "INR", occurredAt: inWindow },
     { projection: { tenantId: 1, amountMinor: 1 } })
```

each row then running through the shipped `countRow` with its tenant key and a **`null` event key**:

```
metrics.revenueMinor += amountMinor
```

That is the whole implementation — two counters are fed by one read, and the platform total is the
same `countRow` call's third fold, so it cannot drift from the tenant rows by construction (the pin
compares both, ADR-0923 §4).

Reasons, one per decision (none re-litigated; ADR-0923 §3 settled them):

| Decision                                | Why                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `status: "succeeded"`                   | `pending` is an unsettled intent, `failed` is money never taken.                                                                                |
| `currency: "INR"`                       | `revenueMinor` is one minor-unit scalar; adding paise to cents is nonsense.                                                                     |
| `occurredAt: inWindow`, not `settledAt` | A late settlement must not move a charge to another day, or a same-day rerun would answer differently (A17: a row counts on its own day field). |
| no event bucket                         | A ledger row carries no `eventId`; revenue has no event scope.                                                                                  |
| non-numeric `amountMinor` skipped       | A malformed stored amount contributes nothing and must not abort the day's rollup.                                                              |
| no resolvable `tenantId` still counted  | `countRow` adds to `totals.platform` unconditionally, exactly as every other counter does.                                                      |

## 2. What stays unchanged

The twelve-key closed metric set, the `analyticsDaily` document shape, the
`{scope.kind, scope.id, dateKey}` upsert, `computedAt` from the injected `Clock`, `affected`,
`scanned`, the summary log line and `?date=` behaviour. `uniqueAttendees`, `storageBytesAdded`,
`downloads` and `p95ProcessingMs` stay `0` and stay unlineaged — **ADR-0918 §A16 is superseded for
`revenueMinor` only**, and **ADR-0919 §8's "five metrics are written as `0`" becomes four**.

`scanned` gains one increment per counted ledger row, which is the shipped `countRow` contract and
the only effect this read has on the counters besides `revenueMinor`.

## 3. Measurement

| State                                            | Result                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| pin head `b92583d4` before the change (the RED)  | `1 failed \| 9 passed (10)` — `expected +0 to be 4500` at `analytics-rollup.test.ts:610` |
| focused `analytics-rollup` spec after the change | `10 passed (10)` — the shipped nine stay green                                           |
| whole `unit` project                             | `194` files, `3261 passed \| 3 skipped (3264)`                                           |
| whole `integration` project                      | `158` files, `1679 passed (1679)`                                                        |
| `tsc`                                            | exit `0`                                                                                 |
| `eslint`                                         | 0 errors                                                                                 |
| `prettier --check`                               | clean                                                                                    |

The shipped nine cases assert presence and integrality for the unlineaged metrics, never a value, so a
real `revenueMinor` leaves them green — measured, not assumed.

### 3.1 Whole `integration`

```text
Test Files  158 passed (158)
Tests  1679 passed (1679)
```

Every file green, the pinned case included.

## 4. Alternatives rejected

1. **Fold revenue into the event bucket through the tenant's event.** Rejected: the row names no
   event; inferring one is an invented relationship (ADR-0923 §7 item 4).
2. **Bucket on `settledAt`.** Rejected: a late settlement would make a same-day rerun non-identical —
   the lane's idempotency criterion — and the pin seeds exactly that shape (ADR-0923 §3.3).
3. **Sum every currency.** Rejected: §20.1 has one `revenueMinor` scalar and no currency field.
4. **Throw on a non-numeric `amountMinor`.** Rejected: one malformed row would fail the whole night's
   rollup for every scope and tenant.

## 5. Consequences and residuals

- The dashboard's revenue figure (`@/server/analytics/totals:84`) now carries a real value for every
  day the rollup has run since this change; days rolled up before it still hold `0` and are re-runnable
  with `?date=`.
- **Residual:** the pin seeds one tenant, so a platform bucket that added only the first tenant's
  revenue would be indistinguishable there (ADR-0923 §8).
- **Residual:** `kind: "refund"` rows are not exercised. The predicate is status- and currency-based,
  so a `succeeded` INR refund adds its stored `amountMinor` (negative, if stored as such) and nets
  revenue; whether refunds should net is a decision this card does not make.
- **Residual:** a row whose `amountMinor` is absent or non-numeric is skipped **before** `countRow`, so
  it does not increment `scanned` either — "contributes nothing" read literally. No pin covers that
  arm.

## 6. Number allocation and sweep

Draws **`0924`**, the OP-139 lane's `Next free` cell (block `0918`–`0937`), and advances it to
**`0925`**. No other cell moves, no cell is lowered and no range is re-cut; the `OP-136 jobs lane`
cell and the `unallocated (future lanes)` cursor stay at `0962`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `521e305b`: highest record `ADR-0942` (the OP-140 lane, outside this block); no
  `ADR-0924`–`ADR-0937` path on the trunk;
- every `.worktrees/*/docs/adr` tree on this host: highest `ADR-0942`; no `ADR-0924` file anywhere;
- the open PR heads #812 (the pins, this record's base), #755, #743, #272: none carries a
  `ADR-0924`–`ADR-0937` path;
- `git rev-list --objects --all -- docs/adr`: no `ADR-0924` or `ADR-0925` object.

Re-swept immediately before the push: `origin/main` had moved only by release chores, and no surface
resolved `ADR-0924`.
