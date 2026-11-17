# ADR-0463 — OP-109 follow-up GREEN: the consequence-pin ESLint exemption removed and the literal `false` type restored

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 follow-up GREEN A (`t_f9146a1a`) · **Branch:** `OP-109-task-plan-change-lint-exemption` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4079f630`
- **Relates to:** [ADR-0460](ADR-0460-op109-plan-change-red.md) (§3 typed `destructive` as the literal `false`), [ADR-0461](ADR-0461-op109-plan-change-green.md) (§5 recorded the `destructive: boolean` deviation and the scoped `eslint.config.mjs` exemption this card removes), [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) (§1 rephrased the pin lint-clean, which is what makes this card possible), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.3 (downgrade consequences) · **Schema:** §14.1 (plans/entitlements)

## Context

The OP-109 GREEN ([ADR-0461](ADR-0461-op109-plan-change-green.md) §5) carried one
deliberate, documented deviation from [ADR-0460](ADR-0460-op109-plan-change-red.md) §3:
`DowngradeConsequence.destructive` was typed plain `boolean` instead of the
literal `false`, and `eslint.config.mjs` gained a scoped exemption switching
`@typescript-eslint/no-unnecessary-boolean-literal-compare` off for
`apps/web/src/test/unit/plan-change.test.ts`. The RED's own runtime pin compared a
boolean to `false` (`consequence.destructive !== false`), which
`strictTypeChecked` reports as an unnecessary comparison **whatever** the property
type is — so no property type could lint, and a GREEN that may not edit the RED's
pin had no other legal move. The exemption masked exactly one diagnostic
(`plan-change.test.ts:187:49`).

[ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) §1 rephrased that pin to
read each consequence's `destructive` **as a value**, keyed by the entitlement:

```ts
expect(
  CONSEQUENCES.map((consequence) => [consequence.entitlementKey, consequence.destructive])
).toEqual(CONSEQUENCES.map((consequence) => [consequence.entitlementKey, false]));
```

The value form lints clean under **both** `boolean` and the literal `false`
(ADR-0462 §1 table), which removes the constraint that forced the deviation. This
card is the GREEN that closes it.

## Decision

### 1. The `eslint.config.mjs` exemption is deleted

The config object `{ files: ["apps/web/src/test/unit/plan-change.test.ts"], rules: { "@typescript-eslint/no-unnecessary-boolean-literal-compare": "off" } }`
(added by the OP-109 GREEN commit `5161c05`) is removed in full. Every other config
entry is untouched. `no-unnecessary-boolean-literal-compare` therefore applies to
the spec file again, exactly as it does everywhere else.

### 2. `DowngradeConsequence.destructive` is the literal `false` again

`apps/web/src/server/services/subscriptions/plan-change.ts` types the property
`readonly destructive: false;` — [ADR-0460](ADR-0460-op109-plan-change-red.md) §3's
literal — and the type's TSDoc paragraph now states the literal instead of arguing
for `boolean`. No behaviour changes: `computeDowngradeConsequences` already pushed
the literal `false` at both emit sites (`used > limit` and the ceiling-shrink
shape), and both remain assignable. §3.3's "a downgrade prompt is never a threat"
is now carried by the **type** as well as by the calculator and the runtime pin.

### 3. No test, mock, fixture or factory is edited

The pins from [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) ship
byte-unchanged; the rephrased pin is lint-clean with the exemption gone (evidence
below). This is the whole point of the sequence: the Test Author rephrased the
pin, the GREEN removed the workaround.

## Consequences

- The deviation [ADR-0461](ADR-0461-op109-plan-change-green.md) §5 recorded is
  closed: there is no longer a per-file ESLint exemption for the OP-109 pins, and
  the served/typed contract matches [ADR-0460](ADR-0460-op109-plan-change-red.md) §3.
- The consequence pin now lints under `strictTypeChecked` with no exemption
  **and** stays meaningful under the literal type, so a future reader cannot
  reintroduce the deviation by editing only the type.
- Behaviour-preserving for every caller: the routes place the consequences into
  `details.consequences` of the `422 acknowledgement_required` refusal, and the
  runtime shape is unchanged (`false` at every emit site).
- F5 (`downgrade/route.ts:139` schedules at `now` for a live row without
  `currentPeriodEnd`) remains an open product question recorded in
  [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) §3 — this card is out of
  that scope and does not touch it.

## Evidence

| Gate                                                                     | Result                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `git grep -n "no-unnecessary-boolean-literal-compare" eslint.config.mjs` | **no output** (exemption gone)                         |
| `eslint apps/web/src/test/unit/plan-change.test.ts` (exemption gone)     | exit `0`, **0 problems**                               |
| `vitest run --project unit apps/web/src/test/unit/plan-change.test.ts`   | **20 passed (20)**                                     |
| `tsc -p apps/web/tsconfig.json --noEmit`                                 | exit `0`                                               |
| `eslint .`                                                               | **0 errors**                                           |
| `prettier --check` on the touched files                                  | clean                                                  |
| `adr-numbering` guard (`apps/web/src/test/unit/adr-numbering.test.ts`)   | green                                                  |
| full unit / integration projects, `test:coverage` (thresholds enforced)  | exit `0` (see the handoff for the exact counts/ratios) |

The diff is `eslint.config.mjs`, `apps/web/src/server/services/subscriptions/plan-change.ts`,
this ADR and the `docs/adr/README.md` ledger cells. **No test, mock, fixture or
factory is edited.**

## Number allocation

Lane range `0460`–`0479` (`docs/adr/README.md` row `OP-109 plan-change lane`).
`0460` (the RED), `0461` (the GREEN) and `0462` (the follow-up pins) are taken, so
this record consumes `0463` — the cell's value re-read immediately before pushing.
The lane's `Next free` cell advances `0463` → `0464`. No number outside
`0460`–`0479` is touched.
