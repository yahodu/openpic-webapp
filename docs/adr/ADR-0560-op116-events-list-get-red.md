# ADR-0560 — OP-116 RED: the event list, detail and stats surface pinned — `q` escaping, the pipeline-status table and the closes-in-hours rounding

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-116 RED (`t_deab8c0f`) · **Branch:** `OP-116-task-events-list-get` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_deab8c0f`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0520](ADR-0520-op115-events-create-red.md) / [ADR-0521](ADR-0521-op115-events-create-green.md) (the parent lane's create-event surface this card's list/detail build on — the shared `@/server/events/{windows,dates,slug}` units, the `events`/`event_organizers` collections, the `accessLinks.slug` unique partial index, the tenant-scoped read `GET …/events/{eventId}`), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the tenant stage), [ADR-0040-op83-event-members.md](ADR-0040-op83-event-members.md) (the organizer/co-organizer roles the access control reads)
- **Contract:** §4.1 (`GET /tenants/{tenantId}/events`, event detail), §0.4 (never a cross-tenant oracle), §0.8 (cursor pages), §0.10 (ETag) · **Schema:** §15.1 (`events`), §15.2 (`event_organizers`), §14.2 (`usageCounters` / `entitlementUsage`) · **Doc:** `docs/API Contract.md` Part 4

## Context

OP-116 is the second card of the Events epic. The story: _as an organizer or
co-organizer, I browse my events and read details, windows and pipeline status
so I know whether my photos landed._ The card pins three units (the regex
escaping of the caller-supplied `q` search, the pipeline-status derivation
table, the `uploadClosesInHours` rounding) and four integration behaviours (a
repeatable status filter with cursor pages; a co-organizer reading a shared
event but not another tenant's; a foreign eventId under my tenant path → 404;
an ETag present on detail reads and changing after an update).

The card does not pin module paths, the detail endpoint's routing, the list
envelope, the derivation table's exact rows, or the rounding rule. This record
fixes those, because the gated GREEN card `t_4da9eb71` must implement them in
one pass. It builds **directly on the parent lane's branch** (PR #372 is still
open), so the base of this pins branch is `origin/OP-115-task-create-event-windows`
(`b60ad8e`), not bare `origin/main`.

## Decision

### Module contract (the three units)

```
@/server/events/search
  escapeRegex(value: string): string
      // every regex metacharacter escaped with a backslash; ordinary chars unchanged
  buildNamePrefixRegex(query: string): RegExp
      // new RegExp(`^${escapeRegex(query)}`, "i") — anchored, case-insensitive
@/server/events/pipeline
  type ProcessingCounts = {
    imageCount: number; processedImageCount: number; failedImageCount: number;
  }
  type PipelineStatus = "idle" | "indexing" | "indexed" | "delayed" | "partial_failure"
  derivePipelineStatus(counts: ProcessingCounts): PipelineStatus
@/server/events/windows
  uploadClosesInHours(uploadWindowEndsAt: Date | null, now: Date): number | null
      // null -> null (unlimited); else max(0, ceil((end - now) / 3_600_000))
