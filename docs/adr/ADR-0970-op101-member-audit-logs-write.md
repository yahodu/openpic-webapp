# ADR-0970 — OP-101: a workspace-member mutation writes an `auditLogs` row, in the same transaction as the membership change

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 follow-up decision `t_b142c5d8` (openpic-orchestrator), finding **F3** of the pin pack's review · **Branch:** `OP-101-task-member-mutation-audit-records` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_b142c5d8`
- **Lane:** OP-101 follow-up (member mutations) · **Consumes:** `0970` (a **pool draw**, [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 — the board-wide block `0300`–`0319` is exhausted)
- **Spec sources:** contract §2.2 (the workspace member surface), §9.9 (`GET /admin/audit-logs`); schema §20.2 (`auditLogs`), §22 (400-day TTL), §13.4 (`tenantMembers`), §18.3 (`domainEvents`, the sibling append-only ledger)
- **Relates to:** [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (§D3/R2 — the pins of the two log lines, which this record leaves untouched), [ADR-0289](ADR-0289-op101-tenant-members-tiebreak-green.md) (the GREEN that landed the pin pack), [ADR-0281](ADR-0281-op101-tenant-members-green.md) (the shipped member surface), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§9, §11 items 18–19 and 27 — allocation and the pool cursor), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/server/audit/audit-log.ts` (new), `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts`, `apps/web/src/test/integration/tenant-members.test.ts`, `docs/Notification and Database Design.md` §20.2

## Context

The finding is from the review of the OP-101 pin pack ([ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) §Findings F3)
and it is a **documentation-versus-code** gap, not a failing assertion:

- `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts`
  emits two structured **log lines** — `member.role_changed` at `:107-112` (workspace,
  target, new role) and `member.removed` at `:133-137` (workspace, target). Both are
  pinned by [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) R2 and those
  pins are green on the trunk.
- Schema §20.2 defines `auditLogs` with
  `action: "plan.price.updated" | "member.removed" | "subscription.downgraded" | "dsr.executed"`,
  a scope sentence that names **membership changes** explicitly, a 400-day TTL on
  `expireAt` and the indexes `{tenantId:1, at:-1}` · `{"actor.id":1, at:-1}` ·
  `{"target.kind":1,"target.id":1, at:-1}` · `{action:1, at:-1}` · `{expireAt:1}` TTL 0.
- Contract §9.9 declares `GET /admin/audit-logs?tenantId=&actorId=&action=&targetKind=&targetId=&from=&to=&cursor=`
  as read-only, with no write endpoint "by design".
- Nothing writes an `auditLogs` document. Measured at `origin/main` `5565eec9`:

  ```
  $ git grep -n "auditLogs" -- apps/web/src
  apps/web/src/server/db/collections.ts:16:  auditLogs: "audit_logs",
  apps/web/src/server/db/indexes.ts:183:    collection: COLLECTIONS.auditLogs,
  ```

  So the **collection and its TTL index exist** and no module inserts into it. The
  reader does not exist either — see the premise correction below.

**The card's premise is partly wrong, and the correction matters for the pins.** The
card states that `git grep` "shows only the admin read endpoint and its schema".
There is **no admin read endpoint**: `find apps/web/src/app -type d -name "admin*"`
prints nothing, Part 9 of the contract declares **10** `/admin` route headings
(§9.1–§9.10) and not one is routed. §9.9 is a contract, not a shipped reader. The
gap is therefore wider than membership: the **audit write path does not exist at
all**, and neither do the admin actions that the other three union members describe.

Two further measured facts decided the shape of the answer:

- `actor.kind` in §20.2 is `"user" | "admin" | "system"`. **Two** union members are
  user-actor actions on a shipped route and **neither** writes a row: `member.removed`
  (this record's subject) and `subscription.downgraded`
  (`POST …/billing/downgrade` logs `billing plan downgrade scheduled` and inserts
  nothing — measured, see §Evidence). The other two are platform-admin actions whose
  routes are not built at all. The schema's `"user"` discriminator therefore presupposes
  exactly this class of write; dropping membership from the union would leave the two
  user-actor actions audited by two different mechanisms with two retentions.
- The `audit_logs` row is the only one of the two records with a retention promise.
  The log lines have no stated retention, no query surface and no per-tenant index;
  §20.2's 400-day TTL is the durable record. A dispute ("who removed me, and when")
  is exactly the class §20.2 P5 exists for.
- The codebase already performs atomic multi-write: `withTransaction`
  (`apps/web/src/server/db/transaction.ts:63`) is used by the **event**-member removal
  route (`…/events/[eventId]/members/[userId]/route.ts`, 2 uses), so pairing a state
  change with its ledger write is an established shape here.

**Same class, one member over — measured and routed, not widened into this record.**
The same sweep found that `subscription.downgraded`, the other user-actor member of
§20.2's union, has a shipped route (`POST /api/v1/tenants/{tenantId}/billing/downgrade`)
that also writes no `auditLogs` row: it logs `billing plan downgrade scheduled`
(`downgrade/route.ts:170`) and inserts nothing. That gap belongs to the OP-110
self-serve billing lane, not to the member surface, so this record only records it;
the card that lands this decision routes it to its own decision card (`t_7aedaced`)
rather than letting one record grow a second subject.

The pin pack's context line is stale in one respect and it is quoted for the record,
not re-decided: PR [#866](https://github.com/yahodu/openpic-webapp/pull/866) no longer
"stays draft until its tie-break GREEN lands" — it was **closed** on 2026-11-24
(`mergedAt: null`), and its pins plus the tie-break GREEN landed together on `main` as
`774e5584` (PR [#871](https://github.com/yahodu/openpic-webapp/pull/871)). The R2 log
lines are therefore already green on the trunk.

## Decision

**D1 — option 1: the mutations write `auditLogs` rows, and §20.2's union gains
`member.role_changed`.** §20.2 keeps `member.removed` and keeps its scope sentence
("…membership changes…"). The union was simply incomplete: the route has **two**
actions and the schema declared one, so a client filtering
`action=member.role_changed` could never find a row. The gap is closed by making the
code write what the schema promises and by adding the missing member — **not** by
deleting the membership guarantee to match the missing writer.

**D2 — one writer seam, not an inline insert per route.** A new module
`apps/web/src/server/audit/audit-log.ts` exports:

- `auditExpireAt(at: Date): Date` — `at` plus **exactly 400 days**
  (`400 * 24 * 60 * 60 * 1000` ms), the §20.2/§22 TTL, pure and unit-pinnable;
- `requestAuditActor(request: Request, id: string): AuditActor` — `{ kind: "user", id }`
  plus the two fingerprints, computed with the platform's existing
  `hashFingerprint(parts, getRateLimitConfig().salt)` (`@/server/auth/device-fingerprint:52`,
  a 64-character lowercase hex SHA-256) over `resolveClientIp(request.headers, getTrustedClientIpHeader())`
  and `request.headers.get("user-agent")`, so no raw IP and no raw user-agent is ever
  stored (the same rule `p/attendee-sessions/route.ts`'s `deviceFingerprint` applies);
- `writeAuditLog(session, entry)` — `insertOne` into
  `platformRepo(getDb()).collection(COLLECTIONS.auditLogs)` **with the caller's
  session**, so the write joins the route's transaction.

The exact source/destination shape, and the key set the pins assert, is:

```js
{ actor:    { kind: "user", id, ipHash, uaHash },   // ipHash/uaHash 64-hex, never raw
  action:   "member.role_changed" | "member.removed",
  target:   { kind: "user", id: targetUserIdHex },
  tenantId: tenantIdHex,                            // string, like domainEvents.tenantId
  before:   { role } | { status },
  after:    { role } | { status },
  at,                                               // systemClock.now(), one read per row
  expireAt }                                        // at + 400 days
```

`before`/`after` are narrowed to the **field the mutation changes** — `{ role }` for
`member.role_changed`, `{ status }` for `member.removed` (with
`after.status === "removed"`). No `reason` key: contract §2.2 has no reason on either
verb. `tenantId`, `actor.id` and `target.id` are **strings**, matching the sibling
append-only ledger (§18.3's `domainEvents`, whose input schema types `tenantId` and
`refs.id` as `z.string()`), so §9.9's query parameters map straight onto the row.

**D3 — the row and the state change are one transaction.** Both verbs run the
membership `updateOne` and `writeAuditLog` inside a single `withTransaction` callback,
each passing `{ session }`. Consequences:

- a mutation that commits always has exactly one audit row;
- an audit insert failure aborts the mutation and answers the app-wide
  `500 internal_error`, leaving the membership untouched — the posture §20.2 P5
  ("append-only where disputes happen") requires, because a mutation nobody can
  attribute is the failure mode the row exists to prevent;
- the response is sent only after the commit, so a `200`/`204` is evidence that both
  writes happened.

**D4 — the log lines stay.** [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md)
R2 keeps pinning `member.role_changed` / `member.removed` exactly as it does today;
this record is **additive** to those pins and changes neither emitter nor pin. The two
records are not duplicates: the log line is the operator's tail (no retention
promise, no query), the row is the durable per-tenant record the §9.9 contract reads.
A future reader must not "simplify" one into the other.

**D5 — the pins assert at the collection, never at a route that does not exist.** With
§9.9 unrouted, the observable is `COLLECTIONS.auditLogs`: a test reads the inserted
document (or injects a failure on its `insertOne`), because that is what the future
admin reader will read. Pinning an `/admin/audit-logs` response would pin a route this
repository does not have.

**D6 — boundary: this record is the workspace membership only.** §2.2's
`tenantMembers` row, mutated through
`/api/v1/tenants/{tenantId}/members/{userId}`. **Event**-scoped membership removals
(`collab.member.removed`, an event organizer/co-organizer leaving an event) are **not**
in §20.2's union and are out of this decision; their record is the transactional
outbox plus the notification ledger (§18.3). Auditing those is a separate decision and
must not be folded in silently.

**D7 — accepted consequence: one row per successful call, not per state transition.**
The two verbs are not idempotent at this head: a second `DELETE` of an already-removed
membership re-runs the `updateOne` and re-emits the log line today, so it will write a
second `member.removed` row, and a `PATCH` to the role the member already holds writes
one row with `before.role === after.role`. That is the honest reading of "who called
what, when" and it is what the pins assert; making the route idempotent is a separate
contract decision, and this record does not pre-empt it.

## Consequences

- **Two routed cards, in TDD order.** The RED/TEST card `t_5f145f2a` pins the contract above
  (`Consumes: 0971`): a successful `PATCH` writes exactly one `member.role_changed`
  row with the actor, the target, the workspace, the `{role}` before/after and
  `expireAt - at === 400 days`; a successful `DELETE` writes exactly one
  `member.removed` row with `after.status === "removed"`; both `403` refusal arms and
  the `409 cannot_demote_owner` arm write **no** row; and an injected audit-insert
  failure answers `500` with the membership unchanged (the anti-vacuity guard against
  a best-effort write). The GREEN card `t_c2e6b60b` (`Consumes: 0972`, parented on the
  TEST card) adds the module and the two in-transaction calls and lands them with the
  pins in one squash.
- **§20.2 is corrected by this record's own PR** (one member added to the union line),
  so the schema and the code agree at the merged head and no phantom action is written.
- **A sibling gap is routed, not absorbed.** `subscription.downgraded`'s missing write
  goes to its own decision card `t_7aedaced`, gated behind this one (the OP-110 billing
  lane owns the route), so this record keeps one subject and the billing lane decides
  its own audit posture.
- **The reader gap is recorded, not closed.** `GET /admin/audit-logs` stays
  unrouted; when it lands, `action=member.role_changed` and `action=member.removed`
  both have rows to serve, and the 400-day TTL keeps them for a full audit year.
- **One seam for the later admin surface.** The three unwritten union members
  (`plan.price.updated`, `subscription.downgraded`, `dsr.executed`) will call the same
  `writeAuditLog`; this record fixes the row shape once instead of letting an
  admin-surface writer invent a second one.
- **Cost:** one extra insert and one transaction per member mutation. The two verbs
  are owner-only and rare; the transaction is one round trip on a replica set the
  deployment already runs (both the integration harness and every existing
  `withTransaction` caller depend on it).

## Alternatives considered

- **Option 2 — drop `member.removed` and membership changes from §20.2 and declare the
  log stream the membership audit record (rejected).** It deletes a documented
  guarantee to match a missing implementation; the log lines carry no retention
  promise, no query surface and no per-tenant index, so "who removed this member after
  400 days" becomes unanswerable — the exact dispute §20.2 P5 names. It would also
  split the user half of the union: `subscription.downgraded` would stay an
  `auditLogs` action while `member.removed` moved to a log sink, so "who removed this
  member" and "who downgraded this plan" would be answered by two mechanisms with
  different retention.
- **Best-effort insert after the mutation, failure only logged (rejected).** The row
  would go missing exactly when the database is unhealthy — the moment an audit trail
  is worth having — and a `500`-free response would advertise a mutation with no
  record. D3's abort-the-mutation posture is the opposite trade and is deliberate.
- **Inline `insertOne` in each handler instead of a seam (rejected).** Two call sites
  would drift in `expireAt` arithmetic, fingerprinting and key naming, and the later
  admin writer would need a third copy.
- **Write a `domainEvents` row instead of an `auditLogs` row (rejected).** The outbox is
  the notification fan-out (180-day TTL, `eventKey` keys from the notification
  catalogue, `dispatch` flags); §20.2's action-keyed, 400-day, tenant-indexed audit
  collection is what §9.9 queries. Emitting `member.removed` through the outbox would
  also fan out notifications nobody asked for.
- **Change §9.9 or build the admin reader here (rejected).** The card forbids
  production changes outside the decision, the admin surface is a lane of its own, and
  the pins do not need a reader — they need the row.
- **Reopen PR #866 to carry this (rejected).** It is closed; its pins and GREEN landed
  as `774e5584`, and a fresh pin pack on its own branch is how this board adds a
  contract (ADR-0304 §Consequences).

## Numbering

The board-wide / process block `0300`–`0319` is **exhausted** (its cell has read past
the range end since [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)), so
this record draws from the `unallocated (future lanes)` cursor
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18).

The card proposed `0965`; that cursor value is **stale by four draws**. Measured at
`origin/main` `5565eec9`: `0965`, `0966` and `0967` are committed records
([ADR-0965](ADR-0965-op132-confirm-transaction-failure-pins.md),
[ADR-0966](ADR-0966-op132-confirm-outbox-failure-pins.md),
[ADR-0967](ADR-0967-merged-lane-local-branch-deletion.md)), `0968` is on the trunk
([ADR-0968](ADR-0968-op134-attendee-claim-i2-clock.md)), and `0969` was held in flight by
open PR [#879](https://github.com/yahodu/openpic-webapp/pull/879) (which has since landed as
[ADR-0969](ADR-0969-op132-confirm-deactivation-sweep-pin.md)) and by the running
card `t_6ee47a21`, which also reserves `0969`). The lowest free number above the highest in-flight
one is **`0970`**, which this record takes.

The draw advances every cell that reads `0969` at this record's cut — `board-wide /
process`, `OP-129 attendee identity lane`, `OP-136 jobs lane` and the `unallocated
(future lanes)` cursor — to **`0971`** (forward only; no cell is lowered and no range is
re-cut). PR [#879](https://github.com/yahodu/openpic-webapp/pull/879) then landed
([ADR-0969](ADR-0969-op132-confirm-deactivation-sweep-pin.md)) while this record was in
review and wrote `0970` into the same four cells, so this record's merge keeps the
**higher** value `0971` on every cell and discards nothing: the two landings cannot
rewind each other.

The pre-mint sweep covered all four surfaces and no non-`done` card body:

```
$ ls docs/adr | grep -E '^ADR-09[0-9]{2}' | sort | tail -5      # origin/main 5565eec9
ADR-0964-op140-images-retry-refusal-denial-log-pin.md
ADR-0965-op132-confirm-transaction-failure-pins.md
ADR-0966-op132-confirm-outbox-failure-pins.md
ADR-0967-merged-lane-local-branch-deletion.md
ADR-0968-op134-attendee-claim-i2-clock.md
$ gh pr list --state open --json number,headRefName
[{"number":879,"headRefName":"OP-132-task-confirm-deactivation-failure-pins"}]
$ git ls-tree -r --name-only 6b4e0441 -- docs/adr | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -4
ADR-0966
ADR-0967
ADR-0968
ADR-0969                                  # the single in-flight number
$ git rev-list --objects --all -- docs/adr | grep -oE 'ADR-09[0-9]{2}' | sort -u | tail -3
ADR-0968
ADR-0969
$ python3 <read-only board probe>          # tasks where status not in (done, archived)
t_6ee47a21  running  Consumes: 0969
t_b9b9f203  todo     Consumes: none
t_f5c2523e  blocked  Consumes: none
                                          # no non-done card holds 0970
```

**Hotspots found while sweeping, recorded here because they are ledger facts, not this
record's business:** two different files carry `0968` across in-flight refs —
`ADR-0968-op134-attendee-claim-i2-clock.md` on the trunk and
`ADR-0968-op132-confirm-deactivation-sweep-pin.md` in worktree `t_52256cb7` — which is
the collision the open process card `t_0904efc1` owns; and the ledger's row table is
split by a blank line at the `0966`/`0967` boundary, so rows `0967`–`0970` do not render
as table rows until the repair card `t_a2124da9` lands. This record's row is written in
the same shape as its neighbours and needs no change of its own when that repair lands.

## Evidence

The gap, measured on `origin/main` `5565eec9`:

```
$ git grep -n "auditLogs" -- apps/web/src
apps/web/src/server/db/collections.ts:16:  auditLogs: "audit_logs",
apps/web/src/server/db/indexes.ts:183:    collection: COLLECTIONS.auditLogs,
$ find apps/web/src/app -type d -name "admin*" | wc -l
0
$ sed -n '/^# Part 9/,/^# Part 10/p' "docs/API Contract.md" | grep -cE '^### `(GET|POST|PATCH|PUT|DELETE) /admin'
10
$ git grep -n "member.removed\|member.role_changed" -- 'apps/web/src/app/**/members/[userId]/route.ts'
apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts:108:      event: "member.role_changed",
apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts:134:      event: "member.removed",
```

The mechanisms the decision rests on:

```
$ git grep -n "export async function withTransaction" -- apps/web/src
apps/web/src/server/db/transaction.ts:63:export async function withTransaction<T>(
$ git grep -c "withTransaction" -- 'apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/members/[userId]/route.ts'
apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/members/[userId]/route.ts:2
$ git grep -n "export function hashFingerprint" -- apps/web/src
apps/web/src/server/auth/device-fingerprint.ts:52:export function hashFingerprint(parts: FingerprintParts, salt: string): string {
$ git grep -n "salt:" -- apps/web/src/server/config/env.ts
apps/web/src/server/config/env.ts:527:    salt: process.env.RATE_LIMIT_SALT ?? DEFAULT_RATE_LIMIT_SALT,
$ grep -n "tenantId: z.string\|actorRef: z.object\|subjectRef: z.object" apps/web/src/server/domain/domain-events.ts
159:  tenantId: z.string().min(1),
160:  actorRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
161:  subjectRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
$ grep -n "getLogger\|COLLECTIONS\.\|insertOne" "apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts"
8:import { getLogger } from "@/server/logging";
75:  const counters = tenantRepo(tenantId, db).collection(COLLECTIONS.usageCounters);
113:    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
170:    getLogger().info("billing plan downgrade scheduled", {
                                          # no insertOne anywhere in the route
```

The pin pack this finding came from, and its stale draft line:

```
$ gh pr view 866 --json state,mergedAt,closedAt
{"state":"CLOSED","mergedAt":null,"closedAt":"2026-11-24T11:18:55Z"}
$ git log --oneline -1 origin/main -- apps/web/src/test/integration/tenant-members.test.ts
774e5584 fix(tenants): OP-101 add the joinedAt userId tie-break to the workspace member listing (#871)
```
