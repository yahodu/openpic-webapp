# ADR-0242 — OP-99 RED review sign-off: the one-click unsubscribe pins verified RED; the gitleaks scope closed and the follow-up pins routed

- **Status:** Accepted · **Date:** 2026-10-23 · **Author:** `openpic-webapp-reviewer`
- **Card:** OP-99 RED (`t_28ab0e00`), review rounds 1–2 · **Verdict:** round 1 (artifact lens) **changes requested** — one in-lane item, F6 — then round 2 (execution lens) **APPROVED**, Low/Info findings only; **zero reviewer edits to the deliverable**
- **Reviewed:** branch `OP-99-task-one-click-unsubscribe`, head `0a56f32`; PR [#253](https://github.com/yahodu/openpic-webapp/pull/253) — a **draft, deliberately held open** at review time (see §5)
- **Reviewed by:** round 1, **artifact lens** (diff read cold); round 2, **execution lens** (every handoff claim independently reproduced)
- **Number:** drawn from the OP-99 lane's reserved range `0240`–`0259` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), `docs/adr/README.md` § "ADR number allocation"). `0240` is consumed by [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) (the RED contract) and `0241` by [ADR-0241](ADR-0241-op99-one-click-unsubscribe-green.md) (the GREEN implementation) — both count as taken under ADR-0300 §7 — so this sign-off takes `0242`; the lane's `Next free` cell in `docs/adr/README.md` read `0242` on a fresh `origin/main` immediately before this commit and advances to `0243`.
- **Relates to:** [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) (the RED contract of record), [ADR-0241](ADR-0241-op99-one-click-unsubscribe-green.md) (the GREEN the lane produced), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the per-lane range policy), [ADR-0091](ADR-0091-op94-fan-out-red-review-signoff.md) (the sibling RED sign-off posture), PR [#253](https://github.com/yahodu/openpic-webapp/pull/253) review comment [`#issuecomment-6337865455`](https://github.com/yahodu/openpic-webapp/pull/253#issuecomment-6337865455)
- **Touches:** `docs/adr/ADR-0242-op99-red-review-signoff.md` (this file) and the `docs/adr/README.md` ledger (the OP-99 lane row cell and one paragraph) — **docs only**

## Context

This ADR records only the **review** of the OP-99 RED. The contract the RED
pins is recorded in ADR-0240; nothing here restates or contradicts it. The
sections below are the delta a sign-off adds: what was independently
reproduced, what the verdict pins, and where each finding went.

The RED delivers **specification files only** — two vitest specs (the unit
token/reducer pins U1–U4 and the integration contract pins I1–I3), one Playwright
spec (E1), the e2e token-minting fixture and its two config edits, ADR-0240 and
the README ledger — with **no production code**. The module under test and the
route pair do not exist yet, so the specs are red for the right reason. This
review therefore looked at a tree whose suite the handoff reported as honestly
red, and re-derived that claim from scratch at the reviewed head.

## Decision

### 1. Reviewed scope and evidence — reproduced, not taken from the handoff

Every number below was re-run by the reviewer at the reviewed head `0a56f32`,
in the lane worktree, not read off the handoff:

| Check (at `0a56f32`)                                                               | Result                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `vitest run --project unit`                                                        | **1 failed \| 90 passed (91) files · 1605 passed (1605)**                         |
| `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`)                      | **1 failed \| 63 passed (64) files · 430 passed (430)**                           |
| `prettier --check .`                                                               | clean                                                                             |
| `eslint .`                                                                         | **0 errors / 3 `security/detect-object-injection` warnings** (pre-existing class) |
| ADR guard `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts` | **29 / 29 passed**                                                                |
| `git diff 1387d79..0a56f32 -- <the six contract files>`                            | **empty** — byte-identical to the RED commit                                      |

The single failing **file** in each suite is the delivered RED spec, and the
failure is `module-not-found` — the honest RED:

- unit: `@/server/notifications/unsubscribe` (the token/reducer module ADR-0240
  contracts);
- integration: `@/app/api/v1/notifications/unsubscribe/[token]/route` (the
  public preview/apply route pair).

