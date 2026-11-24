# ADR-0945 — OP-140 TEST: the `pay_now` producer — an owner's `billing.payment.failed` row carries exactly one action

- **Status:** Accepted (TEST; RED by design) · **Date:** 2026-11-23
- **Card:** `t_b27b8d1a` (OP-140 TEST, Low, phase 6-M2M · epic Notifications) — the **producer
  slice** decided by the round-2 append `t_b1bebbc8` to
  [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §4.6.
- **Branch:** `OP-140-task-pay-now-producer` (the card body suggested `OP-140-test-pay-now-producer`;
  `test` is not a work type in the CI branch-name rule `^OP-[0-9]+-(feature|bug|task)-[a-z0-9_-]+$`,
  so the delivered branch uses `task` and nothing else changed), cut from `origin/main` `0628629f` (the squash of the
  round-2 append). **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-affordance-producer`.
- **Touches:** one spec file, **append-only**
  (`apps/web/src/test/integration/notification-actions.test.ts`: five cases in one new `describe`,
  `+260/−0`), plus this record, its ledger row and the lane's `Next free` cell. **No production
  file, factory, fixture or helper is in the diff.** The throwaway near-fix used to prove the pins
  green (Evidence §3) was restored byte-identically.
- **ADR number:** `0945` — the `OP-140 notifications lane` row's `Next free` cell, which advances to
  `0946`. The sweep read `origin/main` `0628629f` (highest record `0944`), every worktree's
  `docs/adr` directory (66 worktrees, highest `0944`), the four open PR heads (#823 `e2efaee8`
  → `0944`; #755, #743, #272 carry no `09xx`) and `git rev-list --objects --all -- docs/adr`
  (no `ADR-0945` object), so nothing held the number. No cell is lowered and the `0942`–`0961` range
  is unchanged.
- **Consumes:** [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) (§4.3 the
  kind → key-set table, §4.4 the recipient rule, §3 fact 4 that the feed cannot reach the rows, and
  §4.6 the acceptance this record pins), [ADR-0943](ADR-0943-op140-notification-action-residual-pins.md)
  (the residue pins on the same endpoint and harness) and
  [ADR-0944](ADR-0944-op140-notification-action-affordance-closure.md) (the closure the `A4` arm
  observes after the click).
- **Consumers:** `apps/web/src/test/integration/notification-actions.test.ts` (§1–§4).

## Context

The endpoint `POST /api/v1/me/notifications/{id}/actions/{actionKey}` has a working `pay_now`
delegate (`startOutstandingCharge`, `server/billing/charge-outstanding.ts:120`) and a working
closure (`closeActionAffordance`, ADR-0944), yet **no user can reach either**. The fan-out's
`buildActions` returns `actionTarget: null, actions: []` for any catalogue row without
`actionable` (`server/notifications/fan-out.ts:456`), and for an actionable row it emits a
non-empty `actions` list only when the target kind is `invitation` (`:463-468`). Exactly one
catalogue row is actionable (`collab.invite.sent`). The shipped `pay_now` arm is therefore
production code reachable only by a spec that hand-inserts a feed row — which is exactly what the
eighteen shipped cases of `notification-actions.test.ts` do.

The producer rule (ADR-0942 §4.4) is that an action is emitted **only to a recipient the delegate
will accept**. `startOutstandingCharge` refuses a non-owner with `403 forbidden`
(`charge-outstanding.ts:97-108`), and the type's audience is `billing_contact` — a field the owner
may set to **any** active member (`server/repos/notification-recipients.ts:139-145`). So flipping
the catalogue row alone would ship a button that answers `403` to a legitimate recipient.

## Decision

Pin the producer end to end through the feed, with no internal function named. The five appended
cases deliver the **real** domain event (the emit at `server/billing/webhook-projection.ts:968`:
`subjectRef {kind: "subscription", id}`, `payload {subscriptionId}`) through `emitDomainEvent` and
a real `runNotificationFanOut` run with `mongoRecipientRepository`, then assert only what
`GET /me/notifications` and the action endpoint serve.

| Arm    | Case                                                                                | What it pins                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | `A1: serves the owner's produced row exactly one pay_now action`                    | One row; `actionTarget` exactly `{kind: "subscription", id: <subscription>, state: "open"}`; `actions` exactly one element whose key set is exactly `{key, label, state, style}`, `key: "pay_now"`, `state: "available"`, `style` inside the §7.1 enumeration, non-empty `label`.     |
| **A3** | `A3: serves a non-owner billing contact the row and no action`                      | With `tenants.billingContactUserId` set to an **active `member`** (not the owner), the fan-out's `billing_contact` audience resolves that member: the row exists **for them** with `actionTarget: null, actions: []`, and the owner — outside that audience — receives no row at all. |
| **A4** | `A4: applies the produced pay_now once and closes the produced row`                 | A click on the **produced** row answers `200 applied`, writes one `pending` charge for `pendingDueMinor`, and the next `GET` serves `actionTarget.state: "resolved"` with `[["pay_now", "unavailable"]]`; a second click answers `already_resolved` and writes no second charge.      |
| **A5** | `A5: never offers pay_now on an incomplete subscription that carries a checkout`    | An `incomplete` row with a stored `checkout` inside its `expiresAt` (and `pendingDueMinor: 0`) is not offered `pay_now`, and carries at most one action.                                                                                                                              |
| **A5** | `A5: never offers complete_mandate on a past_due row that still carries a checkout` | A `past_due` row that still carries a (live) `checkout` is offered exactly `["pay_now"]` — the presence of `checkout` is not what selects the key.                                                                                                                                    |

The key set is read from the served row, never from a table: the pins name no function and no
module other than the two routes already imported by the file. Nothing about the implementation is
fixed beyond the observable row — the owner may be resolved once per run or per recipient, and the
key set may be derived any way that agrees with ADR-0942 §4.3.

## Evidence

### 1. RED on `origin/main` `0628629f` (the honesty of the flip)

`npx vitest run --project integration apps/web/src/test/integration/notification-actions.test.ts`
with this branch's spec appended:

```
❯ .../notification-actions.test.ts (23 tests | 3 failed) 6010ms
   ❯ billing.payment.failed — the producer of the pay_now affordance (5)
     × A1: serves the owner's produced row exactly one pay_now action 159ms
     × A4: applies the produced pay_now once and closes the produced row 131ms
     × A5: never offers complete_mandate on a past_due row that still carries a checkout 218ms

 FAIL  A1 … AssertionError: expected null to deeply equal { kind: 'subscription', …(2) }
- Expected: { "id": "6b046037b9445da53ebd8d89", "kind": "subscription", "state": "open" }
+ Received: null                       (notification-actions.test.ts:1516)

 FAIL  A4 … AssertionError: expected 422 to be 200 // Object.is equality
- Expected 200  + Received 422         (notification-actions.test.ts:1582)

 FAIL  A5 (past_due) … AssertionError: expected [] to deeply equal [ 'pay_now' ]
- Expected [ "pay_now" ]  + Received [] (notification-actions.test.ts:1670)

      Tests  3 failed | 20 passed (23)
```

Every red is an **assertion** failure on a row the fan-out really wrote: `A1`'s preceding
`expect(rows).toHaveLength(1)` passes, so the event, the audience, the template and the row all
work and only the affordance is missing — the flip ADR-0942 §3 fact 1 measured. `A4` reds because a
row with `actions: []` answers `422` before it can delegate. No red is a harness or import error.

### 2. Two arms are green on arrival, by design

`A3` and the `incomplete` half of `A5` pass **before** any implementation: the trunk already serves
`actionTarget: null, actions: []` to everyone and offers no `pay_now` at all. They are the
authorization half and the exclusion half; their job is to stop the GREEN over-emitting (a
catalogue flip that ignores the recipient role reds `A3`; one that ignores the target's stored
state reds the `past_due` half). Declared here so neither is mistaken for a pin that already
shipped a fix.

### 3. The pins are satisfiable — throwaway near-fix, restored

A minimal near-fix (`actionable: true` on the `billing.payment.failed` spec at
`notification-types.values.ts:361`, plus `buildActions` taking the recipient and the stored
subscription and returning `pay_now` for a past-due owner / `complete_mandate` for an `incomplete`
row with a live checkout) makes the file **`23 passed (23)`** — the five pins and all eighteen
shipped cases, so the probe does not disturb the invitation arm. Both production files were then
restored and are byte-identical to `HEAD`:

```
fan-out.ts                      8a6cf389092aa6f3c7db8aebb69dda6681a08a68355b2e2c10e1dc6757d5e5db
notification-types.values.ts    d1c89430f562ae3e3d6f6f84429840981acfb0f0787e027257db9b5d4a9c910a
git status --short  →  M apps/web/src/test/integration/notification-actions.test.ts
```

The near-fix is **not** a proposal: it resolves the owner per recipient (the card asks for once per
run), it shapes the label copy, and it reads the subscription with a direct driver call. It exists
only to prove that every assertion in §Decision is reachable.

### 4. Static checks on the delivery head

`npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `npx eslint` on the spec: no issues;
`npx prettier --check` on the spec: clean.

## Assumptions

- **P-1 — the label copy is not pinned.** `A1` requires a non-empty `label` and the contract §7.1
  `style` enumeration (`primary` | `secondary` | `danger`), not the string `"Pay now"`. The card's
  A1 sketch named the copy and its closing note forbade pinning it beyond "non-empty and one
  action"; the narrower reading is the one recorded here, so a copy change is not a regression.
- **P-2 — the kind comes from the emit.** `actionTarget.kind` is asserted as `"subscription"`, the
  emit's `subjectRef.kind` (`webhook-projection.ts:968`), per ADR-0942 §4.5. A type→kind map in the
  fan-out would pass this pin by coincidence; the pin still forbids a different kind.
- **P-3 — `A5` pins the exclusion, not `complete_mandate`'s delegate.** ADR-0942 §4.7 keeps that
  row deferred, so the `incomplete` arm asserts only "no `pay_now`, at most one action". An
  implementation that offers no action there is accepted; one that offers `complete_mandate` is
  accepted; one that offers both is not.
- **P-4 — the event is emitted, not written.** The cases go through `emitDomainEvent`, so the
  outbox row is production's (validated key, retention expiry, dispatch flag). They therefore also
  fail loudly if `billing.payment.failed` ever leaves the catalogue.
- **P-5 — the owner's row is reached by the `billing_contact` audience.** `A3` sets
  `tenants.billingContactUserId` explicitly instead of editing `tenantMembers`, because that field
  (`server/tenancy/permissions.ts:9-38`) is what `getBillingContactUserId` reads; it is the only
  lever the fan-out has, and the fact that moving it moves the row is the authorization evidence.

## Out of scope

- The other five §7.3 rows (`complete_mandate`, `retry_failed`, `acknowledge`, `extend_upload_window`,
  `retry`): ADR-0942 §2 and §4.7 keep them deferred, each on a measured precondition.
- `complete_mandate`'s delegate and its click: no stored value exists on the upgrade path
  (ADR-0942 §2).
- An e2e arm. The card asks for integration; the rows are produced and clicked in-process, and the
  endpoint's e2e journey (`E1`) already exists for the invitation story.
- The five other audiences' recipient rules. `A3` pins `billing_contact` only, the only audience
  that can receive `pay_now` today.

## Consequences

- The GREEN (`openpic-webapp-backend-coder`, a sibling card in a **different** worktree) inherits a
  contract it cannot satisfy by flipping one boolean: the catalogue change is one line, but `A3`
  forces the recipient check and `A5` forces the target's stored state. The three code points are
  `actionable: true` on `notification-types.values.ts:361`, a key set derived from the one
  `DISPATCH_TABLE` in `notification-actions.ts:46`, and `buildActions`
  (`fan-out.ts:452-471`) gaining the target's stored state and the recipient's workspace role.
- The PR is a **draft**: a RED-by-design pin pack must not merge alone (ADR-0306). The GREEN bases
  its branch on this one, not on bare `origin/main`.
- A future refactor that keeps emitting exactly one owner-only `pay_now` on a produced row breaks
  none of these five cases; one that emits it to a billing contact, or that adds a second key,
  breaks at least one — with a message naming the offending row state.
- Hotspot: `docs/adr/README.md` (row `0945`, cell `0946`), which the sibling OP-140 cards also
  append to — merge as a union keeping the higher cell.
