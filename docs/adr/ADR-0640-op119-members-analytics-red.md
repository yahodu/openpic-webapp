# ADR-0640 — OP-119 RED: event member listing and tenant analytics pinned

- **Status:** Accepted
- **Date:** 2026-11-11
- **Ticket:** OP-119 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_20c75ee0` (tdd_stage RED, test-author)
- **Branch:** `OP-119-task-members-analytics-red` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_20c75ee0`, off `origin/main`
  `9761fae`)
- **Range:** `0640`–`0659` (drawn as this lane's first card; the allocator pool
  advances to `0660`+, no number outside the block is touched)
- **Gated GREEN:** `t_da9cbf64` (`openpic-webapp-backend-coder`) — consumes
  `0641` next and must base its branch on this pins branch.

## Context

Contract §4.3 and §4.5 specify the two reads this card's user story needs:

- `GET /api/v1/tenants/{tenantId}/events/{eventId}/members` — "Auth `user` +
  event member"; per row `{ userId, displayName, role, status, emailMasked,
addedAt, uploadedImageCount }`, with the contact **masked** (§0.13) and never
  returned raw (§0.15). §4.3 also says `uploadedImageCount` is the PRD's
  _attribution_ requirement.
- `GET /api/v1/tenants/{tenantId}/analytics?from&to&scope=tenant|event&eventId`
  — "Auth `user` + role `owner`|`admin`", "Max 366-day range (`422
