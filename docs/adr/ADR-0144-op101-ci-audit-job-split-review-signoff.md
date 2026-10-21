# ADR-0144 — OP-101 review sign-off: the `Dependency audit` job split is verified and merged; the masking is removed in both directions

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 CI lane-shape review (`t_a3d52d6e`, review lane; implementation lane `openpic-webapp-backend-coder`, PR [#213](https://github.com/yahodu/openpic-webapp/pull/213))
- **Relates to:** [ADR-0142](ADR-0142-op101-ci-audit-job-split.md) (the split this record signs off), [ADR-0119](ADR-0119-op101-ci-dependency-audit-review-signoff.md) (the review that routed the masking finding forward as M1), [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) (the advisories cleared before it), [ADR-0069](ADR-0069-op91-green-review-signoff.md) (the CI pipeline this job belongs to)
- **Schema:** n/a · **Contract:** n/a (CI workflow shape and docs only; no application code)

## Context

The review lane received `t_a3d52d6e` after the implementer split the
`Dependency audit` step out of the single `ci` job into its own top-level job in
`.github/workflows/ci.yml`, and recorded the decision as ADR-0142.

Round 1 used the **artifact lens** on head `8c216de`: the diff was read cold and
every handoff claim was reproduced, and the verdict was **CHANGES REQUESTED** for
a single mechanical item — `origin/main` had advanced to `4424e74` (PR #219
merged, carrying the `0140`/`0141` rows and lane notes in the same two regions of
`docs/adr/README.md`), so PR #213 was `CONFLICTING` and `gh pr merge` failed. No
other change was requested: the deliverable itself was verified good.

Round 2 used the **execution lens** on head `d6a1f45`: the rebased branch was
checked out and the deliverable was re-run rather than re-read.

## Decision

**APPROVED (LGTM).** No changes were requested in round 2 and no implementation
file was edited by the reviewer (role separation: report, do not rewrite). PR
#213 was squash-merged to `main` as `705467a` with the standard owner bypass —
`main`'s ruleset requires an approving review and the sole `gh` identity is also
the PR author, so GitHub refuses a self-approval; the squash merge preserves the
required linear history. Local `main` was fast-forwarded to `705467a`, so local
and remote `main` are in sync.

### Evidence (independently reproduced in round 2, worktree `t_a3d52d6e`)

| Claim                                    | Independent check                                                            | Result                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round-1 item resolved (no conflict)      | `git rev-list --left-right --count origin/main...HEAD`                       | `0 2` — branch not behind `main`                                                                                                                    |
| Scope unchanged                          | `git diff --stat origin/main...HEAD`                                         | exactly 3 files, **+123/-0**                                                                                                                        |
| Reviewed blobs byte-identical            | `git rev-parse HEAD:<path>`                                                  | `ci.yml` = `b16202d` ✓ · `ADR-0142-…md` = `6d80ce0` ✓ — exactly as requested                                                                        |
| README conflict resolved per instruction | `git show HEAD:docs/adr/README.md`                                           | main's `0140`/`0141` rows and trailing notes kept verbatim; OP-101 `0142` row appended in numeric order, `+3` only                                  |
| Audit gate still clears                  | `pnpm audit --audit-level=moderate`                                          | `1 vulnerabilities found — Severity: 1 high (1 ignored)` → **exit 0**                                                                               |
| Format                                   | `prettier --check` on the three touched files                                | clean                                                                                                                                               |
| Separation is real — structure           | read of `.github/workflows/ci.yml`                                           | `audit:` is its own top-level job, **no `needs:`**, no `continue-on-error`; `ci` keeps all 13 project steps minus the audit                         |
| Separation is real — run shape           | `gh run view 39451959198 --json jobs`                                        | three **independent** checks: `ci` ✓ (no `Dependency audit` step), `audit` ✓ (its own Checkout/Install/audit), `secret-scan` ✓                      |
| The two signals can differ               | head run `39415696818` (earlier, while `main` was broken by the OP-96 merge) | `audit` **success** while `ci` red on `Integration tests` — the masking is gone empirically, not just structurally                                  |
| Gate not weakened                        | diff + `pnpm-workspace.yaml`                                                 | `audit.ignore` untouched (still exactly `GHSA-vfj7-8cjw-p6xm`), overrides untouched, no step deleted, no `continue-on-error`                        |
| PR checks                                | `gh pr checks 213`                                                           | 12/12 pass incl. CodeQL; `mergeable: MERGEABLE`                                                                                                     |
| ADR-0142 numbering                       | re-derivation across `origin/main` and every local/remote ref                | `origin/main` (`851a3c1`) ended at `ADR-0141`; `0143` claimed by the OP-96 F1-GREEN renumber lane; `0142` held by this branch alone → lowest free ✓ |

Independence was verified **empirically** as well as structurally: the audit and
the project gate report as two distinct check names in the same run, and the
inverse observation (audit green, `ci` red) is on the record from the earlier
head — which is precisely the card's acceptance condition.

Honesty audit: **clean**. No fixture-shaped hardcoding, no test-environment
conditional, no `@ts-ignore`/lint suppression, no `continue-on-error`, no
`audit.ignore` addition, no new dependency, no leftover experiment, no `console`
noise. Commits follow Conventional Commits (`ci(workflow): …`, `docs(adr): …`).

## Consequences

- The audit and the project gate are two independent, blocking checks, so a red
  audit no longer masks (or is masked by) a genuine unit/integration/typecheck
  regression. `t_a3d52d6e` is complete.
- **The masking is removed in the workflow, but not yet in repo governance.**
  The split's value is fully realised only if `main`'s ruleset requires status
  checks: requiring only `ci` would silently drop the audit gate. That remains a
  human repo-settings decision, already routed as ADR-0119 L2 — no card.
- **Hotspot (Low, routed to the orchestrator):** `docs/adr/README.md` — the ADR
  table row and the trailing lane-note block collided **three times in this one
  card** (PR #219, then PR #222), each time costing a mechanical rebase and
  renumber, and sibling OP-96 lanes are renumbering on every merge. The root
  cause is that every in-flight lane appends to the same two hunks with no
  reserved range. Routed as a card to `openpic-orchestrator` to allocate
  per-lane ADR number ranges up front; not a defect in this deliverable.
- **L1 (Low, doc accuracy):** `docs/adr/ADR-0069-op91-green-review-signoff.md`
  still lists the authoritative gate as `ci.yml: …/e2e/audit`, which is now two
  jobs. Substantively unchanged (same gate set) and an accepted ADR is
  immutable — no action.

## Alternatives considered

- **Request changes again for L1 / the hotspot.** Rejected: neither is a defect
  in this deliverable, and blocking a correct, CI-green workflow change on an
  immutable historical record or on board process would hold the lane open for
  no benefit. Both are reported with a named owner instead.
- **Fix the hotspot (reserve ADR ranges) in the review lane.** Rejected:
  number allocation across lanes is an orchestration decision, and the reviewer
  works inside this card's worktree/scope; it is routed as its own card.
- **Record the sign-off only on the Kanban board, with no ADR.** Rejected: the
  lane's own convention (ADR-0081, 0084, 0091, 0093, 0095, 0099, 0101, 0104,
  0107, 0109, 0111–0115, 0117, 0119) is that a review sign-off — especially one
  with findings routed onward — gets a record so the decision survives the board.
