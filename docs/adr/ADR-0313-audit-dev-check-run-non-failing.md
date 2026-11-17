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

## Review sign-off (round 1, artifact lens) — 2026-11-03

**Verdict: APPROVED WITH FINDINGS** by `openpic-webapp-reviewer` (card
`t_f8e45c00`, OP-117 follow-up DEPS/CI). No Critical or High finding. **Nothing
in this record is retracted**: the §Decision stands as merged, and every finding
below is either routed to another card or recorded as accepted.

### Reviewed and reproduced (not taken from the handoff)

- **Reviewed:** PR #389 head `9b28dc4` → squash `7fc7abf` (merged
  2026-11-03T20:04:32Z); re-verified on the then-current trunk `b683c3c` and on
  the newest pushed head `6f675bc1`.
- **Merged bytes are the reviewed bytes:** the per-path diff from the reviewed
  head to the squash is empty.
- **Check-runs:** on `7fc7abf` → `audit-dev :: success` with 0 failures (the same
  on trunk `b683c3c`; `audit-dev :: success` on `6f675bc1`). `gh pr checks 389`
  is all `pass`.
- **The advisory report is preserved:** job `126172435455` (head `7fc7abf`) still
  prints the `undici` advisories in its log — `GHSA-xjj6-f33q-929c`,
  `GHSA-4w7w-5xrc-9h26` and the TLS-certificate-validation-bypass entry — so the
  ADR-0301 visibility guarantee holds.
- **Suites on the merged trunk (`b683c3c`):** `unit` project 141 files /
  2276 passed | 3 skipped; the four ADR/workflow guards (`adr-numbering`,
  `ci-evidence-guard`, `workflow-shell-safety`, `git-identity-guard`) 122 passed.
- **Scope and hygiene:** the squash touches `.github/workflows/ci.yml` (+15/−6),
  this ADR (+99) and the `docs/adr/README.md` `Next free` cell only;
  `prettier --check` is clean on the touched files and no duplicate `ADR-NNNN`
  exists.

### Findings — routed, not retracted; none is inside this record's decision

- **F1 (Medium, coverage gap) → card `t_f5588c70`** (TEST): a characterisation
  pin of the non-gating `audit-dev` job shape (job-level `continue-on-error` plus
  the step-level `|| true`), so that a future edit which re-gates or re-reddens
  the job fails a test instead of a check-run consumer.
- **F2 (Low, robustness) — recorded, accepted, no card:** `|| true` also swallows
  a genuine `pnpm`/registry failure, so a broken registry would let `audit-dev`
  conclude `success` with no advisory output. This is the accepted cost of the
  shell-level determinism chosen in §Alternatives; the blocking `audit` (`--prod`)
  job remains the real supply-chain gate.
- **F3 (Info, process) — recorded only, no card:** this record's number came from
  the `docs/adr/README.md` `Next free` cell rather than a card-body `Consumes`
  line (DoD §9 wording). No collision: `0313` was free in the `0300`–`0319`
  block and the cell advanced to `0314`.
- **F4 (Low, hygiene) — recorded, remediated in-run, no card:** the shared
  checkout arrived with staged reverse edits; the reviewer restored them
  net-zero before the docs branch was cut, so no file was left changed.
- **F5 (High, board config, outside this ADR) → card `t_8be5a785`**
  (orchestrator): repoint the OP-119–OP-140 cards off the shared main checkout.
  This is a board-configuration matter; the frozen content of this ADR is not
  affected.

### Post-review status (2026-11-03)

F1 and F5 are open follow-ups on the cards named above; F2 and F3 are recorded
here with no card; F4 was remediated during the review run. No finding retracts
the decision above.

## Test pin (follow-up card `t_f5588c70`)

This record deliberately did not consume a second number: the decision above is
unchanged, and the follow-up only locks it (this section closes finding F1 of the round-1
sign-off below). `apps/web/src/test/unit/ci-audit-dev-nongating.test.ts`
is the regression pin, in the same idiom as the repo's other two workflow guards
(`workflow-shell-safety.test.ts`, `ci-evidence-guard.test.ts`) — every invariant
is asserted on the real `.github/workflows/ci.yml` **and** on synthetic fixtures
derived from it, so the assertion is a guard rather than a snapshot of today's
file. The scanner is line-based and lives inside the spec (no exported helper:
a characterisation pin has no downstream consumer for a scanner API).

The pinned properties, and nothing else: `audit-dev` exists; it declares no
`needs:`; **no** step in it that runs `pnpm audit` can fail the job — either its
`run:` ends in a shell form that exits `0` on a non-zero audit (`|| true`,
`|| :`, `|| exit 0`, `|| echo …`) **or** the step carries `continue-on-error:
true`; the job still runs `pnpm audit --dev` (so deleting or downgrading it
cannot satisfy the pin vacuously); and the blocking `audit` job still exists as
its own job. The literal `|| true` string is deliberately **not** pinned, and
the blocking job is not asserted on beyond existence.

A **job-level** `continue-on-error: true` alone must not satisfy the pin — that
is the pre-record defect — so the negative control is derived mechanically from
the live workflow (strip the exit-`0` suffix from every line) and keeps the
job-level flag; it must report `nonGating: false`. Two further controls prove
the guard bites for invariants 1 and 3 (`needs: [ci]` injected -> reported; the
`--dev` flag removed -> `runsDevAudit: false`), and one proves the accepted
_second_ shape (suffix stripped, step-level `continue-on-error: true` added ->
`nonGating: true`).

Evidence at the head: the new spec is green on the trunk (10 passed); the full
`unit` project is **142 files · 2286 passed | 3 skipped** (the card's baseline
141 / 2276 plus this file's 10 cases); the mutation probe that reverts
`.github/workflows/ci.yml` to the pre-record line
(`run: pnpm audit --dev --audit-level=moderate`, no suffix, no step-level flag)
turns exactly this spec RED — 3 cases inside it — and no other file (`1 failed |
141 passed` files); the workflow is restored byte-identically (sha256 equal,
`git diff` empty). `tsc` is exit `0` on all three projects, `eslint` reports 0
errors (one accepted `security/detect-non-literal-fs-filename` warning, the
class the two existing guards already carry) and `prettier --check` is clean.

Scope boundary: this pin changes no workflow, no production code and no ADR
number, and `docs/adr/README.md` is left byte-identical.
