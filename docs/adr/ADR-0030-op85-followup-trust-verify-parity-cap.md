# ADR-0030 — OP-85 follow-up: trusted-header precedence, anonymous-verify error parity, authenticated-cap fail-closed

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

## Reviewer addendum — round 1 (artifact lens)

Reviewed at commit `09a86e3` and reproduced independently: unit **1163 passed /
58 files**, integration **164 passed + 1 by-design RED (I20)** (`expected
'invalid_code' to be 'INVALID_OTP'`), tsc/eslint/prettier clean, production code
untouched, existing test semantics preserved (the `auth.test.ts` change is a pure
append). Verdict **APPROVED**.

The card's ACCEPTANCE text expected spec 4 to be RED; it is in fact a green
coverage pin because the fail-closed `try/catch` already shipped in `15d31ba`.
The reviewer accepts the deviation rather than a fabricated red state: the
mandated base is post-#132, and a red probe of the cap path would require
reverting shipped behaviour (forbidden) or probing pre-#132 `920e856` (excluded
by the card). The reviewer did not request a production edit. Referenced at PR
#134, which is intentionally a **draft** and must not be merged — the RED specs
travel to `main` inside the GREEN PR from `t_1175689a` (precedent #127/#128).

## Implementer addendum — GREEN (`t_1175689a`)

Turns the single red spec green and closes the two follow-up work items, on top
of `main` post-#132 (re-based onto `origin/main` at the time of merge; this ADR
was renumbered from a transient `ADR-0025` to `ADR-0030` to avoid a collision
with the independently-landed `ADR-0025-auth-guards`).

### 1. Anonymous-verify error parity (spec I20 → green)

The unknown-number guard in `apps/web/src/server/auth/phone-hook.ts` now throws
the **same** envelope Better Auth's own verify step produces for an existing
user's wrong code:

```
400  { code: "INVALID_OTP", message: "Invalid OTP" }
```

Previously it threw `400 { code:"invalid_code", message:"Invalid or unverifiable
code." }`, which was distinguishable from the wrong-code response and thus a
residual account-existence oracle. The two responses are now byte-identical on
status, `code` and `message`; the code comment's claim is true. No other
production path referenced the old `invalid_code` envelope (the unrelated
two-factor code path is untouched).

### 2. Authenticated-verify cap constants exported (`finding #4`)

The `AUTHENTICATED_VERIFY_LIMIT` / `AUTHENTICATED_VERIFY_WINDOW_SECONDS` magic
values moved out of `apps/web/src/server/auth/rate-limit-hook.ts` into a single
exported constant on the rate-limit module:

```
apps/web/src/server/rate-limit/authenticated-verify.ts
  export const AUTHENTICATED_VERIFY_CAP = { limit: 10, windowSeconds: 600 } as const;
```

re-exported from the `@/server/rate-limit` barrel. The frozen
`RATE_LIMIT_CLASSES` table is untouched (`classes.test.ts` stays frozen); the
hook now passes `AUTHENTICATED_VERIFY_CAP` straight to `rateLimiter.limit`. The
value is unchanged, so observable behaviour is unchanged, and the budget is now
unit-testable on its own.

### 3. Cap fail-closed path (spec set → green)

The `429 too_many_requests` envelope on a limiter fault / spent cap is unchanged
and remains covered by `rate-limit-hook.test.ts`.

**Verification:** integration I20 green (parity), unit `rate-limit-hook.test.ts`

- `client-ip.test.ts` green, full suite green.

## Follow-up addendum — anonymous `send-otp` enumeration nuance (`t_893c8e7c`)

The GREEN above aligned the **anonymous verify** leg (I20). Reviewing it surfaced
the residual surface on the _other_ phone leg — anonymous
`POST /phone-number/send-otp` — whose docblock (`phone-hook.ts`) and ADR-0021 §1
claimed the endpoint "can never be used to enumerate numbers". That claim is
**overbroad**. This addendum states precisely what the three anonymous
`send-otp` inputs do on `main`, pinned by spec **I21** (a green coverage pin, not
a prescribed change — see below).

| Anonymous `send-otp` input                       | Observed on `main`                              | Spec |
| ------------------------------------------------ | ----------------------------------------------- | ---- |
| A number with **no user**                        | `403 { code: "phone_not_verified" }`            | I9   |
| An existing user whose phone is **not verified** | `403 { code: "phone_not_verified" }`            | I10  |
| An existing user whose phone is **verified**     | `200 { message: "code sent" }` + a real SMS OTP | I21  |

- **Indistinguishable:** the first two rows share status, code and message, so a
  caller cannot tell an unknown number from an existing-yet-unverified one.
- **Distinguishable:** the third row is accepted and delivers an OTP. This is a
  genuine "a verified account exists" oracle on an anonymous endpoint — an
  anonymous caller who guesses a number learns whether it belongs to a verified
  OpenPic user. It is bounded only by the `auth.otp` rate limit
  (5/hour/contact, 15/hour/IP; ADR-0005 / §0.11).

I21 drives a real signed-up user with a verified phone, then calls the endpoint
**without a session** and pins the observed `200` plus the fact that the process
OTP inbox gains exactly one `sms` entry for that number — the observable that
distinguishes it from I9/I10's `403`, which deliver nothing. The status was
**observed by running the spec against untouched `main`**, never guessed.

**This is deliberately a green coverage pin, not a fabricated red.** The card's
mandate is to pin the ACTUAL behaviour of `main` and stop; making it red would
require reverting shipped behaviour (forbidden) and inventing a product
decision. Whether to accept the oracle (phone sign-in UX, already bounded by the
`auth.otp` limit) or to make all three responses uniform is a **human product
decision**; I21 records the current behaviour so that decision — and any future
change to it — is visible.

Deliverable: the append-only I21 `it` in
`apps/web/src/test/integration/auth.test.ts`; no production file is touched.
ADR-0020 §5's enumeration sentence is qualified in place to point here.

### Reviewer sign-off (`t_893c8e7c` / PR #146)

Reviewed round 1 (artifact lens) — **APPROVED**. Independently reproduced on the
untouched worktree: focused integration 21/21, full integration 32 files / 194
passed, unit 61 files / 1235 passed, `tsc -p apps/web/tsconfig.json --noEmit` /
ESLint / Prettier clean; all per-PR CI checks green. The pin was confirmed
non-vacuous by mutation: forcing the anonymous `send-otp` guard to reject a
verified number makes I21 fail with `expected 403 to be 200` (mutation reverted).

**Landing decision:** I21 is a _green_ regression pin, and the OP-85 GREEN
(PR #145 / `69847d8`) had already merged, so no future GREEN PR could carry it —
it would have been stranded in a draft PR. Consistent with the OP-87
coverage-pin precedent (card `t_cb2f94bf`, PR #142), and because the change is
tests + docs only with no production impact and fully green CI, the branch was
squash-merged directly to `main` as `f4db1e9` (branch deleted).

Two Low documentation items were routed to follow-up card **`t_b43559b3`**
(`openpic-webapp-backend-coder`, docs/comment only): (1) the `phone-hook.ts`
docblock still asserts the endpoint "can never be used to enumerate numbers";
(2) this addendum attributes that exact phrase to ADR-0021 §1, whereas ADR-0021
§1 says "(no enumeration)" — the quoted phrase is from the source docblock.
