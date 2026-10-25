# ADR-0481 — OP-110 GREEN: the self-serve billing surface implemented — retry charge, cancel, transactions, invoices and add-ons

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 GREEN (`t_81899e24`) · **Branch:** `OP-110-task-self-serve-billing-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_81899e24`
- **Relates to:** [ADR-0480](ADR-0480-op110-self-serve-billing-red.md) (the RED contract this GREEN implements), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the `BILLING_ERROR_CODES` append shape and the insert-then-call order), [ADR-0460](ADR-0460-op109-plan-change-red.md) / [ADR-0461](ADR-0461-op109-plan-change-green.md) (`cancelMandate`, the `ownerOnlyTenant()` gate placement), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0441](ADR-0441-op108-webhook-inbox-green.md) / [ADR-0443](ADR-0443-op108-concurrent-projection-ordering-green.md) (the webhook inbox and the projection this lane extends), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (`entitlementGrants` + the `effectiveLimit` arithmetic), [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the add-on schema of record), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (retry, cancel), §3.4 (transactions, invoices), §3.6 (add-ons), §0.5, §0.8, §0.9, §0.13, §0.15 · **Schema:** §14.2, §14.3, §14.4 · **Appendix A.4**

## Context

OP-110's RED (ADR-0480) pinned the observable behaviour of five endpoints and two
pure functions and named no module paths, no one-time-charge shape and no
webhook correlation key. This record fixes those and reports what the
implementation actually does.

The lane's specs are:

| Spec                                                       | Tests | Content                                                                                     |
| ---------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/test/unit/retry-charge.test.ts`              | 12    | `decideRetryEligibility` decision table                                                     |
| `apps/web/src/test/unit/billing-transactions.test.ts`      | 9     | `toTransactionDto` — the §3.4 never-return boundary and the §0.13 conversions               |
| `apps/web/src/test/integration/billing-self-serve.test.ts` | 34    | I1–I5, the owner/role ladder, the idempotency receipts, the cancel rule and the invoice 404 |

## Decision

### 1. Module contract (as implemented)

| Module                                                                                                                           | Exports                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@/server/services/subscriptions/retry-charge` (barrel-re-exported)                                                              | `decideRetryEligibility`, `RetryEligibility`, `RetryEligibilityInput`, `retryChargeResponseSchema`                        |
| `@/server/services/subscriptions/transactions` (barrel-re-exported)                                                              | `toTransactionDto`, `StoredTransactionRow`, `ServedTransaction`, `transactionPageSchema`                                  |
| `@/server/billing/one-time-charge`                                                                                               | `providerRefSchema`/`providerRefsSchema`, `providerRefOf`, `insertPendingCharge`, `failPendingCharge`, `recordChargeRefs` |
| `@/server/billing/webhook-projection` (extended)                                                                                 | the applier settles a pending one-time-charge intent and writes the add-on's grant                                        |
| `@/server/tenancy/route-stage` (extended)                                                                                        | `ownerOnlyTenant()` — OP-109's gate lifted into the shared stage module                                                   |
| `apps/web/src/app/api/v1/tenants/[tenantId]/billing/{retry-charge,cancel,transactions,invoices/[invoiceNumber],addons}/route.ts` | `POST` / `POST` / `GET` / `GET` / `POST`                                                                                  |

`ownerOnlyTenant()` was factored out of OP-109's `upgrade/route.ts` (verbatim
behaviour) so this lane's `cancel`, `retry-charge` and `addons` reuse one gate
rather than three copies of it; the upgrade route now imports it.

### 2. `toTransactionDto` builds the served item; `transactionPageSchema` serves the page

The mapper reads a narrow `StoredTransactionRow` (the fields §3.4 serves) and
**builds** the served object, so no `delete` stands between the vendor code and
the wire. A stored failure with no `category` is served `null`; a stored failure
with no `message` is served the generic dunning copy, because §3.4 pins a
non-empty string and nothing more.

The route keysets on `(occurredAt, _id)` **with both halves revived to their
stored BSON types** — the shared `paginateByCursor` helper passes a cursor's
`i` through as the string it decoded to, which never compares equal to an
ObjectId, so this route builds the compound filter itself and rejects a
non-hex tiebreaker as `400 invalid_cursor` rather than letting the driver throw.

### 3. A one-time charge is a pending ledger intent, written before the provider call

