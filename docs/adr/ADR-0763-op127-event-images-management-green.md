# ADR-0763 — OP-127 GREEN: event image management implemented

- **Status:** Accepted
- **Date:** 2026-11-12
- **Ticket:** OP-127 — _event images management_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_fd02050b` (GREEN), branch `OP-127-task-event-images-management-green`,
  worktree `/root/openpic/openpic-webapp/.worktrees/t_93217b87`
- **Base:** the OP-127 RED head `615da3a` (itself on the OP-126 GREEN `3f17938`; the uploads
  lane OP-123 → OP-126 is unmerged, so this branch carries every module it consumes)
- **Consumes:** contract §4.4, §5.6, §0.8, §0.14 C6, §0.15; schema §16.1–§16.3, §17.5,
  §18.1–§18.2; CONVENTIONS §8.1
- **Supersedes:** nothing (implements [ADR-0762](ADR-0762-op127-event-images-management-red.md))

## Context

The RED pinned the curation surface: the listing filters and cursor, the reprocess reset, the
list projection, the four mutations and the 401/404/403 ladder. This card turns those pins
green with no test change. Three things the pins did not state on their face are decided
here.

## Decision

### D1 — two DTOs, not one widened DTO

The §4.4 list item and OP-124's completion answer are **different projections**. The
completion answer (11 keys including `assetId`, a two-key `processing`) is pinned by
`uploads-multipart.test.ts:1157`; the list item (15 keys, no `assetId`, a five-key
`processing`) is pinned here. So the list projection lives in
`@/server/images/dto.ts` (`toEventImageListItem`, `eventImageListItemSchema`) and
`@/server/uploads/event-image-dto` is untouched. Narrowing the shared projection would
redden OP-125.

### D2 — `thumbnailUrl` is nullable in the contract, because the pin is right

`docs/API Contract.md`'s `interface EventImage` declared both thumbnail fields non-null, but
I1 pins `null` for an asset with no derivative — which is the real state of a just-completed
upload (OP-124's e2e reads that page while the pipeline is still queued). The TS block now
says `string | null` / `IsoDateTime | null` with the reason inline. No pin changed; a pin
change would need a new RED card.

The URL itself is minted per item by the §5.6 signer over the `thumbnail` derivative
(`/t/<contentHash>.<format>`, 24 h), from the asset's `contentHash` and the derivative's
`format` — never a storage coordinate (§0.15).

### D3 — the summary's only invariant is structural

`done`/`failed` are the event's cached counters (`processedImageCount`/`failedImageCount`);
`queued`/`processing` are a live `countDocuments` tally over the event's live images; and
`total` is their **sum**, so `total === done + failed + queued + processing` holds by
construction rather than by luck. `approximate: true` is what tells the client the figures
are not a transactional read. A counter drift therefore shows as an approximate total, not
as a violated invariant — which is exactly what the pin asserts.

### D4 — delete is one transaction, and the counters are nested

Soft-delete `event_images` (`deletedAt`), remove the image's `face_matches` rows and
`$inc` each affected profile's `matchCount` by the number of rows removed, `refCount - 1` on
the asset (purged only at `0`, by a job — `status` is untouched), and
`$inc {"counters.imageCount": -1, "counters.storageBytes": -bytes}` on the event, then
`releaseEntitlement(session, tenant, "storage.bytes", bytes)` for the tenant meter (§0.14 C6).

The one trap worth recording: the event counters are **nested under `counters`**, so a
top-level `$inc {imageCount: -1}` matches the document, reports `modifiedCount: 1` and
changes nothing. The first implementation did exactly that and I3 caught it.

`processedImageCount`/`failedImageCount` are deliberately not moved: the nightly
counter-reconcile owns them (ADR-0762 D5).

### D5 — hiding writes only `visibility`

`PATCH` sets `event_images.visibility` and answers the updated §4.4 item. No match row, no
cached count and no `deletedAt` changes, so unhide restores delivery with no re-match — the
pin that makes "hide is not delete" load-bearing.

### D6 — `409 not_failed` is appended, never inserted

`not_failed` is appended to `MEDIA_ERROR_CODES` and `MEDIA_ERROR_TRANSPORT` (409,
non-retryable) in the append-only shape of `upload_window_closed`/`size_mismatch`/
`parts_missing`. The single-image route refuses anything whose durable
`processing.status !== "failed"` **before** the reset or the enqueue, so a refused
`POST` leaves no work item (I2 asserts the queue is empty).

### D7 — `uploadedBy` is validated before the cast, in the builder

ADR-0762 F7: `new ObjectId("garbage")` is a driver error, i.e. a `500` on client-controlled
input. The 24-hex check lives in `buildEventImageListFilter` — the function that performs
the cast — so the rule cannot be bypassed by a second caller, and it surfaces as the same
`422 validation_failed` the route would throw. The `cursor` gets the same treatment
(`c` decimal, `i` 24-hex) and answers `invalid_cursor`, the pin already fixes that shape.

### D8 — the list defaults and ordering

`parsePageQuery(params, { defaultLimit: 60 })` (F6), default order
`{sequence: -1, _id: -1}` over the `{eventId: 1, sequence: -1}` index, `sequence_asc`
flipping both keys, and the §0.8 compound `$or` for the cursor. A `batchId` matches both
stored shapes (`$in` of the `ObjectId` and the verbatim string).

### D9 — reprocess is a pipeline retry, shared by both routes

`requeueImages` resets each row via `resetProcessingForReprocess` (durable write **first**),
then calls `enqueueWork` per row, so a broker failure leaves a `queued` row the sweep picks
up (§18.1) — never a lost image and never a failed request. The single route answers `202`
with the re-read §4.4 item (the enqueue wrote `processing.queueRef`, which the wire
projection does not carry); the bulk route answers the contract's exact `{ requeuedCount }`
and is scoped to this event's live `failed` images only.

## Out of scope (handed forward)

- **F4 — `POST …/images/originals:archive` is not built.** It needs OP-133's `downloadJobs`
  collection and no pin in this lane touches it, so building it now would be untested code
  against a collection that does not exist yet.
- `?preview` derivative, `counters.matchCount` reconciliation and a hidden-image count
  (§6.5 counts attendee-hidden _matches_) stay with their own cards.
- Unexercised by the pins, implemented as the only sound reading: a soft-deleted image is
  `404` on `PATCH`/`DELETE`/`reprocess`, and the reprocess `priority` mapping treats
  anything but `high` as `normal`.

## Number allocation

`0763` is the value the OP-127 RED left in the **OP-126 uploads lane** row (`0760`–`0779`);
this card uses it and advances the cell to `0764`. No number outside that range is touched.

## Evidence

- `tsc -p apps/web/tsconfig.json --noEmit` → clean.
- The three pinned specs: unit **18/18**, integration **20/20**.
- Full suites: unit **156 files / 2502 passed | 3 skipped**; integration **103 files / 1001 passed**
  (the lane's own 20 cases plus no regression across the other 102 files); ADR-numbering guard 29/29.
- `npm run test:coverage` → exit 0: statements 91.7 %, branches 80.08 %, functions 96.08 %, lines
  91.91 % (global thresholds 80 %; `services/**`/`domain/**` 90 % untouched).
- `npm run lint` and `npm run format:check` clean on every touched file.
- `PR Checks` on PR #436: `ci` (typecheck, lint, unit, integration, coverage, build, Playwright E2E),
  `audit`, `audit-dev`, `secret-scan`, `env-changes` and the branch/title guards all pass.
- One honest correction was made in this card (D4's nested `$inc`), found by I3 before the suite went
  green; a later refactor folded the builder's duplicated sort-direction expression into one value.
