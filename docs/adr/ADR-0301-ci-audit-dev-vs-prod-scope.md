# ADR-0301 — split the `audit` gate by dependency class: blocking `pnpm audit --prod`, non-blocking `pnpm audit --dev`

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (POLICY) — implement the audit-gate split (`t_1bf1ea8d`, backend lane; decision owned by orchestrator card `t_095d34ca`)
- **Relates to:** [ADR-0142](ADR-0142-op101-ci-audit-job-split.md) (gave `Dependency audit` its own blocking `audit` job — the signal-shape change this record builds on), [ADR-0144](ADR-0144-op101-ci-audit-job-split-review-signoff.md) (the review sign-off of that split), [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) (the first audit remediation, cleared the advisories of the day), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the allocator that assigned `0301`)
- **Schema:** n/a · **Contract:** n/a (CI workflow + policy only; no application code)

## Context

ADR-0142 extracted `Dependency audit` from the `ci` job into its own top-level
blocking job `audit`, so a red audit no longer masks the project gate. That
fixed the **signal shape** but left the gate's **scope** unchanged: `audit` ran
`pnpm audit --audit-level=moderate` over the **whole** dependency tree,
`dependencies` and `devDependencies` alike, and any single moderate+ advisory
anywhere in the tree reddened `main` and every open PR.

