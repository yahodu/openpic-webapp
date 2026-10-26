# ADR-0580 — OP-117 RED: the event update / archive / delete surface pinned — the recompute, the editable-field whitelist, the start-lock and the confirmName delete

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-117 RED (`t_c44493a2`) · **Branch:** `OP-117-task-events-update-delete` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_c44493a2`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0520](ADR-0520-op115-events-create-red.md) / [ADR-0521](ADR-0521-op115-events-create-green.md) (the parent lane's create surface and the shared `@/server/events/{windows,dates,slug}` units, the `events`/`event_organizers` collections and the Event DTO), [ADR-0560](ADR-0560-op116-events-list-get-red.md) / [ADR-0561](ADR-0561-op116-events-list-get-green.md) (the list/detail lane this card depends on — the **global** `/api/v1/events/{eventId}` detail route this card's mutations extend), [ADR-0029](ADR-0029-domain-events-outbox.md) (the domain-event outbox this card's emissions ride), [ADR-0040](ADR-0040-op89-identity-lifecycle-hooks-red-followup.md) (the organizer/co-organizer event-role model this card's admission reads)
- **Contract:** §4.1 (PATCH / archive / upload-window:extend / DELETE), §0.10 (ETag / If-Match), §0.4 (never a cross-tenant oracle), §22 (the ordered purge), §7.7 (domain events) · **Schema:** §15.1 (`events`), §15.2 (`event_organizers`), §18.3 (outbox) · **Doc:** `docs/API Contract.md` Part 4

## Context

OP-117 is the third card of the Events epic. The story: _as an organizer, I
want to edit, archive, extend or delete my event safely so that changes are
consistent and destructive actions are deliberate._ The card pins three units
(the window recompute, the editable-field whitelist, the start-lock boundary)
and eight integration behaviours (If-Match enforcement; an endAt move
recomputing both windows; a co-organizer archive refusal; a wrong confirmName
delete refusal; the delete transition plus its purge domain event and the
later-PATCH `409`; a co-organizer PATCHing the description; a startAt change
after the start; an endAt beyond the plan's duration), plus one e2e journey
(create → PATCH with the ETag → delete).

The card does not pin module paths, the routing surface, the whitelist's
exact field set, the recompute signature, the lock-check shape, the purge
event's key/payload or the exact response bodies. This record fixes those,
because the gated GREEN card `t_a6a8f636` must implement them in one pass.

## Decision

### Module contract (the three units)

```
@/server/events/windows
  interface RecomputeWindowsInput {
    endAt: Date; postUploadDays: number | null; retentionDays: number | null;
  }
  interface RecomputeWindowsResult {
    uploadWindowEndsAt: Date | null; retentionExpiresAt: Date | null;
  }
  recomputeWindows(input: RecomputeWindowsInput): RecomputeWindowsResult
      // uploadWindowEndsAt = computeUploadWindowEndsAt(endAt, postUploadDays)
      // retentionExpiresAt = retentionDays === null ? null
      //                    : computeRetentionExpiresAt(endAt, retentionDays)
@/server/events/update            (new module)
  EVENT_EDITABLE_FIELDS: readonly string[]
      // exactly the ten §4.1 editable field names, verbatim:
      // name, description, startAt, endAt, displayTimeZone, logoAssetId,
      // watermarkAssetId, thumbnailPreset, visibilityDefaults, status
  findForbiddenEditableFields(supplied: Record<string, unknown>): string[]
      // the supplied keys outside the editable set, in Object.keys order;
      // a key whose value is undefined is invisible (the PATCH /me
      // precedent, @/server/me/patch-schema.ts)
  isEventLocked(now: Date, startAt: Date): boolean
      // now.getTime() >= startAt.getTime() — the exact boundary (now ===
      // startAt) is already locked (U3)
