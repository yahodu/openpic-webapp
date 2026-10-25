# ADR-0460 — OP-109 RED: the plan-change surface — immediate upgrade, period-end downgrade and the scheduled-change cancel

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 RED (`t_1dac4ffe`) · **Branch:** `wt/t_1dac4ffe` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1dac4ffe`
- **Relates to:** [ADR-0400](ADR-0400-op106-subscription-read-red.md) / [ADR-0401](ADR-0401-op106-subscription-read-green.md) (the `scheduledChange` the downgrade writes is the block that read serves), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout envelope and insert-then-call shape the upgrade reuses), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the `PaymentProvider` port and the Cashfree adapter this lane extends), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the webhook that lands `billing.plan.upgraded`), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the `usageCounters` the consequence calculator reads), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (checkout, upgrade, downgrade, cancel), §0.5 (envelopes), §0.9 (idempotency), §0.15 (never-return) · **Schema:** §14.1 (plans), §14.2 (usage counters), §14.3 (subscriptions) · **Billing doc:** §4.5 (upgrade), §10 (never destructive)

## Context

OP-109 is the story that lets a tenant owner **change** plans safely. §3.3 names
three endpoints and pins their shapes:

```
POST   /api/v1/tenants/{tenantId}/billing/upgrade           (user:complete, owner, Idempotency required)
{ "targetPlanKey": "professional", "priceKey": "professional-monthly-inr", "returnUrl": "…" }
→ 201 (the checkout envelope) + { "requiresReauthorization": true, "notice": "…" }
  422 not_an_upgrade  if targetPlanKey.tierRank <= current.tierRank

POST   /api/v1/tenants/{tenantId}/billing/downgrade         (user:complete, owner)
{ "targetPlanKey": "free", "acknowledgeConsequences": true }
→ 200 { "scheduledChange": { "toPlanKey": "free", "effectiveAt": "<currentPeriodEnd>" } }
  422 acknowledgement_required with details.consequences

