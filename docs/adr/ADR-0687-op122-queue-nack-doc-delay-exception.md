# ADR-0687 — OP-122 `nack` doc: the position is guaranteed in every adapter, the delay is not

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 round-1 follow-up GREEN, comment-only (`t_a8787672`) · **Branch:** `OP-122-task-nack-doc-delay-exception` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0685](ADR-0685-op122-queue-retry-position-and-containment-green.md) (§3 wording refined here, §2 decision stands), [ADR-0684](ADR-0684-op122-queue-retry-position-and-containment.md) (§3 — F5 frozen), [ADR-0681](ADR-0681-op122-queue-green.md) (the list adapter whose `nack` ignores the delay), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope) · **Schema:** §18.1 (broker = transport)

## Context

ADR-0685 §3 rewrote the `nack` doc in `apps/web/src/server/queue/work-queue.ts` to:

```
* Guaranteed: FIFO over *enqueued* messages, and a nacked one becomes
* claimable no sooner than the delay and behind everything already enqueued
* on its key (ADR-0685 §2) — the same rule in every adapter.
```

The round-1 review of that GREEN (finding **F3**, Low) showed the sentence over-claims twice:

1. **The delay is not honoured by the Upstash list.** `createUpstashQueue.nack` takes
   `_delaySeconds` and re-`LPUSH`es the payload at once, so the message is claimable immediately at
   any delay. The adapter's own docblock says so (`shortcut: a Redis list has no delay …`), and
   P5 in `queue-followup-pins.test.ts` freezes it at 0 s / 600 s / 3 600 s (ADR-0684 §3).
2. **The trailer's scope.** "the same rule in every adapter" trailed the whole sentence, so the
   _delay_ read as universal too. Only the **position** rule is universal: `memoryWorkQueue.nack`
   splices to the back, and the Upstash list re-pushes to the head while `RPOP` drains the tail —
   both put a retry behind everything already enqueued.

The port doc is the contract a worker author reads, so an over-claim there is worse than the
explicit "adapter-defined" wording it replaced in ADR-0683 §4.

## Decisions

### 1. The position rule stays a guarantee

One sentence, unchanged in substance: a nacked message becomes claimable **behind everything
already enqueued on its key** (ADR-0685 §2). ADR-0685 §2's decision — and ADR-0684 §2's before it
— stands untouched; this record refines the _wording_ of §3 only.

### 2. The delay rule is stated honestly, with the exception named

The doc now says the delay is honoured by `memory`, and that the Upstash list re-pushes at once and
serves the payload immediately at any delay **until the delayed sorted set lands** — the upgrade
ADR-0684 §3 already named (`ZADD key <now + delay>` + `ZRANGEBYSCORE key -inf now`). Both ADRs are
cited inline, so the reader of the port can find the freeze and the fix.

### 3. F5 stays frozen; no behaviour, wire or test changes

The Upstash `nack` keeps ignoring `delaySeconds` and P5 keeps freezing that — honouring it is a new
wire contract (a sorted set) and a new card. This change is **comment-only**: compiled output,
the wire, `claimed` ledger, memory adapter and every spec are unchanged.

## Alternatives considered

- **Drop the delay from the port contract entirely.** Rejected: `memory` honours it and a worker
  author must be able to rely on the port's delay bound where it is real; dropping it would
  under-claim the adapter that ships it.
- **Say "position _and_ delay are adapter-defined".** Rejected: it retracts the F4 decision of
  ADR-0684 §2, which the round-1 review upheld, to fix a documentation over-claim.
- **Implement the sorted set now.** Out of scope by the card and blocked by F5's pins, which this
  card may not edit.

## Consequences

- A worker author reading `nack` now sees which half of the contract is universal and which half
  one adapter still owes, with the ADR trail for both.
- ADR-0685 §3's sentence is **refined in place** (a docblock edit, not retraction of a decision);
  §2 stands. F5 remains frozen and F7 (OP-136 I1, `t_b25b384f`) remains the durability net.
- No test is added, changed or weakened: the behaviour is already pinned by P5 and by the memory
  delay case, so this card owes no new pin.

## Evidence

Commands run in `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9` on branch
`OP-122-task-nack-doc-delay-exception`, cut from `origin/main` `e774a73`.

| Check                                                                    | Result                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `git diff --stat origin/main`                                            | on the code: `work-queue.ts` `+4/−2`, all four lines inside the `nack` docblock |
| `tsc -p apps/web/tsconfig.json --noEmit`                                 | exit 0                                                                          |
| `eslint` on the touched file                                             | 0 errors, 0 warnings                                                            |
| `prettier --check` on the touched file                                   | clean                                                                           |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts` | **29 passed (29)**                                                              |
| full `unit`                                                              | **147 files / 2375 passed \| 3 skipped** (unchanged)                            |
| full `integration`                                                       | **98 files / 908 passed** (unchanged — a comment cannot move a count)           |

## Number allocation

This record takes the OP-122 lane's `Next free` value read from `docs/adr/README.md` at cut time:
`0687` inside the reserved range `0680`–`0699` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§2 — a lane-local counter, never the high-water mark). Checked free against `origin/main` `e774a73`
and every `origin` ref immediately before committing (`ADR-0687*` in none of them). The ledger cell
advances to `0688` in the same commit, with the index row and the lane note. No number outside the
lane range is touched.
