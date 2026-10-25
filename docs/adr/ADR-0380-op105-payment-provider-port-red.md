# ADR-0380 — OP-105 RED: the payment provider port and the Cashfree adapter — normalized statuses, the four-category failure taxonomy, the webhook signature window and the vendor event mapping

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 RED (`t_bcfc0d8a`) · **Branch:** `OP-105-task-payment-provider-cashfree-adapter` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_bcfc0d8a`
- **Relates to:** [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters, provider neutrality), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) / [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (the transport adapter + drift-guard precedent this lane mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.1 (the webhook order), §10.1.1 (never-let-vendor-strings-leak), §10.1.2 (the event mapping table), §3.2 / §0.15 (`checkoutUrl` is opaque; no vendor field in a response) · **Schema:** §14.3 (`subscriptions.status` / `mandateStatus`), §14.4 (`billingTransactions.kind` / `status` / `failure.category`), §11.1 (`externalRefs`)

## Context

OP-105 is the lane's foundation: everything downstream (OP-107 checkout, OP-108
the webhook inbox and projection, OP-109 upgrade/downgrade, OP-110 retry/cancel)
consumes the port this card defines, so an under-specified port would be
re-litigated four more times. It is the payments twin of OP-92 — a
`MessageTransport` port, a Novu adapter, Zod at both boundaries and a classified
`TransportError` — and reuses that lane's shared error module as-is
(`@/server/adapters/transport-error`: `TransportError`, `UpstreamContractError`,
`classifyTransportFailure`).

The card pins the _behaviours_ it wants (`U1` status table, `U2` failure
categories, `U3` signature verification, `U4` webhook parsing, `I1`–`I5` the MSW
contract) and the GREEN card's scope note pins the **port surface**
(`createPlan`, `createMandate`, `chargeOnce`, `cancelMandate`, `fetchStatus`,
`verifyWebhook`, `parseWebhook`, `normalizeStatus`, `normalizeFailureCategory`),
the sandbox/production base URL by env, the pinned
`x-client-id`/`x-client-secret`/`x-api-version` headers, the
`base64(HMAC-SHA256(timestamp + rawBody))` scheme and the `payments.call` log
line. What neither document fixes is the thing an implementation is judged by:
**which** vendor status maps to which normalized pair, **which** failure code
maps to which category, the exact module paths, the shape of the normalized
event, and the exact HTTP request/response fields. Those are settled here, in the
executable contract, exactly as ADR-0340 settled the entitlement contract its
card left open.

The Cashfree Subscriptions API facts the tables below rest on were verified
against Cashfree's own documentation while writing this RED (its webhook
signature page, the Subscriptions FAQ status list, and the
`POST /pg/subscriptions` reference), matching the instruction in the GREEN
card's §3.

## Decision

### Module contract

| Module (specifier)                             | Exports                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/payments/payment-provider`           | The port: `PaymentProvider`, `PaymentProviderConfig`, `ProviderRef`, `WebhookHeaders`, `CreateMandateInput`/`CreateMandateResult`, `ChargeOnceInput`/`ChargeOnceResult`, `FetchStatusResult`, `NormalizedStatus`, `NormalizedTransaction`, `NormalizedProviderEvent`, and the normalized unions (`SubscriptionStatus`, `MandateStatus`, `FailureCategory`, `TransactionKind`, `TransactionStatus`, `NormalizedEventKind`) |
| `@/server/adapters/cashfree/cashfree-provider` | `createCashfreeProvider(config: PaymentProviderConfig): PaymentProvider`                                                                                                                                                                                                                                                                                                                                                  |
| `@/server/adapters/cashfree/schemas`           | `cashfreeCreateSubscriptionRequestSchema`, `cashfreeCreateSubscriptionResponseSchema`, `cashfreeSubscriptionStatusResponseSchema`, `cashfreeChargeResponseSchema`, `cashfreeWebhookEventSchema` and their inferred types                                                                                                                                                                                                  |
| `@/test/factories/payment`                     | `makePaymentProviderConfig`, `makeCreateMandateInput`, `makeCashfreeCreateSubscriptionRequest/Response`, `makeCashfreeSubscriptionStatusResponse`, `makeCashfreeChargeResponse`, `makeCashfreeWebhookBody`, `makeCashfreeWebhookHeaders`                                                                                                                                                                                  |

