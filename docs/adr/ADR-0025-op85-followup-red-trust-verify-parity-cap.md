# ADR-0025 — OP-85 follow-up RED pins: trusted-header precedence, anonymous-verify error parity, authenticated-cap fail-closed

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** `t_9d6a765c` (OP-85 reviewer round-1 follow-up, RED) · **Extends the pins of:** ADR-0023, ADR-0024
- **Supersedes / amends:** nothing. Records the test-author decisions taken while closing three residual findings from the PR #132 review.
- **Feeds:** `t_1175689a` (GREEN — close the enumeration oracle + export the cap constants), `t_19bf5c17` (production trust-policy decision).

## Context

PR #132 (squash `15d31ba` on `main`) shipped the configurable client-IP trust
model (`TRUSTED_CLIENT_IP_HEADER` + `resolveClientIp`, ADR-0024) and the
per-user authenticated-verify cap (ADR-0023 §4). The review left four findings;
the three test-coverage/behaviour ones are pinned here. On `main` (post-#132):

1. The trusted-header **precedence** and the **configured-but-absent fail-safe**
   of `resolveClientIp` had no direct spec — only the integration IP-leg pin
   (I15) exercised the resolver indirectly.
2. An anonymous `POST /phone-number/verify` of an **unknown number with a valid
   code** answered `400 {"code":"invalid_code","message":"Invalid or
unverifiable code."}`, while an existing verified user's **wrong code**
   answered `400 {"code":"INVALID_OTP","message":"Invalid OTP"}`. Same status,
   different code and message — a residual **account-existence oracle**.
3. The authenticated-verify cap's **fail-closed** path (limiter rejects/throws)
   was implemented in `rate-limit-hook.ts` but had no spec.

This is a RED card: it may only add/adjust test files; it adds no production
code. The matching Implementer card (`t_1175689a`) is what makes the one red
spec green.

## Decision

### 1. `resolveClientIp` precedence and fail-safe are pinned directly (specs U-of `client-ip.test.ts`) — green coverage pins

New specs drive the resolver in `apps/web/src/server/rate-limit/client-ip.ts`
directly, independent of the env wiring:

- with a trusted header configured, the resolver returns **that** header's value
  (trimmed) and ignores `x-forwarded-for` **and** `x-real-ip` even when both are
  present;
- with the trusted header configured but **absent** (or blank), it returns
  `undefined` and does **not** fall back to the forgeable list.

Both are **already green** on `main` — the ADR-0024 behaviour is correct; these
are coverage pins that fail loudly if a future edit reintroduces a fallback or
drops the trim.

### 2. An anonymous unknown-number verify must be indistinguishable from an existing user's wrong code (spec I20) — RED

Spec I20 drives the real handler twice and asserts **status + error code +
message** are equal:

- **(a)** an existing, verified user with a _pending_ OTP who submits a wrong
  code — the library's own verify step rejects it (`400 INVALID_OTP` / `Invalid
OTP`). A fresh OTP is requested first so the case is genuinely "wrong code",
  not the library's "no OTP" branch (`OTP_NOT_FOUND`).
- **(b)** a number with **no user**, presented with a **valid** code obtained
  through the authenticated send-otp flow (as I16/I14(b) do) — today the phone
  hook throws `400 invalid_code` / `Invalid or unverifiable code.`.

On `main` the spec fails with
`expected 'invalid_code' to be 'INVALID_OTP'` (status already matches at `400`).
Pinning **equality**, not a hard-coded envelope, leaves the GREEN card free to
converge on either envelope — it must only remove the difference. The spec also
asserts both are ordinary `4xx` responses (never a `5xx`, never the `429` rate
limit) and that the shared envelope really carries a non-empty `code` and
`message` (non-vacuous guard).

### 3. The authenticated-verify cap fails closed (specs of `rate-limit-hook.test.ts`) — green coverage pins

New unit specs drive `createRateLimitHook` directly with a context whose
`context.session` is set (the first thing `getSessionFromCtx` reads), so no
database or network is involved; only the rate-limit port is injected:

- when `RateLimiter.limit` **rejects**, the hook rejects with the `429
too_many_requests` envelope (`statusCode: 429`, `body.code:
"too_many_requests"`, `body.message: "Too many requests. Try again
later."`) — never resolves (fail-open);
- when the limiter reports the cap **spent** (`success:false`), same `429`;
- **positive control**: when the limiter allows, the hook resolves;
- the cap is keyed on the salted hash of the user id under the `user` scope
  (`rateLimitKey("auth.verify","user",hashIdentity(userId,salt))`), never the raw id.

All four are **already green** on `main` — ADR-0023 §4's fail-closed path is
correct; they are coverage pins. The cap **value** (10 / 600s) is deliberately
**not** asserted here — it is exported and pinned by `t_1175689a`.

## Consequences

- Deliverables: `apps/web/src/server/rate-limit/client-ip.test.ts` (new),
  `apps/web/src/server/auth/rate-limit-hook.test.ts` (new), and one added
  `describe`/`it` (I20) in `apps/web/src/test/integration/auth.test.ts`. No
  production file is touched.
- Suite state on `main` (post-#132): **unit 1163 passed / 58 files** (was 1155 /
  56; +8 new green coverage pins); **integration 1 failed | 164 passed / 27
  files** — the single failure is the by-design RED I20, and every pre-existing
  spec stays green.
- The RED failure names the exact oracle (`invalid_code` vs `INVALID_OTP`), so
  the GREEN card's target is unambiguous.
- ADR-0024's trust model and ADR-0023 §4's cap are now regression-guarded at the
  unit level, not only through the integration IP-leg / lockout pins.
- The residual **production trust-policy** question (finding 1: whether the knob
  is set, and to which header, in each deploy) is out of scope here and stays
  with `t_19bf5c17`.

## Alternatives considered

- **Hard-code the expected envelope** (`INVALID_OTP` / `Invalid OTP`) in I20.
  Rejected: it over-specifies the library's wording and would break on a
  legitimate Better Auth bump while the security property (indistinguishability)
  still held. Equality is the contract.
- **Compare only the status** (already equal at `400`). Rejected: the oracle
  lives in the `code`/`message`, so a status-only pin would be vacuous.
- **Unit-test `resolveClientIp` through `getTrustedClientIpHeader()` / env.**
  Rejected: env access is confined by lint and the resolver's contract is its
  argument, so passing the trusted header explicitly is the stable seam.
- **Test the fail-closed path through the full integration handler.** Rejected:
  forcing the limiter to reject inside the memoised process singleton is not
  controllable per spec; the hook seam is the smallest surface that isolates the
  fail-closed decision.
- **Assert the cap value in the fail-closed specs.** Rejected: the value is a
  product decision owned by `t_1175689a`; inventing it here would silently ship
  it.
