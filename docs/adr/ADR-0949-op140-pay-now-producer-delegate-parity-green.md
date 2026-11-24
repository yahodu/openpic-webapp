# ADR-0949 — OP-140 GREEN: the `pay_now` producer offers only the event's own, delegate-parseable subscription

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_a587119c` (OP-140 GREEN, Low, phase 6-M2M · epic Notifications) — makes the five pins of
  `t_9b3063ff` / [ADR-0948](ADR-0948-op140-pay-now-producer-delegate-parity-pins.md) green: findings
  **F1** and **F2** of the round-1 review `t_61798b06` of the merged GREEN
  [ADR-0946](ADR-0946-op140-pay-now-producer-green.md) (PR
  [#845](https://github.com/yahodu/openpic-webapp/pull/845), squash `2fa60b9c`).
- **Branch:** `OP-140-task-pay-now-delegate-parity-green`, cut from the pins head `40d2dc4d` (the
  pins commit `9dc58ac7` on `origin/main` `2c2c6a7a`) and merged with `origin/main` `1543d2ae` before
  the push, so one squash carries the pins commit **unchanged**, this record and the implementation.
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-affordance-producer-green`.
- **Touches:** two production files — `apps/web/src/server/billing/charge-outstanding.ts` (the
  delegate's subscriptions parser is exported, TSDoc extended, one word of code) and
  `apps/web/src/server/notifications/fan-out.ts` (`resolveActionScope` parses with that parser and
  requires the event's tenant; the narrower local schema and its three now-unused imports are
  deleted) — plus this record, its ledger row and its cell. **No test, factory, fixture, helper or
  harness file is in the implementation commit**; the pinned `describe` (`+160/−0`) is byte-identical
  to `40d2dc4d`, and the twenty-three shipped cases are untouched.
- **ADR number:** `0949` — the number this card reserved (`Consumes: 0949`), drawn as given
  (CONVENTIONS §11). The `OP-140 notifications lane` cell read `0949` at this head, so
  `max(cell, 0949) = 0949` and drawing it advances the cell `0949` → **`0950`** (`max(cell, 0950)`);
  no cell is lowered, no range is re-cut and the `0942`–`0961` block is unchanged. The sweep read
  `origin/main` `1543d2ae`, every `.worktrees/*/docs/adr` tree (no `ADR-0949`), every open PR head
  (none carries `ADR-0949`), `git rev-list --objects --all -- docs/adr` (no `ADR-0949` object) and
  `ls docs/adr` (0).
- **Consumes:** [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) (§4.1 the producer
  never emits a control the delegate refuses; §4.3 the live-when state rule; §4.4 the owner-only
  recipient; §4.5 the kind comes from the emit), the pins
  [ADR-0948](ADR-0948-op140-pay-now-producer-delegate-parity-pins.md) and the producer they pin
  [ADR-0946](ADR-0946-op140-pay-now-producer-green.md).

## Context

`resolveActionScope` (`fan-out.ts`) decided whether an actionable event earns a `pay_now` from two
facts the delegate it feeds disagrees with — both measured at `2fa60b9c` and pinned by ADR-0948:

1. **The target read had no tenant predicate.** `findOne({ _id: id })` accepted the subscription of
   another workspace, so an event inside tenant A naming tenant B's row left A's owner a `pay_now`
   whose click `startOutstandingCharge` answers `403` to (its owner gate re-checks the
   _subscription's_ tenant, `charge-outstanding.ts:97-108`).
2. **The local parser was narrower than the delegate's.** `actionableSubscriptionSchema` made
   `mandateStatus` optional (`nullable().default(null)`) and omitted `_id` / `tenantId` / `currency`,
   while `chargeableSubscriptionSchema` (`charge-outstanding.ts:46-54`) requires all four. A row the
   delegate cannot parse — `mandateStatus` absent, or `tenantId` stored as the `ObjectId` shape
   `webhook-projection.ts:359-367` documents — still got a button, and the button answered `500`.
   The delegate parses `tenantId` as `z.string()`, so the `ObjectId` shape is unparseable for it
   whether or not a producer normalises it.

Both are the one class ADR-0942 §4.1 forbids, and no shipped producer emits a mismatched
`subjectRef` or an unparseable row today, so both are Low.

## Decision

**1. One parser, the delegate's own.** `chargeableSubscriptionSchema` is exported from
`charge-outstanding.ts` and used by the fan-out; `actionableSubscriptionSchema` is deleted rather
than widened, so there is exactly one definition of what a chargeable `subscriptions` row is. The
producer therefore refuses every row the click would refuse (`mandateStatus`-less and
`ObjectId`-tenant arms, P3/P5), and no third copy of the shape exists to drift.

**2. The target must be the event's own tenant.** After the parse, the stored row's `tenantId` is
compared to the event's tenant as normalized hex (`asObjectId(...)?.toHexString()`); an unreadable
id on either side fails closed. A comparison, not a query predicate, because the delegate's parser
already rejects the `ObjectId` stored shape and a `$or` over two shapes would put the tenant rule in
a second place. `startOutstandingCharge` keeps its owner gate and its `403` unchanged.

**3. Nothing else moves.** `actionTarget.kind` stays the emit's `subjectRef.kind` (§4.5), the
liveness decision keeps `decideRetryEligibility` + `providerRefOf` (§4.3), the owner is still
resolved once per fan-out run behind the memoised `ownerOf` (§4.4), the invitation arm is unchanged
(ADR-0946 §P-4), the `pay_now` action's shape/label/state is unchanged, and the closure stays the
endpoint's (ADR-0944).

**4. No re-normalisation.** A row storing `tenantId` as an `ObjectId` is _not_ converted to hex and
emitted: the delegate would still answer `500` because it parses the stored value. "No action" is
the only honest producer answer for both F2 arms.

## Evidence

### 1. Focused spec, RED → GREEN

```
40d2dc4d (pins head, before):  3 failed | 25 passed (28)
after (on the merged head):   28 passed (28)
```

The pins are the same file at both ends (no test file in the implementation diff).

### 2. Whole suites and guards

```
unit         195 files | 3300 passed | 3 skipped (3303)
integration  163 files | 1737 passed (1737)   (was 1734 passed | 3 failed)
adr-* guards 8 files   | 280 passed (280)
tsc          exit 0 for the root, apps/web and packages/contracts projects
prettier     clean (both production files, this record, the ledger)
```

### 3. Lint, compared against the base blob

```
eslint, base blob (40d2dc4d):  charge-outstanding.ts 0, fan-out.ts 8
eslint, after:                 charge-outstanding.ts 0, fan-out.ts 8
```

The eight are pre-existing `security/detect-object-injection` warnings on lines this diff does not
touch (297/298/308/442/457/484/487). A `prefer-optional-chain` warning the first draft introduced on
the tenant comparison was removed by comparing hex strings, so the diff adds none.

### 4. Merge gate

The §9.1 gate output and the CI rollup on the exact head SHA are posted on the PR before the merge.

## Assumptions

- **A1 — the delegate's parser _is_ the acceptance.** The producer's job is to not offer a key the
  click refuses, so "can the delegate parse it" is the rule, not a second opinion about which stored
  shape is legitimate.
- **A2 — one shared definition.** The parser stays owned by the delegate it serves
  (`charge-outstanding.ts`), which the fan-out imports; a shared `billing/subscriptions` module is
  not created because one consumer importing one export is smaller than a new module.
- **A3 — the read cost is unchanged.** Still one indexed `findOne` on `subscriptions` per actionable
  event and the parse is in memory; the owner read stays once per run.
- **A4 — the pinned controls keep their meaning.** P2/P4 still emit exactly one `pay_now`; a valid
  row inside its own tenant parses and compares equal, so nothing about them was weakened.

## Out of scope

- **The delegate's refusal shapes.** `charge-outstanding.ts` still throws `500` on a row it cannot
  parse and still answers `403` to a foreign subscription; both are pre-existing and recorded, not
  fixed here (ADR-0948, this card's body).
- **The rendered UI.** `state: "unavailable"` and the button copy belong to the shipped `A4`/`A5`
  pins.
- **`complete_mandate` and the other four §7.3 rows** (ADR-0942 §4.7).

## Consequences

- A `pay_now` is offered only where the click would succeed: the foreign-target and unparseable-row
  arms now serve `actionTarget: null` / `actions: []`, and the two control arms are unchanged.
- The `subscriptions` shape has one definition for both the producer and the delegate; a future
  change to what a chargeable row is reaches both readers at once.
- A future §7.3 producer that legitimately wants a cross-tenant target must first change
  `startOutstandingCharge` and the ADR-0948 pins in the same PR.
- **Hotspot:** `docs/adr/README.md` (row `0949`, cell `0950`), which the sibling OP-140 cards also
  append to — merge as a union keeping the higher cell.