Both the retry and the add-on purchase write a `billingTransactions` row at
`status: "pending"` **before** `chargeOnce` and stamp the returned provider refs
onto it afterwards (`@/server/billing/one-time-charge`) — the OP-107
insert-then-call order applied to the ledger. A charge the provider refuses parks
the intent at `failed` (never dangling), and the route answers `502
upstream_unavailable`.

The two mutations answer `202 {status: "charge_initiated", billingTransactionId,
pollUrl}` and `201 {…}` respectively; `pollUrl` names the workspace's
`GET …/billing/transactions` list because §3.4 pins no single-transaction read.

### 4. An add-on snapshots its grant; the projection settles it by the payment ref

The pending row carries `addon: {addonKey, entitlementKey, delta, quantity}` with
`delta = quantity × addon.grantDelta`, and `storedAddonSchema` gains the
`grantDelta` field ADR-0320 left unnamed.

The applier extends the OP-108 flow with a second, **independent** correlation:
for a `payment_succeeded` it looks up the pending intent whose `externalRefs`
carry the event's payment ref (provider + env + `kind: "payment"` + id). When an
intent matches — with or without a subscription match — the confirmation
**settles that row** (`succeeded`, `settledAt`, `rawPayloadRef`) instead of
inserting a second ledger row for the same money movement, and, for an add-on,
inserts the **additive** `entitlementGrants` row
(`{tenantId, entitlementKey, delta, overrideLimit: null, source: {kind:
"purchase", billingTransactionId}, validFrom: now, validUntil: null}`) and emits
`billing.addon.purchased` plus `usage.limit.restored` **when the grant clears a
block** (the workspace was over the plan limit before the grant and is inside
the topped-up one after; an uncapped or ungated key has no block to clear). The
whole settlement runs inside the projection's transaction (§23), so money and
access still move together.

The intent's `tenantId` gets the tenant-scoped rows and events, so no code had to
guess a tenant, and the grant is an additive row — the plan document is never
touched (§14.2).

### 5. `payment_succeeded` reactivates any non-active row

The reducer's reactivation rule widens from `status === "downgraded"` to
`status !== "active"`, which is what makes §3.3's retry-from-`past_due` emit
`billing.subscription.reactivated` + `usage.limit.restored` (ADR-0480 §5). OP-108's
own `payment_succeeded` pins seed an **active** row, so no shipped assertion
changes; the full OP-108 suites (unit + integration) are green unedited.

### 6. The owner gate stays in the `tenant` stage slot

