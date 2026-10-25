# ADR-0482 — OP-110 follow-up TEST: the reactivation boundary pinned — a `payment_succeeded` cannot resurrect a `cancelled`/`incomplete` subscription

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up TEST (`t_ffec14e2`) · **Branch:** `OP-110-task-reactivation-boundary-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ffec14e2`
- **Relates to:** [ADR-0480](ADR-0480-op110-self-serve-billing-red.md) §5 (the widening this pin bounds), [ADR-0481](ADR-0481-op110-self-serve-billing-green.md) (the GREEN that shipped it), [ADR-0440](ADR-0440-op108-webhook-inbox-red.md) / [ADR-0443](ADR-0443-op108-concurrent-projection-ordering-green.md) (the projection this pin extends), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0306](ADR-0306-red-branch-pipeline.md) (the RED-by-design draft-PR pipeline)
- **Contract:** §3.3 (retry-charge success returns to `active`), §10.1.2 (`SUBSCRIPTION_PAYMENT_SUCCESS` projection row) · **Schema:** §14.3 (`subscriptions`) · **Appendix A.4**

## Context

The OP-110 GREEN (ADR-0481) widened the webhook projection's reactivation
predicate from `status === "downgraded"` to a bare non-active test
(`apps/web/src/server/billing/webhook-projection.ts:288`):

```ts
const reactivating = subscription.status !== "active";
```

`reactivating === true` makes the patch set `status: "active"` **and**
`activePlanKey: subscription.subscribedPlanKey`, and emit
`billing.subscription.reactivated` + `usage.limit.restored` alongside
`billing.payment.succeeded`. ADR-0480 §5 read §3.3's retry sentence as
"a `payment_succeeded` that returns a non-active row to `active` emits the
restored pair", and that reading is right about the _pair_ — but it grounds
reactivation on exactly **two** recovery paths and names no third:

- **§3.3** (`docs/API Contract.md:1167`) — the retry-charge success "returns to
  `active` with `activePlanKey = subscribedPlanKey`, emitting
  `billing.subscription.reactivated` and `usage.limit.restored`" (the
  `past_due` / `downgraded` banner);
- **§10.1.2** (`docs/API Contract.md:3165`) — the `SUBSCRIPTION_PAYMENT_SUCCESS`
  projection row: "**if previously `downgraded`** → `status: "active"`,
  `activePlanKey = subscribedPlanKey`" and the two extra events "**if recovering
  from `downgraded`**".

`cancelled` and `incomplete` are in neither. As shipped, a stray confirmation for
a cancelled workspace flips it back to `active`, restores the paid plan and
re-emits the restored-limit pair — a widening, not a restatement. This card
(round-1 review finding F2, Medium) pins that boundary.

## Decision

### 1. The reading applied: reactivation is a _recovery_, on the two paths the contract names

Reactivation is the transition **out of a recoverable dunning state** back to
`active` — `past_due` (§3.3's retry) and `downgraded` (§10.1.2's row). A
`cancelled` row is terminal by the tenant's own action, and `incomplete` is the
**pre-activation** state whose documented transition to `active` is the
activation event (`SUBSCRIPTION_AUTH_STATUS`), not a charge confirmation. Neither
is a recovery path, so a `payment_succeeded` for either must not:

1. flip `status` to `active`;
2. restore `activePlanKey` to `subscribedPlanKey`;
3. emit `billing.subscription.reactivated` / `usage.limit.restored`.

The payment itself is still recorded — the ledger row and
`billing.payment.succeeded` are unaffected by this boundary.

### 2. The pins (all in `provider-webhook-inbox.test.ts`, a new `the reactivation boundary` describe)

| Case                                                  | Seeds        | Pins                                                                                                                                                                     |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a cancelled subscription is not revived               | `cancelled`  | status stays `cancelled`; `activePlanKey` stays `free`; keys contain `billing.payment.succeeded` and **not** the restored pair                                           |
| an incomplete subscription is not revived             | `incomplete` | status stays `incomplete`; `activePlanKey` stays `free`; keys contain `billing.payment.succeeded` and **not** the restored pair                                          |
| a `past_due` subscription still reactivates (control) | `past_due`   | status → `active`; `activePlanKey` → `subscribedPlanKey` (`starter`); keys exactly `[billing.payment.succeeded, billing.subscription.reactivated, usage.limit.restored]` |

`seedSubscription` seeds `activePlanKey === subscribedPlanKey === "starter"`, so
"the active plan did not change" would be vacuous — a reactivation restores
`"starter"` and a held boundary leaves `"starter"` too. The pins therefore point
the _active_ plan at a different key (`"free"`) before the webhook, which is what
makes the `activePlanKey` assertion observable. The helper lives inside the new
describe (the no-write-exits suite keeps its own copy of `emittedKeys` for the
same reason).

### 3. This is a RED pin, not a characterisation pin — a GREEN sibling is owed

