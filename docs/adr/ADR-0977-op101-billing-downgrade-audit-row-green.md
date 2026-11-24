# ADR-0977 — OP-101: the two `subscription.downgraded` `auditLogs` rows, written in the transition's own transaction

- **Status:** Accepted (GREEN) · **Date:** 2026-11-24
- **Card:** OP-101 GREEN `t_6634feb1` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-billing-downgrade-audit-write` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/OP-101-billing-audit-write-red` (inherited from the RED parent, not a second worktree)
- **Lane:** OP-101 follow-up (audit writes, billing half) · **Consumes:** `0977` — the reservation [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) §Consequences assigned this card at creation, used as given (not a fresh draw, so no range is re-cut); the four pool-mirror cells read `0979` at this cut and **none is lowered** (the higher of the trunk's value and `0978` is `0979`)
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`), §9.1 (every admin mutation writes a row), §9.9 (`GET /admin/audit-logs`, contract-only), §10.2 (`dunning`, `scheduled-plan-changes`), §10.2.1 (C6); schema §20.2 (`auditLogs`), §22 (400-day TTL), §14.3 (`subscriptions.activePlanKey`, `scheduledChange`, `statusHistory`), §18.3 (`domainEvents`); `docs/Subscription flow.md` §4.3
- **Relates to:** [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) (§D3 the widened seam, §D4 one transaction, §D5 the two row shapes, §D6 the `I1` amendment — this record implements all four), [ADR-0976](ADR-0976-op101-billing-downgrade-audit-row-pins.md) (the pins this record satisfies, bytes unchanged), [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D2 row shape and writer seam, §D3 the one-transaction rule, §D4 log lines stay), [ADR-0972](ADR-0972-op101-member-audit-log-write-green.md) (the seam this record widens, its member call sites byte-identical), [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the member reverse-half pins, green here), [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the two jobs), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/server/audit/audit-log.ts`, `apps/web/src/server/billing/jobs/scheduled-plan-changes.ts`, `apps/web/src/server/billing/jobs/dunning.ts`

## Context

[ADR-0976](ADR-0976-op101-billing-downgrade-audit-row-pins.md) landed the executable
contract on the RED tip `9d1450fa`, and the GREEN takes that branch — the parent's bytes,
not a fresh cut — so the pins below are satisfied, never adjusted:

- `billing-crons.test.ts` `Tests 5 failed | 20 passed (25)`: `I1` (the amended
  whole-database diff expects `["audit_logs", "domain_events", "subscriptions"]`), `A1`
  and `A2` (the two exact rows), `A5` and `A6` (the two atomicity arms).
- `audit-log-system-actor.test.ts` `3 failed | 2 passed (5)`
  (`TypeError: systemAuditActor is not a function`), and `pnpm typecheck` exit 2 with
  exactly the three `TS2339` at lines 51/65/78.
- `billing-plan-change.test.ts` `30 passed (30)`: `A0` is a characterization arm (the
  schedule request writes no row) and must never be "fixed" by making the route write.

Two things the pins decide beyond the card body, measured on the RED tip and recorded in
its handoff: the run must **reject** when the audit insert is refused (a per-row
`try`/`catch` reporting `errors: 1` reds `A5`/`A6`), and `row.at` must be the run's
injected instant, so the job passes its own `clock.now()` into `writeAuditLog`.

## Decision

**D1 — the seam is widened once, in `apps/web/src/server/audit/audit-log.ts`**
([ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) §D3). `AuditLogAction` gains
`"subscription.downgraded"`; `AuditLogEntry.target` becomes
`{ kind: "user" | "subscription", id }`; `AuditActor` becomes the discriminated pair
`AuditUserActor` (`{ kind: "user", id, ipHash, uaHash }`, exactly as shipped) |
`AuditSystemActor` (`{ kind: "system", id, ipHash: null, uaHash: null }`) with one new
builder `systemAuditActor(id)`, both digest keys **present and null**; `AuditLogEntry`
gains an optional `reason`, written **only when present** (the writer destructures it and
spreads it back conditionally, so a member row keeps its exact key set and gains no
`reason: undefined`); and `writeAuditLog(session, entry, at = systemClock.now())` takes
the instant. `requestAuditActor` and both member call sites in
`…/tenants/[tenantId]/members/[userId]/route.ts` are byte-identical — the member suite's
`AUDIT_ROW_KEYS` pin stays green, which is the "no key moved" half of §D3.

**D2 — each job runs its conditional write and its row in one `withTransaction`**
([ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) §D4). Both jobs now call
`findOneAndUpdate(..., { returnDocument: "before", session })` and
`writeAuditLog(session, …, now)` inside one callback, so a committed transition has
exactly one row and a refused insert aborts the transition. `returnDocument: "before"`
is what makes `before` the state the write actually replaced, so a concurrent transition
cannot make the row lie. The outbox emit stays **after** the commit (it is a different
concern, and the shipped `emitDomainEvent` owns its own dedupe); the candidate filters
(`scheduledChange.effectiveAt <= now`, `status: "past_due"` + `gracePeriodsEndsAt < now`),
the `skipped` counter, `affected`, `hasMore` and both log lines are unchanged. A lost
race still matches zero documents → `skipped`, and a refused audit insert propagates, so
the run rejects — the pinned `A5`/`A6` behaviour.

**D3 — the rows are §D5's shapes, exactly.** `scheduled-plan-changes` writes
`before: { activePlanKey }` / `after: { activePlanKey: toPlanKey }` /
`reason: scheduledChange.reason` / `actor: systemAuditActor("scheduled-plan-changes")`;
`dunning` writes `before: { status: "past_due", activePlanKey }` /
`after: { status: "downgraded", activePlanKey: "free" }` / `reason: "grace_expired"` /
`actor: systemAuditActor("dunning")`. Both use `target: { kind: "subscription", id }`,
the workspace hex **string** as `tenantId`, and `at = now` (the job's injected clock).

**D4 — an unrecordable pre-image is skipped, never guessed.** If the matched pre-image
carries no string `activePlanKey` (scheduled) or no string `status` (dunning), the row's
`before` would be a guess, so the job throws a local `UnrecordablePreImage` **inside** the
transaction — the write is rolled back with it — and the candidate counts as `skipped`,
the same outcome as a lost race. No fallback value is invented. Ordering inside the
transaction stays free; the callback's own `previous === null` branch is the shipped
lost-race `skipped`.

**D5 — boundary held: the request writes nothing, and C6 is unweakened.**
`POST …/billing/downgrade` is untouched (§D2, pinned by `A0`). `dunning.ts` imports only
`@/server/audit/audit-log`, `@/server/db/**`, `@/server/domain/domain-events`,
`@/server/jobs/cron-job`, `@/server/logging`, `@/server/repos` and
`@/server/runtime/clock` — all already inside the C6 boundary — so `eslint.config.mjs` is
untouched and the content-repository ban list is not weakened; `docs/Subscription flow.md`
§4.3's "no deletion" invariant is proven by the amended whole-database diff, which admits
`audit_logs` and still names every changed collection, with the six content collections
absent. The `dunning.ts` docblock's "writes **nothing else**" sentence now names the
`subscription.downgraded` row and the outbox row. `billing-crons.test.ts`'s `I1` header
sentence is corrected in the same edit (comment text only — no case, helper, fixture or
assertion byte changed).

## Consequences

- `action=subscription.downgraded` answers exactly "the plan was reduced, by the system,
  for this reason, from this plan to that one", one row per applied transition, durable
  for 400 days (§22) — where `statusHistory` is capped at ~50 entries and the log lines
  carry no retention promise.
- A downgrade nobody can attribute cannot happen: the transition and its row commit or
  abort together, and an insert failure rejects the run (the app's `internal_error` path)
  instead of being swallowed into `errors: 1`.
- The billing lane now shares ADR-0970 §D2's arithmetic and fingerprinting rather than a
  second write path; a system row is distinguishable from an unhashed user row by
  `kind` and by the two null digests.
- `dunning` writes one `auditLogs` collection it did not write before; `I1`'s diff names
  it deliberately, so any _other_ new write still reds that case by name.

## Alternatives

- **A per-row `try`/`catch` reporting `errors: 1`.** Rejected by the pins: it leaves a
  silently unaudited downgrade, which is the failure mode the row exists to prevent.
- **A write before the transaction (or in its own transaction after the commit).**
  Rejected and measured: it reds `A6` (`expected { …(26) } to match object
{ status: "past_due", …(2) }`) because the transition commits while the row is refused.
- **A fallback `activePlanKey`/`status` for an unrecordable pre-image.** Rejected: a row
  whose `before` is a guess asserts a state the write did not replace.
- **Writing the row at `POST …/billing/downgrade`.** Rejected by
  [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) §D2 and pinned by `A0`.

## Evidence

Measured on this head, after `origin/main` (`c291cd08`, which landed
[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md)) was merged in:

| Check                                           | Result                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| focused `billing-crons.test.ts`                 | `Tests 25 passed (25)` (was `5 failed \| 20 passed`)                   |
| focused `server/audit/**` unit                  | `Tests 5 passed (5)` (was `3 failed \| 2 passed`)                      |
| whole `integration` project                     | `Test Files 165 passed (165)`, `Tests 1795 passed (1795)`              |
| whole `unit` project                            | `Test Files 199 passed (199)`, `Tests 3378 passed \| 3 skipped (3381)` |
| `pnpm typecheck`                                | exit `0` (three tsconfigs)                                             |
| `pnpm exec eslint` on the three changed modules | `No issues found`                                                      |
| `prettier --check` on every changed file        | clean                                                                  |

**Negative control (the ADR-0975 §D4 atomicity, measured not asserted).** In a scratch
copy of `dunning.ts` the row was moved into its **own** transaction after the commit
(`sha256` of the file taken first). `billing-crons.test.ts` reddened exactly the atomicity
arm — `A6` `AssertionError: expected { …(26) } to match object { status: "past_due", …(2) }`,
`Tests 1 failed | 5 passed | 19 skipped` when focused — with `A1`–`A4` still green. The
file was restored from the pre-probe copy and `sha256sum -c` answered
`dunning.ts: OK` (`06706a7b49dd624cf942ea32ce81ce0821340fcb7f804a8ef7941e6018b535ac`), and
the whole pack was green again.

**Numbering.** `0977` used as given: the four-surface sweep at this cut finds no
`ADR-0977` on `origin/main` (which holds `0970`–`0975` and `0978`), in any
`.worktrees/*/docs/adr` tree (highest among them `0976`, this branch's own), in
`git rev-list --objects --all -- docs/adr` (highest `0978`), on either open PR head
(#904 this branch, #896), or in any non-`done` card's `Consumes`. The four pool-mirror
cells read `0979` on the trunk and are written as `0979` — the higher of the trunk's value
and `0978` — so no cell is lowered and no range is re-cut.
