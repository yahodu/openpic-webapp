# ADR-0810 — OP-132 GREEN: the reusable selfie listing is bounded and cursor-paged

- **Status:** Accepted
- **Consumers:** `apps/web/src/app/api/v1/p/selfies/reusable/route.ts`,
  `apps/web/src/server/repos/cross-tenant.ts`,
  `apps/web/src/test/integration/selfie-zero-match-and-reusable-pages.test.ts`
  (the F7 pins, extended by the card that follows this one),
  `apps/web/src/test/integration/selfie-reusable-listing-page-bound.test.ts`
  (the executable pin of this record's bound and cursor round-trip),
  `apps/web/src/test/integration/selfie-reusable-cursor-halves.test.ts`
  (the pin on the stored-type half of the cursor guard) and
  `docs/API Contract.md` §6.3.
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the
  `unallocated (future lanes)` pool — the
  [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md) precedent, and
  the number is the allocator's reservation for this card. Before minting, the
  sweep found **three** numbers in flight and nothing above them: `0807` on
  `OP-132-task-refusal-edge-pins` (PR #558, unmerged), `0808` minted by
  `t_ef9d6371`, `0809` reserved on `t_b0bf2ff2` for `t_29382bcc`, while both
  `Next free` cells on the trunk read `0807`. This record therefore draws
  **`0810`** and both cells advance to `0811`. No lane row is minted.
- **Amends:** [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) — the reusable
  listing's shape — and closes `ADR-0807` §Open question 1 by name (that record
  is still on unmerged PR #558, so it is named here rather than linked: a link
  to a file this base does not carry is a dangling target for the
  `adr-record-links` guard. Relink it when #558 lands).
- **Consumes:** `0810`.

## Context

Review finding **F7** of `t_3b8151c3`: `GET /api/v1/p/selfies/reusable` answered
every active selfie the calling subject holds in every tenant.
`ADR-0807` §Decision 5 measured it and
deliberately left the bound undecided, because §6.3's `200` carried no cursor: a
bare `limit` would truncate with no way to page, and asserting a size would have
frozen whichever shape the next card chose.

Measured at `02fcc72` and re-verified by the reviewer: a population of 25 active
selfies in each of two tenants, plus one newer inactive row and one newer row
belonging to another subject, answered **50 of 50** items. The route called
`crossTenantReads.findReusableSelfiesBySubjectUser(principal, {}, getDb())`, and
the port applies `limit` only when `page.limit !== undefined && page.limit > 0`
— the documented default being "no limit". Every item is signed at request time
(`createMediaSigner`), so the cost of one call grew with the row count.

The decision this record implements was taken by card `t_e5e5b413`: **cap plus
cursor**. Its two rejected alternatives are recorded in §Alternatives.

## Decision

### 1. The listing is bounded, with the repo's own defaults

`?cursor=<opaque>&limit=<1..100>`; `limit` defaults to **`40`**
(`DEFAULT_PAGE_LIMIT`), is clamped to **`100`** (`MAX_PAGE_LIMIT`) above the
ceiling, and a non-integer or `< 1` value is `422 validation_failed`. An
unparseable or foreign cursor is `400 invalid_cursor`. Both come from
`parsePageQuery` (§0.8's one implementation) — the route parses and never
re-implements.

### 2. The `200` gains a `page` member, and no `total`

`{ data: [...], page: { nextCursor, hasMore, limit } }`. The item keeps its four
keys (`selfieId`, `createdAt`, `previewUrl`, `quality`) and the auth stage stays
`user` — an anonymous attendee still answers `401 authentication_required`.

`page.total` is **absent**: §0.8 forbids a total without a cached counter, and
reusable selfies has none (the gallery has `profile.matchCount`; the selfie
listing has nothing equivalent).

### 3. Keyset, never offset

The sort is `createdAt` **desc** with `_id` **desc** as the tiebreak, and the
page is built from a `limit + 1` over-fetch: `buildCursorPage` derives
`hasMore`/`nextCursor` from the extra row, so an exactly-full page is terminal
and never hands out a cursor that leads nowhere.

The cursor continues through a strict `$or` keyset filter on the compound
`(createdAt, _id)` key, both halves revived to their stored BSON types (a string
`_id` compares unequal to every `ObjectId`, which would make the tie arm return
nothing). A `skip(offset)` page cannot satisfy this: the F7 pin that follows
places a `createdAt` **tie across the page boundary**, where an offset page
repeats or skips a row as soon as the tie's internal order shifts.

### 4. `CrossTenantPage` is extended, never replaced

`findReusableSelfiesBySubjectUser` takes `CrossTenantCursorPage` (the existing
`limit`/`offset` interface plus an optional decoded `cursor`), so the port's
documented behaviours are unchanged: `{ limit: 5 }` still answers the five
newest, `{}` still answers every row. Only the route passes a cursor, and only
it adds the over-fetch (`limit + 1`).

### 5. The §6.3 amendment is this card's only docs edit

The reusable endpoint's section now documents the query parameters, the defaults
and ceiling, the opaque cursor, the `page` member, the `400 invalid_cursor`
refusal and the absence of `page.total`. The rest of §6.3 belongs to the F4 docs
card `t_a1fbb7a7`; on a conflict the union keeps both amendments.

### 6. ADR-0807 §Open question 1 is closed, by name

> "**What bound, and how is it paged?** §6.3's `200` has no cursor, so a `limit`
> alone silently truncates."

Closed: the bound is `40`/`100` as §1 says, and the paging is the repo's cursor
convention (`nextCursor`, keyset), not a documented truncation maximum.

## Evidence

Card `t_3c97c2f0`; branch `OP-132-task-reusable-listing-page-bound`, cut from
`origin/main` `70ae5ec`.

### Wire probe (throwaway, run then deleted — the diff does not contain it)

A 50-row active population for one subject, seeded directly, with the 40th and
41st newest rows sharing one `createdAt` so the tie straddles the default page
boundary:

| probe                   | measured                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| default `GET`           | `40` items, `page.hasMore: true`, non-null `nextCursor`            |
| follow the cursor       | `10` items, `page: {nextCursor: null, hasMore: false, limit: 40}`  |
| both pages concatenated | exactly the 50 seeded ids, in sort order — no repeat, no skip      |
| the tied pair           | one row in page 1, its twin first in page 2 (exactly once overall) |
| `?cursor=garbage`       | `400 invalid_cursor`                                               |
| `?limit=0`              | `422 validation_failed`                                            |
| `?limit=1000`           | clamped: `page.limit: 100`, all 50 rows, `nextCursor: null`        |

Load-bearing proof: dropping the cursor from the port call (leaving the
over-fetch) made page 2 answer the same 40 rows — `expected 40 to have length
10` — and the route was then restored byte-identically.

### Gates at this head

| gate                                                                                                               | result                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| integration, full project                                                                                          | `118 files` / `1267` cases, `1258 passed`; `9` timed out (`Test timed out in 5000ms`) in the six notification / `attendee-media-access` files this diff does not touch, and all six re-run isolated → `41 passed (41)`                                                                                |
| unit, full project                                                                                                 | `175 files, 2909 passed \| 3 skipped (2912)` — the ADR-0807 baseline exactly; both changed files are integration-surface, so no unit case moved                                                                                                                                                       |
| five ADR guards (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-source-references`, `adr-consumers`) | `5 files, 218 passed (218)`                                                                                                                                                                                                                                                                           |
| `tsc -p apps/web/tsconfig.json --noEmit`                                                                           | exit `0`                                                                                                                                                                                                                                                                                              |
| `eslint --max-warnings=0` on the two changed files                                                                 | `0 errors, 0 warnings` (the two `consistent-type-definitions` suppressions are pre-existing)                                                                                                                                                                                                          |
| `prettier --check` on the two changed files, this record and the ledger                                            | clean                                                                                                                                                                                                                                                                                                 |
| `pnpm test:coverage` — the CI `test_coverage` command, both projects in one run                                    | exit `0`: `293 files, 4176 passed \| 3 skipped (4179)`; statements `92.57%`, branches `81.1%`, functions `96.95%`, lines `92.76%` — every threshold met. This run carries the same cases as the standalone integration row above and had **no** timeout, so the `9` there is host load, not behaviour |

The case population is the ADR-0807 baseline exactly (`118 files / 1267`), which is
what "no pre-existing case changed" means here: this diff adds no case, and the
route's existing cases (`selfie-reuse.test.ts` I6 and the scope case) still pass.
`cross-tenant.ts` reads `81.25%` lines / `74.28%` branches on the combined run: the
one uncovered arm is the keyset filter's non-null path (lines 210–214), which no
committed case drives yet — the F7 pin card owns that coverage.

## Consequences

- **The route is bounded on every call**, so the signing cost per request is now
  bounded too — a subject with 2 000 reusable selfies costs the same per page as
  one with 40.
- **A client that wants every reusable selfie must follow `nextCursor`** until it
  is `null`; a client that only previews the newest ones may ignore `page`. This
  is the §0.8 rule applied to a collection that used to be exempt from it.
- **The port keeps both paging shapes.** `offset` is still honoured (unchanged),
  so no existing caller's behaviour moved. Only the reusable route passes a
  cursor; nothing else uses `CrossTenantCursorPage`.
- **The keyset filter is local to `cross-tenant.ts`.** `@/server/repos/paginate`'s
  `cursorFilter` keys on a tenant-scoped `RepositoryCollection` and passes the
  cursor's `_id` through as a string; this whitelisted read reaches the driver
  directly (it must, to cross tenants) and needs the `ObjectId` revival. Recorded
  as a deliberate duplication of ~15 lines rather than a refactor of the shared
  paginator.
- **No `page.total`**, so a client cannot show "50 of 230" on this listing.
  Adding one needs a cached counter, which is a schema decision this record does
  not take.
- `docs/adr/README.md` is the shared-ledger hotspot: both `Next free` cells move
  `0807` → `0811` (0808 and 0809 land from their own branches); the row and the
  note merge as a union keeping the highest value.

## Alternatives

1. **Cap only — a `limit` with no `nextCursor`.** Rejected by `t_e5e5b413`: it
   silently truncates, so a subject holding more rows than the cap could never
   see or reuse the older selfies, and §0.8 says collections are cursor-paged, so
   a truncating collection breaks the contract's own rule.
2. **Leave it unbounded (accepted risk).** Rejected: measured 50 of 50 answered,
   with every item signed on every call, so the cost grows with the row count and
   nothing bounds it.
3. **`skip(offset)` paging.** Rejected: an offset page repeats or skips rows
   across a `createdAt` tie as soon as the tie's internal order differs between
   calls, and the F7 pin places a tie exactly on the boundary.
4. **A route-local keyset query.** Rejected: the cross-tenant read is the one
   whitelisted place that may reach the driver, and the repo's lint rule
   (`no-direct-collection-access`) forbids a route from doing it.
5. **Add `page.total` from a `countDocuments`.** Rejected: §0.8 permits a total
   only from a cached counter, and a count on every listing call reintroduces the
   per-request cost this record removes.

## Open questions

1. **Should the pin card's spec live in the existing F7 file or a new one?** This
   record's `Consumers` names
   `apps/web/src/test/integration/selfie-zero-match-and-reusable-pages.test.ts`
   (the file ADR-0807 put the reusable cases in). A pin written into a new file
   must be added to that list, or the `adr-consumers` guard will report the new
   spec as an unclaimed consumer of this record.
2. **Is a `page.total` ever needed here?** Not today: no UI shows a count of
   reusable selfies. If one appears, the counter belongs on the subject profile
   (the `matchCount` pattern) and this record is amended rather than superseded.
3. **Should the offset half of `CrossTenantPage` be retired for this read?** It is
   unused by every caller and §0.8 forbids offset params on the wire. Left in
   place because this card's brief is to extend, not replace, and removing it
   would be an untested behaviour change.
