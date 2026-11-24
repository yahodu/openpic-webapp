# ADR-0980 — OP-101: the GREEN of ADR-0978 — the downgrade request emits inside its transaction, and the billing contact hears about it

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 GREEN `t_ddd87497` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-downgrade-scheduled-event` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-scheduled-event-red`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0980` — the reservation [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) §Consequences assigned to this gated GREEN when it was created, used as given (not a fresh draw)
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`), §7.7; schema §18.3 (`domainEvents`), §19.1 (`notificationTypes`), §20.2 (`auditLogs`); notification design §2 (audiences), §4.3 (the billing matrix), §4.5 (the event-lifecycle audiences that carry "minus the actor")
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D1–§D5 — the decision this record implements), [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) (the 15 pins carried unchanged and satisfied), [ADR-0975](ADR-0975-op101-billing-downgrade-audit-write.md) (§D9 — the request writes no audit row, characterised by `E1`), [ADR-0974](ADR-0974-op101-audit-txn-failed-membership-pins.md) (the `{ code: 91 }` refusal recipe `C1` uses), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18: the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** none in source — no source comment cites this record; the shape it implements is cited as [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md), which `apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts` and `apps/web/src/server/notifications/fan-out.ts` name. This record's only citation is its ledger row below.

## Context

[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) decided both
halves: the request emits `billing.plan.downgrade_scheduled` inside its own write
transaction (§D1, §D2) and the billing contact receives it even when they are the
actor (§D3), while the request writes no `auditLogs` row (§D4) and
`DELETE …/billing/scheduled-change` stays log-only (§D5).
[ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) pinned that contract
as one integration spec — 15 cases, `13 failed | 2 passed (15)` on its own head,
with `D3` and `E1` the declared green controls. This card is the GREEN half: the
spec bytes are carried unchanged and no assertion is edited, relaxed or reordered.

## Decision

**D1 — the request emits in the write's transaction.** `POST …/billing/downgrade`
wraps the existing `subscriptions.updateOne` and one `emitDomainEvent` in a single
`withTransaction` callback, `{ session }` on both — the shape
`billing/upgrade/route.ts` already ships. The auth, role, tier, acknowledgement
and usage branches, the `200` body and the log line are byte-identical; the log
line stays outside the transaction body.

**D2 — the event is exactly §D2.** `eventKey` the catalogue key, `tenantId` the
workspace hex string, `actorRef { kind: "user", id: scope.userId }`,
`subjectRef { kind: "subscription", id: <live row hex> }`, payload exactly
`{ fromPlanKey, toPlanKey, effectiveAt: <ISO 8601> }` and
`dedupeKey billing.plan.downgrade_scheduled:<subscriptionId>:<toPlanKey>:<effectiveAt>`.
`expireAt` and `dispatch.notifications` are `emitDomainEvent`'s own, so a
hand-rolled insert cannot pass `A4`/`A5`. No `actionUrl` (§D2): this repository
ships no billing screen, and the seeded copy renders the declared variable empty
exactly as `billing.plan.downgrade_applied` does.

**D3 — the repeat is read before it is written.** The transaction reads
`platformRepo(db).collection(COLLECTIONS.domainEvents)` for the same `dedupeKey`
(with the session) and emits only when no row exists. This is not decoration:
`emitDomainEvent`'s duplicate-key arm cannot save the caller here, because a
unique-index violation inside a transaction is not a settled write error the
driver reports back — measured, the emit-and-let-the-index-dedupe shape answers
`500` on the second identical request (`B1`), and it is the only reason the guard
exists. A re-schedule to a different target plan (`B3`) or a later instant (`B4`)
is a different key and therefore a second row by construction.

