# ADR-0098 — OP-95 GREEN: OTP delivery through the synchronous NotificationService entry point

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-95 GREEN (`t_0e8a6a84`, assignee `openpic-webapp-backend-coder`)
- **Contract:** ADR-0096 (OP-95 RED pins) · ADR-0092 (fan-out ledger) · ADR-0085 (`resolveChannel` + `renderTemplate`) · ADR-0072 (MessageTransport)
- **Depends on:** OP-94, OP-85, OP-93, OP-92

## Context

OP-95 RED (ADR-0096) pinned the synchronous transactional path as the two pure
helpers `resolveOtpTarget` / `buildDispatchRecord` (unit) plus the end-to-end
`notificationOtpSender` → `sendTransactionalNow` → `MessageTransport` journey
(integration I1–I3, e2e E1). This ADR records how the GREEN implementation
satisfies those pins, and the four non-obvious decisions forced by the existing
library and test surface.

**ADR renumber (merge hygiene, 2026-10-05).** This lane originally numbered its
records 0094/0095/0096, but main had already accepted `ADR-0094-op94-fan-out-polish`
and its sign-off (#193) under 0094/0095. To keep one decision per number, the
unmerged OP-95 records were renumbered: RED → ADR-0096, RED sign-off → ADR-0097,
GREEN → ADR-0098. Production comments were updated; the ADR number still quoted
in the OP-95 **test-file** docstrings (`fan-out-transactional.test.ts`,
`notification-otp-delivery.test.ts`, `otp-notification-delivery.spec.ts`) is left
for a Test Author follow-up — GREEN must not edit specs.

## Decision

### 1. `sendTransactionalNow` lives in `fan-out.ts`

Per the operator routing note on `t_a4ec4d74`. It resolves the type (DB first,
seed fallback), reuses `resolveOtpTarget` → `resolveChannel`, renders through
`renderTemplate`, persists **one** `notification_dispatches` row, hands the
rendered `OutboundMessage` to the injected transport, and returns
`{ dispatchId, status, providerMessageId }`. A transport failure updates the row
to `failed` (classified `lastError`) and rethrows.

### 2. Metadata-only ledger row

`buildDispatchRecord` stamps `body` only when `typeRow.retainBody === true`.
Every `auth.otp.*` type is `retainBody: false`, so the code is never persisted.
The synchronous row adds `body` (the one §19.5 deviation, ADR-0096 assumption 3)
and keeps the async fan-out's persistence untouched (`body` absent there).

### 3. Better Auth swallows plugin callback errors — the 503 is surfaced by the `after` hook

**Finding (reviewer note (a) under-specified the mechanism).** Better Auth's
`sendVerificationOTP` / `sendOTP` callbacks are invoked through
`ctx.context.runInBackgroundOrAwait`, which catches a rejected promise and only
logs it. A thrown `APIError` therefore does **not** reach the client — the
endpoint still returns `200`, which is what the RED baseline and a naive
implementation both produced.

The GREEN wires it so the failure is still surfaced as the retryable `503`
`upstream_unavailable` the pins require:

1. `notificationOtpSender` maps a retryable `TransportError` to
   `APIError.from("SERVICE_UNAVAILABLE", { code: "upstream_unavailable" })`.
2. The plugin callback catches that error and stashes it on the shared request
   context, keyed `__openpicOtpDeliveryFailure` (the endpoint ctx and the global
   `after` hook observe the same `ctx.context`).
3. The global `after` hook, for `/email-otp/send-verification-otp` and
   `/phone-number/send-otp`, re-throws the stashed `APIError`. A thrown
   `APIError` from an `after` hook becomes `context.returned`; the dispatch
   `toResponse` uses its `statusCode` (the handler sets no explicit status), so
   the endpoint answers `503`.

### 4. Shared OTP templates: `code` added, `actionUrl` kept

`auth.otp.email.requested` copy now declares both `code` and `actionUrl`;
`auth.otp.mobile.requested` declares `code`. The `code` is a template variable
rendered at send time, never stored (ADR-0096 assumption 2). `actionUrl` is kept
because the existing OP-94 fan-out secret-type pin (`I6`) drives an
`auth.otp.email.requested` event with an `actionUrl` payload and asserts the
rendered email contains it — one template must serve both the synchronous and
the async path.

To reconcile the two payload projections with the renderer's strict
"declared variable must have a value" rule (OP-93 U19), the fan-out's
`renderVarsFor` supplies an **empty string** for a declared variable the event
payload does not carry. The renderer itself stays strict; the fan-out, which
owns the payload projection, chooses the empty default. This is a deliberate
behaviour change at the fan-out boundary (no test relied on the previous
throw), documented so a later story can revisit it if copy should hard-fail.

### 5. Transport resolution: memory from config; other providers are injected

`getMessageTransport()` maps `MESSAGE_TRANSPORT=memory` to
`memoryMessageTransport()`. The Novu adapter is import-restricted to its own
module (`eslint.config.mjs`) and its credentials are not part of the validated
`AppConfig`, so the factory raises a loud error for any other provider instead
of silently dropping every OTP; a real deploy injects its transport through
`createAuth({ transport })` until that wiring lands. `createAuth` accepts the
injected transport and defaults to the factory, matching ADR-0096.

### 6. Catalogue resolution falls back to the checked-in seed

`sendTransactionalNow` reads the type and templates from `notificationTypes` /
`notificationTemplates` and falls back to `SEED_NOTIFICATION_TYPES` /
`SEED_NOTIFICATION_TEMPLATES` when the DB has not been seeded. This resolves the
reviewer's E1 prerequisite without touching test infrastructure: the e2e server
boots an empty MongoDB, and the existing OP-85 auth integration suites send OTPs
against an empty catalogue. The seed is the canonical catalogue, so resolving
from it is a safe fallback for the auth-critical synchronous path.

### 7. `OtpSender.send` may be asynchronous

The port widens to `void | Promise<void>`; `createAuth` awaits the plugin send
callbacks and `two-factor.ts` awaits `issueTwoFactorCode`'s send. The code is
recorded to the process inbox only **after** a successful transport receipt, so
a failure never captures a code and never logs one.

## Consequences

- The synchronous OTP path is end-to-end: resolve → render → metadata-only
  ledger → transport, with channel pinning (`sms`, never WhatsApp), no code in
  the feed/log/ledger, and a retryable `503` on transport failure.
- `notificationOtpSender` records a `providerMessageId` into the in-memory OTP
  inbox; the test-only read route exposes it (E1's proof the code traversed the
  injected transport).
- Suppression handling (GREEN card §4) is **not** implemented here: OP-99 owns
  the suppression-list lane and no OP-95 RED pin covers it (reviewer scope note
  #1). Surfaced, not silently skipped.

## Alternatives considered

- **Rethrow from the plugin callback.** Rejected: Better Auth swallows it
  (`runInBackgroundOrAwait`), yielding `200` — the RED pin fails.
- **`advanced.backgroundTasks` to force propagation.** Rejected: it does not
  exist to un-swallow; the catch is unconditional.
- **Give OTP copy `{{code}}` only.** Rejected: breaks the existing OP-94 fan-out
  OTP pin (I6), which has no code in its payload.
- **Embed the code in `actionUrl`.** Rejected: does not follow ADR-0096's "add
  `code` to the templates' `variables[]` and body" and puts the secret in a URL.
- **Build the Novu transport from config here.** Rejected: the eslint import
  boundary forbids referencing the Novu adapter outside its module and the Novu
  credentials are not validated config; injecting the transport at the
  composition root is the honest seam.
- **Seed the e2e launcher.** Rejected in favour of the seed fallback: it fixes
  the empty-catalogue case for every caller (e2e **and** the OP-85 auth suites)
  without editing test infrastructure.
