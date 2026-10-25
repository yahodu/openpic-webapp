# ADR-0441 — OP-108 GREEN: the inbox route, the projection and the §18.4 index fix

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-108 GREEN (`t_6a9a0ae6`) · **Branch:** `OP-108-task-webhook-inbox` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a297e850`
- **Relates to:** [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) (the RED contract this implements), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) / [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the port — `verifyWebhook` / `parseWebhook` are §10.1 steps 1–3), [ADR-0383](ADR-0383-op105-memory-payment-provider-red.md) / [ADR-0384](ADR-0384-op105-memory-payment-provider-green.md) (the memory provider `E1` signs with), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the `incomplete` row this inbox activates and the `CASHFREE_*` wiring it reuses), [ADR-0029](ADR-0029-op88-domain-events-red.md) (the outbox every projection emits through), [ADR-0007](ADR-0007-op82-platform-settings-red.md) (the settings singleton `gracePeriodEndsAt` and `expireAt` come from)
- **Contract:** §10.1 (the 8-step handler order), §10.1.1 (the non-negotiable rules), §10.1.2 (the payment mapping), §0.3 / §0.10 / §0.11 (`provider` auth; `/webhooks/**` exempt from CSRF and rate limiting), §11.1 (tagged external identity), §14.3, §14.4, §18.3, §18.4, §21, §22, §23 · **Appendix A:** `invalid_signature`, `stale_signature`

## Context

ADR-0440 fixed the executable contract and left the implementation, plus the
§18.4 index bug, to this card. The pins are 4 spec files: `webhook-projection.test.ts`
(unit, 16), `provider-webhook-inbox.test.ts` (integration, 15),
`provider-webhook-projection-failure.test.ts` (integration, 2) and
`apps/web/e2e/webhook-inbox.spec.ts` (`E1`). Unit and integration drive the
handler in-process against a real MongoDB replica set; `E1` drives a real
`next start` server through the memory provider.

## Decision

### 1. Two modules, and the split is the design

| Module                                   | Exports                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@/app/api/v1/webhooks/[provider]/route` | `POST` — `defineRoute({route: "/api/v1/webhooks/:provider", …})`, **no** request `body` schema, **no** `rateLimit` stage               |
| `@/server/billing/webhook-projection`    | `reduceProviderEvent`, `computeGraceEndsAt`, `projectProviderWebhookEvent`, `isDuplicateKeyError`, and the `Projection*` types         |
| `@/server/db/collections`                | `COLLECTIONS.billingTransactions = "billing_transactions"`                                                                             |
| `@/server/db/indexes`                    | the §14.4 `billingTransactions` indexes + the corrected §18.4 webhook pair                                                             |
| `@/server/payments/get-payment-provider` | `paymentEnvironmentFor(appEnv)` — the one place the vendor environment is derived (§11.1), exported so the inbox stamps the same value |

`reduceProviderEvent` is pure: no database, no clock, no `process.env`. That is
what makes every §10.1.2 row pinnable without Mongo, and what makes a
re-projection after a crash produce a byte-identical decision (the ledger's
`idempotencyKey` is a function of the event identity — `provider:kind:identity:txKind:txStatus`).

### 2. The route reads the raw body itself, and owns the window check

`parseJsonBody` is deliberately **not** declared: it would re-serialise the body
and break the HMAC (§10.1.1). The handler calls `ctx.request.text()` once. The
port's `verifyWebhook` returns a plain `boolean` (ADR-0380 §2) and folds the
±300 s window into it, so the route produces the two Appendix A codes itself:

1. a missing/unparseable `x-webhook-timestamp` or `x-webhook-signature` →
   `401 invalid_signature` (never "no window to check");
2. `|now − ts| > 300_000` → `401 stale_signature`;
3. `!verifyWebhook(...)` → `401 invalid_signature`.

All three warn as `webhook.signature_rejected` with `{provider, reason, ipHash}`:
the IP is hashed (`sha256` truncated to 16 hex chars) rather than logged, and the
raw payload never reaches a log line (§0.15, CONVENTIONS §5.3).

The `{provider}` segment must equal `config.payments.provider` — the key of the
registered adapter. Anything else is `404 not_found` with **no write**: a 5xx on
unroutable input is a crash, not a refusal. Because there is exactly one
configured adapter, no vendor table appears in the route.

### 3. The §18.4 index bug is fixed, and a deployment must rename the old index

`INDEX_SPECS` carried `{provider, providerEventId}` as a **plain** unique index
and no `{provider, payloadHash}` index at all. The Cashfree adapter mints no
event id for `SUBSCRIPTION_STATUS_CHANGED` (ADR-0381), so two _different_ status
changes collided on `(cashfree, null)` and the second was silently swallowed as
`duplicate_ignored` — a missed cancellation. The registry now carries:

- `provider_webhook_events_provider_event_unique` — `{provider, providerEventId}`,
  unique, **partial on `providerEventId: {$type: "string"}`**;
- `provider_webhook_events_provider_payload_unique` — `{provider, payloadHash}`,
  unique, partial on `providerEventId: null` (the second identity shape §18.4
  names, and what makes a byte replay of an id-less payload a dedupe);
- `provider_webhook_events_unprocessed_received` — `{processedAt, receivedAt}`
  partial on `processedAt: null`, the index OP-111's sweep reads.

**Deployment note:** `ensureIndexes` only ever adds — it never drops. A database
that already built the old index keeps it, and the old index still swallows the
second id-less delivery. The operator must
`db.provider_webhook_events.dropIndex("provider_webhook_events_provider_event_unique")`
and re-run `pnpm db:ensure-indexes` (a rename, not an edit).

`billing_transactions` also lands with its §14.4 indexes: the unique
`{idempotencyKey}`, `{tenantId, occurredAt: -1}`, `{subscriptionId, kind, occurredAt: -1}`,
the partial `{externalRefs.provider, externalRefs.id}` pair and the partial
`{status, occurredAt}` on `pending`. It is deliberately **not** added to
`TENANT_SCOPED_COLLECTIONS`: the `{subscriptionId, …}` index is a legitimate
per-subscription scan (see §5 below), and the U1 lint's exception list is owned
by its spec.

### 4. The inbox row, and what "the unique index is the dedupe" means in code

The row is §18.4's document. `eventType` stores the **normalized** `kind`
(§10.1.1 keeps vendor names inside the adapter); `payloadHash` is
`sha256:<hex of the raw body>` and is set **only** when `providerEventId` is
`null`; `env` is `paymentEnvironmentFor(config.app.env)`; `expireAt` is
`receivedAt + platformSettings.retention.webhookDays`. The insert is a bare
`insertOne`, and a `11000` is the deduplication:

- duplicate-key → `200 {"status":"duplicate_ignored"}`, nothing else;
- inserted → `after(() => projectProviderWebhookEvent(insertedId))` and then
  `200 {"status":"received"}`.

There is no read-then-write "have I seen this?" check anywhere (§10.1.1). The
response body is exactly the receipt — no `eventId`, no `processedAt` — because
the projection has not run yet.

### 5. The projection: ordered by the provider's instant, applied in one transaction

`projectProviderWebhookEvent(eventId, {db, clock})` is the seam OP-111's sweep
calls; the route's `after()` work calls the same function.

1. Re-read the row; re-parse `rawPayload` through the configured adapter
   (the stored payload is the parsed JSON, so the rebuild is
   `JSON.stringify(rawPayload)`).
2. Match the subscription by the event's `kind: "subscription"` ref with
   `$elemMatch {provider, kind, id, env}` — §11.1 makes `env` part of the
   identity, so a sandbox event can never address a production subscription
   (`I4`: recorded, `processResult: "ignored"`).
3. **Ordering.** The last applied provider instant is persisted on the
   subscription as `lastProviderEventAt` (the §14.3 schema has no such field
   today, as ADR-0440 §6 recorded); an event whose `occurredAt` is **not
   strictly newer** is ignored. That is what stops `I7`'s late, older failure
   from rolling a renewal success back to `past_due`.
4. Reduce, then apply — and applying is **one transaction** (§23): the
   `billingTransactions` insert (when the decision carries a transaction), the
   `subscriptions` `$set` (when it carries a patch), and one `emitDomainEvent`
   per key with the caller's `session`, so the outbox row commits with the money
   and the access (§18.3).
5. The ledger nests `failureCategory` under `failure: {category}` (§14.4),
   stamps `occurredAt` from the provider's `event_time`, `settledAt`/`createdAt`
   from `now`, and points `rawPayloadRef` at the inbox row's `_id` — a
   reference, never a copy.
6. `processedAt`/`processResult` are written **after** the transaction commits:
   `"applied"` or `"ignored"`. A throw leaves `processedAt: null`,
   `processResult: "error"` and the message on `processError`, and the provider
   is unaffected (`I5`). The failure is recoverable: the second failure spec
   lifts the poisoned ledger validator and re-drives the same row.

Two details of §10.1.2 are easy to get wrong and are pinned here: an activation
writes `status: "active"` / `mandateStatus: "active"` regardless of what the
vendor status string normalized to, and `payment_failed` writes `"past_due"`
from the **row**, not from the event's `status` (the vendor fixture reports
`ACTIVE` on a failed charge — the mapping, not the payload, decides).

### 6. Choices the pins left open

- **The billing period is 30 days.** A successful charge extends the stored
  period (`case end = max(storedPeriodEnd, now) + 30d`), an activation opens one
  (`start = now`). ADR-0440 explicitly left the exact cycle arithmetic
  unpinned; the invariant the pins do hold is that the period only moves
  forward.
- **`lastProviderEventAt`** is the watermark leaf (see §5).
- **The ledger `idempotencyKey`** formula is stated in §1.
- **`tenantId` is accepted as either an ObjectId or a hex string.** §14.3 types
  the field as an `ObjectId` and the checkout path writes one, but the
  integration fixtures seed a hex string, and the outbox's own `tenantId` is a
  string. The applier therefore preserves the value it matched instead of
  normalising it — the ledger row must stay findable by the filter its caller
  used. (First iteration of this GREEN failed every projection until the schema
  accepted both; that is the observation behind the choice, and it is a real
  trap for `billingTransactions` readers.)
- **`refund_processed` patches nothing** (`subscriptionPatch: null`) — §10.1.2
  records the money and leaves access alone, so the applier skips the
  subscription update and the watermark for that row.
- **A signed body the adapter cannot normalize is `400 malformed_json`** and
  writes nothing (there is no `eventType` to record and nothing to re-project).
  Not pinned; the alternative would be a 500 on garbage input.

## Consequences

- A replayed delivery can no longer reprocess: the dedupe is the database's, in
  both identity shapes. `I2` measures it as "one inbox row, one ledger row,
  `duplicate_ignored`".
- Two _different_ id-less status changes both land — the difference between a
  working dunning pipeline and one that silently drops every second
  cancellation.
- Money and access cannot half-move: `I5` pins the `200`, the empty ledger and
  the untouched subscription, and the sweep seam is proven to recover the row.
- The grace deadline is data, not a constant: 14 days by default, 7 after an
  operator edit, measured against the request's own clock readings.
- Late-arriving failures cannot downgrade a customer.

### Evidence

| Gate                 | Result                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| unit (OP-108)        | **16 passed (16)**                                                                                                                           |
| unit (full)          | **110 files / 1915 passed, 3 skipped**                                                                                                       |
| integration (OP-108) | **7 passed / 10 disputed** (see Disputes; every disputed case passes in isolation — one exception, D2)                                       |
| integration (full)   | **77 files / 564 passed**; the only failing files are this lane's two specs                                                                  |
| e2e `E1`             | **1 passed** — a real `next start` (`APP_ENV=e2e`, memory provider): checkout `201`, signed `/webhooks/memory`, polled subscription `active` |
| `pnpm build`         | exit `0`; `/api/v1/webhooks/[provider]` present in the route table                                                                           |
| `tsc -p apps/web`    | exit `0`                                                                                                                                     |
| coverage             | statements `~93.0 %`, branches **81.23 %**, functions 96.36 %, lines **92.88 %** — every threshold above its floor (global 80 %)             |
| ESLint / `prettier`  | 0 errors on the touched files                                                                                                                |

## Disputes

Two defects in the RED specs are left red as delivered — **no test, mock,
fixture or factory was edited**, and the branch's diff is production code, this
ADR and the README ledger row.

**D1 — the integration suites share one database across tests while reusing both
the vendor event ids and the subscription ref id.** `provider-webhook-inbox.test.ts`
boots the app once in `beforeAll` and only clears `platformSettings` in
`beforeEach` (`notification-fanout-cron-route.test.ts` shows the idiom the file
should have used: delete each collection it touches). Every case seeds a
subscription carrying the same `SUBSCRIPTION_REF_ID = "sub_test_001"` and
delivers bodies whose `providerEventId` repeats across cases, so within one file
`webhookRows()` accumulates (`[1, 2, 3, 5]` rows observed where the specs assert
`[1, 1, 2]`) and a later case's payload is either swallowed as
`duplicate_ignored` or matches a previous case's subscription. **Nine of the
ten reds pass when run alone** (`vitest -t "<case>"`), which is the proof that
the implementation, not the assertion, is right:

| Case                                                    | In-file failure               | Solo   |
| ------------------------------------------------------- | ----------------------------- | ------ |
| `I2` replay / id-less dedupe / two different id-less    | row count 2 / 3 / 5           | passed |
| exported projection seam re-projects an unprocessed row | previous case's row picked up | passed |
| `I4` sandbox event vs production subscription           | `duplicate_ignored`           | passed |
| `I6` default 14-day grace / operator 7-day change       | `duplicate_ignored`           | passed |
| `I7` late older failure                                 | `duplicate_ignored`           | passed |
| failure spec `the sweep seam applies the same row…`     | previous case's row picked up | passed |

Proposed fix (Test Author): add a `beforeEach` that clears
`providerWebhookEvents`, `subscriptions` and `billingTransactions` — or give
each case a unique ref id and event id.

**D2 — `I3: a rejected signature warns with the provider and never logs the
payload or the client IP` is unsatisfiable as written.** It builds its request
with `signedHeaders(rawBody)` — the _correct_ secret and a fresh timestamp —
and then asserts `response.status === 401`. A correctly signed body is `200` by
construction (`I1` pins that), in a clean database as much as in-file (observed:
`expected 200 to be 401`). The case's own final pin
(`webhookRows()).toHaveLength(rowsBefore)`) needs the same reading, so the intent
is clearly "an invalid signature warns and logs nothing leaky" — the fix is to
make the body invalid (tamper it, or sign with `not-the-webhook-secret`) while
keeping the `x-forwarded-for` header that the hygiene assertions are about.

## Alternatives considered

- **Verifying inside the adapter.** Rejected: the port's `verifyWebhook` returns
  a boolean and folds the window in, so the two Appendix A codes could not be
  distinguished; widening the port is a cross-lane change for a per-route
  concern.
- **Projecting inline and answering afterwards.** Rejected: §10.1 step 5 and
  ADR-0440's first alternative — a slow projection becomes a redelivery storm.
- **Reading the subscription before ordering, or ordering by `receivedAt`.**
  Rejected: arrival order is not event order; `I7` exists precisely for the
  delayed-but-older failure.
- **Normalising `tenantId` to an ObjectId on the ledger row.** Rejected: the
  ledger must stay findable by the same filter the subscription was matched
  with; normalising silently breaks a reader that passes the stored value.
- **Storing `rawPayload` as the raw string.** Rejected: §18.4 writes a document,
  and the parsed form is what the reconciliation readers and `/admin` expect;
  the signature was verified over the original bytes anyway.
- **Emitting domain events after the commit.** Rejected: §18.3's "write the
  event in the same operation where possible" — a crash between commit and emit
  loses the notification forever.
