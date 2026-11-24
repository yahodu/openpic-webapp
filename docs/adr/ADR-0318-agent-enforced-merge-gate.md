# ADR-0318 — The merge gate is enforced by the merging agent, not by the branch ruleset

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** board process (`t_b38fd67e`, Medium; the decision was taken on `t_72d33d02` by Ashish, 2026-11-18T13:49Z) · **Branch:** `OP-135-task-agent-merge-gate` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op135-merge-gate-adr`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0318`
- **Relates to:** [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (CI evidence is a `pull_request` run on the head SHA; a missing check is never green — the rule this record finally gives an enforcement point), [ADR-0316](ADR-0316-pr-run-pinned-merge-ref-refresh.md) (a `pull_request` run is pinned to its own merge commit: refresh stale evidence by synchronizing, never by `gh run rerun` — the precondition of G6), [ADR-0301](ADR-0301-ci-audit-dev-vs-prod-scope.md) (the blocking `audit` / non-blocking `audit-dev` split), [ADR-0313](ADR-0313-audit-dev-check-run-non-failing.md) (the always-`success` `audit-dev` check-run), [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md) (a card does not complete on an unmerged deliverable)
- **Schema:** n/a · **Contract:** n/a (process rule; no application code)
- **Implementation:** none — no repository-settings change, and no file under `.github/`, `apps/` or `packages/` changes · **Spec:** none (no code, no test)

## Context

Main is protected by exactly one ruleset, and that ruleset does not require a
single check. Measured with `gh api repos/yahodu/openpic-webapp/rulesets/11577307`
at `origin/main` `1167db2d` (2026-11-18):

| Fact                                   | Measured value                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruleset                                | `11577307`, `main branch ruleset`, `target: branch`, `enforcement: active`, `conditions.ref_name.include: ~DEFAULT_BRANCH`                   |
| `required_status_checks`               | `[]` — **no check is required to merge**                                                                                                     |
| `strict_required_status_checks_policy` | `true` — vacuous while the required list is empty                                                                                            |
| Other rules                            | `deletion`, `non_fast_forward`, `required_linear_history`, `pull_request` (1 approval, code-owner review, thread resolution), `code_quality` |
| `bypass_actors`                        | Integration `3251029` and User `77051732`, both `bypass_mode: always`                                                                        |
| `current_user_can_bypass`              | `"always"`                                                                                                                                   |
| The identity `gh` authenticates as     | `getwithashish`, `id: 77051732` — the User bypass actor above                                                                                |
| The command merges run                 | `gh pr merge --squash --admin`                                                                                                               |
| `updated_at`                           | `2026-10-01T10:51:33Z` (unchanged by this record)                                                                                            |

The consequence is structural. The only identity that merges a PR here is the
same identity that opens it, so it cannot satisfy the one-reviewer rule and must
merge through `--admin`. That identity is an `always` bypass actor, so it would
pass a `required_status_checks` list the same way: the list would render as
required in the UI and stop nothing at merge time. Adding `audit` and `ci` to it
would produce a gate that _looks_ enforced and is bypassed on every merge.

The decision source (Ashish, 2026-11-18T13:49Z, card `t_72d33d02`) is therefore:
**do not change the repository settings** — the plan does not permit the
strict-validation configuration — and put the gate where the decision is
actually made, in the merging agent. The requirement is one sentence: the agent
that merges must check that all checks are passing before it merges.

The gap this closes is measurable. [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md)
already states that a missing check is no evidence, and
[ADR-0316](ADR-0316-pr-run-pinned-merge-ref-refresh.md) already states that a
stale green cannot be refreshed by rerunning it — but neither rule had an
enforcement point. Between them sits the merge: a green with no freshness check,
or a green whose audited tree is not the tree the merge would produce, passes
every existing rule because no rule reads the evidence at merge time. The two
open PRs at this head show both shapes: `#279` carries a full `COMPLETED` /
`SUCCESS` rollup (14 entries), and `#272` answered `mergeable: UNKNOWN` on one
read and `CONFLICTING` / `mergeStateStatus: DIRTY` on every `gh pr view` read
seconds later — which is why condition G1 re-polls instead of reading a single
`UNKNOWN` as a pass.

## Decision

### 1. The merging agent runs the gate on the exact head SHA, immediately before the merge

The gate is a **pre-flight of the merge**, not a CI job and not a repository
setting. Whoever runs `gh pr merge` — an agent or a human — reads the PR's
current head SHA and evaluates the seven conditions below against **that** SHA.
The gate's output is pasted into the PR (body or a comment) before the merge, so
the evidence for the merge lives where the merge is reviewed.

`--admin` is not a gate bypass in this scenario: it exists to bypass the
one-reviewer rule that the sole `gh` identity cannot satisfy by approving its own
PR. **A failed gate is never merged with `--admin`.**

### 2. The seven conditions

- **G1** `mergeable == "MERGEABLE"` and `mergeStateStatus` ∉ {`DIRTY`, `UNKNOWN`}; re-poll up to 5 × 3 s when `UNKNOWN`.
- **G2** every entry in `statusCheckRollup` for the head is `status: COMPLETED` with `conclusion: SUCCESS` — no `FAILURE`, no `PENDING`, no `CANCELLED`, no `SKIPPED` on a gating name.
- **G3** the gating name set is present on the head: `ci`, `audit`, `audit-dev`, `secret-scan`, `lint`, `unit_test`, `test_coverage`, `env-changes`, `validate-branch-name`, `validate-pr-title`, `Assert CI evidence for the pushed head`.
- **G4 (audit freshness)** No commit on `origin/main` in `<merge-base>..origin/main` may touch the **audit input surface** — `pnpm-lock.yaml`, `pnpm-workspace.yaml` (carries `audit.ignore`), `package.json`, `.github/workflows/ci.yml` (carries the `audit`/`audit-dev` jobs and thresholds) — with a commit date _later_ than the head's `audit` check `completedAt`. If one did, the green predates a change in what `audit` means: **STALE**.
- **G5** `git diff --quiet <merge-base> origin/main -- pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml` — if false, the merge would change the audited tree, so the head's evidence cannot cover the merge result.
- **G6** on any failure: **do not merge**, do not rebase, do not `gh run rerun`, do not `--admin`. Comment the failing condition on the PR and route — reconcile through the lane owner (merge `origin/main` in, push to re-trigger CI and get a fresh merge ref) or close as superseded.
- **G7** (added 2026-11-24, `ADR-0300` §11 item 28): on an ADR-carrying PR the number the PR adds must be absent from every other open PR head at the merge instant — `docs/CONVENTIONS.md` §9.1.

### 3. The commands (read-only; `gh` and `git` only)

```
N=<pr>; SHA=$(gh pr view "$N" --json headRefOid -q .headRefOid)
gh pr view "$N" --json mergeable,mergeStateStatus
gh pr view "$N" --json statusCheckRollup \
  -q '.statusCheckRollup[] | "\(.name)\t\(.status)\t\(.conclusion)\t\(.completedAt)"'
BASE=$(git merge-base "$SHA" origin/main)
git log --format='%cI %h %s' "$BASE"..origin/main -- \
  pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml
git diff --quiet "$BASE" origin/main -- \
  pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml && echo G5-pass
```

G1 and G2 are the output of the first two `gh pr view` calls. G3 is read from
the rollup names. G4 is the `git log` output compared against the `audit`
entry's `completedAt` — an empty log passes G4, and a non-empty log whose newest
commit date is older than `completedAt` passes it too. G5 is the printed
`G5-pass`; its absence is a failure, not a warning.

### 4. A failed gate stops the merge and the branch work

A failing condition ends the card's landing step (G6). The response is a PR
comment naming the condition and the value that failed, then a route: the lane
owner merges `origin/main` in and pushes (a new head, a new merge ref, fresh
evidence) or the PR is closed as superseded. Refreshing evidence by rerunning a
check is explicitly excluded — a `pull_request` run replays its own frozen merge
commit ([ADR-0316](ADR-0316-pr-run-pinned-merge-ref-refresh.md)), so a rerun of a
stale green can only turn it red, never make it current.

### 5. What does not change

- No ruleset, protection rule, required check or bypass actor is edited. The
  ruleset must read identically after the gate is adopted —
  `gh api repos/yahodu/openpic-webapp/rulesets/11577307` before and after.
- `.github/workflows/ci_evidence_guard.yml` stays as it is. It is the visibility
  arm (ADR-0305): it annotates a pushed head that has no evidence, and it cannot
  stop a merge made by an `always` bypass actor.
- No application code, no spec and no workflow changes. This record adds a
  process rule, one Definition-of-Done bullet, one line in `AGENTS.md` and one
  checkbox in the PR template.

## Consequences

- Every merge now costs one gate run — two `gh pr view` calls, one
  `git merge-base`, one `git log` and one `git diff` on four paths. Seconds, and
  no network round trip beyond GitHub's own API.
- The evidence for a merge is durable: the printed gate output sits in the PR
  that was merged, so a later reader can re-evaluate the decision against the
  same head SHA instead of trusting the merge.
- The gate replaces nothing. The ruleset still requires linear history, a code
  owner and one approval; `--admin` still bypasses the approval the sole `gh`
  identity cannot give. The seven conditions are added on top, at the one moment
  the bypass actor decides.
- The residual risk is stated plainly: this is a process rule, so a merger that
  does not run it can still merge a red or conflicted PR. That risk is accepted
  by the decision source, because the settings route is out of bounds and would
  be bypassable by the same identity anyway. The mitigation is that every merge
  lane's handoff now has to carry the gate output, so a missing run is visible
  in the record.
- A `BLOCKED` `mergeStateStatus` passes G1 by design (G1 excludes `DIRTY` and
  `UNKNOWN`): `BLOCKED` is the missing-review state that `--admin` exists for, and
  turning it into a failure would make every merge in this repository fail.
- The `audit` freshness rule (G4) is what keeps a green meaningful across a
  dependency change on `main`. It is deliberately narrow — four paths that
  define what `audit` audits — so it does not redden on unrelated trunk work.

## Alternatives considered

- **(a) Add `audit` and `ci` to `required_status_checks`.** Rejected twice over.
  The settings change is out of bounds for the plan that owns this work, and it
  would be ineffective even if it were permitted: the merging identity is an
  `always` bypass actor (`current_user_can_bypass: "always"`), so a required
  check would be enforced on everyone except the one identity that merges. The
  gate would read as enforced in the repository settings and stay bypassable at
  the command line — a worse outcome than an honest process rule.
- **(b) Make the gate a CI job.** Rejected. `.github/workflows/ci_evidence_guard.yml`
  is the right shape and already exists, but a check cannot stop a merge made
  through an `always` bypass: it can only annotate the head. It stays as the
  visibility arm and is not edited here. A job that reports PASS while the merge
  decision ignores it would add a green without adding a gate.
- **(c) Rebase, or `gh run rerun`, to refresh stale evidence.** Rejected as a
  refresh mechanism and as a gate remedy. A `pull_request` run is pinned to the
  merge commit GitHub built for its own event, so a rerun replays a pre-fix tree
  and can manufacture reds ([ADR-0316](ADR-0316-pr-run-pinned-merge-ref-refresh.md),
  card `t_8f0c9915`). Freshness comes from a **synchronize** event — a push, or a
  merge of `origin/main` into the branch — which is exactly what G6 routes to.

## Numbering

Allocated as **`0318`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md),
on the value the allocator reserved at card creation. The sweep for `0318` at
`origin/main` `1167db2d` was empty: no `ADR-0318` file on the trunk, in
`git rev-list --objects --all -- docs/adr`, in any live `.worktrees/*/docs/adr`
tree, on a remote head or in an open PR. This record advances the block cell to
`0319`. No number outside `0300`–`0319` is touched.

