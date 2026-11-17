# ADR-0420 — OP-107 RED: the checkout mandate flow — returnUrl allow-list, subscription decision table, 201 envelope

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-107 RED (`t_98bf1d99`) · **Branch:** `wt/t_98bf1d99` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_98bf1d99`
- **Relates to:** [ADR-0400](ADR-0400-op106-subscription-read-red.md) / [ADR-0401](ADR-0401-op106-subscription-read-green.md) (the subscription row this mutation creates), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the `PaymentProvider` port and the Cashfree adapter the route calls), [ADR-0280](ADR-0280-op101-tenant-members-red.md) (the owner-only gate), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the reusable tenant stage), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (checkout, upgrade, downgrade, cancel), §0.5 (envelopes), §0.9 (idempotency), §0.15 (never-return), §0.12 (`Location` on `201`), Appendix A.4/A.2 (the error rows) · **Schema:** §14.1, §14.3 · **Billing doc:** §4.1

## Context

OP-107 is the story that turns a workspace into a paying one: the tenant owner
subscribes to a paid tier through a **hosted mandate flow**. §3.3 names the
endpoint and pins the shape:

```
POST /api/v1/tenants/{tenantId}/billing/checkout   (user:complete, owner, Idempotency required)
{ "planKey": "starter", "priceKey": "starter-monthly-inr", "returnUrl": "https://openpic.in/billing/return" }
→ 201 { subscriptionId, status: "incomplete", checkout: { kind, url, expiresAt }, paymentMethodKind, amountMinor, currency }
```

with three documented refusals — an off-allow-list `returnUrl` (`422
invalid_return_url`), a live subscription (`409 subscription_already_active`) and
a sales-assisted tier (`422 plan_not_self_serve`) — and one hard rule that
shapes the whole design: **a landing on the return URL is not proof of success;
only a verified webhook may move the subscription to `active`.**

The card pins only observable behaviour:

- `U1` `returnUrl` allow-list validation (subdomain tricks, userinfo, `http`);
- `U2` the existing-subscription decision table;
- `I1` the happy path against the MSW Cashfree mock → an `incomplete` document
  carrying `externalRefs` and the `201` envelope; `I2` `enterprise` → `422`;
  `I3` a live subscription → `409`; `I4` a provider `500` → `502` with the row
  `expired` and a retry that succeeds; `I5` a replay under the same
  `Idempotency-Key` calls the provider exactly once; `I6` a non-owner member →
  `403`;
- `E1` checkout through the **memory** provider returns a checkout URL and
  `GET /subscription` shows `incomplete`.

It does not pin module paths, where the allow-list comes from, how the existing
row is classified, how the provider is selected, or the exact stored document.
The sibling GREEN card `t_5f08f665` narrows most of it (the route path, the
`user:complete` + owner + idempotency-required pipeline, "insert `incomplete`
first, then call the provider", "on failure set `expired` so the unique index
does not block the retry", the `201` + `Location` envelope, and "state only
changes to `active` via webhook"). This record fixes the rest.

## Decision

### Module contract

| Module (specifier)                                                     | Exports                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/app/api/v1/tenants/[tenantId]/billing/checkout/route`               | `POST` — `userAuth()` + `tenantStage()` + `idempotencyStage({ required: true })` + a `write.normal` rate limit; the bare §3.3 envelope with `Location` |
| `@/server/services/subscriptions/checkout` (re-exported by the barrel) | `isAllowedReturnUrl`, `decideExistingSubscription`, the `ExistingSubscriptionFacts` / `ExistingSubscriptionDecision` types and the checkout schemas    |
| `@/server/payments/get-payment-provider` (OP-105 follow-up)            | `getPaymentProvider(): PaymentProvider` — extended by this lane so `PAYMENT_PROVIDER=cashfree` builds `createCashfreeProvider(...)`                    |

