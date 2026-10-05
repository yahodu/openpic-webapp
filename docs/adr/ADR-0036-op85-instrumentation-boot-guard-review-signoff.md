# ADR-0036 — OP-85 follow-up review sign-off: instrumentation production boot guard pinned

- **Status:** Accepted · **Date:** 2026-10-05 · **Reviewer:** `openpic-webapp-reviewer`
- **Card:** `t_84050085` (OP-85 follow-up RED, coverage pin) · **PR:** [#151](https://github.com/yahodu/openpic-webapp/pull/151)
- **Parent:** `t_5c873993` (OP-85 GREEN review, ADR-0033) · **Pins:** ADR-0035
- **Depends on:** ADR-0024 (client-IP trust model, amended) · ADR-0032 (production requires `TRUSTED_CLIENT_IP_HEADER`)

## Context

PR #147 added the production boot guard in `apps/web/src/instrumentation.ts`:
inside `register()`, when `NEXT_RUNTIME === "nodejs"` **and** `APP_ENV === "production"`,
the hook calls `getConfig()`, so a misconfigured production process refuses to
start. The PR #147 review (ADR-0033) flagged that this mechanism had no direct
spec — `instrumentation.ts` sits outside the Vitest coverage include and was only
exercised by the slower CI production-e2e job — and filed the follow-up card
`t_84050085` (finding #2, Low).

This ADR records the independent review verdict for the coverage pin, per the
ADR sign-off pattern used for OP-88 (ADR-0031) and OP-85 GREEN (ADR-0033).

## Decision

**APPROVED (LGTM) — the coverage pin ships.** PR #151 squash-merged to `main` as
`859b717`. Independently reproduced (round-1 artifact lens):

- Focused `apps/web/src/instrumentation.test.ts` (8 specs, B1–B5): 1 file /
  8 passed.
- **Independent RED proof:** the same spec run verbatim against the pre-guard
  revision `6c75286` in a throwaway worktree → 2 failed / 6 passed, failing for
  the right reason (`promise resolved "undefined" instead of rejecting` on
  B1/B2). This confirms the spec detects removal or bypass of the boot guard and
  is not green for the wrong reason.
- Full unit (post-reconciliation with `origin/main` `04e99e9`): 63 files /
  1278 passed.
- Integration spot-check (`notification-seed.test.ts`, `TMPDIR=/root/tmp-mongo`):
  4/4 passed.
- `tsc` (root + contracts + web): clean. `eslint`: 0 errors. `prettier --check`:
  clean. CI + CodeQL on #151: all required checks green.

No production code was changed by this card; the spec is additive and hermetic.
The only accommodation is a test-side `vi.mock` of the two Node-only side effects
that run **after** the guard (Mongo shutdown hook, e2e MSW server) — they are
process-signal / interceptor side effects of an entry-point module that cannot be
dependency-injected, and the spec asserts only the observable boot contract, never
internal collaborators.

The branch was reconciled with `origin/main` after PR #150 (ADR-0034) landed; the
sole conflict was the ADR README table, resolved by keeping rows 0034 then 0035.

## Findings

- **Low · informational, no action required — ADR-0035 numbering note.** ADR-0035
  carries a forward-looking note that ADR-0034 was "not landed on main yet" and
  to renumber "if that card merges first." PR #150 has since landed, and 0035 _is_
  the next free number after 0034, so the note's conditional is already satisfied
  and no renumber is required — the note reads as historical prose only.
- **Low · flake, tracked separately — `notification-seed.test.ts` I1.** The first
  `test_coverage` CI run on #151 reddened on this unrelated integration spec (5 s
  timeout under CI load); it passed on rerun and 4/4 locally. Already tracked as
  the parent review's finding #3 (card `t_f4aacfdb`); not caused by this PR,
  which touches no integration code.

No Critical/High findings; no changes were requested.

## Consequences

- The "production refuses to start on invalid config" mechanism now has a fast,
  direct unit spec in addition to the CI production-e2e job.
- `instrumentation.ts` remains outside the coverage `include` list; the pin is
  intentionally additive, not a coverage-threshold change.
- If a future refactor extracts the guarded boot-check into an exported helper,
  the two `vi.mock` stubs can be dropped.

## Alternatives

- **Request changes** — rejected: no acceptance criterion failed; the only
  findings at review are informational (a stale ADR note whose instruction is
  already satisfied) and an unrelated tracked flake.
- **Block** — rejected: no external prerequisite or human decision is missing.
