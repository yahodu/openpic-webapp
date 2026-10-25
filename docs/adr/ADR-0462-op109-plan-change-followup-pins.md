# ADR-0462 — OP-109 follow-up TEST: the `destructive` pin rephrased lint-clean, the two uncovered calculator branches pinned, and the missing-`currentPeriodEnd` fallback characterised

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 follow-up TEST (`t_5eef78db`) · **Branch:** `OP-109-task-plan-change-pin-followup` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4079f630`
- **Relates to:** [ADR-0460](ADR-0460-op109-plan-change-red.md) (the RED contract), [ADR-0461](ADR-0461-op109-plan-change-green.md) (§5 records the `destructive: boolean` deviation and the scoped ESLint exemption this card removes the need for), [ADR-0400](ADR-0400-op106-subscription-read-red.md) / [ADR-0401](ADR-0401-op106-subscription-read-green.md) (the `scheduledChange` block the downgrade writes)
- **Contract:** §3.3 (downgrade consequences, period-end scheduling), §0.15 (never-return) · **Schema:** §14.1 (plans/entitlements), §14.2 (usage counters), §14.3 (subscriptions)

## Context

Round-1 review of the OP-109 GREEN (`t_4079f630`, PR #334, merged as `20fa9a5`)
confirmed three low-severity gaps inside this lane's own pins:

- **F3** — the consequence invariant was asserted as
  `CONSEQUENCES.filter((consequence) => consequence.destructive !== false)`.
  `@typescript-eslint/no-unnecessary-boolean-literal-compare` (enabled by
  `strictTypeChecked`) reports a non-nullable boolean-to-`false` comparison as an
  error, so the GREEN had to type `DowngradeConsequence.destructive` as plain
  `boolean` instead of ADR-0460 §3's literal `false` **and** add a scoped
  exemption for this one file in `eslint.config.mjs`. The exemption masks exactly
  one diagnostic (`apps/web/src/test/unit/plan-change.test.ts:187:49`).
- **A coverage gap** — `constrainedKeys` (`plan-change.ts`, ~lines 106–117) skips
  a target entitlement on `spec.enforcement === "feature"` **or**
  `spec.limit === null` (unlimited). No unit fixture reached either skip.
- **F5** — `downgrade/route.ts:139` falls back to `effectiveAt = now` when the
  live row has no `currentPeriodEnd`, which contradicts §3.3's "downgrades take
  effect **at period end**".

This card is **test-only**: no production file and no `eslint.config.mjs` edit.
Removing the exemption and restoring the literal `false` type is the gated GREEN
card's job (`t_f9146a1a`).

## Decision

### 1. The `destructive` pin reads the value instead of comparing a boolean to `false`

The pin now reads each consequence's `destructive` **as a value**, keyed by the
entitlement it belongs to, and compares that to `false`:

```ts
expect(
  CONSEQUENCES.map((consequence) => [consequence.entitlementKey, consequence.destructive])
).toEqual(CONSEQUENCES.map((consequence) => [consequence.entitlementKey, false]));
```

This keeps the invariant (§3.3: **every** emitted consequence is
non-destructive) and still names the offending entries — a failure prints
`[["events.active", true], …]` against `[["events.active", false], …]`, i.e. the
offending `entitlementKey` and its value, not a bare boolean.

The shape is deliberately **not** a predicate over the property. Two alternatives
were tried and rejected because each fails under one of the two possible types of
`destructive`:

| Shape                                             | `destructive: boolean`       | `destructive: false` (literal)                |
| ------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| `filter((c) => c.destructive !== false)` (before) | `no-unnecessary-boolean-…` ✗ | `no-unnecessary-condition` ✗                  |
| `filter((c) => c.destructive)` (truthiness)       | lint-clean ✓                 | `no-unnecessary-condition` ✗ ("always falsy") |
| **map the value, `toEqual` (this ADR)**           | lint-clean ✓                 | lint-clean ✓                                  |

Proven with a throwaway type mutation (the property temporarily typed
`readonly destructive: false`, production file restored byte-identically
afterwards): the truthiness predicate reports `192:49 Unnecessary conditional,
value is always falsy`, while the value form reports **0 problems** under both
`boolean` and the literal `false`.

### 2. The two uncovered `constrainedKeys` skips are pinned

- **`enforcement === "feature"` skip** — an `it.each` over two target feature
  shapes asserts the feature key produces **no** consequence while the sibling
  constrained key (`events.active`) still does, so the key's absence is the skip
  and not an accidental absence from the target plan:
  - the catalogue's unlimited feature shape (`limit: null`, `enabled: false`);
  - a feature shape that carries a **limit below the recorded usage**
    (`limit: 1`, usage `3`), which isolates the `enforcement` guard from the
    `limit === null` guard — that row would emit a consequence if the walk
    visited it.
- **`limit === null` skip** — the target plan makes `images.per_event` unlimited
  while the tenant has usage for it (`used: 100`); the pin asserts **no**
  consequence. Without the skip the walk would evaluate `100 > null` (→ `100 > 0`)
  and emit a bogus consequence, so the pin discriminates.

Both are characterisation pins of shipped behaviour and are green on the trunk.

### 3. The missing-`currentPeriodEnd` fallback is pinned as characterisation, and filed as an open question

A live `subscriptions` row seeded **without** `currentPeriodEnd` (the field is
optional in the route's `liveSubscriptionSchema`) is downgraded with
acknowledgement; the pin asserts the served `scheduledChange.effectiveAt` — and
the stored one — fall inside the `[before, after]` real-clock bracket around the
request and are **not** the seeded period end (~20 days away).

**Open product question (not a decided behaviour).** §3.3 says a self-serve
downgrade lands **at period end** so already-created content is never stranded
above the new limits; scheduling it at `now` for a row with no period end does
the opposite. The shipped fallback is defensible only if "no `currentPeriodEnd`"
can never occur for a live paid row (the seed always writes it, and §14.3 makes
it part of a real subscription), in which case the fallback is dead defensive
code. If it _can_ occur, this author's position is that the route should **refuse**
(a `409`/`422` naming the missing period) rather than silently schedule the change
immediately. That is a product decision for the owner of §3.3 (OP-110/OP-111, the
scheduler that applies the change), so this card **characterises the shipped
behaviour and does not demand a change**; the pin is written so that either
resolution — refuse, or schedule at `now` consciously — is a deliberate edit to a
named pin rather than a silent behaviour change.

## Consequences

- GREEN `t_f9146a1a` can now delete the `eslint.config.mjs` exemption block (the
  `files: ["apps/web/src/test/unit/plan-change.test.ts"]` object at
  `"@typescript-eslint/no-unnecessary-boolean-literal-compare": "off"`) **and**
  restore ADR-0460 §3's literal `false` type on
  `DowngradeConsequence.destructive` without touching a test: the rephrased pin
  is lint-clean under both types.
- The calculator's two skip branches are now covered by unit pins, so a refactor
  that drops either guard fails loudly (`expected [ 'events.active', …(1) ] to
