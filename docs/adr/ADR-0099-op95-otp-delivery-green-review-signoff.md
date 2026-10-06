# ADR-0099 — OP-95 GREEN review sign-off: synchronous OTP delivery ships with hardening follow-ups

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-95 GREEN (`t_0e8a6a84`, reviewer `openpic-webapp-reviewer`)
- **Reviewed artifact:** PR #194, head `6caad97`, squash-merged to `main` as `da7e3c3`
- **Contract:** ADR-0096 (RED pins) · ADR-0097 (RED review) · ADR-0098 (GREEN) · ADR-0092 (fan-out ledger) · ADR-0072 (`MessageTransport`)
- **Verdict:** APPROVED WITH FINDINGS (no Critical/High)

## Context

OP-95 GREEN replaced the OP-85 memory OTP capture with the real
`notificationOtpSender` → `sendTransactionalNow` → `MessageTransport` path and
turned every RED pin green (unit U1/U2, integration I1–I3, e2e E1). This ADR
records the independent review: what was verified, the findings that do **not**
block the merge, and where each one was routed.

## Decision

Ship PR #194. The pins are satisfied and the suite is green; the findings below
are hardening items routed to follow-up cards, not contract violations. Per
`AGENTS.md` §3.3 the reviewer made **no code edits** — findings were recorded on
the PR (summary + inline comments), on the card, and in follow-up cards.

## What was independently verified (head `6caad97`)

- unit 1444/1444 (79 files); integration 297/297 (40 files, real MongoMemoryReplSet);
  e2e 16/16 (incl. the new E1); `tsc --noEmit` clean; eslint 0 errors / 39
  pre-existing warnings; prettier clean; all PR checks green.
- Acceptance criteria mapped: OTP absent from feed/log/ledger (I1 deep
  `sixDigitStrings` scan + `expectNoSecretsInLogs` + feed count 0); `sms` even
  for `whatsappCapable` (U1b/U1c, I2); retryable failure (I3 → 503
  `upstream_unavailable`, `lastError.retryable`).
- Honesty audit: no test file touched after the RED commit `2251e06`; no
  env/test conditionals, `@ts-ignore`/`eslint-disable`, or fixture-shaped
  hardcoding in production paths.

## Findings (all non-blocking) and routing

1. **Medium — `renderVarsFor` defaults every missing declared variable to `""`.**
   Verified by rendering the checked-in templates: the synchronous email body is
   `"… It expires in a few minutes. View the details at ."` because
   `auth.otp.email.requested` declares `actionUrl` (kept for the OP-94 I6 pin)
   but the sync payload only carries `code`. The same change silently masks
   payload/template drift for _every_ type. Routed to a Test-Author RED card
   (pin the intended behaviour) → implementer GREEN.
2. **Low — `sendTransactionalNow` silently falls back to the checked-in seed
   catalogue in every environment**, including production, and also when a
   stored row fails schema validation. Routed with finding 1.
3. **Low — the synchronous path awaits independent reads sequentially**
   (`resolveUserId` → `loadTypeRow` → `loadTemplates` → `getPlatformSettings`).
   Behaviour-preserving refactor; routed to the implementer follow-up.
4. **Low — the non-deliverable-channel guard runs after the dispatch insert and
   outside the `try`**, so an unexpected channel would leave a permanently
   `queued` orphan row. Unreachable for the OTP types today; routed to the
   implementer follow-up.
5. **Low/Info — the 503 surface depends on Better Auth internals**
   (`runInBackgroundOrAwait` swallowing rejections, the `OTP_DELIVERY_FAILURE`
   slot on the shared `ctx.context`, and the hard-coded `OTP_SEND_PATHS`); only
   the email path is pinned. Routed to the Test-Author RED card (phone-path pin).

## Consequences

- `main` carries the synchronous OTP delivery path; the seed fallback is the
  documented E1 resolution (ADR-0098 §6) and is re-examined by finding 2.
- The placeholder OTP copy is still `TODO(product)`; finding 1 keeps the
  user-visible empty-variable artefact on the backlog.
- Suppression handling remains owned by OP-99; §4 of the GREEN card was surfaced,
  not implemented.
