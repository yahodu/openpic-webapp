# ADR-0972 — OP-101: the GREEN of ADR-0970 — both member verbs write the `auditLogs` row in their membership transaction

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 GREEN `t_c2e6b60b` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-member-audit-log-write-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-member-audit-write-green`
- **Lane:** OP-101 follow-up (member mutations) · **Consumes:** `0972` — the reservation [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §Consequences assigned to this card when it was created, used as given (not a fresh draw)
- **Spec sources:** contract §2.2 (the workspace member surface), §9.9 (`GET /admin/audit-logs`, contract-only at this head); schema §20.2 (`auditLogs`), §22 (400-day TTL), §13.4 (`tenantMembers`), §18.3 (`domainEvents`, the sibling append-only ledger)
- **Relates to:** [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D1–§D7 — the decision this record implements), [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) (the pins carried and satisfied unchanged), [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (§D3/R2 — the two log lines kept byte-identical and green), [ADR-0281](ADR-0281-op101-tenant-members-green.md) / [ADR-0289](ADR-0289-op101-tenant-members-tiebreak-green.md) (the shipped member surface), [ADR-0967](ADR-0967-merged-lane-local-branch-deletion.md) (the merge-step hygiene this PR applies), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** none in source — no source comment cites this record; the row shape it implements is cited as [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) by `apps/web/src/server/audit/audit-log.ts` and `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts`. This record's only citation is its ledger row below.

## Context

[ADR-0970](ADR-0970-op101-member-audit-logs-write.md) decided that a workspace-member
role change or removal writes one `auditLogs` document **inside the same
`withTransaction`** as the membership `updateOne`, and fixed the row shape (§D2), the
transaction rule (§D3), the observable (§D5: the collection) and the accepted
non-idempotence (§D7). [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) pinned
it — one appended `describe` in
`apps/web/src/test/integration/tenant-members.test.ts` (T1–T4) and one new unit spec at
`apps/web/src/server/audit/audit-log.test.ts` (T5) — and shipped no production file, so
the pack was RED by design on its own head: `Tests 3 failed | 42 passed (45)` (T1, T2 and
T4's first half) and `Cannot find module './audit-log'`.

This card is the GREEN half: the new writer module and the two in-transaction call sites,
landed with the pins in one squash so `main` is never left red.

## Decision

**D1 — one writer seam, exactly as §D2 names it.** New module
`apps/web/src/server/audit/audit-log.ts`:

- `auditExpireAt(at: Date): Date` — a **new** `Date` exactly
  `400 * 24 * 60 * 60 * 1000` ms after `at`, the §20.2/§22 TTL, `at` never mutated;
- `requestAuditActor(request: Request, id: string): AuditActor` — `{ kind: "user", id }`
  plus `ipHash`/`uaHash`, each the platform's `hashFingerprint(parts,
getRateLimitConfig().salt)` digest (64-character lowercase hex SHA-256) over
  `resolveClientIp(request.headers, getTrustedClientIpHeader())` and
  `request.headers.get("user-agent")`; an unresolvable address hashes its empty slot
  (`?? null`), so no raw IP and no raw user-agent is ever stored;
- `writeAuditLog(session, entry)` — `insertOne` into
  `platformRepo(getDb()).collection(COLLECTIONS.auditLogs)` **with the caller's
  session**, stamping `at = systemClock.now()` and `expireAt = auditExpireAt(at)` from
  one clock read.

**D2 — both handlers run the pair inside one transaction.** In
`apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts` the membership
`updateOne` and `writeAuditLog` now run in one `withTransaction` callback
(`@/server/db/transaction`), each operation passing `{ session }`. `PATCH` writes
`action: "member.role_changed"`, `before: { role: <stored> }`, `after: { role: <new> }`;
`DELETE` writes `action: "member.removed"`, `before: { status: <stored> }`,
`after: { status: "removed" }`. Both carry `target: { kind: "user", id: <target hex> }`,
`tenantId: <workspace hex>`, and `actor` built from the scope's caller id — the one
additive change outside the handlers is the `callerId` field `resolveMemberTarget`
already holds the scope for.

An audit-insert failure therefore aborts the mutation and answers the app-wide
`500 internal_error`; the response is sent only after the commit, so a `200`/`204` is
evidence that both writes landed (§D3).

**D3 — everything else is byte-identical.** The two structured log lines (ADR-0288 R2),
the response shapes (`200` updated member / `204`), the gate order and the
`404`/`403`/`409` arms are untouched. No other route, no `members.ts`, no schema change:
§20.2's `action` union already carries `member.role_changed` on the trunk
(`Notification and Database Design.md` §20.2), written by [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)'s
own PR.

## Consequences

- **One transaction, both verbs, measured.** The shape is the one the parent's review
  probed: with the audit `insertOne` refused for `COLLECTIONS.auditLogs` by a driver
  `code: 91` error, the call answers `500 internal_error` and leaves the membership
  unchanged with **no** row; with the driver restored the same call answers `200` and
  writes exactly one row (T4's two halves). `DELETE` uses the same shape.
- **The row the pins read.** `{ actor, action, target, tenantId, before, after, at,
expireAt }` plus the driver's `_id`; `tenantId`, `actor.id` and `target.id` are
  **strings**, matching §18.3's `domainEvents`; `before`/`after` are narrowed to the
  changed field, with no `reason` key (contract §2.2 has none on either verb).
- **Measured green at this head:** the focused integration spec `Tests 45 passed (45)`,
  the unit spec `2 passed (2)`; the full `unit` project `197 passed (197)` files /
  `3356 passed | 3 skipped (3359)`; the full `integration` project `165 passed (165)`
  files / `1786 passed (1786)`; `pnpm typecheck` exit `0`; `pnpm lint` 0 errors;
  `prettier --check` clean; the eight `adr-*` unit guards green.
- **A follow-up pin card is already routed.** `t_0250ac11` (Low, coverage gap) runs on
  this implementation tree and adds the failed-_membership_ arms for both verbs: the
  delivered pack pins the audit-failure direction only, and it pins `DELETE`'s
  transaction not at all — a route that wrote the row outside any transaction passes all
  45 cases today (measured by the pin pack's review: `{"status":500,"auditRows":1}`
  against the intended `{"status":500,"auditRows":0}`). This card implements the
  intended shape, not the passing shortcut; the arm that would red a regression is that
  card's.
- **Type note, recorded because it is a real limit.** `MembershipDocument.role` and
  `.status` are typed `unknown` (the stored row may hold a value the write path never
  produced), so `AuditLogEntry.before`/`.after` accept `Readonly<Record<string,
