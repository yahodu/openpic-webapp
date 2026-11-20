# ADR-0875 — OP-137 RED: delivery receipts projected into dispatches and suppressions

- **Status:** Accepted (TEST, RED) · **Date:** 2026-11-18
- **Card:** OP-137 (phase 6 — M2M, jobs & compliance; epic _Webhooks_) `t_01fd59cf`,
  branch `OP-137-task-delivery-receipts-red`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_01fd59cf`, cut from `origin/main`
  `7e3f642d` and **rebased onto `bffcc881`** (where the pins below were
  re-measured). GREEN successor: `t_73b9cd9b` (same worktree, same branch).
- **Implements:** contract §10.1.3 (message transport delivery receipts) on top of
  §10.1's generic inbox; design §19.5 (`notificationDispatches`) and §19.6
  (`notificationSuppressions`). Test-only: no production file is in the diff.
- **Consumes:** [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / ADR-0441 (the
  generic inbox: raw-body HMAC, unique-index dedupe, `after()`-deferred
  projection), ADR-0085 (the pure channel resolver and its `suppressions` input),
  ADR-0090 (the fan-out's ledger writes), ADR-0240/0241 (the `sha256:`-prefixed
  suppression key), ADR-0096 (OTP delivery through the notification service).
- **Consumers:** `apps/web/src/server/notifications/receipt-projection.test.ts`
  (U1/U2) and `apps/web/src/test/integration/webhook-novu-receipts.test.ts`
  (I1–I8), plus the fixture
  `apps/web/src/test/factories/novu-webhook.ts`. The modules they constrain are
  `@/server/notifications/receipt-projection`,
  `@/server/notifications/contact-hash`, `@/app/api/v1/webhooks/novu/route`,
  `@/server/adapters/novu/schemas` and the suppression lookup the
  fan-out passes to `resolveChannel`.
- **Number allocation:** `0875` is a **single-number pool draw, not a block**. No
  `OP-137` row existed and the `unallocated (future lanes)` cursor read `0875` at
  the pin base `7e3f642d`, so this record minted it; the OP-136 TEST card
  `t_4fe23af4` then found `ADR-0875` in flight and took `0876` (ADR-0876), and the
  trunk advanced the cursor `0876` → `0882` through the landed `0877`–`0881`. The
  block reservation this record first carried (`0875`–`0894`) is **withdrawn** at
  the rebase onto `bffcc881`: re-reserving it would name numbers other lanes have
  already minted, and the pool cursor `0882` sits inside it. `0875` is a gap below
  the cursor, so both `Next free` cells stay `0882` — no cell moves down (ADR-0300
  §12) — and this lane holds no block: like the OP-132 draws at `0877`/`0878` it
  draws each further record from the pool at its own sweep, so the GREEN
  `t_73b9cd9b` takes the pool head it measures. No number outside `0875` is
  consumed and no frozen record is edited.

## Context

The operator story the card states is _never re-send to a hard-bounced or DND
contact, and be able to prove delivery._ Two facts of the shipped tree make that
impossible today, and both are invisible to the existing suite:

- **Nothing writes a receipt.** `POST /api/v1/webhooks/{provider}` (OP-108) is
  gated on `config.payments.provider`, and `MessageTransport`'s
  `TransportReceipt` stops at `{ providerMessageId }`. A `notificationDispatches`
  row is written `sent` by the fan-out and never advances to `delivered`,
  `bounced` or `failed`, so no dispatch carries a `deliveredAt` and no receipt is
  ever projected.
- **Nothing reads a suppression.** `resolveChannel` accepts a `suppressions`
  input and honours its `scope` (`marketing` never blocks a transactional type,
  ADR-0085/U11), but `fanOutToRecipient` passes `suppressions: []` — a literal.
  The one-click unsubscribe row that contract §7.5 and ADR-0241 already write is
  therefore inert: a user who unsubscribes still receives marketing mail, and a
  future hard-bounce row would be equally inert. `notificationSuppressions`
  therefore exists as a store nothing consumes.

The lane also had to settle a **hash-form** question. Three contact-hash call
sites exist and they disagree: `fan-out.ts` hashes the raw destination to bare
hex, `invitation-delivery` reuses it, and the unsubscribe route writes
`sha256:` + the digest of the trimmed, lower-cased address. A suppression keyed
in one form can never match a lookup built in the other, so §10.1.3's "a
subsequent fan-out is skipped" is unsatisfiable until the digest is shared.

## Decision

1. **The shared contact digest.** `@/server/notifications/contact-hash` exports
   `contactHashOf(contact): string` — `sha256(trim().toLowerCase())`, 64
   lowercase hex characters — and every site that needs a _lookup key_ imports
   it. The `notificationDispatches.contactHash` field keeps its bare-hex form
   (shipped pins in `event-invitations.test.ts` assert it), and the suppression
   key is the `sha256:`-prefixed form §19.6 documents, which the unsubscribe
   route already writes. One digest, one prefix, no second hash.
2. **The receipt webhook is its own route.** `POST /api/v1/webhooks/novu`
   (`@/app/api/v1/webhooks/novu/route`) reuses the OP-108 inbox _shape_ — raw
   body, verification before any write, `providerWebhookEvents` identity +
   unique index as the dedupe, `200` before projection, projection deferred
   through `after()` — rather than widening the payment-gated `[provider]`
   route. The payment inbox's first act is to compare the path segment with
   `config.payments.provider`; a transport receipt has no such selector, and
   folding two provider families into one segment comparison would make a
   transport key and a payment key collide.
3. **Signature: Svix, which is what Novu uses today.** Headers `webhook-id`,
   `webhook-timestamp` and `webhook-signature: v1,<base64>`; the signed content
   is **`<id>.<timestamp>.<rawBody>`** keyed by the base64-decoded
   `NOVU_WEBHOOK_SECRET` with its `whsec_` prefix stripped; a header carrying
   several space-separated `v1,` entries verifies when **any** entry matches
   (key rotation). The ±300 s replay window is OP-108's. A missing, malformed,
   stale or non-matching signature is `401` and writes nothing.
   _This is the one vendor fact the pins fix, and it is the vendor's documented
   scheme rather than an invention; the card requires the GREEN to re-verify it
   against Novu's current docs before implementing._
4. **The payload the lane pins is the normalized envelope.** The body parsed by
   `@/server/adapters/novu/schemas` is
   `{ eventId, transactionId, status, channel, to, bounceType?, occurredAt }`
   with `status ∈ delivered | bounced | complained | unsubscribed | dnd_rejected`
   and `bounceType` present iff `bounced`. The vendor's own wire shape maps onto
   this envelope inside the adapter; the reducer and the applier never see a
   vendor field, and the reducer's contract is what the pins measure
   (design §19.6 "vendor ids live in `providerRef` only", CONVENTIONS §7).
5. **Two halves, as OP-108 has them.** `reduceDeliveryReceipt` is pure (U1/U2):
   normalized receipt + matched dispatch + `now` in, `{ processResult,
dispatchPatch, suppression }` out. `projectDeliveryReceipt(inboxId, { db?,
clock? })` is the applier (I1–I8): re-read the inbox row, parse `rawPayload`
   through the adapter, look the dispatch up by
   `{providerRef.provider, providerRef.messageId}`, apply the patch and upsert
   the suppression. A row that cannot be parsed is `processResult: "error"` with
   a `processError` naming the offending field, logged at `error` with the
   provider — the provider is never told, exactly as the payment projection
   records its own failures so the sweep can retry them.
6. **The fan-out resolves suppressions.** `fanOutToRecipient` builds the
   recipient's suppression list from `notificationSuppressions` (keyed
   `{channel, contactHash: "sha256:" + contactHashOf(contact)}`) and passes it to
   `resolveChannel` instead of `[]`.

## Tests delivered

| Case  | What it pins                                                                                                                                                                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 ×6 | the §10.1.3 table, one row per receipt kind: `delivered` (+`deliveredAt`), `hard_bounce` (+`all` suppression), `soft_bounce` (`failed`, `attempts++`, **no** suppression), `complaint` (`failed` + `all`), `unsubscribe` (`marketing`, never `all`, never `delivered`), `dnd_rejection` (`dnd_registry`, `all`, SMS channel) |
| U1 ×1 | a receipt no dispatch matched is `ignored`, with no patch and no suppression                                                                                                                                                                                                                                                 |
| U2 ×2 | the suppression key reuses the ledger's digest even when the payload's address differs in case and spacing; `contactHashOf` is one canonical lowercase hex digest                                                                                                                                                            |
| I1    | a signed `delivered` receipt: `200 received` first, dispatch still `sent`, then `delivered` + `deliveredAt` + `applied`, no suppression                                                                                                                                                                                      |
| I2 ×2 | a hard bounce inserts one `all`-scope row keyed by the **fan-out's** hash; a later fan-out to that address is `skipped` / `suppressed` and the transport is never called                                                                                                                                                     |
| I3    | a soft bounce: `failed`, `attempts` incremented, no suppression row                                                                                                                                                                                                                                                          |
| I4    | a `marketing`-scope unsubscribe suppression blocks a marketing email **and** lets the transactional OTP through (both arms in one case: the scope semantics are one behaviour)                                                                                                                                               |
| I5 ×2 | a byte-identical replay is `200 duplicate_ignored`, one inbox row, one projection; a second _event id_ for the same message is its own delivery                                                                                                                                                                              |
| I6    | a payload missing `transactionId` is still `200`, recorded `processResult: "error"` with a `processError` naming the field, logged at `error` with `provider: "novu"`, and projects nothing                                                                                                                                  |
| I7 ×5 | no signature headers, a body modified after signing, a stale timestamp, a foreign key: `401` and zero rows; a rotated header verifies when any `v1,` entry matches                                                                                                                                                           |
| I8    | an unmatched receipt is `ignored`, never an error                                                                                                                                                                                                                                                                            |

## Evidence

Re-measured at the rebased head on `origin/main` `bffcc881` (the base the PR
targets), all probes deleted before the commit:

- **Assertion-level RED, proven with stubs (deleted).** With minimal stubs at the
  three intended paths (`contact-hash.ts`, `receipt-projection.ts` returning an
  inert `ignored` projection, and a `novu/route.ts` that answers `200` and writes
  nothing), `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0`, so the pins are
  type-correct against the contract above. The specs then fail on their own
  assertions: unit `8 failed | 1 passed (9)` (`expected 'ignored' to be 'applied'`,
  `expected undefined to be 'sha256:'`, `expected '' to match /^[0-9a-f]{64}$/`) and
  integration `14 failed (14)` (`expected 401 to be 200`-style arms read
  `expected 200 to be 401`, `expected undefined to match object { processResult:
'ignored' }`, and every projection arm on `status: "sent"`).
- **Satisfiability of the fan-out half, measured.** One throwaway edit to
  `fan-out.ts` alone — reading the recipient's `notificationSuppressions` rows and
  passing them to `resolveChannel` in place of the literal `[]` — turns **I4
  green** (`-t I4` → `1 passed | 13 skipped (14)`, its log carrying
  `notification.skipped … reason: "suppressed"` for
  `account.verification.incomplete` and `notification.dispatched` for
  `auth.otp.email.requested`) while the rest stay red. The file was restored
  byte-identically (`sha256 06fa2c9a…eb643a`, `git status --porcelain` empty), so
  the 401/projection arms are not what I4 depends on.
- **Satisfiability of the projection half, measured on the identical module
  state.** A correct pure reducer + the shared digest turned the unit file
  `9 passed (9)`, and a near-complete _route_ (signature, replay window, inbox
  insert, dedupe, `after()`) with the projection left a no-op turned exactly the
  inbox arms green (`7 passed | 7 failed (14)` — all of I5 and I7) and left
  I1/I2/I3/I6/I8 red on `status: "sent"`. That probe was run at `7e3f642d`;
  `git diff --stat 7e3f642d..bffcc881 -- apps/web/src/server/notifications
