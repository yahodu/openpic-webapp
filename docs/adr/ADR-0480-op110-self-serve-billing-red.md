# ADR-0480 — OP-110 RED: the self-serve billing surface — retry charge, cancel, transactions, invoices and add-ons

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 RED (`t_c048178f`) · **Branch:** `wt/t_c048178f` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_c048178f`
- **Relates to:** [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout envelope, the `BILLING_ERROR_CODES` append and the insert-then-call shape the retry and the add-on purchase reuse), [ADR-0460](ADR-0460-op109-plan-change-red.md) / [ADR-0461](ADR-0461-op109-plan-change-green.md) (the shared `cancelMandate` seam §2 of this lane reuses, and the `ownerOnlyTenant()` gate placement §6 pins), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the webhook inbox and the projection the retry and add-on confirmations flow through), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the `entitlementGrants` row and the `effectiveLimit` arithmetic), [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the add-on catalogue schema of record), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (retry, cancel), §3.4 (transactions, invoices), §3.6 (add-ons), §0.5 (envelopes), §0.8 (cursor pagination), §0.9 (idempotency), §0.13 (data types), §0.15 (never-return) · **Schema:** §14.2 (counters + grants), §14.3 (subscriptions), §14.4 (billingTransactions) · **Appendix A.4** (the billing refusals)

## Context

OP-110 is the story that lets a tenant owner **manage billing self-serve**:
pay outstanding dues, cancel, read the billing history and buy a top-up. §3.3,
§3.4 and §3.6 name five endpoints:

```
POST   /api/v1/tenants/{tenantId}/billing/retry-charge        (user:complete, owner, Idempotency required)
→ 202 { "status": "charge_initiated", "billingTransactionId": "…", "pollUrl": "…" }
  409 no_pending_due            if pendingDueMinor == 0
  409 mandate_not_chargeable    if mandateStatus ∈ {revoked, expired}
                                details.recoveryAction: "recreate_mandate"

POST   /api/v1/tenants/{tenantId}/billing/cancel              (user:complete, owner)
{ "atPeriodEnd": true, "reason": "string?" }
→ 200 { "status": "active", "cancelAt": "<currentPeriodEnd>", "note": "…not deleted…" }

GET    /api/v1/tenants/{tenantId}/billing/transactions?cursor=&kind=   (user, owner|admin)
→ 200 { "data": [ … ], "page": { nextCursor, hasMore, limit } }        occurredAt desc

GET    /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}     (user, owner|admin)
→ 200 { "invoiceNumber", "downloadUrl", "expiresAt" }  |  404

POST   /api/v1/tenants/{tenantId}/billing/addons              (user:complete, owner, Idempotency required)
{ "addonKey": "storage-50gb", "quantity": 1, "returnUrl": "…" }
→ 201
```

Three sentences shape the design:

- **A retry is confirmed by a webhook, not by the response.** §3.3: "On success
  the subscription returns to `active` with `activePlanKey = subscribedPlanKey`,
  emitting `billing.subscription.reactivated` and `usage.limit.restored`."
- **A cancel is likewise webhook-confirmed.** §3.3: "`status` becomes
  `cancelled` only then." The route asks the provider and parks the intent.
- **The ledger is a never-return boundary.** §3.4: "**Clients and dunning copy
  branch on `category` only** — `failure.providerCode` is never exposed
  (schema §14.4)."
- **A grant is additive.** §3.6: "inserts an **additive** `entitlementGrants`
  row (`delta`, `source.kind: "purchase"`, `source.billingTransactionId`) —
  never a mutation of the plan (schema §14.2)."

The card pins only observable behaviour — `U1` the retry eligibility decision
table, `U2` the transaction DTO mapper, and `I1`–`I5` the endpoints against
MSW + MongoDB + the in-memory server. It does not pin module paths, the shape of
a one-time charge, how a webhook correlates to an add-on, or where the failure
codes live. The sibling GREEN card `t_81899e24` narrows the route list and the
status codes. This record fixes the rest.

## Decision

### Module contract

| Module (specifier)                                                         | Exports                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/server/services/subscriptions/retry-charge` (re-exported by the barrel) | `decideRetryEligibility(input): RetryEligibility`, the `RetryEligibility` / `RetryEligibilityInput` types and the §3.3 `202` response schema                                                                       |
| `@/server/services/subscriptions/transactions` (re-exported by the barrel) | `toTransactionDto(row): ServedTransaction`, the `StoredTransactionRow` / `ServedTransaction` types and the §3.4 page schema                                                                                        |
| `@/app/api/v1/tenants/[tenantId]/billing/retry-charge/route`               | `POST` — `userAuth()` + owner-gated `tenantStage()` + `idempotencyStage({ required: true })`; `202 { status, billingTransactionId, pollUrl }`                                                                      |
| `@/app/api/v1/tenants/[tenantId]/billing/cancel/route`                     | `POST` — `userAuth()` + owner-gated `tenantStage()`; `200 { status, cancelAt, note }`                                                                                                                              |
| `@/app/api/v1/tenants/[tenantId]/billing/transactions/route`               | `GET` — `userAuth()` + `tenantStage()`; owner\|admin; `{ data, page }`                                                                                                                                             |
| `@/app/api/v1/tenants/[tenantId]/billing/invoices/[invoiceNumber]/route`   | `GET` — `userAuth()` + `tenantStage()`; owner\|admin; `200 { invoiceNumber, downloadUrl, expiresAt }` or `404`                                                                                                     |
| `@/app/api/v1/tenants/[tenantId]/billing/addons/route`                     | `POST` — `userAuth()` + owner-gated `tenantStage()` + `idempotencyStage({ required: true })`; `201`                                                                                                                |
| `@/server/billing/webhook-projection` (extended)                           | the applier additionally settles a **pending one-time charge** correlated by the event's `payment` ref, writes the add-on's `entitlementGrants` row and emits `billing.addon.purchased` (+ `usage.limit.restored`) |

