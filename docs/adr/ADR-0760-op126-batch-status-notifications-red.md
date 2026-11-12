# ADR-0760 — OP-126 RED: batch status and the upload lifecycle notifications

- **Status:** Accepted
- **Date:** 2026-11-11
- **Card:** `t_99f7d0b1` (OP-126, `tdd_stage: RED`)
- **Lane:** OP-126 uploads lane — `0760`–`0779`, `Next free` → `0761`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_99f7d0b1`
- **Branch:** `OP-126-task-batch-status-notifications-red` (based on the OP-125
  GREEN branch `OP-125-task-multipart-uploads-green`, head `0f894f0`, because
  PR #425/#430 are still open and this lane's completion path lives there)
- **GREEN child:** `t_78c7cfcf` (pre-created, gated on this card)
- **Consumes:** [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md)
  (`batchId` shapes), [ADR-0721](ADR-0721-op124-single-put-complete-link-only-green.md)
  (the completion transaction), [ADR-0741](ADR-0741-op125-multipart-uploads-green.md)
  (the multipart path), [ADR-0090](ADR-0090-op94-notification-fan-out-red.md)
  (the fan-out and its recipient port), [ADR-0029](ADR-0029-domain-events-outbox.md)
  (the outbox and `dedupeKey`)
- **Consumers:** the OP-126 batch-status route and the specs that pin it —
  modules `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/batches/[batchId]/route.ts`,
  `apps/web/src/server/db/indexes.ts`, `apps/web/src/server/uploads/batch-notifications.ts`,
  `apps/web/src/server/uploads/batch-status.ts`, `apps/web/src/server/uploads/complete-upload.ts`;
  specs `apps/web/src/test/integration/uploads-batch-status.test.ts`,
  `apps/web/src/test/unit/uploads-batch-status.test.ts`.

## Context

Contract §5.5 defines one read (`GET …/uploads/batches/{batchId}`) and four
notification couplings (§4.7's `upload.batch.completed`,
`completed_with_errors`, `files_rejected`, `upload.blocked.quota`), and says the
coupling is **enforced server-side, not client-side**. Nothing in the tree
derived a phase, composed the status answer, or emitted a batch summary: the
upload lane had sessions, images and a completion transaction but no batch
read-side and no lifecycle emission.

The card lists four integration cases and two unit cases. This ADR fixes the
contract they pin, because §5.5 leaves several things open: what `files.total`
counts, whether a rejection is a "failure" for the `completed` /
`completed_with_errors` split, which internal codes the `failures[]` copy
covers, and what actually makes two summaries for one batch.

## Decision

### D1 — One pure derivation, shared by the read and the transition check

`@/server/uploads/batch-status` exports `deriveUploadBatchPhase({files,
pipeline})` and the two count shapes. The route and the transition check both
call it, so a poll and a cron tick can never disagree about one batch. The rules:

1. `total > uploaded + duplicatesSkipped + rejected + failedUpload` →
   `uploading` (a file is still on the wire, even if the pipeline already
   reports a failure for another file).
2. else `pipeline.queued + pipeline.processing > 0` → `processing`.
3. else `failedUpload > 0 || pipeline.failed > 0` → `complete_with_errors`.
4. else → `complete`; an **empty batch is `complete`** and emits nothing (X4).

A **rejection is not a failure**: §5.5 prints `rejected` beside `failedUpload`,
and §4.7 defines `completed` as "zero failures" while
`upload.batch.files_rejected` is a separate summary that is folded into the same
one. `duplicatesSkipped` and `rejected` therefore settle a file without moving
the phase to `complete_with_errors`.

### D2 — The failure view is a table, and it never echoes the worker's error

`describeUploadFailure({code, message?})` returns `{code, message, retryable}`.
The message and `retryable` come from the table, never from
`processing.lastError`: that row is diagnostic data (`message`, `retryable`,
`status`) and a worker's internal text must not reach an organizer. An
unrecognised code collapses to `{code: "processing_failed", message: "This
photo could not be processed.", retryable: false}` — neither the internal code
nor its message survives. The pinned copy:

| Code                     | Message                                                            | Retryable |
| ------------------------ | ------------------------------------------------------------------ | --------- |
| `no_faces_detected`      | No faces were detected in this image.                              | no        |
| `unsupported_media_type` | This image's format could not be processed.                        | no        |
| `corrupt_image`          | This image file appears to be damaged.                             | no        |
| `timeout`                | Processing timed out. This image will be retried.                  | yes       |
| `provider_unavailable`   | Processing is temporarily unavailable. This image will be retried. | yes       |

### D3 — What the status answer counts

- `files.total` — the batch's `upload_sessions` count (one session per file the
  client asked to transfer). `files.uploaded` — the `event_images` the batch
  landed. `failedUpload` — a session that never completed. `duplicatesSkipped`
  and `rejected` read `0` until a writer records them: a duplicate completion
  and a `batch-resolve` rejection are not persisted as batch facts in v1, and
  this card does not invent a batch collection to carry them.
