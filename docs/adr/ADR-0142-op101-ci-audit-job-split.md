# ADR-0142 — OP-101: split `Dependency audit` into its own blocking `audit` job so a red audit stops masking the project gate

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 CI lane-shape follow-up (`t_a3d52d6e`, backend lane; raised by the review of `t_aed7d907`, PR [#211](https://github.com/yahodu/openpic-webapp/pull/211))
- **Relates to:** [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) (the remediation this card follows up), [ADR-0119](ADR-0119-op101-ci-dependency-audit-review-signoff.md) (the review that routed this finding forward as M1), [ADR-0069](ADR-0069-op91-green-review-signoff.md) (the CI pipeline this job belongs to)
- **Schema:** n/a · **Contract:** n/a (CI workflow shape only; no application code)

## Context

`.github/workflows/ci.yml` ran the whole gate as one job, `ci`, with
`Dependency audit` (`pnpm audit --audit-level=moderate`) as its **last step**.
That made the audit and the project gate share a single check name, so neither
could fail independently of the other. Observed on 2026-10-20:

- `main`@`f0b428e` push run `39411613388`: `Install (frozen lockfile)`,
  `Typecheck`, `Lint`, `Unit tests`, `Integration tests`, `Coverage thresholds`,
  `Build` and `E2E tests` all passed, then `Dependency audit` failed. The lane
  read as failure on `main` and on every open PR.
- Because the audit was the terminal step of the only status-check-shaped job,
  a genuine unit/integration/typecheck regression was **indistinguishable from
  the expected audit failure at the "PR CI" check level** — the masking the
  OP-101 card (ADR-0118) was raised about. ADR-0118 cleared the advisories of
  the day but not the mechanism: the next advisory published against any
  dependency re-reddens the single `ci` check with every project step green.

The audit gate itself is correct and stays in place (ADR-0118 evidence: PR #211
run `39412767879`, job `118594342055`, `Dependency audit` ✓, `pnpm audit` exit 0
with the pre-existing `GHSA-vfj7-8cjw-p6xm` ignore). This record changes only the
**signal shape**, not the gate.

## Decision

Extract `Dependency audit` from the `ci` job into its own top-level job in
`.github/workflows/ci.yml`:

1. New job **`audit`** with its own `checkout` / `setup pnpm` / `setup node`
   (pnpm cache) / `pnpm install --frozen-lockfile` steps, then the audit step
   running `pnpm audit --audit-level=moderate`. The command and the audit level
   are byte-for-byte what the `ci` job ran.
2. The `audit` job **does not `needs: ci`** — it runs in parallel and reports
   under its own check name, so a red audit and a red project gate are two
   distinct signals. Making it depend on `ci` (even with `if: always()`) was
   rejected: it would reintroduce the coupling through scheduling and delay the
   audit signal behind the slowest job.
3. Both jobs remain **blocking** — neither is `continue-on-error` and neither is
   removed or weakened. No `audit.ignore` entry was added or changed; the ignore
   list is still exactly `GHSA-vfj7-8cjw-p6xm` in `pnpm-workspace.yaml`.

## Consequences

- A red audit now shows as `audit` (failed) with `ci` (success) on the same run,
  and a project regression shows as `ci` (failed) with `audit` independent of it.
  The masking is removed in both directions.
- The run costs one extra `pnpm install --frozen-lockfile` (the audit job cannot
  reuse the `ci` job's workspace). It is the pnpm store-cached install and runs
  in parallel with the heavy job, so wall-clock impact is negligible; the
  install is also the honest way to audit the locked tree rather than a
  hand-rolled subset.
- Repo governance: if `main`'s ruleset gains required status checks, `ci` and
  `audit` should be required **independently** — requiring only `ci` would
  silently drop the audit gate. (Required-check configuration is a human
  repo-settings decision, routed in ADR-0119 L2, not a code change here.)

## Numbering

Resolved as the lowest free `ADR-0nnn` against a fresh `origin/main` at write
time and across every open ref. This record was first written as `0128` against
`main`@`c27f648` (dense through `ADR-0119`), renumbered to `0129` when the OP-96
lane (PR #203) merged mid-flight as `bb70cef`, and then renumbered again to
**`0142`** after the OP-96 follow-up rounds merged: at that point `origin/main`
(`3f46950`) held through `ADR-0137` (`ADR-0129` on `main` is the OP-96 F1–F4
review-findings RED record, so `0129` was no longer free) and the still-open
OP-96 follow-up PRs #219/#220/#221 hold `0138`–`0141`, making `0142` the lowest
number free across `origin/main` _and_ every open ref. If a sibling lane claims
`0142` first, this record renumbers to the lowest free number on the merged
tree, unchanged in content.

## Alternatives considered

- **Keep one job and reorder the audit step to the top.** Rejected: order does
  not change the check name, so the two failures would still collapse into the
  single `ci` status — the masking survives. It also aborts the run before the
  project checks when an advisory exists, which is worse for regression signal.
- **`audit: needs: ci` (with `if: always()`).** Rejected: the audit would be
  gated on the heavy job finishing (and on its scheduling), so an audit failure
  would still be reported only after the project gate ran — and the card
  explicitly requires the audit to report independently.
- **Delete or disable the audit step / add `audit.ignore` entries.** Rejected
  outright: this is a signal-shape change, not a relaxation. The step is the CI
  gate for a moderate+ vulnerability (ADR-0069) and the ignore list must stay
  exactly as it is.
- **A separate workflow file (`audit.yml`).** Rejected: a separate job in the
  same workflow gives the same independent check name with no extra file, no
  duplicated `on:` triggers, and keeps all CI gates visible in one run's job
  list.
- **`continue-on-error: true` on the audit.** Rejected: it would make the audit
  non-blocking, which the card forbids and which is precisely the weakening the
  gate exists to prevent.
