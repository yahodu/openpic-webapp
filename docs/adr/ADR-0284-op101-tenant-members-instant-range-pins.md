# ADR-0284 — OP-101 TEST: a numeric `joinedAt` outside the four-digit-year window must still not deny the members listing

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-101 TEST (Low, `t_20a04cdb`) · **Origin:** review finding F1 on the land card `t_1d41c1e4` (PR [#694](https://github.com/yahodu/openpic-webapp/pull/694), squash `d42032b4`) · **GREEN successor:** `t_79838160` (gated on this card) · **Docs sign-off:** `t_bfae10cd`
- **Branch:** `OP-101-task-tenant-members-instant-range-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1d41c1e4`
- **Base:** `origin/main` `33b02d8a` (release `1.66.1`, containing `d42032b4`). The card allowed `d42032b4` "or newer"; `git diff --stat d42032b4..33b02d8a -- apps/web/src/server/tenancy apps/web/src/server/http apps/web/src/test/unit/tenant-members-joined-at.test.ts apps/web/src/test/integration/tenant-members.test.ts docs/adr/README.md` is **empty**, so the pins below ran against byte-identical production code, spec harness and ledger to the card's SHA.
- **Spec sources:** API contract §2.2 (tenant members — the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`, no validator on the collection); the executable wire shape in `@/server/tenancy/member-schema` (`joinedAt: isoDateTimeSchema`, i.e. `offset: false`, `precision: 3`, **non-nullable**).
- **Relates to:** [ADR-0282](ADR-0282-op101-tenant-members-pins.md) (the pins the merge turned green), [ADR-0283](ADR-0283-op101-tenant-members-defensive-restore.md) (the reader that left the numeric branch open), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0644](ADR-0644-op119-review-round1-green.md) (the events-module total-read precedent)
- **Consumers:** `apps/web/src/test/unit/tenant-members-joined-at.test.ts`, `apps/web/src/test/integration/tenant-members.test.ts`

## Context

PR #694 made `projectMember()` total for every `joinedAt` that _cannot_ name an
instant: absent, `null`, `NaN`, an unparseable or empty string, an invalid
`Date`, a boolean and an object all degrade to the epoch sentinel
`1970-01-01T00:00:00.000Z` instead of throwing, so one corrupt row can no longer
turn the workspace listing into a `5xx` (ADR-0282 §D1–D2, ADR-0283).

A **finite number** is a different arm. The merged reader accepts any number with
`Number.isFinite`, but `Date.prototype.toISOString()` leaves the RFC 3339
four-digit-year form once the instant crosses the window the wire can carry:

```ts
new Date(253402300800000).toISOString(); // "+010000-01-01T00:00:00.000Z"
new Date(8.64e15).toISOString(); // "+275760-09-13T00:00:00.000Z"  (Date maximum)
new Date(-8.64e15).toISOString(); // "-271821-04-20T00:00:00.000Z" (Date minimum)
new Date(-62167219200001).toISOString(); // "-000001-12-31T23:59:59.999Z"
```

`@openpic/contracts` `isoDateTimeSchema` rejects all four (measured,
`safeParse(...).success === false`), so `serializeResponse` fails the strict
parse — it throws outside production — and the whole
`GET /api/v1/tenants/{tenantId}/members` listing is a `500 internal_error` for
every caller of the workspace. That is precisely the "one corrupt row denies the
listing" failure class ADR-0282 exists to remove, reached through the numeric
branch it left open.

Reachability is narrow and unchanged by design: `tenantMembers` carries no
MongoDB validator, so an older write, a migration or a manual repair can store
such a number; the write path cannot. ADR-0282 §D3's letter ("a number when it
is finite epoch milliseconds") is satisfied by the current implementation, so
this is a **coverage gap**, not a wrong assertion — which is why PR #694 stays
merged and the fix is a pin, not a revert.

## Decision

### D1 — "names an instant" means an instant the wire can carry

The contract the pins fix is one sentence: **whatever the stored `joinedAt`,
`projectMember()` returns a §2.2 member whose `joinedAt` is an
`isoDateTimeSchema`-valid string — the exact instant when the value names one,
the epoch sentinel otherwise.** "Names one" is bounded by the wire format, not by
`Number.isFinite`:

```
-62167219200000 … 253402300799999
```

Those are the first and last instants whose ISO form keeps four year digits
(`0000-01-01T00:00:00.000Z` and `9999-12-31T23:59:59.999Z`), measured in a
throwaway probe at this base. A value inside the window is served as itself; a
value outside it is **undatable for this purpose** and takes the same path as the
mixed kinds PR #694 already degrades.

The closed interval matters in both directions. Pinning only the ceiling would
let a GREEN clamp at, say, `Date`'s own ±8.64e15 limits and keep emitting
`+010000-…`; pinning only the degradations would let a GREEN clamp everything
above "some large number" and truncate a legitimate `9999-12-31T23:59:59.999Z`
row to 1970. Both edges are therefore pinned, and both edges are pinned as
**green controls** as well as the degradations (below).

### D2 — the sentinel stays the epoch, and the mechanism stays free

The degradation target is ADR-0282 §D2's epoch sentinel, unchanged and not
re-litigated: `memberSchema` requires a non-nullable `isoDateTimeSchema`, so
`null` is not on the wire (it would fail `serializeResponse` and still be a
`5xx`) and the listing's `localeCompare` sort would throw on it, while the epoch
is schema-valid, totally ordered and cannot be mistaken for a real join time.

The pins deliberately do **not** pin how the bound is enforced. A range check in
the reader, a clamp on the millis before `toISOString()`, or a guard around the
serialisation all satisfy the contract; the assertions are on the projected
string and the response status only.

### D3 — the route is pinned where the defect is observable

The defect is a `500`, not a wrong field, so the route-level pins are the
primary evidence: `expect(response.status).toBe(200)`, the §2.2
`{ data: […] }` envelope, **every** member still listed (a corrupt instant may
not hide a row), the corrupt row's `joinedAt` at the sentinel, and the exact §2.2
key set. The unit pins carry the boundary cases (`±Date` limits and both edges of
the window); the route pins carry `253402300800000`, `8.64e15`, `-8.64e15` and
one wire-ceiling control.

### D4 — scope: test-only, additive

No production file, existing assertion, fixture, mock, helper, or the two ADRs
already on `main` changed. The diff is two appended `describe` blocks plus this
record and its ledger row. Nothing about storage enforcement, listing order
(ADR-0282 §D5's open item), the events-module duplicate reader (ADR-0283 §D2),
or the totality over-claim in ADR-0283 §D1 (corrected by the GREEN successor
`t_79838160`) is touched.

## Evidence — the measured RED

Base `33b02d8a`, tree = `d42032b4` for every path these specs touch (see §Base).
`0284` is the OP-101 lane's `Next free` cell re-read on `origin/main` immediately
before committing (`| OP-101 CI lane-shape | 0280–0299 | 0284 |`), and the number
is free across every ref: `git ls-tree -r origin/main --name-only docs/adr`
holds no `ADR-0284` path and `git rev-list --objects --all -- docs/adr` names no
such file on any branch.

| Spec                                                      | Before (this head)           | Expected after GREEN |
| --------------------------------------------------------- | ---------------------------- | -------------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `4 failed \| 14 passed` (18) | `18 passed` (18)     |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `3 failed \| 25 passed` (28) | `28 passed` (28)     |

The four failing unit cases are the four out-of-range instants; the two new
**controls** (`253402300799999` → `9999-12-31T23:59:59.999Z` and
`-62167219200000` → `0000-01-01T00:00:00.000Z`) pass on arrival by construction —
they exist to fail a GREEN whose bound is tighter than the wire format, and are
reported as such rather than counted as red. Likewise the route-level
wire-ceiling control passes on arrival.

Unit RED, verbatim:

```
$ npx vitest run --project unit apps/web/src/test/unit/tenant-members-joined-at.test.ts

 ❯ |unit| apps/web/src/test/unit/tenant-members-joined-at.test.ts (18 tests | 4 failed) 25ms
   ❯ projectMember — a `joinedAt` instant outside the four-digit-year range (6)
     × degrades the first instant past the four-digit-year ceiling to the epoch sentinel 5ms
     × degrades the Date maximum to the epoch sentinel 1ms
     × degrades the Date minimum to the epoch sentinel 1ms
     × degrades one millisecond below the year-0000 floor to the epoch sentinel 0ms

AssertionError: expected '+010000-01-01T00:00:00.000Z' to be '1970-01-01T00:00:00.000Z'
AssertionError: expected '+275760-09-13T00:00:00.000Z' to be '1970-01-01T00:00:00.000Z'
AssertionError: expected '-271821-04-20T00:00:00.000Z' to be '1970-01-01T00:00:00.000Z'
AssertionError: expected '-000001-12-31T23:59:59.999Z' to be '1970-01-01T00:00:00.000Z'

 Test Files  1 failed (1)
      Tests  4 failed | 14 passed (18)
```

Integration RED, verbatim (the route is where the defect surfaces):

```
$ npx vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts

 {"level":"error", ..., "route":"/api/v1/tenants/:tenantId/members","event":"http.error","status":500,
  "err":{"message":"Response for /api/v1/tenants/:tenantId/members did not match its schema:
          data.0.joinedAt: Invalid ISO datetime",
         "stack":"Error: ... at serializeResponse (apps/web/src/server/http/serialize-response.ts:58:11)"}}

 ❯ |integration| apps/web/src/test/integration/tenant-members.test.ts (28 tests | 3 failed) 3326ms
   ❯ GET /api/v1/tenants/{tenantId}/members — a numeric `joinedAt` outside the four-digit-year range (4)
     × still answers 200 for a membership whose `joinedAt` is the first instant past the four-digit-year ceiling, degrading it to the epoch
     × still answers 200 for a membership whose `joinedAt` is the Date maximum, degrading it to the epoch
     × still answers 200 for a membership whose `joinedAt` is the Date minimum, degrading it to the epoch

AssertionError: expected 500 to be 200

 Test Files  1 failed (1)
      Tests  3 failed | 25 passed (28)
```

`npx tsc -p apps/web/tsconfig.json --noEmit` exits `0` on the RED head (the pins
use only existing exports, so the red is assertion-level, not a missing module),
`eslint` reports no issues and `prettier --check` is clean on both specs.

## Consequences

- **The numeric branch is closed by contract.** After the GREEN, no finite
  number can produce an `isoDateTimeSchema`-invalid `joinedAt`, so the "one row
  denies the listing" class has no known reachable input left on this endpoint.
- **The window is load-bearing in both directions.** A clamp looser than the wire
  format fails the degradations; a clamp tighter than it fails the two boundary
  controls. A later decision to widen or narrow the accept-set must break these
  pins first.
- **Two edge instants are now documented contract.** `9999-12-31T23:59:59.999Z`
  and `0000-01-01T00:00:00.000Z` are served as themselves, so a future
  "sanity-bound" the reader does not have today is a behaviour change, not a
  cleanup.
- **No route, schema or storage change is implied.** The GREEN successor's surface
  is `apps/web/src/server/tenancy/members.ts` only; `tenantMembers` still carries
  no validator (ADR-0282 §D4).
- **Cost.** One file-level constant pair and six unit cases plus four route cases;
  no measurable suite-time change (integration file `6.5s` at this head).

## Alternatives considered

- **Serve `null` for an out-of-range instant** — rejected: §2.2 and
  `memberSchema` are non-nullable, so it is still a `5xx`, and it breaks the
  listing's `joinedAt` sort (ADR-0282 §D2).
- **Clamp to the nearest window edge instead of the sentinel** — rejected here:
  it fabricates a plausible join time (`9999-12-31T23:59:59.999Z`) for a row
  whose real value is corrupt, which is harder to notice than 1970; it also makes
  the degradation indistinguishable from a genuine edge instant, so the boundary
  control would stop discriminating.
- **Skip the row** — rejected: the listing is the only surface that can manage
  membership, so a skipped row becomes an unmanageable member (ADR-0282 §D4,
  ADR-0283 §D2).
- **Pin only the upper bound** — rejected: the wire's window is closed at both
  ends (`-62167219200000` is `0000-01-01`, `-62167219200001` is `-000001-…`);
  a one-sided pin would leave the low side to a future regression.
- **Assert on the reader's internals** (that a clamp exists, or its exact
  constants) — rejected: the observable contract is the projected string and the
  status code; the mechanism is the GREEN's to choose.

## ADR number allocation

`0284` is the OP-101 lane's `Next free` cell value in `docs/adr/README.md`, read
on a fresh `origin/main` `33b02d8a` immediately before committing (the card
verified the same cell on `d42032b4`). The lane range is `0280`–`0299`
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)); `0280`/`0281` are
the tenant-members RED/GREEN pair, `0282` the defensive-restore pins and `0283`
its GREEN. This record advances the cell to `0285`. No number outside the lane
range is touched.
