# ADR-0029 — Domain-event outbox: one `emitDomainEvent` write point, per-consumer dispatch flags, atomic claims

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-88 `t_a2962abb` (phase 1-Identity, epic Eventing, RED) · **Implements:** schema §18.3, contract §7.7 · **Depends on:** OP-84 (notification routing matrix), OP-77 (repository layer)
- **Supersedes / amends:** nothing. Pins the contract the OP-88 GREEN implementer must satisfy.

## Context

Schema §18.3 makes `domainEvents` the **single fan-out point** for notifications,
analytics and queue publishing: business code calls `emitDomainEvent(...)` once,
and each consumer flips its own `dispatch.*` flag. This is what stops a
notification failure from blocking the analytics rollup, and what lets an
analytics-only event (`event.viewed`) coexist with the 81 notification
`typeKey`s without a notification row.

The RED suite must pin the writer's _boundary_ behaviour (validation, retention,
flags, logging) separately from the _database_ behaviour that only a replica set
can prove (transactionality, dedupe, concurrency, stale-lease recovery), so the
implementer cannot couple them and a refactor of one cannot break the other.

## Decision

### 1. New module `@/server/domain/domain-events`

```ts
emitDomainEvent(input: DomainEventInput, options?: {
  db?: Db; clock?: Clock; session?: ClientSession;
}): Promise<{ deduped: boolean; id: string | null }>

claimPendingEvents(consumer: DomainEventConsumer, batch: number, options?: {
  db?: Db; clock?: Clock; claimerId?: string;
}): Promise<readonly DomainEventDocument[]>

markDone(eventId: ObjectId | string, consumer: DomainEventConsumer, options?: { db?: Db }): Promise<void>
markFailed(eventId: ObjectId | string, consumer: DomainEventConsumer, options?: { db?: Db }): Promise<void>
```

`DomainEventConsumer` is `"notifications" | "analytics" | "queue"`.

`DomainEventInput.eventKey`, `actorRef.kind` and `subjectRef.kind` are typed as
plain `string`s validated at **runtime** (by the Zod schema and the catalogue
gate), never as a closed Zod enum/union. `makeDomainEventInput` deliberately
produces invalid inputs for U1/U2 — an unknown `eventKey` and a contact-bearing
payload — so a closed-union type would make those specs fail to typecheck; the
catalogue itself is carried as `readonly string[]` (`NOTIFICATION_TYPE_KEYS`).

The module lives under `src/server/domain/**`, which carries the 90 % coverage
threshold and the "no ambient `Date`" lint rule (time enters through the
injected `Clock` port).

### 2. `eventKey` gate

