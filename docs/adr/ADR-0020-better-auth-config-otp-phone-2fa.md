# ADR-0016 — Better Auth configuration: OTP + phone + 2FA, cookie policy, and the test-only OTP route

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-85 `t_4c812e1b` (phase 1-Identity, epic Authentication, RED) · **Depends on:** OP-79 (rate-limit port, ADR-0005), OP-84 (notification routing matrix) · **Contract:** API contract §1.1, §0.2, §0.11; notification §4.1; schema §13.1–§13.2
- **Supersedes / amends:** nothing. First record of the auth wiring decision.

## Context

OP-85 introduces the identity foundation: Better Auth with the `emailOTP`,
`phoneNumber`, `twoFactor` and `admin` plugins, exposed — per contract §1.1 — at
the library-owned `/api/auth/**` surface. The rest of the API assumes this wiring
exists (the `user` label resolves a Better Auth session cookie; `user:complete`
requires both contacts verified; admins require 2FA), but none of it has been
written yet.

Three things cannot be left to the implementation's discretion because other
stories, the e2e harness and the security posture depend on them:

1. **Cookie policy by environment.** §0.2 requires `HttpOnly; Secure;
SameSite=Lax` session cookies. `Secure` is only correct under TLS; a
   hard-coded value breaks either local sign-in or production security.
2. **Where OTP codes go in tests.** The e2e suite runs in a separate process
   from the Next server, so it cannot read an in-process capture buffer. A
   read-back route is needed — and anything that can read an OTP is a
   sign-in-as-anyone primitive, so its reachable environments must be pinned.
3. **Phone/2FA policy.** Contract §1.1 and notification §4.1 impose rules that
   are _not_ Better Auth defaults: SMS OTP must never be re-routed to WhatsApp,
   `auth.otp`/`auth.verify` are rate-limited, and 2FA is gated on a verified
   phone.

## Decision

### 1. Module contract (`apps/web/src/server/auth/**`)

| Module               | Export                                               | Purpose                                         |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `auth/index.ts`      | `createAuth({ db }): AuthLike`; singleton `auth`     | The configured Better Auth instance             |
| `auth/cookies.ts`    | `buildCookieOptions(env: AppEnv): AuthCookieOptions` | §0.2 cookie policy, derived from the deploy env |
| `auth/test-route.ts` | `isTestOtpRouteEnabled(env: AppEnv): boolean`        | Guard for the test-only read-back route         |
| `auth/otp-inbox.ts`  | `otpInbox.record/list/take/clear`                    | Process-level capture of every delivered OTP    |

`AuthLike` is the structural `{ handler(request): Promise<Response> }` view the
specs use; the specs never import `better-auth` types, so the RED suite fails
for the right reason (missing module) before the dependency is added.

### 2. Cookie policy is a pure function of `AppEnv`

