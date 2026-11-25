# ADR-0985 — OP-101 GREEN: the period-less downgrade refusal landed (`409 conflict no_period_end`) and the `?? now` fallback is deleted

- **Status:** Accepted · **Date:** 2026-11-25
- **Card:** OP-101 GREEN `t_b4d8d70e` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-downgrade-no-period-end` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-no-period-end-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0985` — the reservation the orchestrator card `t_cb891a2c` carried, used as given (not a fresh draw); the four pool-mirror cells read `0987` at this cut, which is above `0985 + 1 = 0986`, so no cell moves and none is lowered
- **Spec sources:** [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) (the decision of record and the pinned refusal, carried byte-unchanged), contract §3.3 (`POST …/billing/downgrade`, the `scheduledChange` write and its period-end instant), contract §A (the admin `PATCH /admin/subscriptions/{id}` repair path, `reason` required), schema §14.3 (`subscriptions`, `currentPeriodStart` / `currentPeriodEnd` a `date`), [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2 (the `dedupeKey`)
- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts` (the guard, the widened reader, the deleted fallback), `apps/web/src/test/integration/billing-plan-change.test.ts` (`F5`, `F5b`; `I4` the control)
- **Relates to:** [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) (the decision this record executes), [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md) (the open question it supersedes), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D3 (the `alreadyEmitted` pre-read the stable instant feeds), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §D5 (the measured duplicate this refusal makes impossible), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 (the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) decided that a
downgrade against a live subscription with no `currentPeriodEnd` is **refused**,
not scheduled at the clock. It pinned the refusal in
`apps/web/src/test/integration/billing-plan-change.test.ts` and left the
production tree untouched, so the pack was RED by design at this branch's parent
commit: `F5` read `expected 200 to be 409` (the shipped
`const effectiveAt = current.currentPeriodEnd ?? now` still scheduled) and `F5b`
read `expected 500 to be 409` (the shipped
`currentPeriodEnd: z.date().optional()` rejected an explicit `null` inside
`parse`, which surfaced as `internal_error`). This record is the landing: the
spec bytes are carried unchanged and the production tree now satisfies them.

## Decision

**D1 — what landed, and nothing else.**

1. `liveSubscriptionSchema` in
   `apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts` widens
   one field: `currentPeriodEnd: z.date().nullable().optional()`, so an explicit
   `null` reaches the guard as a value instead of throwing out of `parse`.
2. Immediately after `liveSubscriptionSchema.parse(stored)` — beside
   `no_live_subscription`, before the target plan loads and before the
   acknowledgement prompt — the route refuses:

   ```ts
   const periodEnd = current.currentPeriodEnd ?? null;
   if (periodEnd === null) {
     throw appError("conflict", { details: { reason: "no_period_end" } });
   }
   ```

3. The fallback is deleted:
   `const effectiveAt = current.currentPeriodEnd ?? now;` becomes
   `const effectiveAt = periodEnd;`. `now` stays where it already served another
   purpose (`updatedAt`, `resolveUsageFacts`).
4. Contract §3.3 gains one sentence after its `scheduledChange` sentence: a live
   subscription whose `currentPeriodEnd` is absent or `null` answers
   `409 conflict` with `details.reason: "no_period_end"` and writes nothing.

No other route, job, service, or spec byte moves. `conflict` is the shipped
`409` code and `details.reason` is the shipped shape for a specific conflict, so
the error catalogue is untouched.

**D2 — the exact refusal shape.** `409`, `error.code` `conflict`,
`error.details.reason` `no_period_end`, and no write: `subscriptions.scheduledChange`
stays unset and no `billing.plan.downgrade_scheduled` row is emitted. Both
shapes of the same state — the field `$unset` and the field explicitly `null` —
answer identically.

**D3 — why refuse (summary; the argument is ADR-0984's).** Refusal is what
[ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) decided, for its five
reasons: §3.3 names `currentPeriodEnd` and no other instant; schema §14.3 makes
the field a `date`, so its absence is a repairable row-integrity gap (contract §A
admin `PATCH`); no stored field _means_ period end, so a derived instant would
redefine `effectiveAt`; refusal keeps [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md)
§D2's `dedupeKey` stable, so two identical requests compute one key and
[ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §D3's pre-read
collapses them; and one refusal covers the explicit `null` shape that used to be
a `500`. This record does not re-argue them.

**D4 — the rejected alternative: derive a stable instant.** Rejected on the same
ground as ADR-0984's reason 3. There is no stored field that _means_ period end;
reusing `updatedAt`/`createdAt` would silently redefine `effectiveAt`, apply a
paid-plan downgrade the customer did not get a period for, and still need its own
contract §3.3 amendment. A refusal is reversible through the admin `PATCH` and
needs no amendment.

**D5 — what does not change.** The acknowledgement exchange and its
`details.consequences` payload; the tier check (`not_a_downgrade`); the emit
inside the request transaction; `B1`'s sequential-repeat dedupe; and the admin
`PATCH /admin/subscriptions/{id}` repair path. `I4` (the accepted direction:
`200` with `effectiveAt` equal to the stored period end) and the sibling
`billing-downgrade-scheduled-event.test.ts` (`B1`–`B5`) stay green, so the
refusal is not "refuse everything".

## Consequences

- The `?? now` fallback and its characterisation are gone; [ADR-0462](ADR-0462-op109-plan-change-followup-pins.md)'s
  open product question is answered by [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md)
  and executed here.
- Every _accepted_ schedule's instant is now the stored period end, so the
  measured duplicate (two events under keys differing only in the clock
  milliseconds) cannot occur, and no second dedupe special case was added.
- A period-less live row is now load-bearing on the admin `PATCH` repair path:
  without a period end the downgrade has no exit, and that is deliberate — a row
  with no period to schedule against is repaired, not guessed at.
- **Reversal condition.** A product decision that a period-less row downgrades
  immediately needs its own contract §3.3 amendment and its own record; it cannot
  be reintroduced as a fallback, because the fallback is what made the duplicate
  possible.
- **Numbering.** `0985` was used as given. The four-surface sweep at this cut
  (`origin/main` `a1c6d51c`): the trunk holds `0980`–`0983` and `0986`; the
  worktree trees hold `0984` and `0986`; the all-ref listing holds `0984` and
  `0986`; open PR heads #926 and #896 hold no `0984`–`0989`; and no non-`done`
  card's `Consumes` holds `0985` except this card. No ref holds it, so no
  renumbering was needed. The four pool-mirror cells (`board-wide / process`,
  `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future
lanes)`) read `0987` on the trunk and here; the higher of `0987` and `0986` is
  `0987`, so no cell is edited and none is lowered. Hotspot:
  `docs/adr/README.md` (this record's ledger row) — merge as a union keeping the
  highest value in every cell.

## Verification

Focused `billing-plan-change.test.ts`: `2 failed | 29 passed (31)` before the
change (`F5` `expected 200 to be 409`, `F5b` `expected 500 to be 409`) and
`31 passed (31)` after. Sibling `billing-downgrade-scheduled-event.test.ts`:
`16 passed (16)`. Negative control: restoring
`const effectiveAt = current.currentPeriodEnd ?? now;` in a scratch copy reds
`F5` again, and the file is restored byte-identically. The whole `unit` and
`integration` projects, `pnpm typecheck`, `pnpm lint`, `prettier --check` and the
`adr-*` guards are quoted in the card handoff.

## Round-1 review sign-off

- **Verdict: APPROVED WITH FINDINGS** — card `t_b4d8d70e` (`openpic-webapp-reviewer`), round 1, artifact + execution lens, recorded in the review comment `7149339076` on PR [#925](https://github.com/yahodu/openpic-webapp/pull/925). The implementer merged before the review lane ran, so this is a **post-merge** verification of the landed bytes, not a pre-merge approval: `gh pr view 925` answers `state=MERGED`, `mergeCommit 468f1542`, `head f1f6ab3a`, and `git merge-base --is-ancestor 468f1542 origin/main` succeeds at the base this section lands on (`7fe38594`).
- **Land proof, per path.** `git diff --stat f1f6ab3a 468f1542 -- <every path in the PR>` is **empty**, so every lane byte that landed is the reviewed byte, and the spec answers one blob at both commits (`449b49a3b58074c9153219f94cbceacd68f00c50`). The whole-tree diff `git diff --stat f1f6ab3a 468f1542` is one path, `docs/adr/ADR-0986-op101-actor-exemption-namespace-agnostic-pin.md` (+16/−0), which is main's own intervening commit `02281437` (PR [#927](https://github.com/yahodu/openpic-webapp/pull/927)) on a path this PR never touches; `468f1542`'s single parent is `02281437`.
- **Counts re-measured by the reviewer** in a throwaway worktree detached at `468f1542`, with `node_modules`, `apps/web/node_modules` and `packages/contracts/node_modules` symlinked and `git diff --stat 468f1542 7fe38594 -- packages/contracts apps/web/src/server` empty (so the symlinks mix no two trees): focused `billing-plan-change.test.ts` **31 passed (31)**; sibling `billing-downgrade-scheduled-event.test.ts` **16 passed (16)**; whole `unit` **201 files / 3423 passed | 3 skipped (3426)**; the ten `adr-*` guards **10 files / 340 passed (340)**; `prettier --check` clean on all six PR paths — the review comment's "four changed files" is a smaller set of the same green.
- **Probe table — each mutation applied to the detached probe worktree, run, and reverted.**

  | probe | mutation                                                                            | measured                                                                                 |
  | ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | P2    | revert the whole production change (`git checkout 06453275 -- route.ts`)            | `2 failed \| 29 passed (31)` — `F5 expected 200 to be 409`, `F5b expected 500 to be 409` |
  | P1    | keep the guard, restore only `const effectiveAt = current.currentPeriodEnd ?? now;` | `31 passed (31)`                                                                         |
  | P4    | near-fix: refuse only `=== undefined`, schema widened                               | `1 failed \| 30 passed (31)` — `F5b expected 500 to be 409`                              |
  | P3    | move the guard after the plan load and tier check                                   | `31 passed (31)`                                                                         |
  | P5    | move the guard after the acknowledgement prompt                                     | `31 passed (31)`                                                                         |

- **The probe worktree was restored after every arm**: the route read `sha256 ba6f5945829bffe1a5177f3506099b201877c64d5e4c6fd6c4c9430691f16c31` again with `git status --porcelain` empty, so no arm's mutation reached a count quoted here.
- **Correction C1 (Low, docs accuracy).** §Verification's "Negative control: restoring `const effectiveAt = current.currentPeriodEnd ?? now;` in a scratch copy reds `F5` again" is **not reproducible as written**: with the guard in place that line is unreachable, and P1 measures `31 passed (31)`. The control that does red both pins is the whole-change revert, P2 (`2 failed | 29 passed (31)`), which is what the card handoff metadata records. §Verification stands as merged and is corrected here: the control reverts the whole production change, not the one line. The same sentence sits in the `0985` ledger row, which is left byte-identical for the same reason, so the correction is carried by this section for both sites.
- **Correction C2 (Low, docs completeness).** §Consequences' "A period-less live row is now load-bearing on the admin `PATCH` repair path" understates the exits. `apps/web/src/server/billing/webhook-projection.ts:273` (`subscription_activated`) and `:304` (`payment_succeeded`) both write `currentPeriodEnd: end`, where `periodEnd()` at `:183`–`:187` anchors on a stored period end while it is still future and otherwise on `now`, plus `BILLING_PERIOD_DAYS = 30` (`:159`); and `PATCH /admin/subscriptions/{id}` is **contract-only at this head** — no `apps/web/src/app/api/v1/admin` route directory exists. The refusal is therefore not terminal: the next activation or charge webhook restores a period end.
- **Findings routed, by card id** — not open defects of this delivery. The precedence pin is `t_6d7eb4f1` (TEST, `openpic-webapp-testcase-writer`; a child of this card, so it starts when this card closes), the still-open `cancel`-route `?? now` decision is `t_181a9c55` (`openpic-orchestrator`), and this section itself is card `t_d8c4ac80`. The board carries those two ids, not the `t_0d4c7b4e` / `t_c0bf5a1f` the sign-off card's body named: the body was written before the cards existed, and the measured ids are the two above.
- **Nothing is retracted.** No sentence of §D1–§D5, §Consumers or the `0985` ledger row is withdrawn. C1 corrects how the control was _described_ and C2 names exits the consequence sentence left _out_; the decision, the refusal shape, the deleted fallback and the record's own numbering all stand, and each follow-up's own record documents what followed it.
- **Numbering — this append consumes nothing.** At this cut `origin/main` (`7fe38594`) holds **491** `ADR-*` records with no duplicate number (`ls docs/adr | sed 's#.*/##' | grep -oE 'ADR-[0-9]{4}' | sort | uniq -d` empty) and exactly one `ADR-0985` path; `git rev-list --objects --all -- docs/adr | grep -c ADR-0985` answers `1`; the four pool-mirror cells (`board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) all read `0987`. No ADR number is consumed and no ledger cell is edited.
- **This append's own delivery.** One file, `docs/adr/ADR-0985-op101-downgrade-no-period-end-green.md`, `+23/−0`; `docs/adr/README.md` is byte-identical to `origin/main` (`blob d67203034ccdf7bb390110eb27322cb8d94832a7`, `sha256 981e4c5307e524f4d94d17d0a6572d7846c4bb1c4aa340d41f1383beceda44d4` at the base it lands on); `prettier --check` is clean and the ten `adr-*` guards stay `10 files / 340 passed (340)`.
