# ADR-0684 — OP-122 retry position and poison containment: a nacked message goes to the back, and one poison payload no longer costs the claimed batch

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 round-1 sign-off residue TEST (`t_c3f5bf7e`) · **Branch:** `OP-122-task-queue-retry-position-and-containment` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0680](ADR-0680-op122-queue-port-red.md) (the executable contract), [ADR-0681](ADR-0681-op122-queue-green.md) (the GREEN whose findings these are, and the round-1 sign-off that routed them here), [ADR-0682](ADR-0682-op122-queue-followup-pins.md) §4 (which authorises exactly this pin retarget), [ADR-0683](ADR-0683-op122-queue-followup-green.md) §4 (which prefers the "back" rule and could not adopt it), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope and the queue-swap surface) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (`processing.queueRef`)

## Context

The OP-122 round-1 sign-off (appended to ADR-0681, PR #424) left **F5**, **F6** and the
F4 pin retarget open on purpose: the round-1 follow-up pins froze the current behaviour
and the GREEN card was not allowed to edit a pin. This card claims that residue and is
**test-only**: one spec file changed (`apps/web/src/test/integration/queue-followup-pins.test.ts`),
no production file, fixture, `ADR-0680`, `ADR-0681`, `ADR-0682`, `ADR-0683` or shipped
adapters spec touched.

The three findings, at `c9c259c`:

- **F4** — `memoryWorkQueue.nack` clears `inFlight` and sets `visibleAtMs`, so the entry
  stays where it is in the table and is redelivered **in place**; the Upstash list
  re-`LPUSH`es to the head while `RPOP` drains the tail, so it is served **last**.
  ADR-0682 §4 authorises retargeting the P4 memory pin to `[second, first]` and ADR-0683
  §4 names the exact fix ("a one-line edit in `memoryWorkQueue.nack` — move the entry to
  the back of the table").
- **F5** — the Upstash `nack` signature takes `_delaySeconds` and ignores it; the one
  shipped case fixed the delay at 600 s only, so nothing observed that the delay is
  irrelevant at every value.
- **F6** — `claim` throws on the first payload that is not JSON or not a §10.4 envelope,
  so every payload that the same `RPOP` already removed is lost: nothing re-`LPUSH`es it
  and the sweep that would repair it is F7 (OP-136 I1, not this card).

### Posture, so a green run is not misread

| Pin                                                    | Kind              | State at `c9c259c` |
| ------------------------------------------------------ | ----------------- | ------------------ |
| P4 memory — nack lands behind the queue (F4)           | **RED by design** | 1 case fails       |
| F6 — a poison payload is contained (2 poison variants) | **RED by design** | 2 cases fail       |
| F6 — the payloads behind the poison survive            | **RED by design** | 1 case fails       |
| F5 — the Upstash `nack` delay is ignored (3 delays)    | characterization  | 3 cases pass       |
| F6 — a clean batch claims normally                     | characterization  | 1 case passes      |
| F6 — an all-poison batch still raises                  | characterization  | 1 case passes      |

P1/P2 (green since PR #421) and P3, P4 upstash are carried unchanged. The
characterization half is proven load-bearing by the mutation probes in §Evidence, not by
staying green.

## Decisions

### 1. F6 — a poison payload is contained, and the containment is _at-least-once for the valid payloads, loud for the poison_

The card offers two contracts and forbids leaving the choice open. This record takes **both,
split by payload class**, because neither option alone survives the batch shape the card
itself describes (some valid payloads, one invalid):

1. **`claim` parses every payload of the popped batch before it acts on any of them.** A
   batch whose invalid payload sits in the middle therefore cannot lose the payload behind
   it — the loop no longer throws on the first bad payload and abandons the rest.
2. **Every §10.4-valid payload is re-`LPUSH`ed onto the same key, in the order `RPOP`
   returned them, before the drift error is raised.** Because `LPUSH` prepends and `RPOP`
   drains the tail, re-pushing in popped order restores FIFO: the next `claim` serves the
   rescued payloads in their original relative order. This is the card's **at-least-once**
   option, and it is the half §18.1 asks for — the broker is transport, MongoDB is the job
   state, so a payload may be delivered twice but must not evaporate because a sibling
   payload was corrupt.
3. **The invalid payload is _not_ re-pushed.** Re-pushing it would reproduce the same drift
   on every subsequent `claim` and the key would never drain again — the card's Option A,
   read literally ("the whole batch is re-`LPUSH`ed"), buys at-least-once for the good
   payloads by turning one poison payload into a permanent outage of its queue, and is
   therefore rejected. The poison is dropped, which is the card's Option B — but only for
   that payload, and never silently.
4. **The drift is raised once per `claim` call** (`UpstreamContractError`, non-retryable) and
   recorded once as `error` `queue.upstream_contract_violation` with `provider: "upstash"`,
   `operation: "claim"` and the `queueKey`. A batch with nothing salvageable still raises —
   containment must not become silence.

The invariant the GREEN must satisfy, in one sentence: **one `RPOP` batch loses at most the
payloads that fail the §10.4 parse, and every valid payload is back on the key before the
rejection surfaces.** How the adapter structures that (parse pass, partition, rescue loop) is
its choice; the pins assert only the observables: the next `claim`'s envelopes and their
order, an empty `claim` after them (the poison is not in the list), and one drift record.

Two consequences the GREEN inherits from this record, both visible in the pins:

- a rescue is one `LPUSH` per rescued payload (the Upstash REST transport is one command per
  POST, exactly as `enqueue` and `nack` already are), so a 10-message batch costs up to 10
  extra round trips **only on the drift path**;
- the rescue is best effort: if the broker fails mid-rescue, `claim` rejects with the
  transport error and the payloads not yet re-pushed are lost. That is the same gap F7
  closes for every other lost pointer, and it is why the sweep is not optional — see
  §Consequences.

### 2. F4 — the retry position is unified on the "back" rule

The port now promises, and both adapters now implement, **a nacked message becomes claimable
again behind everything already enqueued on its key** (still no sooner than its delay). The
memory adapter is retargeted to it: `nack` must move the entry to the back of its table
instead of leaving it in place. The Upstash list already satisfies it — `LPUSH` to the head
plus `RPOP` from the tail is precisely "serve it after everything else" — so that pin is
carried unchanged and only its section comment moved under the shared rule.

This is the one pin retarget ADR-0682 §4 authorised and ADR-0683 §4 preferred but could not
take. It **supersedes** the sentence in ADR-0683 §4 that calls the position "adapter-defined"
and the header of `memory-queue.ts` that names the divergence; the GREEN owes both doc
updates plus the port's `nack` doc in `work-queue.ts`, none of which a behavioural spec can
assert.

Why the stricter rule is the right one here: with "in place", a nacked message jumps the
queue and can starve the messages enqueued behind it, which is the opposite of what a retry
is for; with "back", a poison or a hot retry costs one turn instead of the head position.
The two adapters agreeing also restores the property the memory adapter exists for — a
worker spec written against `memory` proves the retry position of every adapter, so a later
lane no longer has to write its claim-order spec twice.

### 3. F5 — the ignored `delaySeconds` stays, pinned at three delays, with the upgrade named

The card asks for honesty, not a fix: `nack` re-`LPUSH`es immediately and the delay never
reaches the broker. That is now pinned at **0 s, 600 s and 3 600 s** — the last one far
beyond any test window — so a future implementation that starts honouring the delay (or
starts honouring it only above some threshold, or starts sending it as a command argument)
breaks a named case instead of changing the divergence silently. Each case asserts the whole
command shape (`[LPUSH, RPOP, LPUSH]`, the third one the payload's own bytes) and that the
payload is claimable again with no wait at all.

The path that would honour the delay is named in the spec's docblock and in P5's inline
comment: a **delayed sorted set** (`ZADD key <score = now + delay> payload`, promoted by
`ZRANGEBYSCORE key -inf now` + `ZREM` on claim), which is a new wire contract and therefore
a new ADR, not a refactor of this one.

## Alternatives considered

- **F6 Option A as written (re-push the whole batch).** Rejected: it re-queues the payload
  that no `claim` can ever parse, so the key drifts on every poll and never advances. Probe
  B in §Evidence is exactly this implementation and it reddens every containment case.
- **F6 Option B as written (return the valid payloads, log the drift, drop the rest).**
  Rejected as the _sole_ contract: `claim` would report success while a payload disappeared,
  so a worker (and the review) cannot tell a clean batch from a lossy one; the drift record
  is the only trace and the caller has no reason to look at it. Taking B for the poison
  only, and A for the valid payloads, keeps both properties.
- **F6: keep the poison in a dead-letter list.** The right long-term home, but it needs a new
  key name, a retention rule and a reader — a new contract, and the card forbids new fields.
  Recorded as an open item instead.
- **F5: honour the delay now.** Out of contract for this card (test-only) and it needs the
  sorted set above, in both adapters, to keep them equal. Pinned as-is instead.
- **F4: keep "adapter-defined" and pin the divergence.** ADR-0683 §4 already rejected it for
  a stronger reason than this card has: two adapters that disagree make every downstream
  worker spec adapter-specific.

## Consequences

- **The GREEN child owes four production edits**, all small: `memoryWorkQueue.nack` moves the
  entry to the back of its table; the `claim` parse/partition/rescue in `upstash-queue.ts`;
  the `nack` doc on `work-queue.ts` (position is now "the back", not adapter-defined); and
  the `memory-queue.ts` header sentence that names the divergence. Its own ADR records the
  implementation and quotes this one.
- **A poison payload's bytes are lost.** The drift record carries `provider`, `operation`
  and `queueKey` (never the payload — the token/payload hygiene rule of ADR-0681 holds), so
  an operator can see _that_ a payload was dropped and on which key, not _what_ it was.
  Operator forensics needs the dead-letter list; open item, not this lane.
- **F7 is still the durability net.** The rescue covers a poison payload inside a claimed
  batch; a crash between the rescue and the next `claim`, or a broker failure mid-rescue,
  is still only repaired by the sweep (OP-136 I1 `t_b25b384f`). This record does not claim
  otherwise.
- **At-least-once can duplicate a payload** that the rescue re-pushed while another process
  was already handed it by a racing `claim`. That is the accepted §18.1 trade; a worker's
  processing must be idempotent per `envelope.id`, which is why the envelope carries the
  pointer and not the work.
- **`queue-followup-pins.test.ts` changes shape**: its Upstash mock now emulates a real Redis
  list (head/tail) instead of returning an armed `RPOP` answer, so "served last", "re-queued"
  and "not re-queued" are observed as the payloads a worker would receive next. The 13
  shipped cases keep their intent: P1/P2/P3 and the Upstash P4 assertion are untouched apart
  from the P5 `it.each` widening and the P6 retarget.

## Evidence

Commands run in `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9` on branch
`OP-122-task-queue-retry-position-and-containment` (cut from `origin/main` `c9c259c`).

| Check                                                                                                                    | Result                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run --project integration …/queue-followup-pins.test.ts` at the RED state                                        | **4 failed \| 14 passed (18)** — P4 memory, the two middle-poison variants and the payload-behind-the-poison case                                                                              |
| the two RED failure lines                                                                                                | `expected [ …{id 000…beef2}, …{id 000…51f1e} ] to deeply equal [ …{id 000…51f1e}, …{id 000…beef2} ]` (in-place vs back) and `expected [] to deeply equal [ Array(2) ]` (the batch was dropped) |
| throwaway faithful implementation (`nack` moves the entry back; `claim` parses all, rescues the valid ones, then raises) | **26 passed (26)** across the pins file (18) and `queue-upstash.test.ts` (8)                                                                                                                   |
| `queue-memory-adapter` + `queue-envelope` (unit) with that implementation                                                | **41 passed (41)** — unchanged                                                                                                                                                                 |
| mutation A: `nack` emits `ZADD key <score> payload` (the sorted-set upgrade)                                             | **3 failed** — `expected [ 'LPUSH', 'RPOP', 'ZADD' ] to deeply equal [ 'LPUSH', 'RPOP', 'LPUSH' ]` (P5 bites)                                                                                  |
| mutation B: the rescue re-pushes the whole batch, poison included                                                        | **4 failed** — the second `claim` throws `UpstreamContractError: A queued message was not JSON.` (the poison-loop assertion bites)                                                             |
| both adapters after the probes                                                                                           | restored byte-identically (`sha256` equal before/after); `git status --short` shows the spec file only                                                                                         |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                                 | exit 0, `TypeScript: No errors found`                                                                                                                                                          |
| `eslint` on the touched spec                                                                                             | 0 errors, 0 warnings                                                                                                                                                                           |
| `prettier --check` on the touched spec                                                                                   | clean                                                                                                                                                                                          |
| `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts`                                                 | **29 passed (29)**                                                                                                                                                                             |

Full-suite runs at this head: `unit` **147 files / 2375 passed | 3 skipped** (no unit change),
and `integration` **98 files / 905 tests: 5 failed | 900 passed** — the four intended RED pins
plus three 5 s timeouts under load (`notification-digest-flush-failure`,
`admin-two-factor-signin` I10, `media-signed-url-never-logged`), each of which passes when its
file is run alone and none of which imports a queue module.

## Number allocation

This record takes the OP-122 lane's `Next free` value read from `docs/adr/README.md` at cut
time: `0684` inside the reserved range `0680`–`0699` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§2 — a lane-local counter, never the high-water mark). The ledger cell advances to `0685`
in the same commit, and the index row and the lane note are appended with it. No number
outside the lane range is touched.
