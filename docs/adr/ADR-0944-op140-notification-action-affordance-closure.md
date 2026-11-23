# ADR-0944 — OP-140 GREEN: the feed affordance closes after a non-invitation action

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_8d9e090c` (OP-140 GREEN, Medium, phase 6-M2M · epic Notifications) — makes the pins of
  `t_b8461910` green (finding **F1** of the round-1 review of PR
  [#810](https://github.com/yahodu/openpic-webapp/pull/810), landing as PR
  [#818](https://github.com/yahodu/openpic-webapp/pull/818))
- **Branch:** `OP-140-feature-notification-action-affordance-closure` (cut from `02389b12`, carrying
  the pins commit `a18502b9` unchanged, then `origin/main` `ac075316` merged before the push, so one
  squash lands the pins, this record and the change). **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_5d080821`
- **Touches:** one **new** production module
  (`apps/web/src/server/notifications/action-affordance.ts`: one `updateMany`), one thin wrapper
  (`apps/web/src/server/collaboration/invitation-transition.ts`: `closeInvitationAffordance` delegates
  to it, signature and call sites unchanged), one route change
  (`apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts`: the row's own `kind`
  is threaded into `delegateAction` and the closure runs after the `retry_charge` arm), plus this
  record and its ledger row and cell. **No test, factory, fixture, helper or harness file is in the
  diff.**
- **ADR number:** `0944` — the `OP-140 notifications lane` row's own cell. `0943` was reserved for this
  card by `t_d08eeb7f` when the highest record in existence was `0942`, but the trunk consumed `0943`
  in flight (`ADR-0943-op140-notification-action-residual-pins.md`, card `t_b4c8f1d9`, landed on
  `origin/main` `ac075316`), so this record takes the higher of the trunk's cell and one more than the
  highest number consumed in the lane — both read `0944` — and advances the cell to `0945`. No cell is
  lowered and the `0942`–`0961` range is unchanged.
- **Consumes:** [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) (the endpoint, its
  `delegateAction` seam and the §7.3 nine-key body),
  [ADR-0943](ADR-0943-op140-notification-action-residual-pins.md) (the residual pins on the same
  endpoint, and the number this card's reservation collided with), and
  [ADR-0664](ADR-0664-op121-invitation-decisions-green.md) (the shipped invitation decision and its
  transactional closure).

## Context

Contract §2.3 rule 3 says that after **any** successful transition the server runs the `notifications`
fan-out, so the same decision is closed in every channel and on every device on the next poll; §7.3
repeats it ("closed in every channel"). The endpoint honoured that for one of its seven rows only.

`decideInvitation` called `closeInvitationAffordance` inside its transaction
(`invitation-transition.ts`), so an `accept`/`reject` closed the feed row. `startOutstandingCharge`
(`charge-outstanding.ts`) closed nothing, so after `POST …/actions/pay_now` answered
`outcome: "applied"` the row still served `state: "available"` and `actionTarget.state: "open"`.

The gap was measured on trunk `521e305b` and pinned on the parent card as two new arms
(`notification-action-affordance.test.ts` `A1`/`A2`, red as `Cannot find package` and as
`expected 'available' to be 'unavailable'`) plus two route arms in the shipped
`notification-actions.test.ts` (`A3` at the stored row and the feed, `A4` on a replay).

## Decision

### 1. One kind-generic write owns the closure

`@/server/notifications/action-affordance` exports

```ts
closeActionAffordance(
  db: Db,
  target: { readonly kind: string; readonly id: string },
  now: Date,
  options?: { readonly via?: string; readonly session?: ClientSession }
): Promise<void>
```

and does exactly one `updateMany` on `COLLECTIONS.notifications`, filtered on the **pair**
`{"actionTarget.kind", "actionTarget.id"}`, setting `actions.$[].state: "unavailable"`,
`actionTarget.state: "resolved"`, `actionResolvedAt: now`, `updatedAt: now`, and `actionResolvedVia`
only when `via` is given; `options.session` is passed through so a caller inside a transaction keeps
its atomicity.

The helper is kind-generic because §7.3's promise is not per kind: the same row shape carries every
target, and a per-kind switch would make the next delegate arm (and the two after it) repeat a write
that only differs in a string. The filter is the pair, not the id or the kind alone — ids are unique
in practice, but "the kind is part of the key" is the schema's own statement (`actionTarget` is
`{kind, id, state}`) and a kind-only filter would close a sibling row of another kind that reused an
id.

