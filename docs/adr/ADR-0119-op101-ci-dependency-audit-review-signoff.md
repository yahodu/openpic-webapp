# ADR-0119 — OP-101 review sign-off: the CI dependency-audit remediation is verified; the underlying CI-lane masking is routed forward

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 CI dependency-audit review (`t_aed7d907`, review lane; implementation lane `openpic-webapp-backend-coder`, PR [#211](https://github.com/yahodu/openpic-webapp/pull/211))
- **Relates to:** [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) (the remediation this record signs off), [ADR-0069](ADR-0069-op91-green-review-signoff.md) (the CI pipeline whose audit step was red), [ADR-0109](ADR-0109-op94-followup-test-pins-review-signoff.md) (precedent for a review-sign-off record with findings routed to a follow-up card)
- **Schema:** n/a · **Contract:** n/a (dependency, lockfile and workflow review; no application code)

## Context

The review lane received `t_aed7d907` after the implementer cleared the repo-wide
`ci` red on the preferred (remediation) route: `next` `^15.1.0 → ^15.5.27` in
`apps/web/package.json`, a `handlebars@<4.7.10 → 4.7.10` override in
`pnpm-workspace.yaml`, a regenerated `pnpm-lock.yaml`, and ADR-0118. Round 1 used
the **artifact lens** — the diff was read cold before the handoff narrative, and
then every claim in the narrative was reproduced.

## Decision

**APPROVED WITH FINDINGS.** No changes were requested and no implementation file
was edited by the reviewer (role separation: report, do not rewrite). The PR was
squash-merged to `main` as `a5d2048` with the standard owner bypass — `main`'s
ruleset requires one approving review and the sole `gh` identity is also the PR
author, so GitHub refuses a self-approval; the squash merge preserves the
required linear history. Local `main` was fast-forwarded to `a5d2048`, so local
and remote `main` are in sync.

### Evidence (independently reproduced at head `a2f96a2`, worktree `t_aed7d907`)

| Claim                        | Independent check                                         | Result                                                                                        |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Audit gate clears            | `pnpm audit --audit-level=moderate`                       | `1 vulnerabilities found — Severity: 1 high (1 ignored)` → **exit 0**                         |
| `next` bump landed           | probe of the installed tree                               | `apps/web/node_modules/next` = **15.5.28**                                                    |
| `handlebars` override landed | probe of `.pnpm` store                                    | `handlebars@4.7.10` present, no `4.7.9`                                                       |
| Lockfile in sync             | CI step `Install (frozen lockfile)`                       | ✓ (no drift)                                                                                  |
| Typecheck                    | three `tsc --noEmit` projects                             | exit 0                                                                                        |
| Lint                         | `eslint .`                                                | **0 errors**, 39 pre-existing warnings                                                        |
| Format                       | `prettier --check .`                                      | clean                                                                                         |
| Unit                         | `vitest run --project unit`                               | **83 files / 1460 tests passed**                                                              |
| Integration                  | `TMPDIR=/root/tmp-mongo vitest run --project integration` | **43 files / 326 tests passed**                                                               |
| Build / E2E / Coverage       | CI run `39412767879`, job `118594342055`                  | `Build` ✓ · `E2E tests` ✓ · `Coverage thresholds` ✓ · `Dependency audit` ✓ — every step green |

The "before" state was re-confirmed on the **then-current** `main`, not only on
the older SHA the card cited: `main`@`f0b428e` push run `39411613388` had every
step green except `Dependency audit`. After the merge, `main`@`a5d2048` run
`39413906095` is fully green including `Dependency audit` — the repo-wide red is
cleared on `main` itself, which was the card's acceptance criterion.

The ADR-0118 numbering deviation from the card's literal instruction ("lowest
free against a fresh `origin/main`") was checked and accepted: `gh pr diff 203`
shows the unmerged OP-96 lane already writes `ADR-0111`–`ADR-0117`, so `0118`
was genuinely the lowest number free across `origin/main` **and** every open
ref, and the deviation is documented in ADR-0118's Numbering section.

Scope and honesty audit: the diff was exactly the five declared files; no test,
mock, fixture or factory was touched; no new `audit.ignore` entry was smuggled in
(the pre-existing `GHSA-vfj7-8cjw-p6xm` ignore is untouched); no `@ts-ignore`, no
test-environment conditional and no fixture-shaped hardcoding — no application
code changed at all, so there was nothing in scope to refactor. Commits follow
Conventional Commits.

## Consequences

- The `ci` workflow is green on `main` and on PRs again, restoring the lane's
  regression signal. `t_aed7d907` is complete.
- **M1 (Medium) is routed forward, not fixed here.** The remediation clears
  _today's_ advisories but not the _mechanism_ the card was raised about:
  `Dependency audit` remains the **last step of the single `ci` job**
  (`.github/workflows/ci.yml`), so the next advisory published against any
  dependency reddens the whole `ci` check while every project step is green —
  the exact "a genuine regression is indistinguishable from the expected audit
  failure" condition. Routed to the implementation lane as card `t_a3d52d6e`
  (child of `t_aed7d907`, worktree `t_aed7d907`), which must split the audit
  into its own blocking job and record its own ADR. It is not a defect in
  PR #211 and did not block the merge.
- **L1 (Low, human):** Dependabot PR #207 (`bump next from 15.5.26 to 15.5.27`)
  is fully superseded — this merge resolves `next@15.5.28`; close it. No card.
- **L2 (Low, human governance):** `main` requires a review but no status checks,
  which is why the lane stayed red across merges. Worth adding `ci` to the
  required checks now that it can pass. Repo-settings decision, no card.
- **L3 (Low, doc accuracy):** ADR-0118's reachability rationale for the `next`
  advisory cites self-hosted rendering/cache poisoning, but no SSG/ISR surface
  exists in the tree (`generateStaticParams|export const revalidate|force-static|unstable_cache|revalidatePath|revalidateTag`
  across `apps/web/src` returns zero matches). The bump was still the right call
  (critical-severity advisory, drop-in patch). Wording nit, no card.
- **L4 (Low, test quality):** nothing in the local suite pins the audit gate or
  the `pnpm-workspace.yaml` override. Structurally mitigated — a future install
  that drops the override changes the committed lockfile, and CI re-runs the
  audit — so no card was raised.

## Alternatives considered

- **Request changes on M1 in PR #211.** Rejected: M1 is a property of the
  existing workflow shape, not of the diff under review; blocking a correct,
  CI-green dependency fix on a workflow redesign would hold the repo-wide red
  open for no benefit. Routing it to a child card keeps the fix shipped and the
  finding owned.
- **Fix `.github/workflows/ci.yml` in the review lane.** Rejected: reviewer role
  separation — the review lane reports and routes, it does not rewrite the
  deliverable. The change also alters CI observable behaviour and belongs to the
  implementation lane with its own ADR.
- **Record the review sign-off only on the Kanban board, with no ADR.** Rejected:
  the lane's own convention (ADR-0081, 0084, 0091, 0093, 0095, 0099, 0101, 0104,
  0107, 0109, 0111–0115, 0117) is that a review sign-off — especially one with
  findings routed onward — gets a record so the decision survives the board.
- **Do nothing about L1–L4.** Rejected as a posture: all four are reported with
  a named owner even though none warrants a card, so a human can act or dismiss
  them deliberately.
