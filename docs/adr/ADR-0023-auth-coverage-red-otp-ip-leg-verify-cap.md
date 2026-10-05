# ADR-0023 — Auth coverage RED: OTP IP leg, unknown-number verify 4xx, callbackURL trust matrix, session-authenticated verify cap

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** `t_27242306` (OP-85 reviewer round-1 follow-up, RED) · **Amends:** nothing. **Extends the pins of:** ADR-0020, ADR-0021
- **Supersedes / amends:** nothing. Records the test-author decisions taken while closing four coverage gaps the OP-85 GREEN suite could not see.

## Context

OP-85 shipped GREEN to `main` as PR #128 (`e05ed3f`). The reviewer's round-1
audit (task `t_c63a267f`) found four behaviours that the GREEN integration suite
(`apps/web/src/test/integration/auth.test.ts`, specs I1–I14) either did not
exercise at all or pinned only through one of several defences:

1. `RATE_LIMIT_CLASSES["auth.otp"]` declares **both** a `contact` leg (5/h, pinned
   by I2) and an `ip` leg (15/h, unpinned).
2. An **anonymous `phone-number/verify` with a valid code for an unknown number**
   returns Better Auth's internal `500` ("Failed to update user"), documented in
   ADR-0021 as "known under-constrained behaviour". I14 pins the observable
   invariants (no session, no user) but accepts the 5xx.
3. `callbackURL` trust is pinned **only** by I11, which proves our `before`-hook
   rejects an untrusted absolute URL — not the effective behaviour a client sees,
   nor that the allowlist (not the hook) is the source of truth.
4. ADR-0021 §1 intentionally does not count a **session-authenticated** verify
   toward `auth.verify`, so a session holder can guess `phone-number/verify` /
   `two-factor/verify-otp` codes with no lockout.

This is a RED card: the only production changes it may cause are the guard the
matching Implementer card adds; it touches test files only.

## Decision

### 1. `auth.otp` IP leg is pinned as a coverage spec (I15)

16 OTP sends from **16 distinct contacts sharing one `x-forwarded-for` IP**: the
first 15 are `200`, the 16th is `429`. Distinct contacts keep the per-contact 5/h
leg (I2) out of the way so only the 15/h/IP leg can trip.

This leg is **already live** on `main` (the hook forwards IP facts and the rule
is in the table), so I15 is **green on delivery** — a coverage pin, not a
regression detector. It exists so a future edit that drops the IP rule, or that
keys the IP from the wrong header, fails loudly. That the IP value is
client-spoofable is the separate Medium finding owned by `t_40c45a13`; I15 pins
the current contract, it does not bless the trust model.

### 2. Anonymous unknown-number verify must be a client error (I16)

The valid-code path is reproduced exactly as I14(b) builds it (a signed-in owner
requests the SMS code for a number with no user; an anonymous caller then
verifies it). I16 pins:

- status is `4xx` (never `4xx`-adjacent 5xx): `>= 400 && < 500`;
- **no** session cookie is minted;
- **zero** `user` documents exist for the number.

I16 fails on `main` with `expected 500 to be less than 500`. The Implementer
card replaces the library's internal 500 with a `4xx` (the code may stay a
generic "invalid or unverifiable code" so the endpoint does not leak whether a
number has an account).

### 3. `callbackURL` trust is pinned through the handler, as the allowlist's effect (I17, I18)

- **I17** — a relative `callbackURL` (`/welcome`) is accepted and mints a session.
- **I18** — an absolute `callbackURL` whose origin **is** in `ALLOWED_ORIGINS` is
  accepted and mints a session.

Together with I11 (an absolute URL outside the allowlist is `403`, no session),
these pin the allowlist as what decides trust, not a particular hook. Both our
`before`-hook and Better Auth's native `trustedOrigins` consume the same
`ALLOWED_ORIGINS` value, and `auth.handler` exposes only their **combined**
outcome. No spec can attribute the decision to one of the two, so the spec does
**not** claim to; it pins exactly what is observable — the allowlist's verdict.
I17/I18 are green on delivery (coverage pins).

### 4. Session-authenticated verify cap exists and is per-session (I19) — value OPEN

I19 signs in, verifies a phone (so a valid session exists), then drives repeated
wrong `phone-number/verify` codes on that session. It pins:

- a `429` appears within the probe bound (the cap is **bounded**);
- every attempt is `< 500` (client errors only);
- once locked out, the lockout is terminal for the rest of the window;
- the budget is **per-user/per-session, not per-contact**: a second,
  never-attempted number under the same session is already `429`. A per-contact
  counter would reset and answer `4xx` instead.

The **cap value is deliberately OPEN** — a product decision for the
orchestrator/human; the spec does not invent it. `AUTHENTICATED_VERIFY_PROBE_BOUND`
(100) is a _probe bound_, i.e. "the cap must be reachable within 100 attempts",
not the cap. If the decided cap exceeds 100 the constant must be raised; the
spec's assertion message names this explicitly.

I19 fails on `main` with "no locked-out response within 100 session-authenticated
attempts — the per-session cap is unbounded". The Implementer card adds a
session/user-keyed counter on the authenticated verify branch.

## Consequences

- Deliverable is `apps/web/src/test/integration/auth.test.ts` only. No production
  file is touched.
- On `main` the suite is **red by design**: 19 specs in the file, **2 fail**
  (I16, I19) for the right reasons and **17 pass**, of which **3 are new
  coverage pins** (I15, I17, I18). Full integration: 162 passed / 2 failed of
  164; unit unchanged at 1155 passed.
- The cap value remains an open decision surfaced in the card handoff, not
  silently chosen.
- I19's per-session scoping is a **product decision**, not a library fact: an
  implementation that keys the cap by contact alone fails I19 by design.

## Alternatives considered

- **Leave the 500 unpinned** (rely on I14). Rejected: a malformed/anonymous
  request must not surface an internal error as its contract; a 5xx also makes
  the endpoint a noisy failure signal.
- **Attribute callbackURL trust to the hook in the spec.** Rejected: the handler
  cannot distinguish the hook's rejection from the library's, so such a spec
  would assert implementation detail and break under a legitimate refactor.
- **Hard-code the authenticated verify cap.** Rejected: the card explicitly
  leaves the number to a product decision; inventing one would silently ship the
  decision.
- **Key the cap by contact.** Rejected: the requirement is per-user/per-session;
  a per-contact budget lets a session holder rotate numbers to guess forever.
