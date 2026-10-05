# ADR-0024 — Client-IP trust model for the auth rate-limit IP leg

- **Status:** Accepted · **Date:** 2026-10-05 · **Amended:** 2026-10-05 (`t_19bf5c17`, decision option a — `TRUSTED_CLIENT_IP_HEADER` is now **required in production**; see "Production policy (option a)" below)
- **Card:** `t_40c45a13` (OP-85 reviewer round-1 follow-up, GREEN) · **Implements:** the IP-leg finding from `t_c63a267f` · **Depends on:** ADR-0005 (two-tier rate limiting), OP-79 (rate-limit port)
- **Supersedes / amends:** amended by `t_5c873993` (GREEN) on the decision of `t_19bf5c17`; the production leg is now enforced rather than assumed (ADR-0031). Complements ADR-0021/ADR-0023 by fixing the _source_ of the IP identity those legs key on.

## Context

The `auth.otp` class keys a rule on the client IP
(`{ scope: "ip", limit: 15, windowSeconds: 3600 }`, contract §0.11) and the
`before` hook derived that IP from the **leftmost** `x-forwarded-for` hop
(`clientIp()`), with `x-real-ip` as a fallback. Two consequences:

1. `x-forwarded-for` is a comma-separated, **client-writable** list. Unless the
   fronting layer _overwrites_ it, a client can prepend/rotate entries to evade
   the limit and to poison another caller's bucket (a request from a trusted
   proxy that _appends_ makes the genuine client the last trusted entry, not the
   first).
2. On a direct-to-Node deploy (no edge proxy) the header is absent, so the IP
   leg never fires at all; the per-contact 5/h leg still holds, so this is
   defence-in-depth rather than a full bypass.

The IP leg already had a coverage pin (spec I15) that sends 16 distinct contacts
from one `x-forwarded-for` value and expects the 16th to be `429`. The existing
integration pin `rate-limit-route.test.ts` ("derives the client IP from the first
hop of x-forwarded-for") sends `"203.0.113.13, 10.0.0.1"` and expects the
**first** hop to be used.

## Decision

Derive the IP identity from a header the trusted fronting layer **overwrites**,
chosen by deployment configuration, and keep the historical behaviour as the
documented dev fallback:

- New env knob **`TRUSTED_CLIENT_IP_HEADER`** (`getTrustedClientIpHeader()`),
  naming the platform/edge header that carries the real client IP (e.g.
  `x-real-ip`, `cf-connecting-ip`, `x-vercel-forwarded-for`). When set, the
  header's value is the client IP because the edge overwrites it — the client
  cannot forge it.
- When the header is configured but **absent**, the resolver returns `undefined`
  rather than falling back to the forgeable list: a misconfigured deployment
  loses the IP leg (fail-safe) instead of trusting a client-supplied value.
- When the knob is **unset** in a **non-production** environment
  (`development`/`test`/`e2e`/`staging`), the resolver keeps the previous
  behaviour — leftmost `x-forwarded-for`, then `x-real-ip`. This is a
  **dev/e2e fallback, not a production default**: production config validation
  now refuses to start unless the knob is set (see "Production policy
  (option a)" below).

The resolver lives in `apps/web/src/server/rate-limit/client-ip.ts`
(`resolveClientIp`) and is shared by both IP consumers: the auth
`before`-hook (`rate-limit-hook.ts`) and the `defineRoute` rate-limit stage
(`stage.ts`). Neither reads `process.env` directly (the lint rule confines env
access to `src/server/config`).

### Production policy (option a) — enforced

`TRUSTED_CLIENT_IP_HEADER` is **required in production**. Config validation
(`getConfig()`, `apps/web/src/server/config/env.ts`) refuses to start
(`ConfigError` naming the **key only**, never its value) when
`APP_ENV=production` and the knob is unset or blank (whitespace-only fails; a
padded non-blank value such as `"  x-real-ip  "` is valid). The Node server
validates the configuration from the instrumentation hook at boot, so a
misconfigured production process **fails fast at startup** rather than at the
first request. Non-production environments (`development`/`test`/`e2e`/
`staging`) keep the knob optional and retain the dev/e2e fallback.

This is the strongest option: there is **no silent degrade**. A production
deploy cannot start with the forgeable `x-forwarded-for` fallback in place — the
operator is forced to name the header the trusted edge overwrites, which is the
only value the client cannot forge. The rejected alternatives were:

- **(b) startup-warning-only.** Rejected: a warning in the logs is not a gate,
  so a forgotten knob still silently degrades the IP leg — the exact hole the
  PR #132 review filed.
- **(c) accept the residual risk.** Rejected: it leaves a production
  deployment's abuse protection silently weakened, and the fix is a cheap,
  fail-closed config check.

**Deployment note (deploy-order prerequisite):** set `TRUSTED_CLIENT_IP_HEADER`
in the **production** environment **before** this change is deployed — the
production config check otherwise refuses to start. Name the header the deployed
edge guarantees:

- on **Vercel** the platform sets/overwrites `x-forwarded-for` (and `x-real-ip`);
- if a **Cloudflare Worker** fronts the app, use `cf-connecting-ip`.

## Consequences

- No existing observable behaviour changes with the knob unset in
  non-production: all prior integration/unit specs, including the "first hop"
  pin and I15, stay green.
- The trust boundary is now explicit and configurable instead of hard-coded to
  one proxy layout, as the card requires.
- The **production** leg is now enforced (option a): a production deployment
  refuses to start unless `TRUSTED_CLIENT_IP_HEADER` names the header the trusted
  edge overwrites, so the silent-degrade path is closed. The remaining operational
  obligation is the deploy-order prerequisite above (the value must be present in
  the production environment before this ships).
- `.env.example` documents the new variable, so the PR carries an environment
  change.

## Alternatives considered

- **Trust the rightmost `x-forwarded-for` hop (configured trusted-proxy hop
  count).** Rejected: it is the more general fix, but it cannot be a default —
  the existing "first hop" integration pin sends a two-entry header and expects
  the first entry, so any hop count that ignores the leftmost breaks that spec.
  It would have to be a second opt-in knob with no universally-correct default.
- **Default to a specific platform header (`x-real-ip`).** Rejected: it would
  disable the IP leg in dev (where no such header is set) unless the
  "configured-but-absent → undefined" safety rule were weakened, re-introducing
  the fallback to a spoofable value.
- **Fail closed (drop the IP leg entirely) when no trusted IP can be derived.**
  Rejected: on a direct-to-Node deploy this would bucket every caller into one
  shared identity and deny legitimate traffic; the per-contact leg already
  carries the primary limit, so this is not worth the availability cost.
