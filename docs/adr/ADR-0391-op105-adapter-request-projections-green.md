# ADR-0391 — OP-105 follow-up GREEN: `paymentMethodKind` is projected onto the create wire and the outbound charge body is schema-validated (F3/F5)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up GREEN (`t_27873de6`) · **Branch:** `OP-105-task-adapter-request-projections` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0391`
- **Relates to:** [ADR-0390](ADR-0390-op105-adapter-request-projections-pin.md) (the pins this GREEN turns green — the contract, not re-decided here), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port + adapter contract), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the adapter whose §6 recorded `paymentMethodKind` as a coverage gap), [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters, provider neutrality), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It closes findings **F3 — Low** and **F5 — Low** of the round-1 (artifact-lens) review of the merged OP-105 GREEN (`t_e553b2c9`, PR [#292](https://github.com/yahodu/openpic-webapp/pull/292)) by delivering the contract [ADR-0390](ADR-0390-op105-adapter-request-projections-pin.md) pinned.
- **Fixes:** **F3** (`CreateMandateInput.paymentMethodKind` carried by the port but never projected onto the wire) and **F5** (`chargeOnce`'s outbound body sent with only the response schema validated).

## Context

The card is the GREEN for the RED pins of [ADR-0390](ADR-0390-op105-adapter-request-projections-pin.md):
one new MSW integration spec,
`apps/web/src/test/integration/payments-cashfree-request-projections.test.ts`
(14 tests), which drives the port and asserts only what a caller or Cashfree
observes — the JSON body that left for the wire, and the classified failure
raised when a projection cannot be built. At the pins head (`664879b`) the spec
was RED **14 failed (14)** at assertion level, with production code in the diff:
none.

Two modules own the change: the wire schemas in
`apps/web/src/server/adapters/cashfree/schemas.ts` and the adapter in
`apps/web/src/server/adapters/cashfree/cashfree-provider.ts`.

## Decision

### 1. `createMandate` projects `paymentMethodKind` onto `authorization_details.payment_methods` (F3)

The adapter now declares a module-private neutral-kind → vendor-value table
alongside the existing status and failure tables — so the vendor strings stay in
the tables, per the adapter's header rule:

| Neutral `PaymentMethodKind` (§14.3) | Cashfree `authorization_details.payment_methods` |
| ----------------------------------- | ------------------------------------------------ |
| `mandate_upi`                       | `["upi"]` (UPI Autopay)                          |
| `mandate_bank_debit`                | `["enach"]` (electronic NACH bank debit)         |
| `card`                              | `["card"]` (Card SI)                             |
| `invoice` / `manual`                | — **refused** before the wire                    |

`invoice` / `manual` are the off-platform Enterprise kinds: contract §14.3/§9
creates them as rows with no vendor mandate, so calling `createMandate` with one
is a programming error. The adapter refuses it **before the wire** with a
non-retryable `TransportError` (`retryable: false`, `code: "invalid_request"`) —
the same failure mode the mandated-request schema failure already uses — rather
than opening a subscription whose payment method the enum cannot express.

The mapped value is applied **through**
`cashfreeCreateSubscriptionRequestSchema`, which now declares
`authorization_details: z.object({ payment_methods: z.array(z.string().min(1)).min(1) }).optional()`.
The block is optional to match the pinned API (the field is optional there, and
the pre-existing `makeCashfreeCreateSubscriptionRequest` factory stays valid);
declaring it is what stops Zod from stripping the projection before it leaves.
The pin reads the projection off the **wire** (the MSW-captured request), which
is exactly what catches a stripped field.

### 2. `chargeOnce` builds its body through `cashfreeChargeRequestSchema` (F5)

`schemas.ts` exports **`cashfreeChargeRequestSchema`** for the
`POST /pg/subscriptions/{id}/payments` request:

- exactly `{ payment_amount: <number> }`, **strict** (an extra key is rejected),
- `payment_amount` must be **positive**.

The request schema is strict while the response/webhook schemas stay non-strict:
a vendor payload tolerates Cashfree's extra keys, but a body **we** build must be
exactly what we intend to send. `chargeOnce` builds
`{ payment_amount: toMajorUnits(input.amountMinor) }`, parses it with the schema
and, on failure, throws a non-retryable `TransportError`
(`retryable: false`, `code: "invalid_request"`, `cause`) **before** the call —
mirroring `createMandate` — then sends `request.data`.

## Consequences

- Every assertion in the ADR-0390 spec passes unedited: `payments-cashfree-request-projections.test.ts`
  **14 passed (14)**, and the pre-existing `payments-cashfree-adapter.test.ts`
  - `billing-checkout.test.ts` are unaffected (**20 passed (20)** when run with
    the new spec).
- A non-positive charge (`amountMinor: 0`) and an off-platform mandate kind now
  fail fast with `invalid_request` and **zero** HTTP requests on the wire —
  `chargeOnce` / `createMandate` can no longer send a body the schema would
  reject.
- The neutral kind no longer disappears between the port and Cashfree: the
  preference Cashfree sees is the one the caller asked for (or the call fails).
- Gate at this head: `pnpm typecheck` clean on all three projects
  (`tsc -p tsconfig.json`, `-p packages/contracts/tsconfig.json`,
  `-p apps/web/tsconfig.json`); `pnpm lint` **0 errors / 105 warnings** (the
  baseline); full unit **110 files / 1913 passed | 3 skipped**; full integration
  **78 files / 571 passed** (`TMPDIR=/root/tmp-mongo`); `test:coverage` exit `0`
  with statements `92.41 %`, branches `81.28 %`, functions `96.27 %`, lines
  `92.89 %` (global gates 80 %; `services/**` 90 %) — no threshold weakened and
  no test written; `prettier --check` clean; the `adr-numbering` guard green.
- **Diff:** two production modules
  (`apps/web/src/server/adapters/cashfree/cashfree-provider.ts`,
  `.../schemas.ts`), this ADR and the `docs/adr/README.md` ledger row/cell. No
  test, mock, fixture or factory is edited; the ADR-0390 spec and its ADR are
  carried byte-unchanged. No test-mode conditional exists anywhere in the change.
- The two open items [ADR-0390](ADR-0390-op105-adapter-request-projections-pin.md)
  recorded still stand and are unchanged by this GREEN: `pnach` (physical NACH)
  is not reachable from the neutral enum, and a multi-element `payment_methods`
  preference is not expressible by the single-valued enum.

## Alternatives considered

- **Send `payment_methods: [input.paymentMethodKind]` verbatim.** Rejected: the
  neutral enum is not the vendor vocabulary (`mandate_upi` is not `upi`), so a
  verbatim forward would send an unrecognised value on a money path.
- **Omit `authorization_details` for the off-platform kinds instead of refusing.**
  Rejected: the pins require a refusal before the wire, and silently letting
  Cashfree pick a payment method for a mandate we cannot express is the worse
  failure.
- **Make the charge request schema non-strict to mirror the response schemas.**
  Rejected: an unrecognised key in a body we construct is a projection bug, not
  vendor drift to tolerate, and the pin asserts the extra-field rejection.

## ADR number allocation

The OP-105 lane holds `0380`–`0399`; the cell read `0391` on this branch's cut
(the pins head `664879b`, off `origin/main` `1f41a7e`). `0380`–`0390` are
consumed on the trunk and by this lane's in-flight pins branch (the port
RED/GREEN pair, the live-sandbox record, the memory-provider RED/GREEN pair, the
F2 drift-log pair, the F1 import-boundary pair and [ADR-0390](ADR-0390-op105-adapter-request-projections-pin.md)),
so this record takes **`0391`** — the number the orchestrator reserved for this
card (decision `t_e5485868`) — and advances the cell to `0392` (the number the
downstream `expiresAt` pins card reserves). The board DB was re-read for a
sibling claim on `0391` immediately before pushing: none exists. No number
outside the lane range `0380`–`0399` is touched.

## Review sign-off — 2026-10-25 (card `t_27873de6`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of this delivery — the review + merge of
PR [#316](https://github.com/yahodu/openpic-webapp/pull/316), reviewed head
`3c5c774` — returned **APPROVED, landed**: zero changes requested to the
deliverable and **zero reviewer edits** to the two production modules, the pins
or this record. The lens was a cold read of the diff before the handoff
narrative, then independent execution on the reviewed worktree.

**Checks re-run independently at the reviewed head `3c5c774`:**

- The pins + the pre-existing adapter/checkout integration specs —
  **32 passed (32)**; the 14 ADR-0390 pins are unedited.
- Full integration **78 files / 571 passed** (`TMPDIR=/root/tmp-mongo`); full
  unit **110 files / 1913 passed | 3 skipped**.
- `tsc --noEmit` exit `0` on the root, `packages/contracts` and `apps/web`
  projects; `prettier --check .` clean.
- `adr-numbering` guard **29 passed (29)**.
- ESLint **0 errors / 0 warnings** on the two changed production files.
- PR Checks green at the head, with `audit-dev` failing as the ADR-0301
  `continue-on-error` baseline; `test_coverage` **passed** on this SHA.

(Head-anchored figures. The 3-spec set reads higher on later trunk commits
because a sibling PR's checkout specs land there afterwards; the pins + adapter
spec pair is the equivalent post-merge measurement for comparison.)

**External fact re-validation.** The reviewer fetched the pinned-version vendor
reference
(<https://www.cashfree.com/docs/api-reference/payments/previous/v2025-01-01/subscription/mandate/create>)
and read its embedded request schema: `authorization_details` is an **object**,
`payment_methods` is a `string[]` with documented values
`enach` / `pnach` / `upi` / `card`, and **none** of `authorization_details` /
`payment_methods` / `authorization_amount` / `authorization_amount_refund`
carries `isRequired: true`. The pinned projection is therefore **not** an
invented vendor field, and declaring the block optional is faithful to
`x-api-version: 2025-01-01`.

**Honesty audit.** `git diff --name-only 664879b HEAD` is two production modules
(`cashfree-provider.ts`, `schemas.ts`) plus ADRs and the README ledger only — no
test, mock, fixture or factory is edited, no `NODE_ENV` / test-mode conditional
exists anywhere in the change, and the ADR-0390 spec stayed **byte-unchanged**
(`git diff --stat 664879b HEAD -- apps/web/src/test/` is empty).

**Blast-radius check.** `createMandate`'s only production caller is
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/checkout/route.ts:369` (at
the reviewed head), which always passes
`SELF_SERVE_PAYMENT_METHOD = "mandate_upi"`, and `chargeOnce` has **no**
production caller yet — so the new pre-wire refusal and the strict charge schema
cannot regress a shipped flow.

**Findings — three, all graded Info and deliberately routed to no card.**

- **Info — cent precision stays unpinned.** `amountMinor: 49901` →
  `payment_amount: 499.01` passes `z.number().positive()`; the vendor type is
  `float64`, so a pin would only characterise legitimate pass-through. Already
  recorded in ADR-0390 §Open items and ADR-0391 §Consequences.
- **Info — `pnach` and a multi-element `payment_methods` preference are
  unreachable** from the single-valued neutral `PaymentMethodKind`. Closing it
  needs a **port** change — an orchestrator/design decision, out of scope at the
  pin stage.
- **Info — `authorization_details.authorization_amount` is not sent.** The
  vendor example carries it (its doc text notes it is always `0` for ENACH) and
  marks none of the subfields required, so acceptance should be confirmed
  against the real API before the first production mandate. That check belongs
  to the live-sandbox record, not a unit pin.

**Test-quality note.** The pins read the **MSW-captured wire body** and assert
the refusal with a **zero-call counter** — behaviour-level, with no brittle
coupling to the implementation, no over-mocking and no flake risk. They survived
the review unedited.

**Merge and follow-ups.** The delivery shipped as PR
[#316](https://github.com/yahodu/openpic-webapp/pull/316), **squash-merged as
`841f342`**, carrying the ADR-0390 pins (byte-unchanged) and this GREEN's ADR in
one squash. **Nothing in this record is retracted**, and **no ADR number is
asserted here for anything unmerged**: the follow-ups are cited by card id and
PR number only — the `expiresAt` TEST card `t_5547cab6` and its GREEN card
`t_e2747a56` (PR
[#317](https://github.com/yahodu/openpic-webapp/pull/317)) — whose own records
document what followed.
