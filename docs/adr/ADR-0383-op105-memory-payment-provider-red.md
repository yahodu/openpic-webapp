# ADR-0383 — OP-105 follow-up RED: the in-process memory payment provider for e2e — deterministic mandate/charge, the shared webhook signer, and the `getPaymentProvider` composition root

- **Status:** Accepted · **Date:** 2026-10-25 · **Renumbered:** cut as `0382`, moved to `0383` (the OP-105 live-sandbox lane merged `0382` to `main` first; ADR-0300 §7)
- **Card:** OP-105 follow-up TEST (`t_68faf9b3`) · **Branch:** `OP-105-task-memory-payment-provider` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_68faf9b3`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port + Cashfree adapter contract, which lists this deliverable as out of scope), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (its GREEN), [ADR-0096](ADR-0096-message-transport-factory.md) / [ADR-0105](ADR-0105-op94-notification-transport-selection.md) (`getMessageTransport`, the config-selector precedent this composition root mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.1 (verify → parse webhook order), §10.1.2 (normalized event taxonomy), §3.2 / §0.15 (`checkoutUrl` opaque, no vendor field in a response) · **Schema:** §11.1 (`externalRefs`), §14.3 / §14.4 (statuses, transaction kinds)
- **Gated children:** OP-105 follow-up GREEN `t_7dd42be8` (this lane); OP-107 RED `t_98bf1d99` E1 and OP-108 RED `t_a297e850` E1 both depend on the API pinned here

## Context

OP-105's GREEN card §9 asks for "a memory provider for e2e". ADR-0380 (§"Module
contract") declared it out of scope and owned by nobody: the port was pinned and
the Cashfree adapter implemented, but nothing in the tree can produce a
`PaymentProvider` without a network. Two already-scheduled RED cards need it:
OP-107 E1 (_"checkout via the memory provider returns a checkout url"_) and
OP-108 E1 (_"the checkout then a simulated signed webhook (memory provider
signer) → GET subscription active"_). Without it, both e2e halves are
unwritable.

Two facts about the surrounding code decide most of the design:

1. **There is no composition root yet.** ADR-0380 deliberately left
   `getPaymentProvider()` to "the GREEN/OP-107 wiring". `PAYMENT_PROVIDER`
   already accepts `memory | stripe` (`config/env.ts` `PROVIDER_SPECS`),
   `getConfig()` already refuses `memory` under `APP_ENV=production` (asserted
   by `config/env.test.ts`), and the e2e launcher (`e2e/start-server.mjs`) sets
   only `APP_ENV=e2e` — so `PAYMENT_PROVIDER` defaults to `memory` there.
2. **The signature scheme is already pinned and verifiable.** ADR-0380 fixed
   `base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody))` over the raw
   bytes with a ±300 s window in `createCashfreeProvider.verifyWebhook`. Reusing
   that exact scheme is what lets an e2e mint a webhook the _same_ verifier a
   production adapter would accept, and it lets the pins cross-check the two
   implementations against each other instead of restating the algorithm.

## Decision

### Module contract

| Module (specifier)                          | Exports                                                                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/adapters/memory-payment-provider` | `memoryPaymentProvider(config?: MemoryPaymentProviderConfig): MemoryPaymentProvider`; the `MemoryPaymentProvider` (port + `signWebhook`) and `MemoryPaymentProviderConfig` (`{ env?: PaymentEnvironment; webhookSecret?: string }`) types |
| `@/server/payments/get-payment-provider`    | `getPaymentProvider(): PaymentProvider` — the config-driven composition root (`@/server/payments/get-payment-provider.test.ts` pins it)                                                                                                   |

`getPaymentProvider()` is **synchronous** and mirrors `getMessageTransport()`:
it reads the validated selection through `getConfig()` (never `process.env`
directly) and maps `memory` onto the memory adapter.

### 1. `createMandate` answers the port's vocabulary only

Every field is a function of the input, never of the wall clock or randomness:
two calls with the same `CreateMandateInput` return deeply-equal results
(deterministic `checkoutUrl`, `externalRefs`, `expiresAt`). The result carries
exactly the port's three fields and the single ref carries exactly the port's
four (`provider`, `env`, `kind`, `id`) — a vendor-named field, or the string
`cashfree`, anywhere in the result fails the pin.

### 2. `chargeOnce` is idempotent under the caller's key

The answer is a single `kind: "payment"` ref in the _configured_ environment,
derived from the caller's `idempotencyKey`: replaying one key returns the same
ref, a different key returns a different payment id. That mirrors ADR-0381 §7
(nothing retries automatically) while making a retry at the route boundary
(OP-107 I5) observably free of double charges.

### 3. The webhook signer shares the vendor scheme; the wire format is our own event

- `signWebhook(rawBody, timestamp?)` returns the `x-webhook-timestamp` /
  `x-webhook-signature` header pair of the ADR-0380 scheme; the timestamp
  defaults to `Date.now()`. The pins prove interop **in both directions**: a
  memory signature is accepted by `createCashfreeProvider(...).verifyWebhook`,
  and a signature built by the Cashfree test factory is accepted by
  `memoryPaymentProvider(...).verifyWebhook`.
- `verifyWebhook` rejects a re-serialised (tampered) body, a missing signature
  header, and a timestamp older than the same ±300 s window.
