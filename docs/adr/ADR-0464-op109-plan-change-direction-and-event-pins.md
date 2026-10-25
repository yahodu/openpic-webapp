# ADR-0464 — OP-109 follow-up TEST: the upgrade's `billing.plan.upgraded` emit, the downgrade direction guard and the Cashfree manage-response shape

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 follow-up TEST (`t_78d4ebb7`) · **Branch:** `OP-109-task-plan-change-direction-and-event-red` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4079f630`
- **Relates to:** [ADR-0460](ADR-0460-op109-plan-change-red.md) (the RED contract for this surface), [ADR-0461](ADR-0461-op109-plan-change-green.md) (the shipped implementation), [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) (§3 already pins the missing-`currentPeriodEnd` fallback this card re-affirms), [ADR-0421](ADR-0421-op107-checkout-green.md) (the append-a-`BILLING_*`-code precedent), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md)/[ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the adapter's wire-schema boundary)
- **Contract:** §3.3 (upgrade/downgrade), §7.7 (domain events), §10.1.1/§10.1.2 (the vendor vocabulary) · **Schema:** §14.3 (subscriptions), §18.3 (domain_events) · **Design:** §4 (the `billing.plan.upgraded` notification row)

## Context

Round-1 review of the merged OP-109 GREEN (`20fa9a5`, PR #334) confirmed three
gaps that the lane's pins do not yet close:

- **F1** — §3.3 says an upgrade **"Emits `billing.plan.upgraded` on success"** (`docs/API Contract.md:1115`), but the merged route only writes an info
  log (`event: "billing.plan.upgrade_started"`). The outbox is untouched, so
  the type that design §4 routes to in-app + email + (no mobile) never fires.
- **F2** — `POST …/billing/downgrade` never compares tiers. Probed on `20fa9a5`:
  from a live `starter` row, `{ "targetPlanKey": "professional",
"acknowledgeConsequences": true }` answered **`200`** and wrote
  `scheduledChange.toPlanKey = "professional"` — an _upgrade_ booked through the
  downgrade endpoint, whose mirror (`not_an_upgrade`, `422`) already guards the
  other direction.
- **F4** — `cancelMandate` (`cashfree-provider.ts`, the `cancelMandate` branch)
  parses the vendor's Manage response with
  `cashfreeCreateSubscriptionResponseSchema`, i.e. the **Create** response
  schema, which requires `auth_link`. Verified against Cashfree's own
  v2025-01-01 reference: the Manage response is the `SubscriptionEntity`
  (the subscription object) and carries **no** `auth_link`. The adapter only
  survives today because the shared fixture `makeManageResponse` is a
  documented superset of the create and status shapes — a trust assumption no
  real vendor body is obliged to satisfy.

**F5** (a downgrade on a live row with no `currentPeriodEnd`) was already pinned
and its open question already filed by [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md)
§3 (`billing-plan-change.test.ts`, `it("F5: a live row with no currentPeriodEnd
schedules the change at now, not at period end")`). This card **adds no
duplicate pin**; §5 below re-affirms the contradiction for the product owner and
records that the pin is unchanged.

## Decision

### 1. The upgrade emits a tenant-scoped `billing.plan.upgraded` domain event

`POST …/billing/upgrade` (`201`) must write **one** `domain_events` row per
policy change through `emitDomainEvent`:

| Field      | Pinned value                                                          |
| ---------- | --------------------------------------------------------------------- |
| `eventKey` | `"billing.plan.upgraded"` (a registered `NOTIFICATION_TYPE_KEYS` row) |
| `tenantId` | the workspace's string hex id — tenant scope, never global            |
| `payload`  | `{ fromPlanKey: <current plan key>, toPlanKey: <target plan key> }`   |

`payload.fromPlanKey`/`payload.toPlanKey` are the same names the route's own
existing log line already uses (`billing plan upgraded`), and they are the
"plan-change subject" §3.3 promises; no internal row field (`_id`,
`previousSubscriptionId`, `externalRefs`) is asserted, so a refactor of the
storage shape cannot break the pin.

The emit must be **part of the request**, not deferred: the pin reads the outbox
when the handler's promise resolves, exactly as `webhook-projection.ts` emits
inside its transaction. (Emitting via `after()` would leave the observable
absent at response time and is therefore not a valid implementation of this
pin.)

An `Idempotency-Key` replay answers `200 idempotency-replayed: true` and emits
**no second** event: one policy change, one event.

### 2. A downgrade target that is not strictly lower is `422 not_a_downgrade`

The symmetric mirror of `I2`'s `not_an_upgrade`. Chosen deliberately over the
alternatives:

- **`422 not_a_downgrade`** _(adopted)_ — appended to the closed
  `BILLING_ERROR_CODES` set and `BILLING_ERROR_TRANSPORT` in the ADR-0421 shape
  (the way OP-107 appended its codes), with `details: { currentTierRank,
targetTierRank }` naming **both** rank values. It is the exact mirror of the
  existing `not_an_upgrade` refusal, so a client that already handles one
  direction handles both, and the failure names the endpoint that _can_ serve
  the request.
- `not_an_upgrade` for both directions — rejected: the code reads as "go to the
  downgrade endpoint", which is the wrong instruction for a target that is
  _higher_.
- `validation_failed` — rejected: it carries `details.fields[]` (a request-shape
  error) and would tell the client nothing about tier direction.

The pin asserts the refusal (status + `code` + both ranks), that **nothing is
written** (`scheduledChange` stays `null`; `status`/`activePlanKey` unchanged)
and that the provider is never called. `I3`/`I4` (the `free` target, a genuine
downgrade) are untouched.

### 3. The Manage response is parsed on its own terms, and a create-shaped body is refused

The v2025-01-01 `POST /pg/subscriptions/{subscription_id}/manage` response is
Cashfree's `SubscriptionEntity`. Fields verified on the vendor's own v2025-01-01
reference (the `/subscription/mandate/manage` page, response schema
`SubscriptionEntity`; the request is `{ subscription_id, action }`):

```
authorisation_details, cf_subscription_id, customer_details, next_schedule_date,
plan_details, subscription_expiry_time, subscription_first_charge_time,
subscription_id, subscription_meta, subscription_note,
subscription_session_id, subscription_payment_splits, subscription_status,
subscription_tags
```

The fields the adapter **reads** and therefore must require are
`subscription_id`, `cf_subscription_id`, `subscription_status` and — the ones
that separate a Manage response from the Create response —
`subscription_first_charge_time` (nullable: the vendor's own example sends `""`
for a plan with no first-charge date) and `next_schedule_date` (nullable: `null`
for `ON_DEMAND` plans). `subscription_expiry_time` is present on the entity too.

The **negative direction** is pinned as an explicit refusal: a body carrying
only the Create shape (`auth_link` + `subscription_expiry_time`, and **neither**
`subscription_first_charge_time` nor `next_schedule_date`) is not a Manage
response, so `cancelMandate` must raise `UpstreamContractError` — and log
`payments.upstream_contract_violation` with `operation: "cancelMandate"` —
rather than read a status off a shape the vendor never promised for that call.

The minimal GREEN is to parse the Manage response with a schema whose required
field set is the one above: **reusing the existing
`cashfreeSubscriptionStatusResponseSchema` satisfies both pins** (it requires
exactly `subscription_id`, `cf_subscription_id`, `subscription_status`,
`subscription_expiry_time`, `subscription_first_charge_time`,
`next_schedule_date`), so no new schema file is strictly needed — the card's
"newly documented dedicated schema" and the reuse are behaviourally identical
here, and the pins admit both.

Both F4 pins are **RED** on the merge trunk (`red.txt` in the card handoff):
F4-a fails because the create schema rejects a body with no `auth_link`
(`Invalid input: expected string, received undefined: auth_link`); F4-b fails
`promise resolved "…" instead of rejecting`, i.e. the create-shaped body is
silently trusted today.

### 4. What this card does **not** change

Test-only: no production module, schema, index, fixture or factory is touched.
The pins are RED-by-design and are the executable contract GREEN card B
(`t_f5df9fe6`) turns green; a GREEN that satisfies them must not weaken them.

### 5. F5 re-affirmed: the missing-`currentPeriodEnd` fallback still contradicts §3.3

`downgrade/route.ts` falls back to `effectiveAt = now` when the live row carries
no `currentPeriodEnd`. §3.3 says a self-serve downgrade "take[s] effect **at
period end**", which exists so already-created content is never stranded above
the new limits; scheduling the change at `now` does the opposite. The shipped
pin (ADR-0462 §3) characterises the behaviour inside a real-clock `[before,
after]` bracket and is **unchanged by this card**. The product owner still owes
a decision: refuse (`409`/`422` naming the missing period) or schedule at `now`
consciously. Until then the fallback stays a named, mutation-proven pin rather
than a silent behaviour.

## Consequences

- GREEN card B (`t_f5df9fe6`) must: emit `billing.plan.upgraded` once per
  upgrade (deduped on replay); add `not_a_downgrade` (`422`) to
  `BILLING_ERROR_CODES` + `BILLING_ERROR_TRANSPORT` and refuse a non-strictly-lower
  downgrade target before any write; parse the Manage response with a schema that
  requires the Manage fields (the status schema already does) and refuse the
  create-only shape.
- The three behaviours are pinned where a future refactor breaks them loudly:
  the missing emit prints `expected [] to have a length of 1 but got +0`; the
  unguarded downgrade prints `expected 200 to be 422`; the inherited create
  schema prints `expected string, received undefined: auth_link`.
- RED evidence on the trunk `1764700` (the OP-109 follow-up squash on top of
  `20fa9a5`), measured not copied: `billing-plan-change.test.ts` +
  `payments-cashfree-adapter.test.ts` → **6 failed | 31 passed (37)**, the six
  being exactly the two F1, two F2 and two F4 pins.
- **Number allocation.** The lane's cell read `0464` in `docs/adr/README.md` at
  the branch cut (immediately before committing), so this record takes `0464`
  and advances `OP-109 plan-change lane` to `0465`. No number outside
  `0460`–`0479` is touched, and no other lane's row is renumbered.
