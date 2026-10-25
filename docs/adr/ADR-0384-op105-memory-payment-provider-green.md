# ADR-0384 — OP-105 follow-up GREEN: the in-process memory payment provider and the `getPaymentProvider` composition root implemented against ADR-0383

- **Status:** Accepted · **Date:** 2026-10-25 · **Renumbered:** cut as `0383`, moved to `0384` (the OP-105 live-sandbox lane merged `0382` to `main`, shifting this lane up one; ADR-0300 §7)
- **Card:** OP-105 follow-up GREEN (`t_7dd42be8`) · **Branch:** `OP-105-task-memory-payment-provider` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_68faf9b3`
- **Relates to:** [ADR-0383](ADR-0383-op105-memory-payment-provider-red.md) (the pins this GREEN satisfies), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the port + Cashfree adapter, whose signature scheme and table style are reused), [ADR-0096](ADR-0096-message-transport-factory.md) / [ADR-0105](ADR-0105-op94-notification-transport-selection.md) (`getMessageTransport`, the selector this root mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §11.1 (`externalRefs`, the provider key names the registered adapter), §10.1 (verify → parse webhook order), §10.1.2 (normalized event taxonomy), §3.2 / §0.15 (`checkoutUrl` opaque, no vendor field in a response) · **CONVENTIONS:** §5.3 (nothing sensitive logged), §7 (adapter boundary)
- **Releases:** OP-107 RED `t_98bf1d99` E1 and OP-108 RED `t_a297e850` E1, both of which need this signer and this selector

## Context

ADR-0383 pinned the second `PaymentProvider` implementation and its composition
root as a RED with no production code. This ADR records the minimal
implementation that turns those 16 pins green, and settles the three questions
ADR-0383 deliberately left open ("Open items").

The pins are the specification. Nothing here goes beyond them: no port change
beyond the union widening ADR-0383 §4 requires, no vendor emulation, no new
configuration key, and no test, mock, fixture or factory touched.

## Decision

### 1. `createMandate` / `chargeOnce` are pure functions of their input

Both answers are _derived_, never read from a clock or a mutable store:

- `createMandate` seeds a `sha256` digest from an **explicit, fixed-order
  projection** of the input (plan ref, the three customer fields, return URL,
  payment-method kind) rather than `JSON.stringify(input)`, so the id depends on
  the mandate's values and not on the property order the caller happened to
  build them in. The mandate id is `mem_sub_<24 hex>`, the `checkoutUrl` is
  `https://memory.openpic.local/checkout/<id>`.
- `chargeOnce` derives the payment id as `mem_pay_<24 hex>` from the caller's
  `idempotencyKey` alone. Idempotency is therefore a property of the
  construction rather than of any bookkeeping: replaying one key returns a
  byte-identical ref, a different key returns a different payment id, and the
  provider needs no state map.

`expiresAt` is a **pinned constant** (`2099-12-31T23:59:59.000Z`), not
`Date.now() + ttl`. ADR-0383 §1 requires every field to be a function of the
input rather than of the wall clock, and a constant is the only shape that
satisfies that without inventing a meaningless input→time coupling; the instant
is deliberately far in the future so no e2e trips an expiry check it never asked
for. A future e2e that genuinely needs a moving expiry has to thread a clock —
that is OP-108's or OP-107's call, not this card's.

### 2. The webhook scheme is the ADR-0380 scheme, and the wire format is our own event

`signWebhook(rawBody, timestamp?)` returns
`{ "x-webhook-timestamp": timestamp ?? String(Date.now()), "x-webhook-signature":
base64(HMAC-SHA256(secret, timestamp + rawBody)) }` and `verifyWebhook` is the
same check `createCashfreeProvider` performs: both headers present, a finite
numeric timestamp inside the shared ±300 s window, then a timing-safe compare of
the recomputed signature. Reusing the scheme verbatim (rather than restating it)
is what makes the two directions the pins cross-check hold: a memory signature
verifies on the Cashfree adapter and a Cashfree-factory signature verifies on
the memory provider.

`parseWebhook` validates the raw body against a Zod schema of the port's own
`NormalizedProviderEvent` (`provider: "memory"`), because there is no vendor
payload to emulate: the body _is_ our normalized event. The schema _is_ the
projection, so a body outside the shape — or one that is not JSON at all —
throws `UpstreamContractError`, the same discipline the Cashfree adapter uses.
Zod strips unknown keys, so a body carrying extras still parses down to exactly
the port's event.

With no `webhookSecret` configured the provider uses the exported, stable
constant `MEMORY_PAYMENT_WEBHOOK_SECRET` so two independently constructed
instances interoperate (sign on one, verify on the other). It is deliberately
low-entropy and deliberately **not** a credential — the memory provider is only
ever selectable outside production.

### 3. The three unpinned port methods get a documented, deterministic behaviour

`fetchStatus`, `normalizeStatus` and `normalizeFailureCategory` are on the port
and no pin drives them (ADR-0383 §"Open items"), so the GREEN gives each a
deterministic, documented answer instead of a throw:

- `fetchStatus` reports `{ status: "active", mandateStatus: "active" }`: the
  provider holds no state, and a ref it minted is the path an e2e drives.