The route is tenant-scoped on the **string** hex `tenantId` (the
OP-103/OP-104/OP-106 convention for `subscriptions` rows), so a seeded fixture
must write `tenantId` as `tenantId.toHexString()`, never an `ObjectId`.

### 1. `isAllowedReturnUrl(url, allowedOrigins)` compares **origins**, and refuses credentials

`returnUrl` is a redirect target, so a prefix match is an open redirect. The
pure predicate takes the allow-list as an argument and accepts a URL only when
its **parsed origin** (scheme + host + port) is a member of the list, and only
when the URL carries no `username`/`password`:

| Input (allow-list `https://app.openpic.in`, `https://openpic.in`) | Accepted | Why                                               |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------- |
| `https://app.openpic.in/billing/return`                           | ✔        | exact origin                                      |
| `http://app.openpic.in/billing/return`                            | ✘        | scheme downgrade; the origin differs              |
| `https://app.openpic.in.evil.com/billing/return`                  | ✘        | suffix host: a `startsWith` check would accept it |
| `https://app.openpic.in@evil.com/billing/return`                  | ✘        | userinfo: a `startsWith` check would accept it    |
| `https://user:secret@app.openpic.in/billing/return`               | ✘        | credentials in the URL are never legitimate here  |
| `https://evil.openpic.in/billing/return`                          | ✘        | a non-allow-listed subdomain                      |
| `https://app.openpic.in:8443/billing/return`                      | ✘        | port is part of the origin                        |
| `/billing/return`, `javascript:…`, `""`                           | ✘        | not an absolute http(s) URL with an origin        |
| **no origins configured at all**                                  | ✘        | an empty allow-list accepts nothing (fail closed) |

The allow-list is `config.app.allowedOrigins` (the validated `ALLOWED_ORIGINS`)
— the app's own frontend origin, which is where a billing return page lives. No
new environment variable is introduced.

### 2. The existing-subscription decision table

`decideExistingSubscription(facts, now)` reads the workspace's current
`subscriptions` row (or `null`) and returns a discriminated union. A row is
**live** when `cancelledAt === null` **and** its `status` is not
`cancelled`/`expired` — exactly the predicate the `subscriptions_active_tenant_unique`
partial index encodes today (`partialFilterExpression: { cancelledAt: null }`).

| Row state                                                                       | Decision                             |
| ------------------------------------------------------------------------------- | ------------------------------------ |
| no document                                                                     | `start`                              |
| `cancelled` (terminal, `cancelledAt` set)                                       | `start`                              |
| `expired` (terminal)                                                            | `start`                              |
| live, `status === "incomplete"`, stored link `expiresAt > now`                  | `reuse { subscriptionId, checkout }` |
| live, `status === "incomplete"`, link `expiresAt <= now` (**boundary = stale**) | `restart { subscriptionId }`         |
| live, `status === "incomplete"`, no stored link                                 | `restart { subscriptionId }`         |
| live, `status ∈ {active, past_due, downgraded}`                                 | `blocked { subscriptionId, status }` |

`reuse` is what makes a double-submit of a still-valid checkout idempotent
without a second mandate; `restart` names the stale row so the route retires it
**before** inserting the new one (the unique partial index would otherwise
reject the insert); `blocked` is the §3.3 `409`.

### 3. The stored row is written **before** the provider is called

The pins require an `incomplete` document to exist after a successful call and
an `expired` document to exist after a `500`, so the sequence is: resolve the
decision → insert `incomplete` (status history entry `to: "incomplete"`) →
`provider.createMandate(...)` → store `externalRefs` plus the hosted link and
its expiry → answer `201`. A provider failure parks the row at `expired`
(terminal, so it no longer occupies the one-live-row slot) and answers
`502 upstream_unavailable` with `retryable: true`, which is what makes the
retry work.

### 4. Vendor selection is env-driven, so MSW can intercept the adapter

The integration suite drives the **route**, so the route must obtain its
provider from `getPaymentProvider()` — the composition root OP-105's follow-up
lane added and whose header already states that "OP-107 owns the production
wiring". Two configuration facts are therefore part of this lane's contract:

