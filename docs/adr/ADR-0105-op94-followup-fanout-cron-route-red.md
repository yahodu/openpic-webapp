# ADR-0105 — OP-94 §1 follow-up RED: the notification-fanout cron route and the `after()` opportunistic trigger

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_1a77ec00` (OP-94 §1 follow-up RED) · **GREEN:** `t_205e5ae7` · **Orchestrator hygiene:** `t_a4ec4d74`
- **Branch:** `OP-94-task-fanout-cron-route-red` (base `origin/main` `2c42fe1`); renumbered `0094 → 0105` at merge because `origin/main` claimed `0094` for the OP-94 fan-out-polish lane
- **Relates to:** [ADR-0090](ADR-0090-op94-notification-fan-out-red.md) (fan-out contract), [ADR-0092](ADR-0092-op94-notification-fan-out-green.md) (green impl, §1 de-scoped), [ADR-0093](ADR-0093-op94-fan-out-green-review-signoff.md) (review sign-off, §1 Low finding), [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md) (cron framework + internal HMAC), [ADR-0029](ADR-0029-domain-events-outbox.md) (outbox)

## Context

OP-94 shipped the notification fan-out consumer (`apps/web/src/server/notifications/fan-out.ts`)
and de-scoped its two triggers (ADR-0090/0092/0093). No live card owned the cron
route — OP-87 is the framework only and OP-96's crons are digest/retry/quiet-hours.
The orchestrator (`t_a4ec4d74`) opened this RED→GREEN lane and settled the
contract (route path, auth, job bounds, summary mapping, import boundary,
`after()` trigger) so it is not re-litigated here.

This ADR records the **test-author decisions** and the module contract the GREEN
card must satisfy. It pins behaviour; it does not implement it.

## Decision

### 1. Pinned surfaces

| Surface           | Contract                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route module      | `apps/web/src/app/api/v1/internal/cron/notification-fanout/route.ts`, exports `GET` + `POST`                                                                                                                                                                                                |
| URL               | `/api/v1/internal/cron/notification-fanout`                                                                                                                                                                                                                                                 |
| Auth              | `internalAuthStage({ internalApiSecret: getConfig().internal.apiSecret, cronSecret: getConfig().cron.secret })` — `GET` accepts the `CRON_SECRET` bearer, `POST` accepts the signed HMAC; denials are catalogue `401` with `internal_auth_failed` / `invalid_signature` / `stale_signature` |
| Job               | `defineCronJob({ name: "notification-fanout", defaultLimit: 500, maxLimit: 2000 })`, returns the §10.2 `CronResult`, `?limit=` parsed per request                                                                                                                                           |
| Summary mapping   | `runNotificationFanOut`'s `FanOutSummary {claimed, processed, failed}` → `CronRunOutcome {scanned: claimed, affected: processed, skipped: 0, errors: failed, hasMore: claimed === resolvedLimit}`                                                                                           |
| Mapper module     | **new** `@/server/notifications/fan-out-cron` exporting `toCronRunOutcome(summary: FanOutSummary, batch: number): CronRunOutcome`                                                                                                                                                           |
| `after()` trigger | `emitDomainEvent` schedules one `after()` callback when the recorded row's `dispatch.notifications === "pending"`; no-op when `after()` throws (outside a request scope)                                                                                                                    |
| Import boundary   | route handlers must not import `@/server/adapters/**` or Novu; `src/server/jobs/**` must not import notifications                                                                                                                                                                           |

### 2. The mapper lives in a new non-jobs module, not the route

A Next.js route module may only export HTTP method handlers, so a pure mapper
cannot be exported from `route.ts` for a unit pin. The projection is therefore
pinned at `@/server/notifications/fan-out-cron` — a non-jobs module (the ADR-0028
boundary forbids `src/server/jobs/**` from importing notifications, and the route
may not reach into adapters). The GREEN card may also place the inline job and
the transport/recipient provider wiring in that module or alongside it.

### 3. Pins written (all RED on `origin/main` `2c42fe1`)

**Unit — `apps/web/src/server/notifications/fan-out-cron.test.ts`**
`toCronRunOutcome` is total and lossless: `claimed→scanned`,
`processed→affected`, `skipped=0`, `failed→errors`, and
`hasMore === (claimed === batch)` including the full-batch-with-partial-failure
and idle-run boundaries. RED reason: the module does not exist
(module-resolution failure).

**Unit — `apps/web/src/server/domain/domain-events-after-trigger.test.ts`**
Mocks `next/server`'s `after` and asserts: a notifications-pending emit schedules
exactly one callback (RED — the current writer calls nothing); a non-owned event
(analytics-only / no enabled type) schedules nothing; an emit whose `after()`
throws still resolves and records the row (the "no request scope" no-op mirrored
from `app/api/v1/health/route.ts:18-25`). The latter two are guard pins that hold
today and protect the scheduler from being added unconditionally.

**Integration — `apps/web/src/test/integration/notification-fanout-cron-route.test.ts`**
Drives the real `GET`/`POST` handlers in-process against a real
`MongoMemoryReplSet`, with credentials read back from `getConfig()`:
`I1` a valid `CRON_SECRET` bearer drains the seeded pending outbox into a valid
`CronResult` (`job: "notification-fanout"`); `I2` `?limit=1` honours the batch,
processes exactly one row and reports `hasMore: true`; `I3` an
absent/malformed/`<= 0` limit falls back to the 500 default; `I4` a signed
`POST` is `200`; `I5`–`I9` a wrong bearer, missing auth, a tampered signed body,
a stale timestamp and a `CRON_SECRET` bearer on `POST` are each `401` with the
matching code and touch nothing. RED reason: the route module does not exist
(module-resolution failure).

### 4. The integration suite owns a private database

`globalSetup` publishes one `MongoMemoryReplSet` whose `getUri()` names no
database, so `getDb()` resolves to the driver default (`test`) — the same
database some existing suites (`me-current-user`, `me-sessions-and-deletion`,
`me-ban-exemption`) drop in `afterAll`. To keep this suite's outbox independent
of those workers, `beforeAll` appends a unique database name to `MONGO_TEST_URI`
before the config is first cached. This is a test-harness decision only; no
production module is affected.

## Assumptions and open questions

- **The `maxLimit = 2000` clamp is not behaviourally observable with a small
  fixture.** Clamping only surfaces when a run claims a full batch, which would
  need 2000 pending rows. The exact clamp arithmetic is already pinned by the
  framework's `clampLimit` specs (ADR-0028); this lane instead pins the
  observable fallback path (`?limit=` absent/malformed → default) and the
  `hasMore === claimed === batch` mapping. The GREEN implementer must still
  declare `defaultLimit: 500`, `maxLimit: 2000` as settled.
- **The happy path seeds no notification-type catalogue row.** With no enabled
  type the consumer still claims and marks each row `done` with no recipients,
  so `scanned`/`affected` count the claimed work without needing memberships.
  Delivery (feed rows, dispatches, transports) is already pinned by
  `notification-fan-out.test.ts`; this lane pins the _route_ wiring.
- **The `after()` trigger is pinned by scheduling, not execution.** The unit
  spec asserts `after` is called once with a callback; it does not invoke the
  callback (that eagerly imports the fan-out and needs a database). Whether the
  deferred callback actually drains the outbox is covered by the route pins.
- **A deduped emit is not pinned for the trigger.** ADR-0090 does not state
  whether a `dedupeKey` collision should schedule a run; only the
  `pending`/non-`pending` branches are pinned. A GREEN implementation may choose
  either and stay green.
- **`vercel.json` is out of this lane.** ADR-0028 deliberately defers the
  `crons` list until the first real §10.2 job lands; the GREEN card adds
  `{ "path": "/api/v1/internal/cron/notification-fanout", "schedule": "* * * * *" }`.
- **The §10.2 table does not list `notification-fanout`.** It is the consumer
  drain route, not a domain job; this lane treats the orchestrator-settled
  name/limits as authoritative.

## Out of scope

- Implementing the route, the mapper, the Mongo `RecipientRepository`, the
  transport provider, the trigger or `vercel.json` (all GREEN `t_205e5ae7`).
- `sendTransactionalNow()` — owned by OP-95.
- Lifecycle/E2E coverage of the deferred callback: it is RSC-adjacent and not
  reliably unit-testable; the route-level pins cover the observable behaviour.

## RED evidence

- `vitest run --project unit fan-out-cron domain-events-after-trigger` →
  `fan-out-cron.test.ts` fails with
  `Cannot find package '@/server/notifications/fan-out-cron'`;
  `domain-events-after-trigger.test.ts` fails with
  `expected "vi.fn()" to be called 1 times, but got 0 times` (the other two
  pins are guard-greens).
- `vitest run --project integration notification-fanout-cron-route` →
  `Cannot find package '@/app/api/v1/internal/cron/notification-fanout/route'`.

## Consequences

- The GREEN implementation is fully specified by these pins; no production
  behaviour is invented beyond the orchestrator's settled decisions.
- Once green, regressing the route wiring (wrong secret, dropped batch, wrong
  mapping, unconditional trigger) breaks a pin and names itself in the failure.
- The `after()` no-op pin keeps the outbox writer usable from scripts and tests
  that run outside a Next.js request scope.

## Alternatives considered

- **Pin the mapper on the existing `fan-out.ts`.** Rejected: a missing named
  export fails as `undefined is not a function`, a poorer RED message than a
  missing module, and it couples the consumer module to the job framework.
- **Pin clamping by seeding 2000+ rows.** Rejected: slow, and the arithmetic is
  already framework-pinned.
- **Assert on `vercel.json`.** Rejected: config, not behaviour, and explicitly
  the GREEN card's deliverable.
