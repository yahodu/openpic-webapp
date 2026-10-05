# ADR-0031 — `TRUSTED_CLIENT_IP_HEADER` is required in production (RED pins)

- **Status:** Accepted (RED) · **Date:** 2026-10-05
- **Card:** `t_cdbfa50e` (OP-85 follow-up RED) · **Decision by:** `t_19bf5c17` (orchestrator, option a) · **GREEN:** `t_5c873993` · **Depends on:** ADR-0024 (client-IP trust model), ADR-0005 (two-tier rate limiting)
- **Amends (in GREEN):** ADR-0024 §Decision/§Consequences (production leg made mandatory)

## Context

ADR-0024 introduced `TRUSTED_CLIENT_IP_HEADER`, the name of an edge/proxy header
the trusted fronting layer **overwrites** (e.g. `x-real-ip`,
`cf-connecting-ip`). When set, `resolveClientIp` keys the auth IP leg on a value
the client cannot forge; when **unset**, it keeps the historical dev/e2e
fallback — the leftmost, client-writable `x-forwarded-for`, then `x-real-ip`.

The PR #132 review (finding #1, Medium, security/config) observed that making
the unforgeable source _opt-in_ means a production deploy that forgets the knob
silently degrades to the forgeable fallback — a silent-downgrade hole. The
orchestrator (`t_19bf5c17`) chose **option (a)**: the knob is **required in
production**. Config validation must refuse to start when `APP_ENV=production`
and `TRUSTED_CLIENT_IP_HEADER` is unset or blank, so a production deploy can
never silently degrade. Scope is **production only** — staging stays optional.

This card writes the failing specs only (TDD RED); it contains **no production
code**.

## Decision

`getConfig()` (module `apps/web/src/server/config/env.ts`) must:

1. **Refuse** (`ConfigError`) when `APP_ENV=production` and
   `TRUSTED_CLIENT_IP_HEADER` is unset, `""`, or whitespace-only.
2. **Accept** any non-blank value in production (e.g. `x-real-ip`,
   `cf-connecting-ip`, or a padded `"  x-real-ip  "`).
3. **Keep the knob optional** for `development`, `test`, `e2e` and `staging`.
4. **Name the key only**, never its value, in the `ConfigError` message —
   extending the established "secrets are never echoed" invariant to this key.

`resolveClientIp` behaviour is unchanged: a configured-but-absent trusted header
still returns `undefined` and never falls back to `x-forwarded-for` / `x-real-ip`.
That contract is already pinned by the `t_9d6a765c` specs in
`apps/web/src/server/rate-limit/client-ip.test.ts` (ADR-0030), so this card
**does not duplicate** those cases.

## Pins (RED evidence)

New `describe("getConfig — production requires TRUSTED_CLIENT_IP_HEADER (ADR-0031)")`
in `apps/web/src/server/config/env.test.ts`:

| Pin | Case                                                                  | Expected                                                                                                    |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P1  | production, knob unset                                                | `ConfigError` naming `TRUSTED_CLIENT_IP_HEADER`                                                             |
| P2  | production, knob `""` / `"   "`                                       | throws naming `TRUSTED_CLIENT_IP_HEADER`                                                                    |
| P3  | production, knob `x-real-ip` / `cf-connecting-ip` / `"  x-real-ip  "` | parses (green pin)                                                                                          |
| P4  | `development`/`test`/`e2e`/`staging`, knob unset                      | parses (green pin)                                                                                          |
| P5  | production, knob unset (single failure)                               | message is exactly `Invalid application configuration: TRUSTED_CLIENT_IP_HEADER` — key names only, no value |

P1/P2 (and P5, which asserts the refusal) are **RED** on `origin/main` @
`b232cc6` because `getConfig()` currently **succeeds** with the knob unset in
production (`expected function to throw an error, but it didn't`). P3/P4 are
green coverage pins.

The `.env.example` coverage pin in `env-example.test.ts` also gains
`TRUSTED_CLIENT_IP_HEADER` (already documented at `.env.example:17`), so the
example cannot drift behind the new requirement.

## Fixture extension (semantics-preserving)

`makeProductionEnv` in `apps/web/src/test/factories/env.ts` now defaults
`TRUSTED_CLIENT_IP_HEADER` to `"x-real-ip"`, so every pre-existing
production-env spec stays valid under the new contract. The P1/P2/P5 specs
override it back to `undefined` / blank. No existing assertion was changed or
weakened.

## Consequences

- A production deploy with the knob unset/blank **fails fast at startup**
  instead of silently trusting `x-forwarded-for`.
- **Deploy-order prerequisite:** `TRUSTED_CLIENT_IP_HEADER` must be set in the
  Vercel production environment **before** this change ships, or production
  refuses to start. Edge value: `cf-connecting-ip` if a Cloudflare Worker
  fronts the app, else `x-forwarded-for` / `x-real-ip`.
- The GREEN card `t_5c873993` implements the check and amends ADR-0024/`.env.example`.

## Alternatives considered

- **Option (b) — warn-only at startup.** Rejected by `t_19bf5c17`: it leaves the
  silent-degrade path in place; a warning in logs is not a gate.
- **Option (c) — status quo (opt-in).** Rejected: this is the Medium the
  reviewer filed.
- **Require the knob in staging too.** Rejected for this card: the decision
  scoped the hard requirement to `APP_ENV=production`; extending it to staging
  is not needed to close the production hole and would change staging's
  fail-closed posture without a decision.

## Assumption

`"  x-real-ip  "` (non-blank after trimming) is treated as **valid** in
production — the refusal is for _blank_ values, not for surrounding whitespace.
This matches `getTrustedClientIpHeader()`, which trims and lowercases before
use.
