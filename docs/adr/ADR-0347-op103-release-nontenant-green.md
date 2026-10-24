# ADR-0347 — OP-103 follow-up GREEN: `releaseEntitlement` agrees with the decision for non-`tenant` scope

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_b21f15aa` (follow-up GREEN), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`, branch
  `OP-103-task-release-nontenant-green`, off the RED head `75f346d`
- **Consumes:** `0347` (the lane's next free number after `0340`–`0346`)
- **Fixes:** the `release`-scope asymmetry surfaced by the F1 GREEN
  (`t_06da2c9f`, [ADR-0342](ADR-0342-op103-nontenant-scope-red.md) /
  [ADR-0343](ADR-0343-op103-nontenant-scope-green.md)) and pinned by
  [ADR-0346](ADR-0346-op103-release-nontenant-red.md) (card `t_cc32c3d2`)

## Context

ADR-0346 pinned the non-`tenant` release contract (option (a), mirrored from the
consume path): for an `event`/`attendee`-scoped key, `ctx.counts` is the only
usage source, the release issues **no** `usageCounters` write, and the verdict's
`used` is derived from `ctx.counts` (clamped to `0` when `amount > ctx.counts ?? 0`)
rather than the counter. This record implements exactly that pin.

Before this change `releaseEntitlement` called `releaseCounter(...)` for every
scope. Because `resolveEntitlement` reads a counter only for `tenant` scope
(`spec.scope === "tenant" ? readCounterValue(...) : (ctx.counts ?? 0)`), a
non-`tenant` release (a) wrote a counter row the decision never reads — the same
pollution class ADR-0343 removed for `consumeEntitlement` — and (b) built the
verdict's `used` from the counter's post-decrement value, disagreeing with the
`consume` echo.

## Decision

### 1. `releaseEntitlement` touches a counter only for `tenant` scope

After resolving the entitlement, `releaseEntitlement` branches on the resolved
scope:

```ts
if (resolved.scope !== "tenant") {
  const counts = ctx.counts ?? 0;
  return allowedVerdict(resolved, amount > counts ? 0 : counts);
}

const used = await releaseCounter(resolved, amount, seams);
return allowedVerdict(resolved, used);
```

For an `event`/`attendee`-scoped key the verdict's `used` is the caller's
`ctx.counts` (defaulting to `0`), floored to `0` only when the release `amount`
exceeds it; no `usageCounters` write is issued. `releaseCounter` is therefore
only reachable for a `tenant`-scoped key — the only scope `resolveEntitlement`
ever reads a counter for. This is the exact mirror of the ADR-0343
`consumeEntitlement` branch shape.

### 2. The `tenant`-scoped release is byte-for-byte unchanged

The `tenant` branch still calls `releaseCounter(...)` and returns
`allowedVerdict(resolved, used)` from its clamped post-decrement value — the
behaviour `I5` pins today, re-guarded by `I11`.

### 3. The clamp reading is the literal echo pinned by ADR-0346

`used = amount > (ctx.counts ?? 0) ? 0 : (ctx.counts ?? 0)` — an echo of
`ctx.counts`, floored to `0` when the release amount exceeds it, **not** the
subtractive `max(0, ctx.counts - amount)`. This matches ADR-0346's literal
reading and the pinned `consume` echo (ADR-0342 U8). It is discontinuous at
`amount == ctx.counts` (stays `ctx.counts`) versus `amount == ctx.counts + 1`
(becomes `0`). ADR-0346 flagged this reading as the one open question for this
GREEN; the card pins it literally, so it is implemented literally and the pin is
**not** weakened.

## Consequences

- The reviewer's probe — `events.duration_days`, limit `3`, a pre-existing counter
  row at `5`, `ctx.counts: 2` — now yields `{allowed: true, used: 2, remaining: 1}`
  and writes no counter row, instead of `{allowed: true, used: 4, remaining: -1}`.
- A non-`tenant` release for a fresh key creates no `usageCounters` row, so the
  schema §23 quota-bar read
  (`usageCounters.find({ tenantId, periodKey: { $in: [monthKey, "lifetime"] } })`)
  gains nothing from it.
- A pre-existing polluted row for a non-tenant key (written by the pre-fix
  consume/release code) is left untouched; deleting it is out of scope
  (ADR-0342 §3, ADR-0346 assumption 3).
- The existing `U1`–`U10` / `I1`–`I11` specs and the `services/**` 90 % branch
  gate stay green. `releaseCounter` remains reachable (the `tenant` branch), so
  no dead code and no coverage regression.

## Alternatives considered

- **Keep decrementing the counter for every scope and only echo `ctx.counts` in
  the verdict.** Rejected: it leaves the pollution (item a) and makes the release
  mutate a row the decision ignores — the same rejection ADR-0346 §3 records.
- **Option (b) — the counter is the usage source for every scope.** Rejected by
  ADR-0342/ADR-0346: a per-event/attendee counter identity the unique
  `{tenantId, entitlementKey, periodKey}` index cannot express, contract §3.5,
  and the §23 quota-read pollution.
- **The subtractive clamp `max(0, ctx.counts - amount)`.** Rejected: it
  contradicts the literal pin ADR-0346 recorded and the card's
  `allowedVerdict(resolved, <clamped ctx.counts>)`; amending the pin is the Test
  Author's call, not this GREEN's.

## Evidence at the GREEN head

- Unit: **100 files / 1735 tests** green, including
  `entitlements-release-nontenant.test.ts` **5 passed (5)**, the pre-existing
  `entitlements.test.ts` and `entitlements-plan-name-guard.test.ts`.
- Integration: **71 files / 513 tests** green, including
  `entitlements-release-nontenant.test.ts` **5 passed (5)** against the real
  `MongoMemoryReplSet` (the `tenant`-scope `I11` guard included).
- Coverage thresholds pass: global statements `92.21 %` / branches `80.45 %` /
  functions `96.29 %` / lines `92.73 %`, and the
  `apps/web/src/server/services/entitlements` directory branch rate `90.65 %`.
- `tsc` clean on the root, `packages/contracts` and `apps/web` projects;
  `eslint` 0 problems; `prettier --check` clean; the `adr-numbering` guard green.
- No test, mock, fixture or factory was edited: this diff is production code
  plus this record and the `docs/adr/README.md` ledger cells.

## Number allocation

The OP-103 lane's reserved range is `0340`–`0359` (ADR-0300). The RED head this
branch stacks on (`75f346d`) already carried the lane cell at `0347`: `0340`/
`0341` are consumed on `main`, and `0342`–`0346` are held **in-flight** by the
still-open F1/F2/release-RED branches (PRs #280–#283, #285; `0342` F1 RED,
`0343` F1 GREEN, `0344` F2 RED, `0345` F2 GREEN, `0346` release RED). Under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 an in-flight
allocation counts as taken, so this record takes the next free number, `0347`,
and advances the lane cell to `0348`. No number outside the lane range is
touched. `docs/adr/README.md` is the known shared-ledger hotspot and will
conflict with the F1/F2 merges; resolve by keeping each row with its own number.
