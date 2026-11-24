# ADR-0976 — OP-101: pin the two `subscription.downgraded` `auditLogs` rows (scheduled-plan-changes + dunning)

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST follow-up `t_e3bb5425` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-billing-downgrade-audit-write` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/OP-101-billing-audit-write-red`
- **Lane:** OP-101 follow-up (audit writes, billing half) · **Consumes:** `0976` — a **pool draw** (the board-wide block `0300`–`0319` is exhausted, ADR-0300 §11 item 18), allocator-assigned in this card's body and used as given; the four pool-mirror cells read `0976` at this cut and advance to `0977` (the higher of the trunk's value and `0976+1`, because `0977` is the number the gated GREEN `t_6634feb1` already holds)
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`), §9.1 (every admin mutation writes a row), §9.9 (`GET /admin/audit-logs`, contract-only), §10.2 (`dunning`, `scheduled-plan-changes`), §10.2.1 (C6); schema §20.2 (`auditLogs`), §22 (400-day TTL), §14.3 (`subscriptions.activePlanKey`, `scheduledChange`, `statusHistory`), §18.3 (`domainEvents`)
- **Relates to:** [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) (§D2 the write site, §D3 the widened seam, §D4 one transaction, §D5 the two row shapes, §D6 the `I1` amendment — this record pins all five), [ADR-0970](ADR-0970-op101-member-audit-logs-write.md) (§D2 row shape and writer seam, §D3 the one-transaction rule), [ADR-0971](ADR-0971-op101-member-audit-log-write-pins.md) / [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the member pins, byte-identical and green here), [ADR-0500](ADR-0500-op111-billing-jobs-red.md) (the two billing jobs and this suite), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the pool-draw rule), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/test/integration/billing-crons.test.ts`, `apps/web/src/test/integration/billing-plan-change.test.ts`, `apps/web/src/server/audit/audit-log-system-actor.test.ts`

## Context

[ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) decided **where** a
`subscription.downgraded` row is written — at the **transition**, by the two shipped
jobs, never at the request — and left the executable contract to this card
(`Consumes: 0976`) and its gated GREEN `t_6634feb1` (`Consumes: 0977`). Measured at
`origin/main` `1d326367`, the tree this record's pins are authored on:

- `apps/web/src/server/audit/audit-log.ts` exports `auditExpireAt`, `requestAuditActor`
  and `writeAuditLog(session, entry)`; `AuditLogAction` is
  `"member.role_changed" | "member.removed"`, `AuditActor.kind` is `"user"`,
  `AuditLogEntry.target.kind` is `"user"`, there is no `reason` and no
  `systemAuditActor`; `writeAuditLog` reads `systemClock.now()` itself and takes no
  instant.
- `runScheduledPlanChanges` and `runDunning` apply their transitions with a bare
  conditional `findOneAndUpdate` (`returnDocument: "after"`, no session, no
  transaction) and write one `domain_events` row each. Neither writes `auditLogs`.
- `billing-crons.test.ts` `I1` pins a **whole-database** diff for the dunning run:
  `["domain_events", "subscriptions"]`. A dunning audit row therefore reds `I1` until
  the pin is amended — which §D6 does deliberately, admitting `audit_logs` while
  keeping the six content collections (`events`, `eventImages`, `mediaAssets`,
  `imageFaces`, `faceMatches`, `attendeeEventProfiles`) absent, so C6 stays proven
  **structurally**: the diff names every changed collection, so any content write is
  still named by the assertion.

So the deliverable is a pin pack, not code: the two rows, their two anti-vacuity arms,
their two atomicity arms, the seam's one new builder, the deliberate `I1` amendment,
and one characterization arm recording that the request writes nothing.

## Decision

