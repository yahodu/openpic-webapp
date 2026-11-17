# ADR-0849 — OP-136 RED: the background jobs that recover, warn and erase

- **Status:** Accepted (RED contract; the sibling GREEN card `t_d18a6e9e` consumes it)
- **Lane:** OP-136 had no row in the reserved-range ledger, so — as its first card — it drew the next 20-number block from the `unallocated (future lanes)` pool: **`0849`–`0868`**. Both cells that read `0849` on this base (the pool row and the stale `OP-129 attendee identity lane` cell) are advanced to `0869`, and the lane gains its own row at `Next free 0850`. One number, `0849`, is consumed by this record.
- **Card:** `t_b25b384f` (RED). Sibling GREEN: `t_d18a6e9e`.

## Context

Contract §10.2 lists 27 cron endpoints. The trunk ships the bounded framework
(`@/server/jobs/cron-job`, OP-87: `defineCronJob`, `clampLimit`, the
`CronResult` envelope), the notification jobs, the billing jobs, and four crons
registered in `apps/web/vercel.json`. It ships **none** of the jobs this card
names: `pipeline-sweep`, `event-window-sweep`, `retention-warnings`,
`retention-purge`, `usage-threshold-check`, `invitation-expiry`,
`verification-nudge`, `account-deletion-purge`, `pipeline-indexed-check`,
`upload-session-sweep` and `attendee-no-match-check` do not exist, and neither
do the pure decisions they rest on.

Three shipped facts shape the contract:

1. `pipeline-sweep` is the **only** producer of `match_incremental` (§10.2 step
   4); ADR-0808 §3 makes the incremental run the owner of a **second**,
   run-discriminated `attendee.matches.new` delivery. Nothing in this card
   emits that event — the transport is OP-135's `/internal/domain-events` —
   but the run identity must exist, so this card pins it as a pure mint.
2. The event status enum stores `draft | published | archived`; §10.2's
   `event-window-sweep` writes `live` and `ended`. The transition is therefore a
   pure decision, not a query.
3. `imageFaces` is named by §10.2's erasure order but is not a registered
   collection; `selfies` carry their own `embedding` field. The erasure order
   must cover both shapes.

## Decision

### 1. One pure module per decision, one `defineCronJob` per job

`@/server/jobs/sweep-decisions` exports the six decisions, each taking its
instant as an argument and reading no clock:

```text
uploadWindowPoint({ uploadWindowEndsAt, now }) -> "t-72h" | "t-24h" | "closed" | null
retentionWarningPoint({ retentionExpiresAt, now, audience }) -> "t-14d" | "t-7d" | "t-3d" | "t-1d" | null
resolveEventStatus({ status, startAt, endAt, now }) -> "live" | "ended" | null
usageThresholdsToNotify({ percent, latched }) -> readonly number[]
nextEraseStep(marker) -> RetentionStep | null
verificationNudgePoint({ createdAt, completed, nudgesSent, now }) -> "t+24h" | "t+72h" | null
```

`RETENTION_STEPS` is the ordered erasure sequence: `storage`, `imageFaces`,
`faceMatches`, `eventImages`, `mediaAssets`, `selfies`, `profiles`.

`@/server/attendee/match-run` exports
`incrementalMatchRunKey({ eventId, profileId, selfieId, runAt })`, whose value is
`attendee.matches.new:<eventId>:<profileId>:<selfieId>:run:<runAt ISO>`. It
starts with the activation key `matchesNewDedupeKey(eventId, profileId,
selfieId)` and appends a run discriminator, so the second delivery can never be
swallowed by `domain_events_dedupe_unique` (ADR-0808 §3) and two runs for one
selfie are two deliveries.

Each job module exports one `CronJob` built by `defineCronJob`:

```text
@/server/jobs/pipeline-sweep          -> pipelineSweepJob           (2000 / 4000)
@/server/jobs/event-window-sweep      -> eventWindowSweepJob        (1000 / 2000)
@/server/jobs/retention-purge         -> retentionPurgeJob          (50 / 100)
@/server/jobs/usage-threshold-check   -> usageThresholdCheckJob     (2000 / 4000)
@/server/jobs/invitation-expiry       -> invitationExpiryJob        (1000 / 2000)
@/server/jobs/verification-nudge      -> verificationNudgeJob       (1000 / 2000)
@/server/jobs/account-deletion-purge  -> accountDeletionPurgeJob    (50 / 100)
```

The job modules are named exactly as the integration specs import them; the
`CronResult.details` keys each spec asserts are listed in §5.

### 2. The fire-window rule

A schedule point at `P` is due while `P <= now < P + runInterval`, where the
interval is the job's own cadence (1 h hourly, 24 h daily). The exact boundary
fires, one interval later does not, and 1 ms before does not. The specs pin both
ends of every point (`U1`) and the two audiences' point sets stay disjoint.

