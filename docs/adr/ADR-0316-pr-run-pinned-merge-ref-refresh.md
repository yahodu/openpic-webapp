# ADR-0316 — A `pull_request` run is pinned to its own merge commit: refresh stale check evidence by synchronizing, never by `gh run rerun`

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-135 DEPS follow-up (`t_8f0c9915`, Low; raised by the verification card `t_f4a45d1c`) · **Branch:** `OP-135-task-frozen-merge-ref-adr` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8f0c9915`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0316`
- **Relates to:** [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (a conflicting PR starts no `pull_request` run — the "no check is not green" rule this record extends), [ADR-0315](ADR-0315-picomatch-redos-audit-ignore.md) (the governed `audit.ignore` entry every measurement below is taken against), [ADR-0301](ADR-0301-ci-audit-dev-vs-prod-scope.md) (the blocking `audit` / non-blocking `audit-dev` split), [ADR-0313](ADR-0313-audit-dev-check-run-non-failing.md) (the `audit-dev` check-run), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (number allocation)
- **Schema:** n/a · **Contract:** n/a (process rule; no application code)
- **Implementation:** none (this record changes no file under `.github/`) · **Spec:** none (no code, no test)

## Context

The verification card `t_f4a45d1c` was dispatched with this instruction:

> "re-running the check on the PR merge ref is enough because GitHub re-evaluates
> the merge commit against current main."

**That is false on this repository.** For a `pull_request` event the job checks
out the merge commit GitHub built for that event, and the run keeps that commit:
a rerun replays the run's stored event with the stored `GITHUB_SHA`. It audits
the same tree as the original run. Nothing about `origin/main` is re-evaluated —
only the advisory database the audit queries is live, so a rerun of an old green
can only **turn it red**, never refresh it.

`refs/pull/N/merge` is a separate, moving pointer: it names the merge GitHub
built most recently, which is why re-reading it proves nothing about what an
older run audited. Measured on `origin/main` `e8cf60b0`
(2026-11-17T20:30Z, the trunk that carries the [ADR-0315](ADR-0315-picomatch-redos-audit-ignore.md)
fix `47d36617`):

| Fact                                                                                      | Measured value                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `refs/pull/272/head`                                                                      | `d5be9af4`                                                                              |
| `refs/pull/272/merge`                                                                     | `300fcf35` — `Merge d5be9af4… into 67feedeb…`, 2026-10-24T20:56:12Z                     |
| The `CI` run on that head, run `40132002880` (`pull_request`, attempt 1)                  | started 2026-10-24T20:56:14Z; `pull_requests[0].base.sha` = `67feedeb`                  |
| That run's `audit` job checkout line (job `120985491611`)                                 | `HEAD is now at 300fcf3 Merge d5be9af4… into 67feedeb…`                                 |
| `300fcf35:pnpm-workspace.yaml` occurrences of `GHSA-fc5q-39xc-vjpf`                       | `0` — the tree predates the ignore                                                      |
| `pnpm audit --prod --audit-level=moderate` run on exactly that tree (this record's probe) | rc `1`, `1 high`, `GHSA-fc5q-39xc-vjpf`, 9 `better-auth > vitest > … > picomatch` paths |
| `#272`'s `audit` check today                                                              | `SUCCESS`, completed 2026-10-24T20:56:38Z — a green that a rerun would replace with red |

So `#272` carries a **stale-green** `audit` whose tree contains no ignore entry.
The check is green only because it ran on 2026-10-24, before the advisory's
metadata put `picomatch@4.0.7` in scope. A `gh run rerun` of run `40132002880`
replays `300fcf35`, the probe above says rc `1`, and the PR's `audit` check turns
**red** — with no dependency change on the branch at all.

The same pointer is not frozen in the other direction either: for the one
mergeable PR, `refs/pull/670/merge` read `6da24a1d` (`Merge 1b38307d into
533bc7f5`, 20:03:42Z) when the parent card measured it and `9d2ef839` (`Merge
48bd808f into e8cf60b0`, 20:41:42Z) 38 minutes later, after the PR synchronised;
its tree does carry the ignore, and its `CI` run reports `audit: success`. A
pointer that moves is exactly why an **old run** cannot be refreshed by rerunning
it: the run does not follow the pointer.

Two PRs in the parent scan had no `CI` evidence at all: `git ls-remote origin
'refs/pull/545/*' 'refs/pull/668/*'` returns a `head` and **no `merge`** ref for
either, because a push made while the PR is `CONFLICTING` builds no merge commit
and therefore starts no `pull_request` run ([ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md)
§1 already records this suppression). Both were closed unmerged by the backlog
triage minutes after that measurement (`#668` 20:52:26Z, `#545` 20:55:50Z). The
two remaining open `CONFLICTING` PRs, `#272` and `#279`, both carry stale-green
`audit` records. A merge ref left over from an earlier mergeable moment survives
— that is why `#272`, also `CONFLICTING`, still has one — but it is stale, and
it is not evidence of the current head.

## Decision

### 1. Stale check evidence is refreshed by a synchronize event, never by a rerun

A PR's check evidence is refreshed only by a **`synchronize`** event: a push to the
head branch, or GitHub's "Update branch" button (which pushes a merge commit to
the head branch). Both make GitHub build a new merge commit, start a new `CI` run
on it, and attach a fresh `audit` check to the new head.

`gh run rerun` and `gh run rerun --failed` are **not** a refresh. They replay the
run's own stored `GITHUB_SHA`, so they re-audit the tree that was already audited
(§Context, `#272`). When the branch is already current with `main` and GitHub
offers no "Update branch", the sanctioned refresh is a push — a merge of
`origin/main` if there is anything to bring in, otherwise an empty commit on the
lane branch. Cite the new run, not the old one.

### 2. A refresh verifies the gate; it never justifies a rebase

Refreshing is a **verification** act, not a repair. The reason to synchronize is
to learn whether the head passes the current gate, and that is the only reason.
A branch that still carries a real advisory — one with no governed
[ADR-0301](ADR-0301-ci-audit-dev-vs-prod-scope.md)/[ADR-0315](ADR-0315-picomatch-redos-audit-ignore.md)
exception — must **stay red**. Turning a check green is never achieved by
re-running it, by rewriting the branch, or by re-cutting it onto a newer base:
the code, the lockfile and the advisory are what the gate measures, and a rebase
that changes them changes the deliverable under review, not the evidence about
it. If a refresh reddens a branch, the finding is the finding.

### 3. "No check" is "no evidence", never "green"

A `CONFLICTING` PR can carry no `CI`/`audit` check at all (`#545`, `#668` at the
time of the parent scan: no `refs/pull/N/merge`, so no `pull_request` run — both
were closed unmerged afterwards). Absence of a check is treated
exactly as [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) §1
states: the head is **UNVERIFIED**. It is never read as passing, and it is never
resolved by `gh run rerun` (there is no run to rerun). The only cure is
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) §2: merge
`origin/main` into the lane branch (**merge, not rebase**, so reviewed SHAs
survive), resolve the conflict, push — and the push is the synchronize event of
§1. Likewise, a merge ref that exists but is older than the trunk commit the
branch must carry (a fix it is supposed to inherit) is **stale evidence**, not
green evidence.

