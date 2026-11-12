# ADR-0762 — OP-127 RED: event image management (list, hide, delete, reprocess)

- **Status:** Accepted (RED pins; the implementation is the gated GREEN `t_fd02050b`)
- **Date:** 2026-11-12
- **Ticket:** OP-127 — _event images management_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_93217b87` (RED), branch `OP-127-task-event-images-management-red`,
  worktree `/root/openpic/openpic-webapp/.worktrees/t_93217b87`
- **Base:** the OP-126 GREEN head `3f17938` (the lane chain OP-123 → OP-126 is unmerged, so
  this branch carries every uploads module it consumes; the GREEN must base on **this**
  branch, never bare `origin/main`)
- **Consumes:** contract §4.4, §5.6, §0.8, §0.14 C6, §0.15; schema §16.1–§16.3, §17.5,
  §18.2; CONVENTIONS §8.1
- **Supersedes:** nothing

## Context

OP-127 is the curation surface of the uploads lane: the organizer browses the event's
images, hides one, deletes one, and reprocesses the ones the pipeline failed. The listing
route already exists as OP-124's deliberately minimal `GET …/images` (`shortcut: no cursor,
no filters, no signed thumbnail URLs (§4.4); upgrade when the gallery UI lands`), and the
four mutations do not exist at all. This card writes the pins only.

## Decision

The executable contract is the three spec files. Their module headers carry the full
statement; this ADR records the decisions the card left open.

### D1 — the pure seams

- `@/server/images/filters` → `buildEventImageListFilter(params)` returning
  `{ filter, sort }`. The base clause is always `{ eventId, deletedAt: null }` and the
  default order is `{ sequence: -1, _id: -1 }` (§0.8's compound key, indexed by
  `{eventId:1, sequence:-1}`). `status` narrows `processing.status`; `visibility`,
  `uploadedBy` (an `ObjectId`) and `batchId` narrow their own fields, the last matching
  **both** stored shapes (`$in` of the `ObjectId` and the string, per `batchIdValue`).
  A cursor adds the compound `$or` (`$lt`/`$gt` with `_id` as the tiebreaker) and a `c`
  that is not a decimal integer is `400 invalid_cursor` — never a silent full scan.
- `@/server/images/reprocess` → `resetProcessingForReprocess(current, now)`. Zeroes
  `attempts`, clears `lastError`/`finishedAt`/`durationMs`/`startedAt`/`leaseExpiresAt`/
  `workerId`/`queueRef`, re-stamps `queuedAt`, and **preserves** `maxAttempts`, `priority`
  and `modelKeys` (a reprocess buys a fresh attempt budget, not a wider one, and never
  changes the model).

### D2 — the routes and their admission

`GET …/images` and `POST …/images:reprocess-failed` read the event id two segments from the
end, `PATCH/DELETE …/images/{imageId}` three, `POST …/images/{imageId}/reprocess` four, so
the nested tenant routes hand `tenantStage` the matching `eventActorAdmission(2|3|4)`.
`PATCH` and `DELETE` add `requireEventRole(…, ["organizer","co_organizer"])` (§4.4), which
is what makes an active workspace member's `200` read and `403` mutation pair coherent.

### D3 — the list projection is the §4.4 item **only**

`data[].` = `id`, `sequence`, `thumbnailUrl`, `thumbnailUrlExpiresAt`, `width`, `height`,
`orientation`, `bytes`, `contentType`, `faceCount`, `visibility`,
`processing.{status,attempts,finishedAt,durationMs,lastError}`, `uploadedByUserId`,
`uploadBatchId`, `createdAt`. No `assetId`, no `objectKey`/`locationKey`/`bucket`/`_id`
(§0.15). The thumbnail is a §5.6-signed `thumbnail` derivative
(`https://pic.openpic.in/t/<contentHash>.<format>?exp&sig`, 24 h) and is **nullable**,
because a just-completed upload has no derivative yet (OP-124's e2e reads that page and
expects the queued item). `thumbnailUrlExpiresAt` is whole-second floored by the signer,
so the TTL bracket allows one second of slack.

### D4 — the summary mixes counters and a tally

`total`/`done`/`failed` are the event's cached counters (`imageCount`,
`processedImageCount`, `failedImageCount`) with `approximate: true`; `queued`/`processing`
are a live tally. The only invariant pinned is
`total === done + failed + queued + processing`, so a nightly counter drift cannot fail the
pin while a swapped bucket would.

### D5 — delete is one transaction with four effects

Soft-delete the join row (`deletedAt`), `refCount - 1` on the asset (purged only at `0`, by
a job), `counters.imageCount - 1` and `counters.storageBytes - bytes` on the event, and
`releaseEntitlement(txn, tenant, "storage.bytes", bytes)` for the tenant meter (§0.14 C6 —
which is why I3 seeds both a plan and the `usageCounters` row: `releaseCounter` never
upserts, and a missing spec makes the release a no-op that would pass vacuously).
`processedImageCount`/`failedImageCount` are deliberately **not** pinned: the nightly
counter-reconcile owns them, and pinning either would fail a legitimate implementation.

### D6 — "removed from matched attendees' galleries" is the match rows

I6 seeds two profiles (2 faces and 1 face on the deleted image, plus one surviving image
for the first profile) and asserts the image's `face_matches` rows are gone, the surviving
image's row is untouched, and each profile's cached `matchCount` fell by the number of rows
removed (3 → 1 and 1 → 0). The event's `counters.matchCount` is left to the reconcile.