apps/web/src/app/api/v1/webhooks` is **empty**, so it transfers to this head
  unchanged.
- **By construction, reported honestly.** With the inert reducer, U1's _unmatched_
  arm passes: a reducer that returns `ignored` for every input satisfies a negative
  pin. It is kept because it is the acceptance criterion "an unmatched receipt is
  ignored, not an error" and it reddens as soon as the reducer gains a matched arm
  that leaks a patch on `null`.
- **Red on handoff.** The production modules do not exist, so the delivered state is
  `Cannot find package '@/server/notifications/contact-hash'` (unit) and
  `… '@/app/api/v1/webhooks/novu/route'` (integration), 0 tests collected.
  `git status --short` is empty and the diff is the three test files, this record
  and the ledger.

## Consequences

- A transport receipt can now advance a dispatch to `delivered`/`bounced`/
  `failed`, which is the evidence the operator story asks for (`deliveredAt`).
- A suppression row is _consumed_: the unsubscribe surface stops being inert, and
  a hard bounce stops the next send before the transport is called.
- The GREEN must extract `contactHashOf` into a shared module and keep the
  dispatch field bare-hex while the suppression key is prefixed; a single-site
  re-implementation of the hash is exactly what U2 forbids.
- `NOVU_WEBHOOK_SECRET` joins the environment. A blank or absent secret must be a
  refusal, not a wildcard — the pins do not cover that arm (see below), so the
  GREEN owes an explicit fail-closed decision and its own `.env.example` /
  env-changes note.

## Out of scope (not pinned, deliberately)

- **The storage webhook** (`POST /api/v1/webhooks/storage`,
  `STORAGE_WEBHOOKS_ENABLED`, §10.1.4) — the GREEN card's §5 makes it optional
  behind a flag; it shares no code with the receipt projection beyond the inbox.
- **The `complaint` dispatch status.** §10.1.3 names `failed` for a complaint and
  nothing for `unsubscribe`/`dnd_rejection`; the two unnamed arms pin the
  suppression only, plus "never `delivered`".
- **The vendor wire shape and the vendor event-name table.** Both live in
  `adapters/novu/schemas.ts`, which the GREEN owns; the pins fix only the
  envelope the projection consumes.
- **A blank `NOVU_WEBHOOK_SECRET`** — fail-closed is asserted nowhere yet.
- **The `providerRef.provider` tag.** The fan-out writes `"transport"` for both
  the memory and Novu adapters; the pins name only `providerRef.messageId`, so a
  later per-adapter tag does not break them.
- **Retention and the `env` label** of the receipt inbox row — §10.1.3 says
  nothing about either for this provider.
- **The `webhook-projection-sweep` re-projection of a receipt row.** The applier
  is exported with the same seam shape, so the sweep can adopt it, but no pin
  asserts the sweep reaches it.
