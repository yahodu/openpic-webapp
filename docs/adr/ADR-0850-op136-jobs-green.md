# ADR-0850 — OP-136 GREEN: the sweeps, the erase and the one pin they cannot satisfy

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 `t_d18a6e9e` (phase 6-M2M / Jobs & Compliance, epic Background
  Jobs, `tdd_stage: GREEN`) · **RED parent:** `t_b25b384f`
  ([ADR-0849](ADR-0849-op136-jobs-red.md))
- **Implements:** contract §10.2 (the cron table), §10.3.3 (worker contract),
  §4.5, §4.6, §9.10, §1.4; schema §13.2, §13.6, §14.2, §15.1, §15.3, §16.4, §22
- **Consumes:** [ADR-0028](ADR-0028-internal-hmac-and-cron-framework.md)
  (`defineCronJob`, the internal HMAC stage), [ADR-0029](ADR-0029-domain-events-outbox.md)
  (`emitDomainEvent` and its dedupe index), [ADR-0680](ADR-0680-op122-queue-port-red.md)/[ADR-0681](ADR-0681-op122-queue-green.md)
  (the §10.4 envelope and `queueKeyFor`), ADR-0721 (`enqueueWork`), ADR-0808 §3
  (the run-discriminated delivery identity), ADR-0340 §4 (`periodKey`)
- **Number allocation:** the lane row `OP-136 jobs lane` reads `0849`–`0868` /
  `Next free 0850` on this head; this record takes `0850` and advances that cell
  to `0851`. No sweep was needed: `0850` is the lane's own reservation, no
  `.worktrees/*/docs/adr` carries an `ADR-0850*`/`ADR-0851*` file and the two
  pool cells stay `0869`.

## Context

ADR-0849 fixed the executable contract — two pure modules, seven job
declarations and the rules the pins measure — and shipped no production code. It
also routed three jobs out of the RED's test list (`pipeline-indexed-check`,
`upload-session-sweep`, `attendee-no-match-check`) while the card's scope notes
kept them in this card. This record covers turning the pins green: what shipped
at each path, the decisions the pins did not make, the three jobs no spec pins,
and the one assertion that **cannot** be made green without contradicting ADR-0849
§3 (§5).

## Decision

### 1. The modules