DELETE /api/v1/tenants/{tenantId}/billing/scheduled-change  → 204
```

Two sentences in §3.3 shape the whole design:

- **Upgrades are immediate**: "Because recurring mandates cannot be mutated in
  place, this is cancel-old + create-new; the new `subscriptions` document
  carries `previousSubscriptionId` and the old one is retained with
  `status: "cancelled"` for history. `usageCounters` are **not** reset."
- **`destructive: false` is a hard invariant of the calculator itself**: "Every
  `effect` must have `destructive: false`. … If any computed consequence would
  be destructive, that is a bug in the consequence calculator, not a valid
  response."

The card pins only observable behaviour — `U1` the consequence calculator over
usage fixtures, `U2` the `tierRank` comparison, `I1`–`I5` the three endpoints
against MSW + MongoDB + the in-memory server. It does not pin module paths, the
provider seam an upgrade uses to cancel the old mandate, the shape of a
consequence, or where the failure codes live. The sibling GREEN card
`t_4079f630` narrows some of it (the three route paths, "cancel the old mandate
via the provider, create a new subscription doc with `previousSubscriptionId`
… old cancelled first, inside a transaction for the DB part", "usageCounters are
NOT reset", "emit `billing.plan.upgraded` on activation" — the last is a webhook
projection concern and out of this card's test list). This record fixes the rest.

## Decision

### Module contract

| Module (specifier)                                                        | Exports                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/services/subscriptions/plan-change` (re-exported by the barrel) | `comparePlanTiers(currentTierRank, targetTierRank): PlanChangeDirection`, `computeDowngradeConsequences(input): readonly DowngradeConsequence[]`, the `PlanChangeDirection` / `DowngradeConsequence` / `EntitlementUsageFact` / `DowngradeConsequencesInput` types, and the request/response schemas |
| `@/app/api/v1/tenants/[tenantId]/billing/upgrade/route`                   | `POST` — `userAuth()` + `tenantStage()` + `idempotencyStage({ required: true })`; the §3.3 envelope plus `requiresReauthorization` and `notice`, with `Location: <checkout url>`                                                                                                                     |
| `@/app/api/v1/tenants/[tenantId]/billing/downgrade/route`                 | `POST` — `userAuth()` + `tenantStage()`; `200 { scheduledChange }`                                                                                                                                                                                                                                   |
| `@/app/api/v1/tenants/[tenantId]/billing/scheduled-change/route`          | `DELETE` — `userAuth()` + `tenantStage()`; `204` with **no body** (the pipeline's own `isNoContentStatus` short-circuit)                                                                                                                                                                             |
| `@/server/payments/payment-provider`                                      | the shared cancel seam `cancelMandate(input: CancelMandateInput): Promise<CancelMandateResult>` — `CancelMandateInput = { ref: ProviderRef }`, `CancelMandateResult = { status: NormalizedStatus }`                                                                                                  |

The three routes are tenant-scoped on the **string** hex `tenantId` (the
OP-103/OP-104/OP-106/OP-107 convention for `subscriptions` rows), so a seeded
fixture writes `tenantId` as `tenantId.toHexString()`.

### 1. The port gains one method, and the upgrade's provider order is cancel **then** create

ADR-0381 deliberately left `cancelMandate` off the port ("their wire contracts
belong with their own pins"). Two lanes now need it — this one (cancelling the
old mandate on upgrade) and OP-110 (`POST /billing/cancel`) — so the name and
signature are fixed **here**, once, and `I1c` pins it directly so the two lanes
cannot diverge:

```ts
cancelMandate(input: CancelMandateInput): Promise<CancelMandateResult>;
```

The Cashfree adapter implements it over the **pinned** `x-api-version:
2025-01-01` **Manage Subscription** endpoint, verified against Cashfree's own
reference for that version rather than the docs default:

```
POST https://sandbox.cashfree.com/pg/subscriptions/{subscription_id}/manage
{ "subscription_id": "…", "action": "CANCEL" | "PAUSE" | "ACTIVATE" | "CHANGE_PLAN", "action_details": { … } }
```

`CANCEL` normalizes through the existing `STATUS_TABLE` (`CANCELLED →
cancelled`/`revoked`), which `I1c` asserts — so a manage response that a future
adapter drops on the floor is a visible failure, not a silent no-op.

`I1` records the **order** of the two vendor calls (a cancel, then a create) and
asserts it, because that ordering is the story: the old mandate must be released
before a new one is minted for the same customer. `I1`'s failure pin asserts the
inverse — a cancel that fails at the vendor (`500` → `502 upstream_unavailable`)
leaves the workspace with exactly its original live row and **never** starts the
second mandate.

### 2. `comparePlanTiers` is a three-way relation, and the upgrade refuses everything that is not `upgrade`

§3.3 refuses `422 not_an_upgrade` for `target.tierRank <= current.tierRank`, so
an **equal** rank is refused by the upgrade endpoint too (the workspace is
already there). A boolean `isUpgrade` would hide that: the route would have to
re-derive "is it equal or lower?" to pick the right refusal. The relation is:

| `comparePlanTiers(current, target)` | Result      |
| ----------------------------------- | ----------- |
| `target > current`                  | `upgrade`   |
| `target < current`                  | `downgrade` |
| `target === current`                | `same`      |

The endpoint branches on `!== "upgrade"`; `I2` pins both the lower-tier and the
equal-tier refusal, each naming `currentTierRank`, `targetTierRank` and a
`downgradeUrl`, and each asserting the provider was never called.

### 3. `computeDowngradeConsequences` is pure, takes the usage as an argument, and emits two shapes

The calculator reasons about plan documents and counters, both of which are I/O
in the route, so it takes them as input and stays a pure function (no `db`, and
— because it lives under `src/server/services/**` — no ambient clock either):

```ts
computeDowngradeConsequences({ currentPlan, targetPlan, usage }): readonly DowngradeConsequence[]
```

It walks the **target** plan's entitlements — a key the target does not gate is
not a constraint (the `coorganizers.per_event` case) — and, per key:

| Key state                                                                     | Consequence                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `enforcement === "feature"`                                                   | none (a gate is not a usage constraint)                                  |
| `target.limit === null` (unlimited)                                           | none                                                                     |
| a `usage` fact exists and `used > target.limit`                               | `{ entitlementKey, currentUsage, newLimit, effect, destructive: false }` |
| a `usage` fact exists and `used <= target.limit` (headroom)                   | none                                                                     |
| no `usage` fact, and `current.limit !== null && current.limit > target.limit` | `{ entitlementKey, current, new, effect, destructive: false }`           |
| no `usage` fact, and the ceiling does not shrink                              | none                                                                     |

Both shapes are the two the contract's worked example carries: a metered key the
tenant has already out-used (`events.active`, `currentUsage` + `newLimit`) and a
policy ceiling that simply shrinks (`gallery.retention_days`, `current` + `new`).
`destructive: false` is a **literal** in the type, so a consequence that would be
destructive is not expressible — and the unit pin still asserts it at runtime,
because the value crossing the wire comes from JavaScript, not from TypeScript.

The route resolves the `usage` facts: for each `tenant`-scoped, non-feature key
of the current plan it reads the `usageCounters` row at its own `resetPeriod`'s
period key (`periodKey(spec.resetPeriod, clock.now())`) and passes
`{ entitlementKey, used }`. `event`/`attendee`-scoped keys have no counter (§14.2:
only a `tenant`-scoped key advances one), which is exactly why a key with no fact
takes the ceiling-diff branch.

### 4. A downgrade is _scheduled_, never immediate

`I4` pins the write §3.3 names verbatim:
`scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason:
"self_downgrade" }`. The live plan is untouched — `status` stays `active` and
`activePlanKey` stays the current tier — because the change lands at period end
and the cron sweep (OP-111) applies it. `I3` pins the refusal direction: without
`acknowledgeConsequences` (or with it omitted) the route is `422
acknowledgement_required` and writes **nothing**.

`DELETE …/scheduled-change` answers `204` with a genuinely empty body (the
pipeline short-circuits any `isNoContentStatus`), and `I5` asserts the body's
**byte length** rather than `text() === ""` — both pass, but the byte count is
what "no content" means.

### 5. Two error codes are appended to the catalogue

`not_an_upgrade` (`422`, `{ currentTierRank, targetTierRank, downgradeUrl }`) and
`acknowledgement_required` (`422`, `{ consequences }`) are Appendix A.4 rows the
server catalogue does not carry yet. The GREEN owes them in the
`BILLING_ERROR_CODES` shape OP-107 established (ADR-0421): appended to
`packages/contracts`' `BILLING_ERROR_CODES` and to the `@/server/http/catalog`
transport table, never into the base `ERROR_CATALOG` the HTTP-pipeline story
pins exactly.

### 6. Owner-only, on all three routes

§3.3 makes every billing mutation owner-only, so `member` **and** `admin` are
`403 forbidden` and a non-member is the uniform `404 not_found`. The ladder is
pinned with one `it.each` over the three routes so a new verb cannot quietly ship
without it.

## Assumptions and open questions

- **The current plan is the live row's `activePlanKey`.** The comparison is
  against the seeded catalogue's `tierRank` (`free` 0, `starter` 1,
  `professional` 2, `enterprise` 3). A workspace with **no** live subscription is
  not pinned at all — §3.3 does not say whether an upgrade from the implicit
  `free` state is a `409` or a checkout in disguise. Out of scope; flagged.
