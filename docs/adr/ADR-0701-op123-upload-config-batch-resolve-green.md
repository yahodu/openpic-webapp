# ADR-0701 — OP-123 GREEN: the upload pre-check implemented — the pure resolver, `GET /uploads/config`, `POST …/uploads/batch-resolve`, and the `409 upload_window_closed` append

- **Status:** Accepted · **Date:** 2026-11-11
- **Card:** OP-123 GREEN (`t_08447abd`) · **Branch:** `OP-123-task-upload-config-batch-resolve-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_28054285`, based on the RED head `228fdfb` (branches `OP-123-task-upload-config-batch-resolve-red`, draft PR #420)
- **Relates to:** [ADR-0700](ADR-0700-op123-upload-config-batch-resolve-red.md) (the pins this record turns green), [ADR-0009](ADR-0009-upload-type-guards.md) (the extension/MIME table the claim guard reuses), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the advisory quota), [ADR-0580](ADR-0580-op112-object-storage-port-red.md)/[ADR-0581](ADR-0581-op112-object-storage-port-green.md) (the `ObjectStorage` port and `ListParts`), [ADR-0644](ADR-0644-op119-review-round1-green.md) (the event-scoped admission seam), [ADR-0541](ADR-0541-op114-branding-upload-green.md) (the per-domain error-table append shape)

## Context

ADR-0700 pinned the executable contract: one pure decision module, the config
endpoint and the batch-resolve endpoint, with four unit cases (U1–U4) and six
integration cases (I1–I6). This record notes the choices the implementation had
to make where the pins left the shape free, and records the two ledger additions
the GREEN owed.

## Decisions

### D1 — the pure module is exactly the pinned surface

`@/server/uploads/batch-resolve` exports `MAX_BATCH_FILES`, `isValidBatchId`,
`quotaSufficiency`, `resolutionFor` and the four types, and nothing else. The
rejection copy is one `as const` table keyed by the four reasons, so the exact
strings U1/U4 pin live in one place. The claim guard reads the extension table
through `UPLOAD_FORMATS` (`@/server/settings/upload-guards`) rather than a copy,
which is what makes `.NEF` + `image/tiff` and `.heic` + `image/heif` pass.

`batchId` is `24-hex any case` **or** `UUIDv4 any case`; the UUID pattern pins
version `4` and variant `[89ab]`, so `…-1f6b-…` is refused (U3).

### D2 — the two API modules carry only reads

- `GET /api/v1/uploads/config` (`defineRoute`, `auth: userAuth()`) answers the
  eight §5.1.1 keys: `multipartThresholdBytes`, `maxFileBytes` and
  `supportedMimeTypes` from `platformSettings.upload`; `partSizeBytes`
  8 388 608, `maxBatchSize` 500, `presignTtlSeconds` 900, `maxConcurrentParts`
  4 and `hashAlgorithm: "sha256"` fixed. `Cache-Control: private, max-age=300`.
- `POST …/events/{eventId}/uploads/batch-resolve` runs the same pipeline with
  `rateLimitIdentity` on the `upload.resolve` class (a **per-user** class, so it
  must key on the authenticated principal after `auth`, not on the pre-auth IP
  fallback, which has no identity to key on), and `tenantStage({ admission:
eventActorAdmission(3) })`.

### D3 — the admission seam gained an offset, not a second copy

`admitEventActor` already read the event id two segments from the end, which is
right for `…/events/{id}` and `…/events/{id}/members`; this path is
`…/events/{id}/uploads/batch-resolve`, i.e. **three** segments from the end.
`admitEventActor` takes an optional `segmentFromEnd` (default `2`, so the
members route is untouched) and `eventActorAdmission(n)` adapts it to the
`TenantAdmission` shape. All of `current` resolution, the `X-Tenant-Id` echo and
the single logged `404` stay in `tenantStage`.

### D4 — `409 upload_window_closed` is appended through the media table

`MEDIA_ERROR_CODES` gains `upload_window_closed` and `MEDIA_ERROR_TRANSPORT`
its `409`, non-retryable row — never `ERROR_CATALOG`, which stays the exact base
Appendix A copy (ADR-0540 shape). The refusal carries
`details.uploadWindowEndsAt` (the stored instant, ISO) and `details.canExtend`
(`true` only for the event's `organizer`, resolved through
`resolveEventActorRole`; a co-organizer or tenant member cannot extend).
`uploadWindowEndsAt === null` is the unlimited window and never closes.

### D5 — the reads, and why each is scoped the way it is

`Promise.all` reads `media_assets` by `{tenantId, contentHash: {$in}}` and
`upload_sessions` by `{tenantId, createdByUserId, contentHash: {$in}, status:
{pending, in_progress}}`; the tenant scope is the repository handle's own
injection, and `createdByUserId` is the per-user half (I1/I6). The
`event_images` link read follows, scoped to this `eventId` and the asset ids the
first read returned. `uploadedPartNumbers`/`uploadedBytes` come **only** from a
live `getObjectStorage().listParts(...)` answered for the session's
`externalRefs` multipart id, with the content-addressed key from
`buildObjectKey(hash, <canonical MIME extension>)`; a listed failure throws
`502 bad_gateway` for the whole call (A9). `COLLECTIONS.uploadSessions =
"upload_sessions"` is registered so the read names the schema's collection.

### D6 — the quota is advisory and consumes nothing

`checkEntitlement(tenantId, "storage.bytes", 0)` (tenant scope) and
`checkEntitlement(tenantId, "images.per_event", 0, { counts:
event.counters.imageCount })` (event scope) are called with amount `0`: the
pre-check asks "how much remains", never "may I consume". `remaining` is
`effectiveLimit === null ? null : max(0, effectiveLimit - used)`, then
`quotaSufficiency` decides `remaining === null || remaining >= requested`. The
request counts only `not_found` + `in_progress` files (A7). Over-quota is still
`200`.

## Consequences

- The pre-check never writes: no `upload_sessions` row, no domain event, so a
  rejection cannot become a per-file notification; one `info` line per call
  carries the four per-state counts and the batch id, never a file name.
- `upload_sessions` has no index added by this card: the `{tenantId,
createdByUserId, contentHash}` lookup works unindexed and the card pins no
  index. Recorded as a coverage gap for the lane that creates the rows
  (OP-124 completion), which owns the collection's write path.
- The `ListParts` empty-part limit (ADR-0700 F1) still refuses an empty part
  list upstream; the zero-part resume is pinned at unit level only, and the
  integration resume case lists parts that exist.

## Alternatives considered

- **A route-local admission** (re-implementing `current` resolution for the
  three-segment path) — rejected: it duplicates the alias, header and denial
  log that ADR-0644 exists to keep in one place.
- **Consuming the quota at pre-check time** — rejected: ADR-0340 keeps
  enforcement in the completion transaction; a pre-check that consumed would
  charge a batch the client never uploads.
- **Reading parts from Mongo** — impossible by design: schema §16.2 has no part
  collection, and the live `ListParts` answer is the only truth (I3 boots
  `STORAGE_PROVIDER=s3` against MSW so a fabricated answer cannot pass).
