# ADR-0946 — OP-140 GREEN: the `pay_now` producer — an owner's `billing.payment.failed` row carries exactly one action

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_61798b06` (OP-140 GREEN, Low, phase 6-M2M · epic Notifications) — makes the five pins of
  `t_b27b8d1a` / [ADR-0945](ADR-0945-op140-pay-now-producer-pins.md) green: the **producer slice**
  of [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §4.6.
- **Branch:** `OP-140-task-pay-now-producer-green`, cut from `origin/OP-140-task-pay-now-producer`
  `ab7cbdad` (the pins commit `5607a2c6` plus ADR-0945 and its branch-name fix, on `origin/main`
  `3616db8a`) and merged with `origin/main` `4ffcf173`, so one squash carries the pins, this record
  and the implementation. **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/op140-affordance-producer-green`.
- **Touches:** three production files —
  `apps/web/src/server/notifications/notification-types.values.ts` (one catalogue flag),
  `apps/web/src/server/notifications/notification-actions.ts` (one read over the shipped table) and
  `apps/web/src/server/notifications/fan-out.ts` (the affordance resolution and its recipient gate) —
  plus this record and its ledger row and cell. **No test, factory, fixture, helper or harness file is
  in the diff**; the five pins are byte-identical to `ab7cbdad`.