```

The recompute composes the two existing `@/server/events/windows` helpers, so
the U1 pins hang off the same worked example the create lane used
(`endAt 2026-11-16T18:00:00Z` + 7 → `2026-11-23T18:00:00Z`, + 90 →
`2027-02-14T18:00:00Z`), whole-day shifts preserve the time of day to the
millisecond, and `null` on either entitlement materialises that window as
`null` (the DTO already carries both windows nullable).

### Routing — the mutations live on the global `/api/v1/events/{eventId}` family

The card's own notation names `PATCH /events/{e}`, `POST /archive`,
`POST /upload-window:extend` and `DELETE /events/{e}`; the OP-116 lane
deliberately moved the detail surface to `GET /api/v1/events/{eventId}`
(ADR-0560's alternatives: the tenant-scoped path cannot admit a co-organizer
who is not a tenant member — the `tenantStage` denies them first). The
mutations need exactly that admission (I6), so:

- `@/app/api/v1/events/[eventId]/route` (the OP-116 detail file) additionally
  exports **`PATCH`** and **`DELETE`**, both `route: "/api/v1/events/:eventId"`.
- `@/app/api/v1/events/[eventId]/archive/route` (new) exports **`POST`**,
  `route: "/api/v1/events/:eventId/archive"`.
- `@/app/api/v1/events/[eventId]/upload-window:extend/route` is **documented
  but not pinned** — the card's test list carries no extend case (see Open
  items).

Admission (mirroring the OP-116 detail route): a caller with an
`event_organizers` row (`role: "organizer"` or `role: "co_organizer"`,
`revokedAt: null`) **or** a tenant-member row of the event's tenant. The
**role** gate then splits: PATCH admits `organizer` **and** `co_organizer`
(I6); archive and delete admit `organizer` only (I3 pins the co-organizer
denial). A caller with no relationship to the event answers `404` like the
detail route (never an oracle, §0.4) — no-relationship is unpinned, the
wrong-role denial is `403 forbidden` (I3).

### PATCH `{name?, description?, startAt?, endAt?, displayTimeZone?, logoAssetId?, watermarkAssetId?, thumbnailPreset?, visibilityDefaults?, status?}`

- **If-Match is enforced** through the existing `defineRoute` ETag stage:
  missing → `428 precondition_required` (`details.header: "If-Match"`),
  stale → `412 etag_mismatch` (`details.currentETag` = the row's current
  `eventETag(updatedAt, schemaVersion)`); the route handler returns the
  **new** quoted `ETag` header after a successful write (the response-header
  merge order `{...stageHeaders, ...result.headers}` lets the handler's new
  tag win — the conditional-write loop closes).
- **Editable fields per §4.1** — a supplied key outside
  `EVENT_EDITABLE_FIELDS` answers `422 forbidden_field` with
  `details.fields` (the `PATCH /me` precedent, U2 at the wire).
- **Date edits** (either `startAt` or `endAt` in the body) recompute **both**
  windows through `recomputeWindows` from the plan entitlements
  (`events.post_upload_days`, `gallery.retention_days`) and re-validate
  `events.duration_days` (`ceil((endAt - startAt) / 1 day)`); the denial is
  `403 plan_limit_exceeded` with `details.entitlementKey:
"events.duration_days"` and `details.requestedDays` (I8, mirroring the
  create route's OP-115 shape). Both recomputed windows are returned in the
  `200` DTO (I2).
- **Start-lock:** a body that changes `startAt` while `isEventLocked(now,
storedStartAt)` answers `409 event_already_started` (I7; the boundary
  `now === startAt` counts as started — U3).
- **Deleting rows** are inert: `status === "deleting"` answers
  `409 event_deleting` with `details.purgeScheduledAt` (I5b).
- The `200` is the full Event DTO; the edit emits **`event.details.updated`**
  (synchronously, in the write path — the outbox row is assertable right
  after the response; the contract's 15-minute coalescing belongs to the
  notification resolver, never the API).

### POST `/archive`

Role `organizer` only (a co-organizer answers `403 forbidden` — I3, and
nothing is emitted). Success: `200` + emits `event.archived` (I3b — added
counterpart of the card's I3, per the GREEN scope §2's own wording).

### DELETE

- Body `{ confirmName }`; a value that is **not** the stored event name
  answers `422 confirmation_mismatch` with `details.field: "confirmName"`
  (I4, mirroring `POST /me/deletion`), writes nothing, emits nothing.
- Exact match: the row flips to `status: "deleting"` with a `deletedAt`
  stamp, and **two** outbox events are emitted in the write path —
  `event.purge.scheduled` (the **ordered purge** for the OP-132 purge job:
  `payload { eventId, purgeScheduledAt }`, `subjectRef {kind: "event",
id}`, `actorRef {kind: "user", id}`, registered as an analytics-only /
  queue key — the table below) and `event.deleted` (the user-facing
  in-app + email + mobile announcement, already a registered notification
  type). Response `202` with exactly `{ status: "deleting",
purgeScheduledAt, irreversible: true }` (I5). A later PATCH answers
  `409 event_deleting` carrying the **same** `purgeScheduledAt` (I5b).
- The row is **not** deleted by this endpoint — the `deleting` state
  persists until the purge job consumes the event (OP-132). The DELETE
  endpoint may enforce If-Match too (the spec sends one on every delete);
  only PATCH's `428` is pinned.

### Registry debts the GREEN owes

| Debt                               | Shape                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event_deleting` error code        | `409`, non-retryable, `details { purgeScheduledAt }` (contract Appendix, "Table 3553" row) — appended in the cannot-demote-owner append-only shape                                                     |
| `event_already_started` error code | `409`, non-retryable — same append                                                                                                                                                                     |
| `event.purge.scheduled` outbox key | registered with the outbox gate (`isRegisteredEventKey`) — an analytics-only/queue key, e.g. appended to `ANALYTICS_ONLY_EVENT_KEYS`; the outbox row must exist **after the `202`** (synchronous emit) |