The port takes an **explicit config object** rather than reading env itself, so
an adapter is constructible in a test without the environment; a
`getPaymentProvider()` composition root (config selector → adapter) is left to
the GREEN/OP-107 wiring and is deliberately **not** pinned here.

### 1. `normalizeStatus(vendorStatus)` returns the `{status, mandateStatus}` pair

Contract §14.3 stores two _independent_ axes — "a revoked mandate on a paid-up
period is `active` + `revoked`" — while Cashfree reports them as one
`subscription_status`. The function therefore splits the vendor value:

| Cashfree `subscription_status` | `status`     | `mandateStatus` |
| ------------------------------ | ------------ | --------------- |
| `INITIALIZED`                  | `incomplete` | `pending`       |
| `BANK_APPROVAL_PENDING`        | `incomplete` | `pending`       |
| `ACTIVE`                       | `active`     | `active`        |
| `ON_HOLD`                      | `past_due`   | `paused`        |
| `PAUSED`                       | `active`     | `paused`        |
| `CUSTOMER_PAUSED`              | `active`     | `paused`        |
| `CUSTOMER_CANCELLED`           | `cancelled`  | `revoked`       |
| `CANCELLED`                    | `cancelled`  | `revoked`       |
| `EXPIRED`                      | `expired`    | `expired`       |
| `LINK_EXPIRED`                 | `expired`    | `expired`       |
| `COMPLETED`                    | `expired`    | `expired`       |
| `CARD_EXPIRED`                 | `active`     | `expired`       |

Five rows are fixed by contract §10.1.2 (`BANK_APPROVAL_PENDING` → mandate
`pending`; `ACTIVE` → both `active`; `ON_HOLD` → mandate `paused`;
`CUSTOMER_CANCELLED` → status `cancelled`; `EXPIRED` → mandate `expired`) and the
value sets by §14.3. The remaining rows are this ADR's decision, argued from the
lifecycle:

- `INITIALIZED` / `LINK_EXPIRED` are the same _"checkout never completed"_ state
  as `BANK_APPROVAL_PENDING`, so both are `incomplete`; an expired authorisation
  link makes the mandate unusable (`expired`) while a merely initialised one is
  still `pending`.
- `ON_HOLD` is Cashfree's _"a charge has failed"_ (its Subscriptions FAQ), i.e.
  exactly our `past_due` — the state `SUBSCRIPTION_PAYMENT_FAILED` also lands on
  (`docs/Subscription flow.md` §3). Its mandate is `paused`, per §10.1.2.
- `PAUSED` / `CUSTOMER_PAUSED` stop future debits without ending the
  subscription: entitlements stay (status `active`), the mandate does not
  (mandateStatus `paused`).
- `COMPLETED` (the schedule ran out) and `EXPIRED` end the mandate; both are
  terminal, so `expired`.
- `CARD_EXPIRED` is the §14.3 case verbatim — the user is paid up (`active`) but
  the **next** renewal will fail — so the mandate is `expired`. It is _not_
  `revoked`: revocation is a deliberate act, expiry is not, and §10.1.2 reserves
  `revoked` for the cancellation rows.

Any value **outside** this table (a new vendor status Cashfree adds tomorrow)
throws a **non-retryable `UpstreamContractError`** naming the value. The whole
point of the port is that an API change is caught in tests rather than silently
degraded: defaulting an unknown status to `active` would extend entitlements,
and defaulting it to `cancelled` would revoke them. Both are worse than a loud
failure, and the adapter's Zod schema already rejects an unknown status before
this function is reached on the wire path.

### 2. `normalizeFailureCategory(vendorCode)` → the four §14.4 categories

