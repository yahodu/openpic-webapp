# ADR-0381 — OP-105 GREEN: the payment provider port and the Cashfree adapter implemented against ADR-0380

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 GREEN (`t_e553b2c9`) · **Branch:** `OP-105-task-payment-provider-cashfree-adapter-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the executable contract this GREEN implements), [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) / [ADR-0076](ADR-0076-op92-message-transport-and-novu-drift-guard-green.md) (the transport-adapter precedent), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It **completes** ADR-0380 §5's HTTP contract and records every question the RED left open for the implementation.
- **Contract:** §10.1 (handler order), §10.1.1, §10.1.2 (event mapping), §14.3 (`status`/`mandateStatus`), §14.4 (`kind`/`status`/`failure.category`), §11.1 (`externalRefs`)

## Context

ADR-0380 pinned the executable contract: the twelve-row status table, the four-code failure
taxonomy, the `base64(HMAC-SHA256(secret, timestamp + rawBody))` signature over the raw bytes with
the ±300 s window, the §10.1.2 event mapping, the three HTTP operations and the drift log line. Nine
unit tests (U1/U2 over the two tables, U3/U4 over the signature and the mapping), six MSW-driven
integration tests (I1–I5) and one fixture factory shipped with it, all red.

This record covers the GREEN: the three production modules, the questions the pins left open for the
implementation to settle, and the two places the implementation deliberately does **not** follow the
card's prose (with the reasoning).

## Decision

### Module layout

| File                                                         | Contents                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/payments/payment-provider.ts`           | The port: `PaymentProvider`, `PaymentProviderConfig`, `ProviderRef`, `WebhookHeaders`, `CreateMandateInput`/`Result`, `ChargeOnceInput`/`Result`, `FetchStatusResult`, `NormalizedStatus`, `NormalizedTransaction`, `NormalizedProviderEvent` and the normalized unions. Types only — not one line of runtime code, and no vendor string. |
| `apps/web/src/server/adapters/cashfree/schemas.ts`           | `cashfreeCreateSubscriptionRequestSchema`, `cashfreeCreateSubscriptionResponseSchema`, `cashfreeSubscriptionStatusResponseSchema`, `cashfreeChargeResponseSchema`, `cashfreeWebhookEventSchema` + inferred types.                                                                                                                         |
| `apps/web/src/server/adapters/cashfree/cashfree-provider.ts` | `createCashfreeProvider(config)`, the vendor tables, the signature check, the event projection, `UPSTREAM_CONTRACT_VIOLATION_EVENT` and `PAYMENTS_CALL_EVENT`.                                                                                                                                                                            |

### 1. The vendor tables are `Map`s, and the vendor names appear once

The three lookup tables (`STATUS_TABLE`, `FAILURE_CATEGORY_TABLE`, `VENDOR_EVENT_KINDS`) are
`ReadonlyMap`s keyed by the vendor string, and the seven vendor **event type** names are declared
once in a `VENDOR_EVENT` object that the mapping tables, `kindForEvent` and `providerEventIdFor`
all reference. Two consequences: a typo in a vendor event name is a compile error rather than a
silently ignored webhook, and no vendor value is reachable through a computed object key (which
`security/detect-object-injection` flags and the repo tolerates as a warning elsewhere).

### 2. The kind of a `subscription_status` change is derived from the **normalized** status

ADR-0380 §4 fixes five `kind` rows for `SUBSCRIPTION_STATUS_CHANGED` (`BANK_APPROVAL_PENDING` →
`mandate_pending`; `ACTIVE` → `subscription_activated`; `CUSTOMER_CANCELLED` / `ON_HOLD` / `EXPIRED`
→ `subscription_cancelled`) and says nothing about the other seven vendor statuses that
`normalizeStatus` accepts.

**Decision:** derive the `kind` from the **normalized** status rather than add a second
vendor-string table — `incomplete` → `mandate_pending`, `active` → `subscription_activated`, the
terminal rows (`past_due`, `cancelled`, `expired`) → `subscription_cancelled`. This reproduces all
five pinned rows exactly, and it is the property ADR-0380 §4 argues for: "`status`/`mandateStatus`
come from `normalizeStatus`, so the event and the status table can never disagree". The extra rows
it resolves are the natural extensions of that same rule (`INITIALIZED` and `LINK_EXPIRED` are the
"checkout never completed" state §1 groups with `BANK_APPROVAL_PENDING`; `PAUSED` /
`CUSTOMER_PAUSED` keep entitlements, so they read as activations; `COMPLETED` / `CARD_EXPIRED` end
like the expired rows). `downgraded` is our own billing state — no vendor status normalizes onto it
— and is grouped with the terminal rows purely so the switch is exhaustive.