range_too_large`)", and the hard rule that it "reads **only** `analyticsDaily`
  rollups (schema §20.1) — never aggregates transactional collections at request
  time".

Neither module exists on the trunk: `apps/web/src/server/analytics/` is absent
and both route folders are new. This ADR records the **test-only** decisions the
card and the contract left open, so the GREEN has one authority. The RED
delivers five test files and no production code.

## Decision

### Module and route contract

- **`@/server/analytics/date-range`**
  - `MAX_ANALYTICS_RANGE_DAYS: 366`
  - `validateAnalyticsRange(from: string, to: string): { from, to, days }` —
    `YYYY-MM-DD` day keys, both ends **inclusive**; `days > 366` throws
    `AppError("range_too_large")` (`422`, `details: { maxDays: 366 }`); a
    reversed span throws `AppError("invalid_date_range")` (`422`, `details:
{ startAt, endAt }`); a non-day-key throws `AppError("validation_failed")`
    (`422`, `details.fields[].path` naming the parameter).
- **`@/server/analytics/totals`**
  - `interface AnalyticsMetrics` — the twelve §20.1 metrics.
  - `reduceAnalyticsTotals(days: readonly AnalyticsMetrics[]): AnalyticsMetrics`
    — pure, total, non-mutating.
- **Routes**
  - `@/app/api/v1/tenants/[tenantId]/analytics/route` → `GET`,
    `route: "/api/v1/tenants/:tenantId/analytics"`, `userAuth()` + `tenantStage()`
    - an `owner`|`admin` gate (`403 forbidden` for a `member`).
  - `@/app/api/v1/tenants/[tenantId]/events/[eventId]/members/route` → `GET`,
    `route: "/api/v1/tenants/:tenantId/events/:eventId/members"`, admitted
    through the OP-117 event-actor rule (`@/server/events/access`
    `resolveEventActorRole`: an `event_organizers` row with role `organizer` or
    `co_organizer`, `revokedAt: null`, **or** an active tenant member).
- **Registry debts the GREEN owes**: a `COLLECTIONS.analyticsDaily` entry
  (`"analyticsDaily"`, schema §20.1; the spec seeds the literal name so the RED
  compiles before it exists) and the `range_too_large` error code in the
  contracts enum + server catalogue + transport row (Appendix A.2 already
  documents it — `422`, `{ maxDays }` — but the executable catalogue does not
  carry it).

### Answer shapes pinned

- Analytics (§4.5): `{ scope: { kind, id }, from, to, series, totals,
computedAt, note }`. The `series` element is **flat** — `dateKey` plus the
  twelve §20.1 metrics, not a nested `metrics` block, because that is how §4.5
  shows it — ordered by `dateKey` **ascending**, and `scope.id` is a hex string.
  `totals` is `reduceAnalyticsTotals` over the served days. `computedAt` is a
  `Z` RFC 3339 instant; `note` is any non-empty string (prose is not pinned).
- Members (§4.3): `{ data: EventMember[] }` with exactly the seven §4.3 fields;
  `emailMasked` is `@openpic/contracts` `maskEmail` of the Better Auth
  `user.email`, `displayName` is `userProfiles.displayName`, `role` is
  `organizer`|`co_organizer`, `addedAt` an RFC 3339 instant, and
  `uploadedImageCount` the cached counter on the member row.

### Assumptions (resolved unilaterally; review them here)

- **A1 — the day count is calendar-based.** `from`/`to` carry no time-of-day, so
  `days` is a `YYYY-MM-DD` subtraction and a DST day is still one day.
- **A2 — `from`/`to` are echoed unchanged.** `validateAnalyticsRange` is a
  validator, not a normaliser.
- **A3 — `p95ProcessingMs` reduces with `Math.max`; the other eleven metrics
  sum.** A percentile cannot be summed, and the daily rollup stores no latency
  sample set to re-derive it from; the conservative envelope is the only
  computable "p95 over the range". This is the one non-obvious rule the card
  left open ("totals computed from the series").
- **A4 — `uniqueAttendees` sums.** Each row holds that day's uniques and no
  identity set is stored, so intersecting is impossible.
- **A5 — an empty series yields the zero object**, never `null`: §4.5 always
  shows `totals`.
- **A6 — `from`/`to` are echoed as day keys**, not instants.
- **A7 — a missing `from`, `to`, or `eventId` (with `scope=event`) is `422
validation_failed`.** §4.5 names no defaults.
- **A8 — `scope=event` is checked against the tenant in the path**, so another
  workspace's event is `404 not_found` (§0.4: no cross-tenant oracle). §4.5 does
  not say this; it is the only reading that keeps the tenant segment meaningful.
- **A9 — a day with no rollup row is not materialised as a zero element.**
  `series` carries stored days only.
- **A10 — the member list is the event's _workers_ only.** A tenant member with
  no `event_organizers` row is **not** listed (the story is attribution of the
  people who upload) even though such a member is admitted to _read_ the list.
  Both halves are pinned.
- **A11 — `addedAt` is the member row's join instant**; only the ISO `Z`
  round-trip is asserted, not which stored field it reads.
- **A12 — the optional co-organizer `invitationId` is not pinned** (either
  presence or absence passes).
- **A13 — `uploadedImageCount` is the cached counter stored as
  `event_organizers.uploadedImageCount`.** The GREEN card chooses "a cached
  counter with `$inc` on upload complete" over a request-time aggregation; the
  spec seeds that field. The `$inc` itself is out of scope (below).
- **A14 — a `removed` member is not pinned.** §4.3 carries a `status` field but
  does not say whether a removed row is served, so either behaviour passes.

### Extra cases beyond the card's list

- Analytics: the `owner`|`admin` gate (`member` → `403`, `admin` → `200`),
  `401` without a session, `404` (never `403`) for a non-member, the 366-day
  **accepted** boundary, `invalid_date_range`, a missing `to`, exclusion of
  days outside `from..to`, exclusion of another workspace's rollups, and the
  §4.5 "no transactional aggregation" rule pinned **behaviourally** by seeding
  five `event_images` + one `domain_events` row against a rollup of 4120 and
  requiring the answer to stay 4120.
- Members: the co-organizer-who-is-not-a-tenant-member admission (the §4.3
  "event member" wording, which the plain `tenantStage()` would refuse),
  `404` for a stranger, `404` for another workspace's event, `404` for an
  unknown event id, `401` without a session, the §0.15 never-return scanner,
  and the "workers only" list contents.

## Consequences

- The GREEN must register `analyticsDaily` in `COLLECTIONS` and append
  `range_too_large` to the contracts `RequestShapeErrorCode` union + the server
  catalogue; both are append-only rows in the `cannot_demote_owner` shape.
- The analytics route is a **pure rollup read**: `series` is a `find` over
  `{ scope, dateKey: { $gte: from, $lte: to } }` sorted by `dateKey: 1`, and
  `totals` is the pure reducer. Any implementation that calls
  `countDocuments` on `event_images`/`domain_events` at request time fails the
  I1 criterion case by construction.
- The members route cannot use `tenantStage()` alone: a co-organizer commonly
  holds no `tenantMembers` row (OP-116/OP-117 precedent, ADR-0580 §D1), so it
  must reuse `resolveEventActorRole` and answer the uniform `404` itself.
- `emailMasked` must come from `maskEmail` at the projection boundary, exactly
  as `listWorkspaceMembers` does; a `$project` that returns `email` and masks it
  in the handler still passes the pins, but the never-return scanner is what
  makes the rule enforceable.
- The `.git`-tracked `docs/adr/README.md` is the known ledger hotspot: this lane
  writes its own row at `0640`–`0659` (`Next free 0641`) and advances the pool
  cell to `0660`+; a later merge is a union resolution keeping the highest cells.

## Alternatives considered

- **Summing `p95ProcessingMs`** — rejected: it is a percentile, and the card's
  own "totals computed from the series" would then produce a number with no
  meaning. `Math.max` is documented as an assumption (A3) rather than silently
  chosen.
- **Returning the §20.1 nested `metrics` block on the wire** — rejected: §4.5's
  own worked body flattens it, and the client dashboard reads that shape.
- **Filtering the member list to `status: "active"`** — neither pinned nor
  forbidden (A14): the contract shows the field but not the rule.
- **A per-day zero fill for gaps in `series`** — rejected as unpinned invention
  (A9): the contract shows stored rollups only, and a synthetic zero day is
  indistinguishable from a real zero-activity day.
- **Asserting the request-time aggregation rule by mocking the collections** —
  rejected: seeding transactional rows that _disagree_ with the rollup is a
  black-box assertion on observable output, and it survives any legitimate
  refactor of the read.

## Evidence (RED at handoff)

- 5 new files, **no production code** (`git status` shows the specs and the one
  factory only):
  - `apps/web/src/test/unit/analytics-range.test.ts` — U1, 12 cases;
  - `apps/web/src/test/unit/analytics-totals.test.ts` — U2, 6 cases;
  - `apps/web/src/test/integration/tenant-analytics.test.ts` — I1 (6), I2 (4)
    and 4 authorization cases = 14;
  - `apps/web/src/test/integration/event-members.test.ts` — I3 (3) and 5
    admission cases = 8;
  - `apps/web/src/test/factories/analytics.ts` — the `analyticsDaily` row /
    `metrics` fixture (type-only import of the not-yet-existing module).
- With throwaway stubs at the four intended module paths (deleted before
  handoff, `git status` clean): `npx tsc -p apps/web/tsconfig.json --noEmit`
  exit `0`; unit **15 failed | 3 passed (18)**, every failure assertion-level
  (`expected { from: '', to: '', days: +0 } to deeply equal { from:
'2026-09-24', …(2) }`, `expected +0 to be 2`, `Error: expected the call to
throw, but it returned`, `expected +0 to be 9100`); integration **22 failed
  (22)** (`expected 500 to be 200/404/401/422/403`).
- At handoff the RED is the honest missing-module failure: five `TS2307`s for
  `@/server/analytics/date-range`, `@/server/analytics/totals`,
  `@/app/api/v1/tenants/[tenantId]/analytics/route` and
  `@/app/api/v1/tenants/[tenantId]/events/[eventId]/members/route`
  (the OP-93/ADR-0306 RED-by-design posture).
- `eslint` 0 errors / 0 warnings and `prettier --check` clean on all five files.

## Out of scope (deliberately not tested)

- The `$inc` of the cached upload counter on upload-complete (A13): the card's
  test list names the listing, not the upload path, which the Media lanes own.
- The nightly rollup job that populates `analyticsDaily` (schema §20.1): the
  analytics job lane owns it; this card reads the collection only.
- The `platform` scope of §20.1 (an admin dashboard concern, §9.3).
- Invitation/removal flows of §2.3 (already shipped by OP-101) and the
  `status: "removed"` listing question (A14).
- Playwright e2e: the card's `e2e_api_playwright` list is empty.
