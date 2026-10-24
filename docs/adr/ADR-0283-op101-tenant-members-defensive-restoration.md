# ADR-0283 — OP-101 follow-up GREEN: restore the defensive branches the coverage gate forced out

- **Status:** Accepted
- **Date:** 2026-10-24
- **Card:** OP-101 follow-up GREEN (`t_082fa536`) · **Predecessors:** OP-101 GREEN (`t_2e576e70`, [ADR-0281](ADR-0281-op101-tenant-members-green.md)), OP-101 follow-up TEST (`t_2d85f947`, [ADR-0282](ADR-0282-op101-tenant-members-pins.md))
- **Branch:** `OP-101-task-tenant-members-green-restore` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_2e576e70`
- **Spec sources:** [ADR-0282](ADR-0282-op101-tenant-members-pins.md) §D2/§D3/§D4 (the executable pins); [ADR-0281](ADR-0281-op101-tenant-members-green.md) §D6 (the branches dropped); API contract §2.2 (tenant members), §0.4 (tenancy in URLs), §0.13/§0.15 (masked contact)

## Context

The OP-101 GREEN review (PR #268) found that the repo's **global** 80% branch
gate had been met by _deleting_ the defensive branches that guard absent or
corrupt member data ([ADR-0281](ADR-0281-op101-tenant-members-green.md) §D6)
rather than pinning them. Two findings were routed here as the implementation
half, after the Test Author's pins landed in
[ADR-0282](ADR-0282-op101-tenant-members-pins.md):

- **F1 (Medium) — `members.ts:76`.** `new Date(membership.joinedAt as string |
number | Date).toISOString()` throws `RangeError: Invalid time value` when a
  `tenantMembers` row's `joinedAt` is absent or unparseable, so one bad row turns
  the whole `GET /members` into a `500` for every caller of that workspace.
  Reproduced: `undefined → RangeError`, `"not-a-date" → RangeError`.
- **F2 (Low) — `route-stage.ts:82-85`.** The doc comment (and ADR-0281 §D2)
  claimed a path with no `tenants` anchor yields `""`; it did not —
  `segments[segments.indexOf("tenants") + 1]` is `segments[0]` for such a path
  (`/api/v1/foo/abc → "api"`), while `/api/v1/tenants → ""`.

The pins were the spec: this GREEN restores the robustness they exercise and
changes no test. The spec was **3 failed / 33 passed** before this change; it is
**36 passed** after.

## Decision

### D1 — a tolerant `joinedAt` normaliser (F1)

`toIso(value: unknown): string` is restored in `members.ts` and used by
`projectMember` in place of the bare `new Date(...).toISOString()`:

| Stored `joinedAt`   | Result                                 |
| ------------------- | -------------------------------------- |
| `Date`              | `value.toISOString()`                  |
| valid ISO string    | the parsed instant as an ISO string    |
| unparseable string  | `1970-01-01T00:00:00.000Z` (the epoch) |
| absent / other type | `1970-01-01T00:00:00.000Z` (the epoch) |

The epoch fallback is the contract ADR-0282 §D2 pins: one corrupt row degrades
its own `joinedAt` instead of `500`ing the listing for the whole workspace. It
also keeps `joinedAt` a total, always-comparable ISO string for the sort.

### D2 — the listing's order is total: `joinedAt` then `userId`

The sort comparator restores the dropped user-id tiebreak:
`left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId)`.
ADR-0282 §D2 pins ascending `joinedAt`, ties broken by ascending `userId`, so the
listing order is stable between calls even when two members share an instant.

### D3 — the F2 guard is restored rather than the comment corrected

`tenantIdFromRequest` now reads:

```ts
const afterTenants = segments.indexOf("tenants") + 1;
if (afterTenants > 0 && afterTenants < segments.length) {
  return segments[afterTenants] ?? "";
}
return "";
```

This is the explicit `afterTenants > 0 && afterTenants < segments.length` guard
the D6 trim removed. Both anchor-less shapes now yield `""` as ADR-0281 §D2 and
the doc comment always claimed, so the **documentation is made true** instead of
being rewritten to describe the accidental `"api"` return. The downstream
`OBJECT_ID_HEX` check still produces the uniform `404 not_found` the pin asserts,
so no behaviour visible on the wire changes: `/api/v1/foo/abc/members → "" → 404`
and `/api/v1/tenants → "" → 404`, exactly as the characterisation pin requires.

### D4 — what was deliberately _not_ restored, and why

The card lists the D6 removals "the new pins require". Only some of them are
pinned; the rest would add uncovered branches and spend the gate's headroom
without coverage. Restored only where a pin exercises the branch:

- **Restored:** `toIso` (four branches, all exercised by the absent /
  not-a-date / ISO-string / `Date` pins), the sort tiebreak (both `||` branches
  exercised by the ordering and tiebreak pins), the F2 segment guard (both
  false branches exercised by the two anchor-less pins, the true branch by every
  normal route).
- **Not restored — the `instanceof ObjectId` filter on the `$in` userIds.**
  [ADR-0282](ADR-0282-op101-tenant-members-pins.md) §D4 explicitly declares a
  `tenantMembers` row whose `userId` is not an `ObjectId` **out of scope and not
  pinned**: the wire DTO's `idSchema` requires a 24-hex id, so such a row cannot
  be projected without a new product decision. Restoring the filter would add an
  uncovered false branch and violate the "every restored branch is exercised by
  the new pins" acceptance criterion. Routed to the Test Author as a coverage
  gap (see Consequences).
- **Not restored — the `?? null` lookups in the projection map.** The same
  argument: the `userId === null ? null : (… ?? null)` form only branches for a
  row without a valid `ObjectId` userId, which §D4 leaves unpinned. The
  `projectMember` signature already accepts `undefined` and its
  `profile?.displayName ?? ""` / `user?.email ?? ""` fallbacks were kept by the
  D6 trim, so the absent-row pins pass without the extra branch.
- **Not restored — the empty-listing early return.** [ADR-0282](ADR-0282-op101-tenant-members-pins.md)
  §D4: unreachable through the route, because the tenant stage denies a caller
  with no active `tenantMembers` row before the handler runs. It guards nothing
  reachable and is not pinned.
- **Not touched — `maskPhone`'s `+` conditional.** The D6 trim made the `+`
  unconditional; no §2.2 path returns a phone and no pin exercises the
  conditional, so ADR-0281 §D6 item 3 stands. Restoring it would be untested code.

### D5 — coverage and static gates

The full suite (`vitest run --project unit --project integration --coverage`)
passes: **unit + integration = 161 files / 2184 tests**, all green. The restored
branches are all exercised, and the global branch gate holds at **80.20%
branches (2455/3061)** — up from the parent's **80.15% (2444/3049)** measured
with its three RED pins filtered out, and from the trunk's 80.02% (2440/3049) at
the OP-101 merge. Twelve branches are added to the denominator (six in `toIso`,
two in the sort comparator, four in the F2 guard) and eleven are covered; the
single uncovered one is the `?? ""` fallback on `segments[afterTenants]`, which
`noUncheckedIndexedAccess` requires (both `!` and `as` are banned by the repo's
eslint config) but the preceding `afterTenants < segments.length` bound makes
unreachable. Every restored _behavioural_ branch is exercised by a pin.
Statements 92.06%, functions 96.11%, lines 92.60%. `tsc` (all three projects),
`eslint` (0 errors; one pre-existing `security/detect-object-injection`
warning on the same dynamic index) and `prettier --check` are clean; the ADR
numbering guard is 29/29.

## Consequences

- A corrupt `joinedAt` now degrades to the epoch and the listing still answers
  `200`; the F1 `500` is closed. The listing order is deterministic
  (`joinedAt`, then `userId`).
- `tenantIdFromRequest` now matches its documentation: an anchor-less or
  anchor-terminated path returns `""`, and the id-shape check denies with the
  same uniform `404`. The nested-route fix from ADR-0281 §D2 is preserved.
- Behaviour is unchanged for everything the existing suite pins: the previous
  full suite was 161 files / 2165 tests at `b88a779`; the 19 added integration
  pins bring it to 2184 and all pass.
- **Coverage gaps noticed (requests for the Test Author, not fixed here):**
  (i) a `tenantMembers` row whose `userId` is not an `ObjectId` — the
  `instanceof ObjectId` filter and the `?? null` projection lookups stay dropped
  until a pin decides what such a row should project to (skip the row? synthesise
  an id?); (ii) a corrupt non-string `email`/`displayName` on an existing row —
  the D6 `typeof … === "string"` guards were also dropped and are unpinned;
  (iii) the empty-listing early return remains unreachable through the route.
- **Supersession note.** ADR-0281 §D6's "dropped branches" table is now partly
  reversed by this record. ADR-0281 itself is not edited (accepted ADRs are
  immutable); this ADR is the superseding record for the restoration half. The
  branches ADR-0281 §D6 lists as dropped and this GREEN leaves dropped are
  re-stated in D4 so the record stays accurate.

## Alternatives

- **Correct the `tenantIdFromRequest` comment instead of restoring the guard.**
  Rejected: the doc comment and ADR-0281 §D2 would then have to be rewritten to
  describe the accidental `"api"` return, codifying a bug as the contract. The
  guard makes the existing documentation true and costs two covered branches.
- **Restore every dropped branch (the `instanceof` filter, the `?? null`
  lookups, the empty-listing return).** Rejected: three of the four are unpinned
  by ADR-0282 §D4, so restoring them would add uncovered branches and could push
  the global branch gate back under 80%. The acceptance criterion explicitly
  requires each restored branch to be exercised by a pin.
- **Weaken the 80% gate or add tests in the GREEN.** Rejected: the gate is a repo
  invariant and the GREEN may not write tests; the pins are the Test Author's.
