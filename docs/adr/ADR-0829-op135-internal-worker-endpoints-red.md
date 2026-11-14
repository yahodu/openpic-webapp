# ADR-0829 — OP-135 internal worker endpoints: the executable contract (RED)

- **Status:** Accepted · **Date:** 2026-11-14
- **Card:** OP-135 `t_ca95e452` (phase 6-M2M / Jobs & Compliance, epic Worker
  Interface, `tdd_stage: RED`) · **GREEN successor:** `t_4a280d94`
- **Implements:** contract §0.3 (`internal` label), §7.6/§7.7 (event catalogue
  and outbox), §10.3.1 (the worker's claim and lease), §10.3.2 (the four
  endpoints), §10.3.3 (the worker's error taxonomy), §6.4 (the poll the result
  must appear on); schema §16.1 (`mediaAssets.derivatives`), §18.2
  (`processing`), §20.4 (`platformSettings`)
- **Depends on:** OP-87 (internal HMAC + cron framework, ADR-0028), OP-88
  (`emitDomainEvent`, ADR-0029), OP-122 (work queue), OP-132 (ADR-0806/ADR-0808:
  the one delivery identity of an activation result)
- **Amends:** nothing. Pins the contract the OP-135 GREEN must satisfy.
- **Number allocation:** this is the OP-135 lane's first record, and the ticket
  had no reserved range on `main`. It draws the next 20-number block from the
  allocator's `unallocated (future lanes)` pool — **`0829`–`0848`** — consuming
  `0829` here, advancing the lane's `Next free` to `0830` and the pool to
  `0849`+ (ADR-0300 §7: a dependent ticket does not continue its parent's
  range). §7 below records the cell arithmetic.

## Context

The Python worker is a separate process that performs the claim, the face
writes and the `$vectorSearch` itself (§10.3.1), and it must **never** embed a
notification client (notification design §1, goal 5). Every fact it produces
therefore crosses one of four HTTP routes, and nothing in `apps/web` shipped
them: `apps/web/src/app/api/v1/internal/` held only `cron/`, so the outbox had
exactly one publisher (the client-initiated confirmation) and a worker result
that landed _after_ the confirmation was neither announced nor visible
(ADR-0808 §1, ADR-0806).

That gap is the whole reason this lane exists, and it makes the four routes the
complete write surface of the pipeline: the outbox writer, the profile
projection, the work-item lifecycle and the derivative slot all become
reachable through an HMAC-signed `POST`. A contract that is only described in
prose is not a contract a worker can be written against, so this record fixes
one — module paths, function signatures, wire shapes and status codes — and
`apps/web/src/test/unit/worker-report-outcome.test.ts`,
`apps/web/src/test/unit/worker-heartbeat-response.test.ts` and
`apps/web/src/test/integration/internal-worker-endpoints.test.ts` are its
executable form.

## Decision

### 1. Two pure modules, so the two mappings are testable without a database

**`@/server/internal/worker-report`**

```ts
type OutcomeStatus = "queued" | "done" | "failed" | "skipped";

interface ReportItemError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface StoredPipelineError {
  readonly code: string;
  readonly message: string;
  readonly at: Date;
  readonly retryable: boolean;
}

interface ReportItemOutcomeInput {
  readonly kind: "event_image" | "selfie";
  readonly outcome: "done" | "failed" | "skipped";
  readonly faceCount?: number;
  readonly error?: ReportItemError;
  /** `processing.attempts` as the stored row carries it. */
  readonly attempts: number;
  /** `platformSettings.pipeline.maxAttempts`. */
  readonly maxAttempts: number;
  /** Injected, so `finishedAt` / `lastError.at` are exact (ADR-0007). */
  readonly now: Date;
}

interface ReportOutcomeDecision {
  readonly status: OutcomeStatus;
  readonly retry: boolean;
  readonly finishedAt: Date | null;
  readonly lastError: StoredPipelineError | null;
}

reduceReportItem(input: ReportItemOutcomeInput): ReportOutcomeDecision;
```

