# ADR-0035 — Instrumentation production boot guard pinned by a direct spec (RED pins)

> _Numbering note: ADR-0034 is claimed by a sibling follow-up card
> (`t_921a05f9`, the ADR-0032 test-reference renumber) that has not landed on
> `main` yet. If that card merges first, renumber this file to the next free
> number on landing. Behaviour is unchanged either way._

- **Status:** Accepted (RED pins, coverage-only) · **Date:** 2026-10-05
- **Card:** `t_84050085` (OP-85 follow-up RED) · **Parent:** `t_5c873993`
  (OP-85 GREEN review, PR [#147](https://github.com/yahodu/openpic-webapp/pull/147))
- **Depends on:** ADR-0024 (client-IP trust model, amended) · ADR-0032 (production
  requires `TRUSTED_CLIENT_IP_HEADER`) · ADR-0033 (GREEN review sign-off)
- **Related:** `apps/web/src/instrumentation.ts`, `apps/web/src/server/config/env.ts`

## Context

PR #147 added the production boot guard in `apps/web/src/instrumentation.ts`:
inside `register()`, when `NEXT_RUNTIME === "nodejs"` **and**
`APP_ENV === "production"`, the hook imports `./server/config/env` and calls
`getConfig()`. Because `getConfig()` throws a `ConfigError` for an invalid
production environment, a misconfigured production process **refuses to start**
rather than silently degrading (the acceptance criterion of ADR-0024, mandated by
ADR-0032).

The file had **no direct spec**: `instrumentation.ts` sits outside the Vitest
coverage `include` list and its only behavioural exercise is the CI
production-e2e job. The PR #147 review (`t_5c873993`, ADR-0033) flagged this as a
self-reported coverage gap and filed this follow-up card.

The question this card had to settle was **reachability**: can a unit spec drive
the real `register()` without editing production code? Yes — the guard is
reachable. `instrumentation.test.ts` imports the exported `register()` with
`NEXT_RUNTIME`/`APP_ENV` set from the existing env fixture factory
(`test/factories/env.ts`). The only accommodation needed is a _test-side_ stub
(`vi.mock`) of the two Node-only side effects that run **after** the guard — the
Mongo shutdown hook and the e2e MSW server — so the spec is hermetic and the
teardown-time SIGTERM hook cannot fire during the run.

**No production code was changed to author this spec.** The card is a coverage
pin: the guarded behaviour already exists on `main`, so the spec is green by
design, and it was verified to be RED against the pre-guard revision (below).

## Decision

Add `apps/web/src/instrumentation.test.ts` pinning the **observable boot
contract** of `register()` — never asserting on internal collaborators:

| Pin | Condition                                                                  | Expected                                                         |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| B1  | `NEXT_RUNTIME=nodejs`, production, invalid config                          | `register()` rejects with `ConfigError` naming the offending key |
| B2  | `NEXT_RUNTIME=nodejs`, production, invalid config                          | message names the key only, never the offending value            |
| B3  | `NEXT_RUNTIME=nodejs`, production, valid config                            | `register()` resolves                                            |
| B4  | `NEXT_RUNTIME=nodejs`, `APP_ENV`∈{development,test,e2e}, incomplete config | `register()` resolves (validation is production-only)            |
| B5  | `NEXT_RUNTIME` not `nodejs` (edge / unknown), production, invalid config   | `register()` resolves (Node branch compiled out)                 |

B1/B2 are the actual boot-guard pins. B3–B5 are green coverage pins that make the
guard's _scope_ explicit: production-only, Node-only.

## Pins (RED evidence)

- **Post-guard (`origin/main` @ `67d53f1`, worktree `t_84050085`):** focused run
  `apps/web/src/instrumentation.test.ts` → 8 passed (B1–B5). Full unit suite →
  63 files / 1278 passed.
- **Pre-guard (`6c75286`, throwaway detached worktree, spec copied verbatim):**
  focused run → 2 failed / 6 passed. Both failures are the refusal pins and fail
  for the right reason — `promise resolved "undefined" instead of rejecting` —
  proving the spec would catch a regression that removes or bypasses the boot
  guard.

## Consequences

- The "production refuses to start" mechanism now has a direct, fast unit spec
  in addition to the slower CI production-e2e job.
- The spec introduces the repository's first `vi.mock` usage, and it is confined
  to neutralising two Node-only side effects of an entry-point module that cannot
  be dependency-injected. If a future refactor extracts the guard into an
  exported helper, the stubs can be dropped.
- `instrumentation.ts` remains outside the coverage `include` list; the pin is
  intentional and additive, not a threshold change.

## Alternatives

- **File a GREEN card for a production seam** (extract the guarded boot-check
  into an exported helper) — rejected: `register()` is already exported and
  reachable from a unit spec with a stubbed side-effect boundary, so no
  production change is warranted.
- **Let the real Mongo shutdown hook / e2e MSW server run** — rejected: it
  registers process signal handlers and an MSW interceptor, producing teardown
  noise (a spurious `db.shutdown` event) and non-hermetic state.
- **Assert `getConfig()` call counts with a spy** — rejected: asserting on
  internal collaborators is brittle and would break under a legitimate refactor;
  the refusal/resolution contract is the observable behaviour.
- **Re-pin `env.ts` production validation** — rejected: already covered by
  `env.test.ts` P1–P5 (ADR-0032).
