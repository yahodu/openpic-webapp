# ADR-0305 — The CI-evidence guard: a push-triggered workflow that fails a lane head whose PR conflicts with `main`

- **Status:** Accepted · **Date:** 2026-10-23
- **Card:** OP-101 CI-evidence guard — RED `t_fe3b946f` (test author) / GREEN `t_22f95e1f` (implementer); branch `OP-101-task-ci-evidence-guard`, worktree `/root/openpic/openpic-webapp/.worktrees/t_fe3b946f`
- **Relates to:** [ADR-0303](ADR-0303-workflow-shell-safety-guard.md) (the `run:`-body `env:`-transport rule this workflow must satisfy), [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (the stale-draft-PR reconciliation that found all eight closed draft branches conflicting on `docs/adr/README.md`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the allocation policy this board-wide number is drawn from)
- **Schema:** n/a · **Contract:** n/a (CI workflow only; no application code)
- **Implementation:** `.github/workflows/ci_evidence_guard.yml` · **Spec:** `apps/web/src/test/unit/ci-evidence-guard.test.ts` (scanner `apps/web/src/test/helpers/ci-evidence-guard.ts`)

## Context

GitHub creates **no `pull_request` workflow run while a PR has a merge
conflict**. The GitHub Actions documentation states it directly: _"Workflows
won't run on pull requests that have a merge conflict."_ Both `CI`
(`.github/workflows/ci.yml`) and `PR Checks` (`.github/workflows/pr_checks.yml`)
trigger on `pull_request`, so a lane head whose PR conflicts with `main` gets
**no run at all**.

The only checks then left on the head are CodeQL _default setup_ runs
(`event=dynamic`, push-triggered and therefore not conflict-suppressed). The
rollup shows those checks green, so the head **reads green although the test
suite never ran**. `main` carries no required status checks to catch the gap.

This was not hypothetical: all eight closed OP-101 draft branches (#160, #163,
#170, #164, #185, #191, #200, #215) conflicted on `docs/adr/README.md`, and each
one showed exactly this shape — CodeQL green, `CI`/`PR Checks` absent. Pointing
at `pull_request_target` (which the docs say _does_ run on conflicting PRs) was
considered, but its check attachment to the PR-head rollup is unproven here,
whereas the **push** path is proved: a push-triggered run is not
conflict-suppressed and its check attaches to the pushed head SHA.

## Decision

A new workflow, `.github/workflows/ci_evidence_guard.yml`, is the **enforcement
arm** of this decision: it fails the pushed head when its open PR conflicts with
its base, so a CodeQL-only rollup cannot read green.

### 1. Trigger — `push`, `branches-ignore: [main]`

The workflow triggers on `push` only (`branches-ignore: [main]`). It is **not**
`pull_request`- or `pull_request_target`-triggered — the former is precisely the
trigger that is suppressed on a conflict, and the latter's head-rollup
attachment is unproven. `on: push` is the one trigger proved (by the CodeQL
default-setup runs) to run and attach when a `pull_request` run is suppressed.

### 2. Permissions — read-only

Workflow-level `permissions: contents: read`, `pull-requests: read`,
`checks: read`. No write scope and no secret beyond the auto-provided
read-scoped `GITHUB_TOKEN`; none of `contents`, `pull-requests` or `checks` may
be `write`.

### 3. Behaviour — read the API, never the code

The single job `ci-evidence` **checks out nothing** (there is no
`actions/checkout`) and executes nothing from the head branch; it only reads the
GitHub API with `curl`. Every `${{ … }}` context (`github.repository`,
`github.sha`, `secrets.GITHUB_TOKEN`) is transported through the step `env:`
map and read as a shell variable, never interpolated into `run:` text — the rule
[ADR-0303](ADR-0303-workflow-shell-safety-guard.md) enforces. For the pushed
head SHA the job:

1. queries `GET /repos/{repo}/commits/{sha}/pulls` for an **open PR whose head
   is this SHA**; **no open PR is an ordinary branch push, so it exits 0**
   (no CI is expected on a branch with no PR);
2. **conflict assertion (the primary, deterministic condition):** when the PR is
   conflicting — `mergeable == false` or `mergeable_state == "dirty"` — it emits
   `::error::` and exits 1, naming the PR and its base and stating that GitHub
   suppresses `pull_request` runs on a conflicting PR, that `CI`/`PR Checks`
   therefore have not run on this head, and that the remedy is `git merge
origin/main` in the lane worktree, resolve, push;
3. **absence assertion (belt-and-braces):** when the PR is mergeable it requires
   a run of workflow `CI` **and** of workflow `PR Checks` whose `head_sha` equals
   the pushed SHA, polling briefly (≤ ~60 s) to absorb the race with the runs a
   push just created; if either is still absent it emits `::error::` and exits 1.

`mergeable` is `null` while GitHub is still computing it, so the job re-queries
a few times and **never fails on `null`** — only on a conclusive `false`/`dirty`.

### 4. The contract is pinned by a unit spec

`apps/web/src/test/unit/ci-evidence-guard.test.ts` (RED `t_fe3b946f`) scans
`.github/workflows/ci_evidence_guard.yml` with the pure scanner
`apps/web/src/test/helpers/ci-evidence-guard.ts` and pins six invariants —
trigger shape, minimal permissions, no `actions/checkout`, the conflict
assertion, the absence check, and **no `${{ … }}` in any `run:` body** — each
asserted both on a synthetic fixture and on the repository's real workflow. The
guard therefore cannot silently regress: deleting or weakening it reddens
`pnpm test:unit`.

## Consequences

- A lane head whose PR conflicts with `main` now shows a **failing** check
  instead of a CodeQL-only green rollup; the failure names the PR, the base, and
  the exact remedy.
- `pnpm test:unit` is a required pre-merge check for any change to
  `.github/workflows/ci_evidence_guard.yml`; the six invariants above are
  enforced mechanically, not by review prose.
- The workflow holds no write scope, checks out no code and runs none, so it
  adds no shell-injection or token-exfiltration surface.
- The guard runs only on non-`main` pushes; a push to `main` is unaffected.

## Alternatives

- **`pull_request_target` as the trigger.** Rejected as the primary trigger: the
  GitHub docs say it runs on conflicting PRs, but its check attachment to the
  PR-head rollup is unproven in this repository, whereas the push path is proved
  by the CodeQL runs. `on: push` is the load-bearing, evidence-backed choice.
- **Add `pull_request` as an additional trigger.** Rejected: it is exactly the
  conflict-suppressed trigger, and it is the reason `CI`/`PR Checks` go missing
  on a conflicting head in the first place.
- **Make the check a required status check on `main` instead.** Rejected here:
  it would need branch-protection administration (a separate, human-owned
  change) and would still not _diagnose_ the conflict; failing the head with an
  actionable message is the narrower, testable fix.
- **Check out the head branch and run the suite from this workflow.** Rejected:
  it would execute untrusted head code and duplicate `CI`; the job only reads
  the API by design.
- **Parse the workflow with a real YAML parser in the scanner.** Rejected: a new
  dependency, and the pinned questions are line-shaped — the same choice as the
  `workflow-shell-safety` and `adr-numbering` scanners.