`buildCookieOptions` returns `useSecureCookies: true` and `cookiePrefix:
"__Secure-"` for `staging`/`production`, and `false`/`""` for
`development`/`test`/`e2e`. `httpOnly: true`, `sameSite: "lax"` and `path: "/"`
are invariant. `createAuth` feeds these into Better Auth's
`advanced.useSecureCookies` / `advanced.cookiePrefix`. Rationale: the same code
must produce a browser-usable cookie on plain-HTTP local/e2e and a
non-sniffable, origin-bound cookie in production (the `__Secure-` prefix is the
browser's guarantee that only a TLS origin may set it).

### 3. The test-only OTP route is allow-listed to `test` and `e2e` only

`GET /api/v1/__test__/otp?contact=&channel=` answers `200 { code }` when
`isTestOtpRouteEnabled(APP_ENV)` is true and `404` otherwise. The allow-list is
exactly `test`, `e2e`; `development` is deliberately excluded too, because a
developer's local server is often reachable from a shared network or CI tunnel.
The route reads the same `otpInbox` the auth config writes to.

The e2e suite proves the guard with a **positive control**: E2 asserts the route
answers `200` on the e2e server _and_ `404` on the production server. Without the
positive control a merely-absent route would also "pass" the 404 assertion —
a green-on-arrival false negative. This mirrors the "guard, not a RED" reasoning
in ADR-0015 §3, except here the control assertion makes the spec genuinely RED
today (404 vs the expected 200 on the e2e server).

### 4. OTP delivery records to the memory transport; channel is pinned

`createAuth` supplies Better Auth's `sendVerificationOTP` (email) and the phone
plugin's `sendOTP` callbacks so each generated code is recorded in `otpInbox`
with its channel before dispatch. The channel vocabulary encodes the §4.1 pin:
email OTPs use `email`; phone and two-factor one-time codes use `sms` — never
`email` and never the `mobile` group (WhatsApp must never carry an auth secret).

### 5. Phone OTP is sign-in for existing, verified users — not a sign-up

- Unauthenticated `phone-number/send-otp` for an unknown number is rejected
  (`403`) and creates no user (I9).
- Unauthenticated `phone-number/send-otp` for an existing user whose phone is
  not verified is rejected with the _same_ `403` (I10) so the endpoint cannot be
  used to enumerate numbers.
- The authenticated verification flow (`send-otp` → `verify`) is what turns an
  unverified phone into a verified one (I4).

### 6. 2FA is gated on a verified phone; the second factor goes by SMS

`two-factor/enable` requires a verified phone (`403` otherwise, I6); the flow
completes with the code delivered by SMS (`sendOTP`, channel `sms`, I5/I7). A
sign-in with 2FA enabled answers `{ twoFactorRedirect: true }` **without** a
session cookie; the session is minted only after `two-factor/verify-otp`
succeeds (I7).

### 7. Rate limiting is enforced inside the auth surface

`createAuth` wires the `auth.otp` class (5/hour/contact, 15/hour/IP) around OTP
send and `auth.verify` (10/10 min/contact) around OTP verify and 2FA verify, so
the 6th send in the hour is `429` (I2), the 11th wrong email OTP is `429` (I3),
and the 11th wrong 2FA code is `429` (I8). This fulfils the §0.11 rows and the
`auth.suspicious.blocked` escalation, which is emitted by the notification layer
(OP-84 covers the type; the emit itself is out of scope here).

### 8. `trustedOrigins` comes from `ALLOWED_ORIGINS`

`createAuth` sets Better Auth's `trustedOrigins` from the validated
`ALLOWED_ORIGINS` config, so a sign-in `callbackURL` outside them is rejected
(`403`) and never mints a session (I11), and the existing CSRF middleware keeps
reading the same source of truth.

## Consequences

- Cookie security, phone/2FA policy and the test-route reachability are now
  executable specifications, not conventions.
- The e2e config gains a second Playwright project (`api-production`) and a
  production-flavoured launcher (`start-production-server.mjs`) so the guard is
  proven against a real production configuration, not a mocked `APP_ENV`.
- `createAuth({ db })` is injectable, so every integration spec runs against its
  own throwaway database and a fresh auth instance — no shared state between
  specs.

## Assumptions resolved unilaterally (flagged for the implementer)

- **Better Auth route names/bodies** follow the library's documented
  `emailOTP`/`phoneNumber`/`twoFactor` surfaces. If a plugin version exposes a
  different path or payload, the implementer satisfies the _observable_ contract
  (status, `twoFactorRedirect`, cookie, DB state, inbox channel) with whatever
  the installed version provides.
- **`two-factor/enable` → `two-factor/verify-otp`** is pinned as the completion
  pair. If Better Auth only supports TOTP confirmation for enable, the
  implementer adds the OTP-confirm step as a thin app wrapper so the end state
  (`twoFactorEnabled: true` after the SMS code) still holds.
- **Rejection status codes**: `403` for the phone-eligibility and 2FA-without-
  verified-phone policies, `403` for an untrusted `callbackURL`, `429` for both
  lockouts. Chosen over `400` to match the "authenticated but not permitted"
  §0.3 semantics.
- **`development` is treated as untrusted** for the test-only route even though
  the route is convenient there; a developer can run with `APP_ENV=test`.

## Out of scope (deliberately not tested here)

- The mandatory Better Auth **hooks** (userProfiles insert, lazy-invite,
  new-device/admin sign-in and 2FA-toggled notifications) — they are the subject
  of the identity-hooks story; only their downstream notification types exist
  today (OP-84).
- The `admin` plugin's ban/unban/impersonation endpoints and their audit trail.
- `/api/v1/me`, sessions/revocation, account deletion and attendee sessions
  (Parts 1.2–1.5) — separate cards.
- Bearer-token auth for mobile.

## Alternatives considered

- **Read the OTP code from a log line in e2e.** Rejected: OTPs are on the
  never-return list (contract §0.13, notification rule 6); parsable OTPs in logs
  are a leak.
- **Return the OTP in the send response when `APP_ENV !== production`.** Rejected:
  it makes the public auth endpoint's response shape environment-dependent and
  couples the client to it; an allow-listed side channel is narrower.
- **Gate the read-back route on `APP_ENV !== production` only.** Rejected: it
  exposes OTPs on every staging and local dev server; an allow-list of `test`/
  `e2e` is the smaller surface.
- **Mock `APP_ENV` for E2 instead of a production server.** Rejected: the point
  is to prove the guard under a real production configuration (strict secrets,
  non-memory providers); a mocked env would not exercise config validation.
- **Test Better Auth internals (`auth.api.*`) directly.** Rejected: it couples
  specs to a library's private shape; `auth.handler` is the documented boundary
  and breaks no spec under a config refactor.
