# ADR-0971 — OP-101: pin the `auditLogs` row a workspace-member mutation must write

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST `t_5f145f2a` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-member-audit-log-write-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-member-audit-write`
- **Lane:** OP-101 follow-up (member mutations) · **Consumes:** `0971` — the reservation [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §Consequences assigned to this card when it was created, used as given (not a fresh draw)
- **Spec sources:** contract §2.2 (the workspace member surface), §9.9 (`GET /admin/audit-logs`, contract-only at this head); schema §20.2 (`auditLogs`), §22 (400-day TTL), §13.4 (`tenantMembers`), §18.3 (`domainEvents`, the sibling append-only ledger)
- **Relates to:** [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D2 the row shape, §D3 the transaction rule, §D5 the collection-not-route observable, §D7 one row per call — the decision this pin pack executes), [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (§D2/§D3 — the two log-line pins this record leaves untouched and green), [ADR-0281](ADR-0281-op101-tenant-members-green.md) / [ADR-0289](ADR-0289-op101-tenant-members-tiebreak-green.md) (the shipped member surface and its listing tie-break), [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (the draft-PR supersession rule this RED PR follows), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (a deliberately unmerged RED-by-design branch is exempt from the stale-branch sweep), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/test/integration/tenant-members.test.ts`, `apps/web/src/server/audit/audit-log.test.ts`

## Context

[ADR-0970](ADR-0970-op101-member-audit-logs-write.md) decided that a workspace-member
role change or removal writes one `auditLogs` document **inside the same
`withTransaction`** as the membership `updateOne`, and wrote the row shape (§D2), the
transaction rule (§D3), the observable (§D5: the collection, because
`GET /admin/audit-logs` is contract-only) and the accepted non-idempotence (§D7) into
the record. It shipped no code and no test; it routed this serial TEST card and then a
GREEN behind it.

At the branch point, measured on `origin/main` `6c788687`:

- both verbs run one `updateOne` on `tenantMembers` (`route.ts:100-105` for `PATCH`,
  `:126-131` for `DELETE`) and then emit a structured **log line**
  (`:107-112`, `:133-137`). The log lines are pinned by
  [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) R2 and are green;
- **nothing writes `audit_logs`**: `git grep -n "auditLogs" -- apps/web/src` returns the
  collection name (`collections.ts:16`) and its TTL index (`indexes.ts:183`) and no
  insert;
- the module §D2 names, `apps/web/src/server/audit/audit-log.ts`, does not exist —
  `ls apps/web/src/server/audit` answers `No such file or directory`.

So the gap the pins must make visible is **the row**, and the only observable is the
document a future §9.9 reader will read.

## Decision

One appended `describe` in `apps/web/src/test/integration/tenant-members.test.ts` and
one new unit spec at `apps/web/src/server/audit/audit-log.test.ts`. Every shipped case,
helper and fixture of the integration file stays byte-identical (the diff is three
import lines plus one appended block); no production file is touched.

The rows are read through the handle §D2 names for the writer —
`platformRepo(db).collection(COLLECTIONS.auditLogs)` — and every document's **key set**
is asserted with `toEqual`, so an added `reason` key or a dropped `before` reds.

**T1 — `PATCH` writes one `member.role_changed` row.** Owner re-roles a `member` to
`admin` → `200`; exactly one document; keys exactly
`{ _id, action, actor, after, at, before, expireAt, target, tenantId }`;
`action: "member.role_changed"`; `actor` keys exactly `{ id, ipHash, kind, uaHash }` with
`kind: "user"`, `id` the caller's Better Auth id, and both fingerprints matching
`/^[0-9a-f]{64}$/`; `target` exactly `{ kind: "user", id: <target userId hex> }`;
`tenantId` the workspace **hex string**; `before: { role: "member" }` and
`after: { role: "admin" }` asserted with `toEqual`, so a nested extra key reds;
`expireAt - at === 400 * 24 * 60 * 60 * 1000`; and no `member.removed` row. The case
also proves the two fingerprints are digests: the request presents a known
`x-forwarded-for` and `user-agent`, and the serialized row contains neither.

