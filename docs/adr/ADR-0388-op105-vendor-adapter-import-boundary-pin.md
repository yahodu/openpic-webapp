# ADR-0388 — OP-105 follow-up TEST: the Cashfree adapter import boundary is lint-enforced (F1)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_d3a8bf6f`) · **Branch:** `OP-105-task-vendor-boundary-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e553b2c9`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0388`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port + adapter contract), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the GREEN implementation, whose Consequences record this boundary as out of scope), [ADR-0001](ADR-0001-ports-and-adapters-provider-neutrality.md) (ports and adapters, provider neutrality), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It **completes** acceptance criterion 1 of the OP-105 GREEN card (`t_e553b2c9`, PR [#292](https://github.com/yahodu/openpic-webapp/pull/292), head `d3b6bdc`), which the round-1 (artifact-lens) review recorded as **not delivered**.
- **Fixes:** round-1 (artifact-lens) review finding **F1 — Medium** on the merged OP-105 GREEN card.

## Context

The OP-105 card's acceptance criterion 1 is "**No Cashfree identifiers outside the
adapter (lint boundary)**". The first half held — the GREEN added no vendor
identifier outside `apps/web/src/server/adapters/cashfree/**` — but the second
half did not: `eslint.config.mjs` carries a `no-restricted-imports` boundary for
the Novu SDK and a first-party `no-direct-collection-access` rule for the
repository seam, and **nothing** for the payments/vendor seam. ADR-0381's
Consequences and ADR-0380's "Out of scope" list both recorded the boundary as
not built. A future caller could therefore `import` the vendor adapter anywhere
and stay green.

A **literal-level** rule (`"cashfree"` may not appear outside the adapter) was
the card's other candidate, and it is the wrong lever here:

- `docs/API Contract.md` §11.1 **requires** every `ProviderRef` / normalized
  event to carry a provider key, so the port's
  `export type PaymentProviderKey = "cashfree" | "memory";`
  (`payment-provider.ts`) is legitimate and must stay — the union is exactly the
  vendor-neutral vocabulary the lane wants at that seam.
- `apps/web/src/server/plans/plans.values.ts` already holds
  `provider: "cashfree"` on `main` (pre-existing, outside this lane's authorship,
  and no other lane owns it), and the port's own TSDoc names the vendor to
  explain what it abstracts.

A literal rule would either false-positive on both or need a growing allowlist
of legitimate sites, and it would still miss the realistic leak shapes:
importing the adapter is what lets vendor wire knowledge (field names, status
strings, signature scheme) cross the seam. The **import boundary** is the
enforceable seam, and it mirrors the two precedents already on `main` — the Novu
SDK boundary (`no-restricted-imports` patterns in `eslint.config.mjs`) and the
repository boundary (`openpic/no-direct-collection-access`, a first-party rule
with a `RuleTester` spec under `apps/web/src/test/unit/eslint/`).

## Decision

The payments vendor seam is enforced by a first-party ESLint rule,
**`no-direct-vendor-adapter-import`**, whose unit contract is pinned by
`apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts` (a
`RuleTester` spec, same shape as `no-direct-collection-access.test.ts`).

**Boundary.** The rule reports any import of a module under
`server/adapters/cashfree/**` — `import … from`, `export … from`, and dynamic
`import()` — unless the importing file is one of exactly two exemptions:

1. **inside the adapter itself** — `apps/web/src/server/adapters/cashfree/**`;
2. **the payment composition root** —
   `apps/web/src/server/payments/get-payment-provider.ts`, the one deliberate
   seam that selects a concrete `PaymentProvider`, exempt exactly as
   `apps/web/src/server/adapters/message-transport-provider.ts` is for Novu
   (ADR-0105).

Everywhere else — route handlers, services, jobs, sibling modules under
`server/payments/**` — a caller must depend on the neutral port
(`@/server/payments/payment-provider`) or on the composition root. The rule must
not be fooled by a relative specifier (`../adapters/cashfree/…`) or by a dynamic
`import()`; both are pinned.

**Module contract the implementation owes** (the GREEN sibling `t_b7f8adfd`):

- `eslint-rules/no-direct-vendor-adapter-import.mjs`, default export, carrying
  the same JSDoc `@type {import("eslint").Rule.RuleModule}` annotation as
  `no-direct-collection-access.mjs` so `tsc` resolves it from the spec;
- `meta.messages.noDirectVendorAdapterImport` — the pinned message id the spec
  asserts;
- `meta.schema: []`;
- registration in `eslint.config.mjs` as
  `openpic/no-direct-vendor-adapter-import` scoped to `apps/web/src/**`, as
  `no-direct-collection-access` is registered. **Registration is the GREEN's
  job**; this card's diff adds no `eslint.config.mjs` entry.

**Why not a literal rule.** Rejected as above: §11.1 mandates the provider key
union, and `plans.values.ts` is pre-existing off-lane config. A literal ban would
have to exempt both by name, and would still not stop the adapter import.

