# ADR-0346 — OP-103 follow-up RED: the non-`tenant` release scope uses `ctx.counts` and leaves `usageCounters` untouched

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_cc32c3d2` (follow-up TEST), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`, branch
  `OP-103-task-release-nontenant-pins`, off `origin/main` `ebb0ebc`
- **Consumes:** `0346`
- **Fixes:** the release-scope asymmetry surfaced by the F1 GREEN (`t_06da2c9f`)
  and asked for by that card; the `consume`-scope finding **F1** of card
  `t_429ad6f8` applied to `release`
- **GREEN successor:** `t_b21f15aa`, gated on this card

## Context

`resolveEntitlement` resolves usage as
`spec.scope === "tenant" ? <usageCounters row> : (ctx.counts ?? 0)`
(`service.ts:198–201`), but `releaseEntitlement` always called
`releaseCounter(...)`, which decrements the tenant-scoped `usageCounters` row for
**every** scope. For an `event`/`attendee`-scoped key the release therefore
disagreed with the decision in exactly the two ways the F1 fix (`ADR-0342` /
`ADR-0343`) removed for `consumeEntitlement`:

1. **Pollution.** The release decremented a counter row the decision never reads.
   The same class of pollution `ADR-0342` rejected for consume: the schema's own
   `usageCounters` examples are all `tenant`-scoped (§14.2), and the §23
   quota-bar read
   (`usageCounters.find({ tenantId, periodKey: { $in: [monthKey(), "lifetime"] } })`)
   has no scope discriminator, so a row written for a non-tenant key surfaces in
   the tenant's quota bars.
2. **A wrong `used`.** `releaseCounter` returns the counter's post-decrement
   value, and `releaseEntitlement` built the verdict from it
   (`service.ts:567–568`) — so a caller releasing an event-scoped entitlement
   was told the counter's figure, not `ctx.counts`. Against a real replica set
   the probe is `{ allowed: true, limit: 3, used: 4, remaining: -1 }` for
   `events.duration_days` with a pre-existing counter row at `5` and
   `ctx.counts: 2` — an **allowed** verdict with a negative `remaining`.

The `tenant`-scoped release is correct and pinned by `I5`; it is not disturbed.

## Decision

### 1. Option (a), mirrored from `ADR-0342`: `ctx.counts` is the only usage source for non-`tenant` scope

`releaseEntitlement` **does not touch `usageCounters` for an `event` or
`attendee` scope**. The caller's `ctx.counts` is the usage source, and the
returned verdict's `used` is derived from it, not from the counter. The GREEN
mirrors the F1 GREEN's shape: branch on the resolved scope and, for a
non-`tenant` scope, return `allowedVerdict(resolved, <clamped ctx.counts>)`
without calling `releaseCounter`.

### 2. The contract this record pins (the card's three items)

1. A non-`tenant`-scoped `releaseEntitlement` issues **no** `usageCounters` write
   (the collection's write log is empty; a pre-existing row is left untouched; a
   fresh key gains no row).
2. The returned verdict's `used` comes from `ctx.counts`, never the counter:
   `used = ctx.counts ?? 0`, clamped to `0` when `amount > (ctx.counts ?? 0)`.
3. The `tenant`-scoped release still decrements and clamps at zero, exactly as
   `I5` pins today (guard against regressing it).

### 3. Why (a) and not (b)

Same reasoning as `ADR-0342` §3: a per-event/per-attendee counter identity the
`{tenantId, entitlementKey, periodKey}` unique index cannot express; the §23
quota read would misreport the row; and contract §3.5 states event/attendee
entitlements are returned "with their plan limits but **without** `used`". The
release must agree with the consume decision for the same key.

## Consequences

- The GREEN changes `releaseEntitlement` so a non-`tenant`-scoped key does not
  call `releaseCounter`; the verdict is built from the resolved usage
  (`ctx.counts`, clamped) rather than a counter read.
- A counter row already present for a non-tenant key (written by the pre-fix
  consume/release code) stays where it is — the fix stops _new_ pollution;
  cleanup of existing rows is out of scope (mirrors `ADR-0342`).