A `SUBSCRIPTION_STATUS_CHANGED` event that carries no `subscription_status` at all is drift and
raises `UpstreamContractError`, as does an unknown vendor event type (U4's third case).

### 3. A payment event may omit its amount; that is not a parse failure

The pinned webhook schema marks the payment detail fields optional, and U4's
"carries the vendor payment id as the provider event id for a payment event" drives exactly such a
payload (`{cf_payment_id, payment_status}`, no amount). Throwing there would fail a body the RED
accepts.

**Decision:** the transaction is still built, with `amountMinor: 0` and the currency falling back to
the payload's `plan_details.plan_currency`. The reasoning: a webhook body that fails to parse is
dropped with nothing written and nothing to retry (§10.1 step 4 is the dedupe insert, and the
projection is a separate consumer), which for a money event is strictly worse than a durable,
zero-amount row that reconciliation can correct. The fallback is recorded here because it is the
implementation's choice, not a pinned behaviour.

### 4. `payments.call` **is** emitted

The card's §5 security/logging requirement asks for `payments.call` with `operation`, `status` and
`durationMs`; ADR-0380 §6 left it unpinned ("a future logger refactor may reshape it"). It is
implemented here because the card asks for it and because it is _covered_ rather than dead code —
every I1/I3/I4/I5 call emits one. The drift line ADR-0380 §6 does pin
(`payments.upstream_contract_violation`, `error`, with `provider` + `operation`) is emitted by
`contractViolation(...)` on both a non-JSON body and a schema failure. Neither line can carry the
client secret, a signature or a raw payload: `logCall` logs four scalars, `contractViolation` logs
the message, the provider and the operation.

### 5. `createPlan` and `cancelMandate` are **not** on the port

The card's §1 lists them; ADR-0380 lists both under **"Out of scope (deliberately not pinned by this
RED)"** on the grounds that no test in this card exercises them, and the same ADR records
`POST /pg/subscriptions/{id}/cancel` as OP-110's endpoint and plan creation as OP-107's. The
implementer's mandate is to build what the tests demand: an untested vendor HTTP call is a
liability the next cycle has to carry, and `createPlan`/`cancelMandate` cannot be validated against
anything until their cards write the pins.

**Decision:** the port exposes exactly the seven methods the tests drive — `createMandate`,
`chargeOnce`, `fetchStatus`, `verifyWebhook`, `parseWebhook`, `normalizeStatus`,
`normalizeFailureCategory`. Adding `cancelMandate` / `createPlan` later is an additive change to one
interface and one adapter, and their wire contracts belong with their tests. **This is the one point
where this record knowingly departs from the card's prose**, and it is flagged as such in the
handoff.

### 6. `paymentMethodKind` is carried by the port but not projected onto the wire

`CreateMandateInput.paymentMethodKind` (the neutral §14.3 enum) is part of the port because the
fixture pins it, but the request body sent to `POST /pg/subscriptions` carries only the four fields
I1 validates (`subscription_id`, `customer_details`, `plan_details`, `subscription_meta`).
ADR-0380's last rejected alternative says why: Cashfree's payment-method preference field is
version-sensitive and "nothing downstream depends on it until OP-107". Projecting it now would be an
unverified wire mapping; OP-107 pins it against the live schema. Recorded as a coverage gap.

### 7. The remaining open questions, as settled

- **`x-idempotency-key`** carries the caller's `idempotencyKey` on `chargeOnce` (I5). `createMandate`
  sends a freshly minted `subscription_id` (UUID) as the vendor's idempotent reference; the port
  input carries no id, so a retry mints a new reference. Nothing retries automatically.
- **Timeouts and retries:** every call has an `AbortController` timeout (15 s default, overridable
  via `PaymentProviderConfig.timeoutMs`) and **no call is ever retried**. A `fetch` rejection —
  including the abort — is classified by the shared `classifyTransportFailure` as retryable
  (`timeout` / `network`), but the retry policy belongs to the caller, not the adapter.