`retry-charge`, `cancel` and `addons` use `ownerOnlyTenant()`; `transactions` and
`invoices` use the plain `tenantStage()` and check `owner|admin` in the handler.
That is what makes a `member`/`admin` `403 forbidden` on the idempotent
mutations — §0.9's idempotency stage would otherwise answer `400
idempotency_key_required` — and a non-member the uniform `404`.

### 7. The two refusals are appended, never inserted into the base catalogue

`no_pending_due` and `mandate_not_chargeable` (both `409`) were appended to
`packages/contracts`' `BILLING_ERROR_CODES` and to `@/server/http/catalog`'s
`BILLING_ERROR_TRANSPORT`; `ERROR_CATALOG` is untouched, so Appendix A stays the
exact table the HTTP-pipeline story pinned (ADR-0421's shape).

### 8. Invoices: the `404` is pinned, the asset's home is not

The route looks up a workspace-scoped `mediaAssets` document carrying the
invoice number and answers `404 not_found` when none exists (the pinned case).
Invoice PDF generation and the stored asset's home remain this lane's open
question (the GREEN card says so), so the found-path serves the asset's stored
`url` with a 15-minute `expiresAt` — recorded below as an assumption rather than
guessed into a pin.

## 9. The three mutation routes log their lifecycle line

`retry-charge`, `cancel` and `addons` each emit one `info` line on the success
path (`billing.retry_charge.initiated`, `billing.subscription.cancel_requested`,
`billing.addon.purchase_initiated`) carrying `event` + `tenantId` +
`subscriptionId` (+ the new row's id) and no redacted value. Every sibling
billing mutation on the trunk already does this — `checkout` (…checkout created),
`downgrade` (…plan downgrade scheduled) and `upgrade` (…plan upgraded) — so this
is the same §5.2 line, not a new contract; nothing asserts it, and the codes stay
`ERROR_CATALOG`-free.

## Dispute — I3 could not address the seeded subscription (resolved test-side)

`billing-self-serve.test.ts` › _I3: a retry success returns the workspace to
active and emits the restored events_ is **left red**, and no honest
implementation can turn it green. The fixture builds its webhook body as

```ts
paymentSucceededBody(VENDOR_PAYMENT_ID);
// → makeCashfreeWebhookBody("SUBSCRIPTION_PAYMENT_SUCCESS", {
//      subscriptionDetails: { subscription_status: "ACTIVE" }, … })
```

which leaves the factory's default `subscription_details.subscription_id`
(`"sub_test_001"`) in place, while the workspace it seeds carries
`SUBSCRIPTION_REF.id === VENDOR_SUBSCRIPTION_ID === "sub_op110_001"`. I verified
the parsed event with a throwaway probe: the refs are
`[{kind: "subscription", id: "sub_test_001"}, {kind: "payment", id: "49914527"}]`.

§11.1 makes the tagged provider ref the _identity_ of the subscription a webhook
addresses, and I3 sends no prior `retry-charge` call, so there is no pending
intent to correlate either: the event matches no subscription and no intent, and
the projection correctly reports `no_subscription_match`. Every other route in
the suite uses `VENDOR_SUBSCRIPTION_ID` (the charge mock asserts the vendor call
is addressed to `sub_op110_001`), so the mismatch is local to this fixture.

The one-line fix belonged to the Test Author: override the subscription id in the
body the suite drives (`subscriptionDetails: {subscription_id:
VENDOR_SUBSCRIPTION_ID, subscription_status: "ACTIVE"}`) — or seed the
subscription with the factory's own `sub_test_001`. Either makes I3 green with no
production change at all. A child card is routed for it; this GREEN does not edit
the spec.

### Resolution — Test Author, card `t_2c3d158b` (same branch, same PR)

The reviewer upheld the dispute and reproduced the failure independently at
`922e8b3`; the correction is **test-side only**, the assertion is untouched, and
**no production file, factory, mock or other spec was edited** (`git status
--short` shows the one spec). The fix keeps the helper's payload for the other
call sites byte-identical, which is why it is the third-parameter form rather
than flipping the shared default (see below).

- `paymentSucceededBody(paymentId, eventTime?, subscriptionId = "sub_test_001")`
  now names `subscription_details.subscription_id`, defaulting to the factory's
  own value.
- I3 alone passes the seeded id:
  `paymentSucceededBody(VENDOR_PAYMENT_ID, undefined, VENDOR_SUBSCRIPTION_ID)`.
- The two I5 add-on call sites (`…/addons` grant and the `usage.limit.restored`
  unblock case) keep the default, so their body stays byte-identical and they
  keep correlating on the **payment** ref alone. Flipping the shared default
  would have silently moved them onto the subscription-match path and stopped
  covering the "an intent settles with no subscription match" branch.

Evidence — before, at the GREEN head `922e8b3` (`-t "I3:"`):
`AssertionError: expected { …(26) } to match object { status: 'active', …(2) }`
with `"pendingDueMinor": 49900, "status": "past_due"` received. After, at the fix
head: focused spec **34 passed (34)**; full integration **83 files / 673 passed
(673)**; full unit **114 files / 1976 passed | 3 skipped (1979)** — i.e. the fix
moves exactly the one previously-red case and nothing else;
`provider-webhook-inbox.test.ts` + `addons-endpoint.test.ts` **2 files / 25 passed
(25)**, proving OP-108's own `payment_succeeded` pins and I5 are unaffected;
`tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint `0` problems;
`prettier --check` clean.

This is a pure fixture correction: it fixes no contract and consumes **no** ADR
number — the lane's `Next free` cell is unchanged at `0482` and the shared
`docs/adr/README.md` ledger is deliberately not touched.

## Assumptions and open questions

- **The add-on `201` body** is unpinned; it carries
  `{status, billingTransactionId, addonKey, quantity, amountMinor, currency}`
  with a `Location` naming the ledger list.
- **`pollUrl`** names the workspace's `GET …/billing/transactions` list, since no
  single-transaction read route exists.
- **The invoice asset's home and signing scheme** are unpinned (see §8); the
  route reads `mediaAssets` and serves a stored `url`.
- **A failed confirmation settles nothing.** Only a `payment_succeeded` settles
  an intent; a `payment_failed` for a one-time charge is not pinned, so the
  intent stays `pending` and the sweep/dunning story (OP-111) owns it.
