# ADR-0686 — OP-122 claimed-ledger exactness, the mid-rescue transport failure, and the two-class drift

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 round-1 follow-up TEST (`t_50ddcec8`) · **Branch:** `OP-122-task-claimed-ledger-and-mid-rescue-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0685](ADR-0685-op122-queue-retry-position-and-containment-green.md) (the GREEN whose §1 is pinned here), [ADR-0684](ADR-0684-op122-queue-retry-position-and-containment.md) (the containment contract and its pins), [ADR-0681](ADR-0681-op122-queue-green.md) (the process-local claim ledger), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (`processing.queueRef`)

## Context

The OP-122 round-1 review of the containment GREEN (`t_1d32d0a2`, PR #427, squash `11103b7`,
ADR-0685) returned **APPROVED WITH FINDINGS** and routed two Medium coverage gaps and one
untested by-design rule to this card. Three behaviours are real and shipped, and no spec
observed them; the reviewer proved two of them by mutation at `11103b7`:

- **P7 gap** — the `claimed` ledger's exactness was pinned only for the **first** message of a
  multi-message claim. Reviewer probe: replacing
  `claimed.set(messageId, { queueKey, payload })` with
  `claimed.set(messageId, { queueKey, payload: valid[0].payload })` left **26 passed (26)**
  over `queue-followup-pins.test.ts` + `queue-upstash.test.ts`. That regression makes
  `nack(secondId)` re-push a **duplicate of the first** payload while the second job's bytes,
  already removed by the `RPOP`, are gone — a silent duplicate plus a silent loss.
- **P8 gap** — the broker failure that can interrupt the rescue loop was unpinned. Reviewer
  probe at `11103b7`: handler answering `RPOP → [first, "{not-json", second]`, then
  `LPUSH#1 → {result: 1}`, then `LPUSH#2 → 503`; `claim` rejects with `TransportError`, **zero**
  `queue.upstream_contract_violation` records (the loop throws before `contractViolation(...)`
  is reached), and only the already-re-pushed payload is back on the list.
- **P9 gap** — ADR-0685 §1 decision 3 and its Alternatives fix "only the first failure is
  raised", but every shipped case puts **one** poison class in the batch, so nothing observed
  that a batch with two classes still raises exactly one drift, with the first class's message.

This card is **test-only**: it extends `apps/web/src/test/integration/queue-followup-pins.test.ts`
(18 cases → 21) and touches no production file, fixture, factory, ADR-0680 … ADR-0685 or the
three other shipped queue specs. The three new cases are **characterization pins** — they
describe what `5bc620d` does today, are green on arrival, and need no GREEN child.

## Decisions

### 1. The three pins, and the one sentence each one locks

1. **P7 — the ledger maps every id to its own payload.** Two envelopes are seeded on a real
   list emulation, `claim("q:image", 2)` returns both, the two `messageId`s are asserted
   **distinct**, and `nack(second.messageId, 0)` is followed by an assertion on the **last**
   `LPUSH` command of the wire: `["LPUSH", "q:image", JSON.stringify(second)]`, with an
   explicit `not.toBe(JSON.stringify(first))` so a duplicate of the first payload fails with a
   message that names the defect rather than a bare deep-equality mismatch. A final
   `claim("q:image", 2)` must serve `[second]`, so the pin also holds at the level a worker
   observes, not only at the command level.
2. **P8 — a mid-rescue broker failure is a retryable transport error, and the claim reports no
   success.** The spec adds a second broker helper,
   `installBrokerFailingPushes(failPushFrom)`: a real head/tail list whose `LPUSH`es answer
   `503` from the given attempt on (`RPOP` keeps draining). With the poison in the middle and
   the second rescue push failing, the case asserts
   `toBeInstanceOf(TransportError)`, **`not.toBeInstanceOf(UpstreamContractError)`**,
   `toMatchObject({ code: "http", retryable: true, status: 503 })`, **zero** drift records,
   and that the payload re-pushed before the failure is claimable again.