```

The `q` search is a **case-insensitive anchored prefix** on the event name
(`/^<escaped-q>/i`); `escapeRegex` exists so a caller can never widen the match
set with `[a-z]`, `.*`, `^` or a lone backslash (the injection/ReDoS surface
U1 pins). The pipeline status is derived in priority order (U2): `idle` when
`imageCount === 0`; `indexing` while `processed + failed < imageCount`;
`indexed` when done with `failed === 0`; `delayed` when done with `processed
=== 0` (every result so far a failure, retries pending); `partial_failure`
otherwise (some indexed, some failed). The countdown (U3) is **upward-rounded**
to whole hours and clamped at `0` (never `null` for a bounded window that has
closed).

### Routing and access control

The card's four integration behaviours span **three** handlers:

- `GET /api/v1/tenants/{tenantId}/events` — the **list** (the existing create
  route file additionally exports `GET`, `route: "/api/v1/tenants/:tenantId/events"`),
  **tenant members only**. `?status=&cursor=&limit=&q=`, sorted `startAt` desc,
  envelope `{ data, page: { nextCursor, hasMore, limit } }` (the §0.8 cursor
  keyed on `(startAt, _id)`); `status` filters the rows, an absent `status`
  returns every event of the tenant. Covers I1.
- `GET /api/v1/events/{eventId}` — the **global detail** (new route file
  `@/app/api/v1/events/[eventId]/route`). Authorised for a tenant member **or**
  a co-organizer recorded in `event_organizers` for that event; a caller with
  no relationship — including an event belonging to another tenant — receives
  `404` (§0.4, never an oracle). Returns the event detail plus a quoted `ETag`
  (`eventETag(updatedAt, schemaVersion)`). Covers I2 and I4.
- `GET /api/v1/tenants/{tenantId}/events/{eventId}` — the existing OP-115
  tenant-scoped read, unchanged. Covers I3.

The **co-organizer** is a signed-in user with an `event_organizers` row
(`role: "co_organizer"`) who is **not** a tenant member — the detail route must
admit them through the event-membership path, and the list stays
tenant-members-only (the tenant stage, not the event-membership gate).

## Assumptions and open questions

- **I3 is a behaviour pin, green on the base.** The OP-115 tenant-scoped read
  already isolates by tenantId via the tenant-scoped `tenantRepo`, so an event
  of another tenant addressed under this tenant's path already answers `404`.
  I3 asserts that contract holds; it is not a red driving new code.
- **I4's "changes after an update" is exercised by mutating the stored row
  directly** (`$set` on `updatedAt`), because OP-116 ships no update endpoint —
  that is OP-117. The pin holds once the detail ETag derives from
  `updatedAt`.
- **The pipeline derivation table is this author's decision**, not the card's.
  `delayed` is the all-failed-but-retryable state (nothing indexed yet), kept
  distinct from `partial_failure` (some indexed, some failed). The five status
  values match the GREEN scope §3 list verbatim.
- **`uploadClosesInHours` uses `ceil`**, so a UI countdown never claims more
  time than the caller has; a closed window is `0`, an unlimited one `null`.
- **The list envelope `{ data, page: { nextCursor, hasMore, limit } }`** mirrors
  the existing cursor-list precedent (§0.8).
- The **detail body's full field set is not pinned** by the card (the scope
  lists members/windows/entitlementUsage/pipelineSummary); the integration
  assertions here pin the identity fields (`id`/`name`/`status`/`startAt`) and
  the `ETag`, leaving the extra detail fields to the GREEN's DTO.

## Consequences

- The GREEN successor `t_4da9eb71` must base its branch on **this pins branch**,
  not bare `origin/main` (the parent OP-115 surface it builds on is still on
  PR #372, and these specs live on this branch).
- **ADR-number allocation.** OP-116 is a dependent ticket, so it draws its own
  block per ADR-0300 §7 rather than continuing the OP-115 events lane
  (`0520`–`0539`). The `unallocated (future lanes)` pool's **correct final
  value on `main` is `0560`+** (the in-flight Media lanes OP-112/113/114 drew
  `0540`–`0559` on their unmerged branches — OP-114 carries ADR-0540/0541 —
  per the OP-115 GREEN handoff). This record therefore draws **`0560`–`0579`**,
  `Next free = 0561`, and the pool advances to `0580`+. The ledger's pool cell
  on this base still reads `0540`+; it is written as `0580`+ here and the gap
  (`0540`–`0559`, held by the in-flight Media lanes) must be union-resolved at
  merge keeping the highest cells.
- No number outside the range `0560`–`0579` is touched.

## Alternatives considered

- **Detail on the tenant-scoped path only.** Rejected: a co-organizer who is
  not a tenant member could not pass the tenant stage, and the card's I2
  requires them to read the shared event — so the global `/api/v1/events/{e}`
  detail path (the GREEN scope §3's own wording) is the authorising surface for
  both tenant members and co-organizers.
- **A `floor` countdown.** Rejected: understates the time remaining and can
  report `0` while the window is still open (U3 pins `ceil`, clamped at `0`).
