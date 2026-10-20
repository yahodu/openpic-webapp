# ADR-0300 — ADR numbers are drawn from per-lane reserved ranges, never from the shared high-water mark

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (process) — allocate per-lane ADR-number ranges (`t_a83e7ff3`, orchestrator; raised by the review of `t_a3d52d6e`, PR [#213](https://github.com/yahodu/openpic-webapp/pull/213))
- **Relates to:** [ADR-0128](ADR-0128-op96-green-review-signoff.md) (the OP-96 integration renumber), [ADR-0133](ADR-0133-op96-f1-f4-round2-red.md) (an earlier cross-lane allocation settled by card `t_cf0b1f77`), [ADR-0138](ADR-0138-op96-f1-unrecorded-flush-bound-red.md) / [ADR-0141](ADR-0141-op96-f1c-r2-redelivered-digest-cap-green.md) / [ADR-0143](ADR-0143-op96-flush-overlap-single-send-green.md) / [ADR-0145](ADR-0145-op96-f1-unrecorded-flush-bound-green.md) (the number collisions this policy ends)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

Until now the allocation rule was _"take the lowest `ADR-0nnn` free against a
fresh `origin/main` **and** every open ref, immediately before committing"_. That
makes the number a function of global board state at one instant, and every other
lane that merges in between invalidates it. On 2026-10-20 alone:

- the OP-101 lane (`t_a3d52d6e`, PR #213) was renumbered **three** times
  (`0128 → 0129 → 0142`);
- the OP-96 lane was relocated **four** times in a day
  (`0100–0106 → 0110–0116 → 0111–0118 → 0120–0128`), and again per round-3 card;
- `0143` was simultaneously claimed by two OP-96 refs (PR #220 and PR #221), and
  `0144` by `main` (PR #224) and `OP-96-task-quiet-release-flake-red` (PR #225),
  so PRs #225 and #221 sat `mergeable: CONFLICTING`;
- `docs/adr/README.md` and the `ADR-01xx` numbering were flagged as a hotspot by
  at least three prior cards (`t_609968cf`, `t_a4cdff8f`, `t_a3d52d6e`) with no
  owner assigned.

Every lane appends a row and a note to the same two regions of `README.md`
(the table tail and the trailing lane notes), so the tail of that file is a
**serialization point** for the whole board. The conflict is structural — same
file region — not semantic: two lanes never disagree about an ADR, they merely
want the same integer. Two of the three OP-101 renumbers cost a full re-review
cycle (`kanban_request_changes` → rebase → re-run CI → re-request review).

## Decision

Adopt **per-lane reserved ranges** as the binding allocation policy for
`docs/adr/`:

1. The **orchestrator is the allocator**. It assigns each lane (`OP-<n>`) a
   disjoint range of numbers **up front**, before any of that lane's cards are
   dispatched, and writes the range into every card body of the lane. Ranges are
   recorded in `docs/adr/README.md` § "ADR number allocation".
2. A lane takes its next ADR number as the **next unused number inside its own
   range** (a lane-local counter). It **never** consults `origin/main`'s
   high-water mark, the tail of `README.md`, or another lane's refs. Because
   ranges are disjoint by construction and are never re-cut, two lanes cannot
   collide even though neither inspects the other's branches.
3. Gaps inside a range, and ranges that go unused, are **expected and cheap**: a
   number is consumed once and is never reissued to another lane. The allocator
   may size a lane's range above the 20-number default when the lane's observed
   ADR volume warrants it (OP-96 received 34).
4. Numbers allocated **before this policy** (`≤ 0145`) are **frozen history** and
   are never moved; a branch that already carries one keeps it and draws only its
   _new_ ADRs from its reserved range.
5. **Board-wide / process** decisions that belong to no single lane draw from the
   allocator-owned `board-wide` range (`0300`–`0319`); this record consumes its
   first slot (`0300`).
6. Reserved ranges in force at adoption:

   | Holder (lane)                       | Reserved range                  | Next free |
   | ----------------------------------- | ------------------------------- | --------- |
   | board-wide / process (orchestrator) | `0300`–`0319`                   | `0301`    |
   | OP-96 notifications follow-up       | `0146`–`0179`                   | `0146`    |
   | OP-97 in-app feed                   | `0180`–`0199`                   | `0180`    |
   | OP-94 fan-out                       | `0200`–`0219`                   | `0200`    |
   | OP-98 notification preferences      | `0220`–`0239`                   | `0220`    |
   | OP-99 one-click unsubscribe         | `0240`–`0259`                   | `0240`    |
   | OP-100 tenancy                      | `0260`–`0279`                   | `0260`    |
   | OP-101 CI lane-shape                | `0280`–`0299`                   | `0280`    |
   | unallocated (future lanes)          | `0320`+ (20 per lane, in order) | `0320`    |

## Consequences

- Two lanes can no longer collide: the integer a lane will use is knowable before
  its branch exists, so `README.md` stops being a merge serialization point.
- Renumber cycles, rebases and re-review loops caused purely by number races end.
- The README grows a small, stable ledger (ranges + frozen pre-policy numbers)
  that the allocator maintains; lanes append only their own row, as before.
- Numbers are no longer dense: the table will show gaps (e.g. `0145 → 0300`) and
  a lane may skip numbers it never uses. This is deliberate and cheap.
- The allocator now owns a step it did not have before: assigning a range when a
  lane is created. If skipped, the lane must not invent a number — it should ask
  the allocator (the rule is "next free _in my range_", and an unallocated lane
  has none).
- A purely mechanical duplicate-prefix check (two files in `docs/adr/` sharing an
  `ADR-NNNN`) remains worthwhile as a backstop and is tracked separately; this
  record is the policy, not the guard.

## Alternatives

- **(b) Merger-owned finalisation** — the _merger_ assigns the number when the
  branch lands, the ADR file carrying a placeholder (`ADR-NNNN-…`) until then.
  Rejected: it serializes renames at merge time instead of removing them (every
  merge rewrites a filename and every cross-reference), and it moves authorship
  of a decision artifact into the merge action, which the board runs as a
  mechanical `--squash --admin` step.
- **(c) Append-only file, number derived from position** — a single `docs/adr/`
  log where the number is the row index. Rejected: it renames history. ADRs are
  cited by number throughout code, tests, the `docs/` design docs and other
  ADRs; positional numbers would invalidate every existing citation on the next
  insert.
- **Keep "lowest free number at commit time"** — rejected: it is the status quo
  that produced four renumbers in a day and two `CONFLICTING` PRs; the check is
  unenforceable because it is stale the moment it is computed.
