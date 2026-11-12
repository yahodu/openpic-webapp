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

## Review sign-off — round 1 (card `t_1d32d0a2`, artifact lens)

**Verdict: APPROVED WITH FINDINGS.** The review read the branch head `a04ca8d` and the
delivery landed as the squash `11103b7`; the review record is the PR #427 verdict comment. No
inline comment was needed, because every finding is a coverage gap or a documentation
over-claim rather than a defect on a line. The lens was the **artifact**: the diff was read
cold before the handoff narrative, then the deliverable was run independently, so every count
below is the reviewer's own measurement at `a04ca8d` and not a transcription of the handoff.

**No section of this record is retracted** — §Context, §1, §2, §3, §Alternatives,
§Consequences, §Evidence and §Number allocation all stand as written. Two amendments are
recorded and neither retracts a decision: §3's quoted docblock wording was refined after this
review by the F3 follow-up ([ADR-0687](ADR-0687-op122-queue-nack-doc-delay-exception.md),
§2 stands), and §1's clean-path ledger sentence is correct by reading but was pinned only for
the first message of a batch — finding F1.

### The reviewed bytes are what shipped

`git diff --stat a04ca8d 11103b7` is **empty**, so every line cited here is a line on the
trunk. `11103b7` is an ancestor of `origin/main`, and `gh pr view 427 --json state` answers
`MERGED` (`mergedAt` 2026-11-11T22:57:20Z, `mergeCommit` `11103b7`).

### Acceptance criteria → evidence (measured at `a04ca8d`)

| Card criterion                                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F4** — `memoryWorkQueue.nack` moves the entry to the back; `inFlight`, `visibleAtMs` and the unknown-id no-op unchanged                                                             | `queue-followup-pins.test.ts` **18 passed (18)**, including the case "memory redelivers a nacked message after the message enqueued behind it", which asserts the served order `[second, first]`; the one-message delay case in `queue-memory-adapter.test.ts` stays green (`queue-memory-adapter` + `queue-envelope` + the ADR guard → **70 passed (70)**) |
| **F6** — one poison payload no longer costs the batch: whole-batch parse, rescue of every §10.4-valid payload in popped order **before** the raise, poison dropped, exactly one drift | the three F6 pins pass inside the same 18; they assert the wire (what the next `claim` serves), that a third `claim` is `[]`, and exactly one `error` `queue.upstream_contract_violation` with `provider: "upstash"`, `operation: "claim"` and `queueKey: "q:image"`                                                                                        |
| The two docs that named the divergence are corrected                                                                                                                                  | the `nack` doc in `work-queue.ts` and the `memory-queue.ts` header both read the shared position rule; ADR-0683 §4 is untouched (frozen — the supersession is recorded here instead of an edit)                                                                                                                                                             |
| Ledger exact on the clean path                                                                                                                                                        | the returned messages map each `messageId` to **its own** payload — correct by reading, but pinned only for the first message of a batch: finding F1                                                                                                                                                                                                        |
| ADR + ledger                                                                                                                                                                          | ADR-0685 present, lane cell `0685` → `0686`, index row and lane note in the same commit; the ADR-numbering guard **29 passed (29)**                                                                                                                                                                                                                         |
| Static gates                                                                                                                                                                          | `tsc -p apps/web/tsconfig.json --noEmit` exit **0**; ESLint **0 errors / 0 warnings** on the three touched source files; `prettier --check` clean on the five touched paths                                                                                                                                                                                 |
| Full suites                                                                                                                                                                           | `pnpm test:unit` → **147 files / 2375 passed \| 3 skipped**; `pnpm test:int` → **98 files / 905 passed**                                                                                                                                                                                                                                                    |
| Trunk                                                                                                                                                                                 | PR Checks **15/15 pass**; the `main` CI run at `11103b7` (`43115994001`) is `success`                                                                                                                                                                                                                                                                       |
| No test, fixture or mock touched                                                                                                                                                      | the squash names exactly five paths: three production modules + ADR-0685 + `docs/adr/README.md`                                                                                                                                                                                                                                                             |
| Honesty audit                                                                                                                                                                         | no fixture-shaped hardcoding, no `APP_ENV` or test-environment conditional, no `@ts-ignore` or lint suppression, no debug logging in the diff                                                                                                                                                                                                               |

