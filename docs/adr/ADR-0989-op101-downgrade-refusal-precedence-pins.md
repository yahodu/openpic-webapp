# ADR-0989 — OP-101: the period-less downgrade refusal is decided before the acknowledgement prompt and the tier ladder

- **Status:** Accepted · **Date:** 2026-11-25
- **Card:** OP-101 TEST `t_6d7eb4f1` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-downgrade-refusal-precedence-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-no-period-end-pins`
- **Lane:** OP-101 follow-up (billing record) · **Consumes:** `0989` — a **pool draw** above the two in-flight reservations `0987` (`t_70826ed1`) and `0988` (`t_65945a20`), per [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18 rule (B); the four pool-mirror cells read `0987` at this cut, below `0989 + 1 = 0990`, so each advances to `0990`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade` — the `scheduledChange` write, the acknowledgement ladder and the `not_a_downgrade` refusal), [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D1–§D2 (the pinned `409`/`no_period_end` contract), [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the production guard's position at landing), [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2 (the `dedupeKey`)
- **Consumers:** `apps/web/src/test/integration/billing-plan-change.test.ts` (`F5c` — precedence over `422 acknowledgement_required`; `F5d` — precedence over `422 not_a_downgrade`)
- **Relates to:** [ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) (the refusal this record orders), [ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) (the guard whose position this record pins), [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D2 — untouched: a refused request emits nothing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) decided that a live row
with no `currentPeriodEnd` is refused as `409 conflict` with
`details.reason: "no_period_end"` instead of being scheduled at the clock, and
[ADR-0985](ADR-0985-op101-downgrade-no-period-end-green.md) landed that guard
immediately after `liveSubscriptionSchema.parse(stored)`, beside
`no_live_subscription` — **before** the plan load, **before** the tier check and
**before** the acknowledgement prompt.

The delivery was correct; the pin set was blind to its **position**. In a detached
worktree at the squash `468f1542` the round-1 reviewer moved the guard in two
independent arms and re-ran the focused spec:

- guard moved **after** the plan load and the tier check → `31 passed (31)`;
- guard moved **after** the acknowledgement prompt → `31 passed (31)`.

`F5` and `F5b` post an **acknowledged** request to a `free` target, so they never
reach the acknowledgement prompt and never reach the tier check with a bad
direction: a reordered guard still answers `409` for them. A later refactor could
therefore turn a period-less request into `422 acknowledgement_required`
(unacknowledged) or `422 not_a_downgrade` (higher-tier target) and every pin would
stay green.

## Decision

**D1 — the refusal ladder has a fixed order, and the row-integrity arm is decided
first.** After auth, scope and the live-row lookup the route decides, in this
order: period end (`409 no_period_end`), catalogue (`422 validation_failed`),
tier (`422 not_a_downgrade`), acknowledgement (`422 acknowledgement_required`),
then the write. Five reasons:

1. **The gap is the server's, not the caller's.** Schema §14.3 declares
   `currentPeriodEnd` a `date`; an absent one is a row-integrity gap repaired
   through the admin `PATCH /admin/subscriptions/{id}` (contract §A). A client
   fault code (`422`) would blame the caller for a state they cannot see or fix.
2. **An acknowledgement prompt it can never honour is a dead end.** The `422
acknowledgement_required` body exists to collect informed consent for a
   specific `scheduledChange`. A period-less row cannot store **any**
   `scheduledChange`, so a prompt asks for consent to a write that is impossible —
   the caller acknowledges, re-posts, and is refused again. The refusal the caller
   needs is the one that names the row state.
3. **`not_a_downgrade` mis-routes.** Its `details.upgradeUrl` points at
   `POST …/billing/upgrade`, a route that cannot schedule against the same row
   either. Naming the direction sends the caller down a road that also ends at the
   repair path.
4. **One row state, one reason.** `details.reason` stays the single discriminator
   for `409 conflict`, so the client's recovery switch keeps one case per state
   instead of a cross-product of "period-less × direction × acknowledgement".
5. **The pins must be discriminating by construction.** Only an acked-to-a-bad-
   direction case can distinguish a correct order from a reordered one, because
   every other request shape is answered identically by both orders.

**D2 — the pinned contract (`F5c`, `F5d`).**

- **`F5c`** — a live row on `starter` with `currentPeriodEnd` `$unset`, posted
  with `acknowledgeConsequences: false` to the `free` target (a real downgrade),
  answers `409` with `error.code === "conflict"` and
  `error.details.reason === "no_period_end"`, and the body carries **no**
  `consequences` array — the acknowledgement prompt never ran. Not
  `422 acknowledgement_required`.
- **`F5d`** — the same row, posted with `acknowledgeConsequences: true` to
  `professional` (rank 2 against `starter`'s rank 1, the pair `F2` refuses as
  `not_a_downgrade` on a healthy row), answers the **same** `409` and the same
  `reason`, and names **neither** `currentTierRank` nor `targetTierRank`. Not
  `422 not_a_downgrade`.
- Both keep the **no-write pair**: the live row's `scheduledChange` is still
  `null` and `domain_events` gains no `billing.plan.downgrade_scheduled` row
  ([ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2).
- **Controls, must stay green:** `F5`/`F5b` (the two shapes of the refusal),
  `I3` (a healthy row, unacknowledged, is `422 acknowledgement_required` — so the
  prompt still exists, it is only _ordered_), `F2` (a healthy row, higher tier, is
  `422 not_a_downgrade`) and `I4` (the accepted direction is `200`).
- These are **characterisation pins**: they describe behaviour the merged trunk
  already has, so they pass on the cut and no production file changes.

**D3 — the rejected alternative: assert the order in the source.** A spec could
read `route.ts` and assert the guard's line comes before the tier check, or spy on
call order through a seam. Rejected: both pin an implementation detail rather than
a behaviour, so a legitimate refactor that keeps the refusal order (extracting a
`resolveRefusal` helper, hoisting the parse, reordering imports) would red them
while a real regression — the response a client sees changing — could still slip
through a source-shape heuristic. The two arms measured below are the behaviour,
so they are what gets pinned.

## Evidence

**Counts, measured on this branch** — cut from `origin/main` `0bc3709e`, then merged
with the trunk's `169bff3d` (merge head `928caf36`); the pre-change figure was
measured before the merge and the post-change figures again at the merge head.

```text
focused  apps/web/src/test/integration/billing-plan-change.test.ts   ->  31 passed (31)   (pre-change file, stashed, at the cut)
focused  the same file with `F5c` + `F5d`                            ->  33 passed (33)   (at the merge head)
sibling  billing-downgrade-scheduled-event.test.ts                   ->  16 passed (16)   (at the merge head)
ten      adr-* guard specs                                           ->  10 files / 340 passed (340)
```

**The two arms are discriminating, measured one at a time.** Production route
`sha256 ba6f5945829bffe1a5177f3506099b201877c64d5e4c6fd6c4c9430691f16c31` before and
after each arm; the guard block was moved with no other edit.

- **Arm A — guard after the plan load and the tier check.** `F5c` **stays green**
  (its target is `free`, a genuine downgrade, so a period-less unacked request is
  still refused by the guard even at that position) and `F5d` **reds**:
  `AssertionError: expected 422 to be 409` — the `not_a_downgrade` refusal took
  the request. `Tests  1 failed | 1 passed | 31 skipped (33)`.
- **Arm B — guard after the acknowledgement prompt.** `F5c` **reds**:
  `AssertionError: expected 422 to be 409` (the prompt took the request), and
  `F5d` reds too, at the tier check for the same reason. `Tests  2 failed | 31
skipped (33)`.
- `F5`/`F5b` stay green in both arms, which is exactly the blindness the review
  measured and the reason `F5c`/`F5d` exist.

**No production change ships.** `git status --porcelain` names only the spec on
this branch, and the merge's file list is the spec plus this record and its ledger
row.

## Consequences

- The guard's position is now load-bearing: moving it below the tier check reds
  `F5d`, moving it below the acknowledgement prompt reds `F5c`. The reviewer's two
  measured `31 passed (31)` arms become `1 failed | 1 passed` and
  `2 failed`.
- The refusal ladder is a contract, not an accident — a future arm added between
  the period end and the tier check (rate limit, entitlement gate) must say where
  it sits relative to the row-integrity arm, and the cheapest way to say it is a
  case here.
- Reversal condition: a product decision that a period-less row should prompt for
  acknowledgement, or report the direction, before the row state needs its own
  contract §3.3 amendment and its own record — the `409 no_period_end` shape
  ([ADR-0984](ADR-0984-op101-downgrade-no-period-end-pins.md) §D2) would then be
  the third answer to one request rather than the first.
- `F5`, `F5b`, `F2`, `I3` and `I4` are byte-identical: this record adds cases, it
  does not rewrite the ladder they describe.

## Numbering

The four-surface sweep at this cut (`origin/main` `0bc3709e`) finds the trunk
ending at `ADR-0986`, and `0987`/`0988` spoken for by the two in-flight `cancel`
lane cards (`t_70826ed1` TEST, `t_65945a20` GREEN) — `0987` is also on that lane's
worktree tree and its open PR #931. No `0989` exists anywhere: not on the trunk,
not in `git rev-list --objects --all -- docs/adr`, not in any
`.worktrees/*/docs/adr` tree and not on an open PR head. `0989` is therefore drawn
above the highest in-flight reservation per [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§11 item 18 rule (B). The four pool-mirror cells (`board-wide / process`, `OP-129
attendee identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read
`0987`; the higher of `0987` and `0989 + 1` is `0990`, so **each advances to
`0990`** and none is lowered. Hotspot: `docs/adr/README.md` (this record's ledger
row) — merge as a union keeping the highest value in every cell.

The trunk then moved underneath this PR: the `cancel` lane's GREEN landed as
`fc8fab29` (records `0987` and `0988`, released as `1.90.0` at `169bff3d` while
this branch was open), so `origin/main` now ends at `0988` and its four
pool-mirror cells read `0989`. `0989` was still the next free number, so no
renumber is needed — the merge head `928caf36` resolves the ledger as a union (all
three rows kept, ascending) and the cells to the higher of `0989` and `0990`,
which is **`0990`**. No cell is lowered and no range is re-cut.
