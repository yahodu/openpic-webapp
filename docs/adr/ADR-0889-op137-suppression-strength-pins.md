# ADR-0889 — OP-137 TEST: suppression **strength** — a hard bounce upgrades a weaker row, and a marketing unsubscribe never downgrades

- **Status:** Accepted (TEST, RED pins + one characterization pin) · **Date:** 2026-11-20
- **Card:** OP-137 TEST (Medium) `t_df4e6eb3`, the routing target of findings **F1**/**F2**/**F4** of the
  landing review of the GREEN `t_73b9cd9b` (PR [#745](https://github.com/yahodu/openpic-webapp/pull/745),
  squash `c92ca81f`). Branch `OP-137-task-suppression-strength-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_df4e6eb3`, cut from the trunk `c96c2d18`.
- **Implements:** contract §10.1.3 (the receipt projection: a hard bounce suppresses the contact for
  **all** scopes; an unsubscribe suppresses **marketing** only) and design §19.6 (the
  `notificationSuppressions` document and its `{channel, contactHash}` key).
- **Consumes:** [ADR-0882](ADR-0882-op137-delivery-receipts-green.md) §1 (the shipped applier, whose
  `$setOnInsert` carries the whole document) and §1's unsubscribe note (the route's own `$set`); the
  user story _"we never re-send to hard-bounced or DND contacts"_;
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12 (allocation, re-sweep, never lower a
  cell).
- **Consumers:** `apps/web/src/test/integration/webhook-novu-receipt-suppression-strength.test.ts` (its
  doc-comment cites this record and every case names `P1`–`P4`).