`failure.category ∈ {insufficient_funds, mandate_revoked, auth_required,
technical}` (§14.4) is the **only** thing dunning copy and retry policy branch
on, so the vendor code must not leak. The pinned table:

| Vendor code             | Category             |
| ----------------------- | -------------------- |
| `INSUFFICIENT_FUNDS`    | `insufficient_funds` |
| `MANDATE_REVOKED`       | `mandate_revoked`    |
| `AUTHENTICATION_FAILED` | `auth_required`      |
| `TECHNICAL_ERROR`       | `technical`          |

Matching is **case-insensitive** — Cashfree's codes are upper-case in payloads
but lower-case in some dashboard exports, and a case-sensitive lookup would
silently downgrade a real `insufficient_funds` to `technical`, changing the
dunning copy the user sees. Anything unrecognised (including the empty string,
which Cashfree sends for `failureDetails: null`) falls back to **`technical`**:
the card's explicit requirement, and the only safe default — a mislabelled
failure must never tell a user their mandate was revoked when it was not.

The code list is deliberately small. It is the _contract_ of which codes are
recognised; a wider list can be added additively without touching this ADR's
shape, and `technical` catches everything else.

### 3. `verifyWebhook(rawBody, headers)` — Cashfree's documented scheme, over raw bytes

Signature: `base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody))`, taken
from **`x-webhook-signature`**, compared against the value computed over the
**raw** body (never a re-serialised one — JSON round-tripping breaks HMAC;
contract §10.1.1). The timestamp is read from **`x-webhook-timestamp`** (epoch
milliseconds) and must fall inside **±300 s** of now — contract §10.1 step 2's
replay window, which the card also carries as `U3`'s "stale timestamp" case.

The function returns `boolean` **by design**, `false` for every failure mode
(absent header, wrong secret, tampered body, stale or future timestamp). It never
throws: the caller is the webhook handler, whose job is to answer
`401 invalid_signature` / `401 stale_signature` (§10.1 step 1–2) without writing
anything, and a distinguish-the-cases API would push that classification into
the handler. Note the deliberate overlap with the handler: freshness is checked
here _as well as_ there, so the adapter is safe to use from any caller.

### 4. `parseWebhook(rawBody)` → `NormalizedProviderEvent`

Input is the **raw body string** (the same bytes `verifyWebhook` signed); the
payload is parsed with `cashfreeWebhookEventSchema` and an unparseable body, a
missing `event_time`, or an unknown `type` raises `UpstreamContractError`.

The normalized event is a vendor-neutral value:

```ts
{
  provider: "cashfree",
  kind: NormalizedEventKind,
  occurredAt: string,            // ISO 8601, from the vendor event_time
  providerEventId: string | null,
  externalRefs: ProviderRef[],
  status: SubscriptionStatus | null,
  mandateStatus: MandateStatus | null,
  transaction: NormalizedTransaction | null,
}
```

`kind` is the §10.1.2 mapping (the one place vendor event names appear):

| Vendor event                                                                 | `kind`                   |
| ---------------------------------------------------------------------------- | ------------------------ |
| `SUBSCRIPTION_STATUS_CHANGED` → `BANK_APPROVAL_PENDING`                      | `mandate_pending`        |
| `SUBSCRIPTION_STATUS_CHANGED` → `ACTIVE`                                     | `subscription_activated` |
| `SUBSCRIPTION_STATUS_CHANGED` → `CUSTOMER_CANCELLED` / `ON_HOLD` / `EXPIRED` | `subscription_cancelled` |
| `SUBSCRIPTION_AUTH_STATUS` success                                           | `subscription_activated` |
| `SUBSCRIPTION_AUTH_STATUS` failure                                           | `mandate_failed`         |
| `SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED`                                | `ignored`                |
| `SUBSCRIPTION_PAYMENT_SUCCESS`                                               | `payment_succeeded`      |
| `SUBSCRIPTION_PAYMENT_FAILED`                                                | `payment_failed`         |
| `SUBSCRIPTION_PAYMENT_CANCELLED`                                             | `payment_failed`         |
| `SUBSCRIPTION_REFUND_STATUS`                                                 | `refund_processed`       |