The reducer is the one place a worker's verdict becomes `processing` state, and
it encodes three rules the contract states but nothing enforced:

- `done` is terminal and **`faceCount: 0` is still `done`** — §10.3.3 lists
  `no_faces_detected` as `outcome: "done"` with `faceCount: 0`, so a reducer
  that reacts to the count fails a photograph of an empty room.
- a **retryable** failure returns the item to `queued` while `attempts <
maxAttempts` and lands on `failed` at the budget (§18.2's retry accounting);
  a **non-retryable** failure is `failed` immediately, whatever the budget —
  §10.3.2's "`retryable: false` jumps straight to `failed` regardless of
  remaining `attempts`".
- `liveness_failed` is terminal **even when the worker marks it retryable**
  (U3): re-running inference cannot improve a liveness verdict, and a retry
  would spend the attendee's own attempt budget (§6.3, §14.1). The code is kept
  verbatim in `lastError.code` because §6.4 renders the `liveness_failed` detail
  from exactly that field (`status-detail.ts`).

**`@/server/internal/worker-heartbeat`**

```ts
interface HeartbeatConfig {
  readonly activeSpaceKey: string;
  readonly leaseMinutes: number;
  readonly maxAttempts: number;
  readonly pauseRequested: boolean;
}

interface HeartbeatResponse extends HeartbeatConfig {
  readonly acknowledged: true;
}

buildHeartbeatResponse(config: HeartbeatConfig): HeartbeatResponse;
```

§10.3.2 calls the answer the worker's **configuration channel** — the face space,
the lease length, the attempt ceiling and the operator's pause switch reach the
worker without a redeploy — so the body is a five-key contract and every value
is a read of `platformSettings` (§20.4). Splitting the shaping from the read
means U2 pins the channel with no database, and a builder that hard-codes a
value is caught (`expected 10 to be 7`).

### 2. `POST /api/v1/internal/domain-events`

Body is §10.3.2's: `{ events: [{ eventKey, tenantId, actorRef, subjectRef,
payload, occurredAt, dedupeKey? }] }`. Answer `202` with exactly
`{ accepted, deduped, rejected }`, where `accepted + deduped + rejected.length
=== events.length` and each rejected item is
`{ index, eventKey, reason }`.

- An unknown `eventKey` is rejected with `reason: "unknown_event_key"` and **the
  rest of the batch still succeeds** (§10.3.2: "A bad key never fails the
  batch"), which is I1.
- `dedupeKey` is honoured through `emitDomainEvent`: a repeat of the same key
  answers `accepted: 0, deduped: 1` (the request is still a `202`; the _item_ is
  deduped).
- The activation identity `attendee.matches.new:<eventId>:<profileId>:<selfieId>`
  (ADR-0808 §3) is the same identity the confirmation mints, so a batch carrying
  it **after** a confirmation is deduped and leaves the confirmation's row as
  the only delivery — the reverse of the pipeline-first order `t_ef9d6371`
  pinned, and the arm ADR-0808 §3 requires.
- A **later arrival** for an already-announced selfie is a _different_ delivery:
  a key carrying a run discriminator inserts a second row. The shape of the
  discriminator is OP-136's to choose (ADR-0808 §3); what this record pins is
  that the endpoint must not collapse the two, i.e. it must not replace the
  caller's `dedupeKey` with a `selfieId`-only identity.

### 3. `POST /api/v1/internal/worker/heartbeat`

Body: §10.3.2's documented object (`workerId`, `version`, `modelKeys`,
`inFlight`, `capacity`, `throughputPerMin`, `queueDepthObserved`, `gpu`).
Answer `200` with exactly `{ acknowledged, activeSpaceKey, leaseMinutes,
maxAttempts, pauseRequested }`.

**`pauseRequested` needs a settings field that does not exist yet.**
`platformSettings.pipeline` carries `leaseMinutes`, `maxAttempts`,
`sweepIntervalSeconds`, `backlogWarnDepth`, `backlogWarnAgeMinutes` (§20.4) and
nothing else, so the GREEN adds `pipeline.pauseRequested: boolean` (default
`false`) to `platformSettingsSchema` and to `PLATFORM_SETTINGS_DEFAULTS`. The
GREEN card's §2 says the value is "from settings" and explicitly flags the
schema addition ("schema addition, confirm"); this record confirms it, as a
non-breaking defaulted field — an existing singleton that lacks it still
parses, which is why the default matters.

The heartbeat also records a `workerHeartbeats` row (GREEN card §2: "reuse a
small `workerHeartbeats` collection with TTL"). **No pin is placed on that
collection here**: §10.3.2 makes the _response_ the contract and
`/admin/pipeline/health` is the reader, so the row's shape is implementation
detail. Naming it in the GREEN card and not pinning it is deliberate — see §6.

### 4. `POST /api/v1/internal/worker/report`

Body: §10.3.2's `items` array plus a **top-level `workerId`**. §10.3.2's sample
shows only `{ items }`, but §10.3.1's lease is held by one worker
(`processing.workerId`) and the GREEN card's §3 requires "a lease check
(workerId + processing status)". A per-item owner would let one request carry
two workers' work, and the heartbeat already carries `workerId` at the top
level, so the report mirrors it.

Answer `200` with exactly `{ applied, leaseLost, rejected }`; each rejected item
is `{ index, id, reason }`.

- **Lease.** The reporter is the leaseholder when the stored
  `processing.workerId` equals the body's `workerId` and `processing.status` is
  a live state. Otherwise the item is `leaseLost` and **nothing is written** —
  the row is byte-identical, because "writing results after losing a lease is
  how duplicate faces appear" (§10.3.1). I2 pins the deep-equal.
- **Selfie outcome on the active selfie (§6.4).** A confirmation that runs
  before the worker leaves the profile `processing` and publishes nothing
  (ADR-0808 §1), so the report is the only writer that can make a late result
  visible: `status: "ready"`, `matchCount = matchesCreated`, and
  `lastMatchRunAt = matchRunStartedAt` — the run's **own** start instant, never
  the report instant, or faces created during the query fall into a gap
  (§10.3.3's watermark rule).
- **Liveness failure (I6).** `processing.status: "failed"`, `processing.lastError
= { code: "liveness_failed", … }`, the profile `failed`, **no embedding
  written**, and the attempt spent. "Spends an attempt" is read as §6.4's
  budget: an attempt _is_ a stored `selfies` row (`selfie-attempts.ts`,
  ADR-0792), so the observable is `selfie.attemptsUsed: 1` /
  `attemptsRemaining: allowed - 1` after the report — the failure neither
  refunds the attempt nor creates a second row.
- **Withdrawn profile (I8).** A withdrawal deletes the profile's selfie rows,
  their matches and their embeddings (ADR-0798), so a report that lands
  afterwards must not re-create what it deleted. The item is discarded:
  `applied: 0`, `rejected: [{ index, id, reason: "profile_withdrawn" }]`, and
  the profile, the selfie row and the outbox are all untouched. The I8 case
  builds the **race window** deliberately — the profile is already `withdrawn`
  while the claimed selfie row still exists — because that is the moment the
  guard has to hold.

**Consequence the GREEN must implement, not just the endpoints.** `GET
/p/events/{slug}/me` calls `resolveStatus({ status, matchCount, rejectionReason
})` and never passes `lastErrorCode`, so a `liveness_failed` pipeline failure
renders as the generic `processing_failed` today. The I6 pin asserts
`statusDetail.code === "liveness_failed"`, which requires the poll to forward
the active selfie's `processing.lastError.code` into `resolveStatus` — a
one-line wiring of an input `status-detail.ts` already models and already tests
(`attendee-status-detail.test.ts`), not a new rule.

### 5. `POST /api/v1/internal/media/derivative-complete`

Body is §10.3.2's, with **`objectKeyRef` required**: an opaque handle, never an
object key ("the handle → key resolution (no raw keys over the wire)", GREEN card
§4; §0.15). A body carrying `objectKey` and no `objectKeyRef` answers
`422 validation_failed` and writes nothing.

Answer `200`. The persisted effect is the contract:

- `mediaAssets.derivatives.<derivative>` (§16.1's **map**, not a slot) carries
  `bytes`, `width`, `height`, `format`, `processorVersion`, `watermarkVersion`,
  a `generatedAt` instant and a resolved `objectKey`;
- `status` advances to `derivatives_ready`;
- the original `storage` descriptor is untouched;
- `preview` is a second key — reporting it does not disturb `thumbnail`;
- **the answer carries no object key**: the pin reads the stored key and asserts
  the response body does not contain it. The reverse direction (the request
  carries no key) is the `422` above.

The resolution mechanism itself is deliberately not pinned: the repo's
`createHandleService` is bound to a _presenting user_ (ADR-0520 §5) and a worker
has none, so the GREEN may derive the key from the asset's content hash or mint
its own handle. Any mechanism satisfies the pins as long as a key and a handle
are different strings and only the handle crosses the wire.

### 6. What is deliberately **not** pinned

- `maxAttempts`'s 100-event batch cap: §10.3.2 states it, the card's test list
  omits it, and pinning it forces a status choice (`413` from a handler check vs
  `422` from `z.array().max(100)`) that the contract does not make. Left to the
  GREEN; recorded here so the omission is auditable.
- The `workerHeartbeats` row (above), the `events.counters` update (GREEN §3's
  "update event counters" — the authority on counters is OP-136's
  `counter-reconcile`), and whether a report for a **superseded** (non-active)
  selfie updates the profile. All three are behaviour the GREEN should get
  right; none is a contract this record can fix without inventing one.
- `vercel.json` scheduling: these routes are called by the worker, not by
  Vercel Cron.

### 7. Ledger arithmetic

The reserved-range table's `unallocated (future lanes)` row read
`` `0799`+ (20 per lane, in order) `` / `Next free 0829` on this base, and the
newest record on `main` was `0828`. This lane takes `0829`–`0848`, so it adds
its own row at `Next free 0830` and advances the pool to `0849`+.

**Observation, not an edit:** the `OP-129 attendee identity lane` row's
`Next free` cell also reads `0829` on this head, which cannot be right — that
lane's range is `0780`–`0798`, so no legitimate value of its cell can exceed
`0798`. The cell is left untouched (it is not this lane's range) and is flagged
in the handoff so the orchestrator can route the repair; if OP-129 later draws
`0829` on the strength of that cell, two records will collide.

## Evidence

The three specs were executed at this head. Their RED is the honest
new-module failure (OP-93/ADR-0306 posture): `Cannot find package
'@/server/internal/worker-report'` (and the three route modules) — no assertion
runs until the module exists.

To prove the pins are **satisfiable** and **discriminating**, two throwaway
stubs were written at the intended paths and deleted again (`git status` shows
the three test files only):

- **Satisfiability.** With faithful stubs at the six intended paths,
  `tsc -p apps/web/tsconfig.json --noEmit` exits `0`, the unit specs are **12
  passed**, and the integration spec fails **30/30 at assertion level**
  (`expected 500 to be 401`, `expected 500 to be 202`, `expected 500 to be 200`,
  `expected 500 to be 422`) — the `500` being the route-stub answer, so every
  case drove its fixture successfully and died on the contract.
- **Discrimination (mutation probe).** Against the faithful reducer, three
  one-anchor mutations each redden exactly one pin:
  `M1` (a liveness failure retried like any retryable failure) →
  `U3: treats a liveness failure as terminal…`,
  `AssertionError: expected 'queued' to be 'failed'`;
  `M2` (the attempt budget ignored) → `U1: fails a retryable failure once the