- **Non-2xx** is classified through the same shared helper: 5xx / 408 / 429 retryable (I3 proves the
  503), everything else not.
- **`ChargeOnceResult`** is `{externalRefs}`, the payment ref only. The charge response's
  `payment_status` is _not_ projected onto the two-state `TransactionStatus` because that mapping
  (Cashfree reports `INITIALIZED` / `PENDING` as well) is unpinned — recorded as a coverage gap
  rather than guessed.
- **`externalRefs` composition:** the subscription ref whenever the payload carries
  `subscription_id`, plus the payment ref (`cf_payment_id`) and/or the refund ref (`cf_refund_id`).
  No test constrains this; it is the §11.1 shape the OP-108 projection needs.
- **`normalizeFailureCategory`** is case-insensitive with the `technical` default (U2), and
  `SUBSCRIPTION_PAYMENT_CANCELLED` is a `failed` charge with the pinned `auth_required` category
  rather than a taxonomy lookup, because §10.1.2 says so explicitly.

## Consequences

- The three modules are the seam OP-107 (checkout), OP-108 (webhook inbox + projection) and OP-110
  (retry/cancel) build on. `createMandate` → `POST /pg/subscriptions`,
  `fetchStatus` → `GET /pg/subscriptions/{id}`, `chargeOnce` →
  `POST /pg/subscriptions/{id}/payments` all validated in both directions.
- A wrong status mapping, a leaked vendor failure code, an accepted tampered or stale webhook, a
  float amount, a missing `x-idempotency-key`, a base URL that ignores the environment or a silent
  drift is now a failing test.
- **Coverage:** `cashfree-provider.ts` sits at 93.4 % lines / 87 % branches. The uncovered
  remainder is deliberate: the abort callback, the `VENDOR_EVENT_KINDS`-miss arm, and the
  `contractViolation` / non-JSON arms that I2's schema failure reaches by only one of two paths.
  All global thresholds pass (statements 92.31 %, branches 80.84 %, functions 96.19 %, lines
  92.81 %) and no gate was weakened.
- **Coverage gaps handed to the Test Author** (behaviours implemented, under-constrained by the
  pins): `createPlan` / `cancelMandate` (absent by design — see §5); `paymentMethodKind`'s wire
  mapping (§6); the `ChargeOnceResult` status projection; the `externalRefs` composition of a
  payment/refund event; the timeout/abort path (no test drives a hanging vendor); the
  `CASHFREE_LIVE_TEST=1` sandbox contract test and the memory provider for e2e (both explicitly out
  of scope in ADR-0380); and the Cashfree-identifiers lint boundary (also out of scope there, so no
  rule enforces §5 above yet).

## Review sign-off — 2026-10-25 (card `t_e553b2c9`, round 1 · artifact lens)