The routes are tenant-scoped on the **string** hex `tenantId` (the
OP-103/104/106/107/109 convention for `subscriptions` / `billingTransactions` /
`entitlementGrants` rows), so a seeded fixture writes `tenantId.toHexString()`.

### 1. `decideRetryEligibility` is pure, and "nothing due" outranks "unchargeable"

§3.3 names exactly two refusals, and the amount owed is the only other input
the decision reads. A boolean pair of guards inside the route would hide the
precedence, so the decision is one pure function over
`{ status, mandateStatus, pendingDueMinor }`:

| State                                                 | Verdict                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pendingDueMinor <= 0` (whatever the mandate)         | `{ allowed: false, reason: "no_pending_due" }`                                             |
| `mandateStatus ∈ {revoked, expired}` and money is due | `{ allowed: false, reason: "mandate_not_chargeable", recoveryAction: "recreate_mandate" }` |
| otherwise                                             | `{ allowed: true }`                                                                        |

`no_pending_due` is checked **first**: a workspace with nothing owed is told
exactly that, and is not sent through a re-authorization it does not need.
`paused` is deliberately **allowed** — §3.3's unchargeable set is exactly
`{revoked, expired}` and the contract names no third state; refusing a paused
mandate would be a product decision, not a reading of this contract (flagged
below).

### 2. `toTransactionDto` is a never-return boundary, not a field pick

§14.4 stores a `failure` block of `{code, message, providerCode, category,
retryable}`; §3.4 serves `{category, message, retryable}` and nothing else. The
projection therefore builds the served object rather than spreading the stored
one, so a vendor code cannot ride along under a renamed key. A stored failure
with **no** category is served as `failure: null` — there is nothing for a
client to branch on, and serving a category-less block would let an untyped
object reach the wire. The `failure.category`/`retryable` policy is the
implementation's (the served `message` is copy), so only the key set, the
category echo and the boolean are pinned.

### 3. A one-time charge is a **pending ledger row written before the provider call**

Both the retry and the add-on purchase are one-time charges confirmed by a
webhook, so both need the same correlation key: the §14.4 ledger row. The
`202`'s `billingTransactionId` names it, and it carries the provider
`externalRefs` the confirmation event will match on. That is the OP-107
insert-then-call shape applied to the ledger, and it is what lets the projection
find the intent when the confirmation arrives.

### 4. An add-on snapshots its grant on the intent, and the catalogue gains `grantDelta`

§3.6 says the webhook "inserts an **additive** `entitlementGrants` row (`delta`,
`source.kind: "purchase"`, `source.billingTransactionId`)". For the projection
to write that row without re-reading a catalogue that may have changed since the
purchase, the **purchase snapshots its grant on the pending ledger row** under
an `addon` block:

```ts
{
  (addonKey, entitlementKey, delta, quantity);
}
```

`delta` is `quantity × addon.grantDelta`. ADR-0320's add-on schema of record
names the entitlement (`entitlementKey`), the unit and the orderable quantity
bounds but **carries no amount**, so the contract's own worked example (a
`storage-50gb` grant of `53687091200` bytes) is not expressible from it. This
lane therefore extends that schema of record with one field:

| Field        | Type   | Meaning                                                                                                              |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `grantDelta` | number | The entitlement delta one ordered `quantity` unit grants, in the entitlement's own unit (bytes for `storage.bytes`). |

The purchase grants `quantity × grantDelta`; a purchase snapshots the product so
a later catalogue edit cannot change what an in-flight purchase grants.

### 5. A retry success from `past_due` emits the restored events

The projection already emits `billing.subscription.reactivated` +
`usage.limit.restored` when a `payment_succeeded` reactivates a `downgraded`
row. §3.3's retry sentence applies the same pair to a retry from **`past_due`**,
so the rule the applier implements is "a `payment_succeeded` that returns a
non-active row to `active` emits the restored pair" — the retry's own status is
not otherwise distinguishable at the webhook, and inventing a second seam to
tell them apart would put a vendor-shaped marker on the row. `I3` drives the
`past_due` case, which is the one that is red on the current trunk.

### 6. The owner gate folds into the `tenant` stage slot

§0.9's idempotency stage runs **before** the handler, so a `member`/`admin` must
be `403 forbidden` rather than `400 idempotency_key_required`. The retry and the
add-on routes therefore reuse OP-109's `ownerOnlyTenant()` (the tenant stage
with the owner check appended) — `cancel` needs it too, and the two reads
(`transactions`, `invoices`) keep the §3.4 `owner|admin` gate in the handler.

### 7. Two error codes are appended to the catalogue

`no_pending_due` (`409`) and `mandate_not_chargeable` (`409`,
`{ mandateStatus, recoveryAction, checkoutUrl? }`) are Appendix A.4 rows the
server catalogue does not carry yet. The GREEN owes them in the
`BILLING_ERROR_CODES` shape OP-107/OP-109 established: appended to
`packages/contracts`' `BILLING_ERROR_CODES` and to the `@/server/http/catalog`
`BILLING_ERROR_TRANSPORT` table, never into the base `ERROR_CATALOG` the
HTTP-pipeline story pins exactly.

## Assumptions and open questions

- **The retry's `details.checkoutUrl` is not pinned.** Appendix A.4 lists it on
  `mandate_not_chargeable`, but §3.3 only says "the client is directed to
  checkout"; `I2` pins `recoveryAction` and `mandateStatus` and leaves the URL
  optional.
- **The add-on `201` body is not pinned.** §3.6 says "checkout envelope as
  §3.3", yet the same sentence describes a one-time `chargeOnce`, which returns
  no hosted URL — the two halves cannot both hold literally. The pending-ledger
  contract is pinned instead; the response shape is an open question for the
  GREEN.
- **`paused` is chargeable.** §3.3's unchargeable set is exactly
  `{revoked, expired}`. A product decision to refuse a paused mandate is a new
  RED.
- **Invoice PDF generation is out of scope** (the GREEN card's own open
  question), so only the no-asset `404` and the read's role gate are pinned; the
  `200` signed-URL path and the stored asset's home are unpinned.
- **`atPeriodEnd: false` is not pinned.** §3.3 shows only `true`; an immediate
  cancel is an unpinned case.
- **The ledger's `kind` enum is wider than §14.4's projection writes.**
  `chargeback` / `credit` / `adjustment` rows exist in the schema but no route
  in this lane writes one, so only `charge` and `refund` are exercised.
- **The pending-charge settle semantics are not pinned.** Whether the projection
  mutates the pending row to `succeeded` or inserts its own receipt row is left
  to the GREEN; `I5` asserts the grant, the emitted keys and the effective limit,
  not the ledger's row count.
- **The invoice number's sequence** (tenant-scoped, gapless) is a §14.4 field
  this lane does not mint.

## Consequences

- The retry's refusal precedence is a **property of one pure function**, so the
  `409 no_pending_due` / `409 mandate_not_chargeable` split cannot drift between
  the route and its documentation.
- The ledger projection is a **never-return boundary**, enforced once at
  `toTransactionDto` and re-asserted at the wire by the shared scanner — the
  §0.15 rule is pinned where it can actually break (the mapper), not only where
  it is visible (the response).
- The add-on purchase is **snapshotted**, so a catalogue edit between purchase
  and confirmation cannot change the grant a user already paid for.
- `I3` is the one case that drives a **behaviour change** on the current trunk:
  a `payment_succeeded` on a `past_due` row must emit
  `billing.subscription.reactivated` + `usage.limit.restored`, which the shipped
  reducer emits only for `downgraded`. OP-108's own pins seed an **active** row
  for their `payment_succeeded` case, so nothing shipped is contradicted.
- **Red state at handoff (evidence).** With throwaway stubs at the seven
  intended paths (all deleted before handoff)
  `npx tsc -p apps/web/tsconfig.json --noEmit` exited `0`, and:
  - unit `retry-charge.test.ts` — **8 failed | 4 passed (12)** and
    `billing-transactions.test.ts` — **5 failed | 4 passed (9)**, all assertion
    level (`expected { allowed: true } to deeply equal { allowed: false, … }`,
    `expected [] to deeply equal [ 'category', 'message', 'retryable' ]`,
    `expected 'stub' to be '<hex>'`). The passes are the negative pins an empty
    stub cannot fail;
  - integration `billing-self-serve.test.ts` — **34 failed (34)**, all assertion
    level (`expected 500 to be 409/202/200/201/422/400/401/403/404`).
    At handoff the specs are red as missing modules — `Cannot find package