**D1 — the widened seam is pinned at its pure builder, the rows are pinned end to end.**
A new unit spec `apps/web/src/server/audit/audit-log-system-actor.test.ts` pins
`systemAuditActor(id)` (ADR-0975 §D3): the exact object
`{ kind: "system", id, ipHash: null, uaHash: null }` for **both** job ids, and the
**four-key** actor set (`id`, `ipHash`, `kind`, `uaHash`) that the member rows already
pin as `AUDIT_ACTOR_KEYS` — both fingerprints **present and null**, never absent, so a
system row can never be read as an unhashed user row. The module is imported as a
namespace (`import * as auditLog`) rather than by named binding, because a missing named
export fails ESM linking and would red the whole file for one symbol; the namespace form
fails inside the three cases that call the missing builder and nothing else.

The rest of the widening (`AuditLogAction` gains the member, `target.kind` becomes
`"user" | "subscription"`, optional `reason`, the optional third `writeAuditLog`
parameter) is pinned where it is observable — in the row: `action`, `target.kind`,
`reason`'s presence in the exact key set, and `at` equal to the **job's injected clock**
(which only holds if the job passes it, `S1`). The member lane's own key-set pin
(`AUDIT_ROW_KEYS` in `tenant-members.test.ts`) stays byte-identical and green, which is
the "the user actor's key set does not move" half of D3.

**D2 — six cases in `billing-crons.test.ts`, read through `platformRepo`.** Rows are read
with `platformRepo(app.db).collection(COLLECTIONS.auditLogs)` matched on the workspace
hex **and** the `ObjectId`, so a row written with the wrong `tenantId` type is found and
reds on the field assertion instead of passing on an empty list. No route is pinned:
`GET /admin/audit-logs` (§9.9) does not exist at this head.