That scope is wrong for the part of the tree that is not shipped. Observed on
2026-10-20 (OP-101 / PR [#228](https://github.com/yahodu/openpic-webapp/pull/228)):

- A newly-published advisory against a **dev-only** package with no upstream fix
  path landed in the toolchain. Until the lockfile/override bump merged, `main`
  and the entire lane read as failure — the audit job was red while every
  project step was green.
- The recurring shape is expensive: every new advisory in the vitest / esbuild /
  rollup / `mongodb-memory-server` toolchain becomes a **new full-lane red**
  that has to be chased with a lockfile or `overrides:` bump before any
  unrelated work can merge. This is an endless lockfile chase, not a
  supply-chain incident: the advisory is in code that never reaches a deployed
  artefact.
- Meanwhile the security-meaningful part — the **production** supply chain — was
  already clean (`pnpm audit --prod --audit-level=moderate` reported no known
  vulnerabilities) and stayed clean through the same period.

`audit` was therefore conflating two different risk classes under one gate: the
shipped production tree (must stay strictly blocking) and the dev/test toolchain
(should be visible, but must not be able to block the lane).

## Decision

**Split the dependency-audit gate by dependency class** into two independent
top-level jobs in `.github/workflows/ci.yml`, mirroring the independent-job shape
of ADR-0142:

1. **`audit` — blocking, production supply chain only.** The job keeps its name
   (branch protection and check names must not change) and its step becomes
   `run: pnpm audit --prod --audit-level=moderate`. It stays **blocking**: no
   `continue-on-error`. A moderate+ advisory in the shipped tree still fails the
   gate and still blocks the merge.
2. **`audit-dev` — non-blocking, dev/test toolchain only.** A second top-level
   job with **no `needs:`** (it reports independently, exactly as `audit` does),
   the same `checkout` / `setup pnpm` / `setup node` (pnpm cache) /
   `pnpm install --frozen-lockfile` preamble, **job-level
   `continue-on-error: true`**, and a step
   `Dependency audit (dev toolchain, non-blocking)` running
   `run: pnpm audit --dev --audit-level=moderate`. Its advisory output is in the
   run log; a failure does not redden the run.

**Test-only tooling coverage (explicit).** `mongodb-memory-server` and
`mongodb-memory-server-core`, `vitest`, `esbuild` and `rollup` all live in
`devDependencies`. They are **covered** by the non-blocking `audit-dev` job:
their advisories are surfaced in the run log, not hidden, and not gating. When a
dev advisory has a fix, remedy it via the `pnpm-workspace.yaml` `overrides:`
entry as usual — that is what OP-101 (PR #228) did for the `vite` /
`follow-redirects` advisories. Nothing about dev/test supply-chain visibility is
dropped by this split; only its ability to block a merge is.

**`audit.ignore` policy — unchanged.** The `audit.ignore` list in
`pnpm-workspace.yaml` keeps exactly its current entry (`GHSA-vfj7-8cjw-p6xm`).
Extending it **still requires a dedicated ADR justifying each GHSA**, one by one.
The existence of a non-blocking `audit-dev` job does **not** make `audit.ignore`
a free-for-all: the ignore list suppresses an advisory from _both_ jobs and is
recorded governance, whereas `audit-dev` merely reports. Adding or removing
`audit.ignore` entries is a separate decision from this one and is out of scope
here.

## Consequences

- A dev-only advisory with no fix path can no longer redden `main` or block the
  lane. `main` stays green while the advisory is visible in the `audit-dev` job
  log and can be triaged, overridden or deliberately aged out.
- The production supply chain stays **strictly blocking**: the security-relevant
  gate is byte-for-byte stricter in scope (only `--prod`) and unchanged in
  strength (still blocking, same `--audit-level=moderate`, same job name).
- This is a **visibility-preserving, non-blocking report**, not a silent gate
  downgrade: `audit-dev` runs the same audit against the dev tree on every PR
  and push to `main` and prints the findings.
- The run costs one extra `pnpm install --frozen-lockfile` (the two jobs cannot
  share a workspace) — the store-cached install, running in parallel with the
  other jobs, so wall-clock impact is negligible. It is also the honest way to
  audit the locked tree rather than a hand-rolled subset.
- Repo governance: if `main`'s ruleset gains required status checks, `audit`
  should be required; `audit-dev` must **not** be made required, or the
  non-blocking property is silently reversed at the settings layer.
  (Required-check configuration is a human repo-settings decision, not a code
  change here.)
- Dev-toolchain advisories now need an explicit human triage step (read the
  `audit-dev` log) rather than an automatic red. That is the deliberate trade:
  the gate stops being a lockfile-chase trigger, at the cost of the dev advisory
  no longer forcing itself onto the merge path.

## Alternatives considered

- **Option 1 — keep the gate as-is (whole-tree blocking `pnpm audit`).**
  Rejected: it leaves the recurring red. It reproduces the exact condition this
  record responds to — any new dev-toolchain advisory blocks the whole lane
  until a lockfile/`overrides` bump lands, which is an endless chase for
  advisories in code that is never deployed.
- **Option 3 — `--prod` only, drop the dev audit entirely.** Rejected: it
  silently drops test/tooling supply-chain coverage. Advisories in the toolchain
  that actually runs the test suite (and can affect CI integrity) would no
  longer be surfaced anywhere. The split keeps that coverage.
- **Option 4 — keep the whole-tree blocking gate and maintain a documented
  `audit.ignore` allowlist for dev-only advisories.** Rejected: it adds a
  recurring allowlist-maintenance burden (every new dev advisory needs a
  justification and a merge to unblock the lane) and it invites silent gate
  downgrades, because "add to the allowlist" becomes the reflex fix. It also
  conflates the two risk classes that this decision separates.
- **`audit-dev` as a `needs:`/dependent job or a step inside `ci`.** Rejected:
  it would reintroduce coupling through scheduling and bury the dev report
  behind the heavy job. It must be a top-level job reporting under its own check
  name, exactly as ADR-0142 established for `audit`.
- **A separate workflow file (`audit-dev.yml`).** Rejected: a second job in the
  same workflow gives the same independent report with no extra file, no
  duplicated `on:` triggers, and keeps all CI gates visible in one run's job
  list.

## Numbering

Allocated as **`0301`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) by orchestrator card `t_095d34ca`, under the per-lane reserved
range policy of [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md). The
index cell for that range in `docs/adr/README.md` is advanced from `0300` (the
policy ADR) to **`0302`**. Because the range is disjoint by construction, this
number is not re-resolved against `origin/main`'s high-water mark and cannot
collide with a lane.
