# ADR-0978 — OP-101: the self-serve downgrade request emits `billing.plan.downgrade_scheduled`, and the billing contact receives it

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 follow-up decision `t_d421271e` (openpic-orchestrator) · **Branch:** `OP-101-task-adr0978-downgrade-scheduled-event` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_d421271e`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0978` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted), allocator-assigned in this card's body and re-verified by the four-surface sweep at this cut; the four pool-mirror cells read `0976` and advance to `0979`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`, `DELETE …/billing/scheduled-change`), §7.7; schema §18.3 (`domainEvents`), §19.1 (`notificationTypes`), §20.2 (`auditLogs`); notification design §2 (audiences), §4.3 (billing matrix)
- **Relates to:** [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) (§Decision D7 routed this gap, §D9 the request writes no audit row), [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D4 log lines stay), [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) / [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) / [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the member lane, untouched), [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the two billing jobs), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) settled where `subscription.downgraded` is written — at the **transition**, by `runScheduledPlanChanges` and `runDunning` — and routed, not absorbed, the gap this record decides (its §D7): after a self-serve downgrade request the requester is durable nowhere.

Measured on `origin/main` `1d326367`:

- Contract §3.3 (`docs/API Contract.md:1160`): "`200` → `{ "scheduledChange": … }`. **Emits `billing.plan.downgrade_scheduled`**; the cron sweep emits `billing.plan.downgrade_applied` on the effective date."
- The catalogue and the matrix both carry the key: `notification-types.values.ts:415` (`channels: [true, true, false]` = in-app and email, `transactional: true`, `optOutAllowed: false`, `NO_THROTTLE`, audience `BILLING`), and design §4.3 (`docs/Notification and Database Design.md:141`: in-app ✅, email ✅, mobile ➖, "Lists what will be constrained next period"). The templates are derived from the catalogue, one per enabled group (`notification-templates.values.ts:148-153`), so the copy for this key already exists.
- `apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts` imports no `@/server/domain/domain-events` and calls no `emitDomainEvent`. Its only write is `subscriptions.updateOne` (`:156`) setting `scheduledChange` (`:160-166`); its only record of the act is `getLogger().info("billing plan downgrade scheduled", …)` (`:170`), and that line carries a field _named_ `event` whose value is the catalogue key (`:171`) — a log field, not an emission.
- `apps/web/src/app/api/v1/tenants/[tenantId]/billing/upgrade/route.ts` is the only tenant billing route that emits: `withTransaction` at `:314`, `emitDomainEvent` at `:387` with `actorRef: {kind: "user", id: actor}` (`:391`, `actor = scope.userId` at `:218`) and `subjectRef: {kind: "subscription", …}`. This is the shipped shape a downgrade emission should take.
- So after a self-serve downgrade: `scheduledChange` carries the fixed reason `self_downgrade` and no actor, `statusHistory` gets no entry, no `domainEvents` row exists, and the log line has no retention, no tenant index and no query surface. `DELETE …/billing/scheduled-change` (`scheduled-change/route.ts:44`) is symmetric — it clears the intent and records neither actor nor event.

**The premise the card carries is one half short, and the measurement decides the record.** The card's option 1 says the route "(and `DELETE …/billing/scheduled-change`) call `emitDomainEvent` … with the catalogue key". There is no catalogue key for a cancellation: §4.3 lists `billing.plan.downgrade_scheduled` and `billing.plan.downgrade_applied` and nothing else; the DELETE route's log line uses `billing.plan.scheduled_change_cancelled` (`:47`), which is **not** in `notification-types.values.ts`; and `emitDomainEvent` refuses any key outside the catalogue (`domain-events.ts:173`, `:317-321`). The DELETE half of option 1 is therefore not implementable as written.

**And emission alone does not deliver.** The `billing_contact` audience is resolved and then the actor is removed unconditionally: `resolveRecipients` adds `getBillingContactUserId` (`fan-out.ts:400`) and then `if (actorUserId !== null) { … splice … }` (`:417-421`); `processEvent` re-adds a subject only when `subjectRef.kind === "user"` (`:1377`, `:1408-1412`), and this event's subject is the subscription. `provisioning.ts:162` sets `billingContactUserId` to the owner, and design §2 says the field "Equals the owner today" (`:76`). A throwaway probe over the real seeded catalogue and the in-memory transport, on the shipped fan-out (three cases, no production change):

