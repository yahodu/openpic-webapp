# ADR-0303 — The workflow-shell-safety guard and the `pr_checks.yml` env transport: contract, scope boundary and review sign-off

- **Status:** Accepted · **Date:** 2026-10-22
- **Card:** OP-101 follow-up (process/ADR) — record the workflow-shell-safety guard, the `pr_checks.yml` `env:` transport and the OP-101 F1 GREEN review sign-off (`t_734fb1a0`, orchestrator; raised by the round-1 review of `t_173447df`, OP-101 F1 GREEN, PR [#240](https://github.com/yahodu/openpic-webapp/pull/240))
- **Relates to:** [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the direct analogue — the `docs/adr/` number guard's contract and deliberate scope boundary), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the allocation policy this record draws its board-wide number from), [ADR-0142](ADR-0142-op101-ci-audit-job-split.md) / [ADR-0144](ADR-0144-op101-ci-audit-job-split-review-signoff.md) and [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) / [ADR-0119](ADR-0119-op101-ci-dependency-audit-review-signoff.md) (the OP-101 lane's comparable CI-workflow change + review-sign-off pairs)
- **Schema:** n/a · **Contract:** n/a (test-only tooling + CI workflow; no application code)
- **Implementation:** `apps/web/src/test/helpers/workflow-shell-safety.ts` · **Spec:** `apps/web/src/test/unit/workflow-shell-safety.test.ts`

## Context

`.github/workflows/pr_checks.yml` interpolated attacker-controllable PR context
**straight into the script text** of a `run:` body, at five sites:

```yaml
run: |
  BRANCH="${{ github.head_ref }}"                                   # line 16
  TITLE="${{ github.event.pull_request.title }}"                    # line 31
  ENV_CHANGED=$(git diff origin/${{ github.base_ref }}...HEAD \    # line 118
  git diff origin/${{ github.base_ref }}...HEAD -- '.env.example'   # line 129
  ${{ github.event.pull_request.body }}                            # line 133
```

GitHub expands `${{ … }}` **before** the shell runs, so the value lands inside
the command line and is re-parsed by the shell. Backticks or `$( … )` in a PR
title or branch name therefore execute on the runner, and a perfectly legitimate
title that merely _contains_ backticks fails validation. This was observed live
on PR #237: the title

```
docs(adr): OP-96 record the `Next free` reservation semantics …
```

ran `` `Next free` `` as a command substitution and failed `validate-pr-title` —
`line 1: Next: command not found` → `##[error]Process completed with exit code 127`
(run `39739073402` / job `119691641674`); it passed only after the backticks were
removed (run `39739241884`).

The remedy — hand the value over through the step `env:` map and read it as a
shell variable (`TITLE: ${{ … }}` plus `"$TITLE"` in the script) — and the guard
that pins it both landed together on `main` via PR #240 (`c44c311`):

- `.github/workflows/pr_checks.yml` — all five sites now transport their value
  through `env:` (`BRANCH`, `TITLE`, `BASE_REF`, `PR_BODY`); regexes, messages
  and exit codes are unchanged (9/9 changed lines).
- `apps/web/src/test/helpers/workflow-shell-safety.ts` + its spec
  `apps/web/src/test/unit/workflow-shell-safety.test.ts` — the mechanical guard.

The guard's contract and, more importantly, its **deliberate scope boundary**
currently live only in TSDoc and in the spec. That is thin for a rule that is
easy to "improve" in the wrong direction, and the boundary is about to be
**deliberately changed** by a follow-up card. [ADR-0302](ADR-0302-adr-number-guard-contract.md)
records the equivalent test-only guard (`apps/web/src/test/helpers/adr-numbering.ts`)
in exactly this way; this record is its analogue.

## Decision

### 1. The mechanical contract

`apps/web/src/test/helpers/workflow-shell-safety.ts` is a **scanner over
`.github/workflows/*.yml|yaml`** with two halves:

1. **The defect half — `scanWorkflowSource` / `scanWorkflowFiles` /
   `listWorkflowFiles`.** Report every `run:` body that interpolates an
   _untrusted_ `${{ … }}` context, one finding per expression
   (`{ file, line, expression, context }`). Pre-#240 this flagged **five** sites
   in `pr_checks.yml` (lines 16, 31, 118, 129, 133); after #240 it flags
   **zero**.
   - A `${{ … }}` under an `env:` key is not a `run:` body and is clean.
   - An expansion anywhere inside a `run:` body counts — including inside a
     shell comment (GitHub expands the whole value before the shell starts) and
     nested inside a function call (`${{ toJSON(github.event.x) }}`).
   - Patterns are **word-bounded**, so `github.event_name` (a safe enum) does not
     match `github.event`, and `someinputs.x` does not match `inputs.x`.
   - A commented-out YAML step is not a step.
2. **The "the fix must not be to delete the check" half —
   `inspectJobEnvTransport(source, job, variable)`.** The named job must _both_
   supply the variable through a block `env:` mapping (`suppliedByEnv`) _and_
   read it as a shell variable (`"$VAR"` / `"${VAR}"`) in one of its `run:`
   bodies (`readInShell`); `ok === readInShell && suppliedByEnv`. The scan is
   scoped to the job — an `env:` mapping or a `$VAR` reference in a _different_
   job does not count — and the _value_ of the `env:` entry is deliberately not
   asserted here (that it is a `${{ … }}` expression is pinned where it is set,
   not by this scanner).

Both invariants are asserted **twice**: once on synthetic fixtures (so the guard
is a scanner, not a snapshot of today's files) and once on the repository's real
`.github/workflows` — `scanWorkflowFiles` must return `[]`, and the
`validate-branch-name` / `validate-pr-title` jobs must report `ok: true` for
`BRANCH` / `TITLE`.

### 2. Scope boundary — the load-bearing part, **as it stands after #240**

Only _untrusted_ contexts are flagged. The enumerated set is:

```
UNTRUSTED_CONTEXTS = github.event · github.head_ref · github.base_ref · inputs.*
```

`github.ref_name`, `github.repository`, `secrets.*` and `steps.*.outputs.*` are
**deliberately excluded** — broadening the rule would drag unrelated workflows
(`new_branch_flow.yml`, the Discord notifier) into the same change.

**This boundary is the record's baseline, not a permanent exemption.** It is
scheduled to move: the sibling card `t_db64743b` extends the guard to flag
`github.ref_name` / `github.ref` (and a derived `steps.<id>.outputs.<name>`),
which will redden `.github/workflows/new_branch_flow.yml` (lines 29, 49, 63, 64)
until that workflow is fixed — `new_branch_flow.yml` triggers on branch
_creation_, so `github.ref_name` **is** the attacker-chosen branch name, and git
permits backticks and `$( … )` in a ref. Whether and when the set moves is a
**review decision**, not something the scanner decides on its own — the set is
enumerated in `UNTRUSTED_CONTEXTS` precisely so the choice is visible and
reviewable.

### 2a. Update 2026-10-22 — the boundary **moved**: the `github.ref_name` extension landed

The baseline paragraph above is a point-in-time snapshot and is left as written.
The **scheduled move happened**: the extension shipped on `main` and the
`UNTRUSTED_CONTEXTS` set no longer matches §2's description of it.

1. **The extension landed.** The TEST pin `t_db64743b` (PR [#241](https://github.com/yahodu/openpic-webapp/pull/241),
   branch tip `bf7c3aa`) and its GREEN sibling `t_c87fd29e` (PR [#245](https://github.com/yahodu/openpic-webapp/pull/245),
   **squash-merged as `86f0feea765bcd79c631c1ca3d2ab4ea198d5075`**, merged
   2026-10-22T08:08:32Z, an ancestor of `origin/main`) landed the permanent
   broadening. `UNTRUSTED_CONTEXTS` is now:

   ```
   github.event · github.head_ref · github.base_ref · github.ref_name · github.ref · steps.<id>.outputs.<name> · inputs.*
   ```

   (7 patterns; note `\bgithub.ref\b` does **not** also match `github.ref_name`,
   the word boundary past `ref` being a `_`.) Only **`github.repository`** and
   **`secrets.*`** remain exempt. `t_db64743b` also repaired the four
   `new_branch_flow.yml` sites it reddened (lines 29, 49, 63, 64) by transporting
   `BRANCH` / `HEAD_REF` / `TITLE` through `env:` (a 13-line, behaviour-preserving
   change), so `scanWorkflowFiles` returns `[]` on the repository's workflows
   again.

2. **The F2 finding landed in the same change.**
   `inspectJobEnvTransport` now also reports the supplying `env:` entry's
   **value** — `JobEnvTransport.envValue` and its untrusted context
   `envValueContext` — so a `TITLE: "literal"` that merely satisfies
   `suppliedByEnv` no longer passes the transport check; a caller can require
   `report.ok && report.envValueContext !== null`. `readsShellVariable` is now
   **word-bounded**, so `$TITLE_BACKUP` is not a read of `$TITLE`. (This reverses
   the corresponding bullet in **Alternatives**, which rejected asserting the
   `env:` value; F2 revisited it and the assertion now lives in the pin, not in
   the transport helper's `ok`.)

3. **Round-1 review sign-off of the pin (`t_db64743b`, PR #241):** **APPROVED**,
   artifact lens, verified on the pinned worktree at `bf7c3aa` — the real-workflow
   invariant red on exactly `new_branch_flow.yml` 29/49/63/64; full unit project
   `1 failed | 1548 passed (1549)` (the one failure being that expected real-workflow
   red at the pin); the F2 neutering reproduced adversarially (a literal `env:`
   value makes `envValueContext` `null` and the pin red); `prettier` clean;
   `eslint` `0 errors` with **no new warning** (helper 8→8, spec 2→2); diff limited
   to the two contract files. Review comment:
   https://github.com/yahodu/openpic-webapp/pull/241#issuecomment-6335788609

4. **Round-1 review sign-off of the GREEN (`t_c87fd29e`, PR #245):** **APPROVED**,
   zero changes requested, zero reviewer edits to the deliverable —
   `git merge-base --is-ancestor 86f0fee origin/main` holds and the branch tip
   tree equals the merge tree (`git diff --stat 87f8631 86f0fee` empty); only
   `.github/workflows/new_branch_flow.yml` changed vs the pin head `bf7c3aa`
   (13 lines, pure `env:` transport at the four sites), both pin files
   byte-identical to `bf7c3aa`, and PR #241 closed as a draft, never merged;
   targeted `vitest run --project unit -t "the repository's real"` → 6 passed;
   full unit → 89 files / 1565 tests, 0 failed; `prettier --check` exit 0; PR #245
   CI 14/14 SUCCESS; adversarial probe — reverting site 29 to a `run:`
   interpolation is flagged (`new_branch_flow.yml` line 31, `github.ref_name`),
   a neutered `env:` literal yields `envValueContext: null`, the real file → `[]`.
   Review comment:
   https://github.com/yahodu/openpic-webapp/pull/245#issuecomment-6336042707

5. **Known, accepted coverage gap (non-blocking, routed):** the real-workflow pin
   asserts the `env:` **value** only for `pr_checks.yml`'s two jobs, so the
   F2-class neutering is not test-enforced for `new_branch_flow.yml`'s four new
   sites — the guard fails open there (a literal `env:` value passes the sweep and
   is never value-checked). The security invariant is intact; the value assertion
   for those four sites is a separate TEST follow-up (`t_0be682ca`), not part of
   this record.

`Schema: n/a · Contract: n/a (test-only tooling + CI workflow; no application code)`
still holds — this update is an append to an existing record and consumes **no
new ADR number** (no allocation from the `0300`–`0319` cell), creates no new
`ADR-0NNN-*.md` file, and leaves `docs/adr/README.md` byte-identical.

### 3. Review sign-off

The round-1 (**artifact-lens**) review of the OP-101 F1 GREEN (`t_173447df`)
returned **APPROVED**, zero changes requested, zero reviewer edits:

- **Merged:** `git merge-base --is-ancestor c44c311 origin/main` holds; local
  `main` == `origin/main` == `a695b68`; the `pr_checks.yml` blob is identical at
  branch tip, merge commit and `main`, and both guard blobs are the frozen blobs
  and present on `main`.
- **Suite green at the merged tree:** `pnpm test:unit` → 87 files / 1542 tests
  passed; the `adr-numbering` pin green; `prettier --check` exit 0; `main`'s own
  CI at `c44c311` green (run `39742646363`).
- **Defect and fix both reproduced from CI logs:** the pre-fix job
  `119691641674` shows the shell executing the backticks (exit 127); the post-fix
  job `119700623207` shows `env: TITLE` → `✅ PR title is valid`.
- **Behaviour preserved:** 9/9 changed lines are a pure transport change (no
  regex, message or exit-code change). Honesty audit clean.

### 4. Where it runs

- The guard runs under **`pnpm test:unit`**, an existing CI step in
  `.github/workflows/ci.yml`; there is no bespoke job to add or maintain.
- It lives under `apps/web/src/test/**`, which is **excluded from coverage**, so
  it cannot move the coverage thresholds.
- Nothing under `.github/` imports it; it is a scanner over repository files, not
  production code.
- It is **non-vacuous**: the "real workflows" cases fail if a workflow regresses,
  and the synthetic cases fail if the scanner's semantics drift.

## Consequences

- The **untrusted-context contract is now gated**: a workflow that interpolates
  `github.event.*`, `github.head_ref`, `github.base_ref` or `inputs.*` into a
  `run:` body reddens `pnpm test:unit` instead of silently shipping a
  shell-injection seam.
- The fix **cannot be "delete the check"**: `inspectJobEnvTransport` pins the
  `env:` transport for the two validation jobs, so removing the check to satisfy
  the scanner is itself a red.
- The scope boundary is a **recorded decision**: "why isn't `github.ref_name`
  flagged?" is answered here, and moving the boundary is an explicit follow-up
  (`t_db64743b`), not a drive-by "fix".
- `pnpm test:unit` is now a required pre-merge check for any PR that touches
  `.github/workflows/**`; a new workflow must satisfy the guard.
- The TSDoc scope-boundary prose and the enumerated `UNTRUSTED_CONTEXTS` set must
  be kept in sync — the set is the contract, the prose is the explanation.

## Alternatives

- **Broaden `UNTRUSTED_CONTEXTS` to every `${{ … }}` (or add `github.ref_name` in
  this change).** Rejected here: it drags `new_branch_flow.yml` and the Discord
  notifier workflows into a security fix that is specifically about
  PR-title/branch injection, and it couples an unrelated workflow's repair to
  this one. The extension is deliberately a **separate, reviewable** card
  (`t_db64743b`).
- **Ban `${{ … }}` inside `run:` bodies outright, or parse the workflow with a
  real YAML parser.** Rejected: a real parser is a new dependency and the repo's
  workflows use block mappings and multi-line expressions the word-bounded
  scanner handles without one; banning _all_ expressions would flag the safe,
  non-attacker-controllable contexts (`secrets.*`, `github.repository`) and force
  churn on unrelated workflows.
- **Ship the guard as a standalone script or its own CI job.** Rejected: it would
  add a job to maintain and a coverage-threshold question; running under the
  existing `pnpm test:unit` step (with the test tree excluded from coverage) is
  the same posture as the ADR-number guard ([ADR-0302](ADR-0302-adr-number-guard-contract.md)).
- **Assert the _value_ of the `env:` entry inside `inspectJobEnvTransport`.**
  Rejected here: that value is a `${{ … }}` expression pinned where it is set
  (the workflow itself and the scanner's defect half); asserting it in the
  transport check would duplicate the concern and make the transport check fail
  for the wrong reason. (The follow-up `t_db64743b` revisits this as finding F2.)
