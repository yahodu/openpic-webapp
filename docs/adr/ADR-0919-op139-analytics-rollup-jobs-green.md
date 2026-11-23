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

## Review — round 1

**Verdict: APPROVED WITH FINDINGS** — the artefact-lens round, on reviewed head `468ab713` (PR #780, base `main`). The verdict and its six inline findings are recorded on PR #780 (`#issuecomment-7098166351`, plus comments `4664581097`, `4664581304`, `4664581503`, `4664581724`, `4664581958`, `4664582141`) and on card `t_c414a059`; round 2 then verified the squash `b1cec73e`. This section records round 1, the round that carried the verdict.

### Acceptance criteria → evidence (measured at `468ab713`)

- **The rollup is idempotent per date** — the case `I1: rolling the same date twice leaves every analyticsDaily document identical` compares the canonical JSON of every row, `_id` included, and asserts no duplicated scope/day pair.
- **Reconciliation corrects drift and records `reconciledAt`** — the case `I2: corrects every drifted tenant, event and profile counter and stamps reconciledAt`, and the agreeing-counter arm `I2: leaves an agreeing counter alone, logs no delta and still stamps reconciledAt`.
- **The isolation audit reports counts, never document contents** — the case `I3: an orphan tenantId document is flagged once, with counts only`, which asserts `Object.keys(payload).sort() === ["collection","count","reason"]`.

### Measured suite state on the reviewed head

- The four OP-139 integration specs — `analytics-rollup` 9, `counter-reconcile` 6, `tenant-isolation-audit` 4, `dsr-sla-check` 4 — report **4 files / 23 passed (23)** on the real `MongoMemoryReplSet`.
- `analytics-rollup-buckets` and `counter-reconcile-drift` report **1 failed | 22 passed (23)**, and the single red is §9's contradicting assertion: line 77 of `apps/web/src/test/unit/analytics-rollup-buckets.test.ts` against its own line 45 table row and its line 91. Card `t_17103f93` corrected those two literals, and PR #780 merged as `b1cec73e`.
- The `adr-numbering` guard reports **29 passed (29)**, and `docs/adr` held **440 records at `468ab713` with no duplicate `ADR-NNNN`**.
- The implementation commit `5780929f` touches **11 production/config files and zero test files** (`git show --stat`).
- Re-measured for this section in a detached worktree at `468ab713`, so the figures above are this append's own runs and not a transcription of the round-1 handoff.

### Findings (all beyond the three pinned criteria)

| #   | Severity | Finding                                                                                                      | Routed to                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- |
| F1  | Medium   | the audit is blind to a tenant-scoped row that carries no `tenantId` — measured `{"scanned":2,"affected":0}` | `t_f12d7d0f` → `t_b0c51c6e` |
| F2  | Medium   | `billingTransactions` is never read, so `revenueMinor` is permanently `0`                                    | `t_0555c437` → `t_e704435e` |
| F3  | Medium   | the DSR check starves its tail once the per-run limit is reached                                             | `t_3f90448c` → `t_4f24b078` |
| F4  | Medium   | one unbounded `$in` query (the 16 MB limit) over a whole-collection `toArray()` in the audit                 | `t_516fb5e6`                |
| F5  | Low      | one sequential `updateOne` per scope in the rollup                                                           | `t_516fb5e6`                |

### Scope note

Every finding is _beyond_ the three pinned acceptance criteria, and the delivery satisfies all three. F2 amends the premise of ADR-0918 §A16 for `revenueMinor` only — the other four unlineaged metrics stay pinned by presence and integrality — and F1 extends ADR-0918 §A10 (the platform address) and turns §A11's two exclusive reasons into three.

### Post-review status

The `revenueMinor`, `missing_tenant` and DSR-paging follow-ups are tracked on the cards above, and at this section's landing each of those cards had completed and its record had landed on the trunk: F1 in `0921`/`0922` (PR #811, `6613c5d0`), F2 in `0923`/`0924` (PR #814, `eeb49f2a`), F3 in `0925`/`0926` (PR #817, `a371ac65`) plus its cold-start pin `0927` (PR #820, `fcba6748`), and F4/F5 in `0928` (PR #822, `f416657c`). Nothing in §4–§9 is retracted: those sections describe the state at delivery, and the records named above are where the later behaviour is decided. This section consumes no ADR number, and the OP-139 lane cell read `0929` at `origin/main` `3616db8a` when it was cut.
