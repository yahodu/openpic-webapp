# ADR-0103 — OP-95 follow-up GREEN: synchronous OTP `actionUrl`, the catalogue-fallback guard and the sync-path polish

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-95 follow-up GREEN (`t_17ca0cb6`, assignee `openpic-webapp-backend-coder`); RED pins in `t_7fde2bdd`
- **Depends on:** OP-95 (ADR-0096 RED, ADR-0098 GREEN, ADR-0099 review sign-off), OP-94 (ADR-0092 fan-out ledger, ADR-0094 polish), OP-93 (ADR-0085 `renderTemplate`), OP-92 (ADR-0072 `MessageTransport`)
- **Findings source:** ADR-0099 §Findings 1–5; pinned by ADR-0102 (F1/F2/F5) and card §Internal-quality (F3/F4)
- **Contract:** §0.13 (secret redaction), §7.6 (type catalogue) · **Design:** §5/§8.2

## Context

The OP-95 follow-up RED (`t_7fde2bdd`, ADR-0102) pinned three reviewer findings
as failing integration specs and routed two behaviour-preserving chores to this
GREEN card. This ADR records the implementation decisions that turn every pin
green without touching a test file.

**ADR renumber (collision).** This lane originally claimed `0100` (RED) and
`0101` (GREEN) at branch time; before merge, `origin/main` landed a _different_
OP-95 follow-up lane that claimed `0100`/`0101` for a test-reference renumber
(PR #196/#198). This lane therefore renumbers to `0102` (RED) / `0103` (GREEN)
per the repo convention (the later-arriving lane yields). The pins' test-file
docstrings still cite `ADR-0100`; they are comment-only references and were left
untouched (this card writes no test changes). The Test Author can re-point them
in a future cycle; the authoritative RED record is `ADR-0102`.

## Decision

### F1 — the synchronous OTP path supplies the `actionUrl` it renders

`auth.otp.email.requested` declares `code` **and** `actionUrl`; the synchronous
sender passed only `{ code }`, and `renderVarsFor` (`fan-out.ts`) defaults every
missing declared variable to `""`, so the email read `"… View the details at ."`.

`notificationOtpSender` now reads the validated `getConfig().app.baseUrl` once
at construction and passes it as `payload.actionUrl` alongside `code`. The
renderer therefore satisfies the declaration instead of masking it:

- `renderVarsFor` stays strict (no loosening of its empty-variable default).
- The OP-94 I6 pin is untouched: the template still declares `actionUrl`.
- The SMS type declares only `code`, so the extra `actionUrl` payload key is
  dropped by `renderVarsFor` (it only projects declared variables) and the SMS
  body is unchanged.
- `retainBody: false` is intact: the ledger row still carries no body and no
  `actionUrl`/code value.

Pinned by F1/F1b in `apps/web/src/test/integration/notification-otp-delivery.test.ts`.

### F2 — no silent seed-catalogue fallback: production refuses, non-production warns

The seed fallback itself is the sanctioned E1 resolution (ADR-0098 §6) and is
kept. `sendTransactionalNow` now routes both fallback sites through
`guardSeededCatalogueFallback(typeKey, collection)`:

- The type-row fallback (`storedType ?? seededTypeRow(...)`).
- The template fallback (`storedTemplates.get(group) ?? seededTemplates(...)`),
  so a missing stored template for the resolved group follows the same rule.

Behaviour:

- **production** — throw before the dispatch insert and before any transport
  hand-off, so an empty or schema-invalid stored catalogue can never be served
  by the compile-time seed (no orphan row, no phantom send).
- **non-production** — keep delivering from the seed but emit a `warn`-level
  line `event: "notification.catalogue_fallback"` carrying `typeKey` (and the
  catalogue `collection`).

The guard reads `getAppEnv()` — the uncached `process.env.APP_ENV` reader — not
the memoised `getConfig()`, so a runtime environment change is honoured at call
time (ADR-0102 "testability contract").

Pinned by F2/F2b in
`apps/web/src/test/integration/notification-otp-catalogue-fallback.test.ts`.

### F5 — the phone-path 503 surface (characterization)

No production change. `POST /api/auth/phone-number/send-otp` already used the
same `notificationOtpSender` and the `OTP_SEND_PATHS` re-throw
(`auth/index.ts`), so a retryable `TransportError` already surfaced as
`503 upstream_unavailable` with a `failed`/`attempts: 1`/`retryable` dispatch
row. ADR-0102 recorded the RED-honesty note (a coverage gap, not a defect); I4
is a green regression pin and passes unchanged. Confirmed locally.

### F3 — the independent synchronous reads are issued together

`sendTransactionalNow` issued `loadTypeRow` → `loadTemplates` →
`getPlatformSettings` sequentially. The three are independent and are now
issued in one `Promise.all`. `resolveUserId` (in `otp-sender.ts`) remains a
distinct upstream step: it is resolved in the sender module and feeds the
dispatch record's `userId`, and the three catalogue/settings reads are the
dominant latency; no signature change was needed or made.

Behaviour-preserving: the same reads, the same order-independent results, the
same errors (a rejection from any read rejects the call before any write).

### F4 — the non-deliverable-channel guard runs before the insert

The guard lived after `insertOne` and outside the `try`, so a resolved
`in_app`/`whatsapp` target could leave a permanently `queued` orphan dispatch
row. The check `target.channel !== "email" && target.channel !== "sms"` now runs
immediately after `resolveOtpTarget`, before the ledger insert. A non-deliverable
target throws with no row written. For the OTP path the resolver pins
`email`/`sms` (`resolveOtpTarget`), so this is a latent-defect guard only.

## Consequences

- The synchronous OTP copy is well-formed end-to-end: the email carries the
  configured app link and the code, with no unresolved placeholder or `" at ."`
  artefact; the SMS carries the code.
- The production catalogue is authoritative; any non-production seed fallback is
  observable in the log stream.
- The synchronous path costs one round-trip fewer and can no longer persist an
  orphan `queued` row for a non-deliverable channel.
- No test file was edited; the RED pins from ADR-0102 ship green in this PR.
- F5 ships as a regression pin only — recorded, not manufactured into a defect.

## Alternatives considered

- **Loosen `renderVarsFor` to default `actionUrl` to the base URL.** Rejected:
  it would make the renderer infer a variable the payload did not supply and
  hide a future missing-variable regression; supplying the variable at the
  sender is the honest fix (ADR-0102 also prefers it).
- **Always throw on the seed fallback (every environment).** Rejected:
  ADR-0098 §6 keeps the seed for non-production (E1 boots an unseeded catalogue).
- **Guard only the type row, not the template fallback.** Rejected: ADR-0102
  states the template fallback "follows the same decision", and a missing
  template group is the same silent-seed class of miss.
- **Restructure `sendTransactionalNow` to resolve `userId` internally so it
  overlaps the catalogue reads.** Rejected: it changes the pinned
  `TransactionalSendInput` contract for a marginal overlap; the three reads now
  run concurrently, which is the reported cost.
- **Leave F4 after the insert and delete the row on throw.** Rejected: a
  pre-insert validation is simpler, has no write, and cannot race with a reader.

## Out of scope

- The asynchronous fan-out path's own reads/fallbacks (unchanged; not pinned).
- Suppression-list handling, the `after()` opportunistic trigger and the cron
  fan-out route (unchanged from ADR-0096/ADR-0098 scope).
- Product copy beyond well-formedness: the marketing wording stays
  `TODO(product)`; only structure (no empty variable, has the link) is pinned.
