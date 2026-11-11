# ADR-0681 — OP-122 GREEN: the provider-neutral WorkQueue port implemented — the strict pointer envelope, the Upstash list adapter (LPUSH/RPOP), the memory adapter and the non-fatal `enqueueWork`

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-122 GREEN (`t_153091a3`) · **Branch:** `OP-122-task-queue-port-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fa23f9c9`
- **Relates to:** [ADR-0680](ADR-0680-op122-queue-port-red.md) (the executable contract this GREEN implements), [ADR-0001](ADR-0001-ports-and-adapters.md) (the port/adapter shape), [ADR-0072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md) (the shared `TransportError`/`UpstreamContractError` classification and the drift-signal shape), [ADR-0580](ADR-0580-op112-object-storage-port-red.md) (the port + vendor adapter + memory adapter + MSW layout), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §10.4 (queue message envelope, the pointer rule, the queue-swap surface) · **Schema:** §18.1 (broker = transport, MongoDB = job state), §18.2 (the `processing` sub-document and `queueRef`), §28 (the queue-swap playbook)

## Context

The RED card (`t_fa23f9c9`, ADR-0680) pinned 41 unit cases and 8 integration
cases over five modules that did not exist. This card turns them green with the
smallest honest implementation: no composition root, no `QUEUE_PROVIDER`
widening, no dedupe, no outbound `.parse` before the wire (all four are
explicitly out of scope in the RED handoff).

Everything below is the _implementation_ choice; the contract itself was fixed by
ADR-0680 and is not re-litigated here.

## Decision

### 1. Modules delivered

| Module                            | Delivered                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/server/queue/envelope`         | `queueEnvelopeSchema` (`z.strictObject`, ten §10.4 keys), `QueueEnvelope`, `QueueKind`, `QueuePriority`, `QueueKey`, `queueKeyFor`, `defaultPriorityFor` |
| `@/server/queue/work-queue`       | `WorkQueue`, `QueueMessage`, `EnqueueResult`                                                                                                             |
| `@/server/adapters/memory-queue`  | `memoryWorkQueue`, `MemoryWorkQueue`, `MemoryQueuedMessage`                                                                                              |
| `@/server/adapters/upstash-queue` | `createUpstashQueue`, `UpstashQueueOptions`, `UPSTREAM_CONTRACT_VIOLATION_EVENT`                                                                         |
| `@/server/queue/enqueue-work`     | `enqueueWork`, `EnqueueWorkOptions`, `WorkItemPointer`, `ENQUEUE_FAILED_EVENT`                                                                           |

`TransportError`, `UpstreamContractError`, `classifyTransportFailure` and
`Clock`/`systemClock` are **reused** from `main`, not re-declared.

The two mappings are written as total conditionals over the closed unions
(`priority === "high" ? "q:selfie" : "q:image"`,
`kind === "event_image" ? "normal" : "high"`) rather than a `Record` lookup: a
`Record` indexed by a non-literal trips `security/detect-object-injection`,
and the conditionals keep the compiler's exhaustiveness check over the union for
free.

### 2. Upstash wire: lists, `LPUSH` head / `RPOP` tail

- `enqueue` → one `POST` of `["LPUSH", queueKey, JSON.stringify(envelope)]`; the
  answer is Zod-parsed as `{result: number}` (the new list length).
- `claim` → `["RPOP", queueKey, String(max)]`, the answer parsed as
  `{result: string[] | null}`. `LPUSH` at the head and `RPOP` from the tail is
  the FIFO direction of the list, and the typed count form means one round trip
  for a batch. Each payload is parsed with `queueEnvelopeSchema`; a payload that
  is not JSON or not a §10.4 envelope is a contract violation, never a partial
  batch.
- **Message ids are adapter-minted** (ADR-0680 §6): a Redis list has no
  server-assigned id, so `enqueue` and `claim` each mint a `randomUUID()`. The
  enqueue-time id is the one that lands in `processing.queueRef.messageId`; no
  other code reads it.
- **`ack`/`nack` are a local claim ledger.** `RPOP` removes the payload at claim
  time, so `claim` keeps `messageId → {queueKey, payload}` in the adapter
  closure: `ack` retires the entry (the payload is already gone), and `nack`
  re-`LPUSH`es the payload and retires the entry.
  - Known limit, marked in code: `shortcut: a Redis list has no delay — the