### 4. Whether `audit` becomes a required check is a separate ruleset decision

This record settles **how** evidence is refreshed, not **whether** it is
enforced. `main`'s ruleset declares no required status checks, so a red or absent
`audit` blocks nothing on its own. That question — making `audit` (and `CI`) a
required status check, and triaging the backlog of PRs holding stale-green or
absent evidence — is owned by the sibling ruleset/backlog decision card
`t_72d33d02` (openpic-orchestrator), raised by the same verification card. This
ADR neither pre-empts nor depends on that decision.

## Consequences

- A lane handoff cites the `CI` run **on the head SHA** it is claiming, with the
  merge base the run actually audited, and never a check-rollup count
  ([ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) §1).
- `gh run rerun` stops being a refresh tool in this repository. Its only legitimate
  uses are re-running a run that failed for an infrastructure reason (runner
  outage, flaky service) on a tree whose content is unchanged — and even then the
  new conclusion is a statement about that same tree.
- The 18 open PRs `t_f4a45d1c` scanned (15 with stale-green `audit` records,
  `#545`/`#668` with none) keep those records until they are next pushed; the
  open set has since shrunk to `#672` (fresh `audit`, 20:53:14Z), `#272` and
  `#279` (both stale green, both `CONFLICTING`). They are **not** evidence that
  those branches pass today's gate, and they must not be "refreshed" by rerun.
- Refreshing costs one push and one full `CI` run per PR; that cost is the point —
  it is the only way the gate gets a say about the current tree.
