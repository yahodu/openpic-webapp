# ADR-0021 — Better Auth config GREEN: hook-based policy, the `__test__` rewrite, and the two-factor flow

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-85 `t_c63a267f` (phase 1-Identity, epic Authentication, GREEN) · **Implements:** ADR-0020 · **Depends on:** OP-79 (rate-limit port), OP-84 (notification routing matrix)
- **Supersedes / amends:** nothing. Records the concrete choices made while turning the ADR-0020 specs green.

## Context

ADR-0020 fixed the contract: Better Auth with the `emailOTP`, `phoneNumber`,
`twoFactor` and `admin` plugins, mounted at `/api/auth/**`, with cookie, origin,
rate-limit, phone-eligibility and 2FA policies enforced. This ADR records the
implementation decisions the specs left to the implementer, and two platform
facts discovered while satisfying them.

## Decision

### 1. Every OpenPic policy is a Better Auth hook, not a route wrapper

`createAuth({ db })` returns a structural `AuthLike` (`{ handler }`) over the
library instance. All OpenPic policy lives in a single global `hooks.before`
and `hooks.after` (better-auth 1.7.7 exposes exactly one of each, so the handler
branches on `ctx.path`):

- **rate limits** — `auth.otp` on `send` paths, `auth.verify` on verify paths,
  via the ADR-0005 port; a denial is `429`. Better Auth's own limiter is
  `enabled: false` so the two windows cannot compound and fire early.
- **`auth.verify` counts only unauthenticated verifies.** A request that already
  carries a session (binding a phone, or the authenticated 2FA-enable code) is
  not a sign-in credential check, so it must not spend the caller's sign-in
  budget before the challenge it protects even begins. Without this, the enable
  flow's own one-time code consumed one of the ten `auth.verify` tokens and the
  "10 wrong then 429" specs could not hold on the shared per-spec identity.
- **callbackURL trust** — an absolute `callbackURL` outside `ALLOWED_ORIGINS` is
  `403`. A relative callbackURL is trusted (it resolves against `baseURL`).
- **phone send-otp eligibility** — an anonymous `phone-number/send-otp` is
  allowed only when an existing user with that _verified_ phone exists; unknown
  and unverified numbers get the same `403` (no enumeration).
- **phone verify binding** — an authenticated `phone-number/verify` is rewritten
  to `updatePhoneNumber: true` so Better Auth binds the new number to the
  signed-in user; `signUpOnVerification` stays unset.

The two-factor `enable`, `disable` and pending-sign-in shapes are likewise hooks
(§4), because the stock endpoints do not match the contract (stock `enable`
requires a password/TOTP; stock `disable` accepts a password, not a code).

### 2. The test-only route needs a rewrite (Next.js private folders)

Next.js treats a `_`-prefixed route segment as a **private folder** and excludes
it from routing, so a route file at `app/api/v1/__test__/otp/route.ts` is never
served (verified: it did not appear in the build's route table). The handler
therefore lives at `app/api/v1/test-support/otp/route.ts` and `next.config.ts`
rewrites the contract path `/api/v1/__test__/otp` onto it. The env guard stays
in the handler (`isTestOtpRouteEnabled`), so production still answers `404`.

### 3. Session lifetime is an env tuneable outside the frozen config shape

`SESSION_TTL_SECONDS` is read by `getSessionTtlSeconds()` in
`src/server/config/env.ts` (not `AppConfig`, which is asserted by its own
specs) and fed to `session.expiresIn`; it defaults to 7 days. Reading
`process.env` directly in the auth module is also barred by the lint rule that
confines env access to `src/server/config`.

### 4. The two-factor flow is SMS-only and gated on a verified phone

- **enable** — `hooks.before` checks `phoneNumberVerified` (`403
phone_not_verified` otherwise), sets `twoFactorEnabled: true`, stores a
  one-time code under `2fa-otp-<userId>!<sessionId>` and sends it by SMS. Stock
  `two-factor/enable` is not used because it would rotate the caller's session
  and its schema defaults to TOTP.
- **completing enable** — the spec then calls the stock `two-factor/verify-otp`;
  since `twoFactorEnabled` is already true, the stock authenticated branch takes
  its `valid` path and returns `200` without rotating the session (so the
  caller's cookie remains valid for the later disable flow).
- **sign-in with 2FA** — email-OTP sign-in does not go through the stock 2FA
  redirect (its after-hook matcher omits `/sign-in/email-otp`), so a global
  `hooks.after` converts the minted session into a pending challenge: the
  session cookie is dropped, the session deleted, a signed `two_factor` cookie
  plus its verification records are created, and an SMS code is sent. The
  response is `{ twoFactorRedirect: true }` with no session cookie.
- **disable** — `hooks.before` requires a fresh `code`, validated against the
  stored `2fa-otp-<userId>!<sessionId>` (consumed on read); a missing or wrong
  code is `400` and leaves 2FA on. On success `twoFactorEnabled` is cleared and
  the `twoFactor` row deleted.

`totpOptions: { disable: true }` keeps the second factor SMS-only.

### 5. OTP delivery is a port; logging is redacted at the port

Every channel (email OTP, phone OTP, 2FA OTP) records its code through
`memoryOtpSender()` into the process `otpInbox` and emits one `auth.otp.sent`
info line carrying the `channel` and a **salted hash** of the contact (reusing
the rate-limit identity hash). The code itself is never logged and never
returned.

## Consequences

- The whole OP-85 RED suite (unit `cookies`/`test-route`, integration
  `auth.test.ts`, e2e `auth.spec.ts`/`auth-production.spec.ts`) is green against
  the library's documented HTTP boundary; no spec imports `better-auth` types.
- Mutation check: enabling `signUpOnVerification` turns I14 red on both
  assertions, so the flag is genuinely pinned (verified, then reverted).
- Known under-constrained behaviour: an anonymous `phone-number/verify` with a
  _valid_ code for a number with no user returns Better Auth's internal
  `500`, because the plugin's "no user" branch throws before `signUpOnVerification`
  is consulted. The observable contract (no session, no user) holds and I14
  pins it, but a cleaner `403` is worth a follow-up spec.

## Alternatives considered

- **Outer handler wrapper instead of hooks.** Rejected: it would have to
  re-implement Better Auth's signed-cookie and session handling by hand, which
  ADR-0020 explicitly rules out ("no hand-rolled auth").
- **Rely on Better Auth's built-in rate limiter.** Rejected: it cannot key by
  contact and its `/two-factor/*` window (3/10s) fires before the contract's
  10th attempt.
- **Keep the route under `__test__` and mount it via middleware.** Rejected in
  favour of a `next.config` rewrite: one declarative mapping, no per-request
  edge work, and the guard stays in the Node handler where the inbox lives.
