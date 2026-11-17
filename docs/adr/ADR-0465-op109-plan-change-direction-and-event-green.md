# ADR-0465 — OP-109 follow-up GREEN B: the `billing.plan.upgraded` emit, the downgrade direction guard and the Cashfree manage-response shape

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-109 follow-up GREEN B (`t_f5df9fe6`) · **Branch:** `OP-109-task-plan-change-direction-and-event` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4079f630`
- **Relates to:** [ADR-0464](ADR-0464-op109-plan-change-direction-and-event-pins.md) (the RED pins this GREEN turns green), [ADR-0460](ADR-0460-op109-plan-change-red.md) (the RED contract), [ADR-0461](ADR-0461-op109-plan-change-green.md) (the shipped implementation), [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) (§3 — the missing-`currentPeriodEnd` fallback stays an open product question), [ADR-0421](ADR-0421-op107-checkout-green.md) (the append-a-`BILLING_*`-code precedent), [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox — `emitDomainEvent` is the only write door), [ADR-0380](ADR-0380-op105-payment-provider-port-red.md)/[ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the adapter's wire-schema boundary)
- **Contract:** §3.3 (upgrade/downgrade), §7.7 (domain events), §10.1.1/§10.1.2 (the vendor vocabulary) · **Schema:** §14.3 (subscriptions), §18.3 (domain_events) · **Design:** §4 (the `billing.plan.upgraded` notification row)

## Context

The three gaps [ADR-0464](ADR-0464-op109-plan-change-direction-and-event-pins.md)
pinned as RED are now implementation work:

- **F1** — §3.3 requires `billing.plan.upgraded` on a successful upgrade
  (`docs/API Contract.md:1115`), but the merged route only wrote the
  `billing.plan.upgrade_started` info log. The type is registered
  (`notification-types.values.ts`) with no emitter, so design §4's
  in-app + email row never fires.
- **F2** — `POST …/billing/downgrade` never compared tiers: a higher target was
  answered `200` and written as a `self_downgrade`, which OP-111's sweep would
  then apply with no charge and no re-authorization.
- **F4** — `cancelMandate` parsed the vendor's Manage response with the **Create**
  response schema, which requires `auth_link`; the real v2025-01-01 Manage
  response (Cashfree's `SubscriptionEntity`) carries no such field.

**F5** (a live row with no `currentPeriodEnd` schedules at `now`) stays the open
product question [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) §3
already records; its pin is a characterisation of shipped behaviour and is
**unchanged** by this card (§5).

## Decision

### 1. The upgrade emits `billing.plan.upgraded` inside the transaction

`upgrade/route.ts` calls `emitDomainEvent` **inside** the existing
`withTransaction` callback, after the replacement row is inserted, passing the
same `{ db, session }` seams `webhook-projection.ts` uses:

| Field        | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `eventKey`   | `"billing.plan.upgraded"` (a registered `NOTIFICATION_TYPE_KEYS` row) |
| `tenantId`   | the workspace's string hex id                                         |
| `actorRef`   | `{ kind: "user", id: <actor> }`                                       |
| `subjectRef` | `{ kind: "subscription", id: <new subscription id> }`                 |
| `payload`    | `{ fromPlanKey: <current plan key>, toPlanKey: <target plan key> }`   |

Emit **inside** the transaction, not via `after()`, for two reasons the pin
enforces: the outbox row must exist when the handler's promise resolves (the pin
reads `domain_events` immediately), and the event commits atomically with the
state change it describes — the invariant `domain-events.ts` states for the
outbox. A replayed `Idempotency-Key` is short-circuited by §0.9's idempotency
stage before the handler, so a replay never emits a second event; **one policy
change, one event**.

The existing `billing plan upgraded` info log is kept.

### 2. A downgrade target that is not strictly lower is `422 not_a_downgrade`

`downgrade/route.ts` now imports `comparePlanTiers` and refuses **before any
write**, immediately after the live plan is resolved:

- `comparePlanTiers(currentPlan.tierRank, targetPlan.tierRank) !== "downgrade"`
  (so an **equal** rank is refused too) → `appError("not_a_downgrade", { details: { currentTierRank, targetTierRank, upgradeUrl } })`.
- `upgradeUrl` names `/api/v1/tenants/{tenantId}/billing/upgrade` — the endpoint
  that _can_ serve the request, the mirror of `not_an_upgrade`'s `downgradeUrl`.

Refusal writes **nothing** (`scheduledChange` stays `null`, `status` and
`activePlanKey` unchanged) and calls no provider. The code is appended — never
inserted — to the closed `BILLING_ERROR_CODES` set in `@openpic/contracts` and
to the `BILLING_ERROR_TRANSPORT` table (`422`, `retryable: false`) in the
ADR-0421 shape; `ERROR_CATALOG` (the exact base Appendix A copy) is untouched.
The direction guard runs before the `acknowledgement_required` check, so a
non-lower target is refused for what it _is_, not for an unacknowledged
consequence list it would never have.

### 3. The Manage response is parsed with the status shape

`cancelMandate` in `cashfree-provider.ts` now parses the Manage response with
`cashfreeSubscriptionStatusResponseSchema` — the same shape `fetchStatus` uses,
whose required field set (`subscription_expiry_time`,
`subscription_first_charge_time`, `next_schedule_date`) is exactly the Manage
entity's and is **not** satisfiable by a create-shaped body. The shared `call`
helper already raises `UpstreamContractError` and logs
`payments.upstream_contract_violation` with `operation` on a schema miss, so the
create-only shape is refused explicitly rather than silently trusted. No new
schema file is needed; the create schema is still used by `createMandate`.

### 4. What this card does **not** change

- No test, mock, fixture or factory is edited: the two lane specs are
  byte-identical to the pins head (F1/F2/F4 assertions frozen).
- `ERROR_CATALOG` is untouched; the new code lives only in the billing table.
- Owner-only enforcement on the three routes is unchanged; the refusal leaks no
  other tenant's data (it names only the caller's own two ranks).

### 5. F5 stays an open product question

The `downgrade/route.ts` `effectiveAt = currentPeriodEnd ?? now` fallback is
**not** changed. ADR-0464 §5 / ADR-0462 §3 already record the §3.3
contradiction, and the surviving pin (`F5: a live row with no currentPeriodEnd
schedules the change at now…`) pins today's behaviour as characterisation. The
product owner still owes the decision (refuse, or schedule at `now`
consciously); until then the fallback remains a named, mutation-proven pin.

## Consequences

- The three RED pins pass with the spec files **byte-identical**; `git diff`
  shows no `apps/web/src/test/**` change.
- Evidence at the head: the two lane integration specs **37 passed (37)**; full
  integration **82 files / 645 passed**; full unit **112 files / 1955 passed |
  3 skipped**; `test:coverage` (both projects, thresholds enforced) exit `0`
  with global branches `81.62 %` (no threshold weakened, the branch gate keeps
  its headroom); `tsc` clean on all three projects; ESLint 0 errors and
  `prettier --check` clean on the touched files.
- `billing.plan.upgraded` now leaves the outbox, so the §4 notification fan-out
  owns a real event to deliver; the event and the subscription write commit
  together.
- **Number allocation.** The lane's cell read `0465` in `docs/adr/README.md` at
  the branch cut (immediately before committing), so this record takes `0465`
  and advances `OP-109 plan-change lane` to `0466`. No number outside
  `0460`–`0479` is touched and no other lane's row is renumbered.