## Evidence

Measured in this card's run at `origin/main` `1167db2d` (2026-11-18). The ruleset
table in §Context is the raw `gh api repos/yahodu/openpic-webapp/rulesets/11577307`
response; `gh api user` answers `getwithashish` / `77051732`, which is the User
entry in `bypass_actors`.

Where each gating name of G3 comes from (measured in this tree, not inferred
from a check name seen on a PR):

| Gating name                                                                                      | Source                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `ci`, `audit`, `audit-dev`, `secret-scan`                                                        | `.github/workflows/ci.yml` jobs                                       |
| `lint`, `unit_test`, `test_coverage`, `env-changes`, `validate-branch-name`, `validate-pr-title` | `.github/workflows/pr_checks.yml` jobs                                |
| `Assert CI evidence for the pushed head`                                                         | `.github/workflows/ci_evidence_guard.yml` job `ci-evidence` (`name:`) |

The two open PRs at this head, both untouched by this record:

| PR     | `mergeable`                           | `mergeStateStatus` | Rollup                                                                                                                                        |
| ------ | ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `#279` | `MERGEABLE`                           | `BLOCKED`          | 14 entries, every one `COMPLETED` / `SUCCESS` — the eleven gating names plus `CodeQL`, `Analyze (actions)`, `Analyze (javascript-typescript)` |
| `#272` | `CONFLICTING` (`UNKNOWN` on one read) | `DIRTY`            | a draft; a `CONFLICTING` branch fails G1, and the single `UNKNOWN` a list read returned is why G1 re-polls                                    |

`#279` is the reference shape a passing head produces: the eleven names of G3 are
all present, and G2's stricter reading (every entry, not only the gating names)
holds at the same time because no advisory check was red. `#272` is why `UNKNOWN`
is a re-poll rather than a verdict: the same PR answered `UNKNOWN` on one read
and `CONFLICTING` / `DIRTY` on the next, so a single answer is not a measurement
of the merge state — and a gate that read either answer alone would block a good
merge or wave a bad one through.

This record's own PR was merged under the gate it defines; the printed output of
the six conditions as they then stood, for its head SHA, is in that PR's body,
and the merge metadata on card `t_b38fd67e` repeats the verdict.
