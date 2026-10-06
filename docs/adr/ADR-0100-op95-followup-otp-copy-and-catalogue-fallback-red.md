# ADR-0100 — OP-95 follow-up RED: synchronous OTP copy `actionUrl` and the catalogue-fallback guard

- **Status:** Accepted · **Date:** 2026-10-06
- **Card:** OP-95 follow-up RED (`t_7fde2bdd`), GREEN card `t_17ca0cb6` (assignee `openpic-webapp-backend-coder`)
- **Depends on:** OP-95 (ADR-0096 RED pins, ADR-0098 GREEN), OP-94 (ADR-0092 fan-out ledger, ADR-0094 polish), OP-93 (ADR-0085 `renderTemplate`), OP-92 (ADR-0072 `MessageTransport`)
- **Findings source:** ADR-0099 §Findings 1/2/5 (Medium/Low/Low)
- **Contract:** §0.13 (secret redaction), §7.6 (type catalogue) · **Design:** §5/§8.2

## Context

The OP-95 GREEN review (ADR-0099) approved the synchronous OTP delivery path
with three non-blocking findings routed to a fresh TDD cycle. This card is that
cycle's RED half: it touches **test files only** and fixes the intended
behaviour the GREEN implementer must satisfy.

1. **F1 (Medium).** `auth.otp.email.requested` declares `code` **and**
   `actionUrl`; the synchronous sender passes only `{ code }`, and `renderVarsFor`
   (`fan-out.ts:425`) defaults every missing declared variable to `""`. The
   delivered email therefore read
   `"Your OpenPic verification code is 123456. It expires in a few minutes. View the details at ."`
   — a user-visible empty-variable artefact.
2. **F2 (Low).** `sendTransactionalNow` does `storedType ?? seededTypeRow(...)`
   (`fan-out.ts:1330`); `loadTypeRow` returns `null` for an absent **or**
   schema-invalid row, so the compile-time seed silently serves OTPs in
   production too, with no log.
3. **F5 (Low/Info).** The 503 `upstream_unavailable` surface is pinned only for
   `/email-otp/send-verification-otp` (integration I3); the phone path is
   unpinned.

## Decision

### F1 — the synchronous OTP path supplies the `actionUrl` it renders

`notificationOtpSender`/`sendTransactionalNow` must supply the `actionUrl`
variable the `auth.otp.email.requested` template declares, using the validated
`getConfig().app.baseUrl` as the destination (a non-secret app link; product may
later choose a deep link). Pinned in
`apps/web/src/test/integration/notification-otp-delivery.test.ts`:

- **F1** — the synchronous email body `toContain`s the configured base URL
  (`APP_BASE_URL`, i.e. `getConfig().app.baseUrl`), still `toContain`s the
  6-digit code (regression, extends I1), `not.toContain("{{")`, and does not
  match `/\bat\s*\./i` (the `" at ."` empty-variable artefact).
- **F1b** — the same well-formedness holds for the mobile/sms body (which
  declares only `code`).

This keeps the OP-94 I6 pin intact: `auth.otp.email.requested` still declares
`actionUrl`; the _synchronous path_ now satisfies the declaration instead of the
renderer masking it with `""`.

### F2 — no silent seed fallback; production refuses, non-production warns

The seed fallback itself is the sanctioned E1 resolution (ADR-0098 §6) and is
**kept**. What changes is that it is never _silent_. Pinned in
`apps/web/src/test/integration/notification-otp-catalogue-fallback.test.ts`:

- **F2 (production)** — with a production environment and an empty
  `notificationTypes` catalogue, `sendTransactionalNow` rejects before writing a
  dispatch row or handing a message to the transport (`outbox` empty,
  `dispatches` count 0). It must not silently serve the seed.
- **F2b (non-production)** — outside production the fallback still delivers
  (`status: "sent"`, one outbox message, one dispatch row) **and** emits a
  `warn`-level log with `event: "notification.catalogue_fallback"` carrying the
  `typeKey`.

**Testability contract.** The guard must consult the environment **at call
time** through the existing uncached reader `getAppEnv()` (`@/server/config/env`),
not the memoised `getConfig()`. `getConfig()` caches its first parse
(`env.ts:535`), so a boot-time answer would pin the guard. The F2 spec stubs a
full valid production environment (non-memory providers) so a rejection can
never be confused with an unrelated `ConfigError`; the F2b spec asserts the
warn line so a silent fallback fails loudly. A schema-invalid stored row takes
the same `loadTypeRow → null` path and is covered by the same guard.