`event.details.updated`, `event.archived` and `event.deleted` are **already**
registered notification typeKeys (`notification-types.values.ts`), so only
the purge key is new.

## Assumptions and open questions

- **The global routing surface** (PATCH/DELETE/archive on `/api/v1/events/{e}`)
  is the direct continuation of the OP-116 decision; the contract's
  tenant-scoped spellings are served only as reads today.
- **The purge event key is this author's choice**: `event.purge.scheduled`
  with `payload { eventId, purgeScheduledAt }`. The OP-132 job is the
  intended consumer — the handoff names the key explicitly so that card can
  subscribe to it.
- **`purgeScheduledAt`** means the instant the delete answers (`202` body,
  outbox payload and the later `409` details all carry the same value).
  Whether it lands exactly at `now` or at a grace offset from
  `platformSettings` is the GREEN's choice (unpinned beyond the three-way
  agreement).
- **Out-of-scope, deliberately unpinned** (not in the card's test list):
  `POST /upload-window:extend` (the story mentions extending, the executable
  list does not — the §4.1 contract entry remains the reference), the
  `draft → published` status transition, `422 retention_would_expire_immediately`
  (a date move into the past), access-link rotation (explicitly OP-118), and
  the co-organizer delete denial.
- The e2e reads the ETag from the **tenant-scoped** GET (existing) and writes
  through the **global** PATCH/DELETE — both compute the same
  `eventETag(updatedAt, schemaVersion)`, so the conditional-write loop is
  coherent.

## Consequences

- The GREEN successor `t_a6a8f636` must base its branch on **this pins
  branch**, not bare `origin/main`, and must merge the OP-116 lane (the
  global detail route file it extends) before or as part of its work — this
  card's pins address the mutations the OP-116 route family will carry.
- **ADR-number allocation.** OP-117 is a dependent ticket, so it draws its own
  block per ADR-0300 §7 rather than continuing the OP-115 events lane
  (`0520`–`0539`) or the OP-116 lane (`0560`–`0579`). The in-flight claims on
  this base: OP-114 holds `0540`–`0559` (ADR-0540/0541 on its unmerged
  branch) and OP-116 holds `0560`–`0579` (ADR-0560/0561). This record
  therefore draws **`0580`–`0599`**, `Next free = 0581`, and the pool cell
  (which reads `0540`+ on this base) is advanced directly to `0600`+ — the
  gap (`0540`–`0579`, held by the in-flight lanes) is the documented
  union-at-merge hotspot: resolution keeps the highest cells (`0600`+).
- No number outside the range `0580`–`0599` is touched.

## Alternatives considered

- **A route-local recompute / whitelist / lock.** Rejected: the card names
  all three as units (U1–U3), so they must be pure exports the specs can
  drive without a clock or a database.
- **PATCH on the tenant-scoped path** (`/tenants/{t}/events/{e}`). Rejected
  for the OP-116 reason verbatim (ADR-0560 §Alternatives): a co-organizer who
  is not a tenant member could not pass the tenant stage, and I6 requires
  them to write the shared event.
- **A dedicated purge-queue table.** Rejected for this card: the card says
  "domain event emitted", and the outbox's `dispatch.queue` consumer model is
  the established seam; a dedicated table would be speculative until OP-132.
