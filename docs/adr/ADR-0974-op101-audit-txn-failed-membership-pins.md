# ADR-0974 — OP-101: pin the failed-membership half of the audit-row transaction (both verbs)

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST follow-up `t_0250ac11` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-audit-transaction-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_5f145f2a-audit-txn-pins`
- **Lane:** OP-101 follow-up (member mutations) · **Consumes:** `0974` — a **pool draw** (the board-wide block `0300`–`0319` is exhausted, ADR-0300 §11 item 18), allocator-assigned in this card's body at creation and used as given; the four pool-mirror cells read `0974` at this cut and advance to `0975`
- **Spec sources:** contract §2.2 (the workspace member surface); schema §20.2 (`auditLogs`), §22 (400-day TTL), §13.4 (`tenantMembers`)
- **Relates to:** [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D3 — the transaction rule whose **reverse half** this record pins), [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) (T4, the forward half, left byte-identical), [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) (the implementation both halves characterize), [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (§D3/R2 log lines, untouched), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/test/integration/tenant-members.test.ts`

## Context

[ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §D3 decided that a
workspace-member mutation writes its `auditLogs` row **inside the same
`withTransaction`** as the membership `updateOne`, so a mutation nobody can
attribute is never committed. [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md)
pinned that rule in one direction only — its `T4` refuses the **audit** insert and
requires the membership to stay put — and [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md)
implemented it.[^trunk]

The symmetric failure was unpinned, and `DELETE`'s transaction was not pinned at
all. Measured by the round-1 review of the pin pack (card `t_5f145f2a`, draft PR
[#891](https://github.com/yahodu/openpic-webapp/pull/891)) in a throwaway
worktree at `0f092fb0`:

| Implementation of `PATCH`                                                      | Shipped pack     | Reverse probe (`status`, `auditRows`) |
| ------------------------------------------------------------------------------ | ---------------- | ------------------------------------- |
| intended — membership `updateOne` + `writeAuditLog` in one `withTransaction`   | `45 passed (45)` | `{"status":500,"auditRows":0}`        |
| audit row written **before** the membership write, **outside** any transaction | `45 passed (45)` | `{"status":500,"auditRows":1}`        |
| `DELETE` writing its row outside the transaction                               | `45 passed (45)` | —                                     |

The middle row is the gap: an **orphan** audit row claims a change that never
committed, and the whole pack stays green, because `T4` refuses `insertOne` on
`auditLogs` and an out-of-transaction pre-write hits exactly that refusal — the
route answers the same `500`, the membership is untouched, and no row survives
_for the wrong reason_. A defect class that the pack cannot see is not pinned.

[^trunk]:
    Both halves run against the implementation on `origin/main`
    `1eb1ee84` (the trunk after `8f4e126e`, PR #894):
    `apps/web/src/server/audit/audit-log.ts` exists and both handlers in
    `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts` run the
    membership `updateOne` and `writeAuditLog` in one `withTransaction` callback.

## Decision

Two cases appended to the existing `OP-101 / ADR-0970` `describe` in
`apps/web/src/test/integration/tenant-members.test.ts`. The diff is `+180/−0` in
that file: every shipped case, helper and fixture stays byte-identical, no
production file is touched, and ADR-0288's R2 log-line pins are untouched.

**The stub is `Collection.prototype.updateOne`, not `insertOne`.** It is resolved
before the stub is installed (so the forwarding target is the driver's own
method, never the stub) and it rejects **only** `COLLECTIONS.tenantMembers`,
forwarding every other collection to the driver. The rejection is a driver error
carrying `{ code: 91 }` — a replica-set election — with **no**
`TransientTransactionError` label, so `withTransaction` rethrows it on the first
attempt and no retry can absorb it. That is the same error shape `T4` uses, in the
opposite direction.

**R1 — `PATCH`: the membership write fails → no row.** An owner re-roles a
`member` to `admin` while `tenantMembers` writes are refused: the route must
answer `500` with `code: "internal_error"`, the membership must keep its `role`
**and** its pre-call `updatedAt`, and `audit_logs` must hold **no** row for the
workspace. The stub is then restored and the same call repeated: `200` and
**exactly one** `member.role_changed` row.

**R2 — `DELETE`: the same, for the other verb.** `500 internal_error`, the
membership still `status: "active"` with its pre-call `updatedAt`, no
`audit_logs` row; then restored and repeated: `204` and exactly one
`member.removed` row.

Rows are read through `platformRepo(db).collection(COLLECTIONS.auditLogs)` — the
handle the writer uses — matched with `$or: [{ tenantId: <hex> }, { tenantId:
<ObjectId> }]`, so a row written with the wrong `tenantId` type is still found
and reds on the assertion instead of passing vacuously on an empty list.

**Both halves are load-bearing.** The refusal half alone is vacuous against a
route that never writes a row; the recovery half alone is vacuous against a route
that writes the row outside the transaction. Each case carries both.

## Evidence

### The numbering sweep — `0974` was free at this cut

Run from the worktree on `2026-11-24`, head `1eb1ee84` (`origin/main` equal):

- trunk record numbers: `git ls-tree -r --name-only origin/main -- docs/adr | sed 's#.*/##' | grep -oE 'ADR-097[0-9]' | sort -u` → `ADR-0970 ADR-0971 ADR-0972 ADR-0973`;
- every ref: `git rev-list --objects --all -- docs/adr` → no `ADR-097[4-9]` path;
- every worktree: `ls` of each `.worktrees/*/docs/adr` → no `ADR-097[4-9]`;
- every open PR head: `gh pr list --state open` → only #895; its `refs/pull/895/head` tree has no `ADR-097[4-9]`;
- every non-`done` card's `Consumes`: ten cards; this card holds `0974`; `t_7aedaced` states `0973` (stale — [ADR-0973](ADR-0973-op134-attendee-sessions-ttl-clock.md) already landed on the trunk) and no card holds `0974`.

**Recorded contention, not fixed here:** the round-1 reviewer's comment on
`t_7aedaced` recommends re-issuing that card as `0974`, which is the number this
card drew. This record takes `0974` (its own allocation) and advances the four
pool-mirror cells to `0975`, so `t_7aedaced` must draw `0975`+ — the allocator
owns that re-issue.

### Green on arrival (a characterization pin)

- before the append, the file on this head: `Tests 45 passed (45)`;
- after the append, with the intended implementation: `Tests 47 passed (47)`.

### Measured RED — the negative control (`PATCH`)

The `PATCH` audit write was moved **out** of the transaction and **before** the
membership `updateOne` in this worktree only (one atomic clock read so the TTL
arithmetic stays exact, `insertOne` without a session), then the focused file was
re-run:

```
 FAIL  |integration| …/tenant-members.test.ts > OP-101 / ADR-0970 — the `auditLogs` row a
       workspace-member mutation writes > answers 500 and writes no row when the membership
       write fails on PATCH, then writes the member.role_changed row once the driver recovers
AssertionError: expected [ { …(9) } ] to deeply equal []

- []
+ [ { "_id": …, "action": "member.role_changed", "actor": { … },
+     "after": { "role": "admin" }, "before": { "role": "member" },
+     "expireAt": 2027-12-29T…, "target": { … }, "tenantId": … } ]

 Test Files  1 failed (1)
      Tests  1 failed | 46 passed (47)
```

The failing assertion is the no-row claim; the orphan row is the full
`member.role_changed` document, i.e. exactly the `{"status":500,"auditRows":1}`
probe the review measured. The other 46 cases — `T1`–`T4` and the 42 shipped pins
— stayed green, which is the point: without `R1` the defect is invisible.

### Measured RED — the negative control (`DELETE`)

The same move for `DELETE`, same file:

```
 × answers 500 and writes no row when the membership write fails on DELETE, then writes the
   member.removed row once the driver recovers
AssertionError: expected [ { …(9) } ] to deeply equal []

 Test Files  1 failed (1)
      Tests  1 failed | 46 passed (47)
```

The orphan row here is `action: "member.removed"`, `before: { status: "active" }`,
`after: { status: "removed" }`. No other case reds.

### Reverted, and green again

`git checkout -- …/members/[userId]/route.ts`; `git status --porcelain` lists the
test file only; the focused file answers `Tests 47 passed (47)` again.

### Gates

- focused integration, whole file: `Test Files 1 passed (1)`, `Tests 47 passed (47)`;
- `pnpm typecheck` (`tsc -p tsconfig.json`, the contracts project and the app project): exit `0`;
- `pnpm exec eslint` on the touched file: `No issues found`, exit `0`;
- `pnpm exec prettier --check` on every changed file: clean;
- the eight `adr-*` unit guards: green.

## Consequences

- An implementation that writes the audit row outside the mutation's transaction —
  before it or after it — now reds on `R1`/`R2`, on both verbs. The row and the
  state change become observably atomic in both failure directions.
- **Ordering inside the transaction stays free.** A row written before the
  membership `updateOne` _inside_ the callback still rolls back, so the cases do
  not pin an internal order: a legitimate refactor that swaps the two writes
  inside the callback breaks neither case. §D3 is about atomicity, not sequence.
- No production file, no shipped assertion, and no `members.ts` / `route.ts` /
  ADR-0288 line is in the diff. The admin surface is untouched.
- The pins are green on the intended implementation, so this record ships with a
  **non-draft** PR (there is nothing to wait for; a GREEN would only re-run them).

## Alternatives considered

- **A1 — spy `Collection.prototype.insertOne` (the `T4` shape).** Rejected: it
  pins the forward direction only. An out-of-transaction pre-write fails the
  insert first and passes every current case, which is the measured gap.
- **A2 — assert only `500 internal_error` and "the membership did not move".**
  Rejected: both the intended implementation and the defective one answer exactly
  that, so the assertion discriminates nothing.
- **A3 — pin the order of the two writes inside the transaction.** Rejected: that
  is internal structure, not observable behaviour; it would red a legitimate
  refactor that keeps atomicity.
- **A4 — drop the anti-vacuity half.** Rejected: without the recovery call a route
  that never writes a row passes the refusal half, so the pin would be vacuous in
  the other direction.
- **A5 — read rows with a plain `{ tenantId }` filter on `app.db`.** Rejected: a
  row written with an `ObjectId` instead of the §D2 hex string would be missed, and
  the case would pass on an empty list instead of reding on the drift.