- The existing `U1`–`U9` / `I1`–`I8` specs and the `services/**` 90 % branch gate
  must stay green.

## Alternatives considered

- **Option (b) — the counter is the usage source for every scope.** Rejected for
  the same reasons as `ADR-0342`: a per-event/attendee counter identity the
  unique index cannot carry, contract §3.5, and the §23 quota-read pollution.
- **Only special-casing the returned `used` while still decrementing the
  counter.** Rejected: it leaves the pollution (item 1) and makes the release
  mutate a row the decision ignores — it is simply wrong for a caller that owns
  `counts`.

## Number allocation

The OP-103 lane's reserved range is `0340`–`0359` (ADR-0300). On `origin/main`
(`ebb0ebc`) the README `Next free` cell reads `0342`, but `0342`–`0345` are held
_in-flight_ by the still-open F1/F2 branches (PRs #280–#283, both OPEN at this
writing): `0342` (F1 RED, `t_a2dd4b1a`), `0343` (F1 GREEN, `t_06da2c9f`), `0344`
(F2 RED, `t_4ce9a410`), `0345` (F2 GREEN, `t_2d83385c`). Under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 an in-flight
allocation counts as taken, so this record takes the **next number free after
them, `0346`**, and advances the lane cell to `0347`. No number outside the lane
range is touched. `docs/adr/README.md` is the known shared-ledger hotspot and
will conflict with the F1/F2 merges; resolve by keeping this row with `0346`.

## Assumptions recorded in the handoff (open questions)

1. **The clamp reading.** The card specifies `used` "equals `ctx.counts`
   (clamped at `0` when `amount > ctx.counts ?? 0`)". This record encodes that
   **literally**: `used = amount > (ctx.counts ?? 0) ? 0 : (ctx.counts ?? 0)` —
   i.e. an echo of the caller's count, floored to `0` only when the release
   amount exceeds it (not a subtraction `max(0, ctx.counts - amount)`). The two
   readings differ for every `amount <= ctx.counts`; they agree that
   `amount > ctx.counts` ⇒ `0`. The literal reading matches the GREEN card's
   `allowedVerdict(resolved, <clamped ctx.counts>)` and the pinned `consume`
   echo (`ADR-0342` U8). It is **discontinuous** at `amount == ctx.counts`
   (`used` stays `ctx.counts`) versus `amount == ctx.counts + 1` (`used` is `0`);
   if the lane intended the subtractive mirror, the GREEN card `t_b21f15aa` must
   say so and this pin is amended — it is **not** weakened here.
2. **Where the scope guard lives.** The pin requires only that a non-`tenant`
   scope issues no counter write and reports `ctx.counts`; whether the guard is a
   `scope !== "tenant"` branch in `releaseEntitlement` or a `metered` predicate
   on the resolved state is the GREEN's choice.
3. **A pre-existing polluted row.** This RED does not require the fix to delete
   a `usageCounters` row already written for a non-tenant key; it pins only that
   a release leaves it untouched.

## Evidence at the RED head

Two new spec files (production code: none):

| File                                                                   | Pins                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/web/src/test/unit/entitlements-release-nontenant.test.ts`        | U10 (event/attendee/feature scope: `used` + no counter write) |
| `apps/web/src/test/integration/entitlements-release-nontenant.test.ts` | I9/I10 (no row written / row untouched) + I11 (tenant guard)  |

- Unit: **5 failed | 26 passed (31)** across the three entitlement unit specs
  (`5 failed (5)` on the new file alone), all assertion-level —
  `expected "used": 2, received "used": 0`; `expected [ { …(3) }, { …(3) } ] to
deeply equal []` (two counter `findOneAndUpdate` calls recorded).
- Integration: **2 failed | 3 passed (5)** on the new file, assertion-level —
  `expected "used": 2, received "used": 4` and `expected "remaining": 1, received
"remaining": -1` (I9, against a real pre-existing counter row at `5`) and
  `expected +0 to be 3` (I10, the release clamped the attendee row to `0`).
- The pre-existing `entitlements.test.ts` (unit 26 passed; integration 9 passed)
  and `entitlements-plan-name-guard.test.ts` stay green.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 problems;
  `prettier --check` clean on both files.
