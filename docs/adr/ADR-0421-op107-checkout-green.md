# ADR-0421 — OP-107 GREEN: the checkout route, env-driven vendor selection, and three pins the fixtures cannot express

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-107 GREEN (`t_5f08f665`) · **Branch:** `OP-107-task-billing-checkout-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_98bf1d99`
- **Relates to:** [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) (the RED contract this record implements), [ADR-0383](ADR-0383-op105-memory-payment-provider-red.md) / [ADR-0384](ADR-0384-op105-memory-payment-provider-green.md) (the composition root this lane extends), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the port and the vendor adapter), [ADR-0400](ADR-0400-op106-subscription-read-red.md) (the `subscriptions` row this mutation creates), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (checkout, upgrade, downgrade, cancel), §0.5, §0.9, §0.11, §0.12, §0.15, Appendix A.2/A.4 · **Schema:** §13.1, §14.1, §14.3

## Context

OP-107 RED ([ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md), commit `05a88aa`) shipped
three specs — `apps/web/src/test/unit/subscription-checkout.test.ts` (26 tests),
`apps/web/src/test/integration/billing-checkout.test.ts` (12 tests) and
`apps/web/e2e/billing-checkout.spec.ts` (1 test) — red as missing modules, and named two
cross-lane prerequisites the RED could not implement itself (`cashfree` in
`PROVIDER_SPECS.PAYMENT_PROVIDER` + the `CASHFREE_*` names; the plan-catalogue seed on the e2e
boot). This record is the GREEN: the production code those pins demand, the decisions they left
open, and **three pins that cannot be satisfied as written** (raised under the Dispute Protocol,
left red, and handed back to the Test Author with a proposed correction).

`origin/main` moved between the RED and this GREEN: PR #296 (the OP-105 memory provider +
`getPaymentProvider()`) merged, so the composition root ADR-0420 assumed already exists and is
extended here rather than duplicated.

## Decision

### 1. One route, one service module, one vendor selection

