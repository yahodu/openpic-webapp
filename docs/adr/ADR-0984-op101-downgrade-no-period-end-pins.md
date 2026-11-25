# ADR-0984 — OP-101: a downgrade against a live row with no `currentPeriodEnd` is refused (`409 conflict no_period_end`), not scheduled at `now`

- **Status:** Accepted · **Date:** 2026-11-25
- **Card:** OP-101 TEST `t_e05af75c` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-downgrade-no-period-end` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-no-period-end-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0984` — the reservation the orchestrator card `t_cb891a2c` carried, used as given (not a fresh draw); the four pool-mirror cells read `0987` at this cut, which is above `0984 + 1 = 0985`, so no cell moves and none is lowered
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`, the `scheduledChange` write and its period-end instant), contract §A (the admin `PATCH /admin/subscriptions/{id}` repair path, `reason` required); schema §14.3 (`subscriptions`, `currentPeriodStart` / `currentPeriodEnd` a `date`); [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2 (the `dedupeKey`), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D3 (the repeat reads before it writes), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §D5 (the measurement this record acts on)
- **Consumers:** `apps/web/src/test/integration/billing-plan-change.test.ts` (`F5` the `$unset` shape, `F5b` the explicit `null` shape; `I4` stays the accepted-direction control); `apps/web/src/test/integration/billing-self-serve.test.ts` (`K1`/`K2`/`K4` cite this record's §D1 as the answer [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) extends one route over — a guard-required citation, not a change to the frozen decision)
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D2 — the stable `dedupeKey` a refusal preserves), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) (§D3 — the `alreadyEmitted` pre-read that collapses a repeat once the instant is stable), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) (§D5 — the measured duplicate this record makes impossible), [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) (the `?? now` fallback this record **supersedes** as an open product question), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18, the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

Contract §3.3 writes, unconditionally:

```text
subscriptions.scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason: "self_downgrade" }
```

`now` appears nowhere. The shipped route deviated at
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts:160` —
`const effectiveAt = current.currentPeriodEnd ?? now;` — so a live row that carries
no period end was scheduled **immediately**, and that instant became part of
[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2's
`dedupeKey`. [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §D5
measured the consequence: two identical requests produced the keys
`billing.plan.downgrade_scheduled:<sub>:free:<…:03.042Z>` and
`…:<sub>:free:<…:03.066Z>`, both answered `[200, 200]`, and two event rows, two feed
rows and two emails followed. A different clock read per request is the same intent
under two identities.

[ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) had filed the fallback as an
open product question — refuse, or derive a stable instant — and pinned the shipped
behaviour as a characterisation. The orchestrator card `t_cb891a2c` decided it:
**refuse**. This card makes that decision executable and retires the fallback.

## Decision

**D1 — a live row with no `currentPeriodEnd` is refused as `409 conflict` with
`details.reason: "no_period_end"`, and the refusal writes nothing.** Five reasons:

1. **§3.3 is unconditional.** It schedules at `currentPeriodEnd` and names no other
   instant. The shipped `?? now` is the deviation, and it is what makes
   [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2's `dedupeKey`
   carry a per-request clock instant — the measured duplicate above.
2. **Schema §14.3 declares `currentPeriodStart` / `currentPeriodEnd` a `date`.** An
   absent value is a row-integrity gap, not a legitimate state — and it is
   repairable: the admin `PATCH /admin/subscriptions/{id}` may set
   `currentPeriodEnd` (contract §A, `reason` required), so the refusal has a real
   recovery path rather than a dead end.
3. **"Derive a stable instant" has no honest source.** No stored field means _period
   end_; reusing `updatedAt`/`createdAt` would silently redefine `effectiveAt` and, on
   a paid plan, apply an immediate downgrade the customer did not get the paid period
   for — a worse failure than a refusal. Deriving one would need its own contract
   amendment.
4. **Refusal makes the duplicate impossible by construction.** Every _accepted_
   schedule's instant is the stored period end, so two identical requests compute an
   identical key and the shipped `alreadyEmitted` pre-read (`route.ts:182`) collapses
   them — no second dedupe special case, and
   [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D3 keeps its single
   meaning.
5. **The explicit `null` shape gets the same answer.** On the shipped tree it is a
   `500` (`Invalid input: expected date, received null`) because
   `liveSubscriptionSchema` is `z.date().optional()` (`route.ts:52-56`). A `500`
   blames the client for a server row state; one refusal covers both shapes.

**D2 — the pinned contract (what the gated GREEN must satisfy).**

- A live row with `currentPeriodEnd` **absent** (`$unset`) answers `409`,
  `error.code === "conflict"`, `error.details.reason === "no_period_end"`, and writes
  nothing: `subscriptions.scheduledChange` is still unset and `domain_events` gains no
  row.
- The same row with `currentPeriodEnd: null` answers the **same** `409` and the same
  `reason`, and still writes nothing — not a `500`.
- **Control, must stay green:** a row that _has_ a period end still answers `200` with
  `effectiveAt` equal to the stored period end and
  `scheduledChange = { toPlanKey, effectiveAt: <period end>, reason: "self_downgrade" }`.
  The refusal must not be satisfiable by refusing everything, so the accepted direction
  keeps its pin.

**D3 — the rejected alternative: derive a stable instant.** Rejected for the reason
above (D1 reason 3): there is no stored field that _means_ period end, so any derived
instant redefines `effectiveAt` from a field with another meaning, applies a paid-plan
downgrade the customer did not buy a period for, and would still need a contract §3.3
amendment to be legal. A refusal is reversible (the admin `PATCH` repairs the row) and
needs no amendment.

## Evidence

**Pinned (RED by design).** `apps/web/src/test/integration/billing-plan-change.test.ts`,
focused on the shipped tree:

```text
npx vitest run --project integration apps/web/src/test/integration/billing-plan-change.test.ts
Tests  2 failed | 29 passed (31)
```

- `F5: a live row with no currentPeriodEnd is refused as 409 conflict no_period_end and writes nothing` — `AssertionError: expected 200 to be 409` (the fallback still schedules).
- `F5b: a live row whose currentPeriodEnd is explicitly null is refused the same 409 conflict no_period_end` — `AssertionError: expected 500 to be 409` (the schema still rejects `null` in `parse`).
- `I4` (the control) stays green; the file read `30 passed (30)` before the rewrite.

**The no-write half is discriminating, measured** on a throwaway copy of the spec with
the status assertions removed (shipped tree, no production change): `F5` reds at
`expected { toPlanKey: 'free', …(2) } to be null`, and with that assertion removed too,
at `expected [ { …(10) } ] to have a length of +0 but got 1`. The shipped path really
does write the schedule and emit the event, so both halves discriminate.

**The pack is satisfiable, measured.** With the decided shape applied as a probe (the
`z.date().nullable().optional()` widening, the guard beside `no_live_subscription`, and
`const effectiveAt = periodEnd;`), the focused spec reads `31 passed (31)` and the
sibling `billing-downgrade-scheduled-event.test.ts` reads `16 passed (16)` — the refusal
does not disturb `B1`–`B5`. The production file was restored byte-identically
(`sha256 4cc75efa53b5707da6a9b471b8a0cf59fb805b6a13be306fc5e203a891353479`).

## Consequences

- The `?? now` fallback at `route.ts:160` and its `F5` characterisation are **retired**;
  [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md)'s open question is answered.
- Two test cases are RED by design on this branch. The gated GREEN
  (`openpic-webapp-backend-coder`, `Consumes: 0985`) carries these spec bytes unchanged
  and owns `route.ts`, `liveSubscriptionSchema` and the contract §3.3 sentence; nothing
  in `docs/API Contract.md` or any production file is in this record's diff.
- The admin `PATCH` repair path is now load-bearing for a period-less row: without it
  the refusal would have no exit. That route is contract-only at this head; the refusal
  does not depend on it existing, only on the state being repairable in principle.
- Reversal condition: a product decision that a period-less row downgrades immediately
  needs its own contract §3.3 amendment and its own record — it cannot be reintroduced
  as a fallback, because that is what made the duplicate possible.
- `I4` and `B1`–`B5` stay byte-identical, so the accepted direction and the
  sequential-repeat dedupe are unchanged by this record.

## Numbering

The four-surface sweep at this cut (`origin/main` `7ae790f7`, PR #921) finds `0980`–`0983`
and `0986` on the trunk and **no** `ADR-0984` or `ADR-0985` anywhere: not in any
`.worktrees/*/docs/adr` tree, not in `git rev-list --objects --all -- docs/adr`, not on
either open PR head (#924, #896) and not in any non-`done` card's `Consumes` (`0983` is
done, `0986` belongs to `t_ab833349`/`t_cfaec81c`, and the gated GREEN `t_b4d8d70e` holds
`0985`). `0984` is used as given, so no renumbering is needed and no range is re-cut. The
four pool-mirror cells (`board-wide / process`, `OP-129 attendee identity lane`, `OP-136
jobs lane`, `unallocated (future lanes)`) read `0987`; the higher of `0987` and `0985` is
`0987`, so **no cell is edited and none is lowered**. Hotspot: `docs/adr/README.md` (this
record's ledger row) — merge as a union keeping the highest value in every cell.