- **The consequence `effect` copy is not pinned.** Only "a non-empty sentence" is
  asserted: the contract's examples are copy, and pinning prose would break on a
  copyedit rather than on a behaviour change.
- **A `feature` gate that closes is not a consequence.** Neither the card nor
  §3.3's worked example names one, and the invariant "nothing already created is
  retroactively removed or hidden" makes a closed gate a _new-event_ limit rather
  than an acknowledgement. The unit fixtures avoid feature keys entirely; if
  product wants an "original downloads will stop" line, that is a new RED.
- **`DELETE` with nothing scheduled.** §3.3 shows only the `204`. The suite does
  not pin the absent case, so the GREEN may answer `204` (idempotent) or a
  refusal without breaking a pin. Flagged.
- **A create failure after a successful cancel** is not pinned. The old mandate
  is already cancelled at the vendor by then, so the honest answers (park the new
  row terminal and let the user retry the upgrade, or leave an `incomplete` row)
  differ in observability and the contract is silent. Flagged.
- **`usageCounters` period keys come from the real clock.** The route reads
  `systemClock.now()`, so the spec derives the seeded key with the production
  `periodKey("monthly", new Date())` rather than a literal — a midnight-UTC
  month rollover mid-run would move it, the same residual the entitlement suites
  already carry.
- **The manage-response fixture is a superset.** It is the create-response
  fixture with `subscription_status: "CANCELLED"` plus the two fetch-status-only
  fields, so either existing adapter schema may be reused for the manage call
  without the fixture being the reason a parse fails.

## Consequences

- The lane's **port extension is now a cross-lane contract**: OP-110's
  `POST /billing/cancel` must reuse `cancelMandate` (posted as a note on OP-110's
  cards), or the two lanes will mint two different cancel seams against one
  vendor endpoint.
