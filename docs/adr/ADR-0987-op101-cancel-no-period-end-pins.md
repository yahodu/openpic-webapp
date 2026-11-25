# ADR-0987 — OP-101: an at-period-end `cancel` against a live row with no `currentPeriodEnd` is refused (`409 conflict no_period_end`) before the provider call

- **Status:** Accepted (TEST; RED by design) · **Date:** 2026-11-25
- **Card:** OP-101 TEST `t_70826ed1` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-cancel-no-period-end` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-cancel-no-period-end-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0987` — the reservation the decision card `t_181a9c55` carried, used as given (not a fresh draw); the four pool-mirror cells read `0987` at this cut and advance to **`0988`** = the higher of the cell and `0987 + 1`, because the gated GREEN `t_65945a20` already holds `0988`
- **Spec sources:** contract §3.3, the cancel subsection (`docs/API Contract.md:1174-1180`); schema §14.3 (`subscriptions.currentPeriodEnd` is a `date`); [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 (absent and explicit `null` are one state); [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 (the pool draw); [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/test/integration/billing-self-serve.test.ts` (`K1`–`K5`, in the shipped `POST /api/v1/tenants/{tenantId}/billing/cancel` describe)
- **Relates to:** [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 (the refusal this record extends one route over — **not** retracted), [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the downgrade route's landing — unchanged by this record), [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (RED by design never merges), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)

## Context

The shipped cancel route
(`apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts`) reads the
workspace's live row, parses it with `liveSubscriptionSchema` — whose
`currentPeriodEnd` is `z.date().nullish()` — resolves the mandate with
`providerRefOf` and refuses `mandate_not_chargeable` when there is none, calls
`getPaymentProvider().cancelMandate({ ref: mandate })` at `:88`, and only then
records the intent at `:101`–`:105`:

```text
const cancelAt = ctx.body.atPeriodEnd ? (current.currentPeriodEnd ?? now) : now;
```

`now` appears nowhere in §3.3's cancel subsection. An at-period-end cancel asks
the subscription to stop **at the period end it has**; a live row that carries no
period end has no such instant, and the `?? now` fallback silently turns that
request into an immediate stop — measured on this cut: `K1` and `K2` answer `200`
today and write `cancelAt = now` on a period-less row (`K1`/`K2` below).

The same state is already refused one route over. [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md)
§D1 made a **downgrade** against a live row with an absent-or-`null`
`currentPeriodEnd` answer `409 conflict` with `details.reason: "no_period_end"`
and write nothing; [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md)
landed it. The decision card `t_181a9c55` extended that answer one route over:
the cancel route answers the same refusal, and — because a cancel **releases the
mandate at the provider** — the refusal must come before the provider call, not
after it.

Two facts about the shipped spec matter for the pins. First, the file's only
cancel arm seeds `currentPeriodEnd: PERIOD_END` and asserts `200` with
`cancelAt === PERIOD_END`, so nothing exercises the `?? now` branch. Second,
`seedSubscription` writes `currentPeriodEnd: options.currentPeriodEnd ?? PERIOD_END`,
so passing `undefined` or `null` still seeds a period end: a period-less row has
to be built by seeding and then `$unset`-ing the field (absent shape) or setting
it to `null` (second shape). There are no fake timers in this file, so the
immediate-cancel instant is bracketed with `Date.now()` reads around the request.

## Decision

**D1 — a live row with no `currentPeriodEnd`, asked to cancel at period end, is
refused as `409 conflict` with `details.reason: "no_period_end"`, and the refusal
writes nothing.** Four reasons:

1. **§3.3 is unconditional about the instant.** A cancel-at-period-end stops at
   the stored period end. `?? now` is a fallback for a state the contract does
   not describe, and it converts a request the row cannot honour into a different
   request (an immediate stop) without telling the caller — the response still
   says `200` and `status: "active"`.
2. **Schema §14.3 declares `currentPeriodEnd` a `date`.** An absent value is a
   row-integrity gap, and it is repairable through the admin
   `PATCH /admin/subscriptions/{id}` path (contract §A, `reason` required), so
   the refusal has a real recovery route rather than a dead end.
3. **The state is already answered this way on the neighbouring route.**
   [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 settled the
   downgrade; refusing one route and inventing an instant on the other would make
   the same row state legal or illegal depending on which self-serve button the
   customer pressed.
4. **Absent and explicit `null` are one state** ([ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md)
   §D1). `liveSubscriptionSchema` already parses both (`z.date().nullish()`), so
   one guard covers both and neither shape becomes a `500`.

**D2 — the guard sits before the provider call.** It goes immediately after
`const current = liveSubscriptionSchema.parse(stored);` and **before**
`providerRefOf` and `cancelMandate`, so a refused request is a no-op at the
provider: nothing is released, no vendor call is made, and no retry budget is
spent on a request that can never be honoured. This is load-bearing rather than
cosmetic — `cancelMandate` is the destructive half of the route (see `K1`, `K2`,
`K4`: `calls` length `0`).

**D3 — the refusal outranks `mandate_not_chargeable`.** A request that cannot be
honoured is refused regardless of mandate state, so a row that is both
period-less and mandate-less answers `no_period_end`, not
`mandate_not_chargeable`. `K4` pins the ordering and `K5` is its discriminating
partner: a row that **does** carry its period end and has no mandate must still
answer `mandate_not_chargeable`, so `K4` cannot be satisfied by deleting the
§3.3 mandate check. The refusal is never a `422` — that code does not exist on
this route.

**D4 — `atPeriodEnd: false` is unchanged.** It never reads `currentPeriodEnd`:
the stop is immediate, `cancelAt` is the request instant, and the provider is
called exactly once. `K3` pins that the refusal is scoped to the `atPeriodEnd`
branch only, on the very same period-less row.

## Pins — K1 to K5

All five cases live in `apps/web/src/test/integration/billing-self-serve.test.ts`,
appended after the shipped arm (which is byte-identical). Each asserts the exact
`code` **and** `details.reason`, the provider call count from the recorded MSW
handler, and the no-write row set (`cancelAt` null, `cancelReason` null,
`status: "active"`, `cancelledAt` null, and `updatedAt` still the seed's
`2026-09-01T00:00:00.000Z`).

- **`K1`** — absent `currentPeriodEnd` (`$unset`), `atPeriodEnd: true` → `409`,
  envelope `{ code: "conflict", details: { reason: "no_period_end" } }`, zero
  provider calls, no write.
- **`K2`** — explicit `currentPeriodEnd: null`, `atPeriodEnd: true` → the same
  refusal, zero provider calls, the same no-write set.
- **`K3`** — the same period-less row, `atPeriodEnd: false` → `200`,
  `status: "active"`, `cancelAt` inside `[before, after]`, exactly one provider
  call carrying `{ subscription_id, action: "CANCEL" }`, the stored `cancelAt`
  equal to the returned instant, `cancelledAt` null, `note` matching
  `/not deleted/i`.
- **`K4`** — period-less row **and** `externalRefs: []` → `409` `no_period_end`
  (not `mandate_not_chargeable`), zero provider calls, no write. This is the case
  that makes D2's position, and D3's ordering, executable.
- **`K5`** — a row **with** its period end and `externalRefs: []`,
  `atPeriodEnd: true` → still `409` `mandate_not_chargeable`, zero provider
  calls, no write.

## Verification

Measured on this cut, base `origin/main` `08c778bc` plus the spec bytes only (no
production file in the diff).

**Before the pack** (spec stashed back to the trunk bytes), whole file:
`37 passed (37)`.

**After the pack**, whole file: `3 failed | 39 passed (42)`. Focused on the
cancel describe (`-t "billing/cancel"`): `3 failed | 3 passed | 36 skipped (42)`
— exactly the split this card predicted:

- `K1` — `AssertionError: expected 200 to be 409` (the `?? now` fallback still
  answers the receipt and writes `cancelAt`).
- `K2` — `AssertionError: expected 200 to be 409` (the same fallback, on the
  explicit `null` shape).
- `K4` — `expected { code: 'mandate_not_chargeable', …(3) } to match object
{ code: 'conflict', …(1) }` (the row is refused, but by the mandate check that
  today runs above any period-end guard).
- `K3` and `K5` are **green on arrival**, as declared controls.

**The pack is satisfiable, measured.** With the decided guard applied as a probe
immediately after `liveSubscriptionSchema.parse` and above `providerRefOf`
(`if (ctx.body.atPeriodEnd && (current.currentPeriodEnd ?? null) === null) throw
appError("conflict", { details: { reason: "no_period_end" } });`), the focused
cancel describe reads `6 passed | 36 skipped (42)`.

**The precedence half is load-bearing, measured.** The same guard moved one stage
lower — below the `mandate_not_chargeable` check — reads `1 failed | 5 passed |
36 skipped (42)`: `K4` alone reds (`expected { code: 'mandate_not_chargeable', … }
to match object { code: 'conflict', … }`) while `K1`/`K2` stay green. Deleting
the mandate check instead is caught by `K5`.

The production route was restored byte-identically after both probes
(`sha256 86d3b24d10e66a7727c8b99e242ba90db16d4f5a361c0c91244f41513289e594`), and
`git status --porcelain` names only the spec file.

**Siblings and gates.** `billing-plan-change.test.ts` `31 passed (31)`;
`billing-downgrade-scheduled-event.test.ts` `16 passed (16)` — the downgrade
lane's refusal and the delivered-event pin are undisturbed. `pnpm typecheck`
exit `0`; `pnpm lint` exit `0` with only the repository's pre-existing warnings
(the new spec contributes none); `prettier --check` on the spec is clean.

## Consequences

- The cancel route's `?? now` branch becomes unreachable for the `atPeriodEnd`
  direction. The gated GREEN `t_65945a20` owns that production file, the one
  contract §3.3 sentence that names the refusal, and its own record `ADR-0988`
  (held by that card, not yet written);
  nothing in `docs/API Contract.md` or any production file is in this record's
  diff, and the RED branch never merges ([ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md)).
- A period-less live row can no longer be stopped at period end until its
  `currentPeriodEnd` is repaired; the immediate cancel (`atPeriodEnd: false`)
  remains available, so the customer is never trapped.
- The reference implementation of the same answer is
  [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md); the two routes now
  read alike, and the downgrade route is not touched by this lane.
- Reversal condition: a product decision that a period-less row cancels at a
  clock instant needs its own contract §3.3 amendment and its own record — it
  cannot come back as a `?? now` fallback, because that is the silent
  reinterpretation this record removes.
- The shipped cancel arm, the `MUTATION_ROUTES` ladder entry (`401`/`403`/`404`,
  which never reaches the handler) and every other case in the file are
  byte-identical.

## Numbering

The four-surface sweep at this cut (`origin/main` `08c778bc`) finds `0986` as the
highest record on the trunk, in `git rev-list --objects --all -- docs/adr`, and in
every `.worktrees/*/docs/adr` tree (`0985`/`0986` only). Neither open PR head
carries a higher number (#930 appends to `0985`, #896 holds `0973`), and no
non-`done` card holds one: this card consumed `0987`, the gated GREEN
`t_65945a20` holds `0988`, and `t_6d7eb4f1` carries none. So `0987` is used as
given and no renumber is needed. The four pool-mirror cells (`board-wide /
process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated
(future lanes)`) all read `0987`; the higher of `0987` and `0987 + 1` is `0988`,
so each advances to **`0988`** — the cursor does not stop at `0987`, because the
GREEN already reserved `0988`. No other cell moves, no cell is lowered and no
range is re-cut. Hotspot: `docs/adr/README.md` (this record's ledger row, four
cells) — merge as a union keeping the highest value in every cell.
