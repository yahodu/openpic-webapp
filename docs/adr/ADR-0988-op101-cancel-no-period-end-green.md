# ADR-0988 — OP-101 GREEN: the period-less `cancel` refusal landed (`409 conflict no_period_end`) above the provider call

- **Status:** Accepted (GREEN) · **Date:** 2026-11-25
- **Card:** OP-101 GREEN `t_65945a20` (openpic-webapp-backend-coder) · **Branch:** `OP-101-task-cancel-no-period-end` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-cancel-no-period-end-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0988` — the reservation the decision card `t_181a9c55` carried, used as given (not a fresh draw); the four pool-mirror cells read `0988` at this cut and advance to **`0989`** = the higher of the cell and `0988 + 1`
- **Spec sources:** [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) (the pins `K1`–`K5`, carried byte-unchanged), contract §3.3, the cancel subsection (`docs/API Contract.md:1174-1182`), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 (the refusal this record extends one route over), schema §14.3 (`subscriptions.currentPeriodEnd` is a `date`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 (the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)
- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts` (the guard, the deleted `?? now` derivation), `apps/web/src/test/integration/billing-self-serve.test.ts` (`K1`–`K5` plus the shipped arm in the `POST …/billing/cancel` describe)
- **Relates to:** [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) (the decision of record this landing executes), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 / [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the downgrade route's identical answer — untouched here), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18, [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)

## Context

[ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) decided that an
at-period-end cancel against a live subscription with no `currentPeriodEnd` is
**refused**, not turned into an immediate stop, and pinned five cases
(`K1`–`K5`) in `apps/web/src/test/integration/billing-self-serve.test.ts`. The
production tree was untouched, so the pack was RED by design at this branch's
parent commit: `K1`/`K2` read `expected 200 to be 409` (the shipped
`current.currentPeriodEnd ?? now` still answered the receipt) and `K4` read
`expected { code: 'mandate_not_chargeable', … } to match object { code:
'conflict', … }` (the mandate check ran above any period-end guard).

This record is the landing. The spec bytes, [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md)
and its ledger row are carried unchanged; one production file, one contract
§3.3 sentence, and this record plus its ledger row are new.

## Decision

**D1 — what shipped, and nothing else.** In
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts`,
immediately after `const current = liveSubscriptionSchema.parse(stored);` and
**before** `providerRefOf` and `cancelMandate`:

```ts
// §3.3 (ADR-0987): a request to stop at period end needs a period end to stop
// at. The refusal is decided before the mandate is released, so a refused
// request is a no-op at the provider as well as on the row — ADR-0984's answer
// one route over; the two billing routes must not disagree.
let cancelAt = now;
if (ctx.body.atPeriodEnd) {
  const periodEnd = current.currentPeriodEnd ?? null;
  if (periodEnd === null) {
    throw appError("conflict", { details: { reason: "no_period_end" } });
  }
  cancelAt = periodEnd;
}
```

The old derivation — `const cancelAt = ctx.body.atPeriodEnd ?
(current.currentPeriodEnd ?? now) : now;` — is deleted; the pre-computed
`cancelAt` feeds the existing `$set` unchanged, so no `?? now` survives in the
`atPeriodEnd` branch and no non-null assertion or helper could reintroduce the
fallback.

**D2 — the refusal shape.** `409`, `error.code` `conflict`,
`error.details.reason` `no_period_end`, and no side effect: nothing is written
(`cancelAt`, `cancelReason` and `cancelledAt` stay null, `status` stays `active`,
`updatedAt` keeps the seed's instant) and nothing is released at the provider
(zero `cancelMandate` calls). Both shapes of the same state — the field `$unset`
and the field explicitly `null` — answer identically; the reader already widens
it to `z.date().nullish()`, so an explicit `null` reaches the guard instead of
throwing out of `parse`.

**D3 — the guard position is the decision, not an implementation detail.** It
sits before `providerRefOf`/`cancelMandate` for two reasons: a refused request
must be a no-op at the provider (`K1`, `K2`, `K4` all assert zero calls), and
the refusal outranks `mandate_not_chargeable`, so a row that is both period-less
and mandate-less answers `no_period_end` (`K4`) while a row that does carry its
period end and has no mandate still answers `mandate_not_chargeable` (`K5`).
The three negative controls below measure that both halves are load-bearing.

**D4 — `atPeriodEnd: false` is unchanged.** It never reads `currentPeriodEnd`:
the stop is immediate, `cancelAt` is the request instant (`now`), the provider is
called exactly once and the stored instant equals the receipt's. `K3` pins that
on the very same period-less row, so the refusal is scoped to one branch and is
not "refuse everything".

**D5 — what does not change.** `ownerOnlyTenant` authorization, the `not_found
no_live_subscription` arm, the `mandate_not_chargeable` arm, the
`upstream_unavailable` arm and its `retryAfterSeconds`, `CANCEL_NOTE`, the
response shape, the log line, and the `$set` fields (`cancelAt`, `cancelReason`,
`updatedAt`) are byte-identical. The downgrade route, its spec and its contract
sentence are untouched.

## Consequences

- A live row with no `currentPeriodEnd` can no longer be stopped "at period end";
  the caller gets a named `409` instead of a silent immediate stop. The
  immediate cancel (`atPeriodEnd: false`) remains available, so the customer is
  never trapped.
- The row is not stuck permanently: `webhook-projection.ts` restores a period end
  on the next subscription event — the activation patch (`:273`) and the
  `payment_succeeded` patch (`:304`) both set `currentPeriodEnd` (and
  `nextChargeAt`), and the admin `PATCH /admin/subscriptions/{id}` path
  (contract §A, `reason` required) repairs a row-integrity gap directly.
- The two billing routes now answer the same row state the same way, which is
  what [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1 and
  [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) already do for the
  downgrade; the cancel route's `?? now` fallback is gone for the `atPeriodEnd`
  direction.
- **Reversal condition.** A product decision that a period-less row cancels at a
  clock instant needs its own contract §3.3 amendment and its own record — it
  cannot come back as a `?? now` fallback, because that is the silent
  reinterpretation this landing removes.
- **Numbering.** `0988` was used as given. The four-surface sweep at this cut
  (`origin/main` `08c778bc` plus #930's tree): the trunk's highest record is
  `0986`; `git rev-list --objects --all -- docs/adr` ends at `0987` (this
  branch); every `.worktrees/*/docs/adr` tree ends at `0987` (this worktree) and
  no other worktree holds `0988`; the open PR heads hold `0986` (#932, #931's
  base) and `0973` (#896); and no non-`done` card's `Consumes` holds `0988` but
  this card. `ADR-0987` exists exactly once, on this branch. No collision, so no
  renumber. The four pool-mirror cells (`board-wide / process`, `OP-129 attendee
identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) all read
  `0988`; the higher of `0988` and `0988 + 1` is `0989`, so each advances to
  **`0989`**. No other cell moves, no cell is lowered and no range is re-cut.
  Hotspot: `docs/adr/README.md` — merge as a union keeping the highest value in
  every cell.

## Verification

Measured at head `9fc2a3f6` (this branch's implementation commit: the route plus
the contract §3.3 sentence; the record and its ledger row add no executable
surface).

**The pins.** Focused cancel describe (`-t "billing/cancel"`): RED — measured by
the authoring card on base `08c778bc` plus the spec only — `3 failed | 3 passed |
36 skipped (42)`; after this landing `6 passed | 36 skipped (42)` (the shipped
arm plus `K1`–`K5`). Whole file: `3 failed | 39 passed (42)` before,
`42 passed (42)` after — the RED baseline's `37 passed (37)` plus the five pins.

**Siblings unchanged and green.** `billing-plan-change.test.ts` `31 passed (31)`
and `billing-downgrade-scheduled-event.test.ts` `16 passed (16)`; the three
billing specs in one run read `3 passed (3)` files / `89 passed (89)` tests.

**Negative controls, each measured then reverted byte-identically.**

1. _Restore `?? now`_ (guard removed, the old derivation put back): focused
   `3 failed | 3 passed | 36 skipped (42)` — `K1` and `K2` `expected 200 to be
409`, `K4` `expected { code: 'mandate_not_chargeable', … } to match object
{ code: 'conflict', … }`. The probe bytes reproduce the pre-GREEN route
   exactly (`sha256 86d3b24d…`).
2. _Move the guard below `cancelMandate`_ (after the provider call, before the
   write): `3 failed | 3 passed | 36 skipped (42)` — `K1` and `K2` red because
   the provider is called once before the refusal, `K4` red because the mandate
   check fires first. The card predicted `K1`/`K4`; the measured set is
   `K1`/`K2`/`K4`, and the extra red is the provider-call half of `K2`.
3. _Move the guard below `providerRefOf`_ (after the mandate check, before the
   call): `1 failed | 5 passed | 36 skipped (42)` — `K4` alone, the precedence
   case, exactly as [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md)
   measured.

After each probe the route was restored and the GREEN bytes re-verified
(`sha256 b12b9be5…` for the shipped route).

**Gates.** `pnpm typecheck` exit `0`; `pnpm lint` exit `0` (the repository's
pre-existing warnings only, none in the touched files); `prettier --check` clean
on the changed files; the ten `adr-*` guards green in the whole `unit` run, and
the whole `unit` and `integration` projects green.

## Review sign-off

- **Verdict: APPROVED WITH FINDINGS** — card `t_d446d250` (`openpic-webapp-reviewer`, round 1, artifact + execution lens), and a **post-merge** verification of the landed bytes: PR [#931](https://github.com/yahodu/openpic-webapp/pull/931) answers `state=MERGED`, `head 3b5a708a`, `mergeCommit fc8fab29` and `mergedAt 2026-11-25T02:18:20Z`, and `git merge-base --is-ancestor fc8fab29 origin/main` succeeds at the base this section lands on (`d614bafc`). The guard, its position, the five pins and the three negative controls all verify; the two Medium findings are record defects this delivery introduced and are repaired by card `t_511d9cc2` (this append), and the two Low findings are routed — `t_6f146377` (the pin's `details` assertion and [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) §Pins) and `t_1bb6d2c3` (the `adr-ledger-shape` guard stays green on a detached ledger row).
- **The guard and its position, measured on the landed route** — `git rev-parse fc8fab29:apps/web/src/app/api/v1/tenants/[tenantId]/billing/cancel/route.ts` answers `6a8e2cd8…`, `sha256 b12b9be5…`: `liveSubscriptionSchema.parse` at `:78`, the period-end block at `:84`–`:91` with `throw appError("conflict", { details: { reason: "no_period_end" } })` at `:88`, `providerRefOf` at `:93` and `cancelMandate` at `:101`, so a refused request releases nothing at the provider and the refusal outranks `mandate_not_chargeable`, which is what §D1 and §D3 decide. No `?? now` survives in the `atPeriodEnd` branch.
- **The five pins** are in `apps/web/src/test/integration/billing-self-serve.test.ts` — `K1` `:750`, `K2` `:793`, `K3` `:827`, `K4` `:868`, `K5` `:906`, the spec blob `0a481d86…` — and they are the decision [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) records, carried byte-unchanged.
- **The three negative controls, re-measured by this card at the trunk the section lands on** (`origin/main` `d614bafc`; the route and the spec answer one blob each at `fc8fab29` and at that trunk — `6a8e2cd8…` and `0a481d86…` — so every count below holds for the merged tree too). Each arm was mutated in this card's worktree, the focused cancel describe run, and the route restored byte-identically before the next arm (`sha256 b12b9be5…` again, `git status --porcelain` clean):

  | arm | mutation                                                                                                                  | measured                                                                                                                                                                             |
  | --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | A   | the guard removed and the old `const cancelAt = ctx.body.atPeriodEnd ? (current.currentPeriodEnd ?? now) : now;` restored | `3 failed \| 3 passed \| 36 skipped (42)` — `K1`/`K2` `expected 200 to be 409`, `K4` `expected { code: 'mandate_not_chargeable', … } to match object { code: 'conflict', … }`        |
  | B   | the guard moved below the provider call (after the `try`/`catch`)                                                         | `3 failed \| 3 passed \| 36 skipped (42)` — `K1`/`K2` `expected [ { …(2) } ] to have a length of +0 but got 1` (the provider is called before the refusal), `K4` the precedence diff |
  | C   | the guard moved below `providerRefOf` (after the mandate check, above the call)                                           | `1 failed \| 5 passed \| 36 skipped (42)` — `K4` alone, the precedence case, exactly as [ADR-0987](ADR-0987-op101-cancel-no-period-end-pins.md) measured                             |

- **Correction C1 — §Consequences' "Numbering" sweep missed a live allocation.** The bullet says the `.worktrees/*/docs/adr` trees end at `0987` and that the open PR heads hold `0986` (#932) and `0973` (#896). That sweep is incomplete: `0989` was **already allocated in flight** when this record was cut — commit `4b0dbdbf` added `docs/adr/ADR-0989-op101-downgrade-refusal-precedence-pins.md` at `2026-11-25T02:17:04Z`, 76 s before #931 merged, on branch `OP-101-task-downgrade-refusal-precedence-pins`, whose tip `072d4e14` is open PR [#933](https://github.com/yahodu/openpic-webapp/pull/933). [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) item 7 makes a number taken once it is on `main` **or** allocated to an open branch, PR or live card of the lane, so the four pool-mirror cells were one behind. Card `t_511d9cc2` advances all four — `board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)` — from `0989` to **`0990`**, the highest number on any ref (`0989`, measured by `git rev-list --objects --all -- docs/adr`) plus one. No cell is lowered, no range is re-cut and no number is consumed by this append.
- **Correction C2 — the `0988` ledger row did not render as a ledger row (finding F1).** A blank line had been left between the `0987` row and this record's row, and GFM ends a table at a blank line: a render of the header plus rows `0986`–`0988` (`gh api -X POST markdown -f mode=gfm`) came back with **3** `<tr>` and the `0988` row as `<p>| … </p>` outside `</table>`, so [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) held only textually. The row's missing padding was the symptom, not a `prettier` choice: with the blank line deleted, `prettier --write` re-pads it to the neighbours' width (`4458` characters, the same as the `0986` row). The same render of the repaired bytes answers **4** `<tr>` with no `<p>|`, so the row is inside the table.
- **The `0988` ledger row repeats the `0989` claim, and it is not rewritten.** The row's own sentence — "the four pool-mirror cells read `0988` and advance to **`0989`**" — is a statement about this record's cut, and a frozen section's ledger row is not edited by a sign-off: C1 is carried here for both sites, exactly as [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) §Round-1 review sign-off C1 does for the sentence it shares with the `0985` row. The pool table the row mirrors reads `0990`.
- **This append's own delivery.** Two files: `docs/adr/README.md` (`+5/−6` — the blank line deleted, this record's row re-padded, and the four pool cells rewritten in place `0989` → `0990`) and this record (`+19/−0`, appended at the end, no edit above it). `prettier --check` is clean on both, and the `adr-*` guard family answers **10 passed (10)** files / **340 passed (340)** tests. `docs/adr/README.md` answers `blob 1a6b9857…` / `sha256 0dc25a4c…` at the cut base `d614bafc`, which holds **493** records with no duplicate number (`uniq -d` empty).
- **Nothing is retracted.** No sentence of §D1–§D5, §Consumers or §Verification is withdrawn: C1 corrects the sweep's completeness and C2 repairs the ledger row's rendering, while the decision, the guard's position, the refusal shape, the deleted `?? now` and the five pins stand as merged, and each routed finding's own card documents what followed it.