`git diff 1387d79..0a56f32` is **empty** for all six contract files the review
froze — `apps/web/src/server/notifications/unsubscribe.test.ts`,
`apps/web/src/test/integration/notification-unsubscribe.test.ts`,
`apps/web/e2e/notification-unsubscribe.spec.ts`,
`apps/web/e2e/start-server.mjs`, `apps/web/playwright.config.ts` and
`docs/adr/README.md` — so the rework of round 1 touched no frozen contract and
**no production file**. No `.skip`, no test-environment conditional and no
fixture-shaped hardcoding was found in the delivered specs.

### 2. Verdict: round 1 changes requested → round 2 APPROVED

Round 1 (artifact lens) requested changes on exactly **one** in-lane item, F6:
the `secret-scan` gate was red because the committed e2e token fixture tripped
gitleaks. Round 2 (execution lens) verified the correction and approved: the
contract is unambiguous, the RED reason reproduces, and the remaining
observations are Low/Info only. **No reviewer edit landed in the deliverable**;
the reviewer's only touched file was `docs/adr/README.md`, and only to resolve
the `origin/main` merge in this lane's favour.

Review record: the PR body comment
[`#issuecomment-6337865455`](https://github.com/yahodu/openpic-webapp/pull/253#issuecomment-6337865455)
(the sole `gh` identity, `getwithashish`, authored PR #253, so a formal GitHub
approval is not possible — the sign-off is recorded as a PR comment, matching
the posture of every prior OP-9x review in this board).

### 3. F6 — the gitleaks `secret-scan`: closed, reproduced with a negative control

The fixture mints its signing secret at runtime, but the fixture file also
carried a literal that tripped the `generic-api-key` rule. The fix scopes the
`.gitleaks.toml` allowlist to the **exact** literal with `regexTarget = secret`.
The closure was re-derived independently, and — importantly — with a **negative
control** that proves the allowlist is not over-broad:

```
# with the branch config — the shipping posture
$ docker run --rm -v "$PWD":/repo zricethezav/gitleaks:latest \
    detect --config .gitleaks.toml --log-opts="origin/main..0a56f32"
4 commits scanned.
no leaks found

# negative control: the same range with the allowlist entry REMOVED (scratch config, not committed)
$ … detect --config <scratch .gitleaks.toml> --log-opts="origin/main..0a56f32"
1 leak: generic-api-key  apps/web/e2e/unsubscribe-token.ts:22  commit 1387d79  (entropy 4.28)
```

So removing the allowlist reddens the scan on exactly the historical fixture
literal, and the reviewed head tree carries only the runtime-derived secret. The
allowlist is precisely scoped; F6 is **closed**.

### 4. Findings routed to follow-up cards

All routed findings are Low/Info; none blocked the merge of the lane.

| #    | Severity | Finding                                                                                                                                                                | Routed to                                                                                                        |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F1   | High     | The GREEN card's token-rejection wording (`404 not_found`) disagreed with ADR-0240 / the RED pins (`400 bad_request` invalid/tampered/absent, `410 gone` expired).     | **`t_b8ee4846`** (orchestrator reconcile — gated the GREEN; landed)                                              |
| F3   | Medium   | Three GREEN scope items were pinned by no RED test (`buildUnsubscribeLink` / `List-Unsubscribe` headers, the resolver suppression lookup, the `20/min/IP` rate limit). | **`t_b8ee4846`** (all three narrowed out of the GREEN; each deferred by ADR-0240 or out of OP-99 contract scope) |
| F2   | Medium   | The **locked non-transactional** `422 opt_out_not_allowed` path and its `details.reason` were untested (only the transactional case was).                              | **`t_af207345`** (TEST pins; appended to the lane branch)                                                        |
| F4   | Low      | The **cookie-less** public `POST` through the real middleware was unpinned (integration calls the handler directly).                                                   | **`t_af207345`** (Playwright pin; appended to the lane branch)                                                   |
| R2-1 | Low      | A cosmetic merge-commit title (`… into op99-build`) from a scratch branch used to build the rework; tree-only, vanishes in the squash-merge.                           | no action (cosmetic)                                                                                             |
| R2-2 | Info     | The reconcile card `t_b8ee4846`'s comment named the F2/F4 follow-up as `t_9d4e7c02`, which does not exist; the real card is `t_af207345`.                              | prose corrected by a comment on `t_b8ee4846`                                                                     |

F1/F3 were settled by the orchestrator reconcile card `t_b8ee4846`, which kept
the approved RED's `400`/`410` codes and narrowed all three unpinned scope items
out of the GREEN (TDD forbids untested code); **no ADR-0240 edit was needed**.
F2/F4 were closed by the TEST card `t_af207345`.

### 5. Posture and the lane's outcome — the RED PR was held open, then landed inside the GREEN PR

At sign-off the RED branch/PR **stayed open** (draft) for the GREEN
(`t_3bb9a1a3`), which inherits the same branch: a RED-by-design PR cannot be
squash-merged, because the red specs would redden the trunk's `unit_test` and
`test_coverage` jobs. The pins therefore ship inside the gated GREEN PR, the
established posture of the sibling RED lanes ([ADR-0091](ADR-0091-op94-fan-out-red-review-signoff.md),
ADR-0086).

The lane then completed on that same branch, and this record is written after
the fact on the landed trunk:

- **F1/F3** settled by `t_b8ee4846` (no ADR edit); **F2/F4** pinned by
  `t_af207345` (commits `4026979`, `d8df729`).
- The **one disputed RED assertion** left red and unedited
  (`notification-unsubscribe.test.ts:307`, line 330 after the F2/F4 pins, which
  asserted `toEqual({ effective, source })` against a settings response that
  contract §7.4 requires to carry `optOutAllowed`) was **confirmed by the human
  on 2026-10-23** as the defect, not the implementation, and corrected by the
  TEST card `t_8676455d` (commit `b955446`; recorded in ADR-0241 § "The disputed
  assertion"). No production change followed.
- PR [#253](https://github.com/yahodu/openpic-webapp/pull/253) was
  **squash-merged to `main` as `0f872dc`** at `2026-10-23T04:49:45Z`
  (head `b955446`) — `git merge-base --is-ancestor 0f872dc origin/main` **true**
  — with all 13 required checks green.

## Consequences

- OP-99 phase 1 is **closed**: the one-click unsubscribe contract, its
  implementation and the follow-up pins are verified, landed and recorded.
  ADR-0240 stays authoritative for behaviour; ADR-0241 records the
  implementation; this ADR records the acceptance of the RED.
- Number `0242` is consumed by this sign-off; the OP-99 lane's `Next free` cell
  in `docs/adr/README.md` advances to `0243`. No number outside the lane's
  `0240`–`0259` range is touched.
- This is a **docs-only** record: no production, test, fixture or configuration
  file is touched, so no suite's observable behaviour changes.
- The findings are routed, not buried: F1/F3 → `t_b8ee4846` (landed); F2/F4 →
  `t_af207345` (landed); the disputed assertion → `t_8676455d` (landed). R2-1
  needs no card; R2-2's prose was corrected in place.
- The `docs/adr/README.md` edit is the OP-99 lane row cell (`0242` → `0243`)
  plus one inserted paragraph. That file is a cross-lane hotspot; the paragraph
  is appended in the established sign-off style and no other lane's cell is
  touched.

## Alternatives considered

- **Record this sign-off as a section inside ADR-0240.** Rejected: ADR-0240 is
  the _contract_ and shipped with the RED; the acceptance of the reviewed head is
  a distinct artifact, and every prior sign-off in this lane family (ADR-0091,
  0097, 0107, 0181, 0222) is recorded as its own file.
- **Merge PR #253 at sign-off.** Rejected: a RED-by-design PR carries red specs;
  squash-merging it would put a red suite on `main`. The pins ship inside the
  gated GREEN PR, which is what in fact happened.
- **Request changes on PR #253 for F2/F4.** Rejected: both are _coverage_ gaps,
  not contract defects, and test additions belong to the Test Author — they were
  routed to `t_af207345` rather than blocking a verified RED contract.
- **Leave the findings as PR comments only.** Rejected: the repo's operating
  rules require every review finding to be routed to a card; F1/F3 went to
  `t_b8ee4846` and F2/F4 to `t_af207345`, both of which landed.