| Path                                                  | Contract                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web/src/server/jobs/sweep-decisions.ts`         | The six pure decisions and `RETENTION_STEPS`, exactly as ADR-0849 §1 names them                 |
| `apps/web/src/server/attendee/match-run.ts`           | `incrementalMatchRunKey({eventId, profileId, selfieId, runAt})` — activation key + `:run:<ISO>` |
| `apps/web/src/server/jobs/run-options.ts`             | `SweepJobRunOptions { db, clock, logger, limit }` — one seam, not a barrel                      |
| `apps/web/src/server/jobs/pipeline-sweep.ts`          | `pipelineSweepJob` (2000/4000) and its runner                                                   |
| `apps/web/src/server/jobs/pipeline-indexed-check.ts`  | `pipelineIndexedCheckJob` (500/1000)                                                            |
| `apps/web/src/server/jobs/upload-session-sweep.ts`    | `uploadSessionSweepJob` (1000/2000)                                                             |
| `apps/web/src/server/jobs/event-window-sweep.ts`      | `eventWindowSweepJob` (1000/2000)                                                               |
| `apps/web/src/server/jobs/retention-warnings.ts`      | `retentionWarningsJob` (2000/4000)                                                              |
| `apps/web/src/server/jobs/retention-purge.ts`         | `retentionPurgeJob` (50/100)                                                                    |
| `apps/web/src/server/jobs/usage-threshold-check.ts`   | `usageThresholdCheckJob` (2000/4000)                                                            |
| `apps/web/src/server/jobs/invitation-expiry.ts`       | `invitationExpiryJob` (1000/2000)                                                               |
| `apps/web/src/server/jobs/verification-nudge.ts`      | `verificationNudgeJob` (1000/2000)                                                              |
| `apps/web/src/server/jobs/attendee-no-match-check.ts` | `attendeeNoMatchCheckJob` (1000/2000)                                                           |
| `apps/web/src/server/jobs/account-deletion-purge.ts`  | `accountDeletionPurgeJob` (50/100)                                                              |

Each module exports its runner (so a future spec can drive it with a private
database) **and** the `defineCronJob` declaration the specs import, because the
specs name the declaration's path as the module path. `retention-purge` logs its
per-step evidence through `ctx.logger`, never `getLogger()`: the recording logger
is how the DSR evidence is observed.

### 2. `pipeline-sweep` — four steps, then the run

Step 1 moves an expired lease to `queued` with the `processing.status:
"processing"` prior state in the filter, then re-enqueues through `enqueueWork`;
step 2 re-enqueues a `queued` item older than five minutes whose
`processing.queueRef.messageId` is absent **and** whose attempt budget is not
spent (otherwise step 2 would buy a sixth attempt for a row step 3 must fail);
step 3 fails a row at `settings.pipeline.maxAttempts` and emits one
`pipeline.image.failed`; step 4 enqueues the incremental run.

Decisions the pins did not make:

- **The watermark write is the run's claim.** The sweep advances
  `lastMatchRunAt` with a conditional update before enqueuing, and hands the old
  value back if the broker refuses — a lost broker pointer would otherwise lose
  the run until the event gained another face.
- **`pipeline.image.failed` is emitted for `event_image` work only.** A selfie
  whose budget is spent is marked `failed` and nothing else: the contract's emits
  column lists the image failure, and a selfie has its own refusal event.
- **The sweep never announces a match.** It mints no `attendee.matches.new`; the
  run identity ADR-0808 §3 requires is minted by `incrementalMatchRunKey` and is
  the worker report's to use. The sweep only makes the run happen.

### 3. The erase is ordered, counted and resumable — and carries its asset ids

The steps run exactly `RETENTION_STEPS`, each one logging
`{ event: "retention.purge.step", eventId, step, count }` at info and persisting
`purge.step` (the **last completed** step) with the merged `purge.counts`
immediately after it, so an interrupted run resumes on the next one and keeps its
earlier evidence. The terminal marker is `purge.step: "done"` with
`purge.completedAt`. Three limits the pinned order forces, none of them
guessable from the step list:

- **`purge.imageAssetIds` is persisted.** The `mediaAssets` step needs the asset
  ids of image rows that the `eventImages` step has already deleted, so the ids
  are read once at the start of the erase and stored on the marker; without it a
  resume that begins at `mediaAssets` would leave the rows for ever.
- **The `mediaAssets` counter counts image assets only.** The pinned counts are
  `mediaAssets: 1` and `selfies: 1` for a world holding one owned image asset,
  one shared one and one selfie asset, so the `selfies` step erases its own asset
  rows (and their objects, which the `storage` step deleted) without adding to
  the `mediaAssets` tally.
- **The selfie object key is derived, not read.** A selfie's `mediaAssets` row
  carries no `storage` block, so its bytes are addressed as
  `originals/selfies/<contentHash>` — which is exactly the key OP-132's
  withdrawal path writes.
- **A shared asset is decremented, never counted and never deleted.** The
  storage step skips any asset with `refCount > 1`, so its objects stay readable
  for the other event.

The two job-level legs log `{ step, counts }` (an object, because a leg bounds
several collections): `expiredSelfies` → `{ selfies, embeddings, matches }` and
`anonymousSessions` → `{ sessions, selfies, profiles }`. The `expiredSelfies` leg
also erases the selfie's asset row and object; the `anonymousSessions` leg erases
an expired, unclaimed session's selfies, their bytes and its profiles. Consents
are never touched: the demonstrable record the DSR rests on outlives its event.

### 4. The remaining jobs, where the pins were silent

- **`usage-threshold-check`** resolves each counter row through the shipped
  `checkEntitlement`, skips a row whose `periodKey` is not the key's current one
  (an elapsed row is not this period's usage) and latches on the current row with
  `$addToSet`, which keeps the per-period order. `notified` counts deliveries the
  outbox did not dedupe.
- **`invitation-expiry`** latches its one reminder on a new
  `invitations.reminderSentAt` field, set by the same conditional update that
  claims the row; the expiry itself is a `pending → expired` conditional write
  and the accept route's `410 invitation_expired` already reads that status.
- **`verification-nudge`** counts on `userProfiles.verificationNudges` and emits
  with the shipped account-scope convention (`tenantId: userId`, the shape
  `handleDeletionRequested` uses) — an account event belongs to no tenant.
- **`event-window-sweep`** writes the status only from `resolveEventStatus`, with
  the prior status in the filter, and announces `event.ended` only when that
  write matched. The T-24h run therefore announces `event.starting_soon` and
  moves nothing.
- **`pipeline-indexed-check`** treats an event as indexed when
  `processedImageCount + failedImageCount >= imageCount` on its counters (the
  denominator the address book keeps), with a six-hour bucket in the dedupe key:
  one notice per event per window, email on the first.
- **`upload-session-sweep`** reads the stored proxy for "has parts" — the
  `multipart_upload` entry in `externalRefs`, because parts are never stored
  (§16.2 makes the live `ListParts` answer the only part truth). The
  `shortcut:` comment in the module says so.
- **`attendee-no-match-check`** takes `status: "ready"`, `matchCount: 0` and a
  stamped `lastMatchRunAt` as "the run finished and found nothing", and keys one
  delivery per profile.
- **`account-deletion-purge`** anonymizes in this order: claim the profile
  (`deletion_pending` + `deletionScheduledAt <= now` → `deleted` +
  `purgeStartedAt`, display fields cleared), read the contact, `$unset` the
  Better Auth row's `email`/`name`, delete its sessions, upsert the tombstone,
  then emit `account.deletion.completed` with `payload: { userId }`. The payload
  carries no contact; the fan-out resolves it from `accountDeletionTombstones`.

### 5. Disputed pin — the latch assertion reads the previous period's row

`apps/web/src/test/integration/job-usage-and-invitations.test.ts` → **"notifies
the same threshold again in a new period"**, line 263:

```ts
expect(await latch("events.active")).toEqual([80]);
```

`latch(entitlementKey)` is `findOne({ tenantId, entitlementKey })` — no
`periodKey`. The case seeds **two** rows for `events.active`: `2026-10` with
`thresholdsNotified: [80, 95, 100]` and the current `2026-11` with none. With
`usage_counters_tenant_key_period_unique` on `{tenantId, entitlementKey,
periodKey}`, that query is an index-prefix match and answers the **lowest**
period key, i.e. the fully latched October row. Measured on this head:

```
AssertionError: expected [ 80, 95, 100 ] to deeply equal [ 80 ]
```

The first two thirds of the case pass (`thresholdEvents` length 1, payload
`{threshold: 80, percent: 90}`, `details.notified: 1`): the job does warn the
current period once and does latch **it** at `[80]`. Only the helpers' row choice
disagrees.

The pin cannot be satisfied honestly. The only implementations that make that
read answer `[80]` are (a) deleting the elapsed-period counter row, or (b)
replacing its latch with the current period's — and ADR-0849 §3 fixes the latch
as "the `thresholdsNotified` on the `usageCounters` row it reads … because the
row's identity is `{tenantId, entitlementKey, periodKey}`", while contract §6.10
serves those rows raw "for support and reconciliation". Both are data loss
dressed as a pass.

**Proposed correction (test-side, small):** give the helper the period the case
seeded instead of letting `findOne` answer the index's first row. The same helper
serves the `storage.bytes` cases, whose row is `periodKey: "lifetime"`, so a
constant `periodKey("monthly", NOW)` would break them — the period must be a
parameter:

```ts
async function latch(entitlementKey: string, period: string): Promise<unknown> {
  const row = await app.db
    .collection(COLLECTIONS.usageCounters)
    .findOne({ tenantId: TENANT, entitlementKey, periodKey: period });
  return row?.thresholdsNotified;
}
```

with `latch("storage.bytes", "lifetime")` at the I6 call sites and
`latch("events.active", periodKey("monthly", NOW))` at this case's (the helper's
three I6 calls pass `lifetime`, this case's one call passes the current month;
`periodKey` is already imported by the file). Left red on purpose; no test,
fixture or helper was edited, and the repair was routed to the Test Author as its
own card rather than made here.

### 6. Cron registration

Every job has a `POST /api/v1/internal/cron/<job>` route behind the internal HMAC
stage (the `runBillingCronRoute` shape: `CRON_SECRET` bearer accepted for a
`POST`, `?limit=` honoured and clamped) and a `vercel.json` row.

| Route                       | Schedule      |
| --------------------------- | ------------- |
| `…/pipeline-sweep`          | `*/2 * * * *` |
| `…/pipeline-indexed-check`  | `*/5 * * * *` |
| `…/upload-session-sweep`    | `10 * * * *`  |
| `…/event-window-sweep`      | `0 * * * *`   |
| `…/retention-warnings`      | `30 2 * * *`  |
| `…/retention-purge`         | `0 3 * * *`   |
| `…/usage-threshold-check`   | `15 * * * *`  |
| `…/invitation-expiry`       | `20 * * * *`  |
| `…/account-deletion-purge`  | `45 3 * * *`  |
| `…/verification-nudge`      | `25 * * * *`  |
| `…/attendee-no-match-check` | `35 * * * *`  |

## Evidence

- Full suite (`vitest run --project unit --project integration`): **320 of 321
  files, 4492 passed | 3 skipped | 1 failed (4496)**. The single failure is the
  disputed assertion of §5; there is no other red.
- `tsc -p apps/web/tsconfig.json --noEmit`: exit `0`.
- `eslint` 0 errors on the touched paths; `prettier --check` clean.
- The six ADR guards stay green (the record is numbered, well-formed and cites
  only records it does not contradict).

## Out of scope / coverage gaps

- `pipeline-indexed-check`, `upload-session-sweep`, `attendee-no-match-check`
  and `retention-warnings` have **no spec** — the RED card routed them out of its
  test list. Their behaviour is the contract's sentence and the module docblock,
  not a pin; a TEST card is the next cycle's.
- The OP-126 batch transition check named in the card's `pipeline-indexed-check`
  scope note ships in OP-126's own path and is not wired here.
- The emission of the run-discriminated `attendee.matches.new` stays with the
  worker/OP-135 transport (ADR-0808 §3).
- `docs/adr/README.md`'s OP-136 note claims both `0849` cells advanced; the
  OP-129 cell did not. That is card `t_d44c4094`, not this record.