The write is denormalised convenience, never authoritative: the target's own document stays the source
of truth, which is why the endpoint re-reads the row after the delegation and why a stale `available`
never short-circuits a decision (ADR-0942 `I3`'s `410` still comes from the owning document).

### 2. The invitation arm keeps everything it had

`closeInvitationAffordance` keeps its export, signature and call sites and becomes a thin wrapper
calling the helper with `{kind: "invitation", id: invitationId}`; it stays **inside** the decision
transaction on both arms (`transition()`), so a failed decision still leaves the invitation pending and
every affordance usable. The channel it is given (`in_app`/`email`/`sms`) is still recorded as
`actionResolvedVia`. The one behavioural difference is that the helper now writes `actionResolvedAt`
even when no channel is given; the revoke path (which passes none) gains the instant and loses nothing
it recorded before.

### 3. The `retry_charge` arm closes after a real transition only

`delegateAction` receives the row's own `actionTarget.kind` and, after `startOutstandingCharge`
answers `charged` or a replay, calls the helper with that kind and `target.id` before returning. So
`applied` and `already_resolved` both leave the row closed — a replay must not reopen what the first
click closed (pin `A4`) — while a delegate that throws (`403`, `409`, `410`, `502`) or the
`unavailable` rows reach no closure at all.

The closure lives in the **route**, not in `startOutstandingCharge`: the charge service is also called
by `POST /tenants/{t}/billing/retry-charge`, which owns no feed row and whose notification fan-out is
not in this card's scope; the §7.3 fan-out belongs to the endpoint that knows which row was clicked.
The kind is threaded from the row instead of hard-coded to `"subscription"`, so the next delegate arm
inherits the closure by adding one call, not by editing a literal.

### 4. What each path keeps

| Path              | Closure       | Transaction | `actionResolvedVia`  | `actionResolvedAt` |
| ----------------- | ------------- | ----------- | -------------------- | ------------------ |
| invitation decide | shared helper | yes         | the decision channel | yes                |
| `retry_charge`    | shared helper | no          | **never invented**   | yes                |

No channel is invented for `pay_now`: the endpoint knows the instant, not a decision channel, so
`actionResolvedVia` stays absent and the response serves `resolvedVia: null` (pin `A3`'s
`hasOwnProperty` assertion).

## Evidence

Measured on the pins head `a18502b9` and on this head, same commands:

- focused (`notification-action-affordance.test.ts` + `notification-actions.test.ts`): `2 failed | 16
passed (18)` before, **`20 passed (20)`** after.
- whole `unit` project: **`194` files `3261 passed | 3 skipped (3264)`**.
- whole `integration` project: **`159` files `1692 passed (1692)`** (measured after the pre-push
  merge of `origin/main` `fcba6748`, whose DSR pin adds one case to the `1691` this lane measured on
  its own head).
- `tsc -p tsconfig.json --noEmit` exit `0`; `eslint` 0 errors on the three touched files;
  `prettier --check` clean.
- The seven `adr-*` guards and the duplicate-number scan
  (`git ls-tree -r --name-only HEAD -- docs/adr | grep -oE 'ADR-[0-9]{4}' | sort | uniq -d` → empty)
  are recorded in the PR handoff comment.

The write's shape is pinned by the parent's measurement, not by this card: a kind-only filter reds
`A1` (the sibling subscription row closes), dropping `actions.$[].state` reds `A1`
(`['available','available']`), writing `actionResolvedVia` unconditionally reds `A3` (`expected true to
be false`), an unfiltered `updateMany({})` reds `A1`, and a route that closes inline instead of
through the helper stays green — which is why the shared helper is a recorded decision and not a
convenience.

## Consequences

- Every successful `pay_now` now closes the caller's row in every channel after the delegation, so the
  next `GET /me/notifications` serves the same decision one click later could not repeat.
- The invitation arm's write is the same write, so the two arms can no longer drift.
- The remaining five §7.3 rows (`checkout_url`, `reprocess_failed`, `policy_acknowledge`,
  `extend_upload_window`, `selfie_redirect`) still answer `unavailable` and still close nothing: they
  have no extracted domain service on the trunk and stay deferred per `t_d08eeb7f`. Each one inherits
  the closure by calling the helper after its own successful transition.
- A non-invitation, non-`retry_charge` transition that fails leaves nothing closed, because the
  closure runs only after the delegate answered.
