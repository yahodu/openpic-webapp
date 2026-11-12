# ADR-0682 — OP-122 round-1 review follow-up: the pins for the enqueue pointer ordering, the transport timeout, the ack/nack ledger, the retry ordering, the ignored delay and the batch loss

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 review follow-up TEST (`t_7564fb5a`) · **Branch:** `OP-122-task-queue-followup-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0680](ADR-0680-op122-queue-port-red.md) (the executable contract this follow-up pins), [ADR-0681](ADR-0681-op122-queue-green.md) (the GREEN whose findings these are), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) (the shared `TransportError`/`UpstreamContractError` classification), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope and the queue-swap surface) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (`processing.queueRef`)

## Context

The round-1 review of the OP-122 GREEN (`t_153091a3`, merged as `5f28acd`) reproduced
nine findings in a throwaway probe worktree. Six of them were behaviours no shipped spec
observed; this card adds the pins and nothing else. The other three are routed elsewhere
and are **not** pinned here: F7 (the sweep does not exist yet — OP-136 I1, `t_b25b384f`),
F8 (an ADR-0681 exhaustiveness overclaim — the docs-correction card `t_8c1d9fab`) and F9
(`QUEUE_PROVIDER` still admits only `memory|mongo` — the first wiring lane).

The card is **test-only**: no production file changed, no shipped spec, fixture,
ADR-0680 or ADR-0681 was edited. All 13 new cases live in one file,
`apps/web/src/test/integration/queue-followup-pins.test.ts`, because every pin needs
either the Mongo memory server (`enqueueWork`) or the MSW Upstash mock
(`createUpstashQueue`).

### Posture, stated up front so a green run is not misread

| Pin | Kind              | State at `5f28acd` |
| --- | ----------------- | ------------------ |
| P1  | **RED by design** | 4 cases fail       |
| P2  | **RED by design** | 2 cases fail       |
| P3  | characterization  | 2 cases pass       |
| P4  | characterization  | 2 cases pass       |
| P5  | characterization  | 1 case passes      |
| P6  | characterization  | 2 cases pass       |

P3–P6 are **green on arrival** on purpose: they lock behaviour the review found but
that the card does not ask to change. A later reader must not read them as RED pins
that failed to bite — their discrimination is shown by the mutation probes in the
Evidence section, and
the behaviour they lock is a documented limit, not a target.

## Decisions

### 1. P1 — the pointer is validated **before** the broker sees it (RED)

`apps/web/src/server/queue/enqueue-work.ts` calls `options.queue.enqueue(...)` at
line 77 and only then `new ObjectId(work.id)` at line 79; the envelope is never parsed
against `queueEnvelopeSchema`. Two consequences, both reproduced by the new cases:

- a `work.id` that is not 24-hex is enqueued (the `memory` adapter's `outbox` holds an
  envelope whose `id` is `"not-a-24-hex-object-id"`) and the call still reports
  `{enqueued: false}` — the throw comes from `new ObjectId` _after_ the wire call;
- `spaceKey: ""` and a non-hex `tenantId` are enqueued, the `queueRef` write
  **succeeds**, and the call reports `{enqueued: true}`, so a message the strict §10.4
  schema rejects sits in the broker for good.

The pin set (one `it.each` over the three corruptions plus one aggregate case):

1. `queue.outbox` is **empty** — nothing reached the broker;
2. the seeded work item's `processing.queueRef` stays `null` — nothing was written;
3. a `warn` `queue.enqueue_failed` is logged with `queueKey: "q:selfie"` and
   `kind: "selfie"`;
4. the call returns `{enqueued: false}`;
5. every envelope that _does_ reach the broker parses with
   `queueEnvelopeSchema.safeParse(...).success === true` — with a valid pointer still
   enqueued in the same case, so the empty-outbox assertion cannot pass vacuously.

The invariant the GREEN must satisfy is one sentence: **no request path may put a
value on the broker that `queueEnvelopeSchema` rejects**, and the pointer must be
validated (schema and `ObjectId`) before `enqueue`. How it does that (parse the
envelope, build the `ObjectId` first, or both) is its choice; the tests assert only
the five observables.

### 2. P2 — the adapter takes a request budget: `timeoutMs` (RED)

`createUpstashQueue` builds no `AbortController`, so a broker that never answers never
settles: `enqueue()` was still pending when this card's 1 500 ms deadline expired,
which means `enqueueWork`'s `catch` never runs and the **user request hangs**. That
breaks the lane's third criterion ("an enqueue failure is non-fatal") for a hang, and
it makes `classifyTransportFailure`'s `timeout` branch
(`src/server/adapters/transport-error.ts:92-97`) unreachable from this adapter, while
both sibling production adapters abort (`novu/novu-transport.ts:125-142`,
`cashfree/cashfree-provider.ts:489-513`).

`timeoutMs` is the option name this card fixes:

- **type:** `readonly timeoutMs?: number` on `UpstashQueueOptions`. **Optional**, so
  every shipped `createUpstashQueue({ url, token, logger })` call stays valid.
- **semantics:** the per-request budget for one Redis command. The adapter aborts the
  `fetch` when it expires, and the abort reaches the caller **through the existing
  classification** — `TransportError` with `code: "timeout"` and `retryable: true` —
  not a new error type, and **without** a `queue.upstream_contract_violation` record (a
  hang is transport noise, not wire drift).
- **default chosen by this ADR:** `10_000` ms. Nothing observes the default (a spec
  cannot wait 10 s), so the GREEN may pick another documented default; the pin only
  fixes the name, the optionality and the classification.

The two cases assert (a) `enqueue` rejects with a `TransportError` whose
`code === "timeout"` and `retryable === true`, (b) zero drift records, and
(c) `enqueueWork` returns `{enqueued: false}` and leaves `queueRef: null`. Both race
the call against a 1 500 ms deadline so the RED failure is the assertion
(`expected 'still-pending' to be an instance of TransportError`) rather than a bare
5 s vitest timeout.

### 3. P3 — `ack`/`nack` on a foreign id is a silent no-op (characterization)

`claimed` is a process-local `Map`, so `nack("id-from-another-process", 30)` and
`ack("id-from-another-process")` resolve without a broker call and without a log: the
payload was `RPOP`ed at claim time, so the message is simply gone. The pins assert the
observable — both resolve, zero `fetch` calls, an empty log sink.

The ledger itself is **unbounded**: one entry per claimed-but-never-acked message, held
for the process lifetime. That is not observable through the port (there is no
inspection API and no eviction), so it is recorded here rather than pinned; a worker
that crashes mid-batch leaks one entry per in-flight message until the process
restarts.

### 4. P4 — the two adapters disagree on where a retry goes (characterization)

- `memoryWorkQueue` keeps one entry table: `nack` clears `inFlight` and sets
  `visibleAtMs`, so the message is **redelivered in place** — before a message enqueued
  after it. Pinned: with `delaySeconds: 0`, a `claim` after the nack returns
  `[first, second]`.
- The Upstash adapter re-`LPUSH`es the payload to the **head** while `RPOP` drains the
  **tail**, so a nacked message is served **last**. Pinned on the wire: exactly one
  `LPUSH` of the same payload arrives after the claim, and the command list is
  `[LPUSH, LPUSH, RPOP, LPUSH]`.

**The intended port contract stated here** (this is the decision the divergence forces):
`claim` guarantees FIFO over messages **enqueued** on a key; a message returned by
`nack` is guaranteed only to become claimable again **after its delay**, and its
_position_ among the remaining messages is adapter-defined. The port therefore does
**not** promise in-place redelivery, and the shipped memory spec's doc-comment claim
("the port must behave the same whichever adapter is selected, or a worker spec written
against `memory` proves nothing") is too strong for retry order — it holds for
FIFO-of-enqueued, permanent `ack` and delay-bounded `nack`, not for where a retry
lands. A worker spec that depends on retry _order_ must be written per adapter, and a
later delayed-sorted-set implementation is free to change the Upstash position again
without breaking this port contract.

**The follow-up GREEN may choose the stricter contract** — "a nacked message goes to the
back" (the position the Upstash adapter already has) — because its card prefers the two
adapters agree. That is a _stronger_ promise than this record makes, not a contradiction
of it: adopting it must retarget the P4 memory pin to `[second, first]`, keep the Upstash
`LPUSH` assertion as is, and record the change here. What this record forbids is the
silent option: the divergence is pinned so that either choice is visible in a diff.

### 5. P5 — `nack`'s `delaySeconds` never reaches the Upstash broker (characterization)

`nack(id, 600)` sends one immediate `LPUSH`; no delayed structure is touched and the
delay is discarded. The code marks it `shortcut:` and ADR-0681 §2 documents it, but no
spec observed it. The pin: after the nack the command list is exactly
`[LPUSH, RPOP, LPUSH]` (the re-push is the _same_ payload, issued at once), and a claim
immediately afterwards returns that payload — with a 600 s delay requested, no
visibility window exists at all.

Consequence for the GREEN and for workers: until a broker-side backoff exists, the
`nack` delay is a **memory-adapter-only** semantic. A worker must not rely on it to
space retries on Upstash; the retry budget has to come from the caller's attempt count.

### 6. P6 — one malformed payload costs the whole claimed batch (characterization)

`claim` pops `N` payloads in one `RPOP`, then throws on the first unparseable one. The
good payloads are dropped and never re-`LPUSH`ed: the pin asserts one `RPOP`, **zero**
`LPUSH`, one `queue.upstream_contract_violation` record, and an
`UpstreamContractError`. Two shapes are pinned: a payload that is not JSON, and a
payload that is JSON but not a §10.4 envelope.

§10.4 treats a lost broker message as a non-event **because the sweep re-enqueues it** —
and the sweep does not exist yet. **Recovery for this pin is blocked on OP-136 I1
(`t_b25b384f`)**; until that lands, a single poison payload silently discards up to
`max - 1` healthy messages, and the MongoDB side still shows them `queued` (so the work
is recoverable only by the future sweep, not by the broker).

### 7. What the GREEN owes

The follow-up GREEN sweeps these pins into its own PR and closes this draft PR (the
OP-122 #417 → #418 precedent):

1. validate the pointer (schema **and** `ObjectId`) before `enqueue` in `enqueueWork`;
2. add `readonly timeoutMs?: number` to `UpstashQueueOptions`, abort the request with
   an `AbortController`, and let the existing `classifyTransportFailure` map the abort
   to `code: "timeout"`, `retryable: true`, with no drift record;
3. keep P3–P6 green — they are locks, not targets. If a fix changes one of them (for
   example re-`LPUSH`ing the healthy half of a malformed batch), the GREEN must update
   **that** pin and record the change here; it must not delete it.

## Evidence

Measured on this branch, at the OP-122 squash `5f28acd` (+ the release commit
`629b223` on `origin/main`), with `node_modules` installed offline:

| Run                                                            | Result                           |
| -------------------------------------------------------------- | -------------------------------- |
| focused `--project integration queue-followup-pins.test.ts`    | **6 failed                       | 7 passed (13)** — the 6 are P1's 4 and P2's 2                                          |
| focused `--project unit queue-envelope + queue-memory-adapter` | **41 passed (41)**, unchanged    |
| full `--project unit`                                          | **147 files / 2375 passed        | 3 skipped (2378)** — identical to the parent handoff, i.e. this card is unit-neutral   |
| full `--project integration`                                   | **98 files / 900 tests: 6 failed | 894 passed** — the only reds are the P1/P2 pins (baseline 97/887, +1 file / +13 cases) |

Every RED failure is assertion-level:

```
AssertionError: expected [ { messageId: 'memory-1', …(2) } ] to deeply equal []
AssertionError: expected { enqueued: true } to deeply equal { enqueued: false }
AssertionError: expected 'still-pending' to be an instance of TransportError
AssertionError: expected 'still-pending' to deeply equal { enqueued: false }
```

### Mutation probes (each RED pin bites, and they bite independently)

A faithful **minimal** implementation was applied to the two production files, run,
and reverted (`sha256` before/after; `git diff` on both files empty afterwards):

- `enqueue-work.ts`: `queueEnvelopeSchema.parse(envelope)` + `const workObjectId = new
ObjectId(work.id)` before `options.queue.enqueue(...)`, `updateOne({_id: workObjectId})`.
- `upstash-queue.ts`: `timeoutMs?: number` on the options, and an `AbortController`
  whose `setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)` is cleared
  in a `finally` on the `fetch`, with `signal` passed through.

| State               | Focused result     |
| ------------------- | ------------------ |
| head (both defects) | 6 failed           | 7 passed                       |
| **P1 fix only**     | **2 failed         | 11 passed** — exactly P2's two |
| **P2 fix only**     | **4 failed         | 9 passed** — exactly P1's four |
| both fixes          | **13 passed (13)** |

The P1 fix alone also kept the shipped `queue-upstash.test.ts` at 8/8 and the shipped
unit queue specs at 41/41, so the pinned contract is satisfiable without regressing the
lane.

## Number allocation

This card owns **`0682`** of the OP-122 lane range `0680`–`0699`; the lane's `Next free`
cell advances `0682` → `0683`. No number outside the range is touched.

## Consequences

- The pins PR is **red by design** and is a **draft that is never merged**; its CI is
  expected to fail on the P1/P2 cases and the follow-up GREEN folds the file into its own
  PR.
- `docs/adr/README.md` is the shared-ledger hotspot: the lane cell and any appended
  prose note must merge as a union keeping the highest value.
- P3–P6 are locks. Any future change to the claim ledger, the retry position, the nack
  delay or the batch-loss behaviour must update the matching pin **and** this record —
  deleting a green characterization pin is a silent contract change.
- Recovery from P1 and P6 work-loss needs the sweep (OP-136 I1, `t_b25b384f`); until it
  lands, the §10.4 "a lost broker message is a non-event" claim is only half true.