**D4 — the payer is not the excluded actor.** In `resolveRecipients`, the ids the
`billing_contact` audience resolves are collected into a `payers` set, and the
actor exclusion skips the actor when that set holds them. The rule is
audience-scoped, never `typeKey`-scoped: §4.3 names the payer as the recipient
with no actor exclusion, and only §4.5's event-lifecycle audiences carry "minus
the actor". Everything else moves as before — a non-contact actor is still
removed (`D2`), a `system` actor excludes nobody (`D3`), and the
`processEvent` docblock now states the rule. **Side effect, stated as the ADR
required:** `billing.plan.upgraded`, emitted today with the same audience and a
user actor, starts reaching the owner it was always meant for.

**D5 — nothing else.** No catalogue, template, §4.3 matrix, schema, index,
`scheduled-change/route.ts`, billing-job, audit-seam or `billing-crons.test.ts`
change. `E1` stays green and the request grows no audit write.

## Consequences

- Both halves ship in one PR on the RED parent's branch, with the parent's spec
  bytes and [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md)
  unchanged.
- One insert and one transaction per owner-only request — not a hot path — and
  one in-app row plus one email per accepted request, which is §4.3's own
  promise.
- The dedupe read is snapshot-consistent with the insert (same session), so a
  sequential repeat collapses to one row; a truly concurrent double-submit is out
  of the pinned contract (ADR-0979 §out_of_scope) and still ends at the unique
  index, whose failure mode is a `500` on the losing request rather than a second
  row.
- **Accepted loss:** the same audience-scoped rule means a workspace whose
  billing contact is its owner now emails the owner on `billing.plan.upgraded`.
  That is the matrix's intent, not a regression.

## Numbering

This record consumes `0980`, the number its card carried, as a **pool draw**
(ADR-0300 §11 item 18: the board-wide block `0300`–`0319` is exhausted). The
four-surface sweep at this cut finds no `ADR-0980` anywhere:

```
$ git rev-parse --short origin/main                                9160a962
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -4
                                                                   0975 0976 0977 0978
$ for d in .worktrees/*/; do ls "$d/docs/adr" | grep -oE 'ADR-09(7[5-9]|8[0-9])'; done   # highest 0979 (this card)
$ git rev-list --objects --all -- docs/adr | grep -c 'ADR-0980'     0
$ gh pr list --state open  # 907 -> 0978, 906 -> 0979 (this branch), 896 -> 0973
```

No non-`done` card holds `0980` except this one. The four pool-mirror cells that
read `0980` — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136
jobs lane`, `unallocated (future lanes)` — advance to **`0981`** (the higher of
the trunk's value and `0980 + 1`); no cell is lowered and no range is re-cut.
Hotspot: `docs/adr/README.md` (row `0980`, four cells) — merge as a union
keeping the highest value in every cell.

## Evidence

Measured at the delivered head `e91cfed7` (PR #906's squash). The branch merged
`origin/main` `d944df8a` — OP-132 #907 — before delivery, which is why the
whole-project figures sit 20 tests above the pre-merge run: that merge brought
the `adr-gate-conditions` spec, one file of 20 tests, so the guard family is ten
files here and not the nine the branch cut carried.

```
$ pnpm exec vitest run --project integration apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts
Tests  15 passed (15)          # before: 13 failed | 2 passed (15); three consecutive runs identical