### F5 — the phone-path 503 surface (characterization, not RED)

Pinned in `notification-otp-delivery.test.ts`:

- **I4** — a retryable `TransportError` from the transport during
  `POST /api/auth/phone-number/send-otp` yields `503` with
  `code: "upstream_unavailable"`, a single `status: "failed"`, `attempts: 1`,
  `lastError.retryable: true` dispatch row for `auth.otp.mobile.requested`
  (no 6-digit string anywhere in it), and no secret in the captured logs
  (`sixDigitStrings` empty + `expectNoSecretsInLogs`).

**Honesty note (recorded, not hidden).** Independent probe on the base commit
`d261297` showed the phone path **already** satisfies this contract: the phone
OTP uses the same `notificationOtpSender` and `OTP_SEND_PATHS` re-throw
(`auth/index.ts:103`), and the probe returned `503 upstream_unavailable` with a
`failed`/`retryable` dispatch row and clean logs. ADR-0099 §59 itself rates F5
"Low/Info … only the email path is pinned" — i.e. a coverage gap, not a defect.
I4 is therefore delivered as a **green characterization / regression pin**, not
a RED pin; the "all three specs fail on `origin/main`" acceptance bullet holds
for F1 and F2 only.

### Secondary — e2e rate-limit de-flake

`apps/web/e2e/rate-limit.spec.ts` used a fixed `CLIENT_IP`; because the e2e
server is reused (`reuseExistingServer`) and the rate limiter is process-global
memory state, a re-run (or a parallel repeat) started with a partially consumed
bucket — the observed flake (`ratelimit-remaining` `59` → `57` → `0`). The spec
now derives a fresh TEST-NET-3 `x-forwarded-for` **inside the test** (so a
Playwright retry also gets a clean bucket). Verified by `--repeat-each=3`
(3/3 passed). Not coupled to F1/F2/F5.

## RED evidence (base `origin/main` = `d261297`)

`TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration notification-otp-delivery notification-otp-catalogue-fallback`
→ 3 failed / 5 passed:

- `F1 … toContain 'http://localhost:3000'` — received
  `"… View the details at ."` (the artefact).
- `F2 … promise resolved "{ dispatchId, providerMessageId, status: 'sent' }" instead of rejecting`.
- `F2b … the seed fallback must be recorded at warn level: expected undefined to be defined`.

`F1b`, `I1`, `I2`, `I3`, `I4` pass on the base commit — `I4` deliberately so (see
the F5 honesty note).

## Consequences

- The synchronous OTP copy is well-formed end-to-end: the email carries the app
  link and the SMS carries the code, with no unresolved placeholder. A
  regression in variable projection fails loudly instead of shipping `" at ."`.
- The production catalogue is authoritative: a missing/invalid `notificationTypes`
  row can no longer be masked by the seed in production, and any non-production
  fallback is observable in the log stream (`notification.catalogue_fallback`).
- The phone-path 503 contract is now guarded against Better Auth internal drift.
- The e2e rate-limit spec no longer depends on cross-run limiter state.

## Out of scope (deliberately not tested)

- The remaining ADR-0099 findings routed to the implementer follow-up
  (`t_17ca0cb6`): F3 (sequential independent reads) and F4 (non-deliverable-channel
  guard after insert). Behaviour-preserving; not part of this RED card.
- Suppression-list handling, the `after()` opportunistic trigger and the
  cron fan-out route (unchanged from ADR-0096/ADR-0098 scope).
- E2E/v2 product copy beyond well-formedness: the marketing wording stays
  `TODO(product)`; only _structure_ (no empty variable, has the link) is pinned.

## Alternatives considered

- **Remove `actionUrl` from the `auth.otp.email.requested` template** instead of
  supplying it. Rejected: it would break the OP-94 I6 pin that requires the
  template to declare `actionUrl`, and it deletes a legitimate call-to-action
  rather than fixing the projection.
- **Pin the F2 fallback as "always throw" in every environment.** Rejected:
  ADR-0098 §6 sanely keeps the seed fallback for non-production (E1 boots an
  unseeded catalogue); only production must refuse.
- **Assert only the absence of the fallback, without the warn log.** Rejected:
  the finding is specifically about a _silent_ fallback; a non-production
  fallback that is not logged leaves the same blind spot.
- **Pin F5 with a synthetic gap so it is RED.** Rejected: inventing a defect the
  code does not have would be dishonest. The phone path is pinned as a
  characterization test and the coverage gap is closed without a production
  change.
