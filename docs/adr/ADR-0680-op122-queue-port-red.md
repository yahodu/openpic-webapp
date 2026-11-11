# ADR-0680 — OP-122 RED: the provider-neutral WorkQueue port — the strict pointer envelope, the priority→queue mapping, the Upstash and memory adapters, and the non-fatal `enqueueWork`

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 RED (`t_fa23f9c9`) · **Branch:** `wt/t_fa23f9c9` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0001](ADR-0001-ports-and-adapters.md) (the ports-and-adapters shape this lane instantiates for the queue), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) (the shared `TransportError`/`UpstreamContractError` classification a drift reuses), [ADR-0580](ADR-0580-op112-object-storage-port-red.md) (the port + vendor adapter + memory adapter + MSW layout this record mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this lane draws its own block), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design)
- **Contract:** §10.4 (queue message envelope, the pointer rule and the queue-swap surface), §10.3 (the worker pulls; MongoDB holds durable job state), §6.3 (`POST /p/events/{slug}/selfies` enqueues to `q:selfie` at `high`) · **Schema:** §18.1 (division of responsibility: broker = transport, MongoDB = job state), §18.2 (the `processing` sub-document and `queueRef`), §28 (the queue-swap playbook)

## Context

OP-122 is the queue half of the Uploads & Media epic. The user story is one
sentence: _a provider-neutral queue with pointer-only messages, so the Python
worker can pull work and Upstash can be swapped for SQS without a schema change._

The card's test list is short — U1 the strict envelope, U2 the kind/priority →
queue-key mapping, I1 the Upstash REST adapter over MSW, I2 a failed enqueue
leaving the item queued with a `warn` — and it names no module path, signature
or error class. The gated GREEN card (`t_153091a3`) names the port surface
(`enqueue`/`claim`/`ack`/`nack`), the two adapters and the `enqueueWork`
behaviour, but no types. This record fixes the executable contract the tests
encode, so the GREEN has one coherent spec to implement.

Three sentences from the contract shape everything below:

- **The message is a pointer, never a carrier** (§10.4): all state is re-read
  from MongoDB at claim time, so a message that sat in the queue for an hour is
  never stale — and a message that carried an image URL or an embedding would
  hand the media coordinates to the broker.
- **The broker is transport; MongoDB is the job state** (§18.1, constraint C4):
  a lost broker message is a non-event, because the sweep re-enqueues anything
  `queued` past its ack window. That is what makes an enqueue failure
  **non-fatal** instead of a `500` on the user's upload.
- **The broker id lives in exactly one place** (`processing.queueRef`, §18.2):
  swapping Upstash for SQS changes `queueRef.provider` and one adapter; zero
  schema change.

## Decisions

### 1. Module layout

| Module                            | Exports                                                                                                               | Drives |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| `@/server/queue/envelope`         | `queueEnvelopeSchema`, `QueueEnvelope`, `QueueKind`, `QueuePriority`, `QueueKey`, `queueKeyFor`, `defaultPriorityFor` | U1, U2 |
| `@/server/queue/work-queue`       | `WorkQueue`, `QueueMessage`, `EnqueueResult`                                                                          | all    |
| `@/server/adapters/memory-queue`  | `memoryWorkQueue`, `MemoryWorkQueue`, `MemoryQueuedMessage`                                                           | U3, I2 |
| `@/server/adapters/upstash-queue` | `createUpstashQueue`, `UpstashQueueOptions`                                                                           | I1, I2 |
| `@/server/queue/enqueue-work`     | `enqueueWork`, `EnqueueWorkOptions`, `WorkItemPointer`                                                                | I2     |

`@/server/adapters/transport-error` (`TransportError`, `UpstreamContractError`,
`classifyTransportFailure`) and `@/server/runtime/clock` (`Clock`,
`systemClock`, `fixedClock`) already exist on `main` and are **reused**, not
re-declared — the ADR-0072 / ADR-0580 precedent.

### 2. `@/server/queue/envelope` — the strict §10.4 envelope