The three pins were run against the merged trunk (`2be55fb`, OP-110's PR #339
squash `7ab9780`):

```
× a payment_succeeded for a cancelled subscription does not resurrect it
    AssertionError: expected 'active' to be 'cancelled' // Object.is equality
× a payment_succeeded for an incomplete subscription does not resurrect it
    AssertionError: expected 'active' to be 'incomplete' // Object.is equality
✓ a payment_succeeded for a past_due subscription reactivates it and restores the limits
```

The `past_due` control is green as shipped and must stay green. Because two pins
are RED, this is **not** a characterisation pin: a GREEN sibling is owed. The
pins branch is published as a **draft** PR (ADR-0306) and left open for it; the
GREEN must base its branch on the pins branch, not bare `origin/main`.

### 4. The narrowest honest GREEN change

Gate the status flip, the `activePlanKey` restore and the emitted pair together
on the recovery pair the contract names:

```ts
const reactivating = ["downgraded", "past_due"].includes(subscription.status);
return {
  outcome: "applied",
  subscriptionPatch: {
    ...(reactivating ? { status: "active" } : {}),
    ...(reactivating ? { activePlanKey: subscription.subscribedPlanKey } : {}),
    pendingDueMinor: 0,
    // …
  },
  // …
  emittedKeys: reactivating
    ? ["billing.payment.succeeded", "billing.subscription.reactivated", "usage.limit.restored"]
    : ["billing.payment.succeeded"],
};
```

The shipped `subscriptionPatch` sets `status: "active"` **unconditionally**, so
gating only the predicate is not enough — the status flip must be gated too, or a
cancelled row still lands on `active` (the mutation probes below show exactly
this). The GREEN must leave the OP-110 I3 pin (`billing-self-serve.test.ts` › I3)
and OP-108's own `payment_succeeded` pins (seeded `active`) green **unedited**.

### 5. Mutation evidence — each assertion bites independently

Three one-anchor mutations were applied to `webhook-projection.ts`, the focused
describe re-run, and the production file restored byte-identically
(`sha256 c184ecc351f8edd446b8d05f30a5c764791b10788e0af1a9fdaba43f060edcf6`
before and after; `git diff` on the file empty):

| Mutation                                                                        | Observed failure                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| none (trunk)                                                                    | `expected 'active' to be 'cancelled'` / `expected 'active' to be 'incomplete'` — the **status** assertion                           |
| status gated, but `activePlanKey` + emitted pair still on `status !== "active"` | `expected 'starter' to be 'free'` — the **activePlanKey** assertion                                                                 |
| status + `activePlanKey` gated, but emitted pair still on `status !== "active"` | `expected [ 'billing.payment.succeeded', …(2) ] to not include 'billing.subscription.reactivated'` — the **emitted-keys** assertion |
| the honest fix (all three gated)                                                | all three pins **pass** (3 passed), control included                                                                                |

## Consequences

- The reactivation boundary is now executable: a future widening (or narrowing)
  of the predicate that lets `cancelled`/`incomplete` through, or that drops
  `past_due`, breaks at least one pin with a failure message that names the
  observable.
- **Not pinned (deliberately):** how a non-recovery `payment_succeeded` treats
  `currentPeriodEnd` / `gracePeriodEndsAt` / `dunning` on a `cancelled` or
  `incomplete` row. The contract is silent and the narrowest honest fix leaves
  the period fields in the patch; a GREEN that instead patches nothing for a
  non-recovery status (the refund's `subscriptionPatch: null` shape) is equally
  legitimate and passes these pins. Pinning it would over-constrain a decision
  the contract does not make.
- **Assumption resolved unilaterally:** `incomplete` is treated as _not_ a
  recovery path. A first `payment_succeeded` arriving on an `incomplete` row is
  not a documented activation route — §10.1.2's activation row is
  `SUBSCRIPTION_AUTH_STATUS` — so the pin holds the documented reading. If the
  product intends a charge confirmation to complete an `incomplete`
  subscription, that is a new contract row, not a relaxation of this pin.
- The pin is test-only: no production file is in the branch diff. Suite hygiene
  at the pins head: `tsc -p apps/web/tsconfig.json --noEmit` exit 0, `eslint`
  0 errors (the single pre-existing `security/detect-object-injection` warning on
  `webhook-projection.ts:564` is unchanged), `prettier --check` clean.

## Alternatives

- **Keep the wide `status !== "active"` predicate (ADR-0480 §5 as shipped).**
  Rejected: it lets a late/duplicate confirmation resurrect a terminal
  subscription and restore a paid plan the tenant is no longer entitled to, and
  the contract names no such path.
- **Pin only the emitted keys and leave the status flip unconstrained.**
  Rejected: the status flip is the material effect — a cancelled row reading
  `active` is the defect — so the pin asserts the status and the active plan, not
  only the events.
- **Pin the period/grace fields for a non-recovery payment.** Rejected as
  over-constraining; see Consequences.