- **`atPeriodEnd: false`** sets `cancelAt = now` (an immediate cancel is not
  pinned by §3.3 or the RED).
- **The retry's `details.checkoutUrl`** is still not served; `recoveryAction` is
  what I2 pins and what the client branches on.
- **The add-on catalogue's `grantDelta`** is now required by
  `storedAddonSchema`; every seed in the repo already carries it through
  `makeAddon`.
- **`kind` on the transactions list** is passed through as given — the §14.4
  enum is wider than the kinds this lane writes.

## Consequences

- The retry's refusal precedence is one pure function, so the two `409`s cannot
  drift between the route and its documentation.
- The ledger's never-return rule is enforced once at `toTransactionDto` (where a
  vendor code could actually leak) and re-asserted at the wire by the shared
  scanner — on a non-empty page, so the scan is not vacuous.
- A purchase is snapshotted, so a catalogue edit between purchase and
  confirmation cannot change what a user already paid for.
- The confirmation settles the intent that **is** its ledger row, so one money
  movement is one ledger row, and the add-on's grant is additive by construction.
- **Evidence at this head.** `npx tsc -p apps/web/tsconfig.json --noEmit` exit
  `0`; full unit **114 files / 1973 passed | 3 skipped**; full integration
  **83 files / 671 passed | 1 failed** — the single failure is the disputed I3;
  `billing-self-serve.test.ts` **33 passed | 1 failed (34)**; ESLint `0 errors`
  (106 pre-existing warnings); `prettier --check` clean.
- **Evidence at the PR head** (`e55631b`, the `origin/main` `1764700` merged in;
  README union-resolved): `pnpm typecheck` exit `0` on all three projects; full
  unit **114 files / 1976 passed | 3 skipped**; full integration
  **83 files / 672 passed | 1 failed (673)** — still only I3;
  `test:coverage` statements `92.52 %`, branches `81.35 %`, functions
  `96.43 %`, lines `92.93 %` (all ≥ threshold; the step's non-zero exit is the
  disputed I3, not a threshold); ESLint `0 errors`; `prettier --check` clean.
  CI (`PR Checks` + `CI`) is green on every job except the two that run the
  suite — `ci` (integration) and `test_coverage` — which fail **only** on I3;
  `audit-dev` is the branch's pre-existing non-blocking dev-toolchain job
  (ADR-0301). The two red jobs (`ci`, `test_coverage`) are cleared at the fix
  head — see § _Resolution_ above.
- The lane ships RED-by-design (the OP-108/OP-109 precedent): the pins ride in
  this GREEN's PR — the RED's own test-only commit is the branch's first parent —
  which is why the diff contains the three specs as well as the implementation.

## Alternatives considered

- **Match the retry's webhook by the subscription ref alone.** Rejected: a
  one-time charge's confirmation carries the _payment_ ref, and a pending intent
  is the only thing that knows which subscription that charge was made against;
  correlating on the mandate ref would make a retry unattributable whenever the
  vendor's mandate id and our row disagree (exactly what I3's fixture does).
- **Insert a second ledger row for the confirmation.** Rejected: the pending row
  already is the ledger entry for that money movement, and a second row would
  double-count the charge in the §3.4 history the user reads.
- **Serve the stored `failure` block and strip `providerCode` in the route.**
  Rejected (as in ADR-0480): one forgotten key from a leak, and the shared
  scanner cannot see a field the mapper never stripped.
- **Re-read the add-on catalogue when the confirmation arrives.** Rejected: a
  catalogue edit between purchase and confirmation would change an
  already-paid purchase's grant.
- **Emit `usage.limit.restored` unconditionally on a purchase.** Rejected: the
  event means "the limits you were blocked on are back"; a purchase that does not
  clear a block restored nothing.
- **Serve an always-`404` invoice route.** Rejected as dishonest: the route
  really does look the asset up, it just has no pinned store to find it in.
- **Fix I3's fixture in this lane.** Refused: the GREEN must not edit a test,
  mock or factory. Routed to the Test Author instead.

## ADR number allocation

The OP-110 lane holds `0480`–`0499`; the RED consumed `0480`, so this record
takes **`0481`**, the `Next free` value the RED wrote into the ledger table. The
README's `OP-110 self-serve billing lane` row advances to `0482`, the index gains
this row, and the pool cell (`0500`+) is untouched. No number outside the block
is touched.
