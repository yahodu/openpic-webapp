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

## Follow-up pins (card `t_aa18a7ff`) — the checkout's unpinned edges

The round-1 (artifact-lens) review of the GREEN (`t_5f08f665`, PR [#301](https://github.com/yahodu/openpic-webapp/pull/301),
reviewed head `91135c6`) routed four findings to a TEST card (`t_aa18a7ff`) and its gated GREEN
(`t_b54adec0`). This section records the **pins** the Test Author added on the trunk (`38bad08`,
cut from `f6a973c`) and the decisions they settle. **No production code was touched by this card**
(`git diff --name-only` → the three specs below). **No new ADR number is consumed** and
`docs/adr/README.md` is byte-identical; the lane's `Next free` stays `0422`.

### 1. A concurrent double-submit answers `409`, never `500` (finding F1)

Pins: `apps/web/src/test/integration/billing-checkout.test.ts` `I7` and `I7b`.

- `I7` fires `Promise.all([startCheckout(A), startCheckout(B)])` with **different** `Idempotency-Key`s
  and asserts `[201, 409]`, `provider.calls() === 1`, exactly one live row (`cancelledAt: null`), the
  winner's row still `incomplete` carrying its hosted link, the loser's `details.subscriptionId` equal
  to the winner's `subscriptionId`, and zero `expired` rows.
- `I7b` holds the first request's vendor call open (a gated MSW handler) so the first row is provably
  in flight — inserted, hosted link not yet stored — when the second request arrives, and asserts the
  first row is still the only live one, that nothing was retired, and that the vendor was reached once.

RED reproduced on the trunk **before any fix**: `I7` `expected [ 201, 201 ] to deeply equal [ 201, 409 ]`
in **5/5** consecutive runs — a stable symptom, not a flake; `I7b` fails on the live-row identity in
**3/3** runs. The shipped route's loser takes the `decideExistingSubscription` `restart` branch (it
observes the winner's pre-link `incomplete` row), **expires the winner's in-flight row** and inserts its
own: two mandates, two `201`s, no `409`.

**Decision the pins force.** A live `incomplete` row that is _not reuse-eligible_ is **blocking**, not a
`restart` candidate: one caller's in-flight mandate may not be retired by another caller's request. The
loser answers `409 subscription_already_active` naming the row that won. That is §3.3's "_`409
subscription_already_active` if a live subscription exists_" read together with the one-live-row partial
index (`subscriptions_active_tenant_unique`, `{cancelledAt: null}`) that §3.3 itself names as the race
arbiter — no new code, no new status.

**Open item recorded for the GREEN.** `decideExistingSubscription`'s _pure_ contract (and its unit table)
keeps `restart` for an `incomplete` row with no stored link: the unit pin is the decision **one** caller
makes about the workspace's current row, and the route is where concurrency turns that into a refusal. The
GREEN must resolve both, compliantly (a re-read that answers `409` for the row that exists, or a staleness
fact that tells a crash-orphaned row from an in-flight one) without weakening the unit table. The other
exit of the same defect — `errorResponse` maps a raw `MongoServerError 11000` to `500` — must be mapped to
the same `409`; it is **not separately reachable** in this harness (in 5/5 runs the loser observed the
winner's row instead of losing the insert), so it is covered by `I7`'s `[201, 409]` contract plus the GREEN
card rather than by a dedicated pin.

### 2. The mandate customer's provenance (finding F2)

Pins: `I9` (`it.each`, 3 cases), `I9b`, `I9c` — each capturing the adapter's `customer_details` body
through MSW (the spec already captured the mandate request for I1).

- **name**: `userProfiles.displayName` > the Better Auth `user.name` > `"OpenPic customer"` — pinned and
  already correct (**characterization**).
- **email**: the account's address when it has one, otherwise a **platform no-reply address**. The shipped
  `route.ts:205` falls back to `FALLBACK_CUSTOMER_NAME` — a _display name_ in the vendor's
  `customer_email`. `I9b` pins `"no-reply@openpic.in"` (RED: `expected 'OpenPic customer' to be
'no-reply@openpic.in'`) and asserts the fallback is never the customer's name. **Decision:** the fallback
  is a platform-owned no-reply address — the same shape of documented placeholder as
  `UNSET_CONTACT_PHONE` (Decision §5), because a name is not an address. The literal is a placeholder for
  product input, exactly like the phone fallback: a product that requires a verified address should replace
  it with a refusal.
- **phone**: `"0000000000"` when the account has none — pinned as the **characterization** of the shipped,
  §5-documented gap.

### 3. A retired plan is the not-sold refusal (finding F3)

Pin: `I8`. A clone of the seeded `starter` plan is inserted with `active: false` (keeping `selfServe: true`,
its prices and its vendor refs), so `active` is the only unsellable fact. `I8` pins `422 validation_failed`
with a `fields[]` entry naming `planKey` and **no** `contactSalesUrl` (RED: received `plan_not_self_serve`).

**Decision, with the contract's silence named.** §3.3 names exactly one plan refusal —
`422 plan_not_self_serve` for `enterprise` — and names nothing for a retired plan. §3.1 says the opposite
of "contact sales" for one: "_Retired plans (`active: false`) are excluded_" from the catalogue, so a
retired plan is **not for sale** — the same negative space the route already answers with
`validation_failed` for a _missing_ plan. `plan_not_self_serve` + `contactSalesUrl` stays reserved for the
`selfServe: false` (sales-assisted) tier, where sales is the documented next step. The GREEN splits the
collapsed `!plan.active || !plan.selfServe` accordingly.

### 4. The e2e `§0.5` key set (finding F4)

Pin: `apps/web/e2e/billing-checkout.spec.ts`. The `not.toMatch(/cashfree/i)` sweep (the exact lens §R2
deliberately replaced in the integration spec) is replaced by the same exact key-set assertion at both
levels — `keysOf(envelope)` / `keysOf(envelope.checkout)` — with the shared `keysOf` helper. The sweep
passed only because the e2e provider is memory-hosted (`https://memory.openpic.local/…`, no vendor name);
it would have passed a `cf_subscription_id` leak. **Characterization**: the deployed surface already serves
exactly the six-key §0.5 envelope (the e2e run confirms it end to end), and the assertion's power is the
mutation probe recorded in §R2.

### 5. The unit table's fourth boundary shape (docblock gap)

Pin: `apps/web/src/test/unit/subscription-checkout.test.ts` — `DECISION_CASES` gains the **expired link**
(`expiresAt < now`) case → `restart`, making the docblock's "four boundary shapes" claim true of the table
(it carried three). **Characterization** (the shipped branch already handles it): `27 passed (27)`.

### Evidence at this head (test-only; production untouched)

| Command                                                                                                          | Result                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vitest run --project unit apps/web/src/test/unit/subscription-checkout.test.ts`                                 | **27 passed (27)** (was 26 — the §5 case)                                                               |
| `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/billing-checkout.test.ts` | **4 failed \| 16 passed (20)** — only `I7`, `I7b`, `I8`, `I9b`                                          |
| `vitest run --project unit` (full)                                                                               | 109 files · **1900 passed \| 3 skipped (1903)** (was 1899 \| 3 skipped)                                 |
| `TMPDIR=/root/tmp-mongo vitest run --project integration` (full)                                                 | 77 files · **4 failed \| 561 passed (565)** — the 4 are the pins above; the other 557 pre-existing pass |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                                         | **29 passed (29)**                                                                                      |
| `playwright test -c apps/web/playwright.config.ts --project=api apps/web/e2e/billing-checkout.spec.ts`           | **1 passed (1)**                                                                                        |
| `pnpm typecheck`                                                                                                 | exit 0                                                                                                  |
| `eslint` on the three touched specs                                                                              | 0 errors, 0 warnings                                                                                    |
| `prettier --check` on the three touched specs                                                                    | clean                                                                                                   |

Pin ledger: **(a)** `I7`/`I7b` **pinned-and-red** → `t_b54adec0`; **(b)** `I9b` **pinned-and-red**, `I9`×3
& `I9c` **characterization**; **(c)** `I8` **pinned-and-red** (contract-silent code, reading recorded
above); **(d)** e2e key set **shipped-and-pinned**; **(e)** the unit case **characterization**.

## Follow-up GREEN (card `t_b54adec0`) — the pins satisfied

Round-1's routed findings became the Test Author's pins (`t_aa18a7ff`, above). This section records the GREEN
that turns them green: **production code only** — the route
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/checkout/route.ts` — with **no test, mock, fixture or
factory edited** and **no new ADR number consumed** (`docs/adr/README.md` byte-identical; the lane's
`Next free` stays `0422`).

### 1. The concurrent double-submit is arbitrated in the route (`I7`, `I7b`) — and why that is required

The pins' premise — "the one-live-row partial index is what arbitrates the race" — does **not** hold in the
harness that runs them. Probed at this head: `db.command({ listIndexes: COLLECTIONS.subscriptions })` inside
the route during `billing-checkout.test.ts` answers `[{ key: { _id: 1 }, name: "_id_" }]`. The billing spec
never bootstraps indexes (the specs that need one build their own — `plans-seed.test.ts:199`,
`domain-events.test.ts:148`), so `subscriptions_active_tenant_unique` does not exist there and two racing
inserts both succeed. The route therefore has to arbitrate §3.3's one-live-row invariant itself; the index
stays what §3.3 calls it, the **cross-process** arbiter.

Two changes, measured rather than assumed:

- **A live row of _any_ shape is the `409`.** `liveRowOf` maps every non-`start` decision — `blocked`,
  `reuse`, `restart` — to `409 subscription_already_active` naming that row. With the pinned `reuse`/`restart`
  shapes still able to answer the old `201` reuse echo (or to retire the row), `I7` reproduced RED in **8 of
  10** consecutive focused runs at each intermediate step (`expected [ 201, 201 ] to deeply equal
[ 201, 409 ]`): the loser's read lands on either side of the winner's hosted-link store, and — with no
  index — both callers can also pass the decision point before either inserts. Only "a live row refuses"
  passes **every** interleaving, and it satisfies the pin's remaining assertions by construction: a refused
  caller never reaches the insert, so it can neither retire nor duplicate the winner's row, and
  `provider.calls()` stays `1`.
- **The insert race answers the same `409`.** `runExclusive(workspace, …)` serialises the read-then-claim
  inside one process — the pattern `seed-notification-types.ts` already uses for its "a database not yet
  bootstrapped carries no index" window — and the `E11000` the partial index raises cross-process is caught
  (`isDuplicateKeyError`, the `DUPLICATE_KEY = 11000` pattern) and answered as the §3.3 refusal for the row
  that won instead of falling through `errorResponse` as a `500`. The provider call sits **after** the
  critical section, which is what keeps `I7b` deadlock-free: the second caller reads and refuses while the
  first caller's vendor call is still held open. The queue entry is deleted once it settles, so a long-lived
  process does not accumulate one entry per workspace it has ever served.

Consequence, recorded rather than hidden: this route no longer retires a stale `incomplete` row. An abandoned
checkout is now a `409` naming the pending row, and retiring that row (a vendor expiry / `mandate_failed`
projection) belongs to the webhook lane (OP-108) — the consequence the pins card accepted when it made "not
reuse-eligible" blocking.

### 2. The mandate customer's address fallback (`I9b`)

`email` falls back to a new `PLATFORM_NO_REPLY_EMAIL = "no-reply@openpic.in"` — a platform-owned no-reply
mailbox, the documented-placeholder shape of `UNSET_CONTACT_PHONE` — instead of `FALLBACK_CUSTOMER_NAME`,
which put a display _name_ in the vendor's `customer_email`. The name ladder
(`userProfiles.displayName` > `user.name` > `"OpenPic customer"`) and the `"0000000000"` phone fallback are
unchanged (`I9`×3 and `I9c` characterise them). The route docblock and both constant docblocks state why.

### 3. A retired plan is the not-sold refusal (`I8`)

The collapsed `!plan.active || !plan.selfServe` guard is split: `!plan?.active` answers the same
`422 validation_failed` + `details.fields[].path = "planKey"` the route already serves for a _missing_ plan,
and `!plan.selfServe` keeps `422 plan_not_self_serve` + `contactSalesUrl` for the `enterprise` case (`I2`,
unchanged). §3.1 excludes a retired plan from the catalogue, so it is not for sale — the reading §3's
predecessor recorded, now implemented.

### Out of scope (deliberately)

The other §3.3 verbs (`upgrade`/`downgrade`/`cancel`/`retry-charge`), the webhook projection (OP-108), the
`billing.mandate.pending` event, and round-1's information-only items.

### Evidence at this head

| Command                                                                                                          | Result                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/billing-checkout.test.ts` | **20 passed (20)** — was `4 failed \| 16 passed (20)`; the focused spec re-run **12×**, green every time                                                                                                                   |
| `vitest run --project unit` (full)                                                                               | 109 files · **1900 passed \| 3 skipped (1903)** (unchanged)                                                                                                                                                                |
| `TMPDIR=/root/tmp-mongo vitest run --project integration` (full)                                                 | 77 files · **565 passed (565)** — was `4 failed \| 561 passed (565)`; re-run **3×**, green each time                                                                                                                       |
| `vitest run --project unit --project integration --coverage`                                                     | 186 files · **2465 passed \| 3 skipped (2468)**, exit `0`; statements **92.39 %** / branches **81.15 %** / functions **96.2 %** / lines **92.87 %** — every gate above threshold, `apps/web/src/app/**` on the global `80` |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                                         | **29 passed (29)**                                                                                                                                                                                                         |
| `playwright test -c apps/web/playwright.config.ts --project=api apps/web/e2e/billing-checkout.spec.ts`           | **1 passed (1)** (real `next start`, the memory provider)                                                                                                                                                                  |
| `pnpm typecheck`                                                                                                 | exit `0` (all three projects)                                                                                                                                                                                              |
| `pnpm lint`                                                                                                      | 0 errors (105 pre-existing `security/detect-*` warnings, none in the touched file)                                                                                                                                         |
| `prettier --check` on the touched file                                                                           | clean                                                                                                                                                                                                                      |

### Coverage gaps handed to the Test Author

- **The index exit is still unpinned.** `E11000` → `409` is unreachable in `billing-checkout.test.ts` because
  that spec never bootstraps indexes; a pin that calls `ensureIndexes(test.db)` (as `plans-seed.test.ts` does)
  would exercise it. Until then it is carried by `I7`'s contract plus this record.
- **Nothing pins who retires an abandoned `incomplete` row** now that the route does not, and nothing says
  what a `409` should tell that caller.
- **The `reuse` decision is now unused at the route level** (its unit table still pins it). If §3.2's
  `GET /subscription` is meant to be the only way back to a pending mandate, that deserves a pin; if a
  valid-link `201` echo is wanted after all, `I7`'s concurrency contract needs restating — the two cannot
  both hold.

## Review sign-off — 2026-10-25

- **Reviewer round:** 1 (artifact lens) · **Card:** `t_5f08f665` · **PR:**
  [#301](https://github.com/yahodu/openpic-webapp/pull/301) (reviewed head `91135c6` → squash `38bad08`,
  merged `2026-10-25T04:42:44Z`) · **Verdict:** APPROVED WITH FINDINGS · **Consumes:** no ADR number
  (append-only; `docs/adr/README.md` stays byte-identical to `origin/main`)

The round-1 (**artifact lens**) review of this OP-107 GREEN returned **APPROVED WITH FINDINGS** — zero
changes requested to the deliverable and **zero reviewer edits**: no test, mock, fixture, factory or
production file was touched by the review, and the merged bytes are the reviewed bytes (`38bad08` is an
ancestor of `origin/main`; the squash is the reviewed head plus the two `origin/main` merges recorded
below).

**Evidence reproduced independently on the merged artifact** — the squash `38bad08` (the merged tree),
re-measured on the reviewed head `91135c6` wherever the two heads differ:

- focused unit `apps/web/src/test/unit/subscription-checkout.test.ts` → **26 passed (26)** and
  `adr-numbering.test.ts` → **29 passed (29)**; focused integration
  `apps/web/src/test/integration/billing-checkout.test.ts` → **12 passed (12)**
  (`TMPDIR=/root/tmp-mongo`). All three counts are **identical at both heads** — the merges change none of
  the lane's own numbers.
- full `--project unit`: merged `38bad08` → **109 files · 1899 passed | 3 skipped (1902)**; reviewed head
  `91135c6` → **109 files · 1885 passed | 3 skipped (1888)**.
- full `--project integration`: merged `38bad08` → **77 files · 557 passed (557)**; reviewed head `91135c6`
  → **76 files · 553 passed (553)**.
- the **+14 unit / +4 integration** tests separating the two heads arrived when `origin/main` was merged
  into the branch twice: they are OP-105
  [#297](https://github.com/yahodu/openpic-webapp/pull/297)'s `payments-cashfree-drift-log.test.ts` and
  `payments-memory-provider.test.ts` and their siblings, swept in by the merges — **no OP-107 pin changed**.
- full Playwright e2e (a real `next start` build, `api` + `api-production`) → **22 passed**.
- `tsc -p tsconfig.json --noEmit`, `tsc -p packages/contracts/tsconfig.json --noEmit`,
  `tsc -p apps/web/tsconfig.json --noEmit` → **exit 0** each; `eslint .` → **0 errors / 105 warnings**
  (all pre-existing `security/detect-*`, none in the lane's files); `prettier --check .` → **clean**.
- **scoped-merge proof:** `git diff --stat 38bad08^1 38bad08` → **16 files changed, 2462 insertions(+),
  20 deletions(−)** — the lane's own sixteen files, nothing unrelated swept into the squash.

**Correction to the commissioning card's figures (recorded, not silently copied).** The card asked for the
full-suite pair as `unit 1899 | 3 skipped (1902)` **and** `integration 553 (553)`. Measured, those are the
**two different heads**: `1899` is the merged squash `38bad08`, while `553` is the reviewed head `91135c6`
(whose merged-squash count is `557`). Both are recorded above exactly as measured; every other quoted
figure held.

**Merge reconciliation.** `origin/main` was merged into the branch **twice** before the squash (main's tips
`5181eea` → `9731340`). The shared `docs/adr/README.md` ledger conflicted once and was resolved as a
**union**: main's prose (OP-105's `0385`→`0386` move and the board-wide `0307`→`0308` note) was kept
**first**, the OP-107 lane's two notes appended after it. The table keeps main's OP-105 cell `0386`, the
lane's own row `0420`–`0439` / `Next free 0422`, and the pool at `0440`+. **No ADR number was lost,
displaced or double-counted**; this record consumes none of its own.

**Findings carried out of the review.** All four were **routed, not fixed here** (no production file is a
review artifact); they are cited **by card id and PR number**, not by ADR number — a follow-up's ADR number
may renumber while its PR is open:

- **F1 (the concurrent double-submit answered `201, 201`)** — two racing callers each minted a mandate
  instead of the loser taking `409 subscription_already_active`; the same defect's other exit, a raw
  `MongoServerError 11000`, fell through `errorResponse` as a `500`.
- **F2 (the mandate customer's fallbacks)** — the `email` fallback put a display **name** into the vendor's
  `customer_email`; the name ladder and the `"0000000000"` phone fallback were unverified.
- **F3 (a retired plan's classification)** — a plan with `active: false` was refused as
  `422 plan_not_self_serve` + `contactSalesUrl` rather than the not-sold `422 validation_failed`.
- **F4 (the e2e `§0.5` key set)** — the `not.toMatch(/cashfree/i)` sweep passed only because the e2e
  provider is memory-hosted; it would have passed a real vendor-id leak.

These four went to TEST card `t_aa18a7ff` (pins) and its gated GREEN card `t_b54adec0`; their pins and the
production fix they force are recorded in §"Follow-up pins" and §"Follow-up GREEN" above. The review's
Low/Info items were routed as a second TEST card, **`t_e04e0e39`**
(`parents=[t_b54adec0, t_be4e7022]`): it pins (a) the `E11000` → `409` insert exit — proven by probe at the
reviewed head, but never reached by `billing-checkout.test.ts` because that spec does not bootstrap the
one-live-row index — and (b) what the §3.3 refusal for an abandoned `incomplete` row means and **who
retires it** (OP-108's webhook projection), now that the route no longer runs `restart`.

**Post-review status.** F1 and the Low items are addressed by the `t_aa18a7ff` → `t_b54adec0` chain and
`t_e04e0e39` once they land; **nothing in §Disputes or §Consequences above is retracted** — those sections
are the historical record at the reviewed head `91135c6`, and the follow-ups' **own** records document what
happened next. D1/D2 are not re-litigated here: the Test Author's resolution (card `t_7998de98`,
§"Dispute resolution" above) stands and is already recorded.

## Follow-up pins (card `t_e04e0e39`) — the index exit and the abandoned-`incomplete` refusal

Round-1 (artifact lens) routed the **two remaining findings** of the `t_b54adec0` review into a TEST card,
`t_e04e0e39` (`parents=[t_b54adec0, t_be4e7022]`, same lane worktree). It closes the two coverage gaps the
previous section handed to the Test Author (its §"Coverage gaps handed to the Test Author" items 1 and 2).
**Test-only**: at the pins head `git diff --name-only origin/main` touches exactly **one** file — the
integration spec `apps/web/src/test/integration/billing-checkout.test.ts` — with **no production, mock,
fixture or factory edited**, **no new ADR number consumed** (this append is additive; the lane's `Next free`
stays `0422` and `docs/adr/README.md` is byte-identical).

### 1. The suite now runs against the bootstrapped schema

`ensureIndexes(app.db)` runs in the spec's `beforeAll` (the `plans-seed.test.ts:197` precedent), so the route
faces the real `subscriptions_active_tenant_unique` partial index
(`{ tenantId: 1 }`, unique, `partialFilterExpression: { cancelledAt: null }`) rather than a harness carrying
only `_id_`. That is the precondition the previous section's gap named: **without the index two racing
inserts both succeed and the insert exit is unreachable**, which is why `I7` alone could never pin it.

### 2. `I10` / `I10b` — the `E11000` insert exit is the same `409`, never a `500`

Two pins, and the honest split between them matters:

- **`I10`** (the shape the card asked for) fires `Promise.all` with the index **built** and asserts the pair
  resolves `[201, 409]`, one provider call, exactly one live row (`cancelledAt: null`), no `expired` row, and
  the loser's `details.subscriptionId` naming the winner. **Measured, not assumed:** with the index present
  the loser is still refused by `liveRowOf` **before** it inserts — the in-process `runExclusive` queue
  serialises the read-then-claim, so the second caller reads the first caller's row. `I10` therefore pins the
  observable contract _with the real schema_, but it does **not** by itself traverse the `E11000` branch.
- **`I10b`** is the pin that does, and it is what makes the requirement a regression lock rather than a
  restatement. A row can occupy the index's live slot while this caller's read classifies it as terminal —
  seeded here as `status: "expired"` with `cancelledAt` still `null`, the exact disagreement
  §"Decision §4" above names ("a row parked at `status: expired` with `cancelledAt` still null would keep
  occupying the one-live-row slot"), and the same disagreement a second process creates when its row lands
  after our read. The route decides `start`, inserts, and the index refuses the insert; the catch must answer
  §3.3's refusal for the row that won, not fall through `errorResponse` as a `500`. `I10b` asserts `409` (not
  `500`), `details` naming that occupant with its own status, **zero** provider calls, no second row written,
  and the occupant untouched.

**Mutation evidence (the pin has teeth).** `DUPLICATE_KEY = 11000` → `11001` in
`route.ts` (`isDuplicateKeyError` stops recognising the driver code) makes `I10b` fail with
`AssertionError: expected 500 to be 409`. That single-token mutation is also the proof that the `409` `I10b`
observes comes from the catch and not from a `refused` decision — under the mutation the route reaches the
driver error and answers `500`. The route was restored byte-identical afterwards (`git diff` empty).

### 3. `I11` — what an abandoned `incomplete` row means, and who retires it

`I11` seeds the workspace with a live `incomplete` mandate carrying a hosted link that has **already
expired** (expired by construction — one hour before the run — so the fact under test does not depend on the
wall clock), then starts a checkout. The refusal, pinned field by field:

- `409` `subscription_already_active`, `retryable: false`, `details = { subscriptionId, status: "incomplete" }`
  naming the abandoned row — the **same** refusal a live `active` row gets (`I3`); the expired link does not
  soften or change it, and it is not the `422`/`contactSalesUrl` shape a sales-assisted tier gets;
- `details` is asserted to be **exactly** that key pair (`keysOf(details)` → `["status","subscriptionId"]`) with
  explicit negatives for `checkout`, `expiresAt`, `contactSalesUrl` and `supportUrl`: the refusal carries
  **no recovery affordance at all** — the stored link and its expiry are not echoed, and there is no
  sales/support target and no retry hint. A caller cannot learn from this response how to get unstuck;
- the provider is never called, the abandoned row is **untouched** (still `incomplete`, `mandateStatus:
pending`, `cancelledAt: null`, still carrying its original expired link and expiry) and no second row is
  written;
- a **second** attempt under a fresh `Idempotency-Key` answers identically — the refusal is stable, because
  nothing in this tree retires the row.

**Who retires the row, and what happens in the meantime (the decision this pin records).** This route does
not, and must not: §"Follow-up GREEN §1" removed `restart` deliberately, because retiring a pending mandate
is unsafe from a _checkout_ (one caller's in-flight mandate may not be retired by another caller's request).
The owner of the transition is the **webhook projection (OP-108)**: a vendor
expiry / `mandate_failed` / `LINK_EXPIRED` status-changed event projected onto the row sets it terminal
(`status: "expired"`, `mandateStatus: "expired"`, `cancelledAt` set), which both tells the truth about the
mandate **and releases the one-live-row slot** so a later checkout can start a fresh one. Until that lane
lands and the event arrives, the documented behaviour — now pinned rather than assumed — is that the
workspace is refused with the `409` above **indefinitely**, and the only remedy is an operator retiring the
abandoned row (or the mandate eventually expiring at the vendor and OP-108 projecting it). `I11` is the
regression lock on that: if a future change starts retiring, replacing or re-serving an abandoned row from
this route, `I11` fails (its row-integrity and `keysOf` assertions), and the response gaining any recovery
hint fails its exact-key-set assertion.

**Mutation evidence (the "no recovery affordance" clause has teeth).** Adding `supportUrl: "/support"` to
`alreadyActiveError`'s `details` makes `I11` fail with
`AssertionError: expected [ 'status', 'subscriptionId', …(1) ] to deeply equal [ 'status', 'subscriptionId' ]`.
Restored byte-identical afterwards.

### 4. Recorded, not reworked

- **`decideExistingSubscription`'s unit table is untouched** (`subscription-checkout.test.ts`, 27 passed): the
  `reuse` decision stays unreachable at the route level, and no `201` reuse echo is restored. That is a
  deliberate non-change — a valid-link `201` echo and `I7`'s `[201, 409]` cannot both hold — and the reading
  stands: §3.2's `GET /billing/subscription` is the way back to a _valid_ pending mandate.
- `I10`, `I10b` and `I11` are **characterization pins**: the shipped route already answers them, so this card
  created **no gated GREEN sibling**. The two mutation probes above are what stand in for "these pins are
  meaningful" now that there is no red to hand off.

### Evidence at this head (test-only; production untouched)

| Command                                                                                                          | Result                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `TMPDIR=/root/tmp-mongo vitest run --project integration apps/web/src/test/integration/billing-checkout.test.ts` | **23 passed (23)** (was 20) — the whole focused file re-run **3×**, green each time (incl. `I7`/`I7b` with the index built)       |
| `vitest run --project unit` (full)                                                                               | 1914 passed \| 3 skipped (1917) — see the figure note below                                                                       |
| `TMPDIR=/root/tmp-mongo vitest run --project integration` (full)                                                 | **582 passed (582)** (was 565 at `f35aac9`)                                                                                       |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                                         | **29 passed (29)**                                                                                                                |
| `pnpm typecheck`                                                                                                 | exit `0` (root + contracts + web)                                                                                                 |
| `eslint` on the touched spec                                                                                     | 0 errors, 0 warnings                                                                                                              |
| `prettier --check` on the touched spec                                                                           | clean                                                                                                                             |
| mutation `DUPLICATE_KEY 11000 → 11001`                                                                           | `I10b` → `AssertionError: expected 500 to be 409` (route restored byte-identical)                                                 |
| mutation `details += supportUrl`                                                                                 | `I11` → `AssertionError: expected [ 'status', 'subscriptionId', …(1) ] to deeply equal [ 'status', 'subscriptionId' ]` (restored) |

**Figure note (recorded as measured, not copied).** The card quoted `unit 1900 passed | 3 skipped` and
`integration 565 passed`; both are **stale snapshots of older heads** (the `t_be4e7022` sign-off had to
correct this card's two other figures for the same reason). Measured here: integration `582` = `565` + the
**3** pins this card adds + the **14** integration tests `origin/main` gained after the card was written
(`payments-cashfree-expiresat.test.ts`, `payments-cashfree-request-projections.test.ts` and the
`payments-cashfree-adapter.test.ts` edit, i.e. OP-105 #316/#317). For the unit figure, the `unit` project
(`vitest.config.ts`) includes `packages/contracts/src/**/*.test.ts` and `apps/web/src/**/*.test.ts` and
**excludes** `**/test/integration/**`, and this card's only change is an integration spec — so the pins are
**provably unit-neutral** and `1914` is the trunk's own count; the gate that matters (zero failures, only the
3 known skips) holds.

### Open items handed on

- **`I11`'s recovery path is still product-open.** The pin records the _refusal_; the convergence point is
  OP-108's projection retiring the row (above). Once OP-108 lands, a pin should assert the end-to-end
  transition: an abandoned `incomplete` row → projected terminal → **the next checkout answers `201`** and
  the one-live-row slot is free again. That belongs to the OP-108 lane, not here.
- The `I9` name/phone fallbacks (`UNSET_CONTACT_PHONE`, `FALLBACK_CUSTOMER_NAME`) remain documented
  placeholders (§"Decision §5", §"Follow-up pins §2") — unchanged by this card.
