# ADR-0685 — OP-122 retry position and containment GREEN: the memory retry moves to the back, and a poison payload is rescued around

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 round-1 sign-off residue GREEN (`t_1d32d0a2`) · **Branch:** `OP-122-task-retry-position-containment-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0684](ADR-0684-op122-queue-retry-position-and-containment.md) (the contract this record implements), [ADR-0683](ADR-0683-op122-queue-followup-green.md) §4 (whose "adapter-defined" sentence is superseded here, the record itself left untouched), [ADR-0682](ADR-0682-op122-queue-followup-pins.md) §4 (which authorised the P4 retarget), [ADR-0681](ADR-0681-op122-queue-green.md) (the adapter implementations), [ADR-0680](ADR-0680-op122-queue-port-red.md) (the executable contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope and the queue-swap surface) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (`processing.queueRef`)

## Context

ADR-0684 landed the pins and the decisions but no production code: `main` (`3f39718`) is red on
exactly four cases of `apps/web/src/test/integration/queue-followup-pins.test.ts`, and this card
is the GREEN. The pins are the specification; no test, fixture or mock changed here.

At `3f39718` the focused spec reads **4 failed | 14 passed (18)**, assertion-level:

- `memory redelivers a nacked message after the message enqueued behind it` —
  `expected [ …beef2, …51f1e ] to deeply equal [ …51f1e, …beef2 ]` (in place, not the back);
- `re-queues the batch's valid payloads when a middle payload is not JSON` and
  `… is not a §10.4 envelope` — `expected [] to deeply equal [ Array(2) ]` (the batch was dropped);
- `re-queues the payloads that the one RPOP took after the poison` — the same empty claim.

## Decisions

### 1. F6 — `claim` parses the whole `RPOP` batch, rescues every valid payload in popped order, then raises once

`createUpstashQueue.claim` now has three phases instead of one loop that throws:

1. **Parse pass** — every payload the single `RPOP` returned is read and `queueEnvelopeSchema`-
   parsed. Each valid payload is kept with its own bytes; the **first** failure is remembered
   (message text and cause only) and the pass continues, so a payload behind the poison is not
   abandoned.
2. **Rescue** — if a failure was remembered, one sequential `LPUSH queueKey <payload>` per valid
   payload goes out **in the order `RPOP` returned them**, before the rejection surfaces. `LPUSH`
   prepends and `RPOP` drains the tail, so re-pushing in popped order restores the payloads'
   original FIFO position: the next `claim` serves them in their original relative order.
3. **Rejection** — one `contractViolation(...)` call, therefore exactly one `error`
   `queue.upstream_contract_violation` with `provider: "upstash"`, `operation: "claim"` and the
   `queueKey`; the message text is unchanged (`"A queued message was not JSON."` /
   `"A queued message did not match the §10.4 envelope."`). The `UpstreamContractError` remains
   non-retryable.

The **invalid payload is dropped**, never re-pushed: re-pushing it would reproduce the same drift
on every later `claim` and the key would never drain (ADR-0684 §1 decision 3, rejected alternative
A-as-written).

The clean path is untouched observably — no rescue command, no drift record — and gains the exact
ledger: the returned `messages` are the parsed payloads in popped order, each `messageId` mapped to
**its own** payload, so `nack` re-pushes the right one.

A batch with nothing salvageable still raises and re-pushes nothing (rescue loop over an empty
list), which is the characterization case the pins already had.

### 2. F4 — `memoryWorkQueue.nack` moves the entry to the back of its table

`nack` splices the entry out of `entries` and pushes it to the end, keeping the rest of the
semantics identical: `inFlight = false`, `visibleAtMs = clock.now().getTime() + delaySeconds * 1000`,
an unknown id a silent no-op. `claim` drains the table in order, so the position in the table _is_
the position in the key — behind everything already enqueued, and still gated by the delay. The
Upstash list already behaves this way (`LPUSH` head / `RPOP` tail), so the port rule and both
adapters now agree.

### 3. The two docs that named the divergence are corrected; ADR-0683 §4 is superseded, not edited

- `apps/web/src/server/queue/work-queue.ts` — the `nack` doc now promises "claimable no sooner
  than the delay **and behind everything already enqueued on its key**, the same rule in every
  adapter", replacing "position is adapter-defined — `memory` redelivers in place, the Upstash
  list re-pushes to the head and serves it last".