| Case | Behaviour pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Arrival state   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `A1` | a due scheduled self-downgrade writes exactly one row: `actor` exactly `{kind:"system", id:"scheduled-plan-changes", ipHash:null, uaHash:null}`, `action:"subscription.downgraded"`, `target` exactly `{kind:"subscription", id:<subscription hex>}`, `tenantId` the workspace hex **string**, `before` exactly `{activePlanKey:"starter"}` (the matched pre-image), `after` exactly `{activePlanKey:"free"}`, `reason:"self_downgrade"`, key set exactly the nine §D5 fields plus `_id`, `at` = `NOW`, `expireAt − at = 400 days` | **RED**         |
| `A2` | the dunning transition writes the same action and actor with `id:"dunning"`, `before` exactly `{status:"past_due", activePlanKey:"starter"}`, `after` exactly `{status:"downgraded", activePlanKey:"free"}`, `reason:"grace_expired"`, same key set and `at`/`expireAt` arithmetic                                                                                                                                                                                                                                                 | **RED**         |
| `A3` | a scheduled change that is **not due yet** writes **no** row, moves nothing and keeps its stored intent                                                                                                                                                                                                                                                                                                                                                                                                                            | control (green) |
| `A4` | a `past_due` row **inside** its grace period writes **no** row and stays `past_due`                                                                                                                                                                                                                                                                                                                                                                                                                                                | control (green) |
| `A5` | with the audit insert refused by `{ code: 91 }` (no `TransientTransactionError` label, every other collection forwarded to the driver's own `insertOne` resolved before the stub is installed), the scheduled transition is **unapplied** — `activePlanKey` unchanged, `scheduledChange` still set, `statusHistory` empty, no row — and the run **rejects** (`S2`); with the driver restored the same call applies and writes exactly one row                                                                                      | **RED**         |
| `A6` | the same refusal on the dunning path: `status` still `past_due`, plan and grace stamp unchanged, `statusHistory` empty, no row, the run rejects; restored, it downgrades and writes exactly one `grace_expired` row                                                                                                                                                                                                                                                                                                                | **RED**         |

**D3 — the third `writeAuditLog` parameter is pinned by the clock, not by a signature.**
`row.at` must equal the run's injected `NOW`. A seam that keeps stamping
`systemClock.now()` internally reds with the wall clock in the message, which is the
failure mode §D3 names ("the row's `at`/`expireAt` derive from the same instant as the
transition it records"). No `Function.length` trick and no `expectTypeOf` — both are
either unusable (a defaulted parameter is not counted) or inert without
`typecheck.enabled`.

**D4 — the atomicity cases pin **both** directions, because each half is vacuous alone.**
The refusal half is vacuous against a job that never writes a row (nothing to refuse);
the recovery half is vacuous against a job that writes the row **outside** the
transaction (the transition commits, the insert fails, and the refusal half's state
assertions pass for the wrong reason). Both halves therefore live in one case per job
path, and the run's **rejection** is pinned beside the state, so a job that swallowed
the failure and reported `errors: 1` — a silently unaudited downgrade — reds too.

**D5 — `I1` is amended exactly once, and the C6 invariant is unweakened.** The diff
becomes `["audit_logs", "domain_events", "subscriptions"]` and `audit_logs` joins the
harness's `beforeEach` `deleteMany` list (ADR-0975 §D6). The comment beside the
assertion names the six content collections that must stay absent, so a reader sees the
invariant rather than a widened literal. The rest of the file is append-only: `I2`–`I8`,
every helper and every fixture stay byte-identical. The `I1` **header sentence**
("changes only `subscriptions` (besides the `domain_events` outbox …)") is deliberately
left untouched by this card's append-only rule and is corrected by the GREEN in the same
edit that corrects `dunning.ts`'s docblock (§D6); the assertion's own comment carries the
amendment here.

**D6 — a characterization arm records that the request writes nothing.** One case in
`billing-plan-change.test.ts` (`A0`, appended at EOF, green on arrival): a successful
`POST …/billing/downgrade` answers `200`, stores
`scheduledChange = {toPlanKey:"free", reason:"self_downgrade"}` on the live row, leaves
`activePlanKey` alone, and `audit_logs` holds **no** row for the workspace. It is the
guard against the rejected alternative §Alternatives of ADR-0975 names, and it must never
be "fixed" by making the route write.

**D7 — boundary.** Test files only: one new unit spec, an append to `billing-crons.test.ts`
(plus the one `I1` line and the reset list), an append to `billing-plan-change.test.ts`,
and this record with its ledger row. No production file, no index spec, no schema edit, no
`/admin` route, no change to the member specs. The GREEN inherits these bytes from this
branch tip.

## Evidence

Authored on `origin/main` `1d326367`. Baselines **before** the append, same commands on
the same tree: `billing-crons.test.ts` `19 passed (19)`, `billing-plan-change.test.ts`
`29 passed (29)`, `apps/web/src/server/audit` (unit) `2 passed (2)`.

**Delivered RED** (the shipped tree, the artifacts the GREEN must satisfy):

```
$ npx vitest run --project integration apps/web/src/test/integration/billing-crons.test.ts
  × I1: a dunning run over a tenant with content changes only subscriptions (+ domain_events)
  × A1: a due scheduled self-downgrade writes one subscription.downgraded row with the matched pre-image
  × A2: an expired grace period writes one subscription.downgraded row from the matched pre-image
  × A5: a refused audit insert leaves a due scheduled change unapplied and writes no row, then applies with one row once the driver recovers
  × A6: a refused audit insert leaves a past_due row untransitioned and writes no row, then downgrades with one row once the driver recovers
AssertionError: expected [ 'domain_events', 'subscriptions' ] to deeply equal [ 'audit_logs', 'domain_events', …(1) ]
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected { …(26) } to match object { activePlanKey: 'starter' }
AssertionError: expected { …(26) } to match object { status: 'past_due', …(2) }
 Tests  5 failed | 20 passed (25)

$ npx vitest run --project unit apps/web/src/server/audit
TypeError: systemAuditActor is not a function   (×3)
 Tests  3 failed | 2 passed (5)

$ npx vitest run --project integration apps/web/src/test/integration/billing-plan-change.test.ts
 Tests  30 passed (30)                           # A0 is green on arrival, as declared

$ pnpm typecheck                                  # exit 2
apps/web/src/server/audit/audit-log-system-actor.test.ts(51,28): error TS2339: Property 'systemAuditActor' does not exist on type 'typeof import("…/apps/web/src/server/audit/audit-log")'.
  (and the same at 65,28 and 78,28 — three errors, no others)

$ npx vitest run --project unit                    # the whole `unit` project at this head
 Tests  3 failed | 3375 passed | 3 skipped (3381)   # 199 files; the three are these new cases
```

Before this record existed the full unit run read `4 failed | 3374 passed | 3 skipped (3381)`:
the fourth was `adr-source-references`, reporting four `dangling-reference` issues for
`"number": "0976"` — the source-citation guard refusing a spec that cites a record the
tree does not hold. It went green when this file landed, which is why the record is part
of the deliverable rather than an afterthought.

`A3` and `A4` are the only new cases green at this head, which is what makes them
controls rather than pins.

**Satisfiability probe (P0).** A temporary, never-committed near-fix of the **decided**
shape (ADR-0975 §D3–§D5) — the seam widened, both jobs switching to
`returnDocument: "before"` inside `withTransaction` and calling
`writeAuditLog(session, entry, now)` — turns the pack green: `billing-crons.test.ts`
`25 passed (25)` and the unit spec `5 passed (5)`. That is the proof the pins ask for a
shape that is implementable as decided, not an impossible one.

**Mutation probes** (each applied to the near-fix, measured, then reverted):

| Probe | Mutation                                                                                                                         | Result                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | the row written in its **own** `withTransaction` **after** the transition commits (the rejected "best-effort insert"), both jobs | `Tests 2 failed \| 23 passed (25)` — exactly `A5` and `A6`, on the state assertions (`expected { …(26) } to match object { activePlanKey: 'starter' }`, `… { status: 'past_due', …(2) }`); `A1`/`A2`/`I1` stayed green |
| P2    | the two `writeAuditLog` calls dropped, the seam left widened                                                                     | `Tests 5 failed \| 20 passed (25)` — the same five cases as the delivered RED, and the unit spec `5 passed (5)`, so the five reds are attributable to the missing **write**, not to the missing export                 |
| P3    | the downgrade route inserting an `audit_logs` row (the rejected alternative ADR-0975 §Alternatives names)                        | `billing-plan-change.test.ts`: `Tests 1 failed \| 29 passed (30)` — exactly `A0`, `expected [ { …(5) } ] to deeply equal []`, every shipped case green                                                                 |

**Restore proof.** `sha256sum -c` of the four production files against the base hashes
recorded before P0 is `OK` for all four
(`audit-log.ts` `2bdf96fb…`, `scheduled-plan-changes.ts` `5e59ac72…`, `dunning.ts`
`a9f0811c…`, `downgrade/route.ts` restored by `git checkout --`), and
`git status --short` lists only the three test files and this record. No near-fix, no
mutation and no stub is in the diff.

**Guards.** `pnpm typecheck` exit `0` once the seam is widened (P0 state); `eslint` on the
three touched spec files `No issues found`; `prettier --check` clean; the ADR guards
(`adr-numbering`, `adr-ledger-shape`, `adr-source-references`, …) green once this record
lands — the source-reference guard is what caught the `ADR-0976` citation in the new
spec's docblock before the record existed.

## Consequences

- **The GREEN's job is now exactly bounded.** Widen `audit-log.ts` once (union member,
  `systemAuditActor`, optional `target.kind`/`reason`, optional `at`), make both jobs run
  their conditional write and the audit insert in **one** `withTransaction` with
  `returnDocument: "before"`, and turn `I1`'s diff green by writing the row. Nothing else
  in the file may move.
- **A future refactor that preserves behaviour breaks none of these cases.** They assert
  the document, the key set, the workspace string type, the retention arithmetic and the
  aborted-then-applied state — never a call count, a private helper or an ordering inside
  the transaction.
- **Two behaviours stay unpinned on purpose.** Ordering inside the transaction (the row
  before or after the conditional write) is free, and the `domain_events` outbox is not
  re-pinned here — `I7`/`A1` already own it.
- **The request-side gap stays routed.** §3.3's missing
  `billing.plan.downgrade_scheduled` emission on `POST …/billing/downgrade` is card
  `t_d421271e` (`Consumes: 0978`), not this record's; `A0` records only that the route
  writes no **audit** row.

## Alternatives considered

- **Pin a `GET /admin/audit-logs` response (rejected).** §9.9 is contract-only; there is
  no `admin` route directory at this head. Pinning a route that does not exist would hand
  the GREEN an invented endpoint.
- **Pin a named import instead of the namespace (rejected for the unit spec).** A missing
  named export fails ESM linking, so all three new cases would red — including the
  four-key-set case whose value is that it is checkable the moment the builder exists.
- **Pin `writeAuditLog`'s arity (rejected).** A defaulted parameter is not counted by
  `Function.length`, and a two-parameter function is assignable to a three-parameter
  signature in TypeScript, so the arity carries no information. The clock assertion in
  `A1`/`A2` is the discriminating pin.
- **Assert only "no row" in the atomicity cases (rejected).** Vacuous against a job that
  never writes; P2 measures exactly that.
- **Assert only the state in the atomicity cases (rejected).** Silent against a job that
  writes the row out of the transaction (P1) once the transition is what commits.
- **Amend `I1` by widening it to "any non-content collection" (rejected).** An exact set
  is the stronger statement: a new collection appearing on the dunning path is a
  behaviour change and should be a reviewable diff, not a silently admitted one.
- **Leave `I1` rigid and skip the dunning row (rejected).** ADR-0975 §D6 and its
  §Alternatives settle it: `audit_logs` holds no content reference, so admitting it
  cannot hide a C6 regression, while refusing the row would leave non-payment
  unauditable.

## Numbering

`0976` is an allocator reservation carried in this card's body, used as given. The
four-surface sweep at this cut (`origin/main` `1d326367`) finds no `ADR-0976` on the
trunk (which ends at `0975`), in any `.worktrees/*/docs/adr` tree (the highest there is
`0978`, the sibling decision card `t_d421271e`), in
`git rev-list --objects --all -- docs/adr` (highest `0978`), on either open PR head
([#902](https://github.com/yahodu/openpic-webapp/pull/902),
[#896](https://github.com/yahodu/openpic-webapp/pull/896)), or in any non-`done` card's
`Consumes` — the non-`done` set holds `0976` (this card), `0977` (the gated GREEN) and
`0978` (the routed decision), and nothing else. No renumbering is needed.

The four pool-mirror cells (`board-wide / process`, `OP-129 attendee identity lane`,
`OP-136 jobs lane`, `unallocated (future lanes)`) read **`0976`** and advance to
**`0977`** — the higher of the trunk's value and `0976 + 1`. No cell is lowered and no
range is re-cut; the fact that the gated GREEN already holds `0977` is why the cursor
does not stop at `0976`.

## Assumptions

- **S1 — `at` is the job's injected clock instant.** Every case runs `fixedClock(NOW)`,
  so `row.at` must be `NOW`. A seam that stamps the wall clock reds with a real timestamp
  in the message.
- **S2 — a refused audit insert is not swallowed.** `{ code: 91 }` carries no
  `TransientTransactionError` label, so `withTransaction` rethrows on the first attempt;
  the run rejects, which is the `internal_error` path ADR-0975 §D4 names. A per-row
  `try/catch` that counted `errors: 1` would leave a committed, unattributed downgrade
  and reds `A5`/`A6`.
- **S3 — the two pre-images differ by shape, not by rule.** The scheduled row narrows
  `before` to `{ activePlanKey }` (the only field its conditional write replaces beyond
  `scheduledChange`, which the row does not record); the dunning row narrows to
  `{ status, activePlanKey }`. No field is added to `after`.
- **S4 — `A0` is a characterization arm, not a pin.** It is green at this head by design
  and must stay green; P3 is the measurement that it can fail.
