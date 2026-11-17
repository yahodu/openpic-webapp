# ADR-0642 — OP-119 GREEN: event member listing and tenant analytics implemented

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-119 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_da9cbf64` (tdd_stage GREEN, implementer)
- **Branch:** `OP-119-task-members-analytics-green` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_da9cbf64`, based on the pin card's
  tip `1cf7762`, itself two commits on the RED tip `32a15fb`)
- **Range:** `0640`–`0659` (the lane block drawn by [ADR-0640](ADR-0640-op119-members-analytics-red.md));
  this record consumes `0642` and advances the lane cell to `0643`
- **Consumes:** ADR-0640 (RED contract), ADR-0641 (scope-enum, `eventId`,
  revoked-organizer and empty-window pins)

## Context

The RED and pin cards fixed the executable contract — module paths, export
names, route templates, status codes and answer shapes — for two reads:

- `GET /api/v1/tenants/{tenantId}/analytics?from&to&scope=tenant|event&eventId`
  (`owner`|`admin`), which must read **only** `analyticsDaily` rollups and
  compute `totals` from the series;
- `GET /api/v1/tenants/{tenantId}/events/{eventId}/members` (event member),
  which lists the event's workers with a masked contact and their **cached**
  upload count.

Two registry rows were owed (`COLLECTIONS.analyticsDaily`, the
`range_too_large` code) and the pin card left one question deliberately open:
whether a **malformed** (`scope=event`, non-24-hex) `eventId` answers `422`
or `404`.

## Decision

### Modules and routes (as the tests import them)

- `@/server/analytics/date-range` — `MAX_ANALYTICS_RANGE_DAYS = 366` and
  `validateAnalyticsRange(from, to)`: `dateKeySchema` on both ends, then a
  calendar-day subtraction (`+1`, both ends inclusive), then the `422`
  refusals in the order _shape → reversed → ceiling_ (`validation_failed`,
  `invalid_date_range` `{ startAt, endAt }`, `range_too_large` `{ maxDays }`).
- `@/server/analytics/totals` — `AnalyticsMetrics` (the twelve §20.1 fields)
  and `reduceAnalyticsTotals`: the eleven additive metrics through one
  `sumMetric(days, read)` fold, and `p95ProcessingMs` through `Math.max`. No
  dynamic object indexing (the key-list loop tripped
  `security/detect-object-injection`, so the reduction names each metric), so
  the reducer is total, non-mutating and lint-clean.
- `@/server/analytics/schema` — the §4.5 wire schema: `scope { kind, id }`,
  `from`, `to`, a **flat** `series` element (`dateKey` + twelve metrics),
  `totals`, `computedAt`, a non-empty `note`. The metric schemas are declared
  once as `satisfies Record<keyof AnalyticsMetrics, z.ZodType<number>>`, so a
  metric added to the interface without a wire field is a compile error.
- `@/server/analytics/query` — `parseAnalyticsQuery(searchParams)`: the closed
  `scope` vocabulary (`tenant` default, `event`), the range through the
  validator, and `eventId` **required** under `scope=event`. Refusals use the
  `parseQrQuery` field shape (ADR-0620) so every query refusal reads the same.
- `@/server/analytics/daily` — `readAnalyticsSeries`: one `find` over
  `{"scope.kind", "scope.id", dateKey: {$gte, $lte}}`, sorted `dateKey: 1`.
  Dot paths rather than a sub-document equality match, because §20.1's index is
  on the two sub-fields and an equality match would also refuse a row that grew
  a future `scope` sub-field.
- `@/server/events/member-schema` + `@/server/events/members` — the §4.3 DTO
  and `listEventMembers`: one `find` over `event_organizers` plus two `$in`
  reads (`user`, `userProfiles`), then `maskEmail` at the projection boundary.
