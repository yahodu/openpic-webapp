# ADR-0882 — OP-137 GREEN: delivery receipts projected into dispatches and suppressions

- **Status:** Accepted (GREEN) · **Date:** 2026-11-20
- **Card:** OP-137 GREEN `t_73b9cd9b` (epic _Webhooks_; phase 6 — M2M, jobs &
  compliance), implementing the pins of [ADR-0875](ADR-0875-op137-delivery-receipts-red.md).
  Branch `OP-137-task-delivery-receipts-green`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_01fd59cf`, stacked on the RED head
  `40df0afd` and merged with `origin/main` `bba5f943`.
- **Implements:** contract §10.1.3 (message transport delivery receipts) on top of
  §10.1's generic inbox; design §19.5 (`notificationDispatches`) and §19.6
  (`notificationSuppressions`); schema §18.4 (the inbox row).
- **Consumes:** [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) §1–§6 (the pins
  and every decision below), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) /
  ADR-0441 (raw-body verification, unique-index dedupe, `after()`-deferred
  projection), ADR-0085 (the pure resolver and its `suppressions` input),
  ADR-0240/0241 (the `sha256:`-prefixed suppression key), ADR-0090 (the fan-out's
  ledger writes), ADR-0096 (OTP delivery through the notification service).
- **Number allocation:** `0882` — the pool head. Both `Next free` cells (`OP-136
jobs lane` and `unallocated (future lanes)`) read `0882` on this base, so both
  advance to `0883`; `ADR-0882` exists on no other branch, worktree, commit or
  open PR head at minting. `ADR-0875` keeps its number and is not renumbered.

## Context

ADR-0875 pinned the §10.1.3 table end to end (9 unit cases, 14 integration cases)
and left two facts of the shipped tree impossible: no receipt was written, and the
fan-out passed `resolveChannel` the literal `suppressions: []`. The GREEN had to
make the pins true without touching a test, and four constraints from the RED
review shaped it:

- the dispatch lookup is by **`providerRef.messageId` alone** — the fan-out writes
  the lane-neutral `providerRef.provider: "transport"` for both adapters, so the
  card's original `{provider, messageId}` filter could never match a real row;
- `@/server/adapters/novu/schemas` already existed, so the receipt schema joined
  it rather than a new `webhook-schemas.ts`;
- `notification_suppressions_channel_contact_unique` is unique on
  `{channel, contactHash}`, so a second hard bounce cannot be a plain
  `insertOne`;
- `NOVU_WEBHOOK_SECRET` had to stay **optional** in `getNovuRuntimeConfig()`: a
  required key would break every suite that boots through `startTestApp` →
  `makeEnv`, whose `DEFAULTS` are fixed.

## Decision

1. **The shared digest is its own module.** `@/server/notifications/contact-hash`
   exports `contactHashOf(contact) = sha256(trim().toLowerCase())` as 64 lowercase
   hex characters. The suppression store is keyed `"sha256:" + contactHashOf(contact)`
   — the form the unsubscribe route already writes — and the fan-out's lookup uses
   it, so a stored row can actually stop a send.
2. **The fan-out resolves suppressions.** `loadRecipientContext` reads the
   recipient's rows for its email and phone destinations in one `$in` query
   (`contactHash` in the two keys, `expiresAt` absent/null or in the future) and
   hands them to `resolveChannel`; the resolver's own scope rule then keeps a
   marketing row from blocking a transactional type (ADR-0085/U11).
3. **The receipt route reuses the inbox shape.** `POST /api/v1/webhooks/novu`
   reads the raw body, verifies Svix's `webhook-id`/`webhook-timestamp`/
   `webhook-signature: v1,<base64>` over `<id>.<timestamp>.<rawBody>` (any `v1,`
   entry may match, ±300 s window), inserts with the provider's own event id as
   the `providerWebhookEvents` identity — the unique index is the dedupe, a
   replay is `200 duplicate_ignored` — answers `200 received`, then registers
   `projectDeliveryReceipt(insertedId)` with `after()`. It is its own route, not a
   `{provider}` segment: the payment inbox compares that segment with
   `config.payments.provider`, and a transport receipt has no such selector.
4. **A blank secret fails closed.** `getNovuRuntimeConfig()` gains
   `webhookSecret` (`NOVU_WEBHOOK_SECRET ?? ""`), and the route refuses every
   request when it is absent or blank. The key is documented in `.env.example`
   and stays optional so the test environment fixture is untouched.
5. **The payload is validated by the envelope schema.** `deliveryReceiptSchema`
   (exported from the projection module) pins the normalized envelope and
   requires `bounceType` exactly when `status` is `"bounced"` — an ambiguous
   bounce must not default to a permanent hard-bounce suppression. The envelope
   is vendor-neutral (ADR-0875 §4: the reducer never sees a vendor field), so it
   lives with the projection rather than in `@/server/adapters/novu/schemas`:
   the ESLint Novu boundary forbids `src/server/notifications/**` from importing
   the adapter at all, and the adapter is where a future vendor wire shape maps
   onto this envelope. The route stores the parsed JSON; the applier parses it
   through the schema, so a shape change is `processResult: "error"` with the
   offending field named and logged at `error` with the provider, while the
   provider still gets its `200`.
6. **Two halves, as OP-108 has them.** `reduceDeliveryReceipt` is pure (receipt +
   matched dispatch + `now` in; patch and suppression draft out) and maps the
   §10.1.3 rows one for one; `projectDeliveryReceipt(inboxId, { db?, clock? })`
   re-reads the row, looks the dispatch up by `providerRef.messageId`, applies the
   patch and **upserts** the suppression with `$setOnInsert` on
   `{channel, contactHash}`, so a repeat bounce is idempotent. An unmatched
   receipt is `processResult: "ignored"` with nothing written but the inbox row.
7. **Suppression keys reuse the ledger's digest.** The draft is `sha256:` + the
   matched dispatch's own `contactHash` (falling back to `contactHashOf(receipt.contact)`
   when the row carries none), which is what U2 pins; the receipt's casing and
   padding never enter the key.

## Consequences

- A dispatch can now advance to `delivered`/`bounced`/`failed` with a
  `deliveredAt`, and a suppression row is consumed, so a hard bounce or an
  unsubscribe stops the next send before the transport is asked.
- The fan-out issues one extra read per recipient (the suppression `$in`). It is
  index-served by `notification_suppressions_channel_contact_unique`'s prefix.
- **Known limit, routed:** the ledger's `contactHash` is still the private raw
  digest (`fan-out.ts` hashes the untrimmed destination), so for a non-canonical
  stored address the key written by the projection
  (`sha256:` + the ledger digest) is not the key the lookup builds
  (`sha256:` + the canonical digest). The pins use a canonical address and cannot
  see it; the repair — the fan-out importing `contactHashOf` — is the TEST card
  `t_8290f915`, which owns changing the ledger field's value against the shipped
  `event-invitations` pins.
- **Not pinned, implemented anyway** at the review's direction: the suppression
  upsert (F5) and the blank-secret refusal (F7). `t_a587c8bd` pins both, plus
  receipt log hygiene.
- Out of scope, unchanged: the optional `STORAGE_WEBHOOKS_ENABLED` storage
  webhook (card §5, no pin), the vendor wire event names (the pins fix the
  normalized envelope only), and the `webhook-projection-sweep` reaching receipt
  rows (the applier has the same seam, but no pin asserts it).

## Tests

No test, fixture or helper was edited. Carried byte-identically from `40df0afd`:
`receipt-projection.test.ts` `9 passed (9)`, `webhook-novu-receipts.test.ts`
`14 passed (14)`. Full `unit` `188 files / 3170 passed | 3 skipped (3174)`; full
`integration` green; the six ADR guards green.
