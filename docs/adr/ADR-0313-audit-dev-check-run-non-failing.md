# ADR-0313 — make the non-blocking `audit-dev` job's check-run conclude `success` (`|| true`), not `failure`

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-117 follow-up (DEPS/CI) (`t_f8e45c00`) · **Branch:** `OP-117-task-ci-audit-dev-check-run` · **Worktree:** `/root/openpic/openpic-webapp`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0313`
- **Relates to:** [ADR-0301](ADR-0301-ci-audit-dev-vs-prod-scope.md) (the split this record completes — its intent is preserved, its implementation is corrected), [ADR-0142](ADR-0142-op101-ci-audit-job-split.md) (gave `Dependency audit` its own job), [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (what counts as CI evidence for a head)
- **Schema:** n/a · **Contract:** n/a (CI workflow + policy only; no application code)

## Context

ADR-0301 split the dependency-audit gate into a blocking `audit` job
(`pnpm audit --prod --audit-level=moderate`) and a **non-blocking** `audit-dev`
job (`pnpm audit --dev --audit-level=moderate`) whose whole purpose is: report
dev/test-toolchain advisories in the job log, and **never** gate a merge.

The `audit-dev` job carried `continue-on-error: true` at the **job** level only.
That suppresses the failure at the **workflow-run** level — the `CI` run reads
green — but GitHub still publishes the job's **check-run** with
`conclusion: failure`. Observed on 2026-11-03:

- `origin/main` head `f3b70d9` (PR #388) carried seven check-runs: `success` ×6
  (`ci`, `audit`, `secret-scan`, `Analyze (actions)`,
  `Analyze (javascript-typescript)`, `Semantic Release`) and `failure` ×1
  (`audit-dev`).
- The same red `audit-dev` check-run was on `origin/main` itself and on merged
  PRs #385/#386/#387 — repo-wide, caused by no single card. The advisories were
  all `undici` `GHSA-xjj6-f33q-929c` (DoS via excessive content-encodings)
  reachable only through the `semantic-release` → `@semantic-release/github`
  dev toolchain; the blocking `audit` (`--prod`) job was `success`.

A check-run consumer — the board's kernel-side PR-acceptance gate reads the head
commit's check-runs — saw a non-success check on **every** commit and refused
`kanban_complete` for unrelated, fully-landed cards. The ADR-0301 intent
("reported, never gating") was violated at the check-run level even though the
workflow run was green.

## Decision

Keep the `audit-dev` job non-blocking and **keep its advisory report in the job
log**, and make the job's check-run conclude `success` by making the audit step
itself exit `0`:

```yaml
- name: Dependency audit (dev toolchain, non-blocking)
  run: pnpm audit --dev --audit-level=moderate || true
```

`pnpm audit` prints the advisory report on stdout **before** it exits non-zero,
so `|| true` swallows only the exit code: the findings remain in the job log
(the ADR-0301 visibility guarantee is intact) and the step — therefore the job
and its check-run — concludes `success`. The job keeps its name, its
independent report (`no needs:`), and its job-level
`continue-on-error: true` as a belt-and-braces guard for the preamble steps.

The blocking `audit` (`--prod`) job is **not touched**: it is intentionally
gating and was already `success`. No dependency was changed (`pnpm` `overrides`
/ lockfile bump was deliberately **not** taken, so the advisory report stays
visible rather than being silenced).

## Consequences

- No `conclusion: failure` `audit-dev` check-run on any commit; the check-run
  rollup of a healthy head is all-`success` for the `.github/workflows/ci.yml`
  jobs. The board's PR-acceptance gate and any branch-protection consumer see
  the honest state.
- Dev/test-toolchain advisories stay **reported** in the `audit-dev` job log —
  the non-blocking report is not downgraded to a silent no-op.
- The production supply chain stays strictly blocking (`audit --prod`, unchanged
  job name and strength).
- The `audit.ignore` policy of ADR-0301 is unchanged: suppressing an advisory is
  still a separate, ADR-justified decision.
- Governance unchanged: if `main`'s ruleset gains required checks, `audit` may
  be required; `audit-dev` must **not** be, or the non-blocking property is
  silently reversed (ADR-0301).

## Alternatives considered

- **Leave job-level `continue-on-error: true` and change nothing.** Rejected:
  it is the observed defect — the workflow run is green but the check-run is red,
  which is exactly what the acceptance gate reads.
- **Add `continue-on-error: true` to the step only (no `|| true`).** Acceptable
  and equivalent in outcome (the step's conclusion becomes `success`); `|| true`
  was chosen because it is deterministic at the shell level (exit `0`
  regardless of the `pnpm` exit code) and needs no step-level semantics.
- **Pin `undici@>=7.30.1` via `pnpm` `overrides` / lockfile bump.** Not taken:
  optional per the card, and it would **remove** the advisory report that
  ADR-0301 deliberately keeps visible. Whoever takes it does so as a separate
  dependency change, not as part of this check-run correction.
- **Remove the `audit-dev` job entirely.** Rejected: it would drop dev/test
  supply-chain coverage, the exact silent-gate-downgrade ADR-0301 §Alternatives
  rejected.

## Numbering

Allocated as **`0313`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md).
The `Next free` cell read `0313` on a fresh `origin/main` (`f3b70d9`)
immediately before committing; this record consumes `0313` and advances the cell
to `0314`. No number outside `0300`–`0319` is touched.