- `cashfree` joins `PROVIDER_SPECS.PAYMENT_PROVIDER` in
  `@/server/config/env` (`memory`, `stripe`, **`cashfree`**);
- `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_API_VERSION` and
  `CASHFREE_WEBHOOK_SECRET` are read for the adapter config, reusing the names
  the OP-105 live-sandbox helper already establishes.

With `PAYMENT_PROVIDER=cashfree` the adapter is built for `sandbox`, so the
suite can intercept `https://sandbox.cashfree.com/pg/subscriptions` with MSW.
Without that selection the route cannot be driven against a vendor at all —
which is precisely the "no mocked internal boundary" rule.

### 5. The e2e boot must seed the plan catalogue

`E1` runs against a real `next start` server whose database is empty
(`e2e/start-server.mjs` boots a bare `MongoMemoryReplSet`), and the checkout
resolves the sold price from the `plans` collection. The e2e boot therefore
needs a catalogue seed on the `APP_ENV === "e2e"` branch of
`src/instrumentation.ts`, exactly as the notification catalogue is already
seeded there (ADR-0131). Without it, `starter` has no plan to resolve and `E1`
answers `422`.

### 6. No vendor field ever reaches the response

The `201` body is the §3.3 envelope verbatim — `subscriptionId`, `status`,
`checkout.{kind,url,expiresAt}`, `paymentMethodKind`, `amountMinor`, `currency`
— and the pins assert both the absence of `externalRefs`/`_id` and that the
serialized body matches nothing shape-`cashfree` (§0.15). The provider refs live
in the document, where a webhook can find them.

## Assumptions and open questions

- **The allow-list is `config.app.allowedOrigins`.** §3.3 says "an allow-listed
  origin" without naming the list; the app's own frontend origin is the only
  list the deployment already has. If a dedicated
  `BILLING_RETURN_ORIGINS` is wanted, the change is one line in the route and
  the unit pin (which takes the list as an argument) is unaffected.
- **The vendor plan reference is the sold price's `externalRefs[].id`**
  (`STARTER_MONTHLY_V1` for `starter-monthly-inr`). ADR-0001/ADR-0380 confine the
  vendor name to `plans.prices[].externalRefs`, so the mapping has to flow from
  there; the pin asserts the outgoing `plan_details.plan_id`.
- **`expiresAt` is normalized to an RFC 3339 UTC `Z` timestamp on the wire.** The
  fixture is seeded in that shape on purpose: OP-105's review F1 routed the
  adapter-side normalization (`t_5547cab6`) elsewhere, so this lane must not
  depend on the vendor's `+05:30` string surviving to the envelope.
- **`invalid_return_url`, `plan_not_self_serve`, `subscription_already_active`
  and `upstream_unavailable` are Appendix A codes the server catalogue does not
  carry yet.** The GREEN owes a `BILLING_ERROR_CODES` set plus transport table in
  the `cannot_demote_owner` shape (ADR-0261): `422`/`422`/`409`/`502(retryable)`,
  with `details` `{ allowedOrigins }` / `{ contactSalesUrl }` /
  `{ subscriptionId, status }` / `{ provider, retryAfterSeconds }`.
- **`reuse` answers `201`, not `200`.** §3.3 does not say; the decision table is
  unit-pinned and the integration suite deliberately does not pin the status of a
  reuse, so the GREEN may choose `200` without breaking a pin.
