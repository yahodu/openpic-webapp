# ADR-0855 — OP-136 GREEN: the indexed check derives from the status table, latches on the event, and drives the OP-126 batch arm

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-136 GREEN `t_16239628` (High; branch
  `OP-136-task-indexed-check-matrix-latch-batch-green`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_16239628`). Pins: TEST
  `t_7e31328b` ([ADR-0852](ADR-0852-op136-indexed-check-matrix-latch-batch-pins.md));
  findings F1/F2 of the review of the GREEN `t_d18a6e9e` (PR #625, squash
  `c7628400`).
- **Implements:** contract §10.2 (the `pipeline-indexed-check` row — "Events
  where all queued images reached a terminal state → mark indexed"), §4.1 (the
  pipeline-status table), notification design §4.7 (`pipeline.event.indexed`:
  "Email on first completion per event only"), schema §15.1 (`events`),
  §16.2 (`upload_sessions`), §16.3 (`event_images`).
- **Consumes:** [ADR-0852](ADR-0852-op136-indexed-check-matrix-latch-batch-pins.md)
  (the eight pins this change makes true, carried byte-identically),
  [ADR-0849](ADR-0849-op136-jobs-red.md) §1 (the `defineCronJob` declarations
  and the `SweepJobRunOptions` seam),
  [ADR-0850](ADR-0850-op136-jobs-green.md) (the job's first delivery),
  [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) §A1 (this cron is
  named as a caller of `checkUploadBatchTransition`),
  [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox and
  `FORBIDDEN_PAYLOAD_KEYS`).
- **Number allocation:** the lane row `OP-136 jobs lane` read `0853` at this
  head, but the sweep before minting found `ADR-0853` on
  `origin/OP-136-task-sweep-failure-windows-pins` (cell `0854`) and `ADR-0854`
  on `origin/OP-136-task-usage-elapsed-period-pins`, so neither was free. This
  record takes **`0855`** — the highest record on any surface plus one — and
  advances the lane cell to `0856`; the two pool cells stay `0869`. No number
  outside `0849`–`0868` is consumed. `ADR-0854` merged into the trunk as
  `d5830902` while this branch was in review, moving the trunk's cell to
  `0855`; the pre-push sweep still found no `ADR-0855*` on any surface, and the
  merged tree keeps the cell at the higher value (`0856`).

## Context

`apps/web/src/server/jobs/pipeline-indexed-check.ts` decided "indexed" with a
local arithmetic, `processedImageCount + failedImageCount >= imageCount`
(`:78`), which collapses the §4.1 status table: `indexed`, `delayed` and
`partial_failure` all satisfy it, so an event whose photos **all failed** was
announced as "Event is fully searchable". It carried an absolute six-hour
bucket in its dedupe key (`:72,91`), so a terminal event re-announced once per
bucket for ever, and no per-event marker existed — §10.2's "mark indexed" was
never written. Its payload carried no first-completion discriminator, so §4.7's
"email on first completion per event only" had no input to read. And it never
called `checkUploadBatchTransition`, so a batch the **worker** settled (no
completion route ran) emitted no §4.7 summary, although ADR-0760 §A1 names this
cron as its caller. ADR-0852 measured all three at `7d986972`.

## Decision

### 1. The status comes from the shipped table

`derivePipelineStatus` (`@/server/events/pipeline`, contract §4.1, the same
function `GET …/events/{id}` serves) decides the state from the event's three
counters, and only the derived `indexed` state is announced. The job keeps no
second copy of the arithmetic, so `delayed` and `partial_failure` can never be
announced as searchable.

### 2. The latch is `pipeline.indexedNotifiedAt` on the event

The candidate query stays `counters.imageCount > 0` (the batch arm needs the
latched events too, see §3), and the loop skips an event whose
`pipeline.indexedNotifiedAt` is set. After an emit the job writes the marker
with the injected clock. The dedupe key loses its bucket and becomes the stable
`pipeline.event.indexed:<eventId>`, so even a racing or replayed run cannot
write a second row. The marker is the "first completion" discriminator: because
a latched event is never announced again, the announcement that is emitted is
its first, and it carries `notifyByEmail: true` — the key name agreed with the
pins, since `FORBIDDEN_PAYLOAD_KEYS` refuses a payload key named `email`. A
later completion is therefore suppressed entirely, which ADR-0852 §3 allows.

### 3. The OP-126 batch arm runs for every scanned event

For each candidate event the job reads the distinct `event_images.uploadBatchId`
through the **tenant-scoped** repository (`tenantRepo(row.tenantId)`), so no
cross-tenant scan is opened, and calls `checkUploadBatchTransition` once per
batch. `event_images.uploadBatchId` is the discovery route because a batch whose
worker-settled images exist always has those join rows; a batch that was
entirely duplicates has only its sessions and settles from the completion route.
The arm is bounded by the same `limit` as the scan (per-event reads and one
overall `slice`), and its count is reported as `details.batches`. It runs for
`indexed`, `delayed` and `partial_failure` events alike — the card's scope is
"the batches of each candidate event" — and the summary's own
`(batch, uploader)` dedupe key makes a re-run emit nothing.

## Evidence

- The eight pins of ADR-0852 are green: `vitest run --project integration
apps/web/src/test/integration/job-pipeline-indexed-check.test.ts` → `8 passed
(8)`, with the spec byte-identical to the pin branch (no test, fixture, helper
  or pin assertion edited; the diff's test files are exactly the pin files).
- `vitest run --project unit` → `184 files / 3077 passed | 3 skipped`, and the
  full `integration` project green.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 on the touched
  paths; `prettier --check` clean; the six ADR guards `236 passed` on the
  merged tree.
- The combined run CI performs —
  `vitest run --project unit --project integration --coverage` — is green at the
  merged head: `322 files / 4520 passed | 3 skipped`, statements `91.55 %`,
  branches `80.26 %`, functions `95.95 %`, lines `91.67 %`, so the configured
  global threshold holds (the trunk's branch figure was `80.09 %`).
- The behaviour is load-bearing per ADR-0852's own probe table (the trunk's
  collapsed criterion reddens I1–I3, no latch reddens I4, no flag reddens
  I5/I6, an empty batch arm reddens I7/I8), measured against this job.

## Assumptions

- **A1** — "later completion" is an event whose counters grew after its first
  announcement. The latch suppresses that announcement; no pin asks for a
  second row without the flag.
- **A2** — a batch whose only rows are `upload_sessions` (every file a
  duplicate) settles from the completion route, not from this arm.
- **A3** — the marker is an operational field of the job, not part of the event
  API's payload; `pipeline` is where §15.1's cache-shaped, job-owned additions
  live beside `counters`.

## Consequences

- The announcement now agrees with the status the event detail serves, and it
  is sent once per event for the life of the event.
- A future change to the §4.1 table moves this job with it, because the job
  reads the table instead of re-deriving it.
- The batch arm is reachable for terminal events that are not announced
  (`delayed`, `partial_failure`), which is the behaviour the follow-up TEST card
  `t_71729b5e` pins; it was unpinned when this change shipped.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, this note and the
  lane cell merge as a union keeping the highest cell (`0856` lane,
  `0869` pool).