**T2 — `DELETE` writes one `member.removed` row.** `204`; exactly one document with the
same key set, actor, target and workspace keys; `before: { status: "active" }` and
`after: { status: "removed" }`; the same 400-day retention; and no
`member.role_changed` row.

**T3 — refusals write nothing (control).** Two cases: a non-owner (`admin`) caller is
`403 forbidden` on **both** verbs and the workspace's audit collection stays empty; and
the owner-target removal is `409 cannot_demote_owner` and writes nothing. A row written
before the gate — or in a `finally` — reds here.

**T4 — the write is inside the mutation's transaction (load-bearing).** The audit
`insertOne` is refused for `COLLECTIONS.auditLogs` with a driver error that carries no
`TransientTransactionError` label (`Object.assign(new Error("not primary"), { code: 91 })`,
so `withTransaction` rethrows on the first attempt and no retry absorbs it), every other
collection forwarding to the driver's own method resolved once at module load. The
route must answer `500 internal_error` with no `details`, the membership row must be
unchanged (same `role`, and the same `updatedAt` a pre-call seeding wrote), and no
`audit_logs` document may exist. The stub is then restored and **the same call is
repeated**: it must answer `200` and write exactly one row. That second half is the
anti-vacuity guard — a route that never writes a row cannot pass T4.

**T5 — `auditExpireAt` (unit, pure).** `auditExpireAt(at)` returns a **new** `Date`
exactly `400 * 24 * 60 * 60 * 1000` ms after `at`, and leaves `at` untouched. It pins
the one piece of §D2 arithmetic that fails silently if it drifts: a row dated a year out
instead of 400 days is still a valid, queryable document that simply disappears early.

**What T1–T4 deliberately do not pin.**

- the literal digest values: §D2 fixes the digest (64-hex, salted) and not the salt's
  source, so the pins require the shape and the absence of the raw values (assumption
  A2 below);
- the instant `at` names: only its type and its exact distance to `expireAt` (A3), so no
  case can flake on a millisecond boundary;
- the row's `_id`: it is the driver's, and the key set carries it only so a second
  writer-side field cannot appear unnoticed;
- idempotence: §D7 accepts one row per successful call, so no case re-sends a mutation.

## Consequences

**RED at the branch point, measured** (`npx vitest run --project integration
apps/web/src/test/integration/tenant-members.test.ts` on the delivered head):

```
 FAIL  tenant-members.test.ts > … > writes exactly one member.role_changed row when an owner re-roles a member
AssertionError: expected [] to have a length of 1 but got +0
 FAIL  tenant-members.test.ts > … > writes exactly one member.removed row when an owner removes a member
AssertionError: expected [] to have a length of 1 but got +0
 FAIL  tenant-members.test.ts > … > answers 500 and commits neither the role nor the row when the audit insert fails, then writes the row once the driver recovers
AssertionError: expected 200 to be 500 // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed | 42 passed (45)
```