- `normalizeStatus` reads **our own** subscription-status vocabulary and derives
  the mandate axis from a `ReadonlyMap` (never an object computed key — the same
  reason ADR-0381 chose maps), conservatively defaulting an unrecognised value
  to `incomplete`/`pending` so nothing is silently granted entitlements.
- `normalizeFailureCategory` is the identity over our own four categories,
  defaulting an unrecognised value to `technical` — the Cashfree adapter's
  fail-safe default (§14.4).

### 4. The selector fails closed for a non-memory selection

`getPaymentProvider()` mirrors `getMessageTransport()`: it reads the selection
through `getConfig()` (never `process.env`) and maps `memory` onto the memory
adapter with `env: "sandbox"` (`getConfig()` refuses `memory` under
`APP_ENV=production`, so a memory provider is only ever built for a
non-production process). Any other selection throws
`ConfigError(["PAYMENT_PROVIDER"])`: there is no Stripe adapter, and the
Cashfree adapter needs `CASHFREE_*` runtime wiring that does not exist yet, so a
provider that cannot be built must not be constructed — the deploy posture of
`getRateLimitConfig()` (refuses `redis` without Upstash credentials) and
`getMessageTransport()` (refuses a non-memory transport without a
`NOVU_API_KEY`). **OP-107 owns the production wiring**, including whether
`PAYMENT_PROVIDER=stripe` (the value `e2e/start-production-server.mjs` sets)
ever builds anything.

The production refusal the card cares about is by construction: the selector
cannot bypass the validator, so no `process.env`-reading implementation can
hand a process-local provider to a production deploy.

## Consequences

- The 16 pins in `apps/web/src/test/unit/payments-memory-provider.test.ts` (12)
  and `apps/web/src/server/payments/get-payment-provider.test.ts` (4) are green;
  the existing provider-selection specs (`config/env.test.ts`,
  `config/env-example.test.ts`, `message-transport-provider.test.ts`, both
  Cashfree unit specs) stay green.
- `PaymentProviderKey` is now `"cashfree" | "memory"` (§11.1). Every ref the
  memory adapter mints is tagged `memory`, so OP-108's webhook lookup can never
  attribute a simulated event to a vendor that was never called.
- OP-107 E1 and OP-108 E1 can now be written against a concrete signer and a
  concrete selector with no network and no vendor sandbox.
- The memory spec cross-checks the shared signature scheme against the Cashfree
  adapter and its factory, so a future refactor of the scheme breaks both specs
  — intentional: it is one contract.

### Coverage note (handoff gap, not a gate to weaken)

`fetchStatus`, `normalizeStatus` and `normalizeFailureCategory` are implemented
but **uncovered** — no pin calls them. The file measures 42/47 lines, 17/23
branches and 10/14 functions; the global thresholds (statements 92.27 %,
branches 80.86 %, functions 95.83 %, lines 92.76 %) all still pass unweakened.
Pinning those three methods is a request for the Test Author's **next** cycle,
not a reason to relax the gate.

### Open items (unchanged from ADR-0383)

- A non-memory selection outside production (`PAYMENT_PROVIDER=stripe`) fails
  closed here; OP-107 owns the production wiring that replaces the throw.
- How the e2e process learns `MEMORY_PAYMENT_WEBHOOK_SECRET` (a shared import,
  or an env key threaded through `config/env.ts` + `playwright.config.ts`) is
  OP-108's call. The constant is exported for that to be a one-line import.
- A moving `expiresAt` for the memory checkout link needs a clock; nothing in
  this card's pins asked for one.

## Alternatives

- **`expiresAt = Date.now() + ttl`.** Rejected: ADR-0383 §1 forbids the wall
  clock, and it would make a replayed checkout non-deterministic in production
  time even though the pins pass under frozen fake timers.
- **A mutable `Map` of idempotency keys → refs.** Rejected: deriving the payment
  id from the key is smaller, needs no state, and survives an instance being
  rebuilt between a retry and its replay.
- **A hand-rolled validator instead of a Zod schema for `parseWebhook`.**
  Rejected: the schema _is_ the pinned event shape, it strips unknown keys for
  free, and it keeps the wire contract declared in one place — the style the
  Cashfree adapter's `schemas.ts` already set.
- **Building a Cashfree provider for a non-memory selection.** Rejected for now:
  no `CASHFREE_*` wiring exists and no pin drives it; a fail-closed
  `ConfigError` names the missing decision instead of constructing a provider
  that cannot make its first call.

## Evidence (GREEN)

- Pins: `pnpm vitest run --project unit payments-memory-provider.test.ts
get-payment-provider.test.ts` → **16 passed (16)**, 2 files.
- Full unit project: **106 files / 1816 tests passed**; integration: **73 files
  / 521 tests passed**; combined coverage run **179 files passed**, exit `0`,
  thresholds not weakened.
- `pnpm typecheck` exit `0` on all three projects; `eslint` 0 problems and
  `prettier --check` clean on the three touched production files.
- No test, mock, fixture or factory was edited. The diff is three production
  modules, this ADR and the README ledger cells.
