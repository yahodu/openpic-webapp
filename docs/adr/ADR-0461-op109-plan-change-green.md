# ADR-0461 — OP-109 GREEN: the plan-change surface implemented — immediate upgrade, period-end downgrade and the scheduled-change cancel

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 GREEN (`t_4079f630`) · **Branch:** `wt/t_4079f630` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4079f630`
- **Relates to:** [ADR-0460](ADR-0460-op109-plan-change-red.md) (the RED contract this turns green), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout envelope, `BILLING_ERROR_CODES` shape and the mandate-customer rule the upgrade reuses), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the `PaymentProvider` port and the Cashfree adapter extended with `cancelMandate`), [ADR-0400](ADR-0400-op106-subscription-read-red.md) / [ADR-0401](ADR-0401-op106-subscription-read-green.md) (the `scheduledChange` the downgrade writes is the block that read serves), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) (the activation webhook that emits `billing.plan.upgraded`), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the `usageCounters` the consequence calculator reads), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (checkout, upgrade, downgrade, cancel), §0.5 (envelopes), §0.9 (idempotency), §0.15 (never-return) · **Schema:** §14.1 (plans), §14.2 (usage counters), §14.3 (subscriptions)

## Context

ADR-0460 fixed the executable contract for the OP-109 RED and named the GREEN
successor (`t_4079f630`) as the consumer of number `0461`. This record documents
the implementation that turns the two RED specs green — no test, mock, fixture
or factory is edited, and the pins ship byte-identical.

The RED's contract table is the authority. Where the RED left a parameter open
(the shape of the request/response schemas, the route's body handling) this
record fixes it, in the same spirit as ADR-0421.

## Decision

### Module contract, as delivered

| Module (specifier)                                                        | Exports                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/services/subscriptions/plan-change` (re-exported by the barrel) | `comparePlanTiers`, `computeDowngradeConsequences`, the `PlanChangeDirection` / `DowngradeConsequence` / `EntitlementUsageFact` / `DowngradeConsequencesInput` types, and the request/response schemas (`upgradeRequestSchema`, `upgradeEnvelopeSchema`, `downgradeRequestSchema`, `scheduledChangeSchema`, `downgradeResponseSchema`) |
| `@/server/services/subscriptions/catalogue`                               | `loadPlan`, `soldPrice`, `unsoldField`, `CONTACT_SALES_URL` — extracted from the OP-107 checkout route so the checkout and the upgrade refuse an unsellable plan identically                                                                                                                                                           |
| `@/server/services/subscriptions/mandate-customer`                        | `resolveMandateCustomer` — extracted from the OP-107 checkout route, unchanged in behaviour (`UNSET_CONTACT_PHONE`, `FALLBACK_CUSTOMER_NAME`, `PLATFORM_NO_REPLY_EMAIL`)                                                                                                                                                               |
| `@/app/api/v1/tenants/[tenantId]/billing/upgrade/route`                   | `POST`                                                                                                                                                                                                                                                                                                                                 |
| `@/app/api/v1/tenants/[tenantId]/billing/downgrade/route`                 | `POST`                                                                                                                                                                                                                                                                                                                                 |
| `@/app/api/v1/tenants/[tenantId]/billing/scheduled-change/route`          | `DELETE`                                                                                                                                                                                                                                                                                                                               |
| `@/server/payments/payment-provider`                                      | `cancelMandate(input: CancelMandateInput): Promise<CancelMandateResult>` (`CancelMandateInput = { ref: ProviderRef }`, `CancelMandateResult = { status: NormalizedStatus }`), implemented on **both** adapters                                                                                                                         |

The three routes are tenant-scoped on the **string** hex `tenantId` (the
OP-103/OP-104/OP-106/OP-107 convention), so every read/write goes through
`tenantRepo`.

### 1. The port gains `cancelMandate`, and the Cashfree adapter calls the pinned Manage endpoint

`createCashfreeProvider` gains `cancelMandate`, which validates a strict
`{ subscription_id, action: "CANCEL" }` body (`cashfreeManageSubscriptionRequestSchema`)
and calls `POST {base}/pg/subscriptions/{id}/manage` for the pinned
`x-api-version` (`2025-01-01`). The response is parsed with the existing
create-subscription response schema (the fixture is a documented superset of both
candidate shapes) and the `subscription_status` is normalized through the same
`normalizeWireStatus("cancelMandate", …)` path as `fetchStatus`, so `CANCELLED →
{status: "cancelled", mandateStatus: "revoked"}` — exactly what `I1c` asserts.
`memoryPaymentProvider.cancelMandate` returns that same terminal pair from a
stable constant, so the two adapters agree without a clock or state.

### 2. The upgrade is cancel-then-create at the vendor, and one DB transaction for the rows

The handler resolves the live row's plan and the target plan from the catalogue,
refuses `not_an_upgrade` for anything that is not strictly an upgrade (equal rank
included) **before** touching the provider, then calls `cancelMandate` and — only
on success — `createMandate`. The two `subscriptions` writes are one
`withTransaction`: the old row is `cancelled` (with `cancelledAt`, a non-null
`cancelReason`, `mandateStatus: "revoked"` and an appended `statusHistory` entry)
**before** the new `incomplete` row (carrying `previousSubscriptionId` and the
new vendor refs) is inserted, so the `subscriptions_active_tenant_unique`
partial index (`{cancelledAt: null}`) never sees two live rows. `usageCounters`
are never touched — an upgrade widens the limit the same counters are measured
against.

