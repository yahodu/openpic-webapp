# ADR-0097 — OP-95 RED review sign-off: synchronous OTP delivery pins verified

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-95 RED (`t_3bd2a7b4`), reviewer `openpic-webapp-reviewer` (round 1, artifact + execution lens)
- **Reviews:** `docs/adr/ADR-0096-op95-otp-delivery-through-notification-service-red.md`
- **PR:** [#191](https://github.com/yahodu/openpic-webapp/pull/191) (draft, RED-CI by design) · **Branch:** `OP-95-task-otp-delivery-through-notification-service-red` @ `d157d1a`
- **Verdict:** APPROVED (RED) — no changes requested; no production file touched.

## Context

OP-95 RED delivers the failing pins for OTP delivery through the synchronous
`NotificationService` entry point (`sendTransactionalNow`), plus ADR-0096 which
fixes the module contract. The review had to confirm the pins are genuine,
test-only, and satisfiable before the GREEN card (`t_0e8a6a84`) can begin — and
that no pin is a fixture-shaped tautology.

## Decision

Approved as-is. Independently reproduced on `d157d1a`:

| Check                                                        | Result                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `vitest run --project unit fan-out-transactional`            | 6/6 fail: `resolveOtpTarget` / `buildDispatchRecord` are not functions (exports genuinely absent)                  |
| `vitest run --project integration notification-otp-delivery` | 3/3 fail: I1/I2 `expected [] to have a length of 1`; I3 `expected 200 to be 503`                                   |
| `tsc -p apps/web/tsconfig.json --noEmit`                     | exactly 5 errors (4 missing `fan-out` exports + `transport` absent from `CreateAuthOptions`) — no incidental noise |
| `eslint` / `prettier` on the three test files                | clean                                                                                                              |
| `git diff a095da1..d157d1a`                                  | tests + ADR + README row only; **no production file**                                                              |

Pinned inputs were verified to be real, not stubs: `ResolveProfile` /
`ResolveContacts` are exported by `resolve-channel`; seeded `auth.otp.*` types
carry `retainBody:false`, the email/mobile channel toggles and
`mobileCandidates:["sms"]`; the `/api/v1/__test__/otp` rewrite and read route
exist; `memoryMessageTransport` mints a `providerMessageId`.

### Findings (non-blocking, routed)

1. **[Medium] E1 depends on a catalogue seed the e2e server lacks.** `apps/web/e2e/start-server.mjs` boots an empty Mongo and never seeds the type/template
   catalogue, so E1 cannot resolve `auth.otp.*` once OTP flows through
   `sendTransactionalNow`. Routed to the GREEN card (seed the launcher or resolve
   from the checked-in seed). `MESSAGE_TRANSPORT` already defaults to `memory`.
2. **[Low] GREEN card §4 (suppressed-contact handling) overlaps OP-99.** No OP-95
   pin covers it and OP-99 (`t_28ab0e00`/`t_3bb9a1a3`) owns first-party
   suppressions. GREEN stays scoped to the RED pins; flagged on the GREEN card.
3. **[Low] I3 pins 503**, so the GREEN must map the transport failure to a 503
   `upstream_unavailable` (a bare `Error` through Better Auth yields 500).
4. **[Low] `DispatchRecord.body` is a new §19.5 field**; the GREEN adds it to the
   synchronous path without disturbing the async fan-out's dispatch persistence
   (ADR-0096 assumption 3).

The RED branch is RED-CI by design and must not be squash-merged alone; the pins
ship in the GREEN PR (same pattern as OP-92/OP-93). No new cards were created —
OP-99 already owns the suppression lane and the E1 prerequisite is a GREEN-card
obligation already recorded in ADR-0096.

## Consequences

- The GREEN card starts from a verified-red baseline whose every failure is the
  intended one, so a later green run cannot be green "for the wrong reason".
- The two open implementation risks (503 mapping, e2e seed) are captured on the
  GREEN card before it runs.
