# ADR-0060 — OP-89 follow-up coverage-pins review sign-off: the partial-failure pin is RED for the right reason, with two Low references routed

- **Status:** Accepted (RED review sign-off) · **Date:** 2026-10-05
- **Card:** OP-89 `t_ffd7bc07` (coverage-pin review) · **Verifies:** ADR-0059, ADR-0049 (finding 1)
- **Branch / PR:** `OP-89-task-identity-lifecycle-hooks-followup-pins` (draft PR #170, intentionally RED)
- **Reviewed head:** `fa020aa` · **Reviewer:** `openpic-webapp-reviewer`, round 1, artifact lens
- **Numbering:** provisionally `ADR-0050`/`ADR-0051` when reviewed; renumbered to `ADR-0059`/`ADR-0060`
  at integration against `main` (PR #169 landed 0050–0058), per the orchestrator reconciliation
  card `t_93d4774b`.

## Context

The composition root routed the two Low findings of the OP-89 follow-up GREEN review
(ADR-0049) to the Test-Author card `t_ffd7bc07` (ADR-0059): pin the contact-change
fan-out on a partial failure, and correct the stale `ADR-0043` reference in the pin-file
header. This ADR records the independent review of that RED pin. It does not reship the
pin contract; it records the verdict and the routing.

## Verification performed (round 1, artifact lens)

Independently reproduced on head `fa020aa` in the task worktree
`.worktrees/t_ffd7bc07`:

- **RED for the right reason.** `identity-hooks.test.ts`: 1 failed / 30 passed; the
  failure is at the fan-out count assertion
  (`apps/web/src/test/integration/identity-hooks.test.ts:1248`):
  `expected [] to have a length of 1 but got +0`. The `auth.contact.changed` emit-dedupe
  assertion on the same spec passes (length 1), so the handler is confirmed to
  short-circuit at `emitted.id === null` _before_ the insert — the documented defect, not
  an incidental error.
- **Full integration:** 234 passed + 1 intended RED (235) — `I10` is the only failure.
- **Unit:** 1319 passed (67 files). **Playwright:** 13 passed.
- **Static:** `tsc` root/contracts/web exit 0; ESLint 0 errors (20 pre-existing
  warnings); Prettier `--check .` clean.
- **Diff discipline:** vs `origin/main@9365d9c` the test file is 97 insertions / 1
  deletion, and the single deletion is exactly the `ADR-0043 → ADR-0045` header line; the
  existing 30 specs are byte-identical and `S8` is untouched.
- **Honesty scan:** clean — no `ts-ignore` / `eslint-disable` / `skip` / `only` /
  environment-conditional or fixture-shaped additions.
- **CI (PR #170):** only `ci` and `test_coverage` fail, and both solely on the intended
  `I10` assertion. `validate-branch-name`, `validate-pr-title`, `lint`, `unit_test`,
  `CodeQL`, `secret-scan`, `env-changes` all pass.

The header now cites `ADR-0045`, which is correct against `origin/main@9365d9c`
(ADR-0045 = the OP-89 follow-up RED pins ADR).

## Disposition

- **Verdict:** APPROVED (RED pin); **no changes requested** on PR #170.
- **Not merged.** This is an intended-RED draft pin card: merging would take `main` red.
  The RED specs ship inside the gated GREEN PR (repo convention — the sibling RED draft
  PRs #160/#163/#164/#166 remain open on the same basis).
- **Defect routed to the implementing card** `t_4f3ad9e7` (`openpic-webapp-backend-coder`),
  gated on this card and continuing on this branch: make `I10` green by re-inserting /
  upserting the fan-out idempotently keyed by the deduped event id (or making emit+insert
  atomic) without regressing `I8`.

## Findings routed (Low, non-blocking)

- **ADR-reference drift (pre-existing).** The two `describe(...)` titles at
  `identity-hooks.test.ts:1037/1136` still cite `(ADR-0043 §3)`, and two production
  comments (`identity-hooks.ts:659`, `identity-lifecycle.ts:120`) also cite `ADR-0043`
  where the behaviour is recorded by the (renumbered) pins ADR. Correctly left untouched
  here (the card scoped Finding 2 to the header; the 30 specs must stay byte-identical).
  Owned by the test-docs follow-up `t_c9c415e6`; flagged on that card.
- **ADR-number collision.** This lane provisionally held `ADR-0050`, overlapping PR #169's
  landed 0050–0053; fanned into the orchestrator reconciliation card `t_93d4774b`, and
  renumbered to `ADR-0059`/`ADR-0060` at integration when the GREEN card landed.

## Consequences

- A regression that reintroduces the "dedupe short-circuits before the insert" path, or
  otherwise loses the contact-change fan-out on a partial failure, breaks `I10` loudly
  once the GREEN card lands.
- The residual `ADR-0043` reference drift and the unsettled ADR numbers are owned by
  `t_c9c415e6` and `t_93d4774b` respectively; neither blocks this pin.