Other pinned properties:

- **`status`/`mandateStatus` come from `normalizeStatus`**, so the event and the
  status table can never disagree. This is why `ON_HOLD` reads
  `kind: "subscription_cancelled"` **and** `status: "past_due"`: §10.1.2 groups
  the three terminal status changes into one row, and the projection (OP-108)
  reads `status`, not `kind`, to decide the lifecycle write.
- **`transaction`** is `null` for the status rows; otherwise
  `{kind, status, amountMinor, currency, failureCategory}`, with
  `kind ∈ {authorization, charge, refund}`, `status ∈ {succeeded, failed}` and
  `amountMinor` an **integer in minor units** (§14.4 / schema §14.3: "₹499 →
  `49900, "INR"`") — `payment_amount: 499.5` becomes `49950`, never a float.
  `SUBSCRIPTION_PAYMENT_CANCELLED` is a `failed` charge with
  `failureCategory: "auth_required"` because §10.1.2 says so explicitly (it is
  treated identically to `PAYMENT_FAILED` for dunning).
- **`failureCategory`** is `normalizeFailureCategory(failure_details.failure_reason)`.
- **`providerEventId`** is the vendor's own event identity — `cf_payment_id` for
  a payment/auth event, `cf_refund_id` for a refund, `null` for a
  status-changed event (contract §10.1 step 3 then falls back to
  `sha256(rawBody)` in the handler).
- **`externalRefs`** are `{provider, env, kind, id}` (§11.1) — `kind:
"subscription" | "payment" | "refund"` — so the handler can resolve the
  subscription document without a vendor field.
- The **emitted domain-event keys** of §10.1.2 are _not_ part of this value:
  emitting is the projection's job (OP-108), and inlining a vendor table's
  "Emits" column here would put the projection's policy in the adapter.

### 5. The HTTP contract of `createMandate` / `fetchStatus` / `chargeOnce`

- Base URL is resolved **from `env`**, per the GREEN card §2: `sandbox` →
  `https://sandbox.cashfree.com`, `production` → `https://api.cashfree.com`.
  Tests exercise the sandbox host, so a mis-derived base URL fails loudly.
- Every request carries `x-api-version` (the configured version — pinned as
  `2025-01-01`, Cashfree's current Subscriptions version), `x-client-id` and
  `x-client-secret`.
- `createMandate` `POST`s to `/pg/subscriptions` a body parsed by
  `cashfreeCreateSubscriptionRequestSchema`: a non-empty `subscription_id` (the
  idempotent reference), `customer_details.{customer_name,customer_email,
customer_phone}`, `plan_details.plan_id` (the port's `planRef`) and
  `subscription_meta.return_url` (the port's `returnUrl`). The response is parsed
  by `cashfreeCreateSubscriptionResponseSchema` and projected to
  `{externalRefs: [{kind:"subscription", id: subscription_id}], checkoutUrl:
auth_link, expiresAt: subscription_expiry_time}`.
- **`checkoutUrl` is the vendor's `auth_link`** and is opaque to every caller
  (§3.2: "no request or response field is named after a payment vendor") — the
  `POST /billing/checkout` response (OP-107) carries this string, never the field
  it came from.
- `fetchStatus` `GET`s `/pg/subscriptions/{id}` and returns the normalized pair
  from `normalizeStatus(response.subscription_status)`.
- `chargeOnce` `POST`s `/pg/subscriptions/{id}/payments` with the caller's
  **`x-idempotency-key`** header — the card's `I5`. A retry of the same intent
  reuses that key; the vendor (not application code) is what makes the double
  charge impossible.
- Non-2xx is classified through the shared `classifyTransportFailure`: a 5xx (or
  408/429) is a **retryable** `TransportError` carrying `status`, a 4xx is not,
  and a body that fails its schema is the non-retryable `UpstreamContractError`.

### 6. Logging

A response that breaks the pinned contract is logged at **`error`** under the
event **`payments.upstream_contract_violation`** with at least `provider`
(`"cashfree"`) and `operation` (`"createMandate"`, `"fetchStatus"`,
`"chargeOnce"`). `payments.call` (`info`, with `operation`, `status`,
`durationMs`) is the GREEN card's requirement and is **not** pinned here — it is
an observability nicety a future logger refactor may reshape, whereas the drift
line is the signal an on-call engineer is paged on. No log line may carry the
client secret, a signature or a raw payload (CONVENTIONS §5.3).

## Consequences

- A wrong status mapping, a leaked vendor failure code, a tampered webhook
  accepted, a stale timestamp accepted, a re-serialised body verified as valid,
  a float amount, a missing `x-idempotency-key`, a base URL that ignores the
  environment, or a drift that is not logged with its vendor and operation now
  fails the suite loudly.
- The three new modules are the seam the rest of the billing lane depends on:
  OP-107 calls `createMandate`, OP-108 calls `verifyWebhook`/`parseWebhook`/
  `normalizeStatus`, OP-110 calls `chargeOnce`/`cancelMandate`. Anything this ADR
  pins that they need differently is a _contract_ change, not a local edit.
- `PAUSED`/`CUSTOMER_PAUSED`/`CARD_EXPIRED`/`COMPLETED`/`LINK_EXPIRED` are
  mapped but not yet exercised end-to-end; they are pinned by `U1` only, so a
  future decision to treat a paused mandate as a lost entitlement is a table
  edit plus a test edit.
- **Assumptions resolved unilaterally (flagged for review):**
  1. the twelve-row status table above, and `UpstreamContractError` (rather than
     a default) for an unknown status;
  2. the four-code failure table and the `technical` default;
  3. `mandateStatus` is part of `normalizeStatus`'s return value, not a separate
     call;
  4. `ON_HOLD` maps to `past_due`/`paused` (§10.1.2 fixes only the mandate axis
     for that row);
  5. the normalized event's `kind`/`transaction`/`providerEventId`/`externalRefs`
     shapes and the minor-unit amount rule;
  6. the response field `auth_link` is the hosted authorisation URL (the design
     doc's `authLink`, §2.2/§7) and `subscription_expiry_time` is its expiry;
  7. the idempotency header name `x-idempotency-key`;
  8. the drift log event name and its `provider`/`operation` fields.
- **Out of scope (deliberately not pinned by this RED):** `createPlan` and
  `cancelMandate` (not in the card's test list); the memory provider for e2e (no
  e2e test in this card); the `CASHFREE_LIVE_TEST=1`-gated live sandbox test;
  `payments.call` and its `durationMs`; the config selector
  (`PAYMENT_PROVIDER` still lists `stripe`, not `cashfree`) and the adapter's
  env vars; the lint boundary that keeps Cashfree identifiers inside
  `adapters/cashfree/**`; and the emitted domain-event keys of §10.1.2 (OP-108's
  projection).

## Alternatives considered

- **Defaulting an unknown vendor status** to `active` (fail-open) or `cancelled`
  (fail-closed). Rejected: both silently change who is entitled to what; a
  contract break must be a loud, non-retryable error, and the wire schema already
  rejects an unknown status at the boundary.
- **A separate `normalizeMandateStatus`.** Rejected: the vendor reports one
  status string, and the two axes are read at the same instant — two calls could
  disagree.
- **Returning a discriminated result** (`{ok:true,…}|{ok:false,…}`) from
  `verifyWebhook` instead of a boolean. Rejected: it pushes the
  `invalid_signature` vs `stale_signature` split, which is the handler's §10.1
  responsibility, into the port.
- **`failure_details.failure_reason` free-text matching.** Rejected: Cashfree
  also sends prose (`"DEBIT HAS BEEN FAILED"`); a substring heuristic would make
  the category depend on wording. The pinned code table plus the `technical`
  default is deterministic, and the prose degrades to `technical` — correct, if
  unhelpfully so.
- **Pinning the whole §10.1.2 "Emits" column on the normalized event.**
  Rejected: it would move the projection's policy (OP-108) into the adapter, and
  the same event can emit differently after a state change (reactivation emits
  three keys).
- **Inlining `paymentMethodKind` into the create-subscription wire contract.**
  Rejected for this RED: Cashfree's payment-method preference field is
  version-sensitive and the port already carries the neutral enum, so the GREEN
  verifies that one mapping against the live schema; nothing downstream depends
  on it until OP-107.

## Amendment — `createMandate().expiresAt` is canonicalized in the adapter (`t_e2747a56`)

§5 above projected the create-subscription response as `expiresAt:
subscription_expiry_time` verbatim, which left the field's **shape** open. It is
now closed: the vendor field is typed `string<ISO8601>` and Cashfree's Create
Subscription reference states _"We store timestamps in IST. Example:
`2025-06-01T10:20:12+05:30`"_
(<https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription>)
— ISO 8601 with an **explicit IST `+05:30` offset, second precision, no ms and
no `Z`**. That form is neither UTC nor ms precision, while `docs/API Contract.md`
§0.13 (line 360) fixes **one** shape for every `Timestamp` — RFC 3339 UTC, ms
precision, `Z` — and §3.3 (line 1088) serves `checkout.expiresAt` in exactly
that form, projected straight from this field by OP-107.

So the adapter converts: `normalizeExpiry` parses
`response.subscription_expiry_time` and returns its `toISOString()`
(`2025-06-01T10:20:12+05:30` → `2025-06-01T04:50:12.000Z`). The conversion lives
here for the same reason every other vendor dialect does — the adapter is the
only module that speaks Cashfree, so the port stays provider-neutral
([ADR-0001](ADR-0001-ports-and-adapters.md)) and every downstream route remains
a pure projection. A value that cannot become a valid instant is a contract
break and raises `UpstreamContractError` through the schema-drift path (the
`contractViolation` helper, hence the `payments.upstream_contract_violation`
line), never `Invalid Date` or a raw vendor string on our wire.

The port's `CreateMandateResult.expiresAt` doc comment now states that shape
rather than "the vendor's expiry for that URL". No new ADR number is minted: the
decision is recorded in this amendment and pinned executably by
[ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md).

**Review carry-through (`t_e57e133f`).** The amendment above was carried **byte-unchanged** through
PR [#317](https://github.com/yahodu/openpic-webapp/pull/317) (reviewed head `1f45dcf` → squash
`b317f8b`) and independently re-run by the reviewer (round 1, artifact lens): the scoped
`git diff --stat 1f45dcf b317f8b` over the PR's paths is **empty**, so the amended text shipped
exactly as reviewed, and the pins the amendment is enforced by re-ran green (**10 passed (10)**) at
the reviewed head and again on the merged tree. **Nothing in this record is retracted or
re-decided** — the amendment stands as written, and the follow-up card's own record (`t_d91849b7`,
cited by card id and PR number only) documents what followed. No ADR number is consumed by this note
and `docs/adr/README.md` stays byte-identical to `origin/main`.

## ADR number allocation

This lane (`OP-105`) had no reserved range in
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), so, acting as the
lane's first card, it draws the next block from the allocator's
`unallocated (future lanes)` pool. `0360`–`0379` was drawn by the OP-104 lane,
which is **in flight** (branch `OP-104-task-entitlements-usage-endpoints`, head
`904b495`, PR #279 open), and ADR-0300 §7 counts an in-flight allocation as
taken, so this lane draws `0380`–`0399` and consumes `0380` for this record. The
README table gains an `OP-105 payments adapter lane` row with
`Next free = 0381` and the unallocated pool advances to `0400`+. The
`docs/adr/README.md` ledger row is the lane's known shared hotspot: the OP-104
branch edits the same rows, so this merge is expected to conflict on that file
only, and the OP-105 row stays at `0380`.
