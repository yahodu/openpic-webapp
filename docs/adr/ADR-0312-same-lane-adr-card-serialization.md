# ADR-0312 — Same-lane ADR-minting cards are serialized by the task graph

- **Status:** Accepted · **Date:** 2026-11-03
- **Card:** OP-112 PROCESS/ADR — record the same-lane ADR-card serialization rule
  (`t_851ad543`, implementer; decided by the orchestrator card `t_78773f59`) ·
  **Branch:** `OP-112-task-same-lane-adr-serialization`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0312`
- **Collision this record closes:** two cards in the OP-112 media lane
  (`0580`–`0599`) both minted `ADR-0584` at the same Sunday trunk snapshot
  (`c055cac`): `t_48a8e8ce` (PR [#377](https://github.com/yahodu/openpic-webapp/pull/377),
  landed first) and `t_c469c799` (renumbered to `0585` by comment).
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (per-lane
  reserved ranges, the `Consumes` reservation of §8 rule A and the in-flight enumeration
  of §9 rule B), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the duplicate-prefix
  guard's deliberately narrow contract, which this record does **not** widen),
  [ADR-0308](ADR-0308-one-owner-per-branch-landing.md) (a parent edge is the board's only
  exclusion mechanism — the same mechanism this record reuses)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) made a lane's ADR number a
function of that lane's **own** reserved range instead of the board's shared high-water
mark, and thereby removed the cross-lane race it was written for. It did not remove the
**intra**-lane race. Two cards of the same lane that are dispatched at the same time both
read the same `Next free` cell — or the same in-flight enumeration — off the same trunk
snapshot, and both mint the same number. Rule B (§9) narrows the window by enumerating the
lane's live worktrees, non-`done` cards' `Consumes` values and open remote refs, but an
enumeration is still a **read of a snapshot**: two cards claimed in one dispatcher tick
enumerate before either has written anything, so both see the same "next free" number.

That is the `0584` collision. Two OP-112 media-lane cards, `t_48a8e8ce` and
`t_c469c799`, were cut from the same trunk snapshot `c055cac` and each wrote
`ADR-0584-…`. PR #377 (`t_48a8e8ce`) landed first; the sibling was renumbered to `0585`
by comment, after which its own review had to be re-run against the new head.

The same class has now recurred four times on this board:

- `0147` — PR #235 wrote its own in-flight number as the ledger cell while the sibling
  fixture-clock card counted `0147` as taken (recorded in ADR-0300 §7);
- `0382`/`0383`+`0384` — the OP-105 live-sandbox lane and the memory-provider lane read
  the same cell off `2baaf14` (two ledger notes in `docs/adr/README.md` record it);
- `0482` — the OP-112-class repeat on the OP-105/OP-110 lanes' shared cut: the
  OP-110 invoice-number-decode pins and the reactivation-boundary pair minted the
  same number off one trunk read; the pair moved up to `0483`/`0484` after the
  pins squash-merged as `c2ebc589`;
- `0584` — the collision above.

Why §7 (the reservation counter), §8 (reserve at card creation) and §9 (rule B's
in-flight enumeration) did not close it: all three are **read-side** rules. They tell a
card how to _compute_ a free number from observable state, and every such computation is
taken over a snapshot that a sibling claimed in the same tick can falsify. The ledger
cannot be made atomic from the read side, and the board's task graph already carries the
one mechanism that is: a parent edge, under which two cards are never `ready` at once
(ADR-0308).

## Decision

**Same-lane ADR-minting cards are serialized by the task graph.** When two or more cards
of one lane's reserved range can each mint an `ADR-NNNN` row, the allocator creates them
as a **chain** — the second card gets `parents=[<first card id>]` — and they are never
`ready` at the same time. Both cards additionally carry the `Consumes: NNNN` reservation
ADR-0300 §8 rule A already requires, but for a chained card the number is no longer a
function of any shared snapshot: the successor starts only after the predecessor's ledger
row has landed on `main`, so its number is read off the merged trunk. Chained cards do not
need rule B's in-flight enumeration, because there is no concurrent sibling to enumerate.

Three contracts make the rule actionable (rule C):

1. **Allocator (orchestrator, or whoever mints a card).** At creation, if the card can
   mint an ADR in a lane range that already has a non-`done` ADR-minting card, set
   `parents=[that card]`. Write `Consumes: NNNN` (or `Consumes: none`) and a
   `Same-lane ADR gate: serialized behind <card-id> | none` line into every card body.
   Two ADR-minting cards in one range must never be siblings.
2. **Worker (testcase-writer / backend-coder).** Use the `Consumes` value as given. If it
   is missing, or reads `TBD`, or a sibling card in the same range is already minting that
   number, do **not** invent or renumber — comment on the card and `kanban_block` it back
   to the allocator. Never derive a number from the ledger's `Next free` cell.
3. **Reviewer.** A card body without `Consumes:` is a decomposition defect — return it, do
   not work around it; the ADR file's number must equal the body's `Consumes` value; and
   the pre-merge duplicate check on the merged tree (ADR-0300 §9 item 12) is unchanged.

## Consequences

- **Lane wall-clock cost is accepted.** A chained card waits for its predecessor to land.
  The cost is small in practice: a lane's cards already run in sequence for RED → GREEN →
  review, and a lane's ADR rows are cheap, while a duplicate number costs a renumber plus
  a full re-review loop (four recurrences, above).
- **No new CI.** The rule is a card-graph obligation and review-time check; nothing in
  `.github/workflows/` changes, so no PR gains a new job or a new failure mode.
- **The guard's contract is unchanged.** `apps/web/src/test/unit/adr-numbering.test.ts`
  (ADR-0302) still checks exactly two things — no duplicate `ADR-NNNN` prefix and a
  well-formed file name — over one checkout. Serialization is not mechanised there.
- **For same-lane ADR minters the ledger stops being a cross-card serialization point.**
  A successor reads the number off the merged trunk, so the two cards never contend for
  the same cell or the same table row. The ledger tail remains a merge hotspot only for
  **concurrent lanes** and for index-only union resolution (CONVENTIONS §11).
- **A decomposition defect is now a returnable review finding**, not something the worker
  papers over by renumbering silently (ADR-0300 §8 item 9).

## Alternatives

- **(Rejected) Reserve-first protocol — land an append-only ledger edit reserving the
  number on the trunk, then re-read the cell.** It re-creates the shared-file
  serialization point that ADR-0300 removed: every parallel card must push a trunk commit
  to reserve, and two cards pushing a reservation on the same file region conflict exactly
  like the ADR rows they tried to avoid.
- **(Rejected) A mechanical `reserved:` list in `docs/adr/README.md` checked by the
  guard.** The guard (ADR-0302) reads one checkout. A reservation written on a branch is
  invisible to a sibling cut from the same trunk, so the marker is not atomic; adding it
  to the guard would only relabel the same race and would widen the guard's deliberately
  narrow contract.
- **(Rejected) Rule B alone — the status quo.** The in-flight enumeration narrows the
  window but is still a snapshot read: two cards claimed in one dispatcher tick enumerate
  before either writes, which is exactly how `0584` happened. It stays in force for
  **cross-lane** and same-tick cases; rule C is what makes the same-lane case impossible
  rather than unlikely.
