# ADR-0851 — OP-136 TEST: the usage-latch helper reads the period the case seeded

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 TEST `t_e568306c` (High; branch `OP-136-task-job-sweeps-green`,
  worktree `/root/openpic/openpic-webapp/.worktrees/t_b25b384f`, PR #625). Parent
  GREEN: `t_d18a6e9e` ([ADR-0850](ADR-0850-op136-jobs-green.md) §5); RED:
  `t_b25b384f` ([ADR-0849](ADR-0849-op136-jobs-red.md) §3).
- **Implements:** contract §10.2 (the `usage-threshold-check` row), §6.10 (raw
  `usageCounters` rows served "for support and reconciliation"), §14.2 (the
  counter row's identity `{tenantId, entitlementKey, periodKey}` and the
  `usage_counters_tenant_key_period_unique` index); schema §14.2.
- **Consumes:** [ADR-0849](ADR-0849-op136-jobs-red.md) §3 (the latch is the
  `thresholdsNotified` array on the row the run reads), [ADR-0850](ADR-0850-op136-jobs-green.md)
  §5 (the dispute and this exact proposal), ADR-0340 §4 (`periodKey`).
- **Number allocation:** the lane row `OP-136 jobs lane` read
  `` `0851` `` on this head; this record takes `0851` and advances that cell to
  `` `0852` ``. No sweep was needed: no `.worktrees/*/docs/adr` carries an
  `ADR-0851*`/`ADR-0852*` file and the two pool cells stay `0869`.

## Context

`apps/web/src/test/integration/job-usage-and-invitations.test.ts` held a helper

```ts
async function latch(entitlementKey: string): Promise<unknown> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey });
  return row?.thresholdsNotified;
}
```

with no `periodKey`, so on any case that seeds **two** periods of the same
entitlement it answers whichever row the index serves first. The case "notifies
the same threshold again in a new period" seeds `events.active` at `2026-10` with
`thresholdsNotified: [80, 95, 100]` **first**, then the current `2026-11` at
`value: 9` with no latch. With `usage_counters_tenant_key_period_unique` on
`{tenantId, entitlementKey, periodKey}`, the helper's filter is an index-prefix
match on the **lowest** period key, i.e. the elapsed October row.

Measured at `46018a9a`, before any edit:

```
AssertionError: expected [ 80, 95, 100 ] to deeply equal [ 80 ]
 ❯ apps/web/src/test/integration/job-usage-and-invitations.test.ts:263:42
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

The job was already correct: it emits one `usage.events.threshold`
(`{threshold: 80, percent: 90}`), reports `details.notified: 1` and latches the
**current** month at `[80]` — the case's first two assertions pass. Only the
helper's row choice disagreed, which is why ADR-0850 §5 left the pin RED with no
test touched and routed the repair to this card.

## Decision

### 1. The period is a parameter of the helper

```ts
/** The stored latch of one counter row. */
async function latch(entitlementKey: string, period: string): Promise<unknown> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey, periodKey: period });
  return row?.thresholdsNotified;
}
```

The read is now the row's **whole** identity, the composite the schema declares
and the unique index enforces. Nothing else in the helper changes: it still
returns `row?.thresholdsNotified`, so an absent row still answers `undefined` and
a row without a latch still answers `undefined`, which is what the "says nothing"
case asserts.

### 2. Call sites only

- the three `storage.bytes` calls of the I6 case pass `"lifetime"` — that
  entitlement's `resetPeriod` — so the helper reads the one row the case seeds;
- the single `events.active` call passes `periodKey("monthly", NOW)`, the
  `2026-11` row the case seeds second and the job latches.

No sibling case, seed, assertion, fixture, factory, helper or production file is
edited. No `.only`, no skip, no loosened matcher: the expectation stays
`toEqual([80])` against a helper that now names the period.

### 3. Why the helper moves and the case does not

The only implementations that made the old read answer `[80]` are deleting the
elapsed counter row or replacing its latch with the current period's. ADR-0849 §3
fixes the latch as the `thresholdsNotified` on the row **the run reads for its own
`periodKey`**, and contract §6.10 serves those rows raw for support and
reconciliation; both "satisfiers" are data loss dressed as a pass. A constant
period is equally wrong: the same helper serves `storage.bytes`, whose row is
`periodKey: "lifetime"`, so a constant would break the I6 case and the
"below the first threshold" case. Making the period explicit is the only form
that is true of both rows and of any future second-period case.

### 4. The repair still bites

A throwaway probe (own `startTestApp`, own tenant, deleted before the commit)
seeded the two rows of the case with the current month at exactly 90 % and ran
the job twice:

- run 1 → `details.notified: 1`, `latch("events.active", "2026-11")` `[80]`,
  `latch("events.active", "2026-10")` `[80, 95, 100]` — the elapsed row is intact;
- run 2 → `details.notified: 0`, the same two reads — no second delivery, and the
  scoped helper still answers the seeded month.

The probe therefore measures the scoped read **and** the untouched elapsed row,
which the pre-repair helper could not do.

### 5. Known limit, recorded not fixed

`setCounterValue(entitlementKey, value)` in the same file still updates by
`{tenantId, entitlementKey}`. The I6 case seeds one row per key, so it is
unambiguous there; a future case that mutates a value while two periods exist must
scope it the same way. This card does not touch it, because no pinned behaviour
depends on it and the instruction was the helper plus its call sites.

## Evidence

- Target spec, after the repair:
  `pnpm exec vitest run --project integration apps/web/src/test/integration/job-usage-and-invitations.test.ts`
  → **6 passed (6)** (was `1 failed | 5 passed (6)`).
- `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` → exit `0`
  ("TypeScript: No errors found").
- `prettier --check` on the spec → "All files formatted correctly".
- The self-check probe of §4: **1 passed (1)**, deleted afterwards
  (`git status --short` lists the spec, this record and the ledger only).

## Alternatives

- **Default the parameter** (`period = "lifetime"`) — rejected: it would hide the
  same mistake at the next monthly call site and make the two families of rows
  indistinguishable at the read.
- **Delete or overwrite the elapsed row in the job** — rejected: ADR-0849 §3 and
  contract §6.10 forbid the data loss; the case's own subject is that a **new**
  period warns again.
- **Assert by scanning the whole collection in the case** — rejected: it pins a
  shape rather than the row, keeps the helper index-ambiguous, and weakens the
  assertion the RED chose.
- **Leave the pin RED** — rejected: no implementation can satisfy it without
  contradicting a frozen decision, so it would block PR #625 forever.

## Out of scope

- `setCounterValue` (§5).
- Any sibling case in the file, the invitation-expiry lane, and the fixtures,
  factories and helpers it imports.
- Every production module of OP-136; ADR-0850 stays the record of what shipped.