- `pipeline` — the batch's `event_images[].processing.status` tally over
  `queued` / `processing` / `done` / `failed`.
- `createdAt` — the earliest session `createdAt`; `completedAt` — the instant
  the phase became terminal, `null` before.
- `failures[]` — one entry per `failed` image, its `fileName` read from the
  session of that content hash, its `code`/`message`/`retryable` from D2's table.
- `stalledSessions[]` — `[]`; the 24-hour idle sweep needs a live `ListParts`
  and belongs to OP-136, so this read never calls the provider.
- The body's key set is exactly §5.5's eight keys — no object key, no bucket, no
  upstream id (§0.15).

### D4 — The summary is one outbox row per (batch, uploader)

`@/server/uploads/batch-notifications` exports
`checkUploadBatchTransition({db?, tenantKey, eventId, batchId})` →
`{phase}`. On a terminal phase it emits, **once per distinct
`upload_sessions.createdByUserId` of the batch**, `upload.batch.completed` or
`upload.batch.completed_with_errors` with a dedupe key that names the batch
**and** the uploader — that is what makes a jointly uploaded batch produce one
summary each (I4) and a re-check produce none (I1). The payload carries
`eventId`, `batchId`, `fileCount` (the batch's file count), `durationMs`
(earliest session → the check) and the `files` block, so §4.7's "email only if
≥100 files or >10 min" rule is decided by the resolver from the payload alone.

`upload.blocked.quota` is emitted when a completion is refused for a plan
reason (`plan_limit_exceeded` / `payment_required` / `feature_not_available`),
with the uploader as **both** actor and subject, `payload.eventId` and
`payload.batchId`, and a dedupe key scoped to the event and a six-hour bucket.
That pairing is what reaches both humans: the fan-out removes the actor from the
audience-resolved list (so the ORGANIZERS audience yields the organizer) and then
re-adds the subject, because `upload.blocked.quota` carries no dedupe template
(`resolveRecipients` + `subjectAlwaysNotified` in `@/server/notifications/fan-out`).

### D5 — Route and refusals

`GET /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batches/{batchId}` —
auth `user`, rate `read.normal`, `tenantStage({admission: eventActorAdmission(4)})`
(the event id is four segments from the end: `uploads`/`batches`/`{batchId}`
follow it). Unauthenticated → `401 authentication_required`; a signed-in
non-actor → `404` (never an oracle, §0.4); a `batchId` outside §5.2's two shapes
(24-hex or UUIDv4) → `422 validation_failed`, because it is client-generated
data rather than a route param that could name another resource.

## Assumptions

- **A1** — a completion leaves its own image `queued`, so the complete endpoints
  can never observe a terminal batch by themselves. The suite drives
  `checkUploadBatchTransition` directly (the seam OP-136's
  `pipeline-indexed-check` calls) and does not assert _where else_ it is
  invoked; the endpoints may call it harmlessly.
- **A2** — the fan-out's recipient port reads the literal `eventMembers`
  collection (ADR-0090's known gap: the membership read is not in
  `COLLECTIONS` yet). The I3 fixture seeds both `eventMembers` (for the
  audience) and `event_organizers` (for admission).
- **A3** — `durationMs` is measured against the wall clock at the check, so the
  12-minute-old batch is pinned as a window (11–13 minutes), not a millisecond.
- **A4** — the batch read does not create a batch row; an unseen `batchId` is an
  empty, complete batch.
- **A5** — the GREEN owes the `{eventId, batchId, status}` index on
  `upload_sessions` (and `{eventId, uploadBatchId}` on `event_images`); the
  index name is a GREEN decision and is not pinned here.

## Consequences

- The read is O(sessions + images) with one asset lookup per failed image; a
  500-file batch with many failures does a small fan of point reads. Acceptable
  at the 3-second poll cadence; a batch read that needs to scale folds the
  failure `fileName` into the session projection instead.
- `duplicatesSkipped` and `rejected` stay `0` until a batch-fact writer exists.
  The status contract is honest about that rather than reconstructing the counts
  from session state that does not record them.
- Because the dedupe key names the uploader, a third organizer joining a batch
  after it went terminal gets their own summary on the next check — intended:
  they are being told about a batch they contributed to.
- `docs/adr/README.md` is the shared ledger hotspot: this card adds the
  `OP-126 uploads lane` row (`0760`–`0779`, `Next free 0761`) and advances the
  `unallocated (future lanes)` pool to `0780`+.

## Number allocation

This lane had no reserved range on `main`, so — as its first card — it drew the
next block from the allocator's `unallocated (future lanes)` pool: **`0760`–`0779`**.
`0760` is consumed by this RED ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
§7); the cell now reads `0761` and the pool `0780`+. No number outside
`0760`–`0779` is touched.
