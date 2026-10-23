# ADR-0305 — CI evidence is a `CI`/`PR Checks` run on the head SHA: a PR conflicting with `main` starts no `pull_request` run

- **Status:** Accepted · **Date:** 2026-10-23
- **Card:** OP-101 follow-up (process/ADR) — record the CI-evidence rule (`t_f141ecd8`, raised by the root-cause card `t_2d14ac1f`, itself raised by the draft-PR inventory `t_b8edc166` / `t_e43b1ff0`)
- **Relates to:** [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (the same eight closed draft PRs — the population this record's category error was found on), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the board-wide `0300`–`0319` range this record draws its number from; the shared `docs/adr/README.md` ledger is the file every lane branch conflicts on), [ADR-0142](ADR-0142-op101-ci-audit-job-split.md) / [ADR-0144](ADR-0144-op101-ci-audit-job-split-review-signoff.md) (the OP-101 lane's CI-workflow changes)
- **Schema:** n/a · **Contract:** n/a (process + one CI workflow; no application code)
- **Implementation:** `.github/workflows/ci_evidence_guard.yml` · **Spec:** `apps/web/src/test/unit/ci-evidence-guard.test.ts`

## Context

The lane protocol states every RED/GREEN handoff's evidence as _"CI is red (or
green) for the right reason"_. For eight long-lived draft PRs that statement was
**unfalsifiable**: `CI` and `PR Checks` produced **no run at all** for the head,
yet the head's check rollup showed three green checks, so a reviewer reading the
rollup saw "green".

The mechanism is documented GitHub behaviour. From GitHub's
`events-that-trigger-workflows`:

> "Workflows will not run on `pull_request` activity if the pull request has a
> merge conflict. The merge conflict must be resolved first. Conversely,
> workflows with the `pull_request_target` event will run even if the pull
> request has a merge conflict."

`CI` (`.github/workflows/ci.yml`) and `PR Checks` (`.github/workflows/pr_checks.yml`)
are both triggered by `pull_request`, so a **conflicting** PR gets neither. The
only checks that remain are **CodeQL default setup** runs (`event=dynamic`,
`push`-triggered, therefore not conflict-suppressed) — three of them, all
`success`. Three green checks ⇒ the head reads green while the test suite never
ran.

This is not an edge case. Every lane branch edits `docs/adr/README.md`, the single
shared ADR ledger, so a lane branch becomes conflicting with `main` as soon as
any other lane lands an ADR — which is the _normal_ state of a long-lived lane
branch. And this repository's `main` branch ruleset
(`required_status_checks: []`) declares **no required status checks**, so nothing
downstream catches the missing run: a merge is not blocked by a check that never
started.

## Evidence

All read-only and reproducible with `gh`, re-verified 2026-10-23 against
`origin/main` `f148dc7`.

**The four affected heads.** Each has exactly one `actions/runs` entry — a CodeQL
default-setup run (`event=dynamic`) — and exactly three check-runs, all
`success`: `CodeQL`, `Analyze (actions)`, `Analyze (javascript-typescript)`. No
`CI` and no `PR Checks` run exists for any of them.

| PR  | head SHA   | branch                                              | `runs` | checks (all `success`)                                       |
| --- | ---------- | --------------------------------------------------- | ------ | ------------------------------------------------------------ |
| 215 | `97257f5a` | `OP-97-task-in-app-feed-read-state-red`             | 1      | CodeQL · Analyze (actions) · Analyze (javascript-typescript) |
| 200 | `df6f4866` | `OP-96-task-digest-retry-quiet-hours-crons-red`     | 1      | CodeQL · Analyze (actions) · Analyze (javascript-typescript) |
| 170 | `adc73690` | `OP-89-task-identity-lifecycle-hooks-followup-pins` | 1      | CodeQL · Analyze (actions) · Analyze (javascript-typescript) |
| 164 | `4a0e08e3` | `OP-90-task-get-patch-me-red`                       | 1      | CodeQL · Analyze (actions) · Analyze (javascript-typescript) |

**The contrast.** The other four closed drafts' tips _did_ run both workflows:

| PR  | head SHA   | runs on the head                                                    |
| --- | ---------- | ------------------------------------------------------------------- |
| 191 | `aa0f9b35` | `CI` (pull_request) · `PR Checks` (pull_request) · CodeQL (dynamic) |
| 185 | `81c40e49` | `CI` (pull_request) · `PR Checks` (pull_request) · CodeQL (dynamic) |
| 163 | `281f1c2d` | `CI` (pull_request) · `PR Checks` (pull_request) · CodeQL (dynamic) |
| 160 | `b1b2ac2b` | `CI` (pull_request) · `PR Checks` (pull_request) · CodeQL (dynamic) |

Those four are drafts too, so **draft status is not the cause** — and they ran
despite being red by design, which is exactly the "red for the right reason"
signal the lane protocol needs.