An `eventKey` must be **either** one of the frozen 81 notification `typeKey`s
(`NOTIFICATION_TYPE_KEYS`, contract §7.6) **or** a registered analytics-only key
(the list must contain `event.viewed`, contract §7.7's named example). Anything
else is rejected with `code: "unknown_event_key"` and nothing is written.

### 3. Payload deep scan

`payload` is "minimal and resolvable" (contract §7.7): identifiers plus the few
denormalised fields templates need. A **deep** scan (any depth, exact key match,
not substring) rejects a payload nesting any of `email`, `phone`, `token`,
`otp`, `embedding`, `vector`, `password` with
`code: "forbidden_payload_field"`. This keeps contact details and vector data
out of the append-only log and out of digest buckets read hours later.

### 4. Retention from `platformSettings`

`occurredAt` is stamped from the injected `Clock`; `expireAt` =
`occurredAt + platformSettings.retention.domainEventDays`, defaulting to the
documented 180 days when the singleton is absent. No hard-coded retention.

The singleton is read through the **injected `db`** —
`getPlatformSettings({ db, clock })` — never the ambient/real client. Unit specs
U3/U3b seed a `platformSettings` document on the recording fake and expect the
writer to observe it; without forwarding `db`, `getPlatformSettings` would read
the absent real singleton and take the 180-day default, failing U3. The
`getPlatformSettings` cache is process-wide, so the specs call
`invalidatePlatformSettings()` in `beforeEach`.

### 5. `dispatch` flags

On insert: `{ notifications: "pending" | "skipped", analytics: "pending",
queue: "not_applicable" }`. `notifications` is `skipped` when no enabled
`notificationTypes` row exists for the `eventKey` (catalogue §7.7; this is how
analytics-only events come through with no notification). Claiming transitions
`dispatch[consumer]` `pending -> "in_progress"` and stamps `claimedAt`.

### 6. Atomic per-event claim, 5-minute stale lease

`claimPendingEvents` claims up to `batch` events **atomically per document**
(`findOneAndUpdate` on `{ dispatch[consumer]: "pending" }` or a stale
`in_progress`), so two concurrent consumers can never claim the same event. A
claim whose `claimedAt` is older than 5 minutes is reclaimable; a fresh claim is
not. `markDone` sets `dispatch[consumer] = "done"`; `markFailed` returns it to
`"pending"` so the at-least-once contract in §18.3 ("a crash leaves `pending`,
and the consumer retries") holds.

### 7. Dedupe via a unique partial index

An optional `dedupeKey` relies on a **unique partial index** on `domainEvents`
(registered in `INDEX_SPECS`), not an application-level "have I seen this?"
check: a duplicate insert is caught and returned as `{ deduped: true }`. The
integration spec bootstraps indexes with `ensureIndexes` before asserting the
second write collapses to one document.

### 8. Logging

An info line `domain_event.emitted` carries `eventKey`, `tenantId` and
`subjectRef` kind/id only — never the payload (conventions §5).

## Consequences

- Business code has exactly one door to record an event; consumers are
  independent and can be replayed per `dispatch.*`.
- The outbox doc is _non-strict_ relative to schema §18.3: `in_progress` and
  `claimedAt` are added to the documented `pending|done|skipped` vocabulary to
  make claims observable. See Assumptions.
- A single top-level `claimedAt` is used because v1 fan-out processes one
  consumer per event at a time; a future multi-consumer-at-once claim will need
  a per-consumer lease field.

## Alternatives considered

- **`findOneAndUpdate` upsert for dedupe** — rejected: the unique partial index
  is the documented mechanism (§18.3) and works under concurrent writers.
- **Per-consumer lease object (`claims[consumer].at`)** — more correct for
  concurrent consumers, but the OP-88 GREEN card specifies a `claimedAt` stamp
  and v1 claims one consumer at a time; deferred (see Open questions).
- **Catch-all `failed` terminal for notifications** — rejected for v1: the
  documented `dispatch.notifications` vocabulary has no `failed`, so a failed
  claim returns to `pending` and relies on bounded retries elsewhere.

## GREEN implementation addendum (t_c93c6765)

The implementation at `apps/web/src/server/domain/domain-events.ts` confirms the
contract above. Three supporting decisions were needed to satisfy it without
weakening any rule:

1. **`@/server/runtime/time` helper.** `src/server/domain/**` is lint-forbidden
   from constructing `Date`s (`no-restricted-syntax` bans `new Date(...)` /
   `Date.now()` there). Computing `expireAt` and the stale-claim cutoff from a
   `clock.now()` reading therefore goes through `addDays` / `addMilliseconds`,
   which live outside the domain tree so the guard keeps its teeth.
   `expireAt = addDays(occurredAt, settings.retention.domainEventDays)`.
2. **The outbox is read through `platformRepo`, not a tenant scope.** Consumers
   drain `domainEvents` across every tenant, so `claimPendingEvents` cannot be
   bound to one `tenantId`; the row already carries the `tenantId` the emit
   supplied. `db.collection(...)` is unavailable outside `db/**`/`repos/**`
   anyway (the `no-direct-collection-access` lint).
3. **Indexes.** The dedupe mechanism registers
   `domain_events_dedupe_unique` (unique partial on `{ dedupeKey }` where the
   key is a string) and `domain_events_expire_at_ttl` (TTL 0 on `{ expireAt }`),
   mirroring the `dispatches` pair and schema §18.3/§22.

The claim predicate remains exactly `dispatch[consumer]: "pending"` or a stale
`in_progress` — `"skipped"`, `"done"` and `"not_applicable"` are never claimed,
per §18.3's "Replayable = `{dispatch.notifications: "pending"}`".

## Spec reconciliation (t_c93c6765, Test Author)

The OP-88 GREEN implementer surfaced two defects in the RED specs that made unit
U4 and the claim integration specs mutually unsatisfiable; the Test Author
reconciled them test-side, without weakening U4 (the pinned source of truth for
`dispatch.notifications`):

1. **Integration claim specs now seed an enabled notification type.** A
   `collab.invite.accepted` event emitted with **no** `notificationTypes` row has
   `dispatch.notifications === "skipped"` (U4), and a `skipped` flag is by design
   never claimable. The integration suite emitted exactly such events and then
   claimed the `"notifications"` consumer, so it could never observe a claim. The
   fix (`seedEnabledNotificationType(test)` before each emit in the claim specs)
   makes the emitted rows `pending` — which matches production, where a
   catalogue key has a type row — instead of changing the claim predicate or U4's
   semantics.
2. **The destructured claim is guarded for `noUncheckedIndexedAccess`.**
   `tsconfig.base.json` sets `noUncheckedIndexedAccess: true`, so
   `const [claimed] = await claimPendingEvents(...)` types `claimed` as
   `DomainEventDocument | undefined` and `claimed._id` failed `tsc`. The specs
   now assert `toHaveLength(1)` and narrow with an explicit guard; the return
   type stays `readonly DomainEventDocument[]` (calling with nothing claimable
   legitimately returns `[]`).

Further additions closed the `pnpm test:coverage` gate (CI `test_coverage`;
`apps/web/src/server/domain/**` carries a 90 % line/branch threshold, and
`domain-events.ts` is the only file in that glob). They pin real boundary
behaviour, not internals: the deep payload scan **into arrays** (accept an array
of identifiers, reject one carrying a forbidden key), a structurally invalid
input → `invalid_domain_event`, a non-duplicate insert failure propagates
(instead of being reported as `{deduped: true}`), a claimed row without an
`ObjectId` `_id` is refused loudly, `claimerId` is recorded as `claimedBy`, and
completion accepts the event id as a hex **string** as well as an `ObjectId`.