```
P1  actor == billing contact (provisioning's default)   notifications 0  dispatches 0  outbound 0
P2  actor == system (control)                           notifications 1  dispatch email 1 (delivered)
P3  actor != billing contact                            the contact row only; the actor none
```

So an emission with the caller as `actorRef` reaches **nobody** in the normal case — while `billing.plan.upgraded`, emitted today at `upgrade/route.ts:387` with the same audience and the same user actor, is suppressed for the owner by the same code path. The design doc puts "minus the actor" only on the event-lifecycle audiences (§4.5, `:159`); §4.3 says "Recipient always the **billing contact**. Never co-organizers." (`:127`) and names no actor exclusion. The billing contact is the payer: the record of their own action is theirs to receive.

## Decision

**Option 1, both halves: emit the event on the request, and let the billing contact receive their own confirmation. No audit row is written for the request.**

**D1 — `POST …/billing/downgrade` emits, inside the write's transaction.** The handler wraps the existing `subscriptions.updateOne` and one `emitDomainEvent` call in a single `withTransaction` callback, `{ session }` on both, following `upgrade/route.ts:314`/`:387`. Emission outside the transaction is rejected: an event about a schedule that never stored would notify a plan change that does not exist, and a stored schedule with no event is the silence this record closes; §18.3's outbox is written with the state change so an aborted write leaves neither.

**D2 — the exact event.** One row per accepted request:

```
eventKey   billing.plan.downgrade_scheduled
tenantId   the workspace hex string
actorRef   { kind: "user", id: scope.userId }            // requireTenantScope returns the caller (route-scope.ts:51)
subjectRef { kind: "subscription", id: current._id.toHexString() }
payload    { fromPlanKey, toPlanKey, effectiveAt }       // strings only; effectiveAt ISO 8601
dedupeKey  billing.plan.downgrade_scheduled:<subscriptionId>:<toPlanKey>:<effectiveAt ISO>
```

The dedupe key mirrors the sibling producer's `billing.plan.downgrade_applied:<subscriptionId>:<toPlanKey>` (`scheduled-plan-changes.ts:132`) with the effective instant added, so a repeated request for the same target and date is dropped by the unique index (`domain_events_dedupe_unique`) while a re-schedule to a later period is a new intent and speaks again. The payload carries no `actionUrl`: this repository ships one page (`apps/web/src/app/page.tsx`) and no billing screen, so no URL can be named; the seeded copy declares `{{actionUrl}}` and the fan-out renders an undeclared variable as the empty string (`renderVarsFor`, `fan-out.ts:486-488`), exactly the state `billing.plan.downgrade_applied` ships in today (`scheduled-plan-changes.ts:131` carries no `actionUrl`). When a billing page exists, the payload gains the link.

**D3 — the billing contact receives it, including when they are the actor.** The actor exclusion is not applied to an id resolved from the `billing_contact` audience. The rule is audience-scoped, not `typeKey`-scoped: `billing_contact` names the payer, §4.3 names them as the recipient with no actor exclusion, and a confirmation the payer never receives is the defect this card measured. Observable effect, in the probe's terms: P1 becomes one in-app row plus one email dispatch to the owner, and `billing.plan.upgraded` starts reaching the owner it has always been meant for. Nothing else moves: P3 keeps its answer (the other contact is served, the actor is not), and `billing.payment.failed` (system actor) is unaffected.

**D4 — the request gets no `auditLogs` row, and `domainEvents` is the intended home.** `domainEvents` is the "transactional outbox + business log" (§18.3) — tenant-indexed, `actorRef`/`subjectRef`-addressed, 180 days. That is enough for a schedule whose whole life is at most one billing period, and the transition that matters for §20.2 keeps its 400-day row with `reason: self_downgrade` (ADR-0975 §D5, §D9). A request row is rejected on vocabulary and on honesty:

- §20.2's scope sentence is "billing **state changes**", and every member is a completed fact (`plan.price.updated`, `member.removed`, `member.role_changed`, `subscription.downgraded`, `dsr.executed`). A schedule is cancellable intent — three shipped paths clear `scheduledChange` without applying it (ADR-0975 §Context).
- A `subscription.downgrade_scheduled` member would need a `subscription.downgrade_cancelled` twin to stay true; without it the 400-day trail would end on a row asserting a pending change that no longer exists — the same lie ADR-0975 §D2 refused one field over.
- Adding both members is two new actions on a deliberately narrow union, plus two transaction-scoped writes, for a self-serve intent whose actor is already recorded. That is a schema decision with a named need, and no such need exists today.

**Accepted loss, stated:** after 180 days `audit_logs` can still say the plan was reduced at a user's request (`reason: self_downgrade`) but cannot name the human; only the membership audit rows and the tenant's owner-only write rule bound who could have done it. **Reversal condition:** if a dispute ever needs the requester beyond 180 days, widen §20.2 by **both** members in one record — never one.

**D5 — `DELETE …/billing/scheduled-change` stays log-only, and that is not a gap.** §3.3 promises no emission on the cancel; the catalogue and matrix carry no cancellation type; the log line `billing.plan.scheduled_change_cancelled` (`:47`) is an operator tail, not a registered key. The cancellation is the caller's own act and restores the status quo — there is nothing for the payer to be told that they did not just do. If product later wants a cancellation notice, it is a contract change: add `billing.plan.downgrade_cancelled` to §4.3 and the catalogue (templates follow), and emit it inside the route's own transaction under the same D1 rule.

**D6 — the log line stays, and its field name is a trap worth recording.** `billing plan downgrade scheduled` keeps answering the operator tail (ADR-0970 §D4, ADR-0975 §D8); the row is the durable record. The line's `event: "billing.plan.downgrade_scheduled"` (`:171`) reads like an emission to a grep and is not one; the invariant remains "`emitDomainEvent` is the only door to the outbox" (`domain-events.ts` module doc).

**D7 — boundary.** This record changes no production code. The RED and GREEN that follow own `downgrade/route.ts`, `notifications/fan-out.ts` and their specs. `scheduled-change/route.ts` is untouched (D5); the transition rows of ADR-0975 and the cards that own them (`t_e3bb5425`, `t_6634feb1`) are not overlapped.

## Consequences

- **RED card** (testcase-writer), then **GREEN** (backend-coder) gated on it, one `OP-101-task-…` branch and one PR carrying both:
  - one `domainEvents` row after a `200`, with exactly the D2 key, actor, subject, payload key set, `dedupeKey`, and `expireAt - occurredAt === 180 days` (read the settings, do not hard-code);
  - a repeated request for the same target and date leaves one row (dedupe), a request for a different target or date leaves a second;
  - a refused `domain_events` insert leaves `scheduledChange` unset and answers `500` (the ADR-0974 stub recipe: driver `code: 91`, no transient label), and the same call with the stub restored answers `200` with one row — the atomicity half;
  - delivery: requester == billing contact gets one in-app row and one email dispatch; a different billing contact gets it and the actor does not; a `system`-actor control still delivers;
  - a successful request writes **no** `auditLogs` row (characterization, green on arrival, and it must stay).
- **The fan-out docblock changes with D3**, and the change is audience-scoped so the `billing.payment.failed` producer and the event-lifecycle rules are untouched.
- **No document edit outside this record and the ledger.** §3.3 was right; the catalogue and the matrix were right; §20.2 needs no member (D4).
- **Cost:** one insert and one transaction per owner-only request — not a hot path — and one in-app row plus one email per accepted request, which is the matrix's own promise.
- **`billing.plan.upgraded` starts being delivered** to the billing contact as a side effect of D3. That is the matrix's intent, not a regression; the GREEN's PR body states it.

## Alternatives considered