**Every one of the eight is CONFLICTING, and all eight conflict on
`docs/adr/README.md`.** `gh pr view <n> --json mergeable,mergeStateStatus` →
`CONFLICTING` for all eight, and
`git merge-tree --write-tree origin/main origin/<branch>` exits 1 for all eight
with `docs/adr/README.md` among the conflicting paths (OP-97 also conflicts on 5
other files, OP-96 on 6). The shared ledger is the systemic trigger.

**Timing.** For each of the eight branches, the branch's last `CI`/`PR Checks`
run is strictly **earlier** than the first `origin/main` commit whose change
conflicts with that branch's tip. The four run-less heads were committed _after_
that point, so their `opened`/`synchronize` event was suppressed; the four heads
that ran were committed _before_ it, while the PR was still mergeable.

| PR  | branch                                                     | last CI/PR Checks run             | first conflicting `main` commit | head committed       | verdict                     |
| --- | ---------------------------------------------------------- | --------------------------------- | ------------------------------- | -------------------- | --------------------------- |
| 215 | `OP-97-task-in-app-feed-read-state-red`                    | 2026-10-20T13:16:50Z (`0de60e06`) | `2c779b3a` 2026-10-20T13:52:25Z | 2026-10-22T07:10:39Z | after conflict → **no run** |
| 200 | `OP-96-task-digest-retry-quiet-hours-crons-red`            | **none, ever**                    | `b7c1f19f` 2026-10-06T00:34:29Z | 2026-10-06T01:16:06Z | after conflict → **no run** |
| 170 | `OP-89-task-identity-lifecycle-hooks-followup-pins`        | 2026-10-05T18:21:42Z (`fa020aac`) | `ba431c2c` 2026-10-05T18:33:13Z | 2026-10-05T18:37:14Z | after conflict → **no run** |
| 164 | `OP-90-task-get-patch-me-red`                              | 2026-10-05T17:43:16Z (`588b4b35`) | `6b9cd6e8` 2026-10-05T17:43:44Z | 2026-10-05T17:56:34Z | after conflict → **no run** |
| 191 | `OP-95-task-otp-delivery-through-notification-service-red` | 2026-10-05T23:31:44Z (`aa0f9b35`) | `5ec8633d` 2026-10-05T23:34:05Z | 2026-10-05T23:31:34Z | before conflict → ran       |
| 185 | `OP-93-task-channel-resolution-and-template-renderer-red`  | 2026-10-05T22:01:04Z (`81c40e49`) | `3970d763` 2026-10-05T22:11:48Z | 2026-10-05T22:00:54Z | before conflict → ran       |
| 163 | `OP-89-task-identity-lifecycle-hooks-followup-red`         | 2026-10-05T17:40:50Z (`281f1c2d`) | `6b9cd6e8` 2026-10-05T17:43:44Z | 2026-10-05T17:40:42Z | before conflict → ran       |
| 160 | `OP-89-task-identity-lifecycle-hooks-red`                  | 2026-10-05T16:52:37Z (`b1b2ac2b`) | `8b85b74a` 2026-10-05T17:26:07Z | 2026-10-05T16:52:18Z | before conflict → ran       |

**Candidates ruled out.**

- **Push actor / `GITHUB_TOKEN` suppression.** The OP-97 tip push is a repository
  PushEvent at `2026-10-22T07:11:03Z`, `actor=getwithashish`,
  `head=97257f5a`; earlier pushes by the _same_ actor to the _same_ branch did
  create runs. Not a token problem.
- **Unlinked committer email.** #164's head `4a0e08e3` is authored _and_ committed
  by `77051732+getwithashish@users.noreply.github.com` (linked) and still has no
  run. Correlation, not cause.
- **Draft status.** The four contrast PRs were drafts too and ran both workflows.
- **Path filters.** `ci.yml` is a bare `on: pull_request:` (plus
  `push: branches: [main]`); `pr_checks.yml` adds only
  `types: [opened, edited, synchronize, reopened]`. No path filtering.

## Decision

### 1. What "CI evidence" means

**CI evidence for a lane claim is a `CI` run — and a `PR Checks` run — whose
`head_sha` equals the claimed head SHA, cited by run URL.** A count of
check-rollup entries is **not** evidence.

A head whose rollup contains only CodeQL default-setup checks is **UNVERIFIED**,
not green. Because `main`'s ruleset declares no required status checks, a
missing run blocks nothing; the missing run can only be caught by looking for
the run itself.

### 2. Because the suppression is by design, the lane keeps its PR non-conflicting

The suppression cannot be turned off for `pull_request`. It is instead avoided:

- When `gh pr view <n> --json mergeable` reports `CONFLICTING`, the lane merges
  `origin/main` into the lane branch (**merge, not rebase**, so already-reviewed
  SHAs survive), resolves the conflict, and pushes — **before** any RED/GREEN
  evidence claim. The push re-triggers `CI`/`PR Checks` on the new head.
- The `docs/adr/README.md` ledger is the recurring conflict site; a lane that
  waits until its evidence claim to resolve it is claiming evidence that does not
  exist.

### 3. The enforcement arm