- `apps/web/src/server/adapters/memory-queue.ts` — the module header's retry-position exception
  ("except where a retry _lands_: this adapter redelivers in place …") is removed; the header now
  names the shared position.
- **ADR-0683 §4 is frozen**: its sentence calling the position "adapter-defined" is superseded by
  this record and by ADR-0684 §2. Editing a merged ADR is not allowed, so the supersession is
  recorded here and the README index row carries it.

No behaviour change beyond the two edits above: the §10.4 envelope, `queue.enqueue_failed`,
`processing.queueRef`, the Upstash `nack` shortcut (F5, frozen on purpose by ADR-0684 §3) and the
three other queue specs are untouched.

## Alternatives considered

- **Rescue by re-`LPUSH`ing the whole batch (poison included).** Rejected by ADR-0684 and re-proven
  here: the payload that no `claim` can parse comes back on every poll, so the key drifts forever
  and never drains. The pin "a third `claim` is `[]`" is exactly this guard.
- **Rescue in reverse order.** Rejected: it reads as "restore the list" but reverses FIFO —
  `[first, second]` is served as `[second, first]`, which the pins assert against.
- **One `contractViolation` per invalid payload (the obvious reading of the old loop).** Rejected:
  the pins require exactly one drift record per `claim`, so only the first failure is raised and
  the rest of the batch is judged by the same pass. The remaining invalid payloads are dropped
  without individual records; a per-payload record is part of the dead-letter work, not this card.
- **A sorted-set delay in `nack` while touching the adapter.** Out of contract (ADR-0684 §3, F5
  frozen) and it needs a new wire contract.
- **Keeping the memory entry in place and only pinning the divergence.** Rejected before this card
  (ADR-0683 §4, ADR-0684 §2): two adapters that disagree make every downstream worker spec
  adapter-specific.

## Consequences

- **A poison payload costs its own bytes and one drift record, nothing else.** The valid payloads
  are re-offered at-least-once; the poison is gone, its content unrecoverable from the record
  (dead-letter list is a future card; F7, OP-136 I1 `t_b25b384f`, remains the durability net for a
  crash or a broker failure mid-rescue).
- **The drift path costs up to one extra round trip per rescued payload** (the Upstash REST
  transport is one command per POST, as `enqueue`/`nack` already are). The clean path costs nothing
  new.
- **Rescue is best effort.** A broker failure mid-rescue rejects the `claim` with the transport
  error and the payloads not yet re-pushed are lost — the same gap F7 closes.
- **`memory` and Upstash now share the retry position**, so a worker spec written against `memory`
  proves the ordering of both adapters.
- **Coverage stays above the gate**: the new `claim` branches are exercised by the pins
  (middle poison × 2 classes, poison first, all-poison, clean), and `nack`'s move by P4 memory and
  the delay case.

## Evidence

Commands run in `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9` on branch
`OP-122-task-retry-position-containment-green` (cut from `origin/main` `3f39718`).

| Check                                                                    | Result                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| focused pins at the RED state (before any edit)                          | **4 failed \| 14 passed (18)** — the four cases named in §Context                                      |
| `queue-followup-pins.test.ts` + `queue-upstash.test.ts` after the edits  | **26 passed (26)**, 2 files                                                                            |
| `queue-memory-adapter.test.ts` + `queue-envelope.test.ts` (unit)         | **41 passed (41)**, 2 files                                                                            |
| `pnpm test:unit`                                                         | **147 files / 2375 passed \| 3 skipped**, exit 0                                                       |
| `pnpm test:int`                                                          | **98 files / 905 passed**, exit 0                                                                      |
| `pnpm test:coverage` (the CI gate: both projects)                        | statements **91.99%**, branches **80.47%**, functions **95.8%**, lines **92.27%** — no threshold error |
| `tsc -p apps/web/tsconfig.json --noEmit`                                 | exit 0                                                                                                 |
| `eslint` on the three touched files                                      | 0 errors, 0 warnings                                                                                   |
| `prettier --check` on the three touched files                            | clean                                                                                                  |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts` | **29 passed (29)**                                                                                     |

## Number allocation

This record takes the OP-122 lane's `Next free` value read from `docs/adr/README.md` at cut time:
`0685` inside the reserved range `0680`–`0699` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§2 — a lane-local counter, never the high-water mark). Checked free against `origin/main` and
every `origin` branch immediately before committing. The ledger cell advances to `0686` in the
same commit, and the index row and the lane note are appended with it. No number outside the lane
range is touched.