`queueEnvelopeSchema` accepts exactly the ten documented fields and **rejects
everything else** (`.strict()`):

| Field        | Rule                                                       |
| ------------ | ---------------------------------------------------------- |
| `v`          | literal `1` — an unknown version is refused, never guessed |
| `kind`       | `event_image \| selfie \| match_incremental`               |
| `id`         | 24-character lowercase hex (ObjectId wire shape)           |
| `tenantId`   | 24-character lowercase hex                                 |
| `eventId`    | 24-character lowercase hex                                 |
| `priority`   | `high \| normal`                                           |
| `spaceKey`   | non-empty string (the embedding space snapshot)            |
| `enqueuedAt` | ISO 8601 instant string (JSON transport, not a `Date`)     |
| `attempt`    | integer `>= 0` (§18.2 starts `attempts` at `0`)            |
| `traceId`    | non-empty string; the request id the work is correlated on |

The pins assert the parsed object's **key set** and that no value is an object,
so "no payload beyond identifiers" is structural rather than a comment.

### 3. `match_incremental` reuses `id`, it does not add `profileId`

§10.4 says `match_incremental` "carries `profileId` in place of a media `id`".
That is read as _the same field pointing at a different entity_, not a second
key: `id` holds the `profileId` for that kind. A discriminated union would
multiply the pointer vocabulary (and each variant's strictness) for no gain; the
RED pins both halves — a `match_incremental` envelope parses with the **same ten
keys**, and an envelope carrying an extra `profileId` is **rejected**.

### 4. `queueKeyFor` / `defaultPriorityFor` — the §18.1 mapping

Two total pure functions, so the mapping is stated once:

- `queueKeyFor(priority)` → `high` = `"q:selfie"`, `normal` = `"q:image"` — the
  physical queue is the **priority** (that is what "drained strictly in priority
  order" means: an attendee staring at a spinner goes before a batch).
- `defaultPriorityFor(kind)` → `selfie` = `high` (PRD, §6.3),
  `match_incremental` = `high` (an attendee is waiting for the re-run),
  `event_image` = `normal`.

Pinned composition: `queueKeyFor(defaultPriorityFor("selfie")) === "q:selfie"`
and `defaultPriorityFor("selfie") === "high"` — the card's "selfie → q:selfie
high" in one assertion.

### 5. `@/server/queue/work-queue` — the port surface

```ts
interface WorkQueue {
  readonly provider: string; // "upstash" | "memory"
  enqueue(envelope: QueueEnvelope, queueKey: QueueKey): Promise<{ messageId: string }>;
  claim(queueKey: QueueKey, max: number): Promise<QueueMessage[]>;
  ack(messageId: string): Promise<void>;
  nack(messageId: string, delaySeconds: number): Promise<void>;
}
interface QueueMessage {
  readonly messageId: string;
  readonly envelope: QueueEnvelope;
}
```

`provider` is on the port so `processing.queueRef.provider` is taken from the
**selected adapter** rather than hard-coded: I2 asserts `"memory"` while driving
the memory adapter, which a hard-coded `"upstash"` fails.

### 6. `@/server/adapters/upstash-queue` — the Redis REST adapter

- `createUpstashQueue({ url, token, logger?, fetch? })` — an **explicit** config
  object, no env read inside the adapter (the `createCashfreeProvider` /
  `createR2ObjectStorage` shape).
- `enqueue` POSTs one command array to the REST endpoint:
  `["LPUSH", queueKey, JSON.stringify(envelope)]` — three elements, the envelope
  as the single argument, `authorization: Bearer <token>`,
  `content-type: application/json`. **LPUSH to the head / claim from the tail**
  is the FIFO direction of the list; the queue key already carries its `q:`
  prefix, so the adapter never re-prefixes it.
- The response is parsed with Zod: `{ result: number }`. A **changed shape** (a
  nested object, a string, a non-JSON body) is a non-retryable
  `UpstreamContractError` **and** an `error` log entry
  `queue.upstream_contract_violation` carrying `provider: "upstash"`,
  `operation: "enqueue"` and the `queueKey` — the same drift-signal shape as
  `payments.upstream_contract_violation` (ADR-0072), so one on-call query finds
  both.
- A non-2xx answer is classified through the shared
  `classifyTransportFailure` — a 5xx is a **retryable** `TransportError` and is
  _not_ logged as a contract violation (a retry can fix it).
- **The message id is adapter-minted.** A Redis list has no server-assigned
  message id (LPUSH answers with the list length), so `enqueue` mints an opaque
  token and returns it; that token is what lands in
  `processing.queueRef.messageId` and nothing else reads it. This is safe
  precisely because MongoDB owns retry accounting (§18.1): the sweep keys off
  leases and `queuedAt`, never off a broker ack.

### 7. `@/server/adapters/memory-queue` — the test/e2e adapter

`memoryWorkQueue({ clock? })` — a fresh isolated queue per call, an injected
`Clock` for the nack delay, and an inspectable `outbox`.

- `enqueue` appends to that queue key's FIFO list; `claim(queueKey, max)` returns
  at most `max` envelopes **in FIFO order**, each with a message id, and an
  in-flight message is never handed out twice.
- The two logical queues stay separate: `claim("q:selfie")` never returns a
  `q:image` message.
- `ack` drops a message permanently.
- `nack(messageId, delaySeconds)` makes the message claimable again **only after**
  the delay, read from the injected clock (the delay case is driven by a movable
  clock, never a `sleep`).

The port semantics are pinned here rather than on the Upstash wire because the
Upstash `claim`/`ack` mechanics are the GREEN's choice; what must not vary by
adapter is the port's behaviour.

### 8. `@/server/queue/enqueue-work` — the non-fatal enqueue

```ts
enqueueWork({ db, queue, collection, work, logger?, clock? }) → Promise<{ enqueued: boolean }>
work: { kind, id, tenantId, eventId, spaceKey, traceId, priority?, attempt? }
```

- The envelope is **built here** from the work item (`v: 1`, `priority` =
  `work.priority ?? defaultPriorityFor(kind)`, `enqueuedAt` =
  `clock.now().toISOString()`, `attempt` = `work.attempt ?? 0`), so no caller can
  inject a payload field.
- On success it writes **only** `processing.queueRef = { queueKey, provider,
messageId }` on the work item (`db.collection(collection).updateOne`), leaving
  `processing.status` at `queued`.
- On failure it **never throws**: it logs `warn` `queue.enqueue_failed` with the
  `queueKey` and the `kind`, leaves the item (status and `queueRef` untouched, so
  the sweep re-enqueues it) and returns `{ enqueued: false }`. That is the
  contract's "an enqueue failure must never fail the user request" (§18.1).

### 9. Test placement

The two pure surfaces are `unit` specs (`apps/web/src/test/unit/`); the MSW +
MongoDB cases are one `integration` spec
(`apps/web/src/test/integration/queue-upstash.test.ts`) that boots
`startTestApp({prefix: "op122-queue"})` once and seeds `event_images` work items
with a `processing` sub-document. The envelope factory lives in
`apps/web/src/test/factories/queue.ts`.

## Number allocation

This lane had no reserved range on `main`, so — as its first card — it drew the
next block from the allocator's `unallocated (future lanes)` pool: **`0680`–`0699`**.
The table gains an `OP-122 queue lane` row with `Next free = 0681`, the pool
advances to `0700`+, and this record consumes `0680`. The gated GREEN
`t_153091a3` consumes `0681` next and must base its branch on this pins branch,
not bare `origin/main`. No number outside the lane range `0680`–`0699` is
touched.

## Consequences

- **Provider neutrality is pinned at both ends**: the `WorkQueue` surface on both
  adapters and the explicit-config factory shape (swapping Upstash for SQS is "a
  new adapter plus config", schema §28) — no domain field is named after a
  broker.
- **A pointer message cannot go stale and cannot leak media coordinates**: the
  strict schema makes "an extra field" a test failure, and the work item's state
  is re-read at claim time.
- **A broker outage degrades, it does not fail the request**: the item stays
  `queued`, the failure is a `warn`, and the sweep owns recovery.
- This RED delivers **test files only** (two unit specs + one integration spec +
  the fixture factory) plus this ADR and the README ledger rows. The temporary
  stubs used to prove type-correctness were deleted; `git status` shows the four
  test files only. No production file is touched.

## Evidence

Probed in two directions, so the pins are neither vacuous nor unsatisfiable.

**RED (throwaway stubs that typecheck but do the wrong thing — a non-strict
schema, a constant mapping, a no-op enqueue):**
`npx tsc -p apps/web/tsconfig.json --noEmit` exited `0`, the unit probe failed
**26 failed | 15 passed (41)**, every failure assertion-level —
`expected the schema to reject an extra "payload" field: expected true to be
false`, `expected the schema to reject an extra "url" field: expected true to be
false`, `expected 'q:image' to be 'q:selfie'`, `expected 'normal' to be 'high'`,
`expected [] to deeply equal [ 'q:selfie' ]`.

**GREEN-forecast (a throwaway faithful implementation, deleted before handoff):**
the same two specs ran **41 passed (41)** and the integration spec
**8 passed (8)**, so the contract is satisfiable as written — including the ack
case, which claims exactly one message and then asserts the _other_ is still the
next delivery (an acked message never returns).

**Mutation probes on that faithful implementation (integration, `8` cases):**
`4 failed | 4 passed (8)`. Dropping the Zod validation of the Upstash answer
reddens the drift pin (`expected ZodError: […] to be an instance of
UpstreamContractError`); hard-coding `provider: "upstash"` and advancing
`processing.status` reddens both happy paths (`expected 'processing' to be
'queued'` and a `queueRef` deep-equality miss); rethrowing the enqueue failure
reddens the non-fatal pin (`TransportError: Transport request failed with status
500`). Each probe file was deleted; no production file survives.

At handoff the unit specs are red as **module-not-found** for the four modules
(the OP-93/ADR-0306 posture): `@/server/queue/envelope`,
`@/server/adapters/memory-queue`, `@/server/adapters/upstash-queue` and
`@/server/queue/enqueue-work`. `eslint` 0 errors on the four files and
`prettier --check` clean on the four files, this ADR and the README ledger rows.

## Assumptions and open questions

- **`match_incremental` reuses `id`** (§3 above). If a later lane needs a
  distinct `profileId` key, that is new tests and a schema version bump, not a
  silent widening.
- **`attempt >= 0` at enqueue time.** §18.2 initialises `attempts: 0` and
  increments at claim, while the §10.4 example shows `"attempt": 1`; the schema
  admits both and pins only "non-negative integer".
- **The Upstash wire mechanics beyond `enqueue` are unpinned.** §10.4 names the
  port, not the commands; the GREEN must document its `claim`/`ack`/`nack`
  choice (list vs sorted set, and how a claim hands back a message id) in its own
  ADR. What this RED fixes is the port's behaviour, pinned on the memory adapter.
- **A client-minted `messageId` on a Redis list** is a deliberate reading of
  "the broker id lives only in `processing.queueRef.messageId`" (§10.4): a list
  has no server id, and MongoDB owns retry accounting, so the token is a
  correlation handle rather than an ack capability.
- **No composition root in this lane.** `getWorkQueue()` (and adding `upstash` to
  `QUEUE_PROVIDER`'s admitted values, which today reads `memory | mongo`) lands
  with the first route that enqueues — no route exists in this card, so nothing
  is pinned against config.
- **No outbound envelope validation.** `enqueue` takes an already-typed
  `QueueEnvelope`; a `.parse` before the wire is a later hardening step, not part
  of the card.
- **No dedupe/retry pins.** At-least-once delivery is the broker's contract and
  the sweep's business (§18.1/§18.2); this lane only pins "the failure is
  non-fatal".
- The drift event name `queue.upstream_contract_violation` is new; it follows the
  `payments.upstream_contract_violation` / `ratelimit.limiter_failed` shape so
  log queries stay uniform.
