# ADR-0390 — OP-105 follow-up TEST: the create-wire payment-method projection and the outbound charge request schema are pinned (F3/F5)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_9f1dd822`) · **Branch:** `OP-105-task-adapter-request-projections` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0390`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port + adapter contract; its rejected alternative deferred this mapping), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (§6 records `paymentMethodKind` as a coverage gap), [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters, provider neutrality), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It closes the two findings the round-1 review of the merged OP-105 GREEN (`t_e553b2c9`, PR [#292](https://github.com/yahodu/openpic-webapp/pull/292)) left open, and the ADR-0381 §6 / §"Coverage gaps" entries that named them.
- **Fixes:** **F3 — Low** (`paymentMethodKind` carried by the port but never projected onto the wire) and **F5 — Low** (`chargeOnce`'s request body not schema-validated); the OP-105 GREEN card §3 requires the request/response/webhook payloads to be Zod schemas.

## Context

Two Low findings from the round-1 review of the merged OP-105 GREEN were routed
back to this lane (orchestrator card `t_d4deaa7a`):

- **F3.** `CreateMandateInput.paymentMethodKind` is part of the port, but the
  request body the adapter POSTs to `/pg/subscriptions`
  (`cashfree-provider.ts`, the `createMandate` body) carries only
  `subscription_id`, `customer_details`, `plan_details` and `subscription_meta`.
  ADR-0380's last rejected alternative deferred the mapping because Cashfree's
  payment-method preference field is version-sensitive; ADR-0381 §6 recorded it
  as a coverage gap. The OP-107 cards (`t_98bf1d99` / `t_5f08f665`) do not carry
  the pin either, so ownership returns to the lane that owns the adapter and its
  schema module.
- **F5.** `chargeOnce` sent an inline `{ payment_amount: toMajorUnits(input.amountMinor) }`
  with only the **response** schema validated, while `createMandate` validates
  its request. A malformed outbound body could therefore reach the wire.

### The pinned API version does expose a payment-method preference

The card requires the field name to be verified against the **pinned**
Subscriptions API version (`x-api-version: 2025-01-01`) rather than guessed.
Verified against Cashfree's own v2025-01-01 Create Subscription reference
(<https://www.cashfree.com/docs/api-reference/payments/previous/v2025-01-01/subscription/mandate/create>):
the request body has an optional `authorization_details` object whose
`payment_methods` array takes vendor payment-method identifiers —
`"enach"`, `"pnach"`, `"upi"`, `"card"`. The pinned version **does** expose a
request field for the preference, so no fallback mechanism is needed and the
mapping is pinned against that field. (Note the request spells the object
`authorization_details` with a `z`; the response spells its own block
`authorisation_details` with an `s` — only the request name matters here.)

## Decision

### 1. `createMandate` projects `paymentMethodKind` onto `authorization_details.payment_methods`

The adapter owns a neutral-kind → vendor-value table. Each self-serve §14.3
mandate kind maps onto exactly one value of the pinned `payment_methods` array
(the wire carries a one-element array for that kind):

| Neutral `PaymentMethodKind` (§14.3) | Cashfree `authorization_details.payment_methods` |
| ----------------------------------- | ------------------------------------------------ |
| `mandate_upi`                       | `["upi"]` (UPI Autopay)                          |
| `mandate_bank_debit`                | `["enach"]` (electronic NACH bank debit)         |
| `card`                              | `["card"]` (Card SI)                             |
| `invoice`                           | — **refused** before the wire                    |
| `manual`                            | — **refused** before the wire                    |

`invoice` / `manual` are the off-platform Enterprise kinds: contract §14.3/§9
creates them as rows with **no `externalRefs`** (the admin path
`POST /admin/subscriptions`), so there is no vendor mandate to open. Calling
`createMandate` with one of them is a programming error, so the adapter **refuses
it before the wire** with a non-retryable `TransportError`
(`retryable: false`, `code: "invalid_request"`) — the same failure mode
`createMandate` already uses when the built request fails its schema. Refusing
loudly is preferred to silently opening a subscription whose payment method the
neutral enum cannot express, or to forwarding an empty preference that lets
Cashfree pick a default on a money path.

The mapping is applied **through** `cashfreeCreateSubscriptionRequestSchema`, so
the schema module must declare `authorization_details` (as an optional object
with a non-empty `payment_methods` array) — otherwise Zod would strip the field
and the projection would never leave the building. The pinned body is asserted
from the **wire** (the MSW-captured request), which is what catches that.

### 2. `chargeOnce` builds its body through `cashfreeChargeRequestSchema`

`schemas.ts` exports **`cashfreeChargeRequestSchema`** for the
`POST /pg/subscriptions/{id}/payments` request:

- exactly `{ payment_amount: <number> }`, **strict** (an extra key is rejected),
- `payment_amount` must be **positive** (a zero or negative charge is nonsense).

Request schemas are strict while the response/webhook schemas stay non-strict
(ADR-0388's module note): a vendor payload tolerates Cashfree's extra keys, but a
body **we** build must be exactly what we intend to send.

`chargeOnce` parses its outbound body with that schema and, on failure, throws a
non-retryable `TransportError` (`retryable: false`, `code: "invalid_request"`)
**before** any HTTP request is issued — mirroring `createMandate`.

## Evidence at the RED head

- New spec `apps/web/src/test/integration/payments-cashfree-request-projections.test.ts`
  (MSW), 14 tests, **test files only** — no production file touched.
- RED: `Test Files 1 failed (1)` / `Tests 14 failed (14)`, all at assertion level:
  `expected undefined to deeply equal { payment_methods: [ 'upi' ] }` (F3),
  `Error: cashfreeChargeRequestSchema is not exported from
@/server/adapters/cashfree/schemas` (F5 schema export), and
  `promise resolved "…" instead of rejecting` for the off-platform-refusal and
  non-positive-charge pins (the current code reaches the wire instead).
- Load-bearing, mutation-proven with a throwaway **stub** implementation
  (deleted before handoff; `git diff` on both production files empty): the
  mapping table + the `authorization_details` schema field + the strict
  `cashfreeChargeRequestSchema` + the two `invalid_request` guards turn the spec
  **14 passed (14)**, and the pre-existing `payments-cashfree-adapter.test.ts`
  and `billing-checkout.test.ts` stay green (**18 passed**) with the stub.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 problems;
  `prettier --check` clean on the new file.

## Open items

- **`pnach`** (physical NACH, a paper form) is not reachable from the neutral
  enum — the port carries no bank-account details — so `mandate_bank_debit`
  maps to `enach` only. If a physical-NACH kind is ever added, it is an additive
  table row.
- The **`pnach`/multi-method** preference (a customer who may authorize via more
  than one mode) is not expressible by the single-valued neutral enum; the wire
  could carry a multi-element array, but nothing in the port asks for it.
- The refusal of `invoice`/`manual` is this ADR's decision, not the card's
  prose; the OP-107 checkout route already only ever passes `mandate_upi`
  (`SELF_SERVE_PAYMENT_METHOD`), so no shipped flow changes.

## ADR number allocation

The OP-105 lane holds `0380`–`0399`; the cell read `0390` on this branch's cut
off `origin/main` `1f41a7e`. `0380`–`0389` are consumed on the trunk (the
port RED/GREEN pair, the live-sandbox record, the memory-provider RED/GREEN
pair, the F2 drift-log pair and the F1 import-boundary pair), so this record
takes **`0390`** — the number the orchestrator reserved for this card (decision
`t_e5485868`) — and advances the cell to `0391`. The board DB was re-read for a
sibling claim on `0390` immediately before pushing: none exists. No number
outside the lane range `0380`–`0399` is touched.

## Post-review note — 2026-10-25 (card `t_df8ed734`)

The 14 pins this record specifies were carried **byte-unchanged** through PR
[#316](https://github.com/yahodu/openpic-webapp/pull/316) and turned green by
the GREEN card `t_27873de6`; the reviewer independently re-ran them, unedited
(**32 passed (32)** for the pins + the pre-existing adapter/checkout specs at the
reviewed head `3c5c774`, and the pins + adapter spec set **20 passed (20)** on
the merged trunk `841f342`). **Nothing in ADR-0390 is retracted or re-decided**;
this note records only that the pins landed unchanged and were re-verified. No
ADR number is consumed by this note, and `docs/adr/README.md` is untouched.
