# ADR-0830 — OP-135 GREEN: the four internal worker routes and the two mappers they rest on

- **Status:** Accepted · **Date:** 2026-11-14
- **Card:** OP-135 `t_4a280d94` (phase 6-M2M / Jobs & Compliance, epic Worker
  Interface, `tdd_stage: GREEN`) · **RED parent:** `t_ca95e452`
  ([ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md))
- **Implements:** contract §0.3, §6.2, §6.4, §7.6/§7.7, §10.3.1–§10.3.3, §9.10;
  schema §15.3, §16.1, §18.2, §20.4
- **Consumes:** [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (internal HMAC),
  [ADR-0029](ADR-0029-domain-events-outbox.md) (`emitDomainEvent`),
  [ADR-0806](ADR-0806-op132-confirm-publication-green.md)/[ADR-0808](ADR-0808-op132-late-match-publication-ownership.md)
  (the one delivery identity), [ADR-0792](ADR-0792-op132-liveness-selfie-green.md)
  (the attempt budget), ADR-0798 (withdrawal deletes the rows)
- **Amends:** [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) §1's
  denial precedence, minimally (see §8.1). Records the GREEN's decisions on the
  arms ADR-0829 left open, and the one test-side defect it found (see §8.2).
- **Number allocation:** the lane row `OP-135 worker interface lane` reads
  `0829`–`0848` / `Next free 0830` on this head; this record takes `0830` and
  advances that cell to `0831`. The `unallocated (future lanes)` cell stays
  `0849`. No sweep was needed: the cell is the lane's own reservation and no
  open PR carries `0830`.

## Context

ADR-0829 fixed the executable contract — two pure modules and four `POST`
routes — and left the RED specs as its only expression. This record covers
turning them green: what shipped at each path, the decisions the pins did not
make, the one auth-precedence rule the pins forced (§8.1) and the one pin that
**cannot** be made green without editing a test (§8.2).

## Decision

### 1. The six modules

| Path                                                                  | Contract                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/internal/worker-report.ts`                       | `reduceReportItem({kind, outcome, faceCount?, error?, attempts, maxAttempts, now})` → `{status, retry, finishedAt, lastError}`  |
| `apps/web/src/server/internal/worker-heartbeat.ts`                    | `buildHeartbeatResponse({activeSpaceKey, leaseMinutes, maxAttempts, pauseRequested})` → the same four plus `acknowledged: true` |
| `apps/web/src/app/api/v1/internal/domain-events/route.ts`             | `202 {accepted, deduped, rejected}`                                                                                             |
| `apps/web/src/app/api/v1/internal/worker/heartbeat/route.ts`          | `200` five-key configuration channel                                                                                            |
| `apps/web/src/app/api/v1/internal/worker/report/route.ts`             | `200 {applied, leaseLost, rejected}`                                                                                            |
| `apps/web/src/app/api/v1/internal/media/derivative-complete/route.ts` | `200`, writes `derivatives.<variant>`                                                                                           |

All four routes are `defineRoute` declarations behind `internalAuthStage`, with
the secrets read through a thunk for the same reason the cron routes do it
(`getConfig()` validates the environment, which `next build` runs without). No
route accepts the `CRON_SECRET` bearer: only the cron prefix's exception is
honoured, which is what makes the I5 ladder hold.

### 2. `pipeline.pauseRequested` (schema §20.4)

Added as `z.boolean().default(false)` and to `PLATFORM_SETTINGS_DEFAULTS`
(ADR-0829 §3). The default is the point: a singleton seeded before the field
existed still parses, so the operator's pause switch is the **first** `pipeline`
setting that is not a scalar threshold — `checkSettingBound` does not apply and
its bounds table was not widened.

### 3. `workerHeartbeats` (GREEN card §2, ADR-0829 §3)

`COLLECTIONS.workerHeartbeats` (`"workerHeartbeats"`, platform scope: a worker
serves every tenant) plus one TTL index, `worker_heartbeats_expire_at_ttl` on
`expireAt` with `expireAfterSeconds: 0` (schema §22's shape, invariant U2).
The heartbeat upserts `{workerId}` with the reported body, `lastSeenAt`,
`firstSeenAt` on insert and `expireAt = now + 7 days`. **No pin** constrains the
row — §10.3.2 makes the response the contract and `/admin/pipeline/health` the
reader — so the row is deliberately the smallest thing that reader can use.

### 4. The report's three decisions

- **Lease.** The reporter owns an item while `processing.status === "processing"`
  **and** `processing.workerId === workerId`; anything else increments
  `leaseLost` and writes nothing (I2's deep-equal). An id that resolves to no row
  is `rejected` with `reason: "unknown_item"` — the arm ADR-0829 did not pin.
- **The selfie arm.** `processing` is always written from the reducer; a `done`
  item additionally writes `status: "ready"`, `matchCount = matchesCreated` and
  `lastMatchRunAt = new Date(matchRunStartedAt)` on the profile, a `failed` item
  writes `status: "failed"`, and a `skipped` item leaves the profile alone. The
  worker's `quality`/`liveness` verdicts are patched onto the selfie as
  dot-paths (`quality.accepted`, `liveness.passed`, …) rather than replacing
  those objects, so §6.4's `selfie.liveness.required` survives the write.
- **Withdrawn.** A profile already `withdrawn` discards the item
  (`profile_withdrawn`) before any write, in the race window I8 builds. The
  check is ordered **after** the lease check: an item no worker holds is
  `leaseLost` whether or not its profile was withdrawn.

`maxAttempts` is read from the row's `processing.maxAttempts` with
`platformSettings.pipeline.maxAttempts` as the fallback, because §18.2 puts the
budget on the work item.

### 5. The derivative's key

`objectKeyRef` is required and the body schema is **strict**, so a raw
`objectKey` (or any unknown field) is `422 validation_failed` and writes nothing.
The stored key is derived from the asset's own content hash —
`` `${derivative}s/${contentHash}.${format}` `` with `locationKey` its directory
— so a key and a handle can never be the same string, the §16.1 map is patched
per variant (`derivatives.thumbnail` / `derivatives.preview`, one never
disturbing the other), `status` advances to `derivatives_ready`, the original
`storage` descriptor is untouched, and the answer is `{status}` alone — no key
crosses the wire back (§0.15). An unknown `assetId` is `404 not_found`.

### 6. Two new id-only reads on the whitelisted door

The report and derivative bodies carry an item id and **no tenant** (§10.3.2: a
worker holds a lease on a row, not on a tenant), so the row's own `tenantId` has
to be discovered before the write can be scoped. `crossTenantReads` gained
`findWorkItemById(kind, id)` and `findMediaAssetById(id)` — the sibling of
`findFaceMatchById`, which already exists for the same reason — with
projections limited to the scope, the lease state and the content hash. The
writes that follow go through `tenantRepo(row.tenantId, …)`, so the tenant
boundary is still the one the repository layer enforces, and
`platform-door-tenant-collections` stays green (neither helper opens
`platformRepo`; `selfies` is never reached that way outside `repos/**`).

### 7. The `/me` wiring and the one minter

- `GET /p/events/{slug}/me` now projects the active selfie's `processing` and
  forwards `processing.lastError.code` into `resolveStatus` (ADR-0829 §4), so a
  `liveness_failed` pipeline failure renders its own §6.4 detail instead of the
  generic `processing_failed`. Input and copy already existed; only the wiring
  was missing.
- `matchesNewDedupeKey(eventId, profileId, selfieId)` now lives in
  `@/server/domain/domain-events.ts` and the confirmation route calls it. The
  string is byte-identical (the `selfie-confirm-publication` pins prove it: 4
  passed), so this is the behaviour-neutral refactor the review of PR #560 asked
  for. The worker endpoint does **not** mint the key — it honours the caller's
  `dedupeKey` — so the helper has one production caller and the spec's own
  literal stays the contract that catches drift.

## 8. One forced precedence rule, and one dispute that no implementation can satisfy

### 8.1 — `invalid_signature` outranks a wrong bearer when a signature is present (resolved)

`apps/web/src/test/integration/internal-worker-endpoints.test.ts:161-171`:

```ts
const secret = options.secret ?? getConfig().internal.apiSecret;   // 161
...
authorization: `Bearer ${options.bearer ?? secret}`,               // 165
"x-signature": signatureHeader(secret, raw),
```

The helper's TSDoc says the bearer "defaults to the real `INTERNAL_API_SECRET`"
and `secret` is "the secret the body is signed with", but the code defaults the
bearer to `secret`. So the four `refuses a body signed with another secret as
invalid_signature` cases send `{bearer: "wrong-signing-secret-…", signature:
HMAC(wrong-signing-secret)}` and, under ADR-0028 §1's order (bearer policy, then
HMAC), get `internal_auth_failed` (measured: `expected 'internal_auth_failed' to
be 'invalid_signature'`).

That order was not a decision the I5 ladder can keep: the same `describe` pins
`wrong bearer` (`bearer = wrong`, signature valid) → `internal_auth_failed` and
`CRON_SECRET bearer` (`bearer = cronSecret`, signature invalid) →
`internal_auth_failed`, while this arm (`bearer = wrong`, signature invalid) →
`invalid_signature`. `authorizeInternalRequest` now decides in this order:

1. the cron-`GET` exception (unchanged);
2. `token === null` **or** `token === CRON_SECRET` → `internal_auth_failed` — the
   caller has not identified itself, and the cron secret must never earn a
   signature verdict it could replay onto a route;
3. the HMAC verdict, on every request that presents one:
   - a **present** `X-Signature` that does not verify → its own code
     (`invalid_signature` / `stale_signature`), even when the bearer is unknown:
     the caller did sign this body, just not with our secret (§0.3), and that is
     the more specific failure;
   - **no** `X-Signature` at all under an unknown bearer → `internal_auth_failed`
     (step 4 covers it: nothing to verify, and the bearer is not ours);
4. `token !== INTERNAL_API_SECRET` → `internal_auth_failed`.

No request gains access: every path here denies. The three codes keep their
documented meaning, and every earlier pin holds unchanged — `internal-hmac` U4,
U4b, `internal-hmac.test.ts` I2/I4 and the cron routes' own suites are green.

### 8.2 — `countDocuments({})` ignores the two rows the fixture's sign-in writes (1 case, still RED)

`apps/web/src/test/integration/internal-worker-endpoints.test.ts:819`, in
`counts a repeat of the same dedupeKey as deduped and keeps one row`: the case
asserts `countDocuments({}) === 1` after its batch. The fixture
(`world()` → `seedTenant` → `app.signIn`) publishes `account.welcome` and
`auth.signin.new_device`, so the outbox holds **two** rows before the batch runs
and the endpoint's own insert makes **three** (measured: `expected 3 to be 1`,
and the run's log shows exactly those two `domain_event.emitted` lines before the
batch). Every other assertion in the case passes (`accepted: 1`, then
`{accepted: 0, deduped: 1}`), so the dedupe itself is green; only the unscoped
count cannot be. **Proposed correction (test side):** scope the read to the
delivery, e.g. `countDocuments({ dedupeKey: activation }) === 1` — or to the
tenant.

## 9. Deliberately not implemented (unpinned, and recorded so the omission is auditable)

- `events.counters` (`counters.processedImageCount`) on a done image: the
  authority is OP-136's `counter-reconcile` (ADR-0829 §6).
- Whether a report for a **superseded** (non-active) selfie writes the profile:
  the shipped arm writes the profile the selfie names, which is the only
  behaviour any pin observes.
- The reducer ignores `faceCount` on purpose: zero faces is a `done`
  (§10.3.3), so no count can change the decision — the field is carried for the
  caller, not read here.

## Consequences

- The pipeline now has a transport for every fact it produces, and ADR-0808 §1's
  "neither endpoint ships at this head" is no longer true: a late match is
  announceable (`/internal/domain-events`, deduped on the shared identity) and
  visible (`/internal/worker/report` writes the projection §6.4 polls).
- The `workerHeartbeats` collection is new platform state; it is bounded by its
  own TTL, so it cannot grow without a reader.
- Two frozen records had to name a new citing file, because the RED pack's spec
  cites them and `adr-consumers` verifies citation accuracy: **ADR-0792** and
  **ADR-0798** `Consumers:` each gained
  `apps/web/src/test/integration/internal-worker-endpoints.test.ts`. No decision
  in either record changed, and no test was edited — the guard's own remedy is to
  name the consumer.
- D1 and D2 stay red until the Test Author corrects the spec; both are
  one-line test-side fixes with the evidence above.
