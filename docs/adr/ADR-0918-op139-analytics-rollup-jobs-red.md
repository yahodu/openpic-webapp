# ADR-0918 — OP-139 RED: the nightly analytics rollup, counter reconciliation, tenant isolation audit and DSR SLA check

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_7da4009d` (OP-139, phase 6-M2M — Jobs & Compliance, epic Background Jobs,
  `tdd_stage: RED`, dependencies OP-136 and OP-138)
- **Branch:** `OP-139-task-analytics-rollup-red`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7da4009d`
- **Number allocation:** first card of the **OP-139 lane**, which holds
  `0918`–`0937`; this record consumes `0918`, the lane's `Next free` cell reads
  `0919`, and **both** the `OP-136 jobs lane` cell and the `unallocated (future
lanes)` cursor advance to `0938` (ADR-0300 §11 item 18: the block is cut from
  the pool, so every cell that named the pool head moves past the block, not
  onto its first number). The card body carries no reserved range, so this is
  the lane's own opening draw and it is flagged in the handoff in case the
  orchestrator intended a shared range.
  The sweep was read immediately before this commit:
  - `origin/main` `ecf4eb71` carries `ADR-0900` as its highest record
    (`ADR-0901` is in flight in the OP-138 lane's worktree, inside that lane's
    `0898`–`0917` range, so it is not a candidate here);
  - `git rev-list --objects --all -- docs/adr` stops at `ADR-0901`;
  - every `.worktrees/*/docs/adr` tree stops at `ADR-0901`;
  - the open PR heads stop at `0900`/`0891`/`0881`/`0306` (#778, #755, #743,
    #272), and no `ADR-0918` path exists on any of them;
  - both `Next free` cells read `0918` on `ecf4eb71`.

  No cell is lowered and no range is re-cut.

- **Pins:** contract §10.2 (the four cron rows, their schedules, default limits
  and emissions), §4.5 with schema §20.1 (`analyticsDaily` is the read model's
  only source), §8.1 with schema §20.3 (`slaDueAt` "drives
  `admin.dsr.sla_risk`"), §0.15 (no document payload leaves the boundary) and
  §7.6 (both event keys and their digests).
- **Consumes:** ADR-0642 (the analytics read model that makes `analyticsDaily`
  the sole dashboard source), [ADR-0898](ADR-0898-op138-data-subject-requests-red.md)
  and [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) (the DSR row and
  its `slaDueAt`), ADR-0028 (the bounded cron framework and its `Clock` rule) and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11–§13
  (allocation).
- **Consumers:** `apps/web/src/test/unit/analytics-rollup-buckets.test.ts`,
  `apps/web/src/test/unit/counter-reconcile-drift.test.ts`,
  `apps/web/src/test/integration/analytics-rollup.test.ts`,
  `apps/web/src/test/integration/counter-reconcile.test.ts`,
  `apps/web/src/test/integration/dsr-sla-check.test.ts` and
  `apps/web/src/test/integration/tenant-isolation-audit.test.ts` — each spec's
  header cites this record. No production module cites it: the modules it
  measures do not exist yet, and their record will be the GREEN's.

## 1. Context

Contract §10.2 lists four crons this lane owns as one table row each:
`analytics-rollup` (daily 02:00 IST, "Roll `domainEvents` + counts into
`analyticsDaily`", default limit _all_), `counter-reconcile` (daily 02:30 IST,
"Recompute `tenants.counters`, `events.counters`,
`attendeeEventProfiles.matchCount` from source; log deltas", 200 tenants,
`admin.abuse.flagged` on large drift), `tenant-isolation-audit` (nightly,
"Documents whose `tenantId` doesn't resolve to a live tenant, or disagrees with
the parent event's `tenantId`", _all_, `admin.abuse.flagged`) and `dsr-sla-check`
(daily, "Open DSRs within 48 h of `slaDueAt`", 500, `admin.dsr.sla_risk`).

The card delivered only a test list (`U1`, `U2`, `I1`–`I6`), so this record fixes
every contract detail the specs pin: the two pure functions, the four module
paths and their job names, the `?date=` rerun seam, the `analyticsDaily` write
shape, the reconciliation's source map and threshold location, the two
`admin.abuse.flagged` payloads, the DSR warning payload and its once-per-day
rule, and the 48-hour boundary. The GREEN card `t_c414a059` carries the same
scope prose and is the implementation's brief.

Two upstream lanes are already landed and are consumed rather than re-decided:
`analyticsDaily` and its read model (OP-119, ADR-0642 — the tenant analytics
endpoint reads **only** the rollups, so the rollup is that collection's sole
writer), and `dataSubjectRequests` with its `slaDueAt` (OP-138, ADR-0898/0899).
`admin.abuse.flagged` and `admin.dsr.sla_risk` already exist in the §7.6
catalogue (`notification-types.values.ts:937` and `:977`, both digest-throttled),
so no event key is invented here.

## 2. Decision — the pure rules

`@/server/jobs/analytics-rollup` exports two pure functions, both taking the zone
as an argument (a closure over `"Asia/Kolkata"` would pass the IST table and fail
the `UTC` arm):

```ts
export function dateKeyInTimeZone(instant: Date, timeZone: string): string;
export function dayWindowUtc(dateKey: string, timeZone: string): { start: Date; end: Date };
```

`dateKeyInTimeZone` answers the `YYYY-MM-DD` calendar day an instant falls in;
`dayWindowUtc` answers the half-open `[IST midnight, next IST midnight)` window
as UTC instants, so the source collections can be range-filtered and a row at
exactly `end` belongs to the next day only. IST is a fixed `+05:30` with no DST,
so the whole contract is one offset — but the parameter is what makes the rule
testable.

`@/server/jobs/counter-reconcile` exports the threshold decision (U2):

```ts
export function isDriftSignificant(
  drift: { readonly cached: number; readonly actual: number },
  thresholdPercent: number
): boolean;
```

Drift is **relative to the recomputed value** — `|cached - actual| / actual * 100`
— because the question is "how wrong is the cache" and the source is the truth.
`actual === 0` answers `0` when `cached === 0` and `100` otherwise (never a
division by zero, never `Infinity`). The comparison is **strictly above** the
threshold, matching the contract's "drift above a settings threshold", so drift
exactly at the configured value is corrected but not escalated.

## 3. Decision — the four jobs and the route

- **`@/server/jobs/analytics-rollup`** exports `analyticsRollupJob: CronJob`
  (`defineCronJob({ name: "analytics-rollup", … })`); **`counter-reconcile`**,
  **`tenant-isolation-audit`** and **`dsr-sla-check`** follow the same shape with
  their own names. The `cron.<name>.completed` summary line is the framework's
  (ADR-0028), so no job logs its own summary.
- **`apps/web/src/app/api/v1/internal/cron/analytics-rollup/route.ts`** exports
  `POST`, guarded by the shared internal HMAC stage (`internalRouteAuth`) and
  serialized through the §10.2 `cronResultSchema` envelope, like every sibling
  cron route (`_lib/run-cron-route.ts` is the precedent).
- **The rollup run options gain a `date`.** `CronRunOptions.date?: string | null`
  is forwarded to `CronJobContext.date?: string | null`, so an operator can
  re-run any day with `?date=YYYY-MM-DD` (the GREEN card's "re-runnable for any
  date"). This is the one framework-shape change the lane asks for; the specs
  type their run options as
  `Parameters<typeof analyticsRollupJob.run>[0] & { readonly date?: string }`,
  so they compile before the widening and keep compiling after it, and the RED
  branch ships **no** production edit.
- **An invalid `?date=` is `422 validation_failed`** and writes nothing — the
  §2.2 code the catalogue already carries at that status, decided before any
  document is touched.
- **Absent a `?date=`, the run rolls up the IST day that just closed**
  (`dateKeyInTimeZone(clock.now(), "Asia/Kolkata")` minus one day). A 02:00 IST
  run must not roll up the two hours of the day it is standing in; otherwise
  "yesterday" is permanently empty. This is assumption A5 and the reason the
  default is not "today".

## 4. Decision — what the rollup writes

One `analyticsDaily` document per `{ scope, dateKey }`, upserted on
`{ "scope.kind", "scope.id", dateKey }` (the schema §20.1 unique index), for
`scope.kind` `tenant`, `event` and `platform`, with `scope.id: null` on the
platform row. The `metrics` block is the **twelve** §20.1 counters written in
full on every row — a closed set, so a metric the read model's `toCount` expects
is never absent and never `null`, and an extra key is a failure.

- `computedAt` comes from the injected `Clock`, never the wall clock, so two runs
  for the same day are byte-identical documents (I1 compares the canonical JSON
  of every row, `_id` included, and asserts no duplicated scope/day pair).
- `eventsCreated` is the day's `event.created` count from `domainEvents`
  (`occurredAt` in the window); the collection counts read `event_images`
  (`imagesUploaded` all, `imagesProcessed` / `imagesFailed` by
  `processing.status`), `selfies` (`selfiesUploaded`), `face_matches`
  (`matchesCreated`) and `notification_dispatches` in the `sent` state
  (`notificationsSent`), each filtered by its own day field.
- `uniqueAttendees`, `storageBytesAdded`, `downloads`, `revenueMinor` and
  `p95ProcessingMs` are pinned by **presence and integrality only** (A16): their
  lineage (a distinct-subject count, a byte total across `media_assets`, a
  percentile over processing durations, a per-transaction sum) is not stated by
  the card, and pinning a value would invent a contract the GREEN would have to
  guess. This record names them as the lane's deliberate residual.
- A `tenant` row exists for a tenant with activity; an `event` row for an event with
  activity. The platform row is the sum of the tenants' rows (I7), not one
  tenant's figures.

## 5. Decision — reconciliation, audit and the SLA check

- **`counter-reconcile`** recomputes from source, never from another cached
  counter: `tenants.counters.eventCount` ← the tenant's `events` rows,
  `activeEventCount` ← those with `status: "published"`, `imageCount` ← its
  `event_images` rows, `attendeeCount` ← its `attendee_event_profiles` rows;
  `events.counters.imageCount` / `processedImageCount` / `failedImageCount` ←
  that event's `event_images` rows by status; `attendee_event_profiles.matchCount`
  ← that profile's `face_matches` rows. A drifted field is corrected in place and
  logged as one `counter.reconcile.corrected` line carrying
  `{ collection, field, cached, actual }`; an agreeing field logs nothing.
  `counters.reconciledAt` is stamped from the injected `Clock` (an RFC 3339 `Z`
  string, the field's stored type) on **every** run that examines the tenant,
  including one that finds no drift — that is what "reconciled" means.
  `storageBytes` is **not** pinned (A8): its byte lineage is not stated.
- **The drift threshold** lives at `platformSettings.jobs.counterReconcile.
driftThresholdPercent`, defaulting to `5` (A9): the shipped singleton has no
  `jobs` section, so the GREEN adds the section with a schema default and a
  singleton seeded before the key still parses. A drift strictly above it
  additionally emits **one** `admin.abuse.flagged` under the tenant the drift
  belongs to, with `{ reason: "counter_drift", collection, field, cached, actual }`;
  at or below it the correction is silent, because the admin channel is
  digest-throttled (§7.6) and a routine round must not become an alert stream.
- **Tenant drain.** One invocation examines up to its clamped `limit` tenants
  (the contract's 200) and reports `hasMore` while a tenant examined earlier is
  still unreconciled; `scanned` is the number of tenants examined. The drain
  order is not pinned (A18) — any fair order passes — only that a two-tenant
  budget over three tenants stamps two and the next run reaches the third.
- **`tenant-isolation-audit`** sweeps every collection in
  `TENANT_SCOPED_COLLECTIONS` (imported, never re-listed, so a collection that
  joins the registry is audited without a second edit) and raises at most one
  `admin.abuse.flagged` per `(reason, collection)` per Asia/Kolkata day:
  - `unresolved_tenant` — the document's `tenantId` does not resolve to a
    `tenants` `_id`. The stored field is a hex **string** on tenant-scoped rows
    while the tenant's `_id` is an `ObjectId`, so the comparison is on the hex
    form.
  - `tenant_mismatch` — the document's `tenantId` disagrees with its parent
    event's `tenantId`; `event_images` is the shipped case.
    The payload's key set is exactly `collection`, `count`, `reason`: counts only,
    no ids and no document contents (§0.15). The two reasons are exclusive (A11),
    and a document whose parent event is gone is not flagged (A12).
    `scanned` counts the documents examined, so the "not flagged" case proves the
    sweep looked rather than reporting silence without work (A19).
- **`dsr-sla-check`** warns about requests whose `status` is neither `completed`
  nor `rejected` and whose `slaDueAt` is at or before `now + 48 h` (inclusive,
  A15). Each at-risk request emits one `admin.dsr.sla_risk` per Asia/Kolkata day
  under the first tenant in `scope.tenantIds` (a request that resolved no tenant
  has no tenant to announce it under, matching ADR-0898 §6), with exactly
  `{ requestId, requestType, slaDueAt }`. The dedupe key therefore carries both
  the request id and the day key: a same-day rerun is silent and the next day
  warns again while the request is still at risk.

## 6. Evidence — the RED state

Probe stubs (a UTC-bucketing pure module, a no-threshold drift decision, a
near-complete DSR check **with the dedupe removed**, an empty audit, and a `500`
route) were written at the intended paths, measured, and **deleted**; they are
never committed.

- With the stubs, `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0`, so no
  case fails at type or import level.
- Unit, with the stubs: `Tests 9 failed | 14 passed (23)`. The failures are the
  IST-discriminating arms (`expected '2026-11-17' to be '2026-11-18'`,
  `expected '2026-11-17T00:00:00.000Z' to be '2026-11-17T18:30:00.000Z'`) and the
  tolerance arms (`expected true to be false`); the passes are the by-construction
  ones — the three rows where UTC and IST agree, and the rows where "any
  difference is significant" happens to answer `true`.
- Integration, with the stubs: `analytics-rollup` **8 failed (8)** (every case
  reaches its own assertion: `expected undefined to be defined`,
  `expected 500 to be 401`), `counter-reconcile` **5 failed (5)**, then **6
  failed (6)** after the drain case was added, `tenant-isolation-audit` **4
  failed (4)** after the scan-count control was added.
- `dsr-sla-check`, with the near-fix stub: `Tests 1 failed | 3 passed (4)` —
  **the dedupe arm alone**, `expected [ { …(9) }, { …(9) } ] to have a length of
1 but got 2`. That is the point of the near-fix: the window and status arms
  pass on a job that is otherwise correct, so the only failing case is the
  behaviour the lane is about, and the pin is proven load-bearing rather than
  merely unsatisfied by a missing module.
- On the delivered branch (stubs removed) every case fails at
  `Failed to resolve import "@/server/jobs/…"` — the honest RED a GREEN starts
  from, with the assertion-level evidence above as the proof that the specs
  measure behaviour and not the import.

## 7. Consequences and known limits

- **`vercel.json` schedules are not pinned.** The four schedules live in
  deployment config (contract §10.2's table), and a spec asserting cron strings
  would pin a vendor format rather than behaviour. What the suite does pin is the
  _anchor_: I9 requires a 02:00-IST run to roll up the previous IST day.
- **The five unlineaged metrics** are presence-only (§4). The GREEN may compute
  them from any source it can defend; this lane cannot tell it which.
- **`storageBytes`** is corrected by no case in this pack (A8), so a GREEN that
  leaves it stale passes. Recorded rather than forgotten.
- **No e2e.** The card lists `e2e_api_playwright: []`, and the four jobs are
  internal crons whose `POST` handlers are exercised directly in the integration
  project — the same treatment every sibling cron lane received.
- **The wrong-bearer refusal is not re-pinned here**: `internal-hmac.test.ts`
  owns it (`I2: a wrong bearer is 401 internal_auth_failed`), and this lane pins
  only that _this_ route declares the guard (no credential → 401) and that the
  valid credential reaches the job.
- **Framework shape.** The `date` option is the lane's one framework change; it
  is optional and absent by default, so no existing job's behaviour moves.

## 8. Alternatives

1. **Widen `CronRunOptions` on the RED branch so the specs type-check without a
   local intersection.** Rejected: the card says tests only, and a production
   interface edit in a RED diff is exactly what the TDD gate exists to prevent.
   The intersection type keeps the compile clean in both states with no cast.
2. **Give each job its own `?date=`-free design and re-run by seeding dates.**
   Rejected: the GREEN card names `?date=` as the operator affordance, and an
   operator cannot seed a fixture.
3. **Pin the five unlineaged metrics to plausible sources.** Rejected: an
   invented mapping (`revenueMinor` = every `billing_transactions` amount,
   `p95ProcessingMs` = a percentile over one of three duration fields) would
   red a correct implementation or green a wrong one. Presence and integrality
   are what the contract actually owes §4.5.
4. **Put the dedupe for the DSR warning in the spec's own storage.** Rejected:
   the warning must survive a redeploy, and the outbox is the only durable,
   already-available place a same-day rerun can see.
5. **Assert the audit's log line.** Rejected: the card's requirement is "logs
   collection names and counts only", which the payload's key set already
   measures at the boundary the notification fan-out reads; an invented
   `tenant.isolation.finding` event name would be a contract the docs do not
   carry.
