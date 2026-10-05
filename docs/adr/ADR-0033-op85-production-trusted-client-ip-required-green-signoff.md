# ADR-0033 — OP-85 GREEN review sign-off: `TRUSTED_CLIENT_IP_HEADER` required in production

- **Status:** Accepted · **Date:** 2026-10-05 · **Reviewer:** `openpic-webapp-reviewer`
- **Card:** `t_5c873993` (OP-85 follow-up GREEN) · **PR:** [#147](https://github.com/yahodu/openpic-webapp/pull/147)
- **Amends:** ADR-0024 (client-IP trust model) · **RED pins:** ADR-0032 · **Decision:** `t_19bf5c17` (option a)

## Context

ADR-0024 made the unforgeable edge header (`TRUSTED_CLIENT_IP_HEADER`) opt-in.
PR #132 review finding #1 observed that a production deploy which forgets the
knob silently degrades the auth IP rate-limit leg to the client-writable
`x-forwarded-for` fallback. The decision card `t_19bf5c17` chose **option (a)**:
the knob is required in production. The GREEN card `t_5c873993` implements that
check, guards it at Node boot, and amends ADR-0024 / `.env.example` /
`docs/adr/README.md`.

This ADR records the independent review verdict, per the ADR sign-off pattern
used for OP-88 (ADR-0031).

## Decision

**APPROVED WITH FINDINGS — the GREEN change ships.** Reproduced independently
(round-1 artifact lens) on the PR head:

- Focused `env.test.ts` + `env-example.test.ts`: 2 files, 76 passed.
- Full unit: 62 files, 1270 passed.
- Full integration (`TMPDIR=/root/tmp-mongo`): 33 files, 201 passed.
- `tsc` (root + contracts + web): clean. `eslint .`: 0 errors (20 pre-existing
  warnings). `prettier --check .`: clean.
- CI + CodeQL on the PR: all required checks green.

Acceptance criteria verified against the code (`apps/web/src/server/config/env.ts:272-281`):
production + unset/blank knob → `ConfigError` naming `TRUSTED_CLIENT_IP_HEADER`
only; production + non-blank value → parses; non-production unaffected. The
production-guarded `getConfig()` call in `apps/web/src/instrumentation.ts`
makes the refusal real at server boot without disturbing dev/test/e2e.

Two non-blocking findings were filed as follow-up cards:

- the RED-authored describe label/comment in `env.test.ts` and
  `test/factories/env.ts` still cites `(ADR-0031)` after the file renumbered to
  ADR-0032 (cosmetic, no behavioural impact);
- the instrumentation boot guard has no direct spec (it is outside the vitest
  coverage include; behaviour is exercised by the CI production-e2e job).

Refactor scope was reviewed and intentionally left empty: the diff is minimal,
single-purpose, and already matches the codebase's `addIssue`/`superRefine`
pattern; any change would have been scope drift rather than quality gain.

## Consequences

- The silent-degrade path for the production auth IP leg is closed; a
  misconfigured production process fails fast at boot.
- **Operational obligation (deploy-order prerequisite):** `TRUSTED_CLIENT_IP_HEADER`
  must be set in the production environment **before** this change is deployed.
  Use `x-real-ip` on Vercel (the platform overwrites `x-forwarded-for` /
  `x-real-ip`) or `cf-connecting-ip` behind a Cloudflare Worker.
- Staging remains optional, per the scoped decision; extending the requirement
  to staging would need a new decision.

## Alternatives

- **Request changes** — rejected: no acceptance criterion failed and no
  behavioural defect was found; the open items are cosmetic/test-coverage
  follow-ups suited to the Test Author, not rework of the implementation.
- **Block** — rejected: no external prerequisite or human decision is missing.