### 3. Latches are stored state, not in-memory flags

- **`usage-threshold-check`:** the latch is `thresholdsNotified: number[]` on the
  `usageCounters` row it reads. Because the row's identity is
  `{tenantId, entitlementKey, periodKey}`, a new period is a new row with no
  latch. `CronResult.details.notified` counts the run's deliveries.
- **`event-window-sweep`:** the delivery key is
  `event.upload_window.closing:<eventId>:<point>`, honoured by the outbox's
  unique partial index. A second run is deduped, so no separate latch field is
  needed.
- **`verification-nudge`:** the count is `userProfiles.verificationNudges`
  (number). The ladder is `verificationNudgePoint`, so the cap of 2 is pure and
  the job only increments what it delivered.

### 4. The erasure is ordered, counted and resumable

`retentionPurgeJob` handles every event whose `retentionExpiresAt < now` **or**
whose `status` is `deleting` — a user-initiated delete is never gated on the
retention clock, and its `retentionExpiresAt` may still be in the future. Per
event it writes one `retention.purge.step` info line per step, which is the DSR
evidence, and persists `event.purge = { step, counts, completedAt }`. **Two line
shapes**, and they are not interchangeable:

- an **erase step** (`storage` … `profiles`) logs `{ event, step, count }` — a
  single number: how many rows or objects that step removed;
- the two **job-level legs** log their own `retention.purge.step` lines with
  `{ event, step, counts }` — an object, because a leg bounds several
  collections at once (`expiredSelfies` → `{ selfies, embeddings, matches }`,
  `anonymousSessions` → `{ sessions, selfies, profiles }`).

- `step` is the **last completed** step, so `nextEraseStep` resumes on the next
  one; the final value is the sentinel `"done"`.
- `counts` is the per-step tally of rows **erased or deleted** and is merged
  across runs, so an interrupted run does not lose the earlier evidence.
- A `mediaAssets` row that still holds another reference (`refCount > 1`) is
  **not** erased, its object is **not** deleted, and it is **not** counted; the
  job decrements `refCount` instead.
- The event's own `selfies` (with their `embedding`) are erased by the
  `selfies` step and their profiles by the `profiles` step; consents are never
  touched — a `consents` row is the demonstrable record the DSR rests on, so the
  purge keeps it after every other row for the event is gone.