Exactly the three cases §Consequences of [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
calls RED: the two missing rows, and the route answering `200` and committing when the
audit insert fails. The 42 greens are the shipped cases plus **T3's two control cases**;
T4's second half is green inside the case that fails on its first assertion, which is
what makes it a control rather than RED evidence.

**T5's RED is the honest new-module failure**, measured
(`npx vitest run --project unit apps/web/src/server/audit/audit-log.test.ts`):

```
 FAIL  |unit| apps/web/src/server/audit/audit-log.test.ts
Error: Cannot find module './audit-log' imported from …/server/audit/audit-log.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

and it is **probed** so it is not a hollow red: with a throwaway `audit-log.ts` carrying
the §D2 arithmetic the spec answers `2 passed (2)` (the expected ISO `2027-04-08T05:06:07.890Z`
confirmed), and with the same stub returning `new Date(at.getTime())` it reds exactly the
arithmetic case (`AssertionError: expected +0 to be 34560000000`, `1 failed | 1 passed (2)`)
while the non-mutation case stays green — the two cases discriminate. The stub was
deleted; `git status` shows only the two spec files.

**Assumptions recorded here, resolved unilaterally by the pin pack.**

- **A1 — `actor.id` is the Better Auth `user._id` hex.** §D2 writes
  `requestAuditActor(request, id)`; the route's only principal id is the session user's,
  which is the value every other tenancy row stores.
- **A2 — the fingerprints are asserted by shape, never by value.**
- **A3 — `at` is not pinned to an instant** (type plus the exact distance to `expireAt`).
- **A4 — the workspace `tenantId` is the hex string** (§D2), which is also why the read
  matches the hex form _and_ the `ObjectId`: a row written with the wrong type is still
  found, and reds on the field assertion that names the drift instead of passing on an
  empty list.

**Out of scope, stated so it is not mistaken for a gap.**

- `route.ts`, `members.ts`, the audit writer seam and any admin route: this card is
  pins only, and the GREEN `t_c2e6b60b` (`Consumes: 0972`) carries the implementation
  together with these pins.
- [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md)'s R2 log-line pins and
  their `memoryTransport()` / `setLogger()` helpers: untouched, and still green in the
  same run (the shipped 40 cases).
- Event-scoped membership removal (`collab.member.removed`) stays outside §20.2's union
  — [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D6.
- `subscription.downgraded`'s missing row belongs to the OP-110 lane
  (`POST …/billing/downgrade`), routed by [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
  to `t_7aedaced`; nothing about it is pinned here.
- The §9.9 reader: no case asserts an `/admin/audit-logs` response, because no such
  route exists (§D5).

**Delivery posture.** The branch is pushed and its PR opened as a **draft** that must not
be merged ([ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md)); the GREEN's squash
carries these pins from this branch tip and supersedes it. The branch is therefore also
exempt from the stale-branch deletion sweep
([ADR-0306](ADR-0306-op101-stale-branch-deletion.md)), which keeps a deliberately
unmerged RED PR's branch and worktree.

## Alternatives considered

- **Pin an `/admin/audit-logs` response instead of the collection (rejected).** §9.9 is a
  contract with no routed implementation — `find apps/web/src/app -type d -name "admin*"`
  returns nothing at this head — so the case would pin a route that does not exist
  (§D5).
- **Pin the two log lines and call membership audited (rejected).** The log lines carry
  no retention promise, no query surface and no per-tenant index, and
  [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) already pins them; that is
  option 2 of [ADR-0970](ADR-0970-op101-member-audit-logs-write.md), which the parent
  rejected with measurements.
- **Assert the two fingerprint literals (rejected).** §D2 fixes the digest and not the
  salt's source, so a literal would pin one wiring of `hashFingerprint` and red a
  legitimate refactor. Shape plus the absence of the raw values pins the property that
  matters (no raw address, no raw agent).
- **Assert `actor.id` against the raw `user` document id instead of the session principal
  (rejected).** They are the same value here, and the session's is the honest
  observable: it is what the request carried.
- **Fold T5 into the integration cases and skip the new module (rejected).** The
  integration rows do pin the 400-day distance, but a drift in the pure function would
  then red only inside a Mongo run, with a message about a document rather than the
  arithmetic. The unit case reds with both numbers in the message.
- **Pin a second mutation's row count for §D7's non-idempotence (rejected).** §D7 accepts
  one row per call _and_ says making the route idempotent is a separate contract
  decision; pinning today's double-write would pre-empt it.

## Numbering

This record consumes **`0971`**, the number [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
§Consequences reserved for `t_5f145f2a` at card creation, and it is **not** a fresh draw:
the allocator assigned it, and this record uses it as given. The lane's serialization rule
([ADR-0312](ADR-0312-same-lane-adr-card-serialization.md)) is why the reservation exists
at all — this card is a `parents=[t_b142c5d8]` child, so it reads its number off the
merged trunk instead of enumerating a trunk that is still moving.

The four cells that the pool draws move together (`board-wide / process`,
`OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read
**`0974`** at this cut: [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) advanced them
to `0971`, [ADR-0973](ADR-0973-op134-attendee-sessions-ttl-clock.md) — landed while this
lane's parent was in review — advanced them to `0974`. Taking `0971` therefore **moves no
cell and lowers none**: the rule for this lane is the higher of the trunk's value (`0974`)
and one more than the highest number consumed in the lane (`0972`), which is `0974`, so
those four cells are untouched by this PR.

A pre-mint sweep confirmed `0971` and `0972` are held by nothing:

```
$ ls docs/adr | grep -E '^ADR-097[0-9]'
ADR-0970-op101-member-audit-logs-write.md
ADR-0973-op134-attendee-sessions-ttl-clock.md
$ git rev-list --objects --all -- docs/adr | grep -oE 'ADR-097[0-9]' | sort -u
ADR-0970
ADR-0973
$ for d in .worktrees/*/docs/adr; do ls "$d" | grep -oE 'ADR-097[0-9]'; done | sort -u
ADR-0970
ADR-0973
$ gh pr list --state open --json number,headRefName
[{"headRefName":"OP-134-task-adr0968-review-signoff","number":890},
 {"headRefName":"OP-132-task-adr0318-seven-conditions","number":889}]
$ git ls-tree -r --name-only <each of those two heads> -- docs/adr | grep -oE 'ADR-097[0-9]' | sort -u
ADR-0970
ADR-0973
```

**Collision flag, recorded because it is a ledger fact and not this card's to fix:** the
parent's handoff routed `0973` to `t_7aedaced` (`Consumes: 0973`), but `0973` was taken by
[ADR-0973](ADR-0973-op134-attendee-sessions-ttl-clock.md) in the OP-134 lane while the
parent was in review. `t_7aedaced` must re-draw from the cursor (`0974`+) rather than use
its stale reservation, and the allocator should re-issue it.

## Evidence

The pin pack's RED, at this branch's head (integration, 45 cases):

```
$ npx vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts
FAIL … > writes exactly one member.role_changed row when an owner re-roles a member
AssertionError: expected [] to have a length of 1 but got +0
FAIL … > writes exactly one member.removed row when an owner removes a member
AssertionError: expected [] to have a length of 1 but got +0
FAIL … > answers 500 and commits neither the role nor the row when the audit insert fails, then writes the row once the driver recovers
AssertionError: expected 200 to be 500 // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed | 42 passed (45)
```

The unit pin, and the two probe passes that prove it is load-bearing:

```
$ npx vitest run --project unit apps/web/src/server/audit/audit-log.test.ts
Error: Cannot find module './audit-log' imported from …/audit-log.test.ts
 Test Files  1 failed (1)
      Tests  no tests
$ # probe 1 — the §D2 arithmetic
 Test Files  1 passed (1)
      Tests  2 passed (2)
$ # probe 2 — the same stub returning new Date(at.getTime())
AssertionError: expected +0 to be 34560000000 // Object.is equality
      Tests  1 failed | 1 passed (2)
```

The gap itself, on the branch point `origin/main` `6c788687`:

```
$ git grep -n "auditLogs" -- apps/web/src
apps/web/src/server/db/collections.ts:16:  auditLogs: "audit_logs",
apps/web/src/server/db/indexes.ts:183:    collection: COLLECTIONS.auditLogs,
$ ls apps/web/src/server/audit
ls: cannot access 'apps/web/src/server/audit': No such file or directory
```

The mechanical gates at the delivered head: `npx tsc -p apps/web/tsconfig.json --noEmit`
answers only the one expected `TS2307` for the module T5's GREEN creates (the integration
spec typechecks clean), `eslint` reports nothing on either spec, and `prettier --check`
is clean on both. The eight `adr-*` guards are green on the tree this record leaves.