- **Number allocation:** `0889`. The card body reserved `0885`, but that number was consumed by the
  OP-136 GREEN `t_b7bcc125`'s sibling record before this run and the reviewer's 2026-11-20 10:44
  reservation comment on the card directs this record **above `0888`** (the OP-137 contact-digest pins,
  `ADR-0888`, hold it in flight on draft PR #752 and it is unmerged by design). The sweep in this run,
  at the trunk `c96c2d18` after `git fetch origin --prune`, found both `Next free` cells reading
  `0888`, the trunk's highest record `0887`, `ADR-0884`/`ADR-0886` in other worktrees, `ADR-0888` on
  PR #752, `git rev-list --objects --all -- docs/adr` stopping at `0888`, and no `ADR-0889` — or
  `0890` — file, object, worktree path or PR-head path anywhere. This record therefore takes the
  highest reserved number plus one and advances **both** the `OP-136 jobs lane` cell and the
  `unallocated (future lanes)` cursor to `0890`, one above itself, so neither can re-mint it; no cell
  is lowered (§12). A gap below the cursor would have been allowed (`0885`), but staying above the
  reservation is what the reviewer's correction asked for.

## Context

Two writes own the same `{channel, contactHash}` suppression key (§19.6): the delivery-receipt
projection (`@/server/notifications/receipt-projection`, ADR-0882) and the one-click unsubscribe route
(`apps/web/src/app/api/v1/notifications/unsubscribe/[token]/route.ts`, ADR-0240). A `hard_bounce`
drafts `scope: "all"`; a marketing unsubscribe drafts `scope: "marketing"` and, by §10.1.3's own note,
must never block a transactional OTP. The key is shared, so **which write lands second decides which
contacts keep receiving**, and neither shipped write orders the two strengths:

- The projection upserts with `$setOnInsert` holding the _whole_ document, so an existing row is never
  touched: a later hard bounce is silently dropped.
- The unsubscribe route `$set`s `reason`/`scope`, so a marketing unsubscribe rewrites an all-scope row
  to `scope: "marketing"` and re-enables transactional mail.
- The stored document's _shape_ was unpinned: the shipped pins assert with `expect.objectContaining`,
  which tolerates an extra field — including a raw `contact`.

Measured on this branch's base (`c96c2d18`, the merged GREEN) before any test was added, in this
worktree: pre-seeding the exact row a provider unsubscribe writes for the dispatch's own
`contactHash`, then POSTing a signed hard-bounce receipt, answers route `200`, dispatch
`status: "bounced"`, and the row still reads `{ reason: "unsubscribe", scope: "marketing" }`; a
pre-seeded all-scope row with a past `expiresAt` is never re-armed. Both are one assertion away from
the user story: the next `runNotificationFanOut` of `auth.otp.email.requested` writes a dispatch with
`status: "sent"` for the hard-bounced address.

## Decision

### 1. One new sibling spec, four cases, no shipped pin edited

`apps/web/src/test/integration/webhook-novu-receipt-suppression-strength.test.ts` (536 lines,
`+536/−0`) adds `P1`–`P4`. `webhook-novu-receipts.test.ts` and its fourteen cases are **byte-identical**; no fixture,
helper, factory, route, contract document or frozen record is edited. The new spec boots its own app
(`prefix: "op137-strength"`), builds the declared indexes, seeds the notification catalogue (the
unsubscribe route resolves it) and does not share a database with the shipped suite.

### 2. `P1` — a hard bounce **upgrades** a marketing row, and the send actually stops

Pre-seed exactly what a provider unsubscribe leaves: `{ channel: "email", contactHash:
"sha256:" + <the dispatch's own contactHash>, reason: "unsubscribe", scope: "marketing", expiresAt:
null }`. Act with a signed hard-bounce receipt for that dispatch. Assert `200`, the dispatch
`status: "bounced"`, and the row `{ reason: "hard_bounce", scope: "all", expiresAt: null }`.

The row alone is a database shape, so the case also pins the **observable consequence**: a fresh
`auth.otp.email.requested` fan-out writes **no** dispatch whose `status` is `sent`, and the memory
transport's outbox stays empty. That is the user story, and it is the arm that reddens on the shipped
head for the right reason ("the hard-bounced address receives transactional mail"). It names no
marker field and no ordering, so any upgrade shape satisfies it.

### 3. `P2` — a hard bounce **re-arms** a lapsed row

Pre-seed the same key with `reason: "hard_bounce"`, `scope: "all"` and an `expiresAt` of
`T0 − 1 h` (`T0 = fixtureInstant("00:00:00.000Z")`, i.e. the anchor day's midnight, so "lapsed" is a
fact of the seed and never of when the suite runs). The fan-out's own lookup filters
`$or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]`, so a lapsed row is invisible to it; after
the hard bounce the row must read `expiresAt: null`. Pinning the field, not "the contact receives",
keeps the case independent of P1's send arm.

### 4. `P3` — a marketing unsubscribe **never downgrades** an all-scope row

The unsubscribe token **is** reachable at integration level, so the card's projection-level fallback
was not used: `signUnsubscribeToken` from `@/server/notifications/unsubscribe` with the app's own
`UNSUBSCRIBE_SIGNING_SECRET` (the `startTestApp` harness sets it from `makeEnv`), POSTed to
`/api/v1/notifications/unsubscribe/{token}` exactly as a mail client would. The contact is a real
signed-in identity, the address already carries the `hard_bounce`/`all` row, and the assertion is that
the row survives unchanged while `userProfiles.marketingOptIn` becomes `false` — the stronger
suppression is kept **and** the weaker opt-out is still recorded, so neither half of the user's
intent is lost.

### 5. `P4` — the stored document is the digest only, pinned by key set

A fresh hard bounce (no pre-seed) must leave exactly:

```text
{ _id, channel, contactHash, reason, scope, source: { provider, providerEventId }, createdAt, expiresAt }
```

asserted twice — an exact `toEqual` (with `expect.any(ObjectId)` / `expect.any(Date)`) and
`Object.keys(row).sort()` — plus `JSON.stringify(row)` not containing the raw address, so a raw
`contact` cannot ride along even nested inside `source`. This is the one **characterization** case:
it is green on arrival, and it is what makes the raw-contact mutation red (see §Evidence).

## Consequences

- **The GREEN's repair must update, not insert-only.** The receipt upsert has to `$set` `reason`,
  `scope`, `expiresAt` and `source` on the matched key while leaving `createdAt` insert-only; P4
  requires `source` to remain part of the document, so a repair that drops it fails.
- **The unsubscribe route must not weaken a row.** It keeps writing `marketingOptIn: false` and the
  preferences, and leaves an existing `scope: "all"` row untouched.
- **Known limit, recorded not fixed:** the receipt path's _reverse_ direction — an `unsubscribed`
  receipt arriving **after** a hard bounce — is not pinned by this card. On the shipped head it is
  harmless (the row is never touched), but the naive `$set` repair makes it a real downgrade. The
  GREEN's strength ladder should treat an `unsubscribed` receipt as weaker than an existing
  `hard_bounce`/`complaint` row; no case here holds it, so it is a candidate follow-up, not a claim.
- The PR is a **draft** (OP-93/ADR-0306): `P1`, `P2` and `P3` are RED at this head and the GREEN
  `t_b7bcc125` carries them. `P4` is green and is proven load-bearing by mutation.

## Evidence

- **At the pin head (shipped code, `c96c2d18`):** `3 failed | 1 passed (4)` — `P1` and `P3` with
  `AssertionError: expected { … } to match object …` rendering `reason: "unsubscribe"`,
  `scope: "marketing"` against `hard_bounce`/`all`; `P2` with `expected 2026-11-19T23:00:00.000Z to be
null`; `P4` passing.
- **Satisfiability (throwaway near-fix, both production files restored byte-identically
  afterwards — `git status --short` naming only the new spec):** the naive repair the card describes
  (`$set` the mutable fields + `$setOnInsert: { createdAt }` on the projection; a "skip when the row
  is already `scope: "all"`" guard on the unsubscribe route) turns the file `4 passed (4)` and leaves
  the shipped `14 passed (14)` and the unsubscribe suite's `16 passed (16)` untouched — **three files,
  `34 passed (34)`**. Every one of the four pins is therefore satisfiable without editing a delivered
  case.
- **`P4` load-bearing (same probe, plus `contact: receipt.contact` in the `$set`):**
  `1 failed | 17 passed (18)` — `P4` alone, with `"contact": "strength.recipient@example.com"` shown
  against the exact document, while the shipped `14 passed (14)` stay green. That is precisely the
  hole the card reported: `objectContaining` tolerates the extra key, the key-set pin does not.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 on the new file, `prettier --check`
  clean, the six `adr-*` guards green.

## Alternatives

- **Rewriting `I1`–`I8` instead of a sibling file** — rejected: the delivered cases are the GREEN's
  acceptance evidence and must stay byte-identical, and a sibling spec keeps the new failures
  attributable to the new file.
- **Pinning `P3` at the projection level** (the card's fallback) — not needed: the token is reachable
  through the real route, which is where the defect lives. Pinning the projection with a
  pre-seeded row would have pinned a path that never writes the marketing scope.
- **Keeping `P4` as a `toMatchObject`/`objectContaining` assertion** — rejected: that is the exact
  shape that tolerated the raw contact; the whole-document assertion is the pin.
- **Pinning the send arm of `P2`** rather than the field — rejected: it would duplicate `P1`'s
  consequence and redden for two reasons at once.
