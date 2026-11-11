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

## Review sign-off — round 1 (card `t_153091a3`, artifact lens)

**Verdict: APPROVED WITH FINDINGS.** The round-1 review read the head `e6514db`
(`refactor(queue): OP-122 fold the Upstash answer validation into one helper`) and the
delivery landed as the squash `5f28acd`; the review record is the PR #418 comment
[`#issuecomment-6805809288`](https://github.com/yahodu/openpic-webapp/pull/418#issuecomment-6805809288)
plus five inline comments at the lines the Findings table cites. **Nothing in §Context,
§Decision, §Consequences or §Alternatives is retracted**: every decision, count and limit
above stands as written. The one amendment is the wording correction set out under
"Correction to §1" below, which corrects a claim about what the compiler checks rather
than a decision or an observed behaviour. The reviewer pushed one refactor of its own; it
is recorded at the end of this section.

### The reviewed bytes are what shipped

`git diff --stat e6514db 5f28acd` is **empty**, so every line number cited here is a line
number on the trunk.

### Acceptance criteria → evidence (measured at `e6514db`)

| Card criterion                                     | Evidence                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| There is no payload beyond identifiers.            | `queueEnvelopeSchema` is a `z.strictObject` over exactly the ten §10.4 keys; `enqueue` sends `JSON.stringify(envelope)` and nothing else (`upstash-queue.ts:128`); the envelope is built inside `enqueueWork` from a `WorkItemPointer`, so a caller has no field to add. 20 unit cases, incl. five extra-field rejections and the `profileId` rejection. |
| The broker id only lives in `processing.queueRef`. | `grep -rn messageId apps/web/src` finds one production writer: the `$set` at `enqueue-work.ts:82` (the follow-up moved it to `:89`). `I2` asserts the `{queueKey, provider, messageId}` triple and the exact ten-key envelope on the wire.                                                                                                               |
| An enqueue failure is non-fatal.                   | `I2` drives a real 5xx through MSW: `TransportError` → `warn queue.enqueue_failed` → `{enqueued: false}`, `queueRef: null`, `processing.status` still `queued`. A _hang_ was not covered — that is F2.                                                                                                                                                   |
| `traceId` = the request id                         | required non-empty by the strict schema and copied verbatim from `work.traceId`; the unit case deletes it and asserts the rejection.                                                                                                                                                                                                                     |

Gates, all at the reviewed head:

| Gate                                     | Result at `e6514db`                      |
| ---------------------------------------- | ---------------------------------------- |
| full `unit`                              | 147 files / **2375 passed \| 3 skipped** |
| full `integration`                       | 97 files / **887 passed**                |
| focused                                  | `unit` 41/41, `integration` 8/8          |
| `tsc -p apps/web/tsconfig.json --noEmit` | exit 0                                   |
| eslint                                   | 0 errors                                 |
| `prettier --check`                       | clean                                    |
| ADR guard                                | **29/29**                                |
| CI on the head                           | 14/14                                    |

### Findings

Each finding was re-reproduced with a probe at `e6514db` rather than transcribed from a
handoff, and none of them contradicts a pinned behaviour — which is why the delivery is
approved.

| Finding                                                                                                                                                                                      | Severity | Probe at `e6514db`                                                                                                                                                                                                                 | Routed to                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **F1** the pointer is validated only after the enqueue: `enqueue-work.ts:77` enqueues, `:79` builds the `ObjectId`.                                                                          | Medium   | `enqueueWork` with `id: "not-an-object-id"` put one `LPUSH` on the broker and then answered `{enqueued: false}` with `queueRef` untouched — a poison message _and_ a claim of failure. `spaceKey: ""` reproduced it.               | TEST `t_7564fb5a` (PR #419) → GREEN `t_f41b1eb1` (PR #421) |
| **F2** no request timeout: `upstash-queue.ts:81` passes no `signal`.                                                                                                                         | Medium   | a `fetch` that never settles kept `enqueueWork` pending past a 50 ms timer, so a hung broker hangs the user request; `classifyTransportFailure`'s `timeout` branch (`transport-error.ts:90-93`) was unreachable from this adapter. | `t_7564fb5a` → `t_f41b1eb1`                                |
| **F3** the ack/nack ledger is process-local and unbounded, and an unknown id is dropped silently (`upstash-queue.ts:178-181`).                                                               | Low      | `nack("unknown", 1)` resolved with zero commands and an empty log sink; the `claimed` map carries no bound and no eviction.                                                                                                        | `t_7564fb5a` → `t_f41b1eb1`                                |
| **F4** the two adapters disagree on where a nacked message goes: `memory` redelivers in place, the list re-`LPUSH`es to the head (`:183`) while `RPOP` takes the tail, so it is served last. | Low      | one `nack` on each adapter — `memory`'s next `claim` returned the same message first, the Upstash command log showed the payload re-pushed at the head.                                                                            | `t_7564fb5a` → `t_f41b1eb1`                                |
| **F5** `nack`'s `delaySeconds` is ignored by the list transport (`:175` takes `_delaySeconds`).                                                                                              | Low      | `nack(id, 300)` issued its `LPUSH` immediately, so the delay is not honoured — and no spec observed it.                                                                                                                            | `t_7564fb5a` (pins)                                        |
| **F6** one malformed payload costs the whole claimed batch (`:146-161`).                                                                                                                     | Low      | `claim` over `[good, "{not json}"]` threw a drift error and returned nothing: the good payload had already been `RPOP`ed and was never re-`LPUSH`ed, so it is lost.                                                                | `t_7564fb5a` (pins)                                        |
| **F7** the sweep this record leans on in §4 does not exist yet.                                                                                                                              | Info     | nothing in the tree re-enqueues an item whose `queueRef` is missing; the sweep is OP-136 I1 `t_b25b384f`. That is why F1 and F6 lose work silently instead of being repaired.                                                      | OP-136 I1 `t_b25b384f`                                     |

No Critical finding: the bearer token never reaches a log field or an error body (`I1`
asserts the whole sink), the envelope cannot carry media coordinates, and this card adds no
route, no authorization surface and no user input.

### Correction to §1 — the conditionals are not an exhaustiveness check

§1 says the closed-union conditionals "keep the compiler's exhaustiveness check over the
union for free". They do not. `defaultPriorityFor` (`envelope.ts:69-71`) is
`kind === "event_image" ? "normal" : "high"`, which compiles for any fourth `QueueKind` and
silently routes it to `q:selfie`; `queueKeyFor` (`:59-61`) admits a third `QueuePriority` as
`q:image`. A ternary over a literal comparison is not an exhaustiveness check, so a
widened union fails open instead of failing the build. The
historical sentence stands as the record of what was believed at the time; the
recommendation for a future mapping change is a `switch` with an `assertNever` default
behind a new pin, so widening the union becomes a compile error instead of a silent routing
decision.

### The reviewer's own refactor (`e6514db`)

`refactor(queue): OP-122 fold the Upstash answer validation into one helper`. The
Zod-parse-or-drift pair was written at both answer sites and now lives in the one `query()`
helper (`upstash-queue.ts:107-120`), so "every answer is validated" is structural rather
than remembered. Behaviour is unchanged: same error classes, same drift record fields, same
command arrays, and the full suite is identical before and after the commit (147 files /
2375 passed \| 3 skipped; 97 files / 887 passed, on both sides).

### Post-review status

The follow-ups above ran after this review and their own records document what followed
([ADR-0682](ADR-0682-op122-queue-followup-pins.md) for the pins,
[ADR-0683](ADR-0683-op122-queue-followup-green.md) for the fixes). This line states only
what was re-run against the settled code.

- **F1 and F2 are closed** by `t_f41b1eb1` (PR #421): the `ObjectId` build and
  `queueEnvelopeSchema.parse` now run before `queue.enqueue`, and the adapter carries a
  `timeoutMs` budget (default `DEFAULT_TIMEOUT_MS = 10_000`) whose abort lands in the
  existing `classifyTransportFailure` as a retryable `timeout` with no drift record. Re-run
  on the merged code: the 13 pins plus the 8 shipped adapter cases are **21 passed (21)**.
- **F3 and F4 are settled, not removed**: the silent foreign-id ack/nack is now a pinned
  behaviour instead of an accident, and the port states that a nacked message's position is
  adapter-defined. Unifying the two adapters needs one pin retarget, which the GREEN card
  was not allowed to take.
- **F5, F6 and F7 stand open.** The pins freeze F5 and F6 as they are, and the sweep is
  still OP-136 I1 `t_b25b384f`.

### Carried records

[ADR-0680](ADR-0680-op122-queue-port-red.md) is carried **unchanged** into the same squash
and needs no separate sign-off: it is the pins record, and its contract is what the GREEN
implemented. `docs/adr/README.md` stays byte-identical, and this sign-off consumes **no**
ADR number — the lane's `Next free` cell does not move.