### 3. The upgrade request body is optional

The §3.3 body is `{ targetPlanKey, priceKey, returnUrl }`. The RED specs drive the
happy path, the replay, the cancel-failure and the equal-tier refusal **without a
body**, so a body-less upgrade targets the **highest active self-serve tier**
(resolved from the catalogue) with a `returnUrl` derived from the first allowed
origin; an explicit JSON body is validated through the shared `parseJsonBody`
(415/400/422 preserved) and honoured. This is a flag for the Test Author: the
§3.3 example body is never exercised by a no-body pin, so the default is
unpinned prose (see §Assumptions).

### 4. The owner gate runs before the idempotency stage

`I`'s ladder expects a `member`/`admin` to be `403` on the upgrade **without**
presenting an `Idempotency-Key`, and §0.9's stage runs before the handler. The
upgrade route therefore wraps the reusable `tenantStage()` in `ownerOnlyTenant()`
in the `tenant` slot — the last stage before `idempotency` — so the owner check
precedes the key requirement. The downgrade and scheduled-change routes (which
are not idempotent) keep the plain `tenantStage()` and enforce owner in the
handler.

### 5. The downgrade writes only `scheduledChange`

`POST …/downgrade` resolves the current plan's `tenant`-scoped, non-feature keys
from `usageCounters` at each key's own `periodKey(resetPeriod, clock.now())` (a
missing row is `0`), computes the consequences, and refuses `422
acknowledgement_required` with `details.consequences` until
`acknowledgeConsequences === true`. With the acknowledgement it writes
`scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason:
"self_downgrade" }` and leaves `status`/`activePlanKey` untouched. `DELETE
…/scheduled-change` clears `scheduledChange` and answers `204` with a genuinely
empty body (the pipeline's `isNoContentStatus` short-circuit).

### 6. Two codes appended to the catalogue

`not_an_upgrade` (`422`) and `acknowledgement_required` (`422`) are appended to
`packages/contracts`' `BILLING_ERROR_CODES` (and therefore to `API_ERROR_CODES`
and `AppErrorCode`) and to the `@/server/http/catalog` `BILLING_ERROR_TRANSPORT`
table in the ADR-0421 shape. The base `ERROR_CATALOG` is untouched.

## Assumptions and open questions

- **A body-less upgrade targets the highest active self-serve tier.** The RED
  specs never send a body on the happy path; §3.3 names `targetPlanKey` in the
  request. The delivered default is a general rule (the top self-serve tier), not
  a fixture constant, and is flagged for the Test Author to pin or forbid.
- **A delete with nothing scheduled is `204`.** ADR-0460 left this open; the
  route is idempotent, so an absent `scheduledChange` is still a `204`.
- **A create failure after a successful cancel is unpinned** (ADR-0460): the
  delivered behaviour answers `502 upstream_unavailable` and leaves the old row
  live, the same status a cancel failure returns.
- **An upgrade from the implicit free state is unpinned** (ADR-0460): the
  delivered behaviour is `409 conflict` (`reason: "no_live_subscription"`).
- **`billing.plan.upgraded` on activation is out of this card** (ADR-0460): it is
  a webhook-projection concern (OP-108/OP-111), not a route concern. The route
  emits the `billing.plan.upgrade_started` info log the card asks for.

## Consequences

- The lane's port extension is the single cancel seam for OP-110's
  `POST /billing/cancel`; its wire shape is pinned by `I1c`.
- The checkout route now imports its plan/customer seams from
  `@/server/services/subscriptions` instead of holding private copies; the
  `billing-checkout.test.ts` suite (52 tests over the checkout + Cashfree
  adapter specs) is green, so the extraction is behaviour-preserving.
- `usageCounters` are asserted unchanged across an upgrade, and the downgrade
  deliberately never resets them.

## Evidence

- The two RED specs are green **unedited**: unit `plan-change.test.ts` **17
  passed (17)**; integration `billing-plan-change.test.ts` **24 passed (24)**
  (`TMPDIR=/root/tmp-mongo`).
- Full suites: unit **112 files / 1952 passed | 3 skipped**; integration **82
  files / 638 passed**.
- `test:coverage` (unit + integration, thresholds enforced) exits `0`: **194
  files / 2590 passed | 3 skipped**, global statements `92.66 %`, branches
  `81.55 %`, functions `96.49 %`, lines `93.10 %`;
  `apps/web/src/server/services/subscriptions` at lines `98.52 %` / branches
  `95.53 %` (the `services/**` gate is 90 %).
- `tsc` clean on all three projects (`apps/web`, `@openpic/contracts`, root);
  ESLint 0 errors / 0 warnings on every touched path; `prettier --check .` clean.
- The diff is production code (the five new/edited modules, the two extractions,
  the port + both adapters, the two catalogue codes) plus this ADR and the README
  ledger cells. **No test, mock, fixture or factory is edited.**

## ADR number allocation

`0460` is consumed by the OP-109 RED ([ADR-0460](ADR-0460-op109-plan-change-red.md)),
so this record takes `0461` — the cell's value in the lane's `Next free` column
as written by the RED. The lane's `Next free` advances to `0462`; no number
outside the lane range `0460`–`0479` is touched.