- **There is no vendor to emulate, so the raw webhook body _is_ our normalized
  event**: `JSON.stringify(<NormalizedProviderEvent with provider "memory">)`.
  `parseWebhook` validates that shape and answers it; a non-JSON body or a body
  outside the shape throws (the adapter's `UpstreamContractError` discipline).
  This is the contract OP-108's E1 signs and posts.
- With no `webhookSecret` configured the provider uses a **stable default**, so
  two independently constructed instances interoperate (sign on one, verify on
  the other). How the e2e process learns that secret is OP-108's wiring
  problem — see "Open items".

### 4. `PaymentProviderKey` gains `"memory"`

`externalRefs[].provider` is the key of the _registered adapter_ (§11.1), and
the memory provider is the registered adapter for a `PAYMENT_PROVIDER=memory`
selection, so its refs are tagged `provider: "memory"` (never `"cashfree"`, or
the webhook lookup in OP-108 would attribute an e2e event to a vendor that was
never called). The GREEN must widen the union
`PaymentProviderKey = "cashfree" | "memory"`.

### 5. The selector refuses `memory` in production by construction

Under `APP_ENV=e2e`/`development` with `PAYMENT_PROVIDER=memory` — or with the
variable unset, which is the documented default and exactly what the e2e
launcher does — `getPaymentProvider()` returns the memory provider. Under
`APP_ENV=production` with `PAYMENT_PROVIDER=memory` it throws the
`ConfigError` naming `PAYMENT_PROVIDER`. The existing
`config/env.test.ts` refusal stays green; the new pin adds the property that
matters for honesty: the selector cannot bypass the validator, so no
`process.env`-reading implementation can ever hand a process-local provider to
a production deploy.

## Consequences

- The GREEN card `t_7dd42be8` implements the two modules above; the pins in
  `apps/web/src/test/unit/payments-memory-provider.test.ts` (12) and
  `apps/web/src/server/payments/get-payment-provider.test.ts` (4) become the
  executable acceptance criteria and must not be edited.
- OP-107 E1 and OP-108 E1 can be written against a concrete signer and a
  concrete selector, without a network and without a vendor sandbox.
- The pins cross-check the memory provider against the _Cashfree_ adapter and
  its factory, so a future refactor of the shared signature scheme breaks the
  memory spec too — that is intentional (the scheme is one contract).
- **No new contract at the port.** This ADR records no change to what a
  `PaymentProvider` must do; it fixes the _second implementation's_ API, wire
  format and selection, which ADR-0380 left open by design.

### Open items (deliberately not pinned)

- `fetchStatus`, `normalizeStatus` and `normalizeFailureCategory` are on the
  port, so the memory provider must implement them, but no pin in this card
  drives them; the GREEN should give them a documented, deterministic behaviour
  rather than throwing.
- A non-memory selection outside production (`PAYMENT_PROVIDER=stripe` — the
  value `e2e/start-production-server.mjs` uses) is undefined here: there is no
  Stripe adapter and the Cashfree adapter needs `CASHFREE_*` runtime wiring that
  does not exist yet. The GREEN must decide it (recommended: fail closed with a
  `ConfigError`, mirroring `getMessageTransport` without `NOVU_API_KEY`) and
  OP-107 owns the production wiring.
- How the e2e process obtains the memory provider's default webhook secret
  (a shared constant, or a new env key threaded through `config/env.ts` +
  `playwright.config.ts` like `UNSUBSCRIBE_SIGNING_SECRET`) is OP-108's call.

## Alternatives

- **Tag memory refs `provider: "cashfree"`.** Rejected: it would make an e2e
  event indistinguishable from a real vendor callback at the §11.1 index, which
  is precisely what the `provider` key exists to prevent.
- **Give the memory provider a vendor-shaped webhook payload** (reusing the
  Cashfree schema). Rejected: it drags a vendor wire contract into a
  no-vendor module and would make OP-108 test the mapping table twice.
- **Let `getPaymentProvider()` read `process.env.PAYMENT_PROVIDER` directly.**
  Rejected: it would construct a memory provider under `APP_ENV=production`,
  silently defeating the validator — the honesty risk this card is required to
  close.
- **Make `createMandate` mint a fresh random id per call** (as the Cashfree
  adapter does). Rejected: the card asks for a deterministic result, and an e2e
  that re-enters checkout needs a stable reference.

## Evidence (RED, probe with temporary stubs — stubs deleted before handoff)

- With throwaway stubs at the two intended paths, `tsc -p apps/web/tsconfig.json
--noEmit` exits `0` (the pins are type-correct against the intended contract).
- The 16 pins then fail at **assertion level**, not as harness errors:
  `expected 'cashfree' to match object { provider: 'memory', kind: 'subscription' }`,
  `expected NaN to be 1792924295000`, `expected false to be true`,
  `expected undefined to be instance of ConfigError`, and
  `Error: stub` for `parseWebhook`. Two negative pins (tampered body / bad body)
  pass against a stub that rejects everything — their Green comes from the real
  implementation validating, and they are the only two that can pass for a
  degenerate reason.
- Stubs removed: `git status` shows only the two new spec files; the suite is
  the honest module-not-found red (`Cannot find package
'@/server/adapters/memory-payment-provider'`) that ADR-0380's RED also
  recorded.
- Baseline unaffected: `config/env.test.ts`, `config/env-example.test.ts`,
  `message-transport-provider.test.ts` and both Cashfree unit specs — **135
  passed (135)** — and the full unit project is `2 failed | 104 passed (106)
files`, `16 failed | 1800 passed (1816) tests`, i.e. only the new specs fail.
- `prettier --check` clean, ESLint 0 problems on both new files.
- No production file is touched (diff: two test files, this ADR and the README
  ledger cells only).