- Two job-level phases follow the events, each its own
  `retention.purge.step` line: `expiredSelfies` (an unconfirmed selfie past its
  own `expireAt`, with its embedding, its provisional `faceMatches` and its
  `mediaAssets` reference) and `anonymousSessions` (an expired
  `attendeeSessions` row's profiles and selfies). `details` carries
  `{ events, expiredSelfies, anonymousSessions }`.
- Storage objects are deleted through the `ObjectStorage` port
  (`originals` originals, the `thumbnails` derivative, and
  `originals/selfies/<contentHash>`).

### 5. The remaining behaviours the specs pin

- **`pipeline-sweep`:** four steps in order (expired leases → `queued` +
  re-enqueue; `queued` older than 5 min with no broker ack → re-enqueue;
  `attempts >= maxAttempts` → `failed` + one `pipeline.image.failed`; then the
  incremental run). `details = { requeued, failed, incremental }`. A selfie
  drains `q:selfie` at `high`; a requeued image is `kind: "event_image"` at
  `normal` priority, i.e. `q:image` — `queueKeyFor` owns the mapping, so the
  sweep never crosses the two; an incremental run is a `match_incremental`
  envelope whose `id` is the **profile** id. The run advances the profile's
  `lastMatchRunAt` to the run instant, which is what makes the next 2-minute
  tick silent.
- **`event-window-sweep`:** `closing` carries `{ hoursRemaining, mobile }` with
  `mobile: true` only at T-24h; `closed`, `startingSoon` and `ended` are the
  other three counters. **The status write is `resolveEventStatus`'s alone:**
  the T-24h run announces `event.starting_soon` and leaves a `published` event
  `published`; the status becomes `live` at `startAt` and `ended` at `endAt`,
  and only the terminal transition is announced (`event.ended`). The warning and
  the transition are therefore two separate schedule points, and the sweep
  writes no status it cannot derive from the clock.
- **`invitation-expiry`:** a `pending` row past `expiresAt` becomes `expired`
  and emits `collab.invite.expired`; the later
  `POST /api/v1/invitations/{token}/accept` answers `410 invitation_expired`.
  A still-pending invite past T+3d earns one `collab.invite.reminder`
  (`details = { expired, reminded }`).
- **`account-deletion-purge`:** the predicate is exactly
  `status: "deletion_pending"` **and** `deletionScheduledAt <= now`. The purge
  stamps `purgeStartedAt`, marks the profile `deleted`, **anonymizes** the
  account — the Better Auth `user` row keeps no `email` of its own and loses its
  `name`, and the profile's `displayName` and `avatarAssetId` are cleared —
  revokes the Better Auth `session` rows, retains the last known contact in the
  new platform-scope `accountDeletionTombstones` collection and emits one
  `account.deletion.completed` whose payload is exactly `{ userId }`. The
  tombstone is the **only** place the contact survives: no other document in the
  database may still hold the address.

## Rejected alternatives

- **A shared `@/server/jobs/compliance-jobs` barrel module.** The billing lane
  already shows the per-job module shape; one barrel would hide which job a
  failing import belongs to and would make the GREEN's diffs non-local.
- **Storing the usage latch in `domain_events` only.** A dedupe key alone
  cannot answer "what is latched this period" without a query per threshold, and
  the latch has to survive a threshold dropping and re-crossing. The counter row
  is already keyed by period, so the latch belongs beside the value.
- **A TTL instead of the ordered erasure.** §10.2 forbids it for a reason: the
  erasure must be countable for DSR evidence and must not race the warnings.
- **Deleting the shared `mediaAssets` row anyway.** The row is content-addressed
  and another event still serves those bytes; deleting it would blank a live
  event's gallery.

## Consequences

- The GREEN card carries the specs unchanged; its work is eight modules, one
  new platform collection (`accountDeletionTombstones`) and a `vercel.json`
  registration row per job.
- `pipeline-sweep`'s watermark write means a worker report that lands **before**
  the sweep sees `processing`, and the sweep then enqueues a run that the report
  already covered; the report's own `matchRunStartedAt` is the authority for the
  announcement key, so the two paths cannot double-announce (ADR-0808 §3).
- The `event-window-sweep` status write adds two values (`live`, `ended`) that
  the event DTO schema does not yet admit. The GREEN must widen that enum; no
  spec in this card asserts on the DTO, so the change is free.
- `imageFaces` becomes a name the erasure must know even though nothing writes
  it yet; the purge pins it by its §10.2 literal name.

## Evidence (RED)

_(The measurements below are from the first delivery; the corrected head's figures
are in "Review round 1" at the end, and the unit file now carries 76 cases.)_

Run in the worktree `t_b25b384f` (`wt/t_b25b384f`, cut from `main` `a8856bc2`):

- Without the intended modules: `Cannot find package
'@/server/jobs/sweep-decisions'` (unit) and `'@/server/jobs/pipeline-sweep'`
  (integration) — honest module-not-found red.
- With faithful throwaway stubs (`tsc -p apps/web/tsconfig.json --noEmit` exit
  `0`, stubs then deleted): unit **43 failed | 31 passed (74)** before the
  near-fix pass, integration **24 failed | 2 passed (26)**, every failure at
  assertion level: `expected 'processing' to be 'queued'`, `expected 'queued'
to be 'failed'`, `expected 'published' to be 'live'`, `expected 'pending' to
be 'expired'`, `expected 'deletion_pending' to be 'deleted'`, `expected [] to
deeply equal [ 'storage', 'imageFaces', …(5) ]`, `expected [] to have a
length of 1 but got +0`.
- **Near-fix pass (unit):** a correct implementation of the two pure modules
  made the file **74 passed (74)**, then three one-anchor mutations each
  reddened only their own pin, with the file restored afterwards:
  - the T-72h window's upper bound `now < P + 1 h` → `now <= P + 1 h` →
    `expected 't-72h' to be null` (1 failed);
  - the latch filter dropped (`!latched.includes(t)`) → 4 failed, including
    `expected [ [ 80 ], [], [ 80 ] ] to deeply equal [ [ 80 ], [], [] ]`;
  - the nudge cap `nudgesSent >= 2` → `>= 3` → `expected 't+72h' to be null`.
- The two integration passes under the **zero-value stub** are negative
  controls with no `details` assertion (a draft/archived event is left alone, a
  confirmed selfie inside its period is kept); they are named here rather than
  counted as red.
- `eslint` on the six new spec files and the new helper: 0 issues. `prettier
--check`: clean.

## Out of scope (routed, not pinned)

- `pipeline-indexed-check`, `upload-session-sweep` and
  `attendee-no-match-check` are in the GREEN card's scope notes but not in this
  card's test list; no spec pins them.
- The `vercel.json` registration row per job is config, not behaviour; the
  GREEN's write-up owns it.
- The **emission** of the run-discriminated `attendee.matches.new` stays with
  the worker/OP-135 transport; this card pins the key mint only.
- The `counter-reconcile`-class work ADR-0829 §6 handed to this lane is not in
  this card's list and stays open.

## Open questions (assumptions the GREEN may override with a note)

1. `imageFaces` has no registered collection and no writer. The erasure pins it
   by its §10.2 literal name; if the GREEN registers
   `COLLECTIONS.imageFaces`, the specs keep passing.
2. The contact that `account.deletion.completed` is addressed at is retained in
   `accountDeletionTombstones` (`{ userId, email }`). No shipped code names that
   collection, so the name is this card's decision.
3. `event.purge.counts` counts rows **erased**, not rows touched. The shared
   `mediaAssets` row is therefore absent from the tally although its `refCount`
   moved.

## Review round 1 — the corrections and their evidence

The reviewer's seven items are resolved without editing any implementation file
(the worktree ships no production code) and each corrected pin was re-measured.

| Item                                                                                      | Resolution                                                                                                                                                                                             | Pin                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 `account-deletion-purge` claimed anonymization, asserted none                          | §5 now names the rule: the `user` row keeps no `email` of its own and loses `name`; `userProfiles.displayName` and `avatarAssetId` are cleared; the tombstone is the only document holding the address | `job-account-lifecycle.test.ts` → _anonymizes the account, leaving the tombstone as the only copy of the email_ (a whole-database scan, `collectionsHolding`)        |
| F2 `status: "deleting"` and "consents survive" were stated, never seeded                  | §4 now says the `deleting` arm is not gated on the retention clock and that a `consents` row outlives every other row of its event                                                                     | two new cases: _purges an event in status deleting although its retention has not expired_, _keeps a consent row as evidence when its event is erased_               |
| F3 the integration case wanted `live` at T-24h, `resolveEventStatus` answers `null` there | **Rule chosen: (a) `live` at `startAt`.** The T-24h run announces `event.starting_soon` and moves **no** status; the transition is the pure function's alone (§5)                                      | the case is renamed and asserts `status === "published"` after the run; a new case _moves a published event to live once its startAt has passed_ pins the transition |
| F4 the requeued image envelope was pinned by `id` only                                    | §5 records the mapping (`queueKeyFor`: `normal` → `q:image`)                                                                                                                                           | I1 now asserts `queueKey === "q:image"` and `envelope.kind === "event_image"` — the repo's §10.4 kind literal is `event_image`, not `image`                          |
| F5 the row labelled "selfies done" passed `{ step: "profiles" }`                          | —                                                                                                                                                                                                      | the row now reads `{ step: "selfies" } → "profiles"`, and the terminal row is relabelled _profiles done_                                                             |
| F6 ADR typos                                                                              | `event-window-sweep`, `accountDeletionTombstones`, `account.deletion.completed`                                                                                                                        | —                                                                                                                                                                    |
| F7 `count` vs `counts`                                                                    | §4 now states both line shapes: erase steps log `{ event, step, count }`; the job-level legs log `{ event, step, counts }`                                                                             | —                                                                                                                                                                    |

The earlier 74/75 count discrepancy is resolved: the unit file had 75 cases and
the near-fix pass read `75 passed`; with the missing `selfies → profiles` row it
now has **76**.

### Re-measured (this worktree, at the corrected head)

- **Unit, faithful probe of the two pure modules:** `76 passed (76)`.
- **Unit, one-anchor mutation** (`nextEraseStep({ step: "selfies" })` → `null`):
  `1 failed | 75 passed (76)`, the failure being exactly
  _answers profiles for selfies done_ — F5's pin is load-bearing.
- **Integration, faithful probes of `event-window-sweep` and
  `account-deletion-purge`** (the other five jobs left as zero-value stubs):
  `9 passed | 1 failed (10)` — the single failure is the zero-stub
  `verification-nudge` (`expected +0 to be 2`). So F1's and F3's pins are
  satisfiable by the contract as written.
- **Mutation A** (`starting_soon` also writes `status: "live"`):
  `1 failed | 5 passed (6)` with `expected 'live' to be 'published'` on
  _announces event.starting_soon at startAt-24h and leaves the event published_.
- **Mutation B** (the purge leaves `user.email` in place):
  `expected [ 'accountDeletionTombstones', 'user' ] to deeply equal
[ 'accountDeletionTombstones' ]`.
- **Integration, zero-value stubs for `retention-purge` and `pipeline-sweep`:**
  `13 failed | 1 passed (14)`, every failure at assertion level, including the
  two new retention cases (`expected +0 to be 1`; `expected { …(9) } to be
null`). The pass is the negative control _keeps a confirmed selfie inside its
  retention window_.
- `tsc -p apps/web/tsconfig.json --noEmit` with the probes in place: exit `0`.
  The probes were then deleted with explicit `rm -f`; `git status --short` lists
  only the five spec files and this record.

Note for the GREEN: F2's consent pin does **not** require the erase to skip the
`profiles` step — consents live in `consents`, so "profiles deleted, consents
kept" is one query per collection, not a conditional.