- `destructive: false` is enforced twice — in the type and by a runtime pin that
  names the offending consequence — so "the downgrade prompt is never a threat to
  existing content" is a property of the calculator, not of the copy.
- The upgrade's two vendor calls are ordered and counted at the **external**
  boundary (MSW), so an implementation that creates before it cancels — or that
  retries the create after a cancel failure — fails loudly.
- `usageCounters` are asserted unchanged across an upgrade, which is the
  "immediate effect" story's least visible half: the limit moves, the counter
  does not.
- **Red state at handoff (evidence).** With throwaway stubs at the four intended
  paths and a stub `cancelMandate` on both adapters (all deleted before handoff)
  `npx tsc -p apps/web/tsconfig.json --noEmit` exited `0`, and:
  - unit `plan-change.test.ts` — **7 failed | 10 passed (17)**, all assertion
    level (`expected 'same' to be 'upgrade'`, `expected a consequence for
"events.active", got []`). The ten passes are the negative pins the empty
    stub cannot fail;
  - integration `billing-plan-change.test.ts` — **24 failed (24)**, all assertion
    level (`expected 500 to be 201/422/403/404/400`, and for the port pin
    `expected null to match object { Object (subscription_id, action) }` because
    the stub never reached the wire).

  At handoff the specs are red as missing modules — `Cannot find package
'@/server/services/subscriptions/plan-change'`,
  `Cannot find package '@/app/api/v1/tenants/[tenantId]/billing/upgrade/route'`
  (and `downgrade`/`scheduled-change`) — plus the one honest `TS2339`
  (`Property 'cancelMandate' does not exist on type 'PaymentProvider'`), which is
  this lane's declared port extension. ESLint is clean on both new files (0
  problems) and `prettier --check` passes. The full unit project is otherwise
  green (112 files, 1935 passed / 3 skipped; the only failing file is this lane's
  new spec).

- **`docs/adr/README.md` is the known shared-ledger hotspot.** OP-110/OP-111 and
  every later lane draw from the same `unallocated (future lanes)` cell; if
  another lane lands first, the merge is a union resolution with this row kept at
  `0460` and the pool advancing to the next free value.

## Alternatives considered

- **A boolean `isUpgrade(current, target)`.** Rejected: `not_an_upgrade` covers
  `<=`, so the route would have to re-derive equality to distinguish "you are
  already there" from "that is a downgrade", and a two-value helper invites the
  `===`-only check the contract explicitly forbids.
- **Compute the consequences inside the route (in the handler, next to the
  reads).** Rejected: the destructive invariant and the two shapes would then be
  reachable only through Mongo + HTTP, which is precisely the surface the `U1`
  pins exist to avoid.
- **Cancel the old mandate _after_ creating the new one.** Rejected: two live
  mandates for one customer is the state the story is designed to prevent, and
  the `subscriptions_active_tenant_unique` partial index would reject the new
  row's insert while the old one is still live.
- **Apply the downgrade immediately.** Rejected: §3.3 is explicit ("take effect
  **at period end**, unlike upgrades"), and an immediate downgrade would strand
  already-created content above the new limits — the thing §10 forbids.
- **Return the `scheduledChange` from `GET /subscription` instead of a dedicated
  endpoint.** Rejected: the read already serves the block (ADR-0400/0401), and
  §3.3 gives the cancel its own `DELETE`.
- **Reuse `fetchStatus` (or a raw `manage` passthrough) instead of a named port
  method.** Rejected: a passthrough would leak the vendor's action vocabulary
  into the route, which ADR-0001/ADR-0380 forbid, and `fetchStatus` is a read.

## ADR number allocation

The `OP-109` lane had no reserved range on `main`, so — as the lane's first card
— it draws the next block from the allocator's `unallocated (future lanes)` pool:
**`0460`–`0479`**, consuming `0460` for this record (the move OP-102/OP-103/
OP-104/OP-105/OP-106/OP-107/OP-108 each made for their lane; ADR-0300 §7). Per
that policy a **dependent** ticket does not continue its parent's range: OP-108
holds `0440`–`0459`, so this lane takes the pool's next free block. The README
table gains an `OP-109 plan-change lane` row with `Next free = 0461`, the pool row
advances to `0480`+, and the ADR index gains this row. No number outside the
block is touched, and the frozen pre-policy numbers are left alone.