| Module (specifier)                                                     | What lands                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/services/subscriptions/checkout` (re-exported by the barrel) | `isAllowedReturnUrl`, `decideExistingSubscription`, `ExistingCheckout` / `ExistingSubscriptionFacts` / `ExistingSubscriptionDecision`, `checkoutRequestSchema`, `checkoutPaymentMethodKindSchema`, `checkoutEnvelopeSchema` + types — pure, no I/O |
| `@/app/api/v1/tenants/[tenantId]/billing/checkout/route`               | `POST` — `userAuth()` + `tenantStage()` + `idempotencyStage({ store: mongoIdempotencyStore(), required: true })` + a `write.normal` rate limit; the handler owns every read, write and provider call                                               |
| `@/server/payments/get-payment-provider` (extended)                    | the `cashfree` branch: `createCashfreeProvider({ env, clientId, clientSecret, apiVersion, webhookSecret, logger })`, with `env` derived from the validated `APP_ENV` (`production` → `production`, otherwise `sandbox`)                            |
| `@/server/config/env` (extended)                                       | `cashfree` joins `PROVIDER_SPECS.PAYMENT_PROVIDER`; a new `getPaymentsRuntimeConfig()` runtime accessor holds the four `CASHFREE_*` names                                                                                                          |
| `@/server/http/catalog` + `@openpic/contracts` (extended)              | `BILLING_ERROR_CODES` + `BILLING_ERROR_TRANSPORT` (`invalid_return_url` `422`, `plan_not_self_serve` `422`, `subscription_already_active` `409`, `upstream_unavailable` `502` **retryable**), in the `cannot_demote_owner` shape (ADR-0261)        |
| `src/instrumentation.ts` (extended)                                    | `seedPlans()` on the `APP_ENV === "e2e"` branch, inside the existing `MONGODB_URI !== undefined` guard (ADR-0131's pattern)                                                                                                                        |

The route stays the orchestration unit (it is the only layer that may touch the repository,
the clock and the provider port), and the service module stays pure so the two decisions are
pinnable without a database — which is what keeps `services/**` at its 90 % threshold.

### 2. `getPaymentsRuntimeConfig()` is a runtime accessor, not an `AppConfig` field

`config/env.test.ts` asserts the **exact** shape of `getConfig()` (`toEqual`), so the frozen
`AppConfig` cannot grow a `cashfree` block. The credentials therefore follow the established
vendor-wiring precedent (`getNovuRuntimeConfig`, `getRateLimitConfig`): an accessor in the same
module, reading `process.env`, **failing closed** with a `ConfigError` naming every missing
`CASHFREE_*` key when the vendor is selected. The adapter still receives an explicit config
object (no adapter reads `process.env`), and the provider **selection** still comes from
`getConfig()` — the honesty property `get-payment-provider.test.ts` pins.

### 3. The request order the pins force

`owner` → `returnUrl` origin → plan active/self-serve → price active + vendor ref → existing row:

- **`plan_not_self_serve` is decided before the price is resolved.** `enterprise` carries **no
  embedded prices** ("not self-serve, no prices"), so resolving the price first answers
  `422 validation_failed` and fails I2. The refusal is about the _tier_, not the price.
- A missing plan or an unsellable price (inactive, absent, or carrying no `kind: "plan"` vendor
  ref) is `422 validation_failed` with a field entry — negative-space behaviour §3.3 does not
  name, chosen here.
- A live row is `409 subscription_already_active` with `{ subscriptionId, status }`; a
  still-valid `incomplete` row **reuses** its stored link and never calls the provider; a stale
  or link-less one is retired first.

### 4. A terminal row releases the live slot by setting `cancelledAt`

The `subscriptions_active_tenant_unique` partial index is
`partialFilterExpression: { cancelledAt: null }`, so a row parked at `status: "expired"` **with
`cancelledAt` still null would keep occupying the one-live-row slot** and block the retry I4
pins. Both terminal paths (a restart retiring a stale row, and the provider-failure park) set
`cancelledAt`, `cancelReason` and a `statusHistory` entry, so "a failure leaves no blocking
document" is enforced rather than asserted.

### 5. The mandate customer is derived, with a documented phone fallback

§3.3 sends no customer in the request, so the route derives `{ name, email, phone }` from the
acting account's Better Auth `user` row (the email) and `userProfiles.displayName`. An
email-OTP account has **no phone** (`phoneNumber` is null) and the vendor contract requires a
non-empty `customer_phone`, so a missing phone falls back to `UNSET_CONTACT_PHONE`
(`"0000000000"`). This is the one place the implementation fabricates a vendor-visible value;
it is flagged below as a coverage gap.

## Disputes — three pins that cannot be satisfied as written

All three are **test-side** defects: the implementation is the general behaviour the pins
describe, but the fixtures/assertions as committed contradict themselves. Per the pipeline
rules no test, fixture or helper was edited; each dispute is left red and routed to the Test
Author.

### D1 — the unit fixture cannot express `checkout: null` (2 tests)

`apps/web/src/test/unit/subscription-checkout.test.ts`, `existing()`:

```ts
checkout: overrides.checkout ?? STORED_CHECKOUT,
```

`??` treats `null` as nullish, so `existing({ checkout: null })` returns the **default valid
link** (`expiresAt 10:15 > NOW 10:00`), not `null`. The same facts are therefore asserted to
yield two different decisions:

| Line | Case                                                       | Effective facts                 | Expected  |
| ---- | ---------------------------------------------------------- | ------------------------------- | --------- |
| 120  | "an `incomplete` row whose hosted link is still valid"     | `checkout: STORED_CHECKOUT`     | `reuse`   |
| 126  | "an `incomplete` row with no stored link"                  | **`checkout: STORED_CHECKOUT`** | `restart` |
| 165  | "names the stale row to retire when restarting a checkout" | **`checkout: STORED_CHECKOUT`** | `restart` |

No implementation can distinguish them — the produced objects are value-identical.
**Proposed correction (Test Author, one line):**
`checkout: overrides.checkout === undefined ? STORED_CHECKOUT : overrides.checkout,`.
Both red tests then pass against the implementation unchanged (verified by inspection: the
`null` branch and the `expiresAt <= now` branch are both implemented and exercised by the
"expires exactly now" case, which passes today).

### D2 — the "no vendor field" assertion contradicts the envelope pin (1 test)

`apps/web/src/test/integration/billing-checkout.test.ts:419`:

```ts
expect(JSON.stringify(payload)).not.toMatch(/cashfree/i);
```

but the same spec's first I1 test pins `checkout.url` **and** `Location` to the provider-hosted
`response.auth_link`, and the shared factory default is
`https://payments-test.cashfree.com/links/test-001` — a vendor-hosted URL containing the vendor
name. §3.3/§3.2 make that URL opaque and provider-hosted (`"https://<provider-hosted-auth-link>"`),
so a URL-shaped `cashfree` substring is unavoidable; the assertion can only pass by not
returning the link the other test requires. Both tests use the same fixture, so the two pins
are mutually unsatisfiable.
**Proposed correction (Test Author):** either assert the §0.15 rule on _field names_
(`expect(payload).not.toHaveProperty("externalRefs")` / `_id` and no vendor-shaped key), or
override `auth_link` to a neutral host in this one test (e.g.
`makeCashfreeCreateSubscriptionResponse({ subscription_expiry_time: FIXTURE_EXPIRES_AT, auth_link: "https://psp.example.com/checkout/abc" })`).
The implementation already round-trips the link verbatim and puts no vendor field in the body.

## Dispute resolution (Test Author, card `t_7998de98`)

Both disputes are confirmed **test-side**, exactly as recorded above. Resolved on branch
`OP-107-task-billing-checkout-red` (fast-forward from `552f4b8`) **without touching production code** —
`git diff` at the resolving head touches only the two specs. Both were reproduced on `552f4b8` _before_
any edit (unit **2 failed | 24 passed (26)** — `expected 'reuse' to be 'restart'` twice, the two rows D1
names; integration **1 failed | 11 passed (12)** — `expected '{"subscriptionId":…,"url":"https://payments-test.cashfree.com/links/test-001",…}' not to match /cashfree/i`, line 419).

### R1 — D1: the fixture now distinguishes `null` from "not supplied" (fixture only, meaning unchanged)

```ts
checkout: overrides.checkout ?? STORED_CHECKOUT,            // before
checkout: overrides.checkout === undefined ? STORED_CHECKOUT : overrides.checkout,   // after
```

The pin's **meaning is unchanged**: the case descriptions ("no stored link", "names the stale row to
retire") always meant `checkout: null` → `restart`; the fixture merely could not express it, which is what
made the two cases value-identical. Both assertions now pass against the shipped
`decideExistingSubscription` unchanged (its `checkout === null` and `expiresAt <= now` branches).

**Flagged, not fixed (coverage gap).** The spec's docblock claims "the four boundary shapes of an
`incomplete` row (valid link, expired link, no link, link expiring exactly now)" but `DECISION_CASES`
carries no _expired_-link case (`expiresAt < now`) — only the `expiresAt === now` boundary, which takes the
same `restart` branch. The follow-up card pins the unit count at 26, so adding a fourth case was out of
scope; a future strengthening card should add it, or drop the claim from the docblock.

### R2 — D2: the §0.15 pin is asserted on **keys**, not on a vendor-name substring (pin meaning changed)

`expect(JSON.stringify(payload)).not.toMatch(/cashfree/i)` is replaced by the exact key set of the bare
§0.5 single resource, at both levels:

```ts
expect(keysOf(payload)).toEqual([
  "amountMinor",
  "checkout",
  "currency",
  "paymentMethodKind",
  "status",
  "subscriptionId",
]);
expect(keysOf(payload.checkout)).toEqual(["expiresAt", "kind", "url"]);
```

Why the key set, and not the offered alternative (overriding `auth_link` to a neutral host):

1. **§0.15 / CONVENTIONS §8.1 are rules about fields.** Their vocabulary is "provider API keys, webhook
   secrets, `externalRefs[].meta`", "raw upstream provider payloads and provider-side ids" — a projection
   rule. A vendor _name inside a value_ is a violation only when that value is a provider payload or a
   provider id; `checkout.url` is the §3.3 provider-hosted auth link, which §3.2/§3.3 mandate as opaque and
   vendor-hosted. The deleted sweep asserted the **opposite** of the contract — it could pass only by not
   returning the link I1 pins.
2. **The sweep was blind to the leak shapes that matter.** `cf_subscription_id` / `cf_payment_id` are the
   real Cashfree-side ids; neither the key nor a realistic value contains the substring `cashfree`, so the
   sweep would have passed a body carrying them, while the key set fails on _any_ extra key.
3. **It keeps the fixture representative.** Overriding `auth_link` to `psp.example.com` would leave a
   fixture no code path produces, to preserve an assertion that can only ever fire on the mandated URL.

**Mutation probe — the replacement pin fires.** Widening `checkoutEnvelopeSchema` to admit
`cf_subscription_id` and returning it from the handler puts the key on the wire, and the pin fails exactly
as intended (a leak class the deleted sweep would have let through silently):

```text
AssertionError: expected [ 'amountMinor', …(6) ] to deeply equal [ 'amountMinor', 'checkout', …(4) ]
  [
    "amountMinor",
+   "cf_subscription_id",
    "checkout",
```

The first probe (the same key returned with the schema **unchanged**) never reaches the wire: the
pipeline's `serializeResponse` validates every object schema with `.strict()`, so outside production it
**throws** and the route answers `500`, and in production it logs `http.response.serialization_failed` and
serves the body stripped. That is the layering this pin backs up: the serializer covers a misbehaving
handler, the key set covers a **widened envelope schema** — which is the only way an extra field can reach
a client. Both probes were reverted (`git diff` on `route.ts` / `checkout.ts` empty afterwards).

### Verification at the resolving head

| Command                                                                                                              | Result             |
| -------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npx vitest run --project unit apps/web/src/test/unit/subscription-checkout.test.ts`                                 | **26 passed (26)** |
| `TMPDIR=/root/tmp-mongo npx vitest run --project integration apps/web/src/test/integration/billing-checkout.test.ts` | **12 passed (12)** |
| `npx vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                                         | **29 passed (29)** |
| `npx prettier --check` on both corrected specs                                                                       | clean              |

No `ADR-0422` is drawn and no number is consumed: R1 changes no pin meaning and R2 changes one assertion
inside an existing pin, so this section is the whole ledger entry (the lane's `Next free` stays `0422`).

## Evidence at this head

While D1/D2 stand, the suite is **green except those three pins** (the whole lane, run
unedited):

- unit `subscription-checkout.test.ts` **24 passed | 2 failed (26)** — only D1;
- full unit project **108 files passed | 1 failed (109)**, **1883 passed | 2 failed | 3 skipped (1888)**;
- integration `billing-checkout.test.ts` **11 passed | 1 failed (12)** — only D2;
- full integration project **75 files passed | 1 failed (76)**, **547 passed | 1 failed (548)**;
- e2e `billing-checkout.spec.ts` (project `api`, real `next start` + the **memory** provider)
  **1 passed (1)** — the plan seed, the `current` alias, the middleware and `GET /subscription`
  → `incomplete` all work end to end;
- `pnpm typecheck` exit `0` (all three projects); `pnpm lint` **0 errors** (105 pre-existing
  `security/detect-*` warnings, none in the new files); `pnpm format:check` clean;
  `adr-numbering` guard green;
- combined coverage run exits on the two D1 failures but reports, with
  `--coverage.reportOnFailure=true`, **statements 92.31 % / branches 81.06 % / functions 95.86 %
  / lines 92.78 %** — every gate above its threshold (`services/subscriptions/checkout.ts`
  96.42 % lines / 100 % branches against its 90 % glob), so the disputed pins are the only
  thing standing between this head and a green lane.

## Assumptions and open questions

- **The allow-list is `config.app.allowedOrigins`** (ADR-0420's assumption, unchanged), compared
  by **normalized origin** with credentials refused.
- **`paymentMethodKind` is `mandate_upi`** — §3.3's example and the only hosted-mandate kind the
  self-serve tiers sell; the request carries no preference.
- **The vendor plan reference is the sold price's `kind: "plan"` `externalRefs[].id`**
  (`STARTER_MONTHLY_V1`), per ADR-0001's confinement of vendor names to `plans.prices[]`.
- **`checkout.expiresAt` is normalised to RFC 3339 UTC `Z`** on the wire and stored as a `Date`,
  so a vendor `+05:30` string never reaches the envelope (ADR-0420 §4).
- **`contactSalesUrl` is `/contact-sales`** — §3.1's example target, not a new env var.
- **`reuse` answers `201`** (ADR-0420 left the status open; the unit pin only covers the
  decision).
- **The phone fallback** (Decision §5) is the one fabricated vendor value; a product that
  collects a verified phone should replace it with a refusal.
- **Out of scope, deliberately:** `upgrade`/`downgrade`/`cancel`/`retry-charge` (§3.3's other
  verbs), the `billing.mandate.pending` domain event (this route logs `billing.checkout.created`
  as the card requires; the event belongs to the webhook/inbox lane), the webhook projection
  (OP-108), and rate-limit tuning (OP-79 owns `write.normal`).

## Coverage gaps handed to the Test Author

- The **mandate customer provenance** is unpinned: no test asserts what `customer_details` the
  vendor receives, so the display-name → account-name → fallback ladder and the phone fallback
  are unverified.
- **Non-`incomplete` restart** and **`reuse`** are unpinned at the route level (only the pure
  decision table covers them).
- **The plan-not-found / unsellable-price refusals** (§3.3's negative space) and the
  **plan-catalogue seed at the e2e boot** have no dedicated pin.
- **`getPaymentsRuntimeConfig()`'s fail-closed path** (a `cashfree` selection missing a
  `CASHFREE_*` key) is unpinned.

## Consequences

- The checkout now works against a real vendor adapter behind MSW **and** against the in-process
  memory provider through a real `next start` server, selected by configuration rather than by a
  test-only branch.
- A provider outage leaves the workspace unblocked and the retry is a measured pin (the row is
  terminal _and_ the partial-index slot is released by `cancelledAt`).
- The lane cannot be declared green until D1/D2 are corrected — **both are now resolved, see
  § Dispute resolution** (card `t_7998de98`, same branch, no production-code change); the OP-108 lane
  (which drives a signed webhook onto the row this route creates) should not start from a head carrying
  red pins, and the correcting head carries none.

## Alternatives considered

- **Serving a platform-owned redirect URL as `checkout.url` to avoid the vendor name in the
  body.** Rejected: §3.3 makes the URL the provider-hosted auth link and both I1 pins assert
  equality with the adapter's `auth_link`; D2 is an assertion/fixture defect, not a design gap.
- **Resolving the price before classifying the tier.** Rejected by I2: `enterprise` embeds no
  prices, so the price error would mask the tier's `422 plan_not_self_serve`.
- **Adding a `cashfree` block to `AppConfig`.** Rejected: `config/env.test.ts` asserts the exact
  shape, and vendor wiring is a runtime accessor by precedent (`getNovuRuntimeConfig`).
- **Deleting the failed row instead of parking it at `expired`.** Rejected (ADR-0420): the
  document is billing history and `expired` is already §3.3's terminal vocabulary.
- **Extracting the orchestration into `services/**`.** Deferred: that glob carries a 90 %
  threshold, and the route-level integration suite is what covers the branchy I/O paths; the
  split can follow once those paths are pinned.

## ADR number allocation

The OP-107 lane holds `0420`–`0439` (`Next free` was `0421` on this base). This record consumes
`0421` — the cell's value re-read on the RED head immediately before committing — and the lane's
`Next free` advances to `0422`. No number outside the lane range is touched, and the pool cell
(`0440`+) is unchanged.
