# ADR-0343 — OP-103 follow-up GREEN: the entitlement decision and the counter agree for non-`tenant` scope

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_06da2c9f` (follow-up GREEN), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`, branch
  `OP-103-task-nontenant-scope-green`, off the RED head `b807c1e`
- **Consumes:** `0343` (the lane's next free number after `0340`/`0341`/`0342`)
- **Fixes:** the round-1 review finding **F1 — Medium** on
  [ADR-0341](ADR-0341-op103-entitlements-green.md), per the contract pinned by
  [ADR-0342](ADR-0342-op103-nontenant-scope-red.md) (card `t_a2dd4b1a`)

## Context

ADR-0342 pinned the non-`tenant` scope contract (option (a)): `ctx.counts` is
the only usage source for an `event`/`attendee`-scoped key, a non-`tenant`-scoped
`consumeEntitlement` writes no `usageCounters` row, and a lost counter race must
not be reported as success off the stale read. This record implements exactly
that pin.

## Decision

### 1. `consumeEntitlement` advances a counter only for `tenant` scope

After the decision, `consumeEntitlement` branches on the resolved scope:

```ts
if (resolved.scope !== "tenant") {
  return allowedVerdict(resolved, resolved.used);
}
```

For an `event`/`attendee`-scoped key the verdict's `used` is the resolved usage
(the caller's `ctx.counts`, defaulting to `0`) — the same value `decide`
reasoned about — and no `usageCounters` write is issued. `advanceCounter` is
therefore only reachable for a `tenant`-scoped key, which is the only scope
`resolveEntitlement` ever reads a counter for. Invariant 1 follows for the
non-tenant path by construction: the allowed verdict echoes `decide`'s own
`used`, so it can never exceed the effective limit.

### 2. A failed conditional advance re-decides instead of returning the stale read

`advanceCounter` no longer falls back to
`retried ?? (await readCounterValue(...))`. It returns `number | null`: `null`
when and only when neither conditional `findOneAndUpdate` matched, which — given
the filter's `value: { $lte: limit - amount }` and the upsert-first attempt —
means the counter advanced past the room between the decision and the write (a
lost race).

On `null`, `consumeEntitlement` re-resolves the entitlement against the live
counter and denies with the fresh state:

```ts
const reread = await resolveEntitlement(tenantId, entitlementKey, ctx, seams);
return deny(tenantId, deniedVerdict(reread, limitDenialReason(reread)), ctx, options, seams);
```

The denial carries the re-read `used` (so the payload is truthful), emits the
durable `usage.action.blocked` event, and throws the Appendix A
`plan_limit_exceeded` / `payment_required` error — the same enforcement surface
as a decision-time denial. A conflict error was the pin's accepted alternative;
a re-decided denial was chosen because the domain answer to "the last unit was
taken by another consumer" is the same `403 plan_limit_exceeded` the racing
decision would have produced, and it keeps one denial code path.

### 3. One denial seam

The emit-outside-the-transaction + throw sequence, previously inline in
`consumeEntitlement`, is extracted into a private `deny(...)` helper used by
both the decision-time denial and the lost-race denial. The hard-limit denial
reason (`payment_downgrade` vs `plan_limit`) is extracted into
`limitDenialReason(resolved)` and shared by `decide` and the lost-race path.
Both are behaviour-preserving refactors of the ADR-0341 code.

## Consequences

- The reviewer's probe — `events.duration_days`, limit `3`, a counter at `5`,
  `ctx.counts: 0` — now yields `{allowed: true, used: 0, remaining: 3}` and
  writes no counter row, instead of `{allowed: true, used: 5, remaining: -2}`.
- A `tenant`-scoped consume that loses the counter race now throws the limit
  denial rather than returning `allowed: true` with a negative `remaining`.
- The pre-fix behaviour's pollution — a `usageCounters` row already written for
  a non-tenant key — is left in place; deleting it is out of scope (ADR-0342 §3).
- `releaseEntitlement` still writes the counter for every scope. The pins cover
  `consumeEntitlement` only, so this GREEN does not change `release`; the
  asymmetry is recorded as a handoff coverage gap for the Test Author.
- The existing U1–U7 / I1–I6 specs and the `services/**` 90 % gate stay green.

## Alternatives considered

- **Surface a conflict (`409`) on the lost race.** Accepted by the pin
  (ADR-0342 §2 invariant 3, open question 2) but rejected here: it introduces a
  new error code for a state the caller experiences identically to a normal
  limit denial, and it would leave the quota exhausted without the durable
  `usage.action.blocked` record.
- **Deny from the stale `resolved` without re-reading.** Rejected: the denial's
  `used` would misreport the counter (e.g. `0` while the stored value is `5`),
  which is the same "report off a stale read" defect the fix removes.
- **Advance the counter for non-tenant scope and make it the sole usage
  source (option (b)).** Rejected by ADR-0342 (the unique index cannot carry a
  per-event/attendee identity; contract §3.5; §23 quota-read pollution).
- **Skip the counter write only when the scope is non-tenant but still return
  the counter's value.** Rejected: it keeps invariants 2 and 3 unaddressed.

## Evidence at the GREEN head

- Unit: **100 files / 1735 tests** green, including the new
  `entitlements-nontenant-scope.test.ts` **5 passed (5)** and the pre-existing
  `entitlements.test.ts` + `entitlements-plan-name-guard.test.ts`.
- Integration: **71 files / 510 tests** green, including the new
  `entitlements-nontenant-scope.test.ts` **2 passed (2)** against the real
  `MongoMemoryReplSet`.
- Coverage thresholds pass (see the lane paragraph in `docs/adr/README.md` for
  the exact percentages).
- `tsc` clean on the root, `packages/contracts` and `apps/web` projects;
  `eslint` 0 problems; `prettier --check` clean; the `adr-numbering` guard green.
- No test, mock, fixture or factory was edited: this diff is production code
  plus this record and the `docs/adr/README.md` ledger cells.