**Why a first-party rule rather than more `no-restricted-imports` patterns.**
`no-restricted-imports` matches package specifiers, not "the vendor adapter
directory" — an alias (`@/server/adapters/cashfree/…`) and a relative
(`../adapters/cashfree/…`) specifier would each need its own glob, the
composition-root exemption would have to be a second flat-config object, and
dynamic `import()` is outside the rule's surface. The existing
`no-restricted-imports` boundary for the vendor **SDK package** stays as it is
(Novu) and would be the mechanism if Cashfree ever ships an SDK package; for a
path-based seam the first-party rule is the honest shape, and it matches the
`no-direct-collection-access` precedent the card names.

## Consequences

- Acceptance criterion 1 of the OP-105 GREEN is now enforceable: an
  `import … from "@/server/adapters/cashfree/cashfree-provider"` from a route
  handler, service or job fails lint, so vendor wire knowledge cannot cross the
  seam unnoticed.
- The port's `PaymentProviderKey` union and `plans.values.ts` are **not**
  touched and remain false-positive-free by construction (the rule has no
  literal-string surface at all).
- The composition-root exemption is pinned by a **negative** case: a sibling
  module under `server/payments/**` (`charge.ts`) that imports the adapter **is**
  reported, so the exemption is the exact file and not the whole folder. That is
  what keeps the seam narrow enough to be real.
- **No production file is touched by this card.** The diff is the new spec file,
  this ADR and the `docs/adr/README.md` ledger cells. `eslint.config.mjs` and
  `apps/web/src/server/**` are untouched; `plans.values.ts` and the port are
  untouched. The rule file simply does not exist yet, which is the RED.
- The pins are **RED** against the current trunk. Exact command and failure:
  - `npx vitest run --project unit apps/web/src/test/unit/eslint/no-direct-vendor-adapter-import.test.ts`
  - `Test Files 1 failed (1)` / `Tests no tests` —
    `Error: Cannot find module '../../../../../../eslint-rules/no-direct-vendor-adapter-import.mjs'`.
- **Load-bearing, proven by a throwaway candidate rule** (written at the exact
  intended path, run, then deleted; `git status` clean of it at handoff):
  - **Candidate rule present** → `Test Files 1 passed (1)` / `Tests 14 passed (14)`,
    and `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0`. The pins are
    satisfiable and the contract is type-correct.
  - **Candidate rule removed** (handoff state) → the module-not-found RED above.
  - The 14 pins are 7 valid (adapter self-import by relative path and by alias; a
    port-only import from a service; a composition-root import from a service and
    from a route handler; the composition root naming the adapter; a differently
    named vendored folder) and 7 invalid (alias import from a route handler and
    from a service; the sibling `payments/charge.ts` non-exemption; an
    `export … from` re-export; a relative-path import; a dynamic `import()`; a
    job import), each asserting
    `errors: [{ messageId: "noDirectVendorAdapterImport" }]`.
- The GREEN sibling `t_b7f8adfd` (assignee `openpic-webapp-backend-coder`) is
  gated on this card and reuses this worktree; it must base its branch on this
  pins branch, not bare `origin/main`, or it will not see the pins. This card
  ends with `kanban_complete` (not `kanban_request_review`) so that completion
  releases it — review of the pins happens inside the GREEN's PR, per the lane's
  RED→GREEN precedent (ADR-0306).

## Alternatives considered

- **Ban the literal `"cashfree"` outside the adapter.** Rejected: §11.1 requires
  the port's provider-key union and `plans.values.ts` is pre-existing off-lane
  config, so the rule would carry a standing allowlist of legitimate sites — and
  it would not stop the adapter import, which is the real leak.
- **Extend `no-restricted-imports` with an `**/server/adapters/cashfree/**`
  glob.** Rejected: it needs one glob per specifier shape (alias and relative),
  a separate flat-config exemption object for the composition root, and it
  cannot see dynamic `import()`. Recorded here so the option is not re-litigated.
- **Pin the vendor **SDK package** name instead of the adapter path.** Not
  applicable today: the Cashfree adapter talks raw HTTP (`fetch`) and the
  workspace declares no `cashfree` package. If a vendor SDK is ever added, its
  package specifier belongs in the existing `no-restricted-imports` boundary
  (the Novu shape), and this rule's adapter-path boundary stays.
- **Exempt the whole `server/payments/**` folder.** Rejected: the composition
  root is the deliberate seam; exempting the folder would let any payment module
  reach the adapter. The sibling-module negative pin forbids it.
- **Change production here to make the pins pass.** Not done — this is the TEST
  card; the implementation (the rule module and its `eslint.config.mjs`
  registration) belongs to the GREEN sibling `t_b7f8adfd`.

## Review sign-off

_Pending. This card ends with `kanban_complete` to release the gated GREEN
`t_b7f8adfd`; the pins are reviewed inside that PR._