unknown>>` and the handlers record the stored value verbatim rather than casting it to
  a role/status literal. The pins assert the value, not the type, and a stored drift
  stays visible in the row instead of failing the mutation.

## Alternatives considered

- **An inline `insertOne` in each handler (rejected, [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) §Alternatives).**
  Two copies of the TTL arithmetic and the fingerprinting would drift, and the later
  admin writer would need a third.
- **A best-effort insert outside the transaction (rejected, §D3).** It passes the whole
  delivered pack — which is why the parent routed `t_0250ac11` — but leaves an orphan
  audit row when the membership write fails, and a mutation nobody can attribute is the
  failure mode §20.2 P5 exists to prevent.
- **Writing the row after the mutation without a session (rejected).** Same failure
  direction as above: the row and the state change would commit independently.
- **Splitting the fingerprints into a new helper (rejected).** `hashFingerprint` already
  ships the salted SHA-256 scheme (`@/server/auth/device-fingerprint:52`) and
  `hashing-fingerprint-per-part` is the existing consent-evidence pattern; a second
  scheme would give two digest conventions for one deployment salt.

## Numbering

This card **consumes `0972`**, the reservation [ADR-0970](ADR-0970-op101-member-audit-logs-write.md)
§Consequences assigned it at creation — not a fresh draw. The four cells that a pool draw
moves together (`board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs
lane`, `unallocated (future lanes)`) read **`0974`** at this cut, because
[ADR-0973](ADR-0973-op134-attendee-sessions-ttl-clock.md) advanced them past `0970` while
this lane was in flight. The higher of the trunk's value (`0974`) and one more than the
highest number consumed in the lane (`0972` → `0973`) is **`0974`**, so no cell moves and
none is lowered. Hotspot: `docs/adr/README.md` (this record's row), which the sibling
ADR cards also append to — merge as a union keeping the higher value in every cell.

## Evidence

The writer and the two call sites, measured on this branch:

```
$ git diff --stat origin/OP-101-task-member-audit-log-write-pins
 apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts | 68 ++++++++++-----
 apps/web/src/server/audit/audit-log.ts                               | 96 ++++++++++++++++++++
 2 files changed, ...

$ pnpm exec vitest run --project unit apps/web/src/server/audit/audit-log.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ pnpm exec vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts
 Test Files  1 passed (1)
      Tests  45 passed (45)

$ pnpm exec vitest run --project unit
 Test Files  197 passed (197)
      Tests  3356 passed | 3 skipped (3359)

$ pnpm exec vitest run --project integration
 Test Files  165 passed (165)
      Tests  1786 passed (1786)
```

`pnpm typecheck` exit `0`, `pnpm exec eslint` on the two changed files `No issues found`,
`pnpm exec prettier --check` clean, and the `unit` project's eight `adr-*` guards are
part of the run above.