$ pnpm exec vitest run --project integration          # whole project: 166 files, Tests 1810 passed (1810)
$ pnpm exec vitest run --project unit                 # whole project: 200 files, Tests 3398 passed | 3 skipped (3401)
$ pnpm exec vitest run --project unit adr-            # the adr-* guards: 10 files, Tests 319 passed (319)
$ pnpm typecheck                                      # exit 0
$ pnpm exec eslint <both files>                        # 0 errors (8 pre-existing warnings, untouched lines)
$ pnpm exec prettier --check <both files>               # All files formatted correctly
```

Negative control (ADR-0978 §D1, the ADR-0979 probe re-run against the shipped
code): with the guard and the emit moved **outside** `withTransaction` and
everything else unchanged, `C1` is the only red —

```
Tests  1 failed | 14 passed (15)
FAIL  C1 … AssertionError: expected { toPlanKey: 'free', …(2) } to be null
```

— and the file is then restored byte-identically
(`sha256 e66bcc7f…a8e09` before == after).

## Round-1 review sign-off

- **Reviewer:** `openpic-webapp-reviewer` · **Round:** 1 (artifact lens) · **Card:** `t_a24b1dc1` · **Verdict: APPROVED WITH FINDINGS.**
- **Verified on the merged artifact, not the narrative.** `e91cfed7` is an
  ancestor of `origin/main` (`git merge-base --is-ancestor`), its tree is
  byte-identical to the tested head `a2ed9833` (`git diff --stat` empty), and the
  three lane blobs on `main` equal the reviewed tree (`route.ts` `51de695c`,
  `fan-out.ts` `83a1c8ce`, the spec `36058408`). The spec blob is identical at the
  RED commit, the head and the squash, so no assertion was edited.
- **Counts at `e91cfed7`:** focused spec `15 passed (15)` on three runs; whole
  `integration` 166 files `1810 passed (1810)`; whole `unit` 200 files
  `3398 passed | 3 skipped (3401)`; the ten `adr-*` guards 10 files
  `319 passed (319)`; typecheck 0/0/0; eslint 0 errors; prettier clean. The unit
  and guard figures this record first carried (199 files, `3378 passed` with 3
  skipped, nine guards) were the pre-merge run; §Evidence now states the head the
  record describes, and says why the counts moved (finding F3).
- **Conformance:** §D1–§D5 landed line by line — one `withTransaction` holding the
  update and one emit, §D2's event exactly, the branches and the `200` body
  byte-identical, the exemption audience-scoped by construction, no `auditLogs`
  row, and `DELETE …/billing/scheduled-change` still log-only.
- **Measured finding (F1):** a `typeKey`-scoped variant of the §D3 exemption — the
  shape §D3 rejects — still answers `15 passed (15)`, so the pins cannot tell the
  audience-scoped rule from the one it replaces. Routed to `t_dd0046f3` (with the
  unpinned `billing.plan.upgraded` side effect, the null-`currentPeriodEnd`
  fallback and the concurrent-repeat answer) and to `t_05a6943b` (the dedupe probe
  reads `COLLECTIONS.domainEvents` outside the domain-events seam).
- **Merged** as squash `e91cfed7`; PR
  [#906](https://github.com/yahodu/openpic-webapp/pull/906) carries the verdict.
- **Post-review status (appended 2026-11-24, after this round-1 merge).** The routed
  follow-up **F4** (`t_05a6943b`) has since landed as PR
  [#909](https://github.com/yahodu/openpic-webapp/pull/909), squash `404872ee`: the
  downgrade route now asks `findDomainEventByDedupeKey`, exported beside
  `emitDomainEvent` in `server/domain/domain-events.ts`, instead of reading
  `platformRepo(db).collection(COLLECTIONS.domainEvents)` directly, so the dedupe-seam
  finding above is closed and the emitter remains the only outbox writer. The
  blob-identity sentence in this sign-off is therefore a statement about the review cut
  `e91cfed7`, not about the trunk: on `main` (measured at `03a5fbd5` and at
  `f0422e2e`) `route.ts` is `152e5d3c`, while `fan-out.ts` `83a1c8ce` and the spec
  `36058408` are unchanged.
- **F1** (`t_dd0046f3`) was still in flight when this status was drafted: the
  audience-vs-`typeKey` pin pack, with the `billing.plan.upgraded` side effect, the
  null-`currentPeriodEnd` fallback and the concurrent repeat. It landed before this
  paragraph merged — PR [#911](https://github.com/yahodu/openpic-webapp/pull/911),
  squash `f0422e2e`, carrying
  [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md), whose §D5 leaves
  the other two items routed — so F1 is closed by its own record and no further pin
  is owed for the exemption itself.
- The merged PR's handoff claimed this sign-off already carried a note that `#909` had
  landed on trunk. It did not — a `grep -n 909` of the merged record returned nothing —
  so that note is this paragraph, added after the fact.