- **Reviewer round:** 1 (artifact lens) · **Card:** `t_e553b2c9` · **PR:**
  [#292](https://github.com/yahodu/openpic-webapp/pull/292) (head `d3b6bdc` → squash `d0eb4a0`) ·
  **Verdict:** APPROVED WITH FINDINGS · **Consumes:** no ADR number (append-only; `docs/adr/README.md`
  stays byte-identical to `origin/main`)

The round-1 (**artifact lens**) review of this OP-105 GREEN returned **APPROVED WITH FINDINGS** —
zero changes requested to the deliverable and **zero reviewer edits**: no test, mock, fixture,
factory or production file was touched, and the merged bytes are the reviewed bytes
(`git diff --quiet d3b6bdc d0eb4a0` is empty and `d0eb4a0` is an ancestor of `origin/main`).

**Evidence reproduced independently at the reviewed head `d3b6bdc`:**

- The RED pins re-run **unedited**: unit `payments-cashfree-status.test.ts` +
  `payments-cashfree-webhook.test.ts` → **52 passed (52)**; integration
  `payments-cashfree-adapter.test.ts` → **6 passed (6)**.
- Full suites green: unit **104 files / 1800 tests**, integration **73 files / 521 tests**
  (`TMPDIR=/root/tmp-mongo`).
- `pnpm run typecheck` exit `0` on all three projects, ESLint 0 errors, `prettier --check` clean, the
  `adr-numbering` guard green.
- **Honesty audit clean.** The GREEN commits touch no test file —
  `git diff --stat 8567dc2..HEAD` is the three production modules
  (`server/payments/payment-provider.ts`, `server/adapters/cashfree/schemas.ts`,
  `server/adapters/cashfree/cashfree-provider.ts`), this ADR and the README ledger cells; the pins
  and the fixture factory arrived in the RED's own commits and were carried unchanged.
- **A throwaway probe at the head found F2** (below): an unknown vendor `subscription_status` raised
  `UpstreamContractError` with **no** `payments.upstream_contract_violation` line — `parseWebhook`
  logged `[]` and `fetchStatus` logged only `["payments.call"]`.

### Findings carried out of the review

Both Medium findings are **beyond this card's pinned acceptance criteria** and were **routed, not
fixed here**. They are cited by card id and PR number on purpose: a follow-up's ADR number may
renumber while its PR is open.

- **F1 (Medium) — acceptance criterion 1 (the Cashfree-identifier lint boundary) is not delivered.**
  The diff adds no vendor identifier outside `adapters/cashfree/**` (the port carries only the
  neutral `PaymentProviderKey` union §11.1 requires), but nothing enforces that: `eslint.config.mjs`
  carries a boundary for the Novu SDK and one for the repository seam, and none for the payments
  vendor seam. Routed to TEST card `t_d3a8bf6f` (pins) → GREEN card `t_b7f8adfd` (enforcement, PR
  [#310](https://github.com/yahodu/openpic-webapp/pull/310), stacked on the draft pins PR #306).
- **F2 (Medium) — an unknown vendor status throws with no drift log.** The wire schemas are
  non-strict on the status string, so a status outside the twelve-row table is detected only by the
  `STATUS_TABLE` lookup — the one path outside `contractViolation(...)` — and the drift was therefore
  silent (probe above). Routed to TEST card `t_8ccb6c1f` → GREEN card `t_92de5343` (PR
  [#297](https://github.com/yahodu/openpic-webapp/pull/297)).

The Low/Info items were recorded and routed to the orchestrator card `t_d4deaa7a`, **by card id
only** — none of them had a record when this sign-off was written:

- **F3 (Low) — `paymentMethodKind` is carried by the port and never projected onto the create wire**
  (§6 above).
- **F4 (Low) — `createMandate` mints a fresh `randomUUID()` as the vendor `subscription_id` on every
  call**, so a retried create is not retry-safe (§7 above). Whether the port gains an idempotency key
  is the orchestrator's decision, and the follow-up card's own record documents the outcome.
- **F5 (Low) — `chargeOnce`'s request body is not schema-validated** (§7 above validates the response
  only).
- **F6 (Info)** — `kind` reads `subscription_activated` for a paused mandate that normalizes to
  `active`; documented in §2 above and harmless, since the projection reads `status`. No card.
- **F7 (Info)** — the card's 502 `upstream_unavailable` envelope is unwired because OP-105 has no
  route; the billing route cards (OP-107) own the mapping. No card.
- **F8 (Info)** — the handoff metadata cited a non-existent `ADR-0382`; the ADR text cites ADR-0380
  correctly. No card.

### Post-review status

Nothing in §Context–§Consequences above is retracted: those sections document the state at the GREEN
head, and the follow-ups' own records document what followed. At the time this sign-off was written:

- **F2 is addressed and landed.** TEST card `t_8ccb6c1f` is recorded in
  [ADR-0386](ADR-0386-op105-drift-log-unknown-status-pin.md) and GREEN card `t_92de5343` in
  [ADR-0387](ADR-0387-op105-drift-log-unknown-status-green.md); PR
  [#297](https://github.com/yahodu/openpic-webapp/pull/297) squash-merged as `2669c304`, an ancestor
  of `origin/main`. The drift line now fires on both wire paths (`parseWebhook`, `fetchStatus`) and a
  status **inside** the table logs nothing.
- **F1 is in flight.** TEST card `t_d3a8bf6f` (pins) and GREEN card `t_b7f8adfd` (enforcement) were
  delivered as the draft pins PR #306 and PR #310, both **open** at the time of writing, so this
  record asserts no landed fact and cites **no ADR number** for them — `t_b7f8adfd`'s own record
  documents the outcome.
- **F3–F5 are routed**, with their pins and implementation still in flight on the orchestrator's
  chain behind card `t_d4deaa7a`; their own records document what followed.