- **Out of scope, deliberately:** `upgrade`/`downgrade`/`cancel`/`retry-charge`
  and the remaining §3.3 verbs; the `billing.mandate.pending` domain event and
  the `billing.checkout.created` log line (not in the card's test list, and the
  route-level suites have no log sink to assert against); the planned-add-on
  checkout (§3.6); webhook projection (§7); and rate-limit values (`write.normal`
  is composed but not pinned here — OP-79 owns the limiter's contract).

## Consequences

- A `returnUrl` that merely _looks_ allow-listed (`app.openpic.in.evil.com`,
  `app.openpic.in@evil.com`, a plain-`http` downgrade, embedded credentials) now
  fails with a named table row rather than silently redirecting.
- A second checkout while a mandate is still pending reuses the stored link
  instead of minting a second mandate; a stale one is retired rather than
  blocking the workspace forever; a live paid subscription is a `409`.
- A provider outage leaves the workspace **unblocked**: the `502` is explicit
  (`retryable: true`), the row is terminal, and the retry is a pin — so "a
  failure leaves no blocking doc" is enforced, not asserted in prose.
- The idempotency pin is measured at the **external** boundary (MSW call count),
  so a replay that re-runs the handler — but happens to return the same body —
  cannot pass.
- The lane also pins two cross-lane prerequisites it cannot implement itself:
  `cashfree` in the provider selection and the e2e catalogue seed. Both are named
  in the handoff so the GREEN does not discover them by failing.
- **Red state at handoff (evidence):** with throwaway stubs at the two intended
  paths (deleted before handoff) `npx tsc -p apps/web/tsconfig.json --noEmit`
  exited `0` (with `cashfree` temporarily added to `PROVIDER_SPECS`), and the
  specs failed at assertion level: unit `20 failed | 6 passed (26)` (the six
  passes are the three `start` rows and the three positive allow-list rows a
  stub returning `true`/`start` cannot fail), integration `12 failed (12)` with
  `expected 500 to be 201/422/409/403/404/400`. At handoff the specs are red as
  missing modules — `Cannot find package '@/server/services/subscriptions/checkout'`
  and `Cannot find package '@/app/api/v1/tenants/[tenantId]/billing/checkout/route'`
  — and ESLint is clean on all three new files (0 problems), as is
  `prettier --check`. The full unit project is otherwise green (106 files /
  1843 passed + 3 skipped) and the full integration project likewise (75 files /
  536 passed); the only failing file in each is this lane's new spec.

## Alternatives considered

- **`returnUrl.startsWith(origin)`.** Rejected: it is the open-redirect bug the
  card's U1 names (`…openpic.in.evil.com`, `…openpic.in@evil.com` both pass).
- **Accept any `https` URL and validate later at redirect time.** Rejected: the
  redirect is rendered by the client; by then the damage is done, and §3.3 puts
  the `422` on the request.
- **Insert the `incomplete` row only after the provider answers.** Rejected: it
  inverts the race — two concurrent checkouts would both call the provider, and
  the unique partial index could no longer be the arbiter.
- **On failure, delete the row instead of parking it at `expired`.** Rejected:
  the document is billing history (`statusHistory` answers "why is this tenant on
  free?"), and §3.3's own vocabulary already has the terminal `expired` state.
- **Let the route build the Cashfree adapter directly from `process.env`.**
  Rejected: it bypasses the `getPaymentProvider()` composition root, breaks the
  `no-process-env`-outside-config boundary, and would leave the e2e memory
  selection untestable.
- **Skip the e2e catalogue seed and let E1 buy a "free" tier.** Rejected: `free`
  has no prices and no mandate; the story is buying a paid tier, and a checkout
  that only works for a tier nobody buys proves nothing.

## ADR number allocation

The `OP-107` lane had no reserved range on `main`, so — as the first card of the
lane — it draws the next block from the allocator's `unallocated (future lanes)`
pool: **`0420`–`0439`**, consuming `0420` for this record (the same move
OP-102/OP-103/OP-104/OP-105/OP-106 made for their lanes; ADR-0300 §7). Per that
policy a **dependent** ticket does not continue its parent's range: OP-106 holds
`0400`–`0419` with `Next free = 0402`, and this lane takes the pool's next free
block. The README table gains an `OP-107 checkout lane` row with
`Next free = 0421`, and the pool row advances to `0440`+. No number outside the
block is touched, and the frozen pre-policy numbers are left alone.