payload is requeued at the head immediately`. The port's delay semantics are
    pinned on the memory adapter (ADR-0680 §7); the Python worker talks to
    Redis directly with its own backoff. Upgrade to a delayed sorted set if a
    TypeScript consumer ever needs in-broker backoff.
  - Second limit: the ledger is process-local, so `ack`/`nack` only resolve an
    id minted by the same process. That is exactly the case today (the backend
    enqueues; it does not claim).
- Drift is `error` `queue.upstream_contract_violation` with `provider`,
  `operation` and `queueKey` — the same field shape as
  `payments.upstream_contract_violation`, so one on-call query finds both. The
  bearer token is never a log field.
- `fetch?` is accepted as an injection point, mirroring
  `upstashRateLimiter`'s option of the same name; the pinned specs drive MSW
  through the global `fetch`, so nothing in the suite uses it.

### 3. Memory adapter: one entry table, delivery state on the entry

`memoryWorkQueue({clock?})` keeps a single `entries` array whose order is the
enqueue order, plus `outbox` (the same records, for the inspecting suites). An
entry carries `visibleAtMs`, `inFlight` and `done`:

- `claim` takes the first `max` entries of that key that are not `done`, not
  `inFlight` and whose `visibleAtMs` has passed — so FIFO per key, the two keys
  stay separate, and an in-flight message is never redelivered.
- `ack` sets `done` (permanent). `nack` clears `inFlight` and moves
  `visibleAtMs` to `clock.now() + delaySeconds * 1000`, so the delay is read
  from the injected clock instead of a sleep.

### 4. `enqueueWork`: one `try` around enqueue **and** the `queueRef` write

The envelope is built inside `enqueueWork` from the work pointer, so a caller
cannot add a field. On success the only write is
`$set: {"processing.queueRef": {queueKey, provider: queue.provider, messageId}}`
— `processing.status` is untouched, so the item stays `queued`.

The `catch` covers the `queueRef` write as well as the broker call: if the
enqueue succeeded but the write failed, the item has no `queueRef` and the sweep
re-enqueues it, which is the same non-fatal outcome. It logs `warn`
`queue.enqueue_failed` with `queueKey`, `kind` and the error, and returns
`{enqueued: false}` — it never throws, so an upload never fails because the
broker is down (§18.1).

## Consequences

- Every later lane can enqueue through one port; swapping Upstash for SQS is
  one adapter plus `processing.queueRef.provider` (schema §28), zero schema
  change.
- A broker outage degrades to "work sits queued until the sweep", never to a
  user-facing `500`.
- The Upstash `claim` path is implemented but not yet driven by any TypeScript
  caller, so it is exercised only by reading the code: the list FIFO order and
  the local claim ledger are unverified by tests. The first TypeScript consumer
  (or a worker written in Node) must pin them; until then the memory adapter is
  the only place the port's `claim`/`ack`/`nack` semantics are proven.
- No composition root exists: `QUEUE_PROVIDER` still admits only
  `memory | mongo`, and the first route that enqueues owns wiring the adapter.

## Alternatives considered

- **Sorted set (`ZADD`/`ZRANGEBYSCORE`) instead of a list** — would honour
  `nack`'s delay in the broker and give atomic delayed claims, but needs a
  reaper and two extra round trips for a delay no TypeScript caller asks for.
  Rejected for now; marked as the upgrade path.
- **A discriminated union for the three kinds** (`match_incremental` naming
  `profileId` explicitly) — multiplies the pointer vocabulary and its strictness
  for no gain; the RED pins one ten-key shape (ADR-0680 §3).
- **`$.parse` the envelope before the wire** — the envelope is constructed here
  from typed inputs, so the parse would only restate the type; the RED handoff
  lists it out of scope.
- **Re-throwing the enqueue failure** — would fail the user's upload for a
  broker hiccup, contradicting §18.1 and the I2 pin.

## Evidence

- `npx vitest run --project unit queue-envelope queue-memory-adapter` →
  **41 passed (41)**.
- `npx vitest run --project integration queue-upstash` → **8 passed (8)**.
- `tsc -p apps/web/tsconfig.json --noEmit` → exit 0; ESLint 0 errors and 0
  warnings on every touched file; `prettier --check` clean.
- Full-suite results are recorded on the card handoff.
