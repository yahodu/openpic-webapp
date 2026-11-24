# ADR-0975 — OP-101: `subscription.downgraded` is written where the plan actually changes, by the two shipped downgrade jobs — not by the schedule route

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 follow-up decision `t_7aedaced` (openpic-orchestrator) · **Branch:** `OP-101-task-billing-downgrade-audit` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7aedaced`
- **Lane:** OP-101 follow-up (audit writes) · **Consumes:** `0975` — a **pool draw** ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18: the board-wide block `0300`–`0319` is exhausted), allocator-assigned in this card's body and re-drawn from the trunk at this cut; the four pool-mirror cells read `0975` and advance to `0976`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`, `DELETE …/billing/scheduled-change`, `POST …/billing/cancel`), §9.1 (every admin mutation writes a row), §9.9 (`GET /admin/audit-logs`), §10.2 (`dunning`, `scheduled-plan-changes`); schema §20.2 (`auditLogs`), §22 (400-day TTL), §14.3 (`subscriptions.activePlanKey`, `scheduledChange`, `statusHistory`), §18.3 (`domainEvents`); `docs/Subscription flow.md` §4.3
- **Relates to:** [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D2 row shape and writer seam, §D3 the one-transaction rule, §D4 log lines stay — this record reuses all three and invents no second shape), [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) / [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) / [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the member lane's pins, implementation and reverse-half pins, all untouched), [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (the log-line pin pack), [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the two billing jobs), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/server/audit/audit-log.ts`, `apps/web/src/server/billing/jobs/scheduled-plan-changes.ts`, `apps/web/src/server/billing/jobs/dunning.ts`, `apps/web/src/test/integration/billing-crons.test.ts`, `docs/Notification and Database Design.md` §20.2

## Context

The finding is the same class as [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
§Context, one union member over, and it is a **documentation-versus-code** gap, not a
failing assertion:

- Schema §20.2 declares
  `action: "plan.price.updated" | "member.removed" | "member.role_changed" | "subscription.downgraded" | "dsr.executed"`
  with a scope sentence that names **billing state changes**, `actor.kind: "user" | "admin" | "system"`,
  `target.kind: "plan" | "event" | "user" | "subscription"`, a `reason` field, and a 400-day TTL on `expireAt`.
- `POST /api/v1/tenants/{tenantId}/billing/downgrade` is a shipped, owner-facing route
  (contract §3.3). It writes one structured **log line** — `billing plan downgrade scheduled`
  (`downgrade/route.ts:170`) — and **no** `auditLogs` document. Its only write is
  `subscriptions.updateOne` (`:156`) setting `scheduledChange` (`:160`).
- [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) decided the **membership** half
  (option 1: write the row, atomically, in the mutation's own transaction with a `user`
  actor) and routed the billing half here on purpose, so one record does not carry two
  subjects. [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) then shipped the
  seam `apps/web/src/server/audit/audit-log.ts` — `auditExpireAt` (at + 400 days),
  `requestAuditActor` (the caller id plus salted 64-hex `ipHash`/`uaHash`), and
  `writeAuditLog(session, entry)` (one `insertOne` on the caller's session).
- Nothing writes `auditLogs` for billing at this head, and nothing reads it: `GET /admin/audit-logs`
  (§9.9) is contract-only — `find apps/web/src/app -type d -name "admin*"` prints nothing.

**The premise the card carries is one site short, and the correction decides the record.**
The card offers "the downgrade route … writes an `auditLogs` row", but a self-serve
downgrade is **two** shipped transitions, not one:

1. the **request** — `POST …/billing/downgrade` stores
   `scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason: "self_downgrade" }`
   and changes no plan (`activePlanKey` is untouched, contract §3.3);
2. the **transition** — `runScheduledPlanChanges` applies it at period end
   (`scheduled-plan-changes.ts:102-116`): `$set: { activePlanKey: toPlanKey, scheduledChange: null }`,
   `returnDocument: "after"`, and emits `billing.plan.downgrade_applied` with
   `actorRef: { kind: "system", id: "scheduled-plan-changes" }` (`:125`).

And a third shipped path reduces the plan without any request at all:
`runDunning` (`dunning.ts:82-96`) moves a `past_due` subscription whose grace has run out to
`status: "downgraded"` and `activePlanKey: "free"`, and emits
`billing.subscription.downgraded` with `actorRef: { kind: "system", id: "dunning" }` (`:107`).
`docs/Subscription flow.md` §4.3 is its contract.

**Measured: a schedule is intent, and three shipped paths can erase the intent.** A
`subscription.downgraded` row written at request time would assert a transition that may
never happen, because `scheduledChange` is cleared, without ever applying, by:

```
billing/scheduled-change/route.ts:44   updateOne({cancelledAt: null}, {$set: {scheduledChange: null, updatedAt: now}})
billing/upgrade/route.ts:364           scheduledChange: null
billing/checkout/route.ts:330          scheduledChange: null
```

The product's own vocabulary keeps the two apart: §3.3 says the route "Emits
`billing.plan.downgrade_scheduled`; the cron sweep emits `billing.plan.downgrade_applied`",
and both keys exist in the notification catalogue
(`apps/web/src/server/notifications/notification-types.values.ts:415` and `:425`).
§14.3 pushes the transition into `statusHistory` with `actor: "system"` and a `reason`
(`grace_expired`, or the scheduled change's own `reason`), and caps that array at ~50
entries — so it is not the 400-day durable record §20.2 promises.

Two further measured facts constrain the shape:

- **The union's `system` actor and `reason` field are otherwise unused.** Both member-lane
  actions are `user` actions; §20.2 lists `"system"` and `reason` for exactly this class
  of transition, and both downgrade jobs already carry the actor (`{"kind": "system", id}`)
  and the reason (`scheduledChange.reason`, `grace_expired`).
- **The dunning path is pinned by a whole-database diff.** `billing-crons.test.ts:534` (`I1`)
  asserts `changedCollections(before, after)` equals exactly
  `["domain_events", "subscriptions"]`, and `dunning.ts:26-31` states the job "writes
  **nothing else**". Any audit row on that path reds `I1` — the pin must be amended
  deliberately, not discovered in CI.

**Recorded, not absorbed: the request is durable nowhere.** `POST …/billing/downgrade`
writes no `statusHistory` entry and calls no `emitDomainEvent` (measured: `upgrade/route.ts`
is the only tenant billing route that imports it), so after a self-serve downgrade request
the requester's identity exists only in a log line with no retention promise — although
contract §3.3 says the route emits `billing.plan.downgrade_scheduled`. That is a separate
defect with its own consumer (the notification matrix), and it is routed, not folded in.

## Decision

**D1 — option 1: §20.2 keeps `subscription.downgraded`, and the code writes it.** The union
is not wrong; the writer is missing. Deleting the member would delete the only documented
billing guarantee in the same week [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
kept the membership guarantee, and would leave "who moved this workspace to the free plan,
and when" answerable only against `statusHistory`'s ~50-entry cap.

**D2 — the write site is the transition, not the request.** The two shipped paths that
actually reduce `activePlanKey` write exactly one `subscription.downgraded` row each:
`runScheduledPlanChanges` (a scheduled self-downgrade reaching its effective instant) and
`runDunning` (a grace period expiring). `POST …/billing/downgrade` **keeps its log line and
writes no row**: a schedule is intent, three shipped paths can clear it (measured above),
and a row named `subscription.downgraded` written there would assert a plan change that did
not happen. No action key is invented for the request — see D7.

**D3 — one seam, widened once, no second shape.** The existing module
`apps/web/src/server/audit/audit-log.ts` is extended, so the billing rows share
[ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D2's arithmetic, fingerprinting and
key naming:

- `AuditLogAction` gains `"subscription.downgraded"`;
- `AuditLogEntry.target` becomes `{ kind: "user" | "subscription", id: string }`;
- `AuditActor` becomes a discriminated pair — `{ kind: "user", id, ipHash, uaHash }` exactly
  as shipped, and `{ kind: "system", id, ipHash: null, uaHash: null }` from a new
  `systemAuditActor(id)`. The two keys stay **present and null**, not absent, so every row
  has the key set §9.9's reader and the member pins already assert, and a system row can
  never be mistaken for an unhashed user row. A system transition has no HTTP request to
  fingerprint, so there is nothing to hash;
- `AuditLogEntry` gains an optional `reason`, written **only** when the transition carries
  one (§20.2 declares the key; the member rows from
  [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) are unchanged and must not gain
  an `undefined` key, so the writer spreads it conditionally);
- `writeAuditLog(session, entry, at = systemClock.now())` — an optional third parameter, so a
  job passes its own injected `clock.now()` and the row's `at`/`expireAt` derive from the
  same instant as the transition it records. Existing call sites are untouched.

**D4 — the row and the transition are one transaction, per candidate row.** `findOneAndUpdate`
and `writeAuditLog` run inside one `withTransaction` callback, each with `{ session }` — the
[ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D3 posture: a transition that commits
has exactly one row, and an audit insert that fails aborts the transition and answers the
app's `internal_error` path rather than applying a downgrade nobody can attribute. The
per-row transaction is one round trip on the replica set the deployment and the integration
harness already run.

**D5 — the row shapes, exactly.** Both rows narrow `before`/`after` to the field(s) the
transition changes, as [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D2 does for
membership:

```js
// scheduled self-downgrade (scheduled-plan-changes)
{ actor: { kind: "system", id: "scheduled-plan-changes", ipHash: null, uaHash: null },
  action: "subscription.downgraded",
  target: { kind: "subscription", id: subscriptionIdHex },
  tenantId,                                           // string, like domainEvents.tenantId
  before: { activePlanKey: <the plan the conditional write matched> },
  after:  { activePlanKey: toPlanKey },
  reason: <scheduledChange.reason>,                   // "self_downgrade"
  at: now, expireAt: auditExpireAt(now) }             // now = the job's clock

// dunning (grace expired)
{ actor: { kind: "system", id: "dunning", ipHash: null, uaHash: null },
  action: "subscription.downgraded",
  target: { kind: "subscription", id: subscriptionIdHex },
  tenantId,
  before: { status: "past_due", activePlanKey: <matched> },
  after:  { status: "downgraded", activePlanKey: "free" },
  reason: "grace_expired",
  at: now, expireAt: auditExpireAt(now) }
```

`before` must come from the **matched pre-image**, not from the candidate read: both jobs
switch to `returnDocument: "before"` for the conditional `findOneAndUpdate` (neither uses
the returned document beyond its null check today), so `before` is the state the write
actually replaced and a concurrent transition cannot make the row lie. `actor.id`,
`target.id` and `tenantId` are strings, `target.kind` is `"subscription"` — the two
undecided fields the card required this record to settle in agreement with
[ADR-0970](ADR-0970-op101-member-audit-logs-write.md).

**D6 — the C6 pin is amended deliberately, and the invariant is unweakened.** `I1`'s
whole-database diff becomes `["audit_logs", "domain_events", "subscriptions"]`, and the
harness clears `audit_logs` between cases beside its other `deleteMany` calls. The
invariant §10.2.1 C6 states — "dunning never touches user content" — is still proven
structurally, because the diff names **every** changed collection and the six content
collections (`events`, `eventImages`, `mediaAssets`, `imageFaces`, `faceMatches`,
`attendeeEventProfiles`) must stay absent. `audit_logs` holds no reference into any content
collection and can delete nothing, so admitting it cannot hide a C6 regression; the
`dunning.ts` docblock's "writes nothing else" sentence is corrected to name the audit row in
the same edit, and its ESLint C6 boundary (content repository namespaces only) is unchanged.

**D7 — boundary: two transitions, no new action key.** In scope: the two jobs above. Out of
scope, recorded: the schedule request (`POST …/billing/downgrade`), the schedule's
cancellation (`DELETE …/billing/scheduled-change`), immediate plan changes
(`upgrade`, `checkout`), and the payment-side state machine. The union has no member for a
scheduled or cancelled change, and this record does not invent one: `billing.plan.downgrade_scheduled`
is a **notification** key, and adding it to `auditLogs.action` would be a schema decision
with its own card. The request-side attribution gap (§Context, last paragraph) is routed as
its own card so the missing emission is fixed at its own consumer rather than pre-empted
here.

**D8 — the log lines stay.** `billing plan downgrade scheduled` (route `:170`),
`billing subscription downgraded`/`scheduled plan changes completed` (the jobs' own
completion lines), and every other structured line keep answering the operator tail; the
rows are the durable per-tenant record §9.9 reads. The two are not duplicates
([ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D4).

**D9 — accepted consequence: one row per transition, and none for a cancellation.** A
retried run writes nothing twice, because the conditional filter carries the prior state and
the loser matches zero documents (the shipped concurrency rule, `I2`). A cancelled scheduled
change writes no row at all — the union has no cancelling member (D7) — and a later
`upgrade`/`checkout` writes none either, so `action=subscription.downgraded` answers exactly
"the plan was reduced, by the system, for this reason, from this plan to that one".

## Consequences

- **Two routed cards, in TDD order.** The RED/TEST card `t_e3bb5425` pins the contract above
  (`Consumes: 0976`): one scheduled self-downgrade writes exactly one `subscription.downgraded`
  row with the system actor (`ipHash`/`uaHash` null), the subscription target, the workspace,
  `{activePlanKey}` before/after taken from the matched pre-image, the scheduled reason, and
  `expireAt - at === 400 days`; one dunning transition writes the same action with
  `{status, activePlanKey}` before/after and `reason: "grace_expired"`; a not-yet-due
  scheduled change and a not-yet-expired grace period write **none** (the anti-vacuity
  arms); an injected audit-insert failure leaves the subscription untouched (no
  `activePlanKey` move, `scheduledChange` still set, no audit row) — the
  [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D3 direction, for both job paths —
  and the amended `I1` diff still names no content collection. The GREEN card `t_6634feb1`
  (`Consumes: 0977`, parented on the RED) adds the seam widening and the two in-transaction
  calls and lands them with the pins in one squash.
- **A sibling gap is routed, not absorbed.** The missing
  `billing.plan.downgrade_scheduled` emission on `POST …/billing/downgrade` (and with it the
  requester's attribution) goes to its own decision card `t_d421271e`, so this record keeps
  one subject.
- **§20.2 needs no edit.** The union, the scope sentence, the `reason` field, the `system`
  actor and `target.kind: "subscription"` were all already declared; only the `AuditLogAction`
  TypeScript union in the seam gains the member. The schema and the code agree at the merged
  head with no docs diff.
- **The reader gap is recorded, not closed.** `GET /admin/audit-logs` stays unrouted; when it
  lands, `action=subscription.downgraded` has rows to serve for a full audit year.
- **Cost:** one insert and one transaction per applied plan change — a daily-to-hourly sweep
  over at most `limit` (500) rows, not a hot path.
- **The member lane is untouched.** `member.role_changed`/`member.removed` rows, their pins
  ([ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md),
  [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md)) and the route code stay
  byte-identical; only the seam's types widen, and both member pins assert the `user` actor's
  key set, which does not move.

## Alternatives considered

- **Option 2 — drop `subscription.downgraded` from §20.2 (rejected).** It deletes a
  documented guarantee, and the log lines carry no retention, no tenant index and no query
  surface — the exact properties §20.2's 400-day TTL exists for. It would also split the
  union's two user-reachable halves in opposite directions one day after
  [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) chose the opposite for membership.
- **Write the row in `POST …/billing/downgrade` (rejected).** Measured: a schedule can be
  cleared by three shipped paths, so the row would sometimes assert a downgrade that never
  happened; the product's own keys separate `_scheduled` from `_applied`; and the row's
  `before`/`after` would have to be `{scheduledChange}` under an action named
  `downgraded`, which is the same lie one field over.
- **Write a row at both the request and the transition (rejected).** Two rows sharing one
  action key make `action=subscription.downgraded` return a request and an application that
  a reader cannot tell apart without reading `before`/`after`, and the request row can be
  orphaned by a cancellation. The request's durability belongs to the notification contract
  it already promises (D7's routed card), not to a second audit row.
- **A best-effort insert after the transition (rejected).** The row would go missing exactly
  when the database is unhealthy — the moment an audit trail is worth having — and a
  committed downgrade with no record is the failure mode the row exists to prevent
  ([ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D3's rejected alternative).
- **An inline `insertOne` in each job instead of the seam (rejected).** Two more copies of
  the 400-day arithmetic, the fingerprint rule and the key naming — the drift
  [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D2 rejected for the members.
- **A second, `user`-actor action key for the schedule (rejected as this record's business).**
  `subscription.downgrade_scheduled` would be a new §20.2 member with its own reader
  semantics, and the durable requester record can be had from the emission §3.3 already
  promises. If the board later decides the request deserves an audit row, that is a new
  record, not a silent widening of this one.
- **Only the dunning path, leaving the scheduled transition unaudited (rejected).** Both are
  the same union member; shipping one would make `action=subscription.downgraded` answer for
  non-payment and stay silent for a self-serve change, which is the dual-mechanism defect
  this record exists to close.
- **Keep `I1` rigid and refuse the dunning row because a whole-database diff forbids a new
  collection (rejected).** The pin's claim is "no user content", and `audit_logs` is not user
  content; the diff names every changed collection, so admitting a collection that holds no
  content reference cannot hide a C6 regression. Keeping the pin textual instead of
  structural would trade the invariant's real meaning for its literal list.
- **Write a `domainEvents` row instead (rejected).** §18.3's outbox is the notification
  fan-out (180-day TTL, `eventKey` from the catalogue, dispatch flags); it is already
  written by both jobs and would fan out a second notification. §20.2's action-keyed,
  400-day, tenant-indexed collection is what §9.9 queries.

## Numbering

The board-wide / process block `0300`–`0319` is exhausted (its cell has read past the range
end since [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)), so this record
draws from the `unallocated (future lanes)` cursor
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18).

The card proposed `0973`, which was stale twice over: `0973` landed on the trunk as
[ADR-0973](ADR-0973-op134-attendee-sessions-ttl-clock.md) (the OP-134 lane), and `0974`
landed as [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (card
`t_0250ac11`, PR [#897](https://github.com/yahodu/openpic-webapp/pull/897)) while this card
was in flight — both recorded in this card's thread by the reviewers who measured them. The
re-draw at `origin/main` `d2a5467b` finds no `ADR-0975` on any surface, so this record takes
**`0975`** and leaves `0976`/`0977` to its serial children.

The draw advances the four cells that read `0975` — `board-wide / process`,
`OP-129 attendee identity lane`, `OP-136 jobs lane` and `unallocated (future lanes)` — to
**`0976`** (forward only; no cell is lowered and no range is re-cut).

```
$ git rev-parse --short origin/main                                  d2a5467b
$ git ls-tree -r --name-only origin/main -- docs/adr | sed 's#.*/##' \
    | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -6              0969 0970 0971 0972 0973 0974
$ for d in .worktrees/*/; do ls "$d/docs/adr" 2>/dev/null | grep -oE 'ADR-09[0-9][0-9]'; done \
    | sort -u | tail -3                                            0972 0973 0974
$ git rev-list --objects --all -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -2
                                                                   0973 0974
$ gh pr list --state open --json number,headRefName                 #899 docs, #896 adr-citation pins
$ git ls-tree -r --name-only refs/pull/899/head -- docs/adr; \
  git ls-tree -r --name-only refs/pull/896/head -- docs/adr        # no ADR-09xx paths on either head
$ python3 <read-only board probe>   # non-done cards and their Consumes
t_7aedaced  running  Consumes: 0973   (stale; this card)
t_4cf65e0e / t_76d10c5d / t_a3351538 / t_b9b9f203 / t_e9e94dfb / t_f5c2523e   Consumes: none
                                                                    # no non-done card holds 0975+
```

## Evidence

The gap, measured at `origin/main` `d2a5467b` (the card's figures were taken at `5565eec9`;
none of these lines moved):

```
$ grep -n "getLogger\|COLLECTIONS\.\|insertOne" \
    "apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts"
8:import { getLogger } from "@/server/logging";
75:  const counters = tenantRepo(tenantId, db).collection(COLLECTIONS.usageCounters);
113:  const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
156:    await subscriptions.updateOne(
170:    getLogger().info("billing plan downgrade scheduled", {
                                                    # no insertOne anywhere in the route
$ git grep -n "auditLogs" -- apps/web/src
apps/web/src/server/audit/audit-log.ts:90:    .collection(COLLECTIONS.auditLogs)      # the seam's writer, member actions only
apps/web/src/server/audit/audit-log.test.ts:6,9                        # the retention arithmetic
apps/web/src/server/db/collections.ts:16:  auditLogs: "audit_logs",
apps/web/src/server/db/indexes.ts:183:    collection: COLLECTIONS.auditLogs,     # {expireAt:1} TTL 0
apps/web/src/test/integration/tenant-members.test.ts:1277…1623         # the member pins
$ find apps/web/src/app -type d -name "admin*" | wc -l        0
```

The two transition paths, and the fact that a schedule is clearable:

```
$ grep -n "activePlanKey\|returnDocument\|emitDomainEvent" \
    apps/web/src/server/billing/jobs/scheduled-plan-changes.ts apps/web/src/server/billing/jobs/dunning.ts
scheduled-plan-changes.ts:102  const updated = await subscriptions.findOneAndUpdate(
scheduled-plan-changes.ts:105    $set: { activePlanKey: toPlanKey, scheduledChange: null, updatedAt: now },
scheduled-plan-changes.ts:116  { returnDocument: "after" }
scheduled-plan-changes.ts:125  await emitDomainEvent(   … actorRef: { kind: "system", id: "scheduled-plan-changes" }
dunning.ts:82                  const updated = await subscriptions.findOneAndUpdate(
dunning.ts:85                    $set: { status: "downgraded", activePlanKey: "free", updatedAt: now },
dunning.ts:96                  { returnDocument: "after" }
dunning.ts:107                 await emitDomainEvent(   … actorRef: { kind: "system", id: "dunning" }
$ grep -n "scheduledChange: null" --include=route.ts -r \
    "apps/web/src/app/api/v1/tenants/[tenantId]/billing/"
scheduled-change/route.ts:44   .updateOne({ cancelledAt: null }, { $set: { scheduledChange: null, updatedAt: now } })
upgrade/route.ts:364           scheduledChange: null
checkout/route.ts:330          scheduledChange: null
```

The seam this record widens, and the pin it must amend:

```
$ grep -n "AuditLogAction\|target\|writeAuditLog\|AUDIT_RETENTION_MS" apps/web/src/server/audit/audit-log.ts
22:const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
25:export type AuditLogAction = "member.role_changed" | "member.removed";
39:  readonly target: { readonly kind: "user"; readonly id: string };
87:export async function writeAuditLog(session: ClientSession, entry: AuditLogEntry): Promise<void> {
$ sed -n '553,558p' apps/web/src/test/integration/billing-crons.test.ts
    expect(changedCollections(before, after)).toEqual(["domain_events", "subscriptions"]);
```

The request-side gap this record routes rather than absorbs:

```
$ git grep -n "emitDomainEvent" -- 'apps/web/src/app/api/v1/tenants/*billing*'
apps/web/src/app/api/v1/tenants/[tenantId]/billing/upgrade/route.ts:8,387   # the only one
$ sed -n '1160p' "docs/API Contract.md"
… Emits `billing.plan.downgrade_scheduled`; the cron sweep emits `billing.plan.downgrade_applied` …
```