- Nothing about `.github/workflows/ci.yml`, the `audit`/`audit-dev` job
  definitions, `pnpm-workspace.yaml`, the lockfile or any application file changes
  here. This record is a rule for reading and obtaining evidence.

## Alternatives considered

- **`gh run rerun` / `gh run rerun --failed` (the card's premise).** Rejected:
  measured to replay the run's own merge commit (`#272` → `300fcf35`, no ignore,
  probe rc `1`), so it converts a stale green into a red for a reason that is not
  on the branch.
- **Re-run and read the new conclusion as a refresh.** Rejected: it is a refresh
  of nothing. The conclusion describes the tree the run already audited.
- **Rebase onto `main` to pick up the fix and force a new run.** Rejected as a
  _refresh_: it rewrites the reviewed SHAs and conflates "make the gate see the
  fix" with "make the branch different". Where a branch genuinely needs the trunk
  fix, it merges `origin/main` ([ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md)
  §2); a branch that carries a real advisory stays red.
- **Treat an absent check as green because the PR is only conflicting on docs.**
  Rejected: that is precisely the category error
  [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) was written for —
  the rollup is green and the suite never ran.
- **Add a push-triggered `audit` workflow so conflicting PRs get evidence.**
  Rejected here: it would duplicate the gate on a second trigger and answer the
  enforcement question (§4) that card `t_72d33d02` owns. `ci_evidence_guard.yml`
  already makes the missing run loud on push.

## Numbering

Allocated as **`0316`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md),
on the cell this card's body names ("the cell was at `0316` after ADR-0315
landed"). The cell read `0316` in `docs/adr/README.md` at this head, and the sweep
for `0316` was empty: no `ADR-0316*` file on the trunk `e8cf60b0`, in
`git rev-list --objects --all -- docs/adr`, in any `.worktrees/*/docs/adr` tree or
on any open PR — every surface stops at `0315`. This record advances the cell to
`0317`. No number outside `0300`–`0319` is touched.

## Evidence (measured, this head `e8cf60b0`)

- `git ls-remote origin 'refs/pull/272/*'` → `d5be9af4… refs/pull/272/head`,
  `300fcf35… refs/pull/272/merge`.
- `git log -1 --format='%h %ci %s' 300fcf35` →
  `300fcf35 2026-10-25 02:26:12 +0530 Merge d5be9af49bb1… into 67feedeb87b4…`.
- `gh api repos/yahodu/openpic-webapp/actions/runs/40132002880` →
  `event: pull_request`, `head_sha: d5be9af4…`, `pull_requests[0].base.sha: 67feedeb…`,
  `run_attempt: 1`.
- `gh api repos/yahodu/openpic-webapp/actions/jobs/120985491611/logs` → the `audit`
  job's checkout line: `HEAD is now at 300fcf3 Merge d5be9af4… into 67feedeb…`.
- `git show 300fcf35:pnpm-workspace.yaml | grep -c fc5q` → `0`.
- Probe (throwaway, `$BH_AGENT_WORKSPACE` scratch, deleted; `pnpm-lock.yaml`,
  `package.json` and `pnpm-workspace.yaml` taken from `300fcf35`):
  `pnpm audit --prod --audit-level=moderate` → rc `1`, `1 vulnerabilities found` /
  `Severity: 1 high`, `GHSA-fc5q-39xc-vjpf`, 9 paths.
- `gh pr view 272 --json statusCheckRollup` → `audit: SUCCESS` completed
  2026-10-24T20:56:38Z (`mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`).
- `gh pr view 670 --json` → `MERGEABLE`; `refs/pull/670/merge` = `9d2ef839` at
  20:41:42Z (the parent card measured `6da24a1d` at 20:03:42Z);
  `git show <merge>:pnpm-workspace.yaml | grep -c fc5q` → `2`; `CI` run
  `44165253363` reports `audit: success`.
- `git ls-remote origin 'refs/pull/545/*' 'refs/pull/668/*'` → a `head` ref only,
  no `merge` ref; `gh pr view 545|668 --json mergeable` → `CONFLICTING`. Both are
  now `CLOSED` unmerged (20:55:50Z / 20:52:26Z, after this measurement).
- `gh pr list --state open` at 2026-11-17T21:11:25Z → `#672` `MERGEABLE` `audit`
  `SUCCESS` 20:53:14Z, `#279` `audit` `SUCCESS` 2026-10-25T02:28:30Z, `#272`
  `audit` `SUCCESS` 2026-10-24T20:56:38Z (the latter two `CONFLICTING`).