attempt budget is spent`, same assertion;
  `M3` (a skipped item recorded as a failure) → `U1: marks a skipped item
skipped…`, `expected { Object (status, retry, ...) } to deeply equal
{ status: 'skipped', …(3) }`.
  Against the faithful builder: `M4` (`pauseRequested` hard-coded `false`) →
  `U2: reports a pause…`, `expected false to be true`; `M5` (`leaseMinutes`
  hard-coded `10`) → `U2: carries the configured face space, lease length and
attempt ceiling verbatim`, `expected 10 to be 7`. Both production files were
  restored byte-identically (`sha256` verified).
- **Baseline.** Unit **179 files / 2965 passed, 3 skipped**; integration
  **131 files / 1356 tests with 1 pre-existing failure**
  (`notification-quiet-hours-release.test.ts` › _I12: each deferred row is
  released once and a second run re-sends nothing_), unrelated to this lane and
  present before these files existed.

## Consequences

- The pipeline has a transport for every fact it produces: the outbox
  (`/internal/domain-events`), the work-item lifecycle and the profile
  projection (`/internal/worker/report`), the configuration channel
  (`/internal/worker/heartbeat`) and the derivative slot
  (`/internal/media/derivative-complete`). With them, ADR-0808 §1's "neither
  endpoint ships at this head" stops being true and a late match is announceable
  _and_ visible.
- One delivery identity now has three minters — the confirmation's route
  literal, the OP-132 spec helper and this endpoint. The reviewer of PR #560
  recommended one exported `matchesNewDedupeKey()` in
  `@/server/domain/domain-events.ts` as the single-source fix; that refactor
  belongs to the GREEN card `t_4a280d94`, not here, so this record only notes
  the third call site.
- `pauseRequested` becomes the first `pipeline` setting that is not a scalar
  threshold, so the admin settings validation (`checkSettingBound`) does not
  apply to it — a boolean has no range. The GREEN must not bend the bounds table
  to cover it.
- These four routes are now the only place a machine caller can write
  `domain_events`, so the alarm surface is clear: a `leaseLost` counter that
  climbs, or a `rejected` entry naming `profile_withdrawn`, is a live signal
  (§"security_and_logging_requirements": warn `worker.lease_lost`, error for
  invalid reports).

## Alternatives considered

- **Publish from inside the confirmation only** (ADR-0808 alternative (c)).
  Rejected there and unchanged here: it leaves §7.6's "additional matches later"
  with no producer and makes the worker's own result unannounceable.
- **Let the worker write `domainEvents` directly** (§10.3.2 allows it). Rejected
  for the publisher path: the direct write cannot honour the catalogue gate, the
  forbidden-payload scan or the analytics-only key set without duplicating
  `emitDomainEvent` in Python, and the HTTP path is what keeps the worker's write
  surface to one collection.
- **A per-item `workerId` in the report.** Rejected: a lease belongs to one
  worker process, and a batch carrying two owners would make `leaseLost` depend
  on the item rather than the request.
- **A shared handle service for `objectKeyRef`.** Rejected as a _pin_: the
  existing service is bound to a presenting user and a per-instance registry, so
  requiring it would make the contract untestable from a worker context (see §5).
- **Pinning the `workerHeartbeats` row.** Rejected: §10.3.2 makes the response
  the contract and `/admin/pipeline/health` the reader; pinning the row would
  fix a shape the story does not state.

## Open items handed to the GREEN (`t_4a280d94`)

1. Add `pipeline.pauseRequested` to `platformSettingsSchema` +
   `PLATFORM_SETTINGS_DEFAULTS` (§3).
2. Forward the active selfie's `processing.lastError.code` into the `/me`
   route's `resolveStatus` call so the I6 detail renders (§4).
3. Create the six modules/routes at the paths in §1–§5; the specs import
   `@/server/internal/worker-report`, `@/server/internal/worker-heartbeat`,
   `@/app/api/v1/internal/domain-events/route`,
   `@/app/api/v1/internal/worker/heartbeat/route`,
   `@/app/api/v1/internal/worker/report/route` and
   `@/app/api/v1/internal/media/derivative-complete/route`.
4. Base the GREEN's branch on this RED branch (`t_ca95e452`'s), not bare
   `origin/main`, or the specs will not be present to turn green.
