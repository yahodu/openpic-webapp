# ADR-0900 — OP-138 TEST: the `terms_of_service` document is served from `platformSettings.legal`

- **Status:** Accepted (characterization pin; green on arrival) · **Date:** 2026-11-20
- **Card:** OP-138 TEST (Low) `t_5f600bb4` — the two findings of the round-2 (execution
  lens) review of the OP-138 RED `t_a99f5cce` (branch
  `OP-138-task-dsr-consent-policy-red`, head `a7d848b6`, draft PR
  [#769](https://github.com/yahodu/openpic-webapp/pull/769), closed as superseded by the
  GREEN's PR [#776](https://github.com/yahodu/openpic-webapp/pull/776), squash
  `91644603`). **F1** (the delivery's case count) was closed by the GREEN
  ([ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §5, commit `a6961a03`);
  **F2** — the terms document was never cross-checked against the document the platform
  settings serve — is this record.
- **Branch:** `OP-138-task-dsr-terms-pin`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_a99f5cce`; **base:** `origin/main`
  `dcb80d31` (the `1.70.0` release chore on the GREEN squash `91644603`).
- **Pins:** contract §8.2 (the public current-policy document) with
  [ADR-0898](ADR-0898-op138-data-subject-requests-red.md) §4 (the three `legal` keys)
  and §6.1/§6.2 (a consent surface names the document the settings serve).
- **Consumes:** ADR-0898 (the contract the RED fixed);
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §2 (`currentPolicies` reads
  `settings.legal`); [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11–§13
  (allocation, re-sweep, never lower a cell).
- **Consumers:** `apps/web/src/test/integration/data-subject-requests.test.ts` (its
  `SEEDED_TERMS` doc comment cites this record). No production module cites it: the
  module it measures is `@/server/compliance/policies`, whose record is ADR-0899.
- **Number allocation:** the lane block is `0898`–`0917` and the `OP-138 compliance lane`
  cell (`docs/adr/README.md:77`) read `0900`. The delivery sweep — `git fetch origin`;
  `origin/main` `dcb80d31`; all 46 `.worktrees/*/docs/adr` trees; the open PR heads #755
  (`40df0afd`), #743 (`c90ae3ba`) and #272 (`d5be9af4`), each read with `git ls-tree`;
  and `git rev-list --objects --all -- docs/adr` — resolves no `ADR-0900` object and no
  `09xx` record above `0899`, which is `origin/main`'s highest. This record consumes
  `0900`; the cell advances to `0901`. No cell is lowered and no range is re-cut.

## Context

The public policy route (`apps/web/src/server/compliance/policies.ts`, ADR-0899 §2)
answers both current documents from `platformSettings.legal`: `terms_of_service` reads
`termsPolicyVersion`, `termsPolicyUrl` and `effectiveFrom`, and `biometric_processing`
reads its own version and URL plus the same `effectiveFrom`.

The shipped `I7` pack pins the **biometric** half against the settings
(`data-subject-requests.test.ts:864-865`) but only asserts that the terms entry's
`version` is a non-empty string, its `url` matches `^https?://`, its `effectiveFrom`
parses and its `documentHash` is `sha256:<64 hex>`. A GREEN that hard-coded the terms
document (the `2026-03` triple ADR-0898 §4 lists as the default) while still adding the
three `legal` keys passed every shipped case — `I7`, and `I12`, which acknowledges
whatever version `I7` served. The settings keys existed and were read by nothing the
suite could see. That is the finding this record closes: the terms document is a
contract obligation (§8.2), so "it reads the settings" must be a measurable property,
not a code-reading exercise.

## Decision — two additive cases in the shipped `I7` describe

Appended to the existing `describe("I7 — …")` block, with no shipped case, helper,
factory or harness touched (`git diff origin/main..HEAD` is `+58/−0` in one file):

- **`I7b` — the shipped-shaped control.** With the `beforeEach` default seed, the terms
  entry's `version` / `url` / `effectiveFrom` must equal the settings singleton's own
  `legal.termsPolicyVersion` / `termsPolicyUrl` / `effectiveFrom`, read by reference so a
  default change cannot red it. It proves the route answers a real document from the
  seeded singleton — the distinctive pin below cannot pass on an empty answer.
- **`I7c` — the discriminating pin.** The case reads the shipped singleton, asserts as a
  fixture guard that its terms triple differs from `SEEDED_TERMS`
  (`tos-2099-07`, `https://openpic.in/legal/terms/2099-07`,
  `2099-07-01T00:00:00.000Z`), then replaces the singleton through the existing
  `makePlatformSettingsDocument({ legal: { ...shipped.legal, … } })` override plus
  `invalidatePlatformSettings()` and requires the served terms entry to carry **exactly**
  that triple. The biometric pair is spread from the shipped document, so the case names
  one variable (the terms triple) and the seed cannot fail the `legal` schema for a
  missing required key.

The pinned property names are the ones the GREEN shipped
(`LEGAL_SETTINGS_DEFAULTS` / `legalSchema` in
`apps/web/src/server/settings/platform-settings.ts`): `termsPolicyVersion`,
`termsPolicyUrl`, `effectiveFrom`. They match ADR-0898 §4 exactly, so **no divergence is
recorded** and no production name is renamed.

## Evidence

- **Green on arrival** at the spec commit `6ca98528`:
  `vitest run --project integration apps/web/src/test/integration/data-subject-requests.test.ts`
  answers `Tests 27 passed (27)` — the shipped 25 cases unchanged plus `I7b` and `I7c`.
- **The pin bites.** In a throwaway worktree detached at `6ca98528` (the three per-package
  `node_modules` symlinked from this worktree), the terms entry in
  `apps/web/src/server/compliance/policies.ts` was rewritten to the hard-coded `2026-03`
  triple including its `documentHash` arguments — the exact shape F2 describes. The same
  command answers `Tests 1 failed | 26 passed (27)`: **`I7c` alone**, at
  `AssertionError: expected 'tos-2026-03' to be 'tos-2099-07'`
  (`data-subject-requests.test.ts:921`), with `I7b` and every shipped case green. That is
  the point of the pair: the mutation is invisible to the control, because the control
  asserts the default document the mutation hard-codes.
- **Restoration.** `sha256sum apps/web/src/server/compliance/policies.ts` was
  `d318a2eeac77dbe8621b76267d1a819880de0e79c3e0ccfc7859554a810679f8` before the mutation
  and the same value after `git checkout --`, `git status` clean in the probe, and the
  probe worktree removed (`git worktree remove --force`).
- **Gates.** `tsc` on `apps/web` and `packages/contracts`, `eslint` 0 errors on the
  touched file, `prettier --check` clean, and the seven `adr-*` guards green (recorded in
  the card handoff with their output).

## Item A — the delivery's case count is **25**, verified and not re-edited

The mechanical re-count of `apps/web/src/test/integration/data-subject-requests.test.ts`
on `origin/main` `dcb80d31` is `grep -cE '^\s+it\('` → 15 `it()` declarations and
`grep -cE 'it\.each'` → 1 (`I8`, ten rows), and `I7` holds two cases, so the pack runs
13 + 2 + 10 = **25** cases.

The GREEN corrected every mention in the squash `91644603`, so this record edits none of
them and cites what it verified on that squash:

1. `docs/adr/ADR-0898-op138-data-subject-requests-red.md` §5: line 173 reads
   "(25 cases from 15 `it()` declarations …)" and line 191 ends the inventory at "= 25";
2. `docs/adr/README.md`: the `0898` index row reads "an integration spec (25 cases from 15
   `it()` declarations, `I8` a ten-row `it.each`)", and the lane note reads "25 cases";
3. the GREEN's PR #776 body states in its "Documentation correction" section that both
   mentions and the README lane note now say 25, and it carries no stale 24.

The correction commit is `a6961a03` (`docs(adr): OP-138 record the GREEN and correct the
RED case count to 25`), inside the squash. **Consequence of this card for the next
count:** the spec now runs **27** cases (17 `it()` declarations plus the ten-row
`it.each`), because `I7b` and `I7c` were appended — stated here so the figure does not
drift the way 24 did.

## Consequences and known limits

- The pin cross-checks `version`, `url` and `effectiveFrom` only. `documentHash` is
  pinned by shape in `I7` and by agreement with the acknowledgement route in `I6`/`I12`;
  a route that read the triple from settings and derived the digest from something else
  would not be caught here. Accepted, because ADR-0899 §2 makes one helper
  (`policyDocumentHash`) produce both from the same two values.
- The seed re-reads the shipped singleton and spreads its `legal` block, so a change to
  the biometric defaults cannot break this case; the case's own fixture guard fails
  loudly if the shipped terms triple ever equals `SEEDED_TERMS`, so the pin can never
  become non-discriminating by accident.
- Not pinned: a singleton whose terms keys are absent. The `legal` schema field-defaults
  them, so that document answers the defaults — which is exactly what `I7b` asserts.
- No production file is in the diff: tests and documentation only.

## Alternatives

1. **Extend the shipped `I7` case.** Rejected: the card forbids editing a shipped pin, and
   a strengthened shipped case would hide which half broke. An appended case keeps the
   failure message naming the terms document.
2. **Assert only `version`.** Rejected: `url` and `effectiveFrom` are independent literals
   in a hard-coded document, so a GREEN could pass with the version read from settings and
   the other two hard-coded.
3. **Seed a distinctive biometric triple instead.** Rejected: the biometric pair is
   already cross-checked by the shipped `I7`, so that would pin nothing new — the missing
   half is the terms document.
4. **Move the pin into the unit project** against `currentPolicies(settings)` directly.
   Rejected: the finding is about what the **route** serves (§8.2); a unit call would pass
   with the route bypassing the helper.

## Review — round 1

Sign-off card `t_c951736b` records the round-1 review of the pin card `t_5f600bb4` (PR
[#777](https://github.com/yahodu/openpic-webapp/pull/777)). The delivery merged by its own card's
mandate before the review ran (squash `ecf4eb71`, merged `2026-11-20T17:20:14Z`), so this is a
**post-merge verification** of the bytes the trunk carries. Every figure below is this sign-off's
own measurement at the squash `ecf4eb71`, whose blob of this record is `20f27de2`; none is
transcribed from the delivery handoff.

- **Verdict:** `APPROVED` — no changes requested — posted as the PR comment [`issuecomment-7046084507`](https://github.com/yahodu/openpic-webapp/pull/777#issuecomment-7046084507). No production change was requested, and no re-review is needed.
- **Merge proof.** Head `760b4f7d`, squash `ecf4eb71`, merged `2026-11-20T17:20:14Z`. `git diff 760b4f7d ecf4eb71` is empty, and the branch-tip tree, the squash tree and the `origin/main` tree are one object, `665902cb2428a0c4db5f458a2f33a729fefa36de`; `origin/main` and the local `main` both read `ecf4eb71`, so the reviewed bytes are the trunk bytes. I did not merge again, and I did not edit a delivered file.
- **Scope.** Three paths, `+213/−1`: the spec `+58/−0`, this record `+151/−0` (new) and the ledger `+4/−1`. The spec diff is two hunks (`@@ -837,6 +837,17 @@` and `@@ -864,6 +875,53 @@`) and carries no deletion line at all, so no shipped case, helper, factory or harness line is touched; no production file is in the diff.
- **Item A closed without a re-edit.** At the reviewed base `dcb80d31` the spec reads 15 `it()` declarations, one `it.each` (`I8`, ten rows) and `I7`'s two cases, which is the **25** the card cites; my own count on the merged tree reads 17 `it()` declarations plus the same ten rows, so the file now runs **27**. That `25` still reads correctly at `ADR-0898:173`, at `ADR-0898:191`, in the `README.md` `0898` index row, in the lane note and in PR #776's body — the GREEN's correction `a6961a03`, inside the squash `91644603`, carried every one of them — so no edit was needed and none was made.
- **Item B — green on arrival and load-bearing.** `vitest run --project integration apps/web/src/test/integration/data-subject-requests.test.ts` at the merged squash answers `Tests 27 passed (27)`. Three independent mutations in a detached probe worktree at `ecf4eb71` (three per-package `node_modules` symlinked, removed afterwards), each run from a clean tree with production restored to `sha256 d318a2eeac77dbe8621b76267d1a819880de0e79c3e0ccfc7859554a810679f8` before, between and after: **(a)** the whole `2026-03` terms triple hard-coded in `apps/web/src/server/compliance/policies.ts` → `1 failed | 26 passed (27)`, **`I7c` alone** at `:921`, `expected 'tos-2026-03' to be 'tos-2099-07'`; **(b)** `version` read from settings with `url` and `effectiveFrom` hard-coded → `1 failed | 26 passed (27)`, `I7c` alone at `:922`, `expected 'https://openpic.in/legal/terms/2026-03' to be 'https://openpic.in/legal/terms/2099-07'`; **(c)** only `effectiveFrom` hard-coded → `1 failed | 26 passed (27)`, `I7c` alone at `:923`, `expected '2026-03-01T00:00:00.000Z' to be '2099-07-01T00:00:00.000Z'`. All three assertions are therefore load-bearing, not only `version`; **`I7b`** and the shipped 25 stayed green in every run, which is the documented property of the control — it asserts the default document that a hard-coded triple reproduces, so it cannot carry the verdict alone.
- **Gates at the merged squash `ecf4eb71`.** The seven `adr-*` guards → **7 files, `248 passed (248)`**; `prettier --check` clean on the three delivered paths; `eslint` exit `0` on the spec; and PR #777's checks at head `760b4f7d` are all `pass` — `ci` (`9m3s`, includes E2E), `secret-scan`, `lint`, `test_coverage`, `unit_test`, `audit`, `audit-dev`, `env-changes`, `validate-branch-name`, `validate-pr-title`, the two `Analyze` jobs, `CodeQL` and `Assert CI evidence for the pushed head`, plus the `notify-discord` close side-effect run.
- **Info (recorded, no card).** The terms entry's `documentHash` is pinned by shape in `I7` and by cross-route agreement with the acknowledgement route in `I6`/`I12`, not against `policyDocumentHash(version, url)`; §Consequences and known limits already records that as accepted, because ADR-0899 §2 makes one helper produce both from the same two values. This review agrees and raised no card: the item is Info, not a finding.
- **Nothing retracted, no number consumed.** No decision of §Context, §Decision, §Consequences or §Alternatives is retracted or amended — this section only appends, and the reviewed blobs stand: the spec `a36c0ded` and `docs/adr/README.md` `199aab5d` at `ecf4eb71`. The sign-off mints no ADR number: `docs/adr/` holds **426** records at `ecf4eb71` with no duplicate number and its README is byte-identical to `origin/main`, so the lane's `Next free` cell stays `0901`.
