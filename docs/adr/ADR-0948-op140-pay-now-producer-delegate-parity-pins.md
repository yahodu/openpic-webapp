# ADR-0948 — OP-140 TEST: the `pay_now` producer's delegate parity — a foreign or unparseable subscription emits no action

- **Status:** Accepted (RED by design; gated GREEN `t_a587119c`) · **Date:** 2026-11-23
- **Card:** `t_9b3063ff` (OP-140 TEST, Low, phase 6-M2M · epic Notifications) — findings **F1** and
  **F2** of the round-1 review `t_61798b06` of the merged GREEN
  [ADR-0946](ADR-0946-op140-pay-now-producer-green.md) (PR
  [#845](https://github.com/yahodu/openpic-webapp/pull/845), squash `2fa60b9c`). Both are
  `resolveActionScope` (`apps/web/src/server/notifications/fan-out.ts:571-603`) behaviour the
  producer emits and [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §4.1 forbids:
  _never emit a control the delegate refuses_.
- **Branch:** `OP-140-task-pay-now-delegate-parity-pins`, cut from `origin/main` `0c084248` and merged
  with `origin/main` `2c2c6a7a` (PR #846, a docs-only ledger status cell for `0947`) before the push;
  the focused spec was re-run on the merge result and still reads `3 failed | 25 passed (28)`, the
  eight `adr-*` guards `280 passed (280)`, and the `OP-140 notifications lane` cell stayed at `0949`.
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-affordance-producer-green`.
- **Touches:** one file — `apps/web/src/test/integration/notification-actions.test.ts`, exactly one
  `describe` appended at the end (`+160/−0`; the twenty-three shipped cases, every helper, factory
  and the harness are byte-identical). No production, factory, fixture or helper file is in the
  diff; this record, its ledger row and its cell are the rest of it.
- **ADR number:** `0948` — the number this card reserved (`Consumes: 0948`), drawn as given
  (CONVENTIONS §11). The `OP-140 notifications lane` cell read `0948` at this head, so
  `max(cell, 0948) = 0948` and drawing it advances the cell `0948` → **`0949`** (`max(cell, 0949)`);
  no cell is lowered, no range is re-cut and the `0942`–`0961` block is unchanged. The sweep read
  `origin/main` `0c084248` (`ADR-0948` absent), every `.worktrees/*/docs/adr` tree (none), all seven
  open PR heads (max `0963` on `6233e325`; no `0948`), `git rev-list --objects --all -- docs/adr`
  (no `ADR-0948` object) and the directory itself (`ls docs/adr` → 0).
- **Consumes:** [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) (§4.1 the producer
  never emits a control the delegate refuses; §4.3 the live-when state rule; §4.4 the owner-only
  recipient; §4.5 the kind comes from the emit), the GREEN
  [ADR-0946](ADR-0946-op140-pay-now-producer-green.md) (the producer this pins) and the pins
  [ADR-0945](ADR-0945-op140-pay-now-producer-pins.md) (the same harness and the same emit shape).

## Context

`resolveActionScope` decides whether an actionable event earns a `pay_now` affordance. It does two
things the delegate it feeds does not agree with.

1. **It reads the subscription without a tenant predicate.** The read is
   `findOne({ _id: id })` (`fan-out.ts:591`), so an event emitted **inside tenant A** whose
   `subjectRef.id` names **tenant B's** subscription still resolves a scope, and A's owner's row
   carries `actionTarget` `{kind: "subscription", id: <B's>, state: "open"}` plus one `pay_now`.
   The delegate disagrees: `startOutstandingCharge` re-checks the caller against the
   **subscription's** tenant (`charge-outstanding.ts:97-108`) and answers `403`.
2. **It parses the row with a narrower schema than the delegate.** `actionableSubscriptionSchema`
   (`fan-out.ts:219-225`) makes `mandateStatus` optional (`nullable().default(null)`) and omits
   `_id` / `tenantId` / `currency`, while the delegate's `chargeableSubscriptionSchema`
   (`charge-outstanding.ts:46-54`) requires all four. A row the delegate cannot parse therefore
   still gets a button, and the button answers `500 internal_error` when pressed.

No shipped producer emits a mismatched `subjectRef` today and the seeds always write a parseable
row, so both are **Low** severity. Both are nevertheless the class §4.1 forbids, and neither was
pinned. A behaviour change needs a pin first, so this record is the pin and the sibling GREEN
`t_a587119c` carries the fix.

## Decision

**1. One appended `describe` — five cases, two findings, two controls.** Title
`billing.payment.failed — the pay_now producer's delegate parity`, appended after the shipped
producer `describe` (`notification-actions.test.ts:1682`). Every case emits the **real**
`billing.payment.failed` event (`emitDomainEvent` with the projection's own `subjectRef` and
`payload`, `webhook-projection.ts:968`), drains it with a real `runNotificationFanOut` over
`mongoRecipientRepository`, and reads only the feed `GET`:

- **P1 (F1)** — seed two workspaces; emit in tenant A naming tenant B's subscription. A's owner's
  row exists and carries `actionTarget: null` and `actions: []`. Also pinned: B's owner gets no row
  (the audience is the event's tenant, §4.4), so a fix cannot "repair" the finding by moving the
  row to the subscription's tenant.
- **P2 (F1's control)** — the same emit **inside** the subscription's own tenant gives that
  tenant's owner the one `pay_now` (`actionTarget` exactly `{kind, id, state: "open"}`, key set
  `["pay_now"]`), and the other seeded tenant's owner nothing.
- **P3 (F2)** — one workspace, `mandateStatus` `$unset`, the real emit: the row is delivered with
  `actions: []` and `actionTarget: null`.
- **P4 (F2's control)** — the unmodified `seedBillingWorkspace` row still emits exactly one
  `pay_now` on the subscription target.
- **P5 (F2's second stored shape)** — one workspace, `tenantId` re-stored as an `ObjectId` (the
  second shape §14.3's applier documents, `webhook-projection.ts:359-367`): no action, because the
  delegate requires a string (`charge-outstanding.ts:48`).

**2. The pins assert the served row, not the helper.** `actionTarget` and `actions` are read from
the feed projection, the same two fields the shipped `A3` case reads. No test-side helper
re-derives state, and the previous describe's local `deliverPaymentFailed` is not reached into — the
new `describe` carries its own `emitPaymentFailed(tenantId, subscriptionId, claimerId)` and
`producedRows(cookie)`, both copies of the shipped shape so the emit is the projection's own.

**3. The controls are declared green on arrival.** P2 and P4 pass on the trunk because they pin
behaviour that already ships (`A1`). They exist so P1, P3 and P5 cannot pass by the fan-out never
emitting anything; they are not new requirements and must not be weakened.

**4. The expected behaviour is the delegate's own acceptance, not a re-normalisation.** For P5 the
question is whether the fix should normalise the stored `ObjectId` and emit anyway. It must not: the
delegate parses the **stored** row with `tenantId: z.string()` and answers `500` (measured below), so
emitting would be the same §4.1 violation. "No action" is the pinned reading for both F2 arms.

## Evidence

### 1. RED on the base head `0c084248` with the spec applied

```
Test Files  1 failed (1)
     Tests  3 failed | 25 passed (28)
```

- **P1** fails at `notification-actions.test.ts:1754` with
  `AssertionError: expected { kind: 'subscription', …(2) } to be null`, received
  `{ id: "<tenant B's subscription>", kind: "subscription", state: "open" }` — the foreign target
  is pinned on A's owner's row.
- **P3** fails at `notification-actions.test.ts:1796` with
  `AssertionError: expected [ { key: 'pay_now', …(3) } ] to deeply equal []`, received one action
  `{ key: "pay_now", label: "Pay now", state: "available", style: "primary" }`.
- **P5** fails at `notification-actions.test.ts:1833` with the same
  `expected [ { key: 'pay_now', …(3) } ] to deeply equal []`.
- **P2 and P4 pass on arrival** (`25 passed`) because they pin the shipped `A1` behaviour; they are
  the controls and are declared green here so a future reader does not mistake them for untested
  requirements.

Every failure is an assertion-level failure on the served projection: the row exists, the audience
resolved, the emit is the real one, and only the affordance is wrong.

### 2. The delegate's refusal, measured at the same head

A throwaway copy of the spec with one measurement `describe` appended (run, then deleted; never in
the diff) drove each arm's row through `actOnNotification`:

```
F1  row: actionTarget {id: "<tenant B's subscription>", kind: "subscription", state: "open"},
         actions [pay_now]            → click 403 {"error":{"code":"forbidden", ...}}
F2  row (mandateStatus $unset): actionTarget {...}, actions [pay_now]
                                      → click 500 {"error":{"code":"internal_error", ...}}
         cause: ZodError invalid_value, path ["mandateStatus"], at charge-outstanding.ts:132
F2b row (tenantId ObjectId):     actionTarget {...}, actions [pay_now]
                                      → click 500 {"error":{"code":"internal_error", ...}}
         cause: ZodError invalid_type, "Invalid input: expected string, received ObjectId",
                path ["tenantId"], at charge-outstanding.ts:132
```

So each pinned shape is a control the delegate refuses — `403` for F1, `500` for both F2 arms — which
is exactly the class §4.1 forbids and the reason the pins assert "no action" rather than a state.

### 3. Green on arrival

`P2` (`own tenant`) and `P4` (`unmodified row`) pass against `0c084248`; they are the two control
arms, green by design, and each names in its own case why it exists.

## Assumptions

- **A1 — a null scope still serves the row.** When `buildActions` resolves no scope it returns
  `actionTarget: null, actions: []` (`fan-out.ts:526-531`); the shipped `A3` measures the same
  served shape for a non-owner billing contact, so the pins reuse it rather than a new wire format.
- **A2 — the event's audience is the event's tenant.** The foreign-tenant arm also pins that B's
  owner gets no row (ADR-0942 §4.4). The row that must lose its button is A's, not B's.
- **A3 — P5 is pinned from the delegate's own parser, not from a "both shapes" reading of the
  applier.** `webhook-projection.ts:359-367` documents both stored shapes for the **applier**; the
  delegate's schema accepts only the string, so the producer must not offer a key for the `ObjectId`
  shape. Both readings agree that the row must emit no action; they differ only if a future fix
  normalises the stored value, which would still leave the delegate unable to charge it.
- **A4 — the controls are shipped behaviour.** P2/P4 duplicate no assertion the shipped `A1` does not
  already make; they are the price of making P1/P3/P5 non-vacuous.
- **A5 — the harness is the file's own.** `seedBillingWorkspace`, `emitDomainEvent`,
  `runNotificationFanOut`, `mongoRecipientRepository`, the feed `GET` and the action `POST` are the
  shipped harness; the two new local helpers only bind those calls.

## Out of scope

- **The delegate's refusal shapes.** `charge-outstanding.ts` still answers `403` to a foreign
  subscription and `500` to an unparseable row. Both are recorded here and are **not** this card's
  deliverable; its GREEN card `t_a587119c` records the `500` half as "out of scope, recorded not
  fixed".
- **The fix itself.** This record pins; the sibling GREEN scopes the read (both stored shapes) and
  replaces the narrower schema with the delegate's own acceptance.
- **The rendered UI.** `state: "unavailable"` and the button copy belong to the shipped `A4`/`A5`
  pins and are untouched.

## Consequences

- The GREEN cannot pass by widening the deformation: any fix that keeps reading a foreign
  subscription, or keeps a parser looser than the delegate's, leaves one of P1/P3/P5 red.
- A legitimate refactor of `resolveActionScope` that preserves "no action for a foreign or
  unparseable row" breaks none of these cases, because they assert only the served row.
- If a future producer legitimately emits a cross-tenant `subjectRef`, it must first change the
  delegate and these pins in the same PR; the pins deliberately forbid the current asymmetry.
- **Hotspot:** `docs/adr/README.md` (row `0948`, cell `0949`), which the sibling OP-140 cards also
  append to — merge as a union keeping the higher cell.
