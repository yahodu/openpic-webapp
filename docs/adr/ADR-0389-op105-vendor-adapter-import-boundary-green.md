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

## Review sign-off

_Pending. The pins and this GREEN ship in one PR from
`OP-105-task-vendor-boundary-green`; the review of this delivery is the review of
that PR._