**Playwright / e2e was not run**, deliberately: no route, page or UI file is touched, the e2e
suite needs a full `next build` standalone plus two servers, and no PR CI job runs it. The
five-path diff reaches no client surface, so the browser suite could not observe anything this
delivery changes.

### Findings

Each finding was reproduced by a probe at the reviewed head rather than transcribed, and none
of them contradicts a pinned behaviour — which is why the delivery is approved. The probes:
F1, the ledger write replaced by `payload: valid[0].payload`, leaves the pins plus
`queue-upstash.test.ts` at **26 passed (26)**; F2, an `RPOP` returning a poison between two
valid payloads with the second rescue `LPUSH` answering `503`, yields a retryable
`TransportError` (code `http`, status `503`), **zero** drift records, and a next `claim` that
serves only the payload re-pushed first — the other valid payload is lost; F3 and F4 by
reading the `nack` doc against the adapter's ignored delay, and the rescue loop's unparsed
`command(...)` call.

| #      | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                              | Route                    |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| **F1** | Medium   | The `claimed` ledger's per-message exactness is unpinned for any message but the first of a multi-message batch. The probe leaves 26 of 26 queue cases green. That regression makes `nack(secondId)` re-push a duplicate of the first job while the second job's bytes were already removed by `RPOP` — a silent duplicate plus a silent loss.                                       | TEST `t_50ddcec8`        |
| **F2** | Medium   | A broker failure **mid-rescue** is unpinned. Durability is F7 (OP-136 I1 `t_b25b384f`); what had no pin is the classification — the rescue loop throws before the drift is raised, so a partial rescue is a retryable transport error with no drift record at all.                                                                                                                   | TEST `t_50ddcec8`        |
| **F3** | Low      | The `nack` doc now promises "claimable no sooner than the delay … the same rule in every adapter", while the Upstash adapter ignores `delaySeconds` (F5, frozen by ADR-0684 §3) and re-pushes at once. Only the position rule is universal, so the port contract a worker author reads over-claims. Comment-only correction; §3's wording is refined, §2's position decision stands. | GREEN `t_a8787672`       |
| **F4** | Info     | The rescue `LPUSH` goes through `command(...)` rather than `query(pushResultSchema, ...)`, so it bypasses the module's "every answer is Zod-parsed" invariant (`nack` already did, pre-existing). The answer is a list length with no consumer, so a pin would freeze behaviour with no value.                                                                                       | recorded here, no card   |
| —      | Info     | A batch holding two invalid payloads of different classes raises only the first class's message — by design (ADR-0685 §1 decision 3) and previously unpinned.                                                                                                                                                                                                                        | folded into `t_50ddcec8` |
| —      | Info     | The poison payload's bytes are unrecoverable from the drift record. Already recorded in ADR-0684 and ADR-0685 as the future dead-letter card, so nothing is added here.                                                                                                                                                                                                              | recorded here, no card   |

No Critical or High finding. The delivery adds no route, no authorization surface and no user
input; the bearer token reaches no log field or error body, and the drift record carries the
provider, the operation and the queue key only.

### Post-review status

The review is complete and the GREEN is merged (`11103b7`). Every finding was routed before
this sign-off was written: **F1 and F2** to the TEST card `t_50ddcec8`, **F3** to the GREEN
card `t_a8787672` (gated on the TEST card), while **F4** and the two Info items are recorded
here only — no card, because a pin for either would freeze behaviour with no consumer.

Both follow-ups have since landed on the trunk, and their own records are the authority for
what they did: `t_50ddcec8` shipped [ADR-0686](ADR-0686-op122-queue-claimed-ledger-and-mid-rescue-pins.md)
as `e774a73`, taking `queue-followup-pins.test.ts` from 18 to 21 cases (the per-message
ledger, the mid-rescue classification and the two-invalid-classes case), and `t_a8787672`
shipped [ADR-0687](ADR-0687-op122-queue-nack-doc-delay-exception.md) as `3173ee0`
(comment-only: the docblock now guarantees the position in every adapter and names the delay
exception honestly). Re-run on that settled trunk: **21 passed (21)** over the pins and
**98 files / 908 passed** over the full integration project. This sign-off consumes **no** ADR
number and leaves `docs/adr/README.md` byte-identical, so the lane's `Next free` cell stays
where the follow-ups left it.