'@/server/services/subscriptions/retry-charge'`,
    `…/transactions`, and the five route modules.

- **`docs/adr/README.md` is the known shared-ledger hotspot.** OP-111 and every
  later lane draw from the same `unallocated (future lanes)` cell; if another
  lane lands first, the merge is a union resolution with this row kept at `0480`
  and the pool advancing to the next free value.

## Alternatives considered

- **A boolean `canRetry(status, mandateStatus, due)` in the route.** Rejected:
  the two refusals carry different `details`, and the precedence between them is
  exactly the sort of decision that drifts when it lives inline.
- **Serve the stored `failure` block and delete `providerCode` in the route.**
  Rejected: `delete` is one forgotten key away from a leak, and the shared
  scanner cannot see a field the mapper never stripped. The mapper builds the
  served object.
- **Have the webhook projection re-read the add-on catalogue for the delta.**
  Rejected: a catalogue edit between purchase and confirmation would change what
  an already-paid purchase grants. The purchase snapshots the delta.
- **Derive the add-on delta from `unit` (e.g. `GB` → 1 GiB).** Rejected: it
  makes the amount a magic convention, cannot express the contract's own
  `storage-50gb` example (which grants 50 GiB), and has no meaning for
  `events.active`.
- **Tell a retry apart from a renewal with a vendor-shaped marker on the
  subscription row.** Rejected: ADR-0001/ADR-0380 keep vendor vocabulary inside
  the adapter, and "a payment that unblocks a blocked row restored the limits"
  is true for both.
- **Pin invoices' `200` signed-URL path.** Rejected as premature: the stored
  asset's home is not defined anywhere, and the GREEN card marks it an open
  question. A `404` pin is honest; a guessed asset schema is not.
- **Put the owner gate in the handler (the checkout route's shape).** Rejected
  for the idempotent mutations: §0.9's stage runs first, so the handler would
  answer `400` where §3.3 requires `403`.

## ADR number allocation

The `OP-110` lane had no reserved range on `main`, so — as the lane's first card
— it draws the next block from the allocator's `unallocated (future lanes)`
pool: **`0480`–`0499`**, consuming `0480` for this record (the move
OP-102…OP-109 each made for their lane; ADR-0300 §7). Per that policy a
**dependent** ticket does not continue its parent's range: OP-109 holds
`0460`–`0479`, so this lane takes the pool's next free block. The README table
gains an `OP-110 self-serve billing lane` row with `Next free = 0481`, the pool
row advances to `0500`+, and the ADR index gains this row. No number outside the
block is touched, and the frozen pre-policy numbers are left alone.