- `app/api/v1/tenants/[tenantId]/analytics/route.ts` — `userAuth()` +
  `tenantStage()` + the `owner`|`admin` gate (`member` → `403`; a non-member is
  the stage's `404`; no session is `401`), then the query decoder, then the
  scope resolution, then the rollup read and the reducer. The gate runs
  **before** query validation, so an unauthorised caller learns nothing about
  the request shape.
- `app/api/v1/tenants/[tenantId]/events/[eventId]/members/route.ts` —
  `userAuth()` only (never `tenantStage()`: a co-organizer commonly holds no
  `tenantMembers` row, so the stage would refuse the people the listing exists
  to attribute), then the tenant-scoped `events` read (which is both the tenant
  check and the existence check), then `resolveEventActorRole` — whose
  `event_organizers` filter keeps `revokedAt: null` (ADR-0641) — and only then
  the listing. Every denial is the uniform `404`, and `X-Tenant-Id` echoes the
  resolved segment (`TENANT_ID_HEADER`, normalised through `ObjectId`).

### The `eventId` question left open by the pins

A **malformed** `eventId` under `scope=event` answers `422 validation_failed`
with `details.fields[].path = "eventId"`. Rationale: the value is a _query
filter_, not a resource identity — the caller is already an authorised tenant
`owner`/`admin`, and the tenant segment is what carries the resource, so no
existence oracle is opened by saying the filter value is malformed. A
well-formed id that names nothing (or another workspace's event) stays `404`,
which keeps "shape" (`422`) and "existence" (`404`) distinct the way
`parseQrQuery` and the path-id helpers already do.

### Listing scope and the cached counter

- The list is the event's **workers** only: a workspace member with no
  `event_organizers` row is admitted to read the list but is not listed
  (ADR-0640 §A10).
- `uploadedImageCount` is the cached `event_organizers.uploadedImageCount`
  (§A13); a row without the counter projects `0`. No request-time aggregation
  over `event_images` is performed — the `$inc` on upload-complete remains out
  of this card's scope.
- `addedAt` is read as `addedAt ?? createdAt`: §15.2 names `addedAt`, while
  this codebase's event-create write stores `createdAt` (§A11 pinned only the
  ISO `Z` round-trip).
- `status` is projected from the stored row, and the `find` does **not** filter
  `status`/`revokedAt`: §4.3 carries a `status` field and does not say a removed
  row is served or hidden (ADR-0640 §A14), so the row's own lifecycle is
  reported instead of an invented filter. Admission is unaffected — a revoked
  worker is not admitted at all.
- The optional co-organizer `invitationId` §4.3 shows is **omitted** (§A12
  leaves it open either way; event invitations are §2.3's concern and no row
  this read serves carries one yet).

### Registry rows and the collection read path

- `COLLECTIONS.analyticsDaily = "analyticsDaily"` (schema §20.1).
- `range_too_large` is appended to `REQUEST_SHAPE_ERROR_CODES` (contract
  Appendix A.2: `422`, `{ maxDays }`) and to `REQUEST_SHAPE_ERROR_TRANSPORT` —
  **not** `ERROR_CATALOG`, whose key set the pipeline suite pins to exactly the
  base Appendix A rows (the `cannot_demote_owner` append-only shape).
- `analyticsDaily` carries `scope.id` and no `tenantId` field, so it is read
  through `platformRepo`; the tenant boundary is the `scope` filter the route
  builds from the authorised tenant (or the event proven to belong to it).
- The two schema §20.1 indexes are declared in `INDEX_SPECS`
  (`analytics_daily_scope_date_unique` on
  `{"scope.kind","scope.id",dateKey:-1}`, `analytics_daily_date` on
  `{dateKey:-1}`), so the read this ADR describes is keyed in production. The
  integration harness bootstraps no indexes, so no test depends on them.

## Consequences

- Request cost is independent of event size for both reads: one indexed rollup
  `find` for analytics, one row read plus two `$in` joins for the member list.
  Either route aggregates a transactional collection at request time and the
  §4.5 criterion case (`I1`, five `event_images` + one `domain_events` against a
  rollup of 4120) fails by construction.
- The analytics `series` carries stored days only — no zero fill — so a gap in
  the nightly rollup is a gap on the wire, not a synthetic zero day (§A9).
- `scope` is closed, so platform-wide rollups cannot be reached from a tenant
  route even though §20.1 stores them (ADR-0641).
- The member route is the first `/tenants/{tenantId}/…` route that does not use
  `tenantStage()`; the pattern for a nested route granted through
  `eventMembers` is now "read the parent tenant-scoped, then
  `resolveEventActorRole`, then the uniform `404`". A future lane that needs the
  `current` alias on such a route must extend the stage rather than copy this
  handler (ADR-0260).
- `docs/adr/README.md` remains the shared-ledger hotspot: this record's cell
  (`0643`) unions with the in-flight lanes by keeping the highest value.

## Alternatives considered

- **`tenantStage()` on the member route** — rejected: it refuses a
  co-organizer who is not a workspace member (`404`), which is the one caller
  the §4.3 "event member" admission exists to serve.
- **A bespoke `event_organizers.findOne` for admission** — rejected: it must
  reproduce the `revokedAt: null` filter, and the pin card asserts exactly that
  a removed worker is refused (ADR-0641). Reusing `resolveEventActorRole` keeps
  one admission rule.
- **`404` for a malformed query `eventId`** — rejected as the second-best
  reading: it would make a filter-shape error indistinguishable from "no such
  event" and hide a client bug behind a resource answer. Recorded here because
  the pins deliberately left it open.
- **Materialising zero days for gaps in the requested window** — rejected
  (§A9, and ADR-0640 already rejected it for the same reason).
- **Filtering the member list to `status: "active"`** — rejected: unpinned, and
  it would drop the attribution history the PRD asks for while leaving the
  wire's `status` field permanently `"active"`.
- **A request-time `countDocuments` for `uploadedImageCount`** — rejected: the
  card explicitly chooses the cached counter, and a per-member count would be
  an N+1 aggregation against a transactional collection.

## Evidence (GREEN at handoff)

- Focused: `analytics-range.test.ts` + `analytics-totals.test.ts` **18 passed**
  (unit project), `tenant-analytics.test.ts` + `event-members.test.ts`
  **26 passed** (integration project, both specs RED at the pin tip as
  `Cannot find package`).
- Full suite: unit project **144 files / 2305 passed | 3 skipped**; integration
  project **95 files / 840 passed**.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 errors / 0
  warnings on every touched file; `prettier --check` clean.
- No test, mock, fixture or factory is edited: the diff against the pin tip is
  production code, the ADR and the ledger.

## Coverage gaps handed to the Test Author

- The `current` tenant alias is **not** supported on the member route (it
  answers `404`, because the event read is scoped by the literal segment). No
  case sends `current`; if the alias is meant to work on nested routes, a pin
  should say so, and the route should then extend the stage (ADR-0260).
- The `note`'s wording is prose: only non-emptiness and `typeof === "string"`
  are pinned.
- A malformed `eventId` under `scope=event` (`422` here) and the member route's
  malformed tenant segment (`404`) are unpinned; both are recorded above.
- `p95ProcessingMs` for a window where every stored day is `0` reduces to `0`
  (the `Math.max` of no measurements is the initial `0`), which no case pins.

## Review sign-off — round 1 (card `t_da9cbf64`, artifact lens)

**Verdict: APPROVED WITH FINDINGS.** The delivery was reviewed at head
`fccd1d1` and landed on the trunk as the squash `97f00b1` (PR #405); the review
record is PR #405 comment
[`#issuecomment-6795286796`](https://github.com/yahodu/openpic-webapp/pull/405#issuecomment-6795286796).
Nothing above is retracted: every decision, count and gap in §Decision,
§Consequences and §Coverage gaps stands as written. The reviewer edited no file —
the reviewed SHA is frozen and each improvement below is a card, not a push.

### The reviewed bytes are what shipped

`git diff --stat fccd1d1 97f00b1 -- apps/web packages
docs/adr/ADR-0640-op119-members-analytics-red.md
docs/adr/ADR-0641-op119-analytics-scope-pins.md` is **empty**: the tree the review
read is byte-identical to the merged tree for every path PR #405 carries. Across
the two full trees the only differing file is
`docs/adr/ADR-0620-op118-access-links-qr-red.md` (`+53/−0`), which is main-owned:
it arrived with `284e098` (PR #402, the OP-118 access-links sign-off) between the
reviewed branch cut and the squash base, and this lane never touches it.

### Acceptance criteria → evidence (re-measured at the merge commit)

| Card criterion                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| There are no transactional aggregations at request time for analytics. | A grep for `aggregate`, `countDocuments` and `$group` over `apps/web/src/server/analytics/**` and the analytics route finds no call — every hit is prose in a docblock — and the analytics path's only read is one `find` over the rollup collection at `daily.ts:88`, filtered by the two `scope` sub-fields and the date window. The §4.5 criterion case `I1` seeds five event-image rows and one domain-event row against a rollup of 4120, and the answer stays 4120. |
| Contacts are masked.                                                   | `emailMasked` is produced by `@openpic/contracts` `maskEmail` at the projection boundary (`apps/web/src/server/events/members.ts:91`, `maskEmail(user?.email ?? "")`), and the wire field is typed `maskedContactSchema` (`apps/web/src/server/events/member-schema.ts:32` → `packages/contracts/src/primitives.ts:111`, `/^[^\s]*[•*][^\s]*$/`). No raw address or local-part prefix is reachable from the response, and the I3 scanner case passes.                     |

Gates, `97f00b1` re-run in a detached worktree off the merge commit
(`TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project unit
--project integration --coverage`):

| Gate       | Result                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full suite | **239 files / 3145 passed \| 3 skipped**, exit `0`                                                                                                  |
| Coverage   | statements `91.81 %`, branches `80.36 %`, functions `95.6 %`, lines `92.1 %` — every bar met                                                        |
| Focused    | unit `analytics-range` + `analytics-totals` + the ADR guard **47 passed (47)**; integration `tenant-analytics` + `event-members` **26 passed (26)** |
| Test files | `git diff --stat 1cf7762 fccd1d1 -- apps/web/src/test` empty — the implementation edited none                                                       |

### Findings (routed, not just flagged)

Each finding below was re-reproduced at the merge commit rather than transcribed
from the handoff.

| Finding                                                                                                                                                                                                              | Severity | Evidence at `97f00b1`                                                                                                                                                                                                                                                                                 | Routed to                                           | State on the trunk                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **F1** — `GET /tenants/current/events/{id}/members` answered `404` where contract §0.4 requires the `current` alias be resolved and echoed in `X-Tenant-Id`.                                                         | High     | The ADR-0643 `P1` case run against the merge commit: `AssertionError: expected 404 to be 200`. Reviewer probe at the same commit: the same caller gets `200` + `X-Tenant-Id = <resolved hex>` from `/tenants/current/analytics` while `/tenants/current/events/{id}/members` answers `404 not_found`. | TEST `t_b4ec0827` → GREEN `t_76818e4b`              | Closed by `ea36f33` (PR #408): the shared stage with an `admission` seam                                                     |
| **F2** — a stored `event_organizers` row with neither `createdAt` nor `addedAt` made the listing answer `500 internal_error` (`RangeError: Invalid time value`); a row naming no `userId` was the same defect class. | Medium   | Both `P2` cases at the merge commit: `expected 500 to be 200`, once per arm (`3 failed \| 27 passed (30)` for the two pins together, `P1` being the third).                                                                                                                                           | TEST `t_b4ec0827` → GREEN `t_76818e4b`              | Closed by `ea36f33`: the projection is total (userless row skipped, missing join instant falls back to `_id.getTimestamp()`) |
| **F3** — the unreachable `query.eventId === null` tenant fallback in `resolveScopeTarget` would silently serve the **tenant** aggregate to a `scope=event` caller if the parser ever changed.                        | Low      | `apps/web/src/app/api/v1/tenants/[tenantId]/analytics/route.ts:53` at the merge commit: `if (query.kind === "tenant" \|\| query.eventId === null)` returns the tenant target.                                                                                                                         | GREEN `t_76818e4b` (optional, behaviour-preserving) | Closed by `ea36f33`: `AnalyticsQuery` is a discriminated union, so `kind: "event"` always carries its id                     |

**Info (recorded, no card).** Each was read at the merge commit:

- the member route logged no `tenancy.access_denied` warning — it did not run the
  stage, which owns that log; F1's fix restores it by going through the stage;
- `OBJECT_ID_HEX` (`/^[0-9a-f]{24}$/i`) is duplicated in
  `analytics/query.ts:26` and the member route (`members/route.ts:35` at the merge
  commit), and the `validation_failed` field-refusal helper is duplicated as
  `refuseFields` (`analytics/date-range.ts:38`) and `refuseField`
  (`analytics/query.ts:50`);
- the listing carries no `limit` (`members.ts:118` is `.find({ eventId })`);
  it is bounded by the plan's organizer cap;
- `String(row.dateKey)` (`analytics/daily.ts:96`) would fail the wire schema if a
  rollup row ever stored a `Date` instead of the `YYYY-MM-DD` string;
- `p95ProcessingMs` over a window whose stored days are all `0` reduces to `0`
  (the `Math.max` of no measurements is the initial `0`).

The coverage-gap list this record hands to the Test Author is dispositioned, not
reopened: the `current`-alias gap is F1 (closed by `ea36f33`), the malformed query
`eventId` was closed by the ADR-0643 `P3` characterization pin (`422
validation_failed` naming `eventId`), while the member route's malformed tenant
segment is still unpinned and is carried in
[ADR-0644](ADR-0644-op119-review-round1-green.md) §Coverage gaps; the `note`'s
wording (only non-emptiness pinned) and the all-zero-window `p95ProcessingMs`
need no action and stand as recorded above.

### Carried records

[ADR-0640](ADR-0640-op119-members-analytics-red.md) and
[ADR-0641](ADR-0641-op119-analytics-scope-pins.md) are **carried unchanged** by
this sign-off: their statements stand and nothing in them is retracted. This
section is appended, not rewritten — every historical section of this record is
byte-identical to the merged one. `docs/adr/README.md` stays **byte-identical**
too (this record changes no index row and no lane cell), and the sign-off
consumes **no** new ADR number: the OP-119 lane's `Next free` cell does not move.
