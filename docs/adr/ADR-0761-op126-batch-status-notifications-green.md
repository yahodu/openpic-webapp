# ADR-0761 — OP-126 GREEN: the batch read and the upload lifecycle emissions

- **Status:** Accepted
- **Date:** 2026-11-12
- **Card:** `t_78c7cfcf` (OP-126, `tdd_stage: GREEN`)
- **Lane:** OP-126 uploads lane — `0760`–`0779`, `Next free` → `0762`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_99f7d0b1`
- **Branch:** `OP-126-task-batch-status-notifications-green`, cut from the pins
  head `024f88a` of `OP-126-task-batch-status-notifications-red` (draft PR #433)
- **Consumes:** [ADR-0760](ADR-0760-op126-batch-status-notifications-red.md) (the
  pinned contract), [ADR-0721](ADR-0721-op124-single-put-complete-link-only-green.md)
  (the completion transaction), [ADR-0741](ADR-0741-op125-multipart-uploads-green.md)
  (the multipart path), [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox)

## Context

The pins fixed what §5.5 answers and when the couplings fire. Four things were
left to the GREEN: the shape of `upload_sessions.batchId` in a query, what
"a session that never completed" means once a pending session is still on the
wire, where the transition check is invoked besides the OP-136 cron, and the two
index names (ADR-0760 A5). The pins also forced one decision the ADR left open
implicitly: `failedUpload: 0` on a half-transferred batch (I1's live read).

## Decision

### D1 — `batchId` matches either stored shape

`upload_sessions.batchId` and `event_images.uploadBatchId` are written through
`batchIdValue(batchId)`, which keeps a 24-hex id as an `ObjectId` and a UUID as a
string; older rows and fixtures carry the 24-hex form as a plain string. Every
batch query therefore filters with `{ $in: [batchIdValue(batchId), batchId] }`
rather than re-spelling the conversion in one place and guessing in the other.

### D2 — `failedUpload` is aborted, failed, or expired — not merely unsettled

A `pending`/`in_progress` session is a file **still on the wire**: counting it as
a failed upload made a batch with one landed file out of three read `processing`
instead of `uploading` (the pin that failed first). So `failedUpload` counts a
session that cannot complete any more — `status` `aborted`/`failed`, or a
non-completed session past its five-day `expireAt` TTL. An abandoned session thus
moves the phase to `complete_with_errors` only when its window has closed, which
is also the fact the OP-136 stalled sweep will act on.

### D3 — One read composes the answer; the check reuses it

`@/server/uploads/batch-notifications` exports `readUploadBatch` (the eight-key
§5.5 body) and `checkUploadBatchTransition` (the phase plus the emissions), and
the check calls the same private snapshot the read builds. The route only
authorises, validates the `batchId` and returns the body, so a poll and a cron
tick can never disagree about a batch.

### D4 — The quota block is emitted where the refusal happens

`completeStoredUpload` is the one place both completion paths end, so the plan
refusal (`plan_limit_exceeded` / `payment_required` / `feature_not_available`) is
caught there, `upload.blocked.quota` is emitted best-effort (a broken outbox is a
`warn`, never a different HTTP answer) and the original error is rethrown
unchanged. The uploader is both actor and subject; the dedupe key is the event
plus a six-hour bucket, so a burst of refused files is one alert (§4.7).

### D5 — The transition is also checked after every completion

A completion leaves its own image `queued`, so it cannot by itself make a batch
terminal — but a replayed or duplicate completion can settle the last session
(the pins' seam is the direct call, ADR-0760 A1). `completeStoredUpload` therefore
calls the check after its commit inside a `try/catch` that only logs: a failed
check must not fail an upload that already committed. The cron (OP-136) remains
the primary trigger.

### D6 — The two indexes lead with `tenantId` where the lint demands it

`upload_sessions {eventId, batchId, status}` is added as declared.
`event_images` is a tenant-scoped collection whose compound indexes must lead
with `tenantId` (`indexes.test.ts`'s exception list is test-owned and this card
may not edit it), so the batch index is `{tenantId, eventId, uploadBatchId}` —
same selectivity for the read, and no exception to the lint.

### D7 — The §5.5 body is projected through a response schema

The route declares `batchStatusResponseSchema` with exactly the eight keys, so the
handler cannot leak an object key, a bucket or an upstream id by accident (§0.15,
§0.4).

## Consequences

- Two extra reads per completion (sessions + images) plus one outbox insert per
  distinct uploader on the terminal check. At a 3-second poll cadence this is
  noise; the index from D6 keeps the tally narrow.
- `files.total` counts `upload_sessions`, so a batch whose sessions were swept by
  the TTL monitor loses its history. Accepted: after five days the batch is
  neither polled nor summarised, and the images remain.
- An unseen `batchId` answers `complete` with `createdAt` = the read instant and
  emits nothing. The instant is the only defensible one when no session exists;
  it is not terminal state and no pin reads it.
- `duplicatesSkipped` and `rejected` stay `0` (ADR-0760 D3); the copy table stays
  the only source of user-facing failure text, so a worker's internal message can
  never reach an organizer.

## Alternatives rejected

- **Reconstructing `failedUpload` from "status !== completed"** — reads a
  half-transferred batch as finished; rejected by I1's live read.
- **Emitting the summary from the route** — the poll would then be the emitter and
  a client that stops polling would never be told; the check stays the only
  emitter.
- **Calling `emitDomainEvent` inside the completion transaction** — the outbox row
  would abort with a quota refusal, which is exactly the case the quota alert
  exists for.
