# ADR-0988 — OP-101 GREEN: the period-less `cancel` refusal landed (`409 conflict no_period_end`) above the provider call

- **Status:** Accepted (GREEN) · **Date:** 2026-11-25
- **Card:** OP-101 GREEN `t_65945a20` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-cancel-no-period-end` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-cancel-no-period-end-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0988` — the reservation the decision card `t_181a9c55` carried, used as given (not a fresh draw); the four pool-mirror cells read `0988` at this cut and advance to **`0989`** = the higher of the cell and `0988 + 1`
- **Spec sources:** [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) (the pins `K1`–`K5`, carried byte-unchanged), contract §3.3, the cancel subsection (`docs/API Contract.md:1174-1182`), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 (the refusal this record extends one route over), schema §14.3 (`subscriptions.currentPeriodEnd` is a `date`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 (the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts` (the guard, the deleted `?? now` derivation), `apps/web/src/test/integration/billing-self-serve.test.ts` (`K1`–`K5` plus the shipped arm in the `POST …/billing/cancel` describe)
- **Relates to:** [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) (the decision of record this landing executes), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 / [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the downgrade route's identical answer — untouched here), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18, [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)

## Context

[ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) decided that an
at-period-end cancel against a live subscription with no `currentPeriodEnd` is
**refused**, not turned into an immediate stop, and pinned five cases
(`K1`–`K5`) in `apps/web/src/test/integration/billing-self-serve.test.ts`. The
production tree was untouched, so the pack was RED by design at this branch's
parent commit: `K1`/`K2` read `expected 200 to be 409` (the shipped
`current.currentPeriodEnd ?? now` still answered the receipt) and `K4` read
`expected { code: 'mandate_not_chargeable', … } to match object { code:
'conflict', … }` (the mandate check ran above any period-end guard).

This record is the landing. The spec bytes, [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md)
and its ledger row are carried unchanged; one production file, one contract
§3.3 sentence, and this record plus its ledger row are new.

## Decision

**D1 — what shipped, and nothing else.** In
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts`,
immediately after `const current = liveSubscriptionSchema.parse(stored);` and
**before** `providerRefOf` and `cancelMandate`:

```ts
// §3.3 (ADR-0987): a request to stop at period end needs a period end to stop
// at. The refusal is decided before the mandate is released, so a refused
// request is a no-op at the provider as well as on the row — ADR-0984's answer
// one route over; the two billing routes must not disagree.
let cancelAt = now;
if (ctx.body.atPeriodEnd) {
  const periodEnd = current.currentPeriodEnd ?? null;
  if (periodEnd === null) {
    throw appError("conflict", { details: { reason: "no_period_end" } });
  }
  cancelAt = periodEnd;
}
```

The old derivation — `const cancelAt = ctx.body.atPeriodEnd ?
(current.currentPeriodEnd ?? now) : now;` — is deleted; the pre-computed
`cancelAt` feeds the existing `$set` unchanged, so no `?? now` survives in the
`atPeriodEnd` branch and no non-null assertion or helper could reintroduce the
fallback.

**D2 — the refusal shape.** `409`, `error.code` `conflict`,
`error.details.reason` `no_period_end`, and no side effect: nothing is written
(`cancelAt`, `cancelReason` and `cancelledAt` stay null, `status` stays `active`,
`updatedAt` keeps the seed's instant) and nothing is released at the provider
(zero `cancelMandate` calls). Both shapes of the same state — the field `$unset`
and the field explicitly `null` — answer identically; the reader already widens
it to `z.date().nullish()`, so an explicit `null` reaches the guard instead of
throwing out of `parse`.

**D3 — the guard position is the decision, not an implementation detail.** It
sits before `providerRefOf`/`cancelMandate` for two reasons: a refused request
must be a no-op at the provider (`K1`, `K2`, `K4` all assert zero calls), and
the refusal outranks `mandate_not_chargeable`, so a row that is both period-less
and mandate-less answers `no_period_end` (`K4`) while a row that does carry its
period end and has no mandate still answers `mandate_not_chargeable` (`K5`).
The three negative controls below measure that both halves are load-bearing.

**D4 — `atPeriodEnd: false` is unchanged.** It never reads `currentPeriodEnd`:
the stop is immediate, `cancelAt` is the request instant (`now`), the provider is
called exactly once and the stored instant equals the receipt's. `K3` pins that
on the very same period-less row, so the refusal is scoped to one branch and is
not "refuse everything".

**D5 — what does not change.** `ownerOnlyTenant` authorization, the `not_found
no_live_subscription` arm, the `mandate_not_chargeable` arm, the
`upstream_unavailable` arm and its `retryAfterSeconds`, `CANCEL_NOTE`, the
response shape, the log line, and the `$set` fields (`cancelAt`, `cancelReason`,
`updatedAt`) are byte-identical. The downgrade route, its spec and its contract
sentence are untouched.

## Consequences

- A live row with no `currentPeriodEnd` can no longer be stopped "at period end";
  the caller gets a named `409` instead of a silent immediate stop. The
  immediate cancel (`atPeriodEnd: false`) remains available, so the customer is
  never trapped.
- The row is not stuck permanently: `webhook-projection.ts` restores a period end
  on the next subscription event — the activation patch (`:273`) and the
  `payment_succeeded` patch (`:304`) both set `currentPeriodEnd` (and
  `nextChargeAt`), and the admin `PATCH /admin/subscriptions/{id}` path
  (contract §A, `reason` required) repairs a row-integrity gap directly.
- The two billing routes now answer the same row state the same way, which is
  what [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 and
  [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) already do for the
  downgrade; the cancel route's `?? now` fallback is gone for the `atPeriodEnd`
  direction.
- **Reversal condition.** A product decision that a period-less row cancels at a
  clock instant needs its own contract §3.3 amendment and its own record — it
  cannot come back as a `?? now` fallback, because that is the silent
  reinterpretation this landing removes.
- **Numbering.** `0988` was used as given. The four-surface sweep at this cut
  (`origin/main` `08c778bc` plus #930's tree): the trunk's highest record is
  `0986`; `git rev-list --objects --all -- docs/adr` ends at `0987` (this
  branch); every `.worktrees/*/docs/adr` tree ends at `0987` (this worktree) and
  no other worktree holds `0988`; the open PR heads hold `0986` (#932, #931's
  base) and `0973` (#896); and no non-`done` card's `Consumes` holds `0988` but
  this card. `ADR-0987` exists exactly once, on this branch. No collision, so no
  renumber. The four pool-mirror cells (`board-wide / process`, `OP-129 attendee
identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) all read
  `0988`; the higher of `0988` and `0988 + 1` is `0989`, so each advances to
  **`0989`**. No other cell moves, no cell is lowered and no range is re-cut.
  Hotspot: `docs/adr/README.md` — merge as a union keeping the highest value in
  every cell.

## Verification

Measured at head `9fc2a3f6` (this branch's implementation commit: the route plus
the contract §3.3 sentence; the record and its ledger row add no executable
surface).

**The pins.** Focused cancel describe (`-t "billing/cancel"`): RED — measured by
the authoring card on base `08c778bc` plus the spec only — `3 failed | 3 passed |
36 skipped (42)`; after this landing `6 passed | 36 skipped (42)` (the shipped
arm plus `K1`–`K5`). Whole file: `3 failed | 39 passed (42)` before,
`42 passed (42)` after — the RED baseline's `37 passed (37)` plus the five pins.

**Siblings unchanged and green.** `billing-plan-change.test.ts` `31 passed (31)`
and `billing-downgrade-scheduled-event.test.ts` `16 passed (16)`; the three
billing specs in one run read `3 passed (3)` files / `89 passed (89)` tests.

**Negative controls, each measured then reverted byte-identically.**

1. _Restore `?? now`_ (guard removed, the old derivation put back): focused
   `3 failed | 3 passed | 36 skipped (42)` — `K1` and `K2` `expected 200 to be
409`, `K4` `expected { code: 'mandate_not_chargeable', … } to match object
{ code: 'conflict', … }`. The probe bytes reproduce the pre-GREEN route
   exactly (`sha256 86d3b24d…`).
2. _Move the guard below `cancelMandate`_ (after the provider call, before the
   write): `3 failed | 3 passed | 36 skipped (42)` — `K1` and `K2` red because
   the provider is called once before the refusal, `K4` red because the mandate
   check fires first. The card predicted `K1`/`K4`; the measured set is
   `K1`/`K2`/`K4`, and the extra red is the provider-call half of `K2`.
3. _Move the guard below `providerRefOf`_ (after the mandate check, before the
   call): `1 failed | 5 passed | 36 skipped (42)` — `K4` alone, the precedence
   case, exactly as [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md)
   measured.

After each probe the route was restored and the GREEN bytes re-verified
(`sha256 b12b9be5…` for the shipped route).

**Gates.** `pnpm typecheck` exit `0`; `pnpm lint` exit `0` (the repository's
pre-existing warnings only, none in the touched files); `prettier --check` clean
on the changed files; the ten `adr-*` guards green in the whole `unit` run, and
the whole `unit` and `integration` projects green.
