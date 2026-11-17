# ADR-0683 — OP-122 round-1 review follow-up: the pointer validated before the wire, the Upstash request budget, the ack/nack ledger and the retry ordering

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 review follow-up GREEN (`t_f41b1eb1`) · **Branch:** `OP-122-task-queue-followup-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0680](ADR-0680-op122-queue-port-red.md) (the RED contract), [ADR-0681](ADR-0681-op122-queue-green.md) (the GREEN these findings come from), [ADR-0682](ADR-0682-op122-queue-followup-pins.md) (the pins this record turns green), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) (the shared `TransportError` classification), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (the pointer envelope and the queue-swap surface) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (`processing.queueRef`)

## Context

The round-1 review of the OP-122 GREEN found two real defects and four behaviours no
spec observed. `t_7564fb5a` pinned all six in `queue-followup-pins.test.ts` (13 cases,
ADR-0682) with P1/P2 red by design. This card turns P1 and P2 green with production
code and settles P3/P4 as decisions; it adds no test of its own and **carries the pin
file byte-identical to the pins branch** (no test, fixture or mock is edited).

## Decisions

### 1. F1 — the pointer is built **and validated** before it reaches the broker

`enqueueWork` now does three things inside the existing `try`, in this order:

```ts
const workId = new ObjectId(work.id); // the id must be an ObjectId
const { messageId } = await options.queue.enqueue(
  queueEnvelopeSchema.parse(envelope), // …and the envelope §10.4-clean
  queueKey
);
```

The `ObjectId` is built first because `work.id` is both the envelope field and the
`updateOne` key, and the parse runs before the wire call, so an envelope the strict
schema rejects never becomes a poison message. A validation failure takes the **same
non-fatal path as a broker failure** — the one `catch` logs `warn`
`queue.enqueue_failed` with `queueKey`/`kind`, the call returns `{enqueued: false}`,
`processing.queueRef` is untouched, and nothing is on the broker. That is the shape the
P1 cases assert for all three corruptions (non-24-hex `id`, empty `spaceKey`, non-hex
`tenantId`) plus the aggregate case that keeps a valid pointer enqueued in the same run.

This **supersedes ADR-0681's "Alternatives" note**, which rejected a pre-wire parse as
"restating the type". The review disproved it: `spaceKey: ""` arrives from configuration,
not from a type error, and today it reaches the wire with a successful `queueRef` write.

### 2. F2 — the adapter takes a per-request budget (`timeoutMs`)

`UpstashQueueOptions` gains `readonly timeoutMs?: number` (optional, so every shipped
`createUpstashQueue({ url, token, logger })` call stays valid). `command()` builds an
`AbortController`, arms `setTimeout(() => controller.abort(), timeoutMs)`, passes the
`signal` to `fetch` and clears the timer in a `finally` — the
`novu/novu-transport.ts:125-142` shape. The abort rejects inside the existing `try`, so
the **existing** `classifyTransportFailure` maps it to a `TransportError` with
`code: "timeout"`, `retryable: true` and **no** `queue.upstream_contract_violation`
record: a hang is transport noise, not wire drift. `enqueueWork`'s `catch` then answers
`{enqueued: false}` with `queueRef: null`, which is what the second P2 case drives.

**Default: a documented constant, `DEFAULT_TIMEOUT_MS = 10_000`.** Two alternatives were
rejected:

- `getConfig().transport.timeoutMs` (the Novu resolve) — that value is the budget for a
  _different_ upstream, and coupling the queue to it means tuning Novu's timeout moves
  the broker's;
- a new `QUEUE_TIMEOUT_MS` env var — unobserved configuration. Nothing can assert a 10 s
  default without waiting 10 s, and the pins pass `timeoutMs` explicitly, so the config
  surface would be untested code. The constant follows the `cashfree-provider.ts:77`
  precedent. **Coverage gap for the Test Author:** the default itself is unpinned.

### 3. F3 — an unknown `messageId` is a silent no-op, and the ledger stays unbounded

The P3 pin already fixes the first half: `ack`/`nack` on an id this process never minted
resolve with **zero broker commands and an empty log sink**, so the "log a `warn`"
option is excluded by the pin, not by preference. The `claimed` map is process-local and
the payload was `RPOP`ed at claim time, so there is nothing left to act on.

The ledger is left unbounded, and this record states why that is acceptable: the backend
process **only enqueues** — `claim` is the worker's entry point, so a process that never
claims never grows the map. A worker leaks one entry per in-flight message until it
restarts, which is bounded by its own batch size and dies with the process. Bounding it
needs an eviction policy that nothing observes through the port (no inspection API, no
eviction hook), so an LRU here would be untested machinery. Revisit when a real worker
runtime lands (OP-136 I1 and the worker lane).

### 4. F4 — the port guarantees delay-bounded availability, not the retry's position

**The contract, stated on the port itself** (`work-queue.ts`, `nack` doc): `claim`
guarantees FIFO over messages **enqueued** on a key; a message returned by `nack` is
guaranteed only to become claimable no sooner than its delay, and its **position among
the remaining messages is adapter-defined** — `memory` redelivers in place, the Upstash
list re-`LPUSH`es to the head and `RPOP`s the tail, so it is served last.

**Why the stricter "a nacked message goes to the back" was not adopted here**, although
this card prefers it and Upstash already behaves that way: the two P4 pins freeze _both_
directions (memory `[first, second]`, Upstash `commands[3] === ["LPUSH", …]`), and this
card may not edit a pin. Unifying them therefore needs exactly one pin retargeted — a
Test Author change, then a one-line edit in `memoryWorkQueue.nack` (move the entry to the
back of the table). ADR-0682 §4 already authorises that path for a later card; it is not
taken here because the acceptance for this card is "the pin files unchanged".

What **is** aligned is the claim the code makes: `memory-queue.ts`'s header no longer
says a worker spec written against `memory` proves something about every adapter without
qualification — it now names the retry-position exception, so the divergence cannot be
rediscovered from a wrong doc comment.

### 5. Unchanged, deliberately

The §10.4 envelope shape, the `queue.upstream_contract_violation` record fields
(`provider`/`operation`/`queueKey`), the `queue.enqueue_failed` fields (`queueKey`/`kind`),
the `processing.queueRef` shape and `processing.status` semantics. P3, P5 (`nack`'s
ignored `delaySeconds`) and P6 (one poison payload costs the claimed batch) are locks,
not targets, and stay green untouched. No new dependency.

## Alternatives

- **`enqueueWork` catching only the pointer build, letting the parse throw** — rejected:
  a `ZodError` escaping turns a non-fatal enqueue into a failed user request, which is
  exactly what §18.1 forbids.
- **A `queueEnvelopeSchema.safeParse` with a hand-built failure branch** — rejected:
  the existing `catch` already produces the required observable, so a second branch would
  duplicate it and diverge from the broker-failure path the pin compares against.
- **Aborting with `AbortSignal.timeout(timeoutMs)`** — one line shorter, but it leaves no
  place to clear the timer and diverges from the two sibling adapters; the controller
  shape is the house pattern.
- **Bounding `claimed`** — see §3.

## Evidence

Measured on this branch (base: the pins tip `988e344`, itself on `origin/main` `629b223`):

| Run                                          | Result                                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| focused pin spec at the pins head `988e344`  | **6 failed \| 7 passed (13)** — P1's four and P2's two |
| same, after F1 + F2                          | **13 passed (13)**                                     |
| full `--project unit`                        | **147 files / 2375 passed \| 3 skipped (2378)**        |
| full `--project integration`                 | **98 files / 900 passed (900)**                        |
| `tsc -p apps/web/tsconfig.json --noEmit`     | exit `0`                                               |
| `eslint` on the four touched files           | 0 errors, 0 warnings                                   |
| `prettier --check` on the four touched files | clean                                                  |

The pin file, the fixtures, `ADR-0680`, `ADR-0681` and `ADR-0682` are untouched: the diff
against the pins tip is four production modules, this ADR and the README ledger cells.

## Number allocation

`0682` is consumed by [ADR-0682](ADR-0682-op122-queue-followup-pins.md), so this record
takes **`0683`** inside the OP-122 lane range `0680`–`0699` (the cell's value re-read at
the branch head immediately before the push) and advances the lane's `Next free` cell to
`0684`. No number outside the range is touched.

## Consequences

- A request path can no longer put a value on the broker that `queueEnvelopeSchema`
  rejects, so the reviewer's poison-message class is closed for `enqueueWork`. A _write_
  failure after a successful enqueue still leaves a broker message with no `queueRef` —
  unchanged, and the sweep's job (OP-136 I1, `t_b25b384f`).
- A hung broker now costs one `timeoutMs` and a `{enqueued: false}` instead of an
  unbounded user request; the classification stays in the one shared table.
- The retry-ordering divergence remains, now documented on the port and in the memory
  adapter's header. A future card may adopt "back" everywhere by editing one line and
  retargeting one P4 pin (ADR-0682 §4).
- Coverage gaps handed to the Test Author in the next pin cycle: the `DEFAULT_TIMEOUT_MS`
  default, the `updateOne` failure that follows a successful enqueue, and the
  `priority`/`attempt` overrides `enqueueWork` accepts.