A new workflow, `.github/workflows/ci_evidence_guard.yml`, makes the missing
evidence visible instead of relying on a human to look for it. It is
**`on: push`** with **`branches-ignore: [main]`** — push-triggered runs are the
only trigger _proved_ to survive a conflict (the CodeQL default-setup runs) and
_proved_ to attach their check to the head SHA.

Its contract, as specified (card `t_fe3b946f`, RED → GREEN sibling `t_22f95e1f`):

1. **Triggers on `push`, ignoring `main`.**
2. **Minimal permissions** — `contents: read`, `pull-requests: read`,
   `checks: read`; no `write` permission.
3. **No `actions/checkout`** and no step that fetches or executes head-branch
   code — the job only reads the GitHub API.
4. **A conflict assertion:** the `run:` body queries the pushed head's open PRs
   (the `commits/{sha}/pulls` endpoint) and their `mergeable` state, and fails
   with an `::error::` annotation when the PR is conflicting.
5. **A belt-and-braces absence check:** when the PR _is_ mergeable, it fails if
   neither `CI` nor `PR Checks` has a run whose `head_sha` equals the pushed SHA.
6. **No untrusted `${{ … }}` interpolation in any `run:` body** — `github.sha` and
   `github.repository` are transported through the step `env:` map, per
   [ADR-0303](ADR-0303-workflow-shell-safety-guard.md)'s shell-safety contract,
   which the guard's own scanner reuses.

The contract is pinned by a test-tree scanner
(`apps/web/src/test/helpers/ci-evidence-guard.ts` + its spec), following the
[ADR-0302](ADR-0302-adr-number-guard-contract.md) /
[ADR-0303](ADR-0303-workflow-shell-safety-guard.md) idiom of scanning the real
repository file _and_ synthetic fixtures.

`pull_request_target` was considered and **rejected** as the primary trigger:
it does run on a conflicting PR, but whether its check attaches to the PR head
SHA in this repository is unproven, whereas push-triggered check attachment to
the head SHA is _proved_ here by the CodeQL default-setup runs.

### 4. Scope boundary

- The guard is **push-triggered**, and a workflow is taken from the **pushed
  ref**: branches created before the workflow lands on `main` do not run it. It
  therefore protects new pushes, not existing branches.
- It does **not** cover fork PRs (which never push to this repository).
- It does **not** replace keeping lane branches current; it only makes a missing
  run loud.

### 5. Recommendation (not implemented here)

The repository owner should consider adding `CI` and `PR Checks` as **required
status checks** in the `main` ruleset. That is the only mechanism by which a
_missing_ run — as opposed to a failing one — blocks a merge. It is a ruleset
change, not a code change, and is left to the owner.

### 6. The four affected heads stay unverified

No `CI`/`PR Checks` run ever existed for `97257f5a`, `df6f4866`, `adc73690` or
`4a0e08e3`. Their PRs (#215, #200, #170, #164) were closed as superseded by
`main` ([ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md)) and must not be
reopened to manufacture a run.

## Consequences

- A green-looking check rollup is no longer accepted as evidence; the run on the
  head SHA is. Lane handoffs cite run URLs, not rollup counts.
- A conflicting lane PR is now an explicit, actionable state (`merge origin/main`,
  resolve, re-push) rather than a silent evidence void.
- The guard fails loudly on a push whose open PR conflicts with its base, or
  whose mergeable head has no `CI`/`PR Checks` run — so the class of error that
  produced these four unverified heads is caught at push time instead of at
  review time.
- The guard adds one push-triggered workflow run per lane push; it does no
  checkout and reads only the GitHub API.
- Nothing about the _content_ of the eight stale drafts changes: the four
  affected heads remain unverified, and ADR-0304 remains the reason they are
  closed rather than merged.

## Alternatives

- **Accept the check rollup as evidence.** Rejected: on a conflicting PR the
  rollup is _exactly_ the checks that are not the test suite, and it is green.
  Accepting it is accepting a green that means "nothing ran".
- **Trigger the guard on `pull_request_target`.** Rejected as the primary
  trigger: it runs on a conflicting PR, but its check attachment to the head SHA
  is unproven here, while push-triggered attachment is proved by the CodeQL
  runs. (It is not banned outright — it remains available should push attachment
  ever prove insufficient.)
- **Require `CI`/`PR Checks` in the `main` ruleset instead of adding a workflow.**
  Strongly recommended _in addition_ (see §5), but it does not remove the need
  for the guard: a required check makes a merge wait, while the guard makes the
  reason visible on the head, and it also covers non-merge heads. Recorded as a
  recommendation because it is a ruleset change owned by the repository owner,
  not a lane deliverable.
- **Fix the push identity/token or the committer email.** Rejected: both were
  ruled out as causes (the suppressing actor pushed successfully elsewhere, and
  a linked-identity head — #164 — was suppressed too).
- **Reopen the four PRs to obtain a run.** Rejected: they are superseded by
  `main` (ADR-0304); a fresh branch, not a reopened one, is the way to
  demonstrate any fix.