3. **P9 — two poison classes in one batch raise exactly one drift, with the first class's
   message.** The list is seeded `[first, "{not-json", {v: 1}, second]`; the case asserts one
   `error` record with `provider: "upstash"`, `operation: "claim"`, `queueKey: "q:image"` and
   `msg === "A queued message was not JSON."` (plus a negative assertion against the second
   class's text, so a "last class wins" regression cannot pass), then that the next `claim`
   serves `[first, second]` in FIFO order and a third `claim` is `[]`.

### 2. P8 pins the classification and the no-partial-success half only — not the loss

ADR-0685 §1 already records that the rescue is best effort and a crash or a broker failure
mid-rescue loses the payloads not yet re-pushed, and that F7 (OP-136 I1, `t_b25b384f`) is the
durability net. So this record deliberately does **not** freeze "the payload is lost":

- the surviving payload is asserted with `toContainEqual(first)`, **not** `toEqual([first])`,
  so a future at-least-once fix that also recovers the dropped payload does not redden the
  pin;
- no case asserts that the dropped payload is absent from the list or from the drift record.

What the pin does freeze is the part a retry policy depends on: the failure is a **retryable
`TransportError`** (`code: "http"`, `status: 503`) and **not** the non-retryable
`UpstreamContractError`, and no `queue.upstream_contract_violation` is recorded — a transport
blip must never be reported to an operator as a wire-contract drift.

### 3. P9 pins "first class wins" as the shipped rule, because the alternative was considered

ADR-0685 §1 decision 3 chose one record per `claim`; its Alternatives reject "re-push the whole
batch" and "silently report the valid ones". Both classes in one batch is the only shape where
"one record" and "which class" can differ, so the pin asserts the message text, not only the
count. A future change to "log one drift per payload class" is a contract change and owes its
own ADR; this pin makes that change impossible to make silently.

## Alternatives considered

- **Pin P7 only at the command level (the last `LPUSH`'s payload).** Rejected as the sole
  assertion: a ledger keyed correctly but a `nack` that reads the wrong field would still pass.
  The follow-up `claim` catches that.
- **Pin P8 as `toEqual([first])` / assert the second payload is gone.** Rejected: it would
  freeze the loss as desired behaviour, which the card forbids and F7 will improve.
- **Pin P8's command shape (`[RPOP, LPUSH, LPUSH]`).** Rejected for the same reason: a fix that
  retries the failed rescue push would change the command count without changing the contract.
- **Pin P9 with two not-JSON payloads (same class).** Rejected: it cannot distinguish "one
  record" from "one record per class" unless the classes differ.

## Consequences

- **No production file changes.** The mutation probes in §Evidence are throwaway and the
  adapter is restored byte-identically (`sha256` equal, `git status --short` shows the spec
  file only).
- **`queue-followup-pins.test.ts` grows two helpers' worth of surface**: the existing
  `installBroker()` is untouched, and `installBrokerFailingPushes()` is a second, independent
  mock so no shipped case changes behaviour.
- **The spec's docblock now states the three post-GREEN pins**, so a reader of a green run does
  not mistake P7–P9 for RED pins that failed to bite; §Evidence records the mutation that
  proves each one load-bearing.
- **F5 stays frozen** (ADR-0684 §3) and **F7 stays the durability net** (OP-136 I1). Nothing
  here narrows or widens either.

## Evidence

Commands run in `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9` on branch
`OP-122-task-claimed-ledger-and-mid-rescue-pins` (cut from `origin/main` `5bc620d`).

| Check                                                                                                          | Result                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run --project integration …/queue-followup-pins.test.ts` at this head                                  | **21 passed (21)** — the 18 shipped cases unchanged plus the three characterization pins                                                                                                              |
| mutation A: `claimed.set(messageId, {queueKey, payload: valid[0]?.payload ?? payload})` (the reviewer's probe) | **1 failed \| 20 passed** — `× re-pushes the nacked message's own payload …`, `AssertionError: expected [ 'LPUSH', 'q:image', …(1) ] to deeply equal [ 'LPUSH', 'q:image', …(1) ]`                    |
| mutation B: the rescue loop swallows a transport failure and the drift is raised                               | **1 failed \| 20 passed** — `× rejects a broker failure mid-rescue …`, `AssertionError: expected UpstreamContractError: A queued message w… { …(3) } to not be an instance of UpstreamContractError`  |
| mutation C: the not-envelope branch assigns `violation` instead of `??=` (last class wins)                     | **1 failed \| 20 passed** — `× raises exactly one drift naming the first invalid class …`, `AssertionError: expected 'A queued message did not match the §1…' to be 'A queued message was not JSON.'` |
| the adapter after each probe                                                                                   | restored byte-identically (`sha256` `0eb0d118…fc64` before and after)                                                                                                                                 |

Full suites on the same head: `unit` **147 files / 2375 passed | 3 skipped** (unchanged — the
`unit` project excludes `**/test/integration/**`, so an integration-only change cannot move
it) and `integration` **98 files / 908 passed**, the three new cases being this branch's only
addition to the suite (as measured, not copied from the parent card).

## Number allocation

This record takes the OP-122 lane's `Next free` value read from `docs/adr/README.md` at cut
time: `0686` inside the reserved range `0680`–`0699` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§2 — a lane-local counter, never the high-water mark). The ledger cell advances to `0687` in
the same commit, with the index row and the lane note. No number outside the lane range is
touched.