deeply equal [ 'events.active' ]` for the feature guard; `expected [ { …(5) } ]
to deeply equal []` for the unlimited guard).
- The F5 fallback is a named, characterisation pin with a mutation-proven
  boundary, so it can only change deliberately.
- Test-only: no production module, schema, index, fixture or factory is touched.
  `docs/adr/README.md` remains the shared-ledger hotspot and this record's merge
  is a union resolution.

## Evidence

| Gate                                                                                                | Result                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eslint --rule '{"@typescript-eslint/no-unnecessary-boolean-literal-compare":"error"}'` on the spec | **1 problem at `187:49` before** the rephrase; **0 problems after**                                                                              |
| the same rephrased pin under a literal `false` type (throwaway mutation, restored)                  | **0 problems** (`eslint` default config and with the rule re-enabled); `tsc` exit `0`                                                            |
| `vitest run --project unit plan-change.test.ts`                                                     | **20 passed (20)** (was 17; +2 skip pins, the feature pin is an `it.each` of 2)                                                                  |
| `vitest run --project integration billing-plan-change.test.ts`                                      | **25 passed (25)** (was 24; +1 F5 pin)                                                                                                           |
| unit (full)                                                                                         | **112 files / 1955 passed \| 3 skipped** (was 1952 passed \| 3 skipped)                                                                          |
| integration (full)                                                                                  | **82 files / 639 passed** (was 638 passed; +1 F5 pin)                                                                                            |
| mutation M1 (drop the `enforcement === "feature"` guard)                                            | feature pin **RED**: `expected [ 'events.active', …(1) ] to deeply equal [ 'events.active' ]`                                                    |
| mutation M2 (drop the `limit === null` guard)                                                       | unlimited pin **RED**: `expected [ { …(5) } ] to deeply equal []`                                                                                |
| mutation M3 (emit `destructive: true`)                                                              | consequence pin **RED** and names the entry: `expected [ [ 'events.active', true ], …(1) ] to deeply equal [ [ 'events.active', false ], …(1) ]` |
| mutation M4 (`effectiveAt = current.currentPeriodEnd ?? new Date(0)`)                               | F5 pin **RED**: `expected 0 to be greater than or equal to 1792938568912`                                                                        |
| every probed production file restored                                                               | byte-identical to the pre-probe backup (`git diff` empty)                                                                                        |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                            | exit `0`                                                                                                                                         |
| `prettier --check` / ESLint on the touched files                                                    | clean / 0 problems                                                                                                                               |

## Alternatives considered

- **Assert over `CONSEQUENCES.map((c) => c.destructive)` with no key.** Rejected:
  a failure prints `[true, false]` without naming **which** entitlement broke the
  invariant — weaker than the round-1 pin it replaces.
- **Keep `filter((c) => c.destructive)` (truthiness).** Rejected: it lints under
  `boolean` but trips `no-unnecessary-condition` the moment GREEN restores the
  literal `false`, which would re-open F3.
- **Assert with `expect(c.destructive).toBe(false)` per element.** Rejected: it
  asserts a property of _the calculator's current output_, not "every consequence
  of this input", and does not scale to the array.
- **Demand the F5 fallback become a refusal here.** Rejected: it is a product
  decision (§3.3's owner), not a test-author decision; the card asks for a
  characterisation pin, and the open question is recorded above.
- **Unit-pin the feature skip with a catalogue-shaped feature only.** Rejected as
  the sole row: with `limit: null` the feature key would also be skipped by the
  `limit === null` guard, so removing the `enforcement` guard would not fail the
  pin. The `it.each` keeps the catalogue shape **and** isolates the guard.

## Number allocation

Lane range `0460`–`0479` (`docs/adr/README.md` row `OP-109 plan-change lane`).
This card consumes `0462`, the cell's value re-read on `origin/main` immediately
before pushing; the lane's `Next free` cell advances `0462` → `0463`. No number
outside `0460`–`0479` is touched.
