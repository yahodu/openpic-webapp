# ADR-0996 — OP-101: the README follows the public-repo layout, and a superseded CI run is cancelled

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** none — direct owner instruction on the repository, not a board card · **Branch:** `OP-101-task-readme-workflow-standards` · **Worktree:** `.worktrees/op101-readme-workflow`
- **Lane:** OP-101 follow-up (README and workflow housekeeping) · **Consumes:** `0996` — a **pool draw**, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18); the four pool-mirror cells read `0996` at this cut and each advances to `0997`
- **Spec sources:** `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml` and `.github/workflows/pr_checks.yml` at `origin/main` `6c7fc642` (2026-11-27)
- **Consumers:** none — documentation and workflow configuration; no spec imports it
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) (the guard the README now documents), [ADR-0993](ADR-0993-op101-readme-badge-pins.md) (the badge-strip pin this change must keep green)

## Context

The README already documented the product, the three planes, local setup, every
script and the test layers. Four things were missing against a public-repo layout:
a brand header above the title, one sentence that states the value rather than the
mechanism, a section that says which workflow gates a pull request, and alert
syntax where a plain paragraph carried a warning. `CONTRIBUTING.md` links into
one README heading, so every heading change also moves a caller.

The badge strip is **pinned**: [ADR-0993](ADR-0993-op101-readme-badge-pins.md) and
`apps/web/src/test/unit/readme-badges.test.ts` require the strip to live inside
the first `<div align="center">` block, every markdown image in that block to come
from `img.shields.io`, and one badge to read the live
`/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml` endpoint. Any
layout change must therefore add no image to that block and no change to the seven
URLs.

Both gating workflows start a full run on every push and keep the previous one
running: a second push during a run leaves the first run holding runners to
produce a verdict on a head nobody will merge. `pr_checks.yml` also carried a
`pr-size` job whose whole body was commented out — YAML that never ran and could
not fail.

## Decision

**D1 — a brand block and a hook line, with the pinned strip untouched.** A
plain `text` fenced ASCII wordmark opens the file; the `<div align="center">` block keeps
its title, its seven badge URLs byte-identical and its description; one blockquote
below the block states the value proposition. The strip stays the first centred
block, so the pin's extraction is unchanged.

**D2 — one emoji per H2, and every anchor that moves is moved with it.** The
GitHub slug for `## ✨ Features` is `#-features`; the table of contents and
`CONTRIBUTING.md`'s `README.md#-getting-started` link are updated in the same
change. Rejected: keeping plain headings (the layout standard asks for them) and
trailing the emoji (it moves the same anchors and reads worse).

**D3 — the replica-set warning is a `> [!IMPORTANT]` alert.** The paragraph that
carried it is unchanged in wording; only the container changes, so the reason to
read it is no longer a bold sentence.

**D4 — one new section, "CI/CD and workflows".** It names the nine workflow
files, the two that gate a pull request, the blocking `audit` / non-blocking
`audit-dev` split, and the conflict-suppression hole
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md) closes. Rejected:
a `publish.yml` (this is a private application, not an npm package), a Node
version matrix (`.nvmrc` and one lockfile define the supported runtime), a raster
topology sketch (it would sit in the centred block and break the badge-host pin,
and the README already carries a mermaid topology), trilingual READMEs (nothing
translates an internal proprietary API, and parity would be unverifiable), and an
`.openwiki/` tree (the skill that would own it is not installed on this profile).

**D5 — `concurrency` in both gating workflows.** `ci.yml` and `pr_checks.yml` key
on `${{ github.workflow }}-${{ github.ref }}`. `pr_checks.yml` always cancels the
superseded run, because it only triggers on `pull_request`; `ci.yml` cancels only
when the event is `pull_request`, because a run on `main` is the record of that
commit. The expressions sit in the workflow-level `concurrency` key, never in a
`run:` body, so the `workflow-shell-safety` guard's rule is unaffected.

**D6 — the commented-out `pr-size` job is deleted.** No test pinned it, no trigger
reached it, and a commented workflow is not a policy. A size gate that should
exist belongs in a spec, not in dead YAML.

## Evidence

Counts measured at `b97b3bd5`, the implementation commit, with the tree clean and
nothing else in flight.

```text
focused  readme-badges + workflow-shell-safety + ci-evidence-guard
         + ci-audit-dev-nongating + dependency-licenses   ->  133 passed (133) / 5 files
full     vitest run --project unit                         ->  3602 passed | 3 skipped (3605) / 203 files
typecheck / lint / prettier --check                        ->  exit 0 / 0 errors, 193 warnings / clean
badge lines, origin/main versus this head                  ->  7 and 7, sha256 bb5e89d6…a06c8
```

The badge block is proven unchanged rather than asserted: the seven
`img.shields.io` lines hash identically on `origin/main` and on this head
(`bb5e89d631a176ef…652a06c8`), and `readme-badges.test.ts` stays `4 passed (4)`.
`workflow-shell-safety.test.ts` and `ci-evidence-guard.test.ts` stay green with
the new `concurrency` keys, because the expressions sit in the workflow-level
`concurrency` field and no `run:` body gained an interpolation. No spec, factory,
fixture or production source file is touched.

## Consequences

- A new badge must still come from `img.shields.io` and the CI badge must still
  read the workflow-status endpoint; a non-shield badge inside the centred block
  reds `readme-badges.test.ts`.
- A heading rename now also has to update `README.md`'s table of contents and
  `CONTRIBUTING.md`'s one deep link; the emoji slug form (`#-getting-started`) is
  what GitHub generates.
- A push during a pull-request run cancels the older run: the history keeps a
  cancelled entry, and the merge gate reads the head SHA's newest run, not the
  history. A cancelled run is not a pass.
- Reversal: if a second consumer ever needs the per-commit `main` run record, drop
  `cancel-in-progress` from `ci.yml` and keep the `group` (the newer run then
  queues behind the older one).
- Not covered: the two workflows' step order, the seven badge URLs' liveness and
  the layout's rendering. The first is pinned by other specs, the second is a
  network fact, and the third is a reading, not a test.

## Numbering

The four-surface sweep at this cut finds the trunk's `docs/adr` ending at
`ADR-0995`; `git rev-list --objects --all -- docs/adr` holds no `ADR-0996`; no
other `docs/adr` tree under `.worktrees/*` holds one; `gh pr list --state open` is
empty; and no non-`done` card reserves `0996`. `0996` is therefore a pool draw
above the highest in-flight reservation per
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18. The four
pool-mirror cells (`board-wide / process`, `OP-129 attendee identity lane`,
`OP-136 jobs lane`, `unallocated (future lanes)`) read `0996`; the higher of
`0996` and `0996 + 1` is `0997`, so each advances to `0997` and none is lowered.
Hotspot: `docs/adr/README.md` (this record's ledger row and the four cells) —
merge as a union keeping the highest value in every cell.
