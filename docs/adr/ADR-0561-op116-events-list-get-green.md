# ADR-0561 — OP-116 GREEN: list and get events implemented (`GET /tenants/{t}/events`, `GET /events/{e}`, the `search`/`pipeline`/`windows` units)

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-116 GREEN (`t_4da9eb71`) · **Branch:** `OP-116-feature-events-list-get` (based on the pins head `472cac5`, itself off the OP-115 branch head `b60ad8e`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_4da9eb71`
- **Relates to:** [ADR-0560](ADR-0560-op116-events-list-get-red.md) (the RED contract this card implements), [ADR-0520](ADR-0520-op115-events-create-red.md) / [ADR-0521](ADR-0521-op115-events-create-green.md) (the parent lane's create-event surface — the shared `@/server/events/{windows,dates,slug,dto}`, the `events`/`event_organizers` collections, the `events` DTO, the tenant-scoped read), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) / [ADR-0261](ADR-0261-op100-tenant-provisioning-green.md) (the tenant stage both routes ride), [ADR-0040-op83-event-members.md](ADR-0040-op83-event-members.md) (the organizer/co-organizer roles the access control reads), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §4.1 (`GET /tenants/{tenantId}/events` list and `GET /events/{eventId}` detail), §0.4 (never a cross-tenant oracle), §0.8 (cursor pages), §0.10 (ETag) · **Schema:** §15.1 (`events`), §15.2 (`event_organizers`) · **Doc:** `docs/API Contract.md` Part 4

## Context

The pins card (`t_deab8c0f`, ADR-0560) delivered a test-only RED across four
specs: three unit files (46 cases) pinning the `q` regex-escaping, the
pipeline-status derivation table and the `uploadClosesInHours` rounding, and
one integration spec (4 cases) driving the list route, the global detail route
and the tenant-scoped read in-process against MongoDB-memory-server. This card
is the GREEN half: it implements the ADR-0560 contract, ships the pins
byte-unchanged, and turns every **server-side** behaviour green. One spec
defect in the OP-116 RED spec blocks the last two assertions of I1 from ever
passing (section D); each asserted server behaviour is independently proven.

## Decision

### P1 — Module contract (the three units, ADR-0560 §2.1)

`@/server/events/search` exports `escapeRegex(value)` — every regex
metacharacter (`\ ^ $ . * + ? ( ) [ ] { } |`) escaped with a backslash,
ordinary characters untouched — and `buildNamePrefixRegex(query)` which builds
`new RegExp(\`^\${escapeRegex(query)}\`, "i")`, the anchored case-insensitive
literal prefix the list `?q=`matches against (never a widening injection:
U1's`[a-z]`/`.*`/`^`cases act as literals).`@/server/events/pipeline`exports the`ProcessingCounts`shape, the`PipelineStatus`union and`derivePipelineStatus(counts)` implementing the ADR-0560 priority table (`idle`→`indexing`→`indexed`→`delayed`→`partial_failure`). `@/server/events/windows`adds`uploadClosesInHours(uploadWindowEndsAt, now)`: `null`in →`null`out,
else`max(0, ceil((end - now) / 3 600 000))` — the upward-rounded countdown
(U3).

All three are pure and fully covered by the 46 unit cases.

### P2 — `GET /api/v1/tenants/{tenantId}/events` — the list (I1)

The existing create route file additionally exports `GET`, riding the same
`userAuth` + `tenantStage()` stages (**tenant members only**). `?status=`
filters the rows; an absent `status` returns every event of the tenant. `?q=`
matches the case-insensitive name prefix via `buildNamePrefixRegex`. `?limit=`
(bounded by `parsePageQuery`, default 40 / cap 100) and `?cursor=` drive the
§0.8 cursor: rows sorted `{ startAt: -1, _id: -1 }`, over-fetched
`limit + 1`, and continued on the compound `(startAt, _id)` key (`$or` keyset)
so a repeat query returns the same first page and paging never skips or
repeats a row. The envelope is the canonical `{ data, page: { nextCursor,
hasMore, limit } }` (docs §0.8; sibling `billing-self-serve.test.ts` precedent),
each row projected through the shared Event DTO (`toEventDto`).

### P3 — `GET /api/v1/events/{eventId}` — the global detail (I2, I4)

A new route file (`@/app/api/v1/events/[eventId]/route`) exports `GET` with no
tenant stage: the caller is admitted as a **tenant member** of the event's
tenant (`tenantMembers` row, `status: "active"`) **or** a **co-organizer**
recorded in `event_organizers` (`role: "co_organizer"`, `revokedAt: null`, keyed
by the caller's user id) — the event-membership path ADR-0560 requires so a
co-organizer who is not a tenant member can read the shared event. A caller
with no relationship to the event — including an event of another tenant —
answers `404` (contract §0.4, never an oracle); so do a missing event and a
malformed `{eventId}`. The body is the full Event DTO and the response carries
the quoted `ETag` = `eventETag(updatedAt, schemaVersion)`, so the read value
can satisfy a later `If-Match` (I4: a direct `updatedAt` bump changes the tag).

### P4 — I3 behaviour pin

`GET /api/v1/tenants/{tenantId}/events/{eventId}` (the existing OP-115 read) is
unchanged and still answers `404` for a foreign tenant's `eventId` under this
tenant's path.

### P5 — Deliberately out of scope (no test pins it)

The card's scope-note §3/§4 mention a richer detail body (members,
`pipelineSummary`, `entitlementUsage`, `closesInHours` wiring, `qrUrl`) and a
`GET /events/{e}/stats` endpoint, but the RED spec pins **only** the identity
fields + ETag (ADR-0560: "the detail body's full field set is not pinned…
leaving the extra detail fields to the GREEN's DTO") and has **no** stats test.
Per the TDD `YAGNI` rule this card implements the pinned surface and no more:
the detail body is the shared Event DTO (which already carries the materialised
windows, `accessLinks` and `shareUrl`), and the pure `derivePipelineStatus` /
`uploadClosesInHours` units exist and are tested so a later card can wire them
in when a test pins the field. The stats endpoint and the extra detail fields
are a coverage-gap request to the Test Author's next cycle, not a defect.

## Disputes (documented, fixes belong to the Test Author — a GREEN may not edit tests)

### D1 — `event-list-get.test.ts` I1 pages 2/3 read a phantom `page.data` (the OP-116 spec)

I1 asserts the §0.8 envelope `{ data, page: { nextCursor, hasMore, limit } }`
but is internally inconsistent about where the rows live: **page 1** and the
repeat-read both read **top-level** `data` (`firstPage.data`,
`firstItemId(againPage)`→`againPage.data[0].id`), which is exactly the shape an
honest implementation of ADR-0560 + docs §0.8 produces, while **pages 2 and 3**
read `page2.data` / `page3.data` — `data` **inside** the `page` metadata object
(`event-list-get.test.ts:293` and `:308`). With the canonical envelope
`page.data` is `undefined`, so `data2.map(...)` throws (`TypeError: Cannot read
properties of undefined (reading 'map')`) and I1 fails at the second page. No
single honest envelope can satisfy all three pages (page 1 requires top-level
`data`; pages 2/3 require nested `page.data`). **Fix (one line each):** read
`secondPage.data` and `thirdPage.data` (the top-level `page` sibling), matching
page 1 and the sibling `billing-self-serve.test.ts:792/819` convention. Proof
the server rows are correct: the same query's first page + repeat + I2/I4 all
pass, and the cursor pages return exactly `["Pub 6","Pub 4"]` then `["Pub 2"]`
when read through the top-level `data` the contract documents. Routed as a TEST
card to the OP-116 test author together with D2.

### D2 — `event-create.test.ts` D1/D2 (already documented upstream by the OP-115 lane)

The full integration suite is red on the **base branch** for 11 `event-create`
cases: `E11000 plans_key_unique` at seed (the spec never clears `plans` between
tests) and `TypeError: Body is unusable: Body has already been read` (seven
cases call `errorCodeOf(response)` then `body(response)` on the same one-shot
`Response`). Both are already recorded in ADR-0521 §D by the OP-115 GREEN and
routed to the Test Author as cards `t_4916ad9c` (D1+D2) and `t_7db5345e` (D3).
Verified here that they reproduce on the pristine base with **all OP-116
changes stashed** — they are not a regression of this card.

## Assumptions and open questions

- The detail body is the shared Event DTO; the extra §3 fields are left to a
  future card that pins them (P5).
- `userAuth` (already complete-tolerant) guards both new reads; the detail
  route answers `authentication_required` when no principal is present.
- The list route reuses `tenantStage()` without provisioning — a read must
  never create a billable workspace (ADR-0260 D3).

## Consequences

- The GREEN successor `t_c44493a2` (OP-117 RED) is released by this card's
  completion and must base its branch on this implementation.
- **ADR-number allocation.** The OP-116 lane draws `0560`–`0579` (ADR-0560);
  this record takes **`0561`** and the lane's `Next free` cell advances
  `0561` → `0562`. The ledger's `unallocated (future lanes)` pool stays at
  `0580`+ (the `0540`–`0559` gap held by the in-flight Media lanes OP-112/113/114
  must be union-resolved at merge keeping the highest cells). No number outside
  `0560`–`0579` is touched.
- The list/detail additions need no index beyond the parent lane's
  `{ tenantId, status, startAt }` (the scope note's index) — the cursor uses
  the storage order `{ startAt, _id }` and the `q` prefix is an anchored regex
  that can use a name index when the volume demands it.

## Alternatives considered

- **Detail behind the tenant stage only.** Rejected (ADR-0560): a co-organizer
  who is not a tenant member could not pass the tenant stage; I2 requires them
  to read the shared event, so the global `/api/v1/events/{e}` path authorises
  both membership classes.
- **Repeating `data` inside `page`.** Rejected: adding `page.data` to satisfy
  D1's mis-read pages would violate the documented §0.8 `page` shape and the
  sibling-cursor convention — a test-only accommodation, not honest behaviour.
- **Implementing the stats endpoint / extra detail fields without a test.**
  Rejected under TDD: untested code is a liability; the pure derivation units
  are shipped and a later card wires them when pinned.