### D7 — hiding writes only `event_images.visibility`

Hide is reversible and §6.5's gallery joins the image, so D7 pins **state**, not match
rows: after `PATCH {visibility:"hidden"}` the row keeps `deletedAt: null`, the
attendee-facing predicate (`{visibility:"visible", deletedAt:null}` — the gallery join and
the §5.6 signed-URL gate) selects nothing, the organizer still finds it with
`?visibility=hidden`, no `face_matches` row moves (all `hiddenAt` stay `null`) and
`matchCount` is unchanged; unhiding restores the predicate. **F1** records the boundary.

### D8 — `409 not_failed` is a new media code the GREEN owes

It is appended to `MEDIA_ERROR_CODES` and `MEDIA_ERROR_TRANSPORT` (`409`, non-retryable) in
the append-only shape of `upload_window_closed`/`size_mismatch`/`parts_missing`. The probe
added and then removed exactly that entry.

### D9 — `202` bodies

The single-image reprocess answers `202` with the updated §4.4 item (so the client re-renders
from one call); the bulk route answers the contract's exact `{ requeuedCount }`.

## Evidence

- **RED (delivered state).** No implementation: `tsc -p apps/web/tsconfig.json --noEmit`
  reports exactly the imports of the missing modules, each unit suite dies on
  `Cannot find package '@/server/images/filters'` / `'…/images/reprocess'` and the
  integration suite on
  `Cannot find package '@app/api/…/images/[imageId]/route'` (three missing route modules).
- **Type-correct probe.** With two pure stubs and three `500` route stubs
  `tsc` exited `0`, and the suite failed at assertion level: unit **18 failed (18)**,
  integration **17 failed | 3 passed (20)** — the three were the existing minimal list
  route's `401`/`404` and the scanner check, which is why I5 was then strengthened with a
  signed-URL shape assertion (`expected undefined to match …`) so the leak pin discriminates
  the new `thumbnailUrl` surface instead of passing on the pre-existing projection.
- **Satisfiability probe (throwaway).** A faithful near-fix of all six modules (two pure,
  four routes) turned the suite **unit 18/18 and integration 20/20 green**; every probe file
  was then deleted, `git status --short` shows the three spec files only, and the restored
  list route is byte-identical to the branch's (`sha256 94edab90…`).
- One real test bug was found and fixed by the probe: the signer floors `exp` to whole
  seconds, so the 24 h bracket needed a one-second slack (`expected 1794532028000 to be
greater than or equal to 1794532028611`).
- **Re-verified at the delivered head (`1b48c44`), independent of the probes above.**
  `tsc` printed exactly the five `TS2307` lines and no other diagnostic; with a
  pass-through `resetProcessingForReprocess`, an empty `buildEventImageListFilter` and
  three `501` route stubs the suites failed at assertion level — unit
  **17 failed | 1 passed (18)** (the pass is the `maxAttempts`/`priority`/`modelKeys`
  preservation case, which a pass-through satisfies by construction) and integration
  **18 failed | 2 passed (20)** (the two passes are the pre-existing OP-124 list route's
  `401`/`404`). Stub shapes differ from the earlier probe, so the pass counts differ; the
  discriminating pins behave the same. All stubs were deleted afterwards and
  `…/images/route.ts` re-hashed to `sha256 94edab90…`.

## Open items handed to the GREEN / later lanes

- **F1 — the signed-URL half of I7 is pinned as state, not as a request.** `POST
/media/signed-urls` (§5.6) is OP-128's; this suite fixes the predicate it must apply
  (`visibility: "visible"` **and** `deletedAt: null`) at the data boundary. OP-128 must not
  authorize a hidden image merely because a `faceMatches` row exists.
- **F2 — hide does not decrement any count.** `summary`/`matchCount` still include a hidden
  image's matches; §6.5's `hiddenCount` counts attendee-hidden _matches_, not
  organizer-hidden images. If product wants a hidden count, that is a contract change.
- **F3 — `not_failed` message text is the GREEN's.** Only the code, status and
  non-retryability are pinned.
- **F4 — the archive route (`POST …/images/originals:archive`) is out of scope.** It needs
  OP-133's `downloadJobs` collection, and it is absent from this card's test list.
- **F5 — a re-upload of a deleted image** still collides on the unique
  `{eventId, assetId}` pair, so OP-124's completion answers `200` with the soft-deleted
  row. Unexercised here; a follow-up should decide whether a delete-then-reupload resurrects
  the row.
- **F6 — `limit` default.** §4.4's page example shows `60`, §0.8's global default is `40`;
  the pins never omit `limit`, so either choice stays legal. The GREEN should use `60`
  (`parsePageQuery(params, { defaultLimit: 60 })`).
- **F7 — `uploadedBy` accepts any string** in `buildEventImageListFilter`; the route must
  reject a non-24-hex value as `422 validation_failed` before the `ObjectId` cast (a cast
  of garbage throws a driver error, i.e. a `500`).

## Number allocation

`0762` is the next free number of the **OP-126 uploads lane** row (`0760`–`0779`), which the
OP-126 GREEN left at `0762`; this card advances it to `0763`. The alternative — drawing a
fresh `0780`–`0799` block from the `unallocated (future lanes)` pool because OP-127 has no
row of its own — was rejected: the uploads lane still holds 18 unused numbers and
fragmenting the ledger would double-book the pool's `0780` cell later. No number outside
`0760`–`0779` is touched.
