# ADR-0389 — OP-105 follow-up GREEN: the Cashfree adapter import boundary is enforced

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up GREEN (`t_b7f8adfd`) · **Branch:** `OP-105-task-vendor-boundary-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0389`
- **Relates to:** [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md) (the pins this GREEN turns green — the contract, not re-decided here), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the adapter whose Consequences recorded this boundary as out of scope), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port), [ADR-0001](ADR-0001-ports-and-adapters.md) (ports and adapters, provider neutrality), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation). The Novu seam this rule mirrors is the `no-restricted-imports` boundary documented in `eslint.config.mjs` itself.
- **Supersedes:** nothing. It **delivers** acceptance criterion 1 of the OP-105 GREEN (`t_e553b2c9`, PR [#292](https://github.com/yahodu/openpic-webapp/pull/292), head `d3b6bdc`), which round-1 (artifact-lens) review finding **F1 — Medium** recorded as not delivered.
- **Fixes:** round-1 (artifact-lens) review finding **F1 — Medium** on the merged OP-105 GREEN, via the pinned boundary of [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md).

## Context

[ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md) pins the shape
of the payments vendor seam: a first-party ESLint rule
`no-direct-vendor-adapter-import` that reports any import of a module under
`server/adapters/cashfree/**` unless the importing file is the adapter itself or
the one composition root `apps/web/src/server/payments/get-payment-provider.ts`.
This card is the GREEN: it writes the rule module, registers it, and carries the
pins unedited.

Measurements on this pins head (`52014fd`) fix the starting state:

- `apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts` was
  **RED** — `Test Files 1 failed (1)` / `Tests no tests`, `Cannot find module
'../../../../../../eslint-rules/no-direct-vendor-adapter-import.mjs'`.
- On the whole repository exactly **one** production import of the adapter
  exists — `apps/web/src/server/payments/get-payment-provider.ts:31`, the
  composition root the boundary exempts. Every other importer is a spec, a
  factory or an integration spec: `apps/web/src/test/unit/payments-*.test.ts`,
  `apps/web/src/test/integration/payments-*.test.ts`,
  `apps/web/src/test/integration/billing-checkout.test.ts`.
- A full `npx eslint . -f json` at that head is **0 errors / 105 warnings**
  (436 files) — the warning baseline the registration must not move.

## Decision

**1. The rule module.** `eslint-rules/no-direct-vendor-adapter-import.mjs`,
default-exported, carrying the same JSDoc
`@type {import("eslint").Rule.RuleModule}` annotation as
`no-direct-collection-access.mjs` (so `tsc -p apps/web/tsconfig.json` resolves it
from the spec under `allowJs`), with `meta.type: "problem"`, a `meta.docs`
description, `meta.schema: []` and
`meta.messages.noDirectVendorAdapterImport` — the exact message id every invalid
pin asserts.

It visits `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`,
`ImportExpression`, and (for a pre-`ImportExpression` parser) a `CallExpression`
whose callee is `Import`, and reports the source literal when it resolves into
the adapter. **A relative specifier is resolved against the importing file's
directory before matching** (`path.resolve(path.dirname(filename), specifier)`),
so `../adapters/cashfree/…` is caught exactly as the alias is; every other
specifier is matched as written. The adapter match is a **whole-segment** test
(`/(?:^|\/)server\/adapters\/cashfree(?:\/|$)/`), so a differently named vendored
folder (`adapters/novu/…`), a `cashfree-evil` segment, or a `cashfree` folder
outside `server/adapters/` is never flagged. The exemption is a filename test:
inside `server/adapters/cashfree/**`, or the exact file
`server/payments/get-payment-provider.ts` — the file, **not** the
`server/payments/**` folder, which the pin's sibling-module negative case
(`payments/charge.ts`) forbids.

**2. Registration.** `eslint.config.mjs` registers the rule as
`openpic/no-direct-vendor-adapter-import` with severity **`error`** in the same
flat-config object that already registers `openpic/no-direct-collection-access`
(`files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"]`), by adding it to
that object's `plugins.openpic.rules` map and its `rules` block. No
`no-restricted-imports` option is overridden, so the flat-config "a later
matching object replaces a rule's options" caveat does not apply to this change.

**3. Scope: production sources.** A separate, later flat-config object switches
the rule **`off`** for the spec/mock/e2e globs
(`**/*.test.ts`, `**/*.test.tsx`, `**/test/**`, `**/mocks/**`, `**/e2e/**`) —
the same shape the board's existing test-file object already applies to
`no-restricted-properties`. This is the one decision the pins do not pin, and it
is forced by the baseline measurement above: eight spec/factory files under
`apps/web/src/test/**` construct the adapter directly (that is what an adapter
integration suite does), and the card requires the repo-wide `pnpm run lint` to
exit `0` with no new warnings. The boundary is a **production-source** invariant
— "the caller must depend on the port, not the adapter" — and a spec is not a
caller. Keeping the switch in config (rather than teaching the rule to sniff test
paths) keeps the rule's behaviour exactly the pinned contract: the `RuleTester`
spec exercises it independently of any scope. The alternative — narrowing the
shared registration object with `ignores` — was rejected because it would also
silently narrow the pre-existing `no-direct-collection-access` scope, an
unrelated behaviour change.

**4. No production source is otherwise touched.** The port's
`PaymentProviderKey` union and `apps/web/src/server/plans/plans.values.ts` are
untouched, as [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md)
requires (the rule has no literal-string surface at all, so neither can
false-positive).

## Consequences

- Acceptance criterion 1 of the OP-105 GREEN is enforceable: an
  `import … from "@/server/adapters/cashfree/cashfree-provider"` from a route
  handler, service or job now **fails lint** (severity `error`), not a warning.
- The pins are green and unedited: `npx vitest run --project unit
apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts` →
  **`Tests 14 passed (14)`** (7 valid + 7 invalid).
- **Enforcing, proven in the real config** (a throwaway production-path probe at
  `apps/web/src/server/services/__probe_vendor_boundary.ts`, deleted before
  handoff, `git status` clean of it): with the alias specifier `eslint` reports
  `openpic/no-direct-vendor-adapter-import` at severity `2` on line 1; with the
  relative specifier `../adapters/cashfree/cashfree-provider` it reports the same
  at severity `2`; the composition root
  `apps/web/src/server/payments/get-payment-provider.ts` reports **nothing**.
- **No new warning anywhere**: `npx eslint . -f json` is **0 errors / 105
  warnings** before and after, and the per-file/rule/message key sets are
  identical (0 new warning keys) — the "no new warning" claim is a diff, not a
  count.
- The rest of the gate at this head: `pnpm typecheck` clean on all three
  projects (`tsc -p tsconfig.json`, `-p packages/contracts/tsconfig.json`,
  `-p apps/web/tsconfig.json`); full unit **110 files / 1913 passed | 3 skipped**;
  full integration **77 files / 557 passed** (`TMPDIR=/root/tmp-mongo`);
  `prettier --check` clean on the two touched files; the `adr-numbering` guard
  green.
- **Diff:** `eslint-rules/no-direct-vendor-adapter-import.mjs` (new),
  `eslint.config.mjs` (import + registration + scope block), this ADR and the
  `docs/adr/README.md` ledger row/cell. No test, mock, fixture or factory is
  edited; the [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md)
  pins and its ADR are carried byte-unchanged.
- **Unpinned edges recorded for the Test Author** (not fixed here — a GREEN may
  not write tests): a dynamic `import()` whose specifier is a **template
  literal** with no expressions (`import(\`@/server/adapters/cashfree/x\`)`) is
not reported (the rule matches a string `Literal`only, which is what the pin
exercises); and`export * from "…/cashfree/…"`is reported, but only the`export { … } from` shape is pinned.
- The boundary is path-based, so it deliberately covers **every** current and
  future module under `server/adapters/cashfree/**`, not one file name.

## Alternatives considered

- **Rely on `no-restricted-imports` patterns for the adapter path.** Rejected in
  [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md) §Alternatives
  (one glob per specifier shape, a second flat-config object for the
  composition-root exemption, and no coverage of dynamic `import()`), and the
  pins' 14 cases are written against a first-party rule.
- **Register the rule for `apps/web/src/**` with no test scope.** Rejected: the
  baseline has eight spec/factory files importing the adapter directly, so lint
  would go red — the card requires exit `0` with no new warnings, and the
  boundary is a production invariant.
- **Teach the rule to exempt spec paths by filename.** Rejected: that is a
  behaviour the pins do not pin, and a rule that knows what a test file looks
  like is the wrong place for a deployment-scope decision. The config scope keeps
  the rule equal to its contract.
- **Narrow the shared registration object with `ignores`.** Rejected: it would
  narrow `no-direct-collection-access` at the same time, an unrelated change.
- **Change the port union or `plans.values.ts` to make a literal rule viable.**
  Not done — [ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md)
  rejects the literal rule; no production source outside the rule module and the
  config is touched.

## Review sign-off — 2026-10-25 (card `t_b7f8adfd`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of this delivery — review card
`t_587805e5`, the review + merge of PR
[#310](https://github.com/yahodu/openpic-webapp/pull/310) — returned **APPROVED
WITH FINDINGS**: zero changes requested to the deliverable and **zero reviewer
edits** to the rule, the config, the pins or this record beyond the one
link-only fix to ADR-0388 noted below.

**Evidence reproduced independently at the reviewed head `30bc570`** (`3572300`
was the head before that one-commit link fix):

- The pins re-run **unedited** — the pins spec blob is unchanged —
  **14 passed (14)**.
- `eslint .` → **exit 0, 0 errors / 105 warnings**, and its warning-key set is
  **identical to the `origin/main` `1f3d39d` baseline: 58 keys vs 58 keys,
  0 added / 0 removed / 0 changed** (the one key whose path differs is the
  worktree prefix on `scripts/db/ensure-indexes.ts`); the new rule
  `openpic/no-direct-vendor-adapter-import` contributes **no** warning.
- `pnpm run typecheck` (all three projects) exit `0`; `prettier --check .` clean.
- unit **110 files / 1913 passed | 3 skipped**; integration **77 files / 557
  passed** (`TMPDIR=/root/tmp-mongo`); `adr-numbering` **29 passed (29)**.
- **Production-path probe** (a throwaway file, deleted afterwards; the tree
  returned clean): a specifier into `server/adapters/cashfree/**` is **reported**
  at severity `2` under `openpic/no-direct-vendor-adapter-import` **both** via
  the alias and via a **relative** specifier, while the composition root
  `apps/web/src/server/payments/get-payment-provider.ts` is **silent**.
- CI green (`audit-dev` is `continue-on-error` and is not a gate; `audit`
  passes).

**Findings (both Low; these record review-time state and point forward).**

- **Low — two unpinned edges of the boundary.** A dynamic `import()` whose
  specifier is a **template literal with no expressions** is **not** reported —
  the rule matches a string `Literal` only, which is what the pin exercises —
  and `export * from "…/cashfree/…"` is reported, but only the
  `export { … } from` shape is pinned. The no-expression template-literal edge
  is being **pinned** by the follow-up RED/GREEN pair — RED card `t_a2fde084`
  (assignee `testcase-writer`) and GREEN card `t_dfe5970e` (assignee
  `backend-coder`), same lane branch — so it is **not yet closed** at this head.
- **Low — the `off` switch uses repo-wide globs** (`**/test/**`, `**/e2e/**`,
  …) rather than `apps/web/**`-scoped ones. No functional hole today (the
  registration is `apps/web/src/**`-scoped), noted for the day the rule is
  registered repo-wide.

**Known item, landed inside the PR.** ADR-0388 linked the non-existent
`ADR-0001-ports-and-adapters-provider-neutrality.md`; it was fixed in-PR at
`30bc570` (link-only, one line) so the record lands correct, with an inline line
comment on the PR. No pinned decision and no test, mock, fixture or factory was
touched.

**Merge and number.** The delivery shipped as PR
[#310](https://github.com/yahodu/openpic-webapp/pull/310), **squash-merged as
`dd9a027`** (an ancestor of `origin/main`), carrying both the pins (TEST card
`t_d3a8bf6f`, whose own draft PR
[#306](https://github.com/yahodu/openpic-webapp/pull/306) was **closed
unmerged**) and the enforcement (GREEN card `t_b7f8adfd`). **No ADR number is
asserted here for anything unmerged:** the draft pins PR #306 never merged and
carries **no** ADR number of its own — the pins' record is
[ADR-0388](ADR-0388-op105-vendor-adapter-import-boundary-pin.md), which landed
only inside #310.

## Review sign-off — 2026-10-25 (card `t_dfe5970e`, round 1 · artifact lens)

The round-1 (**artifact-lens**) review of the follow-up GREEN — implementation
card `t_dfe5970e`, and the review + merge of PR
[#326](https://github.com/yahodu/openpic-webapp/pull/326) — returned
**APPROVED**. Zero changes were requested to the deliverable and **zero reviewer
edits** were made to the rule, the pins or this record: the delivery is the
Implementer's, carried byte-unchanged.

**Head chain.** Reviewed head `1caa2f2` (`feat(lint): OP-105 report
no-expression template-literal vendor imports`) → merged-trunk head `a4efdd4`
(the merge that brought `origin/main` into the lane branch) → squash on
`main` **`79a2f66`** (`PR #326`). `79a2f66` is an ancestor of `origin/main`; it
is the state every later record should read.

**Evidence reproduced independently, not taken on trust.**

- **The pins are green at all three heads**, unedited: the target spec
  `apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts` under
  `--project unit` → **`Tests 19 passed (19)`** at `1caa2f2`, at `a4efdd4` and
  on the squash tree (14 pre-existing cases + 5 from the RED card, `+65/−0`,
  and no existing case altered). Re-run on this sign-off's own branch, off the
  current trunk, for **19 passed (19)**.
- **An independent ESLint `Linter` probe of the shipped module** (not the
  suite's `RuleTester`), through a flat-config object registering
  `openpic/no-direct-vendor-adapter-import` at severity `error`: the static alias
  literal, the relative form resolved against the importing file
  (`../adapters/cashfree/…` from `server/services/`, and `../../adapters/cashfree/…`
  from `server/jobs/`) and the **no-expression template literal** inside
  `import()` are all reported at severity `2`; an **interpolated** template is
  silent; the neutral port, a `cashfree-evil` segment, the unrelated
  `adapters/novu/…` folder, the exempt composition root
  `server/payments/get-payment-provider.ts` and the adapter itself are all
  silent. `export * from "…/cashfree/…"` is still reported (regression shape).
- `tsc -p apps/web/tsconfig.json --noEmit` → **exit `0`** (the rule module keeps
  its `@type {import("eslint").Rule.RuleModule}` annotation, so the spec's import
  resolves under `allowJs`).
- `prettier --check` clean on both changed files; `eslint .` → **0 errors / 105
  pre-existing warnings** (the warning baseline did not move); the
  `adr-numbering` guard → **29 passed (29)**.
- **CI on `a4efdd4`**: `ci`, `lint`, `unit_test`, `test_coverage`,
  `env-changes`, `validate-branch-name`, `validate-pr-title`, `audit`,
  `secret-scan` and `CodeQL` all **pass**. `audit-dev` **fails** but is
  `continue-on-error: true` (ADR-0301), so it is non-gating — a red `audit-dev`
  alone is not a red PR.
- **Branch diff.** The GREEN commit `1caa2f2` touches **exactly**
  `eslint-rules/no-direct-vendor-adapter-import.mjs` (`+34/−6`); the lane branch
  above it, `a896a69..1caa2f2`, adds only the RED card's pins
  (`apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts`,
  `+65/−0`) — no `docs/` file, no config, and no test edited by the GREEN. The
  squash `79a2f66` carries **exactly** those same two shapes (`+34/−6` and
  `+65/−0`): rule change and pins landed together, and no test was edited to fit
  the implementation.

**Closure of the recorded unpinned edge.** The §Consequences paragraph
_"Unpinned edges recorded for the Test Author"_ is **CLOSED for the
template-literal edge**: a no-expression `TemplateLiteral` whose single cooked
string resolves into `server/adapters/cashfree/**` is now reported by the rule
and **pinned** by the suite, while an interpolated template stays silent (an
unresolvable specifier is not reported — deliberate, and itself pinned). The
`export * from "…/cashfree/…"` shape, which the earlier sign-off recorded as
reported but unpinned, is **now pinned as well**. The historical §Consequences
text and the `t_b7f8adfd` sign-off above are **not retracted**: they are the
record of the state at that head, and this section is the later record of the
same boundary. The CommonJS `require(…)` edge remains **out of scope**:
`apps/web/src` is ESM-only, so it needs its own `no-restricted-require` shape
rather than an extension of this rule.

**Info-only observations (recorded, no follow-up card).**

- `eslint-rules/**` sits outside the vitest coverage `include` set, so the
  `!sourceNode` early return and the non-string `cooked` arm are unexercised.
  Both are unreachable in practice, proven by probe rather than assumed:
  `import()` with **zero** arguments and an untagged template literal with an
  invalid escape are `SyntaxError`s in the parser, so neither node shape can
  reach the rule. No action.
- Pre-existing, unchanged by this delivery: the flat config ignores
  `eslint-rules/**`, so `eslint .` does not lint the rule module itself. Noted
  for whoever next touches the rule; it is not a hole in the boundary it
  enforces (the pins and the probe above exercise it directly).

**Merge.** Shipped as PR
[#326](https://github.com/yahodu/openpic-webapp/pull/326), **squash-merged as
`79a2f66`**. No ADR number is consumed by this sign-off: it appends to `0389`
and leaves every other record untouched.
