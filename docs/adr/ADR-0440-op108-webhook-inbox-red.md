# ADR-0440 — OP-108 RED: the generic provider webhook inbox and the payment projection

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-108 RED (`t_a297e850`) · **Branch:** `OP-108-task-webhook-inbox` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a297e850`
- **Relates to:** [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout whose `incomplete` row this inbox activates, and the error-code/catalogue wiring it reuses), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the `PaymentProvider` port — `verifyWebhook` / `parseWebhook` are §10.1 steps 1–3), [ADR-0383](ADR-0383-op105-memory-payment-provider-red.md) / [ADR-0384](ADR-0384-op105-memory-payment-provider-green.md) (the memory provider + `signWebhook` the e2e signs with), [ADR-0029](ADR-0029-op88-domain-events-red.md) (the domain-event outbox every projection emits through), [ADR-0400](ADR-0400-op106-subscription-read-red.md) (the read §14.3 state this projection writes), [ADR-0007](ADR-0007-op82-platform-settings-red.md) (the settings singleton grace/retention come from), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.1 (the 8-step handler order), §10.1.1 (the non-negotiable rules), §10.1.2 (the payment event mapping), §0.3 (`provider` auth), §0.10 / §0.11 (`/webhooks/**` exempt from CSRF and rate limiting), §23 (money and access move together), Appendix A (`invalid_signature`, `stale_signature`) · **Schema:** §14.3, §14.4, §18.3, §18.4, §20.4, §21 P4, §22, §23

## Context

OP-108 is the story that makes billing state _reliable under adversarial
delivery_: a provider webhook may be replayed, delayed, reordered or forged, and
billing must still be correct.

```
POST /api/v1/webhooks/{provider}          (provider auth, not rate limited)
```

§10.1 fixes the handler order and only that:

1. read the **raw** body, verify the signature → `401 invalid_signature`, no write;
2. timestamp within ±300 s → `401 stale_signature`;
3. `providerEventId`, else `payloadHash = sha256(rawBody)`;
4. `insertOne` into `providerWebhookEvents` — **the duplicate-key error _is_ the
   deduplication**;
5. answer `200 {"status":"received"}` **before** any projection work;
6. project into domain state **after** responding (or in a separate consumer
   reading `processedAt: null`), as a **transaction**: `billingTransactions`
   insert + `subscriptions` update together;
7. set `processedAt`, `processResult ∈ applied|ignored|error` and `processError`;
   a failure leaves `processedAt: null` for the sweep (OP-111);
8. emit domain events; never call the notification service inline.

The card pins the observable behaviour: `U1` the projection reducer per
normalized event, `U2` grace from settings, `U3` the downgraded→active
reactivation; `I1`–`I7` the endpoint against a real Mongo (acknowledgement,
duplicate, bad signature, env isolation, projection failure, grace from a
changed setting, out-of-order delivery); `E1` the checkout-then-webhook journey
through the memory provider. It does not pin module paths, the inbox row shape,
how the projection is deferred, or where the ordering watermark lives. The
sibling GREEN card `t_6a9a0ae6` narrows most of it (the endpoint, the 8 steps,
the `providerWebhookEvents` insert, the `after()` projection, the §10.1.2
mapping, `env` mismatch → `ignored`, "the projection is also callable by the
sweep"). This record fixes the rest.

## Decision

### Module contract

| Module (specifier)                       | Exports                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/app/api/v1/webhooks/[provider]/route` | `POST` — `defineRoute({ route: "/api/v1/webhooks/:provider", … })`, **no** `rateLimit` stage, **no** request `body` schema; answers the bare §10.1 step 5 receipt                                            |
| `@/server/billing/webhook-projection`    | the pure `reduceProviderEvent(input): ProjectionDecision`, `computeGraceEndsAt(failedAt, settings): Date`, and the transactional `projectProviderWebhookEvent(eventId: ObjectId \| string, { db?, clock? })` |
| `@/server/db/collections` (registry)     | `COLLECTIONS.billingTransactions = "billing_transactions"`                                                                                                                                                   |
| `@/server/db/indexes` (registry)         | the two §18.4 unique indexes (see §3) plus the `billingTransactions` indexes of §14.4                                                                                                                        |

`ProjectionDecision` is `{ outcome: "applied" | "ignored", subscriptionPatch:
Record<string, unknown> | null, transaction: ProjectionTransaction | null,
emittedKeys: readonly string[] }`; `ProjectionInput` is `{ event, subscription,
settings, now }`. The patch keys are §14.3's own field names, the transaction
keys are §14.4's, and `emittedKeys` are the §4.3 notification `typeKey`s — a
client, the sweep and the fan-out all read them, so a rename is a contract
change, not a refactor.

### 1. One inbox, routed by the provider key the adapter itself reports

The `{provider}` segment must equal the **normalized event's own `provider`
key** (§11.1: the key names the registered adapter). That is what makes the
route generic without a vendor table in it: `cashfree` parses through the
Cashfree adapter, `memory` through the memory adapter the e2e selects, and a
segment with no adapter — or a body whose adapter reports a _different_ key —
is refused with a `4xx` and **no write** (a `5xx` there would be a crash on
unroutable input, not a refusal). `novu` receipts are OP-134's; `storage` is
§10.1.4 phase 2.

The route declares **no** request schema, because the pipeline's
`parseJsonBody` would re-serialise the body and JSON re-serialisation breaks the
HMAC (§10.1.1); the handler reads `ctx.request.text()` itself, exactly as
`internalAuthStage` does. It declares **no** `rateLimit` stage: `/webhooks/**`
is not rate limited (§0.11) — the signature and the unique index are the
protection. The edge gate already exempts the prefix from CSRF/Origin
(`@/server/security/csrf`), so a provider POST needs no `Origin`/CSRF header;
the e2e proves that on a real server.

### 2. Verification: two codes, both from the adapter's own scheme

`verifyWebhook` returns a plain `boolean` (ADR-0380 §3), so the route must
produce the §10.1 step 1/2 distinction itself: check the `x-webhook-timestamp`
window first, then the signature. The codes are Appendix A's `invalid_signature`
and `stale_signature` (both `401`, both writing nothing). A **missing**
timestamp or signature is `invalid_signature`, never "no window to check" —
mirroring `verifyInternalSignature`'s rule that an unparseable timestamp is
never silently fresh.

### 3. The inbox row and the two unique indexes — **and a bug this lane must fix**

The row is §18.4's document verbatim: `{provider, env, eventType,
providerEventId, payloadHash, signatureValid, rawPayload, receivedAt,
processedAt: null, processResult: null, processError: null, expireAt}` with
`expireAt = receivedAt + platformSettings.retention.webhookDays`.

§10.1.1 is explicit that **the unique index is the dedupe** and §18.4 names
both: `{provider, providerEventId}` unique **and** `{provider, payloadHash}`
unique **partial on `providerEventId: null`**. The trunk's `INDEX_SPECS`
carries the first as a **plain** unique index
(`provider_webhook_events_provider_event_unique`) and not the second. That is a
live bug for this lane, not a missing nicety: a `SUBSCRIPTION_STATUS_CHANGED`
payload carries no vendor event id (ADR-0381 maps `cf_payment_id`/`cf_refund_id`
only), so **two different status changes would collide on `(cashfree, null)`**
and the second would be swallowed as `duplicate_ignored` — a missed
cancellation, silently. `I2`'s third case pins exactly that: two _different_
id-less events must both insert and both project, which forces the first index
to become partial (`providerEventId` present) and the payload-hash index to
exist. A deployment that already built the old index needs a rename (the
bootstrap never drops), which the GREEN's PR should note.

The spec builds the registry against its own database (`ensureIndexes(db)`,
the `domain-events.test.ts` precedent): with no index a replay inserts twice and
every dedupe pin would be vacuous.

### 4. The reducer is pure, and §10.1.2 is a table of patch + ledger + keys

`reduceProviderEvent` takes the matched row, the event, the settings and `now`
and returns the decision — no database, no clock, no environment. The §10.1.2
rows become patch/ledger/emit triples, including the ones a naive
implementation gets wrong:

| Normalized kind          | `subscriptions` patch                                                                                                                                          | Ledger row                  | Emits                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mandate_pending`        | `mandateStatus: "pending"`                                                                                                                                     | —                           | `billing.mandate.pending`                                                                                  |
| `subscription_activated` | `status: "active"`, `mandateStatus: "active"`, `currentPeriodStart/End`, `nextChargeAt`                                                                        | `authorization`/`succeeded` | `billing.subscription.activated`                                                                           |
| `mandate_failed`         | `status` stays `incomplete`                                                                                                                                    | `authorization`/`failed`    | `billing.mandate.failed`                                                                                   |
| `ignored`                | — (`outcome: "ignored"`)                                                                                                                                       | —                           | —                                                                                                          |
| `payment_succeeded`      | extends `currentPeriodEnd`, `pendingDueMinor: 0`, `gracePeriodEndsAt: null`, `dunning` reset; **`downgraded` → `active`, `activePlanKey = subscribedPlanKey`** | `charge`/`succeeded`        | `billing.payment.succeeded` (+ `billing.subscription.reactivated`, `usage.limit.restored` when recovering) |
| `payment_failed`         | `status: "past_due"`, `gracePeriodEndsAt`, `pendingDueMinor` = amount attempted, `dunning.attemptCount++`                                                      | `charge`/`failed`           | `billing.payment.failed`                                                                                   |
| `subscription_cancelled` | `status: "cancelled"`, `mandateStatus: "revoked"`                                                                                                              | —                           | `billing.subscription.cancelled`                                                                           |
| `refund_processed`       | —                                                                                                                                                              | `refund`/`succeeded`        | `billing.refund.processed`                                                                                 |

`SUBSCRIPTION_PAYMENT_CANCELLED` has no row of its own: the adapter normalizes
it to `payment_failed` with `auth_required` (ADR-0381 §2), so it duns like any
other failed charge. Two details are worth stating because they are the
_interesting_ half of the table: the reactivation writes **`activePlanKey =
subscribedPlanKey`** (a status flip on the same document — a hard-coded tier
would strand a grandfathered customer), and the failed charge records
`pendingDueMinor` = the amount the provider tried to take, which is what the
pay-now banner reads.

`computeGraceEndsAt(failedAt, settings)` is `failedAt +
settings.dunning.gracePeriodDays`, exposed and pinned separately because
"there are no hard-coded grace days" is an acceptance criterion, and the
integration suite proves both the 14-day default and a 7-day operator change
end-to-end (write the singleton → `invalidatePlatformSettings()` → drive the
event).

### 5. The projection is deferred, recoverable, and transactional

- **Deferred.** The route registers the projection with `after()` (the GREEN
  card's §3, Next 15's stable post-response hook). The suite mocks
  `next/server`'s `after` and _runs the captured callback itself_ — the
  `domain-events-after-trigger.test.ts` pattern — which is what lets `I1` assert
  the §10.1 step 5 property directly: when the `200` returns the subscription is
  still `incomplete` and the ledger is empty, and only the deferred run moves it.
- **Recoverable.** `projectProviderWebhookEvent(eventId, {db, clock})` is
  exported, so the sweep OP-111 will build re-projects a `processedAt: null`
  row, and the suite drives that seam directly.
- **Transactional.** §23: the ledger insert and the subscription update are one
  unit of work. `I5` injects the failure where a real one lives — a collection
  validator the ledger collection cannot satisfy — and pins that the provider
  still gets `200`, the row ends `processedAt: null` + `processResult: "error"` +
  a `processError`, and **nothing moved** (subscription untouched, zero ledger
  rows). A non-transactional implementation that wrote the subscription first
  fails that third pin, which is the point; the second spec then removes the
  poison and drives the same row through the sweep seam, proving the failure is
  recoverable rather than lost.
- **Env-isolated.** §11.1: the projection looks the subscription up by
  `{externalRefs.provider, externalRefs.id, externalRefs.env}`, so a sandbox
  event can never match a production subscription's ref and lands `ignored`
  (`I4`).

### 6. Out-of-order delivery is ordered by the provider's `occurredAt`

`I7` delivers a renewal **success** and then a charge **failure whose
`event_time` is an hour earlier**. The failure must not roll the subscription
back to `past_due`, must not set a grace deadline and must write no failed
ledger row — arrival order is irrelevant, the provider's own instant is the
order. The §14.3 schema carries no watermark field today, so the projection must
persist the last applied event's `occurredAt` on the subscription; **which field
carries it is deliberately unpinned** (a `lastProviderEventAt`-shaped leaf or a
`updatedAt` stamped with the event instant both satisfy the pins), and only the
observable outcome is asserted.

### 7. The e2e journey and its two affordances

`E1` signs in, provisions the workspace, checks out through the memory
provider, signs a normalized activation with the _same_ adapter
(`memoryPaymentProvider({env:"sandbox"}).signWebhook`, the scheme ADR-0383 §3
proves interoperates with the vendor verifier), POSTs it to
`/api/v1/webhooks/memory`, and reads `GET /tenants/current/subscription` as
`active`. Two affordances are worth naming:

- **The mandate id comes out of the hosted link.** The projection matches on
  `externalRefs[].id` and no endpoint may return a provider ref (§0.15), so the
  only place an e2e can learn it is the link: the memory adapter's
  `checkoutUrl` is `https://memory.openpic.local/checkout/<id>` with the same
  `<id>` it stores as `externalRefs[0].id` (ADR-0383, pinned by
  `payments-memory-provider.test.ts`). The spec asserts the id's shape
  (`/^mem_sub_/`) rather than trusting the derivation blindly.
- **The read polls.** The projection is post-response work, so `active` is
  observable _shortly after_ the `200`; `expect.poll` is the web-first way to
  observe it (never a sleep).

## Assumptions and open questions

- **`eventType` stores the normalized kind.** §18.4's example writes a vendor
  event name (`PAYMENT_FAILED`), but §10.1.1 keeps vendor event names inside the
  adapter and the port's `NormalizedProviderEvent` exposes `kind` (lower-case,
  our vocabulary) and nothing vendor-shaped. The route can therefore only store
  `kind`; the pin asserts `subscription_activated`. If a future adapter needs
  the vendor name, the port gains a field and one pin changes.
- **`payloadHash`'s prefix convention is the implementation's choice.** The
  schema's example writes `sha256:<hex>`; the pin strips an optional `sha256:`
  prefix and compares the **digest**, so the value is exact and the convention
  stays free.
- **The receipt body is exactly `{"status":"received" | "duplicate_ignored"}`**
  (§10.1 steps 4–5). No `eventId`, no `processedAt`: the provider must be able to
  ignore the body, and the projection happens after it.
- **`billingTransactions` is registered as `"billing_transactions"`** — the
  snake_case convention `COLLECTIONS` follows; the GREEN owes the registry entry,
  its §14.4 indexes (the unique `{idempotencyKey}`, `{tenantId, occurredAt}`,
  `{subscriptionId, kind, occurredAt}`, the partial `externalRefs` pair and the
  partial pending-status index) and the §18.4 fix of §3.
- **The ledger's `idempotencyKey` is a deterministic function of the event's
  identity** (`U1` pins determinism and distinctness, not the formula): a
  re-projection after a crash must be able to write the same row, and the
  transaction means a retry never sees a half-applied predecessor.
- **The `after()`-free path is not pinned.** §10.1 step 6 permits "a separate
  consumer" instead of `after()`; the card's GREEN notes pin `after()`, so the
  suite asserts the registration and drains it. A consumer-only implementation
  would have to change `I1`'s deferral assertions (not its state assertions).
- **Rate limiting is deliberately unpinned.** §0.11 says `/webhooks/**` is not
  rate limited; the pin is structural (the route composes no `rateLimit` stage
  and the e2e drives a real server), not a header assertion.
- **Out of scope, deliberately:** `novu` delivery receipts and suppressions
  (§10.1.3, OP-134), storage events (§10.1.4, phase 2), the
  `webhook-projection-sweep` cron itself (§10.2, OP-111 — this lane owns the
  seam it calls), `admin.provider.failing` on repeated failure (OP-111), log-line
  field names beyond the invalid-signature warn, and the exact billing-cycle
  arithmetic (a successful charge is pinned to _extend_ the stored period, not to
  a specific month length).

## Consequences

- A replayed webhook can no longer reprocess: the dedupe is the database's, in
  both identity shapes, and `I2` measures it as "one ledger row, one inbox row,
  `duplicate_ignored`" — never as "the handler returned 200 twice".
- Two _different_ id-less status changes both land, which is the difference
  between a working dunning pipeline and one that silently drops every second
  cancellation; the fix is pinned by the same test that would have caught it in
  production.
- A projection failure is no longer able to fail the provider or leave half a
  money movement: `I5` records both the `200` and the empty ledger, and the
  sweep seam is proven to be the recovery path.
- The grace deadline is provably data, not a constant: the same event produces
  14 days by default and 7 after an operator edit, both measured as bounded
  intervals against the request's own clock readings.
- Late-arriving failures cannot downgrade a customer — the highest-value
  protection in the story, since a wrongful downgrade is what the §10.1 preamble
  exists to prevent.
- **Red state at handoff (evidence):** the four new files are test-only — no
  production module is created or edited (the two probe stubs and the temporary
  `COLLECTIONS` entry lived and died inside this worktree; `git status` shows only
  the specs). `prettier --check` and `eslint` are clean on all four. At handoff
  the suite is red as missing modules: unit `Cannot find package
'@/server/billing/webhook-projection'`; integration `Cannot find package
'@/app/api/v1/webhooks/[provider]/route'` (both files) — the honest
  module-resolution red of the OP-93/ADR-0306 precedent. With throwaway stubs at
  the intended paths (deleted before handoff) `npx tsc -p apps/web/tsconfig.json
--noEmit` exited `0` — the contract above is type-correct, so the GREEN inherits
  no type ambush — and the specs failed at **assertion level**: unit `16 failed
(16)`, integration `16 failed | 1 passed (17)` (`expected 501 to be 200/401`,
  `expected { error: { code: 'not_implemented' } } to deeply equal { status:
'received' }`, `expected undefined to be defined`); the one pass was the
  unresolvable-provider case against a `501` stub, which the tightened
  `status < 500` assertion now closes.
- **The e2e half is executed by the GREEN, by construction.** `next build`
  typechecks the project, so a RED branch cannot produce a standalone server —
  `E1` runs in the GREEN's PR (the OP-93/ADR-0306 RED-by-design rule, and the
  ADR-0307 completion rule that a card does not complete on an unmerged
  deliverable). What this lane verifies is that the spec loads with its module
  graph resolved under Playwright (the memory provider import is real, not a
  re-implemented HMAC) and that it fails `404`/`200`-mismatched for the right
  reason.

## Alternatives considered

- **An application-level "have I seen this event?" lookup before the insert.**
  Rejected: §10.1.1 forbids it in one sentence — the unique index _is_ the
  dedupe, and a read-then-write check is a race under a redelivery storm.
- **A single `{provider, payloadHash}` identity for every row.** Rejected: it
  would dedupe two _different_ vendor events that happen to hash the same only if
  a provider ever reuses a payload, but it also loses the vendor's own id as the
  primary identity and makes the replay window depend on our hash stability.
- **Verify the parsed body (or a re-serialised copy).** Rejected: §10.1.1 is
  explicit — re-serialisation breaks the HMAC, and the pin that catches it is
  the tampered-body `401`.
- **Project inline and answer afterwards.** Rejected: the provider waits on our
  domain logic, and a slow transaction becomes a redelivery storm (§10.1 step 5)
  — the exact failure mode the story exists to prevent.
- **Mark the row `processedAt` before projecting.** Rejected: the only resumable
  state is "unprocessed", which is what the sweep filters on; a marker written
  before the transaction would lose the event forever on a crash.
- **Compare `occurredAt` against the receipt time instead of the provider's
  instant.** Rejected: it reorders a delayed but _older_ failure ahead of a newer
  success — the wrongful downgrade the story names.
- **Have the e2e re-implement the HMAC (the `unsubscribe-token.ts` shape).**
  Rejected here: the memory provider is a real module in the app, Playwright
  resolves its graph, and duplicating the scheme would let the e2e keep passing
  after the adapter's signer changed.
- **Expose the subscription's `externalRefs` through a test-only e2e route.**
  Rejected: a new test-only surface that leaks provider refs is a worse
  affordance than reading the id the memory adapter already puts in its own link.

## ADR number allocation

The `OP-108` lane had no reserved range on `main`, so — as the first card of the
lane — it draws the next block from the allocator's `unallocated (future lanes)`
pool: **`0440`–`0459`**, consuming `0440` for this record (the same move
OP-102/OP-103/OP-104/OP-105/OP-106/OP-107 made for their lanes; ADR-0300 §7). A
**dependent** ticket does not continue its parent's range: OP-107 holds
`0420`–`0439` with `Next free = 0422`, and this lane takes the pool's next free
block, so the README table gains an `OP-108 webhook inbox lane` row with
`Next free = 0441` and the pool row advances to `0460`+. No number outside the
block is touched, and the frozen pre-policy numbers are left alone.
