# ADR-0392 — OP-105 follow-up TEST: `createMandate().expiresAt` is pinned as RFC 3339 UTC ms `Z` (the vendor IST offset is normalized) (F1)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_5547cab6`) · **Branch:** `OP-105-task-expiresat-rfc3339-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0392`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port contract — `CreateMandateResult.expiresAt` is typed `string` and left unpinned), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the Cashfree adapter), [ADR-0382](ADR-0382-op105-live-sandbox-contract-test.md) (its live spec deliberately asserted only a non-empty string, which is why nothing caught this), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout route already **assumed** the normalization: `billing-checkout.test.ts`'s `FIXTURE_EXPIRES_AT` is `2026-11-01T05:00:46.000Z`), [ADR-0001](ADR-0001-ports-and-adapters.md) (provider neutrality), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It closes **F1 — Medium** of the round-1 (artifact-lens) review of the merged OP-105 live-sandbox card (`t_0998dd27`, PR [#295](https://github.com/yahodu/openpic-webapp/pull/295), squash `a27f360`), routed by the orchestrator decision card `t_d32c89cf`.
- **Fixes:** **F1 — Medium** — `createMandate().expiresAt` had no pinned format, so the vendor's IST-offset string could reach our wire through §3.3's `checkout.expiresAt` once OP-107 landed. This record pins the normalization; the adapter change itself is the gated GREEN (`t_e2747a56`).

## Context

`CreateMandateResult.expiresAt` (`payment-provider.ts`) was typed a plain `string`
and documented "The vendor's expiry for that URL". The adapter returned it
verbatim and the wire schema admitted any non-empty string, while
`docs/API Contract.md` §0.13 (line 360) fixes one shape for **every** `Timestamp`
— `RFC 3339 UTC, ms precision, Z`, example `2026-09-24T18:30:00.000Z` — and §3.3
(line 1088) serves `checkout.expiresAt = "2026-09-25T10:14:00.000Z"`, which the
OP-107 checkout route projects straight from `createMandate().expiresAt`.

### What the vendor actually emits

The routing card `t_d32c89cf` recalled the vendor returning a **space-separated**
`"2023-05-30 00:00:00"` (no `T`, no zone). That recollection is **wrong**. The
current Cashfree Create Subscription reference types the response field
`subscription_expiry_time` as `string<ISO8601>` — _"Time at which the
subscription will expire. We store timestamps in IST. Example:
`2025-06-01T10:20:12+05:30`"_
(<https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription>).
So the vendor emits ISO 8601 with an **explicit IST `+05:30` offset, second
precision, no ms and no `Z`**.

The correction does not change the decision: the offset-bearing form is _still_
neither UTC nor ms precision, so canonicalization at the boundary is still
required. It does change the fixture the pin must drive — a space-separated
fixture would have been a different (and wrong) pin.

## Decision

`createMandate().expiresAt` is **RFC 3339 UTC, ms precision, `Z`** — the §0.13
`Timestamp` shape — and the **adapter normalizes** the vendor value.

### Why the adapter, not the OP-107 route

1. The port is provider-neutral: it must not leak the vendor's IST offset to any
   caller (`ADR-0001`).
2. The adapter already normalizes at this exact boundary — vendor statuses,
   failure categories, amounts and webhook events all become neutral vocabulary
   inside `cashfree-provider.ts`.
3. With the conversion here, every downstream route stays a pure projection, so
   `checkout.expiresAt` needs no per-route special case and cannot drift.

### The pin

`apps/web/src/test/integration/payments-cashfree-expiresat.test.ts` (MSW) drives
the port with a **vendor-shaped** `subscription_expiry_time` and asserts:

- **I1** (three rows, asserted per row that the input is offset-bearing and has
  neither ms nor `Z`, so the pin cannot later be weakened to an ISO-ms fixture):
  - `2025-06-01T10:20:12+05:30` → `2025-06-01T04:50:12.000Z` (the vendor docs' own example),
  - `2100-01-01T23:00:08+05:30` → `2100-01-01T17:30:08.000Z` (day + year boundary),
  - `2026-11-01T10:30:46+05:30` → `2026-11-01T05:00:46.000Z` (the shared factory default),
  - plus the canonical regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`.
- **I2**: an **unparseable** vendor expiry (`"not-a-timestamp"`) rejects with
  `UpstreamContractError` rather than returning the raw string or `Invalid Date`
  garbage — mirroring `parseWebhook`'s existing unparseable-`event_time` guard.

The pre-existing verbatim-passthrough assertion in
`payments-cashfree-adapter.test.ts` (`expect(result.expiresAt).toBe(response.subscription_expiry_time)`)
**contradicted** the decision and would have blocked the GREEN, so its
_expectation_ is repinned to `2026-11-01T05:00:46.000Z`. The factory fixture's
vendor-shaped `subscription_expiry_time` is left **unchanged** — it is
deliberately the vendor's shape and is what keeps the pin honest.

## Evidence at the RED head

- New spec `apps/web/src/test/integration/payments-cashfree-expiresat.test.ts`
  (MSW, 4 tests: 3 `it.each` rows + I2), plus one repinned expectation in
  `payments-cashfree-adapter.test.ts`.
- RED: `Test Files 2 failed (2)` / `Tests 5 failed | 5 passed (10)`, every
  failure at assertion level against the current verbatim passthrough —
  `AssertionError: expected '2025-06-01T10:20:12+05:30' to be
'2025-06-01T04:50:12.000Z'` (and the two other rows); the repinned adapter I1
  `expected '2026-11-01T10:30:46+05:30' to be '2026-11-01T05:00:46.000Z'`; and
  I2 `AssertionError: promise resolved "{ … }" instead of rejecting`.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 problems and
  `prettier --check` clean on both touched specs.
- **Test files only** — no production file touched; no test-mode conditional.

## Open items

- The **exact guard** for an unparseable value is left to the GREEN: I2 pins the
  _observable_ (rejects with `UpstreamContractError`), not whether the adapter
  routes it through the `contractViolation(...)` helper (which would also emit a
  `payments.upstream_contract_violation` line) or throws `UpstreamContractError`
  directly as `parseWebhook` does. Either is faithful.
- The port's doc comment ("The vendor's expiry for that URL") is now inaccurate;
  amending it is the GREEN's job (it is production code).
- The live-sandbox spec (`payments-cashfree-live-sandbox.test.ts`) still asserts
  only a non-empty `expiresAt`; strengthening it to the canonical regex is a
  reasonable follow-up but is not needed for this fix — the MSW pin is the
  executable contract and the live spec is skipped in CI.

## ADR number allocation

The OP-105 lane holds `0380`–`0399`; the cell read `0392` at this branch's cut
off `origin/main` `2a5f40e` (the `1.35.0` release on top of the
request-projections squash `841f342`). `0380`–`0389` are consumed on the trunk
(the port RED/GREEN pair, the live-sandbox record, the memory-provider
RED/GREEN pair, the F2 drift-log pair and the F1 import-boundary pair) and
`0390`/`0391` are consumed by the request-projections pins/GREEN pair — all
count as taken under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§7 — so this record takes **`0392`**, the number the orchestrator reserved for
this card (decision `t_e5485868`) and the cell's value re-read at the branch
cut, immediately before committing. The cell is advanced to `0393`. The board
DB was re-read for a sibling claim on `0392` immediately before pushing: none
exists. No number outside the lane range `0380`–`0399` is touched.