- **ADR number:** `0946` — the number this card reserved (`Consumes: 0946`), taken as given
  (CONVENTIONS §11). The `OP-140 notifications lane` cell read `0948` at this head because the
  attendee RED `t_f26559df` drew `0947` and set the cell to `max(consumed)+1 = 0948`; that moved the
  cell past the reservation without consuming `0946`, so the card body's "higher of the cell you
  read" safety net does not trigger. The sweep confirmed `0946` free on all four §9 sources:
  `origin/main` `4ffcf173` (records run `0945` → `0947`; no `0946`), every `.worktrees/*/docs/adr`
  tree (highest `0947`), the lane's non-`done` cards (`Consumes: 0946` is this card and the done
  pins card only) and the eight open PR heads (#844 `70fcfc13` → `0963`, #832 `16913b23` → `0962`,
  #829 `1e769a7b` → `0944`, #828 `54ca4fdb` → `0944`, #826 `ab7cbdad` → `0945`, #755 `c90ae3ba`,
  #743 `40df0afd`, #272 `d5be9af4` — highest `0963`, none `0946`); `git rev-list --objects --all --
docs/adr` holds no `ADR-0946` object. The cell is **not lowered**: it stays at its trunk value
  `0948` = `max(0948, highest lane record 0947 + 1)`, and the `0942`–`0961` range is unchanged.
- **Consumes:** [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) (§4.1 the producer
  must not emit a control the delegate refuses, §4.2 the one type key that flips, §4.3 the key set
  derived from the §7.3 table and its live-when state rule, §4.4 the owner-only recipient rule,
  §4.5 the kind comes from the emit, §4.6 the acceptance), the five pins of
  [ADR-0945](ADR-0945-op140-pay-now-producer-pins.md), and
  [ADR-0944](ADR-0944-op140-notification-action-affordance-closure.md) (the closure the `A4` arm
  observes on the next `GET`).

## Context

The pins measured the gap precisely: `buildActions` (`fan-out.ts:520`) returned
`actionTarget: null, actions: []` to every catalogue row without `actionable`, and emitted a non-empty
`actions` list only when the target kind was `invitation`. So `startOutstandingCharge` and
`closeActionAffordance` were working code no user could reach, and the owner's
`billing.payment.failed` row carried no affordance. The five appended cases deliver the **real**
domain event through the real fan-out and read only the feed and the endpoint, so the fix must be
observable there — not in a helper the pins could name.

Two facts made the one-line catalogue flip insufficient:

1. The type's audience is `billing_contact`, a field the owner may point at any active member, while
   `startOutstandingCharge` refuses every non-owner with `403` (`charge-outstanding.ts:97-116`).
2. `actionable` is data (§19.1): it says the type offers an action, not which key is live. The key
   set and its liveness are §7.3's, and the target's stored state decides between them.

## Decision

**1. One catalogue row flips.** `actionable: true` on `billing.payment.failed` only
(`notification-types.values.ts:372`). No other key changes; `actionable` stays data read at fan-out
time.

**2. The key set is a read of the one §7.3 table.** `actionKeysForKind`
(`notification-actions.ts:98`) returns a kind's keys from the shipped `DISPATCH_TABLE`; the fan-out
asks it whether `subscription` offers `pay_now` instead of carrying a second table that would drift
from the contract (ADR-0942 §4.3). The invitation arm keeps its shipped `accept`/`reject` pair —
labels are not in the table and the shipped behavior is byte-identical.

**3. `buildActions` gains the target's stored state and the recipient's workspace role.** One
`ActionScope` is resolved **per actionable event** (`resolveActionScope`, `fan-out.ts:571`) and one
owner id **per fan-out run** (`loadOwnerUserId` behind the memoised `ownerOf`, `fan-out.ts:1481`; one
`tenantMembers` read per workspace, never per recipient). The recipient gate returns
`actionTarget: null, actions: []` to any user other than the scope's recipient, and
`actionTarget.kind` stays the emit's `subjectRef.kind` (§4.5) — no type→kind map.

**4. `pay_now` is emitted only where the delegate would accept it.** The stored row is parsed with a
narrow `actionableSubscriptionSchema` and the shipped `decideRetryEligibility`
(`services/subscriptions/retry-charge.ts:61-73`) decides the §4.3 state rule:
`pendingDueMinor > 0` with a chargeable mandate. The mandate reference the delegate needs is checked
with the shipped `providerRefOf` (`billing/one-time-charge.ts:46`), so a row with no chargeable
mandate reference emits nothing rather than a `409`. **No resolvable owner emits nothing either** —
the fail-closed reading of §4.1; a missing owner row must not hand the affordance to every recipient.
The action is `{key: "pay_now", label: "Pay now", style: "primary", state: "available"}` — one
element, never a second key riding along.

**5. `complete_mandate` is still emitted for nobody.** Its delegate stays deferred (ADR-0942 §4.7),
and `A5` accepts an implementation that offers no action on the `incomplete` row: the pin requires
only that `pay_now` is absent there and that no second key is added. When the upgrade path persists
`subscriptions.checkout` and a delegate seam exists, `resolveActionScope` gains that arm; the key
comes from the same table.

## Evidence

### 1. The honest RED on the pin head, reproduced with the implementation stashed

```
$ git stash push -- fan-out.ts notification-actions.ts notification-types.values.ts
$ pnpm exec vitest run --project integration apps/web/src/test/integration/notification-actions.test.ts
     × A1: serves the owner's produced row exactly one pay_now action 125ms
     × A4: applies the produced pay_now once and closes the produced row 189ms
     × A5: never offers complete_mandate on a past_due row that still carries a checkout 154ms
AssertionError: expected null to deeply equal { kind: 'subscription', …(2) }
AssertionError: expected 422 to be 200 // Object.is equality
AssertionError: expected [] to deeply equal [ 'pay_now' ]

      Tests  3 failed | 20 passed (23)
```

The three reds are assertion failures on rows the fan-out really wrote. `git apply` restored the
three files byte-identically (`sha256` unchanged), so the RED above is the pins alone — the commit
`73887a08` re-applied the measured implementation. `A3` and the `incomplete` half of `A5` stay green
on arrival, as ADR-0945 declared.

### 2. GREEN — on the merged head `1dc86d01` (`origin/main` `4ffcf173`)

```
$ pnpm exec vitest run --project integration apps/web/src/test/integration/notification-actions.test.ts
      Tests  23 passed (23)                          (9.4 s)

$ pnpm exec vitest run --project unit
      194 files | 3261 passed | 3 skipped (3264)

$ pnpm exec vitest run --project integration
      159 files | 1697 passed (1697)

$ pnpm exec vitest run --project unit <the seven adr-* guards>
      7 files | 248 passed (248)
```

> **Correction — re-measured at `077967b4` (the squash `2fa60b9c`).** The three counts in the block
> above were taken **before** this branch's final `origin/main` merge, so they trail the head the
> heading names. `1dc86d01` **is** that merge (`73887a08` + `origin/main` `4ffcf173`), and its tree
> differs from `077967b4` only by this record and the ledger row, so both heads carry the same code
> and the same specs. At `077967b4` they measure `unit` **195 files | 3296 passed | 3 skipped
> (3299)**, `integration` **163 files | 1732 passed (1732)** and the **eight** `adr-*` guards **276
> passed (276)** — the eighth guard, `adr-ledger-shape`, was already on `origin/main` `4ffcf173` and
> is green. The block above is left exactly as it was measured; nothing in it is rewritten. The
> `0946` ledger row's "seven `adr-*` guards `248 passed (248)`" carries the same correction — eight /
> **276** for the guards, and `195` / `3296` / `3 skipped` with `163` / `1732` for the two suite counts.
> The two heads are compared with `git diff --name-only 1dc86d01 077967b4`, which lists exactly those two files.

The eighteen shipped cases and every helper are untouched and green; the two green-on-arrival arms
are green for their own reasons (see below), not because a pin was weakened.

### 3. Static checks

`pnpm typecheck` exit `0` (all three projects); `pnpm exec eslint` on the three files: 0 errors (the
8 `security/detect-object-injection` warnings are on lines this diff does not touch); `prettier
--check` clean on all three.

## Assumptions

- **P-1 — the label copy is free.** `A1` pins only a non-empty `label` and the §7.1 `style`
  enumeration; the delivery uses `"Pay now"` / `primary`, the copy the pins' ADR named as a
  non-assertion. Changing it is not a regression.
- **P-2 — the recipient rule is fail-closed.** An event whose tenant has no active owner, or whose
  subscription carries no chargeable mandate reference, emits no action at all. The pins do not
  measure those states; ADR-0942 §4.1 decides them (never a control the delegate would refuse).
- **P-3 — one scope per event, one owner per run.** The owner is read once per workspace per fan-out
  run and the target's state once per actionable event (ADR-0942 §4.4), so a 5 000-recipient event
  costs one extra `tenantMembers` read and one `subscriptions` read, not 5 001.
- **P-4 — the invitation arm is unchanged.** `collab.invite.sent` still emits `accept`/`reject` to
  every recipient (its own document, not the workspace role, owns the decision); the shipped
  invitation cases pin it and stay green.
- **P-5 — the closure remains the endpoint's.** The next `GET` serves `resolved`/`unavailable` and a
  replay is `already_resolved` (ADR-0944); this record adds nothing to the delegate or the closure.

## Out of scope

- `complete_mandate`'s emission and delegate (ADR-0942 §4.7) and the other four §7.3 rows.
- A different audience for `pay_now`: the recipient gate, not a catalogue change, is what keeps a
  non-owner billing contact from receiving a `403` button.
- Backfilling affordances onto feed rows already written before this change: `§7.1` renders actions at
  write time (§19.4), so only rows produced after the fan-out change carry them.

## Consequences

- The shipped `pay_now` arm is reachable: a workspace owner's produced `billing.payment.failed` row
  carries exactly one action, a billing contact receives the notification without it, and a click
  charges once and closes the row everywhere.
- `actionable` remains data and the key set has one source; a future §7.3 row adds a key to
  `DISPATCH_TABLE` and an arm to `resolveActionScope`, never a third table.
- The RED pin pack's draft PR [#826](https://github.com/yahodu/openpic-webapp/pull/826) is superseded
  by this branch's PR, which carries the pins commit, this record, the implementation and the §9.1
  merge gate on its own head.
- Hotspot: `docs/adr/README.md` (row `0946`, cell `0948`), which the sibling OP-140 cards also append
  to — merge as a union keeping the higher cell.

## Review round 1 — APPROVED WITH FINDINGS

**Verdict: APPROVED WITH FINDINGS** on the merged GREEN (card `t_61798b06`, PR [#845](https://github.com/yahodu/openpic-webapp/pull/845), squash `2fa60b9c`, head `077967b4`). Nothing this record decides is retracted: the two code findings are routed to `t_9b3063ff` (pins) and `t_a587119c` (GREEN), and **F3** — the pre-merge figures under §2 — is closed by the docs card `t_db1bb4e2`.

**Verified independently at `077967b4` / `2fa60b9c`:**

- **Tree identity.** `git diff 077967b4 2fa60b9c` is empty, so the head and the squash carry one tree, and `git merge-base --is-ancestor 2fa60b9c origin/main` is true.
- **Focused spec.** `apps/web/src/test/integration/notification-actions.test.ts` `23 passed (23)`.
- **Whole `unit`** `195 files | 3296 passed | 3 skipped (3299)`, **whole `integration`** `163 files | 1732 passed (1732)`, and the **eight** `adr-*` guards `276 passed (276)` — re-measured for this record instead of transcribed.
- **Static.** `tsc` exit `0` in all three projects; `eslint` on `fan-out.ts` reports 8 warnings and 0 errors — exactly the base blob's own eight `security/detect-object-injection` findings, measured on `2fa60b9c^` (8 as well), so this delivery adds none and only shifts their lines; `prettier --check` clean.
- **CI.** 20/20 gates `SUCCESS` at `077967b4`; the commit's check-run list holds 21 entries, one of them the close-time `notify-discord` side effect, and five names appear twice because an edited PR body re-ran those workflows on the same head.
- **The pins file is additive.** `+265/−0` against the squash's first parent, so the eighteen shipped cases are untouched; the `+9/−5` a three-dot diff also shows is `main`'s own, landed by `da4e24cc` and `40af157a` and folded in by the branch's `origin/main` merge.
- **No honesty pattern** in the implementation commit: no fixture-shaped constant, no test-environment conditional, no suppressed diagnostic, no branch narrowed to look like a pin input.

**Findings:**

- **F1 (Low, measured) — no tenant predicate on the subscription read.** `resolveActionScope` fetched the stored row with `findOne({ _id: id })` and nothing else (`fan-out.ts:591` at `2fa60b9c`), so an event in tenant A naming tenant B's subscription emitted a `pay_now` whose click is `403` — ADR-0942 §4.1 violated. Probe at `2fa60b9c`: the row carried the foreign `actionTarget` and one action; `PROBE click: 403`. Routed to `t_9b3063ff` (pins) and `t_a587119c` (GREEN).
- **F2 (Low, measured) — the producer parsed narrower than its delegate.** `actionableSubscriptionSchema` (`fan-out.ts:220-225`) made `mandateStatus` `nullable().default(null)`, while the delegate parses with `chargeableSubscriptionSchema` (`charge-outstanding.ts:46-54`, `mandateStatus` required), so a stored row without the field got a `pay_now` whose click is `500 internal_error`. Probe: `PROBE-B row: {"n":1,"actions":[…]}`; `PROBE-B click: 500`. Routed to the same two cards.
- **F3 (Low, record accuracy) — the §2 counts were pre-merge.** Closed by the correction note under §2 and by the `0946` ledger row's guards phrase, in this card's PR.
- **Info, no card.** An owner who points `billingContactUserId` at another member receives **no row** and that contact receives no action — the recorded consequence of ADR-0942 §4.4/§4.6, pinned by `A3`, and the owner's other path is the billing page. The invitation arm's cross-tenant `subjectRef` is pre-existing, unchanged by this delivery and identity-checked by `requireInvitee`.

**Post-review status, bounded to the commits measured here.** `t_9b3063ff` landed the pins as [ADR-0948](ADR-0948-op140-pay-now-producer-delegate-parity-pins.md) and `t_a587119c` landed the fix as [ADR-0949](ADR-0949-op140-pay-now-producer-delegate-parity-green.md), both squashed on `origin/main` at `70fe8a42`: `resolveActionScope` now parses with the delegate's exported `chargeableSubscriptionSchema` and requires the stored row's `tenantId` to equal the event's tenant, so a foreign subscription emits no `pay_now` while both control arms still emit exactly one.