- **Option 2 — amend §3.3 to drop the emission (rejected).** It deletes a documented API promise, deletes a designed matrix row and a catalogue key with generated copy, leaves the requester durable nowhere, and still leaves `billing.plan.downgrade_applied` arriving thirty days later with no confirmation ever sent. Three documents edited to remove a capability is not the cheap half of this decision.
- **Emit with a `system` actor to dodge the actor exclusion (rejected).** It would deliver, and it would misstate who asked — the attribution this card exists to restore.
- **Emit outside the transaction (rejected).** See D1; the upgrade route already shows the correct shape.
- **Emit and accept zero delivery when the owner is the billing contact (rejected).** §3.3 would be satisfied on paper while the matrix's in-app + email promise stayed false for the payer — the measured gap moves, it does not close.
- **Emit on `DELETE` with the log line's key (rejected).** Not a registered key; the gate refuses it (`domain-events.ts:317`), and minting a type is a product/contract decision (D5 names the path if it is ever wanted).
- **Write an audit row for the request, with or without a cancelling twin (rejected).** D4's vocabulary and honesty reasons; the outbox is the business log and already carries the actor.
- **Route the `billing.plan.upgraded` suppression separately (rejected).** D3 is one audience-scoped rule; splitting it would leave one confirmation delivered and its sibling silent.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18), so this record draws from the `unallocated (future lanes)` cursor. The card assigned `0978`; it was held by no ref at this cut.

```
$ git rev-parse --short origin/main                                   1d326367
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -3
                                                                      0973 0974 0975
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -c ADR-0978
                                                                      0
$ for d in .worktrees/*/; do ls "$d/docs/adr" 2>/dev/null | grep -oE 'ADR-09(7[6-9])'; done
                                                                      (nothing)
$ gh pr list --state open --json number,headRefName                     #902, #896
$ git ls-tree -r --name-only f130797f -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -1
                                                                      0974
$ git ls-tree -r --name-only 3aa0b048 -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -1
                                                                      0973
$ git rev-list --objects --all | grep -c 'ADR-0978'                   0
$ python3 <read-only board probe, non-done cards>
t_e3bb5425  running  Consumes: 0976
t_6634feb1  todo     Consumes: 0977
t_d421271e  running  Consumes: 0978   (this card)
# no other non-done card holds a 09xx number
```

The four cells that read `0976` — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)` — advance to **`0979`** (forward only; no cell is lowered and no range is re-cut).

## Evidence

The request-side silence, re-measured at `1d326367` (the card's figures at `d2a5467b` did not move):

```
$ grep -n 'emitDomainEvent\|domain-events' \
    "apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts"
(nothing)
$ grep -n 'updateOne\|getLogger' "apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts"
156:    await subscriptions.updateOne(
170:    getLogger().info("billing plan downgrade scheduled", {
171:      event: "billing.plan.downgrade_scheduled",
$ grep -rl 'domain-events' "apps/web/src/app/api/v1/tenants/[tenantId]/billing"
…/upgrade/route.ts
```

The delivery gap, measured by a throwaway spec over the real seeded catalogue, the real `runNotificationFanOut` and the in-memory transport (deleted after the run; no production file touched):

```
P1 actor == billing contact → notifications 0, dispatches 0, outbound 0        (provisioning's default)
P2 actor == system          → notifications 1, one email dispatch delivered     (control: the type and copy are live)
P3 actor != billing contact → the contact's row only                            (the actor is still excluded)
```

The code that produces it:

```
fan-out.ts:400    add(await repository.getBillingContactUserId({ tenantId }))
fan-out.ts:417    if (actorUserId !== null) { … splice the actor out … }
fan-out.ts:1377   const subjectUserId = event.subjectRef.kind === "user" ? … : null
fan-out.ts:1408   const subjectAlwaysNotified = typeRow.dedupe.keyTemplate === null
provisioning.ts:162   billingContactUserId: userId
Notification and Database Design.md:76   "Equals the owner today"
Notification and Database Design.md:127  "Recipient always the billing contact. Never co-organizers."
```

The producer shape this record copies (`upgrade/route.ts:314`/`:387`) and the key catalogue / copy the emission makes real (`notification-types.values.ts:415`, `Notification and Database Design.md:141`, templates derived at `notification-templates.values.ts:148-153`), plus the audit boundary this record leaves closed: §20.2's union and scope (`Notification and Database Design.md:2028-2041`) and ADR-0975 §D7/§D9.
