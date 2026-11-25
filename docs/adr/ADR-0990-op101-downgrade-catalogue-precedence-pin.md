# ADR-0990 — OP-101: the period-less downgrade refusal is decided before the catalogue's `422 validation_failed`

- **Status:** Accepted · **Date:** 2026-11-25
- **Card:** OP-101 TEST `t_662cbd6d` (openpic-webapp-testcase-writer), raised by finding **F1** of the round-1 review card `t_6d7eb4f1` of PR [#933](https://github.com/yahodu/openpic-webapp/pull/933) (squash `0058bb13`) · **Branch:** `OP-101-task-downgrade-catalogue-precedence-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-no-period-end-pins`
- **Lane:** OP-101 follow-up (billing record) · **Consumes:** `0990` — a **pool draw** above the highest number reserved at this cut (`0989`, this lane's own [ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md), already merged on the trunk), per [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 rule (B); the four pool-mirror cells read `0990` at this cut, below `0990 + 1 = 0991`, so each advances to `0991`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade` — the target-plan lookup, the `scheduledChange` write and its refusals), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1–§D2 (the pinned `409`/`no_period_end` contract), [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the production guard's position at landing), [ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) §D1 (the refusal ladder `period end → catalogue → tier → acknowledgement`)
- **Consumers:** `apps/web/src/test/integration/billing-plan-change.test.ts` (`F5e` — precedence over the catalogue's `422 validation_failed`)
- **Relates to:** [ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) (the ladder this record completes a rung of), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) (the refusal this record orders), [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D2 — untouched: a refused request emits nothing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) §D1 fixed the
refusal ladder of `POST /api/v1/tenants/{tenantId}/billing/downgrade` as
`period end → catalogue → tier → acknowledgement` and pinned two of its three
relations with `F5c` (before the acknowledgement prompt) and `F5d` (before the
tier check). The **catalogue rung stayed unpinned**. The round-1 review of
PR [#933](https://github.com/yahodu/openpic-webapp/pull/933) measured it on the
merged trunk `e7e92304` in a throwaway probe worktree: with the `no_period_end`
guard moved **below** `loadPlan(db, targetPlanKey)` — that is, below the
`422 validation_failed` unsold-plan refusal — the focused spec still read
`33 passed (33)`.

The gap is client-visible. A live row with no `currentPeriodEnd`, posted with a
`targetPlanKey` the catalogue does not sell, would answer `422
validation_failed` carrying `details.fields: [{ path:
"targetPlanKey", … }]`. That is a caller-fault envelope for a **server row
state** — the exact shape §D1 reason 1 of
[ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) argues
against, and it blames the caller in a field the caller cannot repair (the row
is repaired through the admin subscription `PATCH`).

## Decision

**D1 — the row-integrity arm is decided before the catalogue lookup.** After
auth, scope and the live-row lookup, the `no_period_end` refusal is answered
before `loadPlan(db, targetPlanKey)` and its unsold-plan refusal. Two reasons,
both continuations of
[ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) §D1:

1. **One row state, one envelope.** The catalogue's `422 validation_failed`
   names a **field**; a period-less row names a **row**. When both hold, only
   the row envelope is actionable: fixing `targetPlanKey` leaves the request
   just as unstorable, so a `422` that sends the caller to the catalogue sends
   them in a circle.
2. **The ladder is only a contract if every rung is load-bearing.** `F5c` and
   `F5d` made the tier and acknowledgement rungs discriminating; the catalogue
   rung was the one position a refactor could still move with no case reddening.
   A behaviour that no case distinguishes is not a decision, it is a comment.

**D2 — the pinned contract (`F5e`).** A live row on `starter`
(`priceKey: "starter-monthly-inr"`, `status: "active"`) whose `currentPeriodEnd`
is `$unset`, posted with `acknowledgeConsequences: true` and the unsold
`targetPlanKey: "not-a-sold-plan"`, answers `409` with `error.code ===
"conflict"` and `error.details.reason === "no_period_end"`; the body carries
**no** `details.fields` (so the catalogue's `422` payload cannot masquerade as
the row's), and the no-write pair holds — the live row's `scheduledChange` is
still `null`, `status` is still `active` on `activePlanKey: "starter"`, and
`domain_events` gains no `billing.plan.downgrade_scheduled` row
([ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2).

`acknowledgeConsequences: true` is deliberate: an unacknowledged request would
also be refused by the acknowledgement rung
([ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) `F5c`), so it
could not isolate the catalogue relation. An acknowledged request can only be
stopped, before the write, by the period-end guard or the catalogue refusal —
which is exactly the pair this case discriminates.

**D3 — the rejected alternative: assert the guard's position in the source.**
Reading `route.ts` and comparing line numbers, or spying on the order of
`loadPlan` calls, would pin an implementation detail: a refactor that extracts
the refusal ladder into a helper keeps the behaviour and reds the assertion,
while a reordering that keeps the source shape could still change the response.
The response a client receives is the contract, so the pin is a request.

**D4 — characterization, not RED.** The merged trunk already decides the
refusal first, so `F5e` is **green on arrival**; it changes no production file.
Its value is negative: it reds the moment the guard drops below the catalogue
lookup. This is declared here and in the spec's comment, so a reviewer does not
read a passing new case as a pin that does not pin.

## Evidence

**Counts, measured on this branch** — cut at `origin/main` `2ce1698a` and
rebased onto `00f0d022` (the trunk's #941/#942) before landing; no production
file touched.

```text
focused  apps/web/src/test/integration/billing-plan-change.test.ts   ->  33 passed (33)   (pre-change file, at the cut)
focused  the same file with `F5e`                                    ->  34 passed (34)   (at this head)
sibling  billing-downgrade-scheduled-event.test.ts                    ->  16 passed (16)   (at this head; 50 passed (50) with the focused file)
ten      adr-* guard specs                                            ->  10 files / 347 passed (347)
typecheck / lint / prettier                                           ->  exit 0 / exit 0 / clean
```

**The arm is discriminating, measured once.** Production route
`apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts`
`sha256 ba6f5945829bffe1a5177f3506099b201877c64d5e4c6fd6c4c9430691f16c31`
before and after; the guard block was moved below the unsold-plan refusal and
above the tier check, with no other edit.

- **Guard after `loadPlan(db, targetPlanKey)` and before the tier check.**
  `F5e` reds alone: `AssertionError: expected 422 to be 409 // Object.is
equality`. `Tests  1 failed | 33 passed (34)`. Every other case in the file,
  `F5c` and `F5d` included, stays green — the catalogue rung is the only one a
  reorder there can move.
- Restored with `git checkout -- …route.ts`; the hash above matches, and
  `git status --porcelain` names the spec only.

**No production change ships.** The change set is the spec, this record and the
ledger row.

## Consequences

- The catalogue rung is now load-bearing: moving the guard below
  `loadPlan(db, targetPlanKey)` reds `F5e`, and this is the third of
  [ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) §D1's three
  relations to be pinned by behaviour.
- The full ladder has a case per rung boundary: `F5c` (acknowledgement), `F5d`
  (tier), `F5e` (catalogue). A future arm inserted between the live-row lookup
  and the write — a rate limit, an entitlement gate, a mandate check — must say
  where it sits relative to the row-integrity refusal, and the cheapest way to
  say it is a case in this block.
- Reversal condition: a product decision that an unsold `targetPlanKey` should
  be reported before the row state needs its own contract §3.3 amendment and its
  own record; the client's recovery switch would then have to key a `422` on a
  row the caller cannot repair.
- `F5`, `F5b`, `F5c`, `F5d`, `I3`, `F2` and `I4` are byte-identical: this record
  adds a case, it does not rewrite the ladder they describe.

## Numbering

The four-surface sweep at this cut (`origin/main` `00f0d022`) finds the trunk
ending at `ADR-0989`; no `docs/adr` tree above `0989` exists on any other ref
or in any other `.worktrees/*/docs/adr` tree, and the one open PR head (#896)
adds no `docs/adr/ADR-*` file. No non-`done` card holds
`0990` but this one and its gated sign-off card `t_de4d03a6` (which draws no
number). `0990` is therefore drawn above the highest in-flight reservation per
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 rule (B).
The four pool-mirror cells (`board-wide / process`, `OP-129 attendee identity
lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read `0990`; the higher
of `0990` and `0990 + 1` is `0991`, so **each advances to `0991`** and none is
lowered. Hotspot: `docs/adr/README.md` (this record's ledger row) — merge as a
union keeping the highest value in every cell.

## Provenance note

The `0989` ledger row attributes its pins to card `t_6d7eb4f1` and names PR
[#925](https://github.com/yahodu/openpic-webapp/pull/925) as the review it
followed. On the board, `t_6d7eb4f1` is the **round-1 review of PR
[#933](https://github.com/yahodu/openpic-webapp/pull/933)** — its handoff reads
`APPROVED WITH FINDINGS on merged squash 0058bb13 (PR #933, head 90c7d2ae)` and
routes finding **F1** to this card. This record states the provenance it can
measure from the board and the squash it names; it does not rewrite
[ADR-0989](ADR-0989-op101-downgrade-refusal-precedence-pins.md) or its row — the
reviewer-owned sign-off card `t_de4d03a6`, gated behind this one, owns that text.
