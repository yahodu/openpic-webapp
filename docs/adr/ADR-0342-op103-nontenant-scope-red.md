# ADR-0342 — OP-103 follow-up RED: the non-`tenant` entitlement scope and the counter-advance fallback

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_a2dd4b1a` (follow-up TEST), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`, branch
  `OP-103-task-nontenant-scope-pins`, off `origin/main` `c50ef7c`
- **Consumes:** `0342` (the lane's next free number after `0340`/`0341`)
- **Fixes:** the round-1 review finding **F1 — Medium** on
  [ADR-0341](ADR-0341-op103-entitlements-green.md)
- **GREEN successor:** `t_06da2c9f`, gated on this card

## Context

`resolveEntitlement` resolves usage as
`spec.scope === "tenant" ? <usageCounters row> : (ctx.counts ?? 0)`, but
`consumeEntitlement` always advanced the tenant-scoped `usageCounters` row via
`advanceCounter` (ADR-0341 §2). For an `event`/`attendee`-scoped key the
decision and the counter therefore disagreed: the verdict's `used` was the
counter's post-increment value while the decision reasoned about `ctx.counts`,
and when the counter already exceeded the limit the call returned an **allowed**
verdict with a negative `remaining` (the reviewer's probe: `{allowed: true,
limit: 3, used: 5, remaining: -2}` for `events.duration_days` with `ctx.counts:
0`).

A second, related hole: `advanceCounter` fell back to
`retried ?? (await readCounterValue(...))` and returned an allowed verdict off
that stale value when the conditional `$inc` matched nothing on both attempts
(`service.ts` ~358–361).

ADR-0340 §7 and ADR-0341 §8 recorded that `event`/`attendee` usage comes from
`ctx.counts`, but **only `tenant`-scoped keys were exercised by the OP-103
specs**, so the disagreement was unpinned.

## Decision

### 1. Option (a): `ctx.counts` is the only usage source for non-`tenant` scope

`consumeEntitlement` **does not advance `usageCounters` for an `event` or
`attendee` scope**. The caller's `ctx.counts` is the usage source, and the
returned verdict's `used` equals `ctx.counts`. (Option (b) — the counter as the
sole usage source for every scope — was rejected; see _Alternatives_.)

### 2. The three invariants the pins encode

1. A returned verdict is **never** `allowed: true` with `used > effectiveLimit`
   or `remaining < 0`.
2. A non-`tenant`-scoped consume must not write a `usageCounters` row the
   decision never reads.
3. When the conditional counter advance matches nothing on **both** attempts,
   `consumeEntitlement` must not report success off the stale counter — it
   re-decides (deny) or surfaces a conflict.

### 3. Why (a) and not (b)

- The schema's own `usageCounters` examples are all `tenant`-scoped
  (`events.active`, `storage.bytes` — §14.2). A per-event/per-attendee counter
  would need an owner identity the `{tenantId, entitlementKey, periodKey}`
  unique index cannot express, so (b) would require a schema change.
- Schema §23's organizer-dashboard read is
  `usageCounters.find({ tenantId, periodKey: { $in: [monthKey(), "lifetime"] } })`
  — it has no scope discriminator, so any non-tenant row written there surfaces
  in the tenant's quota bars as pollution.
- Contract §3.5 states event/attendee entitlements are returned "with their plan
  limits but **without** `used`; per-event consumption is returned by
  `GET /events/{eventId}`" — i.e. non-tenant usage is not modelled in
  `usageCounters` at all.

## Consequences

- The GREEN changes `consumeEntitlement` so a non-`tenant`/non-metered scope does
  not call `advanceCounter`; the verdict is built from `resolved.used`
  (`ctx.counts`), not a counter read.
- The `advanceCounter` both-attempts-failed path must re-decide/deny rather than
  return the stale read.
- A counter row already present for a non-tenant key (written by the pre-fix
  code) stays where it is — the fix stops _new_ pollution; cleanup of existing
  rows is out of scope.
- The existing U1–U7 / I1–I6 specs and the `services/**` 90 % branch gate must
  stay green.

## Alternatives considered

- **Option (b) — the counter is the usage source for every scope.** Rejected:
  it needs a per-event/attendee counter identity the unique index cannot carry,
  contradicts contract §3.5, and would make every event/attendee consume write a
  row the §23 quota read misreports.
- **Only special-casing the returned `used` while still writing the counter.**
  Rejected: it leaves the pollution (invariant 2) and the stale-fallback
  (invariant 3) unaddressed.

## Evidence at the RED head

Two new spec files (production code: none):

| File                                                                 | Pins                                             |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/web/src/test/unit/entitlements-nontenant-scope.test.ts`        | U8 (event/attendee/feature scope), U9 (fallback) |
| `apps/web/src/test/integration/entitlements-nontenant-scope.test.ts` | I7/I8 against a real `MongoMemoryReplSet`        |

- Unit: **5 failed | 26 passed (31)** across the three entitlement unit specs
  (`5 failed (5)` on the new file alone), all assertion-level —
  `expected "used": 0, received "used": 5`; `expected [ … ] to deeply equal []`
  (two counter writes recorded); `expected true to be false` (the stale
  fallback returned `allowed: true`).
- Integration: **2 failed (2)** on the new file, assertion-level —
  `expected "used": 0, received "used": 1` (I7, plus the §23 quota read would
  surface the key) and `expected "used": 2, received "used": 1` (I8).
- The pre-existing `entitlements.test.ts` (unit 26 passed) and
  `entitlements-plan-name-guard.test.ts` stay green; the integration
  `entitlements.test.ts` stays green (9 passed).
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 problems;
  `prettier --check` clean on both files.

## Open questions handed to the GREEN

1. **Where the scope check lives.** The pin requires only that a non-`tenant`
   scope does not advance the counter; whether the guard is a `scope !== "tenant"`
   branch in `consumeEntitlement` or a `metered` predicate on the resolved state
   is the GREEN's choice.
2. **The stale-fallback surface.** Invariant 3 accepts either a re-decided
   denial (an `AppError` throw) or a surfaced conflict. U9 asserts only that the
   call does not resolve to an allowed verdict.
3. **A pre-existing polluted row.** This RED does not require the fix to delete
   a `usageCounters` row already written for a non-tenant key.

## Note for the GREEN: the duplicate-key-in-transaction retry storm

The reviewer's over-limit probe used a fake `Db`. Against a real replica set the
same shape (an `event`/`attendee` key with a pre-existing counter row above the
limit, consumed inside `withTransaction`) does **not** reach `advanceCounter`'s
fallback: the upsert's E11000 inside a transaction is labelled
`TransientTransactionError`, so the driver retries the whole callback until the
attempt budget is spent (`TransactionRetryLimitError`). The over-limit verdict
is therefore pinned in the **unit** spec (U8, fake `Db`) and the integration
suite pins the observable "no row written" (I7/I8) instead.
