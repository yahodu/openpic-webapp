# ADR-0118 — OP-101: remediate the repo-wide `ci` "Dependency audit" failure (`next` <15.5.27, `handlebars` ≤4.7.9)

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 CI dependency-audit remediation (`t_aed7d907`, backend lane; raised by the review of `t_b0efb45d`, PR #208)
- **Relates to:** [ADR-0069](ADR-0069-op91-green-review-signoff.md) (the OP-69 CI pipeline this step belongs to), [ADR-0110](ADR-0110-op89-residual-adr-0043-production-citations.md) (predecessor precedent for a fresh-`origin/main` ADR number)
- **Schema:** n/a · **Contract:** n/a (dependency + lockfile only; no application code)

## Context

The `ci` workflow (`.github/workflows/ci.yml`) went red on `main` itself and on
every open PR, and the failure was in its **last** step, `Dependency audit`
(`pnpm audit --audit-level=moderate`), not in any project check. Because the
audit step is the final step of the job, a genuine unit/integration/typecheck
regression is indistinguishable from the expected audit failure at the "PR CI"
level — the whole lane reports failure for every PR.

Evidence gathered 2026-10-20:

- `main`@`229a64c` → run 39409522961: Typecheck, Lint, Unit, Integration,
  Coverage, Build and E2E all pass, then `Dependency audit` exits 1. The last
  green run on `main` is 37404058547 (`f459502`, 2026-10-06), so this went red
  with newly published advisories, not with a code change.
- Failed audit output: `6 vulnerabilities found — Severity: 3 moderate | 1 high
(1 ignored) | 2 critical`, notably:
  - `next` `>=15.0.0 <15.5.27` — [GHSA-mcj8-r9mp-w47p](https://github.com/advisories/GHSA-mcj8-r9mp-w47p)
    (SSG/ISR cache poisoning → cross-user content substitution / persistent DoS).
    Paths `apps__web>better-auth>next` and `apps__web>next`; the repo pinned
    `next@15.5.26`.
  - `handlebars` `>=4.0.0 <=4.7.9` — [GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7),
    16 paths, all `semantic-release → conventional-changelog-writer`; patched at
    `>=4.7.10`.

The workflow's own ignore mechanism already exists (`pnpm-workspace.yaml` `audit.ignore`,
holding one unrelated advisory), so a deferral was available. It was rejected —
see Alternatives.

## Decision

Remediate rather than defer:

1. **`next` `^15.1.0` → `^15.5.27`** in `apps/web/package.json`. This is a normal
   dependency bump, not a silent lockfile refresh: the vulnerable range is
   `<15.5.27`, so the declared floor is raised to the patched line. The lockfile
   resolves `next@15.5.28` (the current patch of that line). better-auth's
   optional `next` peer (`^14.0.0 || ^15.0.0 || ^16.0.0`) is satisfied, so both
   audit paths (`apps__web>next` and `apps__web>better-auth>next`) clear with the
   one edit.
2. **`handlebars@<4.7.10 → 4.7.10`** as a `pnpm.overrides` entry in
   `pnpm-workspace.yaml`, alongside the pre-existing `postcss` override and
   following its comment convention. `conventional-changelog-writer@8.4.0`
   declares `handlebars@^4.7.7`; the range is not vulnerable-only, but the
   lockfile had resolved the vulnerable `4.7.9`, so the override pins the patched
   patch. It is removed once upstream resolves `>=4.7.10` on its own.
3. The regenerated `pnpm-lock.yaml` is committed in sync (CI runs
   `pnpm install --frozen-lockfile`).

No `audit.ignore` entry was added — the audit now exits 0 with the existing ignore
list untouched, i.e. the `1 high (1 ignored)` remainder is the pre-existing
`GHSA-vfj7-8cjw-p6xm` record, not either of the two advisories this card is about.

## Consequences

- The `ci` workflow's `Dependency audit` step passes, restoring the lane's signal
  on `main` and every PR.
- `next` 15.5.27+ is a behavioural change (cache-key scoping, case-sensitive data
  paths, `dynamicParams` handling in metadata image routes), so it was validated
  as a normal change: typecheck, lint, `format:check`, unit (1460), integration
  (326), coverage (93.27% lines, threshold 80%), `next build` and the Playwright
  `api`/`api-production` projects (16) are all green on the branch.
- A second `pnpm-workspace.yaml` override now exists — the file is the single
  documented place for "force a patched transitive version while upstream pins a
  vulnerable range". The `handlebars` entry should be deleted when
  `conventional-changelog-writer` (or its successors in the `semantic-release`
  chain) move past `4.7.9` unaided.
- The orphaned Dependabot PR #207 (`chore(deps): bump next from 15.5.26 to
15.5.27`) covers only the `next` half and no longer applies; it can be closed
  once this lands.

## Numbering

Resolved as the lowest free `ADR-0nnn` against a fresh `origin/main` at write
time: `main`@`f0b428e` is dense through **ADR-0110**, so the nominally lowest
free number is `0111`. However the unmerged OP-96 lane (PR #203) already writes
`0111`–`0117`, so that range is claimed across open refs. This record therefore
took **0118**, the lowest number free across `origin/main` _and_ every open
branch, to avoid the renumber-at-integration churn `docs/adr/README.md` records
(ADR-0066/0081/0110). If a sibling lane claims `0118` first, this record renumbers
to the lowest free number on the merged tree, unchanged in content.

## Alternatives considered

- **Defer both advisories via `audit.ignore` (the card's fallback).** Rejected:
  both advisories are reachable in this codebase (`next` is the production
  framework and self-hosted rendering is in scope for the cache-poisoning
  advisory; `handlebars` is build-tool-only, a low blast radius but still
  fixable). The preferred route (bump + override) is a two-line, fully testable
  change, and the whole point of this card is to restore CI signal — a deferral
  would leave the lane red-by-policy and needs a named owner and review date. It
  is kept documented here as the fallback had the bump broken the suite.
- **`handlebars`-only override plus a deferral of the `next` advisory.** Rejected
  as the primary route: `next` is the framework the app and its e2e suite run on,
  the patch is a drop-in, and the local suite proves it. Also kept as the
  documented fallback.
- **Override `next` instead of bumping the direct dependency.** Rejected:
  `apps/web` declares `next` directly, so raising its specifier is the honest
  edit; an override would hide the direct-dependency floor. (No `next` override
  is needed — the lockfile has no sub-`15.5.27` `next` after the bump.)
- **Delete or disable the audit step.** Rejected outright by the card and by
  ADR-0069: the step is the CI gate for a moderate+ vulnerability.
