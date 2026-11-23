# ADR-0919 — OP-139 GREEN: the four nightly jobs implemented against the RED pins

- **Status:** Accepted
- **Date:** 2026-11-23
- **Card:** `t_c414a059` (OP-139, phase 6-M2M — Jobs & Compliance, epic Background Jobs,
  `tdd_stage: GREEN`, parents `t_7da4009d` (RED))
- **Branch:** `OP-139-task-analytics-rollup-red` (the pins' branch; this GREEN pushes to the
  same branch and the same draft PR #780 — no new branch, no rebase)
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_7da4009d`
- **Number allocation:** draws the **OP-139 lane's** `Next free` cell, `0919`, and advances it
  to `0920`. The sweep was read immediately before this commit:
  - `origin/main` carries no `ADR-0918`–`ADR-0929` object or path (its highest records are the
    OP-136 lane's `0938`–`0941`, which are outside this lane's `0918`–`0937` block);
  - every `.worktrees/*/docs/adr` tree holds no `ADR-0919`;
  - the open PR heads carry none: #780 (`1253a841`, this branch — `0918` only), #755
    (`c90ae3ba`), #743 (`40df0afd`), #272 (`d5be9af4`);
  - `git rev-list --objects --all -- docs/adr` resolves no `ADR-0919` object.
  - the lane row read `0918`–`0937` / `Next free` `0919` on the merged tree; no cell is lowered
    and no range is re-cut.
- **Pins:** the RED pack [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) — 46 cases in
  six specs (`analytics-rollup-buckets` 11, `counter-reconcile-drift` 12, `analytics-rollup` 9,
  `counter-reconcile` 6, `tenant-isolation-audit` 4, `dsr-sla-check` 4) and one factory. **No
  test file, factory, helper or fixture is edited by this delivery.**
- **Consumes:** ADR-0918 (every assumption A1–A19), ADR-0642 (the analytics read model),
  ADR-0028 (the bounded cron framework and its `Clock` rule), ADR-0898/ADR-0902 (the DSR row
  and its `slaDueAt`), contract §10.2 and schema §20.1/§20.3/§20.4.
- **Consumers:**
  - `apps/web/src/server/jobs/analytics-rollup.ts`
  - `apps/web/src/server/jobs/counter-reconcile.ts`
  - `apps/web/src/server/jobs/tenant-isolation-audit.ts`
  - `apps/web/src/server/jobs/dsr-sla-check.ts`
  - `apps/web/src/server/jobs/cron-job.ts`
  - `apps/web/src/server/settings/platform-settings.ts`
  - `apps/web/src/app/api/v1/internal/cron/analytics-rollup/route.ts`
  - `apps/web/src/app/api/v1/internal/cron/counter-reconcile/route.ts`
  - `apps/web/src/app/api/v1/internal/cron/tenant-isolation-audit/route.ts`
  - `apps/web/src/app/api/v1/internal/cron/dsr-sla-check/route.ts`
  - `apps/web/vercel.json`

## 1. Context

ADR-0918 fixed the contract the card left open as a test list and shipped no production file.
This record implements exactly what those 46 cases demand, and records the two places where the
implementation had to choose beyond (or against) the prose.

## 2. Decision — the day bucket

`dateKeyInTimeZone(instant, timeZone)` reads the instant's wall-clock parts through
`Intl.DateTimeFormat` and formats `YYYY-MM-DD`; it takes the zone as an argument and never reads
a clock. `dayWindowUtc(dateKey, timeZone)` converts local midnight to a UTC instant by
subtracting the zone's offset at the guess, twice, so a DST transition still lands on the right
instant; the window ends at the next key's midnight, so it is half-open.

The bucket is the **Asia/Kolkata calendar day**, so `2026-11-17` is
`[2026-11-16T18:30Z, 2026-11-17T18:30Z)`. That is the only window consistent with the same
spec's IST table (18:30Z is IST midnight of the **next** day), with its own
"both ends' day" case, and with the nine integration cases whose fixtures sit at
`2026-11-17T06:00Z`; see §9, the dispute.

## 3. Decision — `analytics-rollup`

One `analyticsDaily` document per `{scope.kind, scope.id, dateKey}`, upserted on that compound
(a plain `$set` of `metrics` and `computedAt`, so a rerun rewrites the same `_id` and the same
values). Scopes are `tenant`, `event` and `platform` (`scope.id: null`), and a scope gets a row
only when the day has activity for it (ADR-0918 §A6).

| metric                                                                                 | source, on the day window                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `eventsCreated`                                                                        | `domain_events` with `eventKey: "event.created"`, by `occurredAt`                                             |
| `imagesUploaded` / `imagesProcessed` / `imagesFailed`                                  | `event_images` by `createdAt`, all / `processing.status: "processed"` / `"failed"`                            |
| `selfiesUploaded`                                                                      | `selfies` by `createdAt`                                                                                      |
| `matchesCreated`                                                                       | `face_matches` by `createdAt`; the tenant/event it belongs to is read from its profile                        |
| `notificationsSent`                                                                    | `notification_dispatches` by `createdAt` with `status: "sent"`                                                |
| `uniqueAttendees`, `storageBytesAdded`, `downloads`, `revenueMinor`, `p95ProcessingMs` | **`0`** — their lineage is not stated (ADR-0918 §A16) and inventing one would write a number no source claims |

Every metric is written in full (twelve keys, integers, never `null`), so the read model's
`toCount` never defaults a real zero. `?date=` re-runs any day; absent, the run rolls up the
IST day that closed (`previousDateKey(dateKeyInTimeZone(now, IST))`). `computedAt` comes from the
injected `Clock`.

## 4. Decision — `counter-reconcile`

`isDriftSignificant` measures `|cached − actual| / actual` (with `actual === 0` answering `0`
or `100`) and compares **strictly above** the threshold. The job:

- examines `limit` tenants **least-recently-reconciled first** (`sort: counters.reconciledAt
asc, _id asc`), so a population larger than the budget drains across nights; `hasMore` is
  `true` while any tenant still carries `counters.reconciledAt: null` — the backlog, not the
  scan, is what the scheduler re-invokes for (ADR-0918 §A18);
- recomputes the tenant's four source-backed counters and each event's three processing
  counters and each profile's `matchCount` from `events` / `event_images` / `face_matches`
  (never from another cached counter); `tenants.counters.storageBytes` is left untouched
  (ADR-0918 §A8);
- rewrites the whole `counters` block (spread of the stored one, so `approximate` and
  `storageBytes` survive) and stamps `counters.reconciledAt` as an RFC 3339 `Z` string on
  **every** examined tenant;
- logs one `counter.reconcile.corrected` line per drifted field with
  `{collection, field, cached, actual}` — no line when a field agrees — and emits one
  `admin.abuse.flagged` (`{reason: "counter_drift", collection, field, cached, actual}`,
  deduped per tenant/field/day) only when that field's drift is above
  `platformSettings.jobs.counterReconcile.driftThresholdPercent`.

## 5. Decision — `tenant-isolation-audit` and `dsr-sla-check`

The audit iterates `TENANT_SCOPED_COLLECTIONS` (imported, so a new member is audited without a
second edit), resolves every `tenantId` against the live `tenants` hex ids, and — for rows that
carry an `eventId` — compares it with the parent event's `tenantId`. The two reasons are
exclusive (ADR-0918 §A11), a row whose parent is gone is silent (§A12), and each
`(reason, collection)` emits at most one `admin.abuse.flagged` per IST day via the outbox
`dedupeKey`. The payload's key set is exactly `{collection, count, reason}` and the summary line
carries collection **names and counts only**.

The SLA check reads open requests (`status ∉ {completed, rejected}`) whose
`slaDueAt <= now + 48 h` (inclusive edge), and emits one `admin.dsr.sla_risk` per request per
IST day with exactly `{requestId, requestType, slaDueAt}`, addressed to the first id in
`scope.tenantIds`. A request with no tenant is skipped, not emitted tenant-less.

## 6. Decision — wiring

- `CronRunOptions` / `CronJobContext` gain `date?: string`: the contract's "re-runnable for any
  date via `?date=`" needs the framework to carry it, and `defineCronJob` forwards it
  unchanged. No other job reads it.
- `POST /api/v1/internal/cron/analytics-rollup` validates `?date=` with `dateKeySchema` and
  refuses a malformed one as `422 validation_failed` **before** the job runs; the other three
  routes are one-liners over the shipped `runBillingCronRoute` (CRON_SECRET bearer accepted for
  POST, ADR-0500).
- `platformSettings` gains `jobs.counterReconcile.driftThresholdPercent`, bounded `0..100`,
  **defaulted to `5`**, so a singleton seeded before this section existed still parses and the
  documented default applies.
- `apps/web/vercel.json` gains the four schedules in UTC: `analytics-rollup` `30 20 * * *`
  (02:00 IST), `counter-reconcile` `0 21 * * *` (02:30 IST), `tenant-isolation-audit`
  `15 21 * * *` (02:45 IST), `dsr-sla-check` `45 2 * * *` (08:15 IST). No test pins these
  strings (ADR-0918's residual), so the IST anchors above are the record of the choice.

## 7. Evidence — the GREEN state

Measured on this head, with no test file touched (`git diff --stat` lists production files, this
record and the ledger only):

- `analytics-rollup-buckets` **10 passed / 1 failed** — the failing case is the disputed one in
  §9; every other case, including the "both ends' day" case that contradicts it, is green.
- `counter-reconcile-drift` **12 passed (12)**.
- `analytics-rollup` **9 passed (9)**, `counter-reconcile` **6 passed (6)**,
  `tenant-isolation-audit` **4 passed (4)**, `dsr-sla-check` **4 passed (4)** — all on the real
  `MongoMemoryReplSet` harness.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors and 0 warnings on the ten
  touched files; `prettier --check` clean.

## 8. Consequences and known limits

- **The rollup reads `selfies` and `attendee_event_profiles` cross-tenant.** It aliases the
  platform handle (`const platform = platformRepo(db)`) exactly as the shipped cross-tenant
  sweeps do (`retention-purge`, `attendee-no-match-check`), because a platform rollup has no
  tenant to scope by and `crossTenantReads` is subject-keyed only. The door rule's textual pin
  stays satisfied and says nothing different from those jobs.
- **Five metrics are written as `0`.** `uniqueAttendees`, `storageBytesAdded`, `downloads`,
  `revenueMinor` and `p95ProcessingMs` have no stated lineage (ADR-0918 §A16), so a dashboard
  reads a real `0` there until a later card defines the source. The alternative — inventing a
  join — was rejected in ADR-0918 §8 and is not revived here.
- **The rollup loads one day's source rows in memory** to build the per-scope buckets. A day
  that outgrows one function's memory wants a `$group` aggregation per collection instead
  (`shortcut: one day's rows are read into memory; switch to $group when a day exceeds ~10^5
rows`).
- **The audit reads every tenant-scoped collection whole**, and resolves parents with one `$in`
  query per collection. Large collections want a paginated cursor; the card's limit is "all".
- **`tenants.counters.storageBytes` is never reconciled** (ADR-0918 §A8) — the byte lineage
  from an `event_image` to its `media_asset` is a later decision.
- **The unit spec's IST window case is red by dispute**, not by defect in the implementation.

## 9. Dispute — the unit spec's IST window expectations are internally contradictory

**Test:** `apps/web/src/test/unit/analytics-rollup-buckets.test.ts`, case
`"returns the half-open UTC window of an IST day"` (lines 74–79).

It asserts `dayWindowUtc("2026-11-17", "Asia/Kolkata").start.toISOString()` is
`"2026-11-17T18:30:00.000Z"`. The same file's IST table pins
`dateKeyInTimeZone("2026-11-17T18:30:00.000Z", IST) === "2026-11-18"` (IST midnight belongs to
the **next** day), and the case `"places the window's own day key on both ends' day"`
(lines 88–96) requires `dateKeyInTimeZone(window.start, IST) === "2026-11-17"`. Those three
assertions cannot hold together for any implementation: `window.start` is the same instant in
both cases, so `dateKeyInTimeZone` would have to answer both `"2026-11-17"` and `"2026-11-18"`.
Lines 88–96, the table and the nine integration cases (whose activity sits at
`2026-11-17T06:00Z`, inside `[16th 18:30Z, 17th 18:30Z)` and outside the expected pair) agree
with each other; lines 77–78 are one day late.

**Proposed correction (for the Test Author, not applied here):**
`start` → `"2026-11-16T18:30:00.000Z"`, `end` → `"2026-11-17T18:30:00.000Z"`. Nothing else in
the pack changes, and the implementation already behaves that way.

## 10. Alternatives

1. **Make `dayWindowUtc` answer the disputed pair to go green.** Rejected: it would red the
   same file's `"both ends' day"` case and all nine integration cases, and would write the
   wrong day's rows in production.
2. **Widen the rollup window by a day to cover both readings.** Rejected: it double-counts
   yesterday's rows into today's rollup, which is exactly the failure acceptance criterion 1
   ("idempotent per date") exists to prevent.
3. **Emit one `admin.abuse.flagged` per drifting row.** Rejected: the admin channel is
   digest-throttled (§7.6); one alert per drifted field with a day-scoped dedupe key is the
   card's "drift above a threshold".
4. **Store an audit cursor instead of reading the live tenant set.** Rejected: a reused cursor
   hides a tenant created since the last run, which is the case the audit exists for.
