# ADR-0283 — OP-101 GREEN: the members listing degrades an undatable `joinedAt` instead of denying the workspace

- **Status:** Accepted
- **Date:** 2026-11-18
- **Card:** OP-101 GREEN (`t_2e0b8f30`) · **RED predecessor:** `t_19b89cbb` ([ADR-0282](ADR-0282-op101-tenant-members-pins.md)) · **Land card:** `t_1d41c1e4`
- **Branch:** `OP-101-task-tenant-members-defensive-restore` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_2e0b8f30`
- **Spec sources:** [ADR-0282](ADR-0282-op101-tenant-members-pins.md) (the executable contract); API contract §2.2 (tenant members, the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`); [ADR-0281](ADR-0281-op101-tenant-members-green.md) (the GREEN that shipped `projectMember`); [ADR-0644](ADR-0644-op119-review-round1-green.md) (the events-module total-read precedent)
- **Consumers:** `apps/web/src/server/tenancy/members.ts`

## Context

ADR-0282 pinned the defect and three decisions. `projectMember()` read the join
instant as `new Date(membership.joinedAt as string | number | Date).toISOString()`,
so an absent, `null`, `NaN` or unparseable `joinedAt` on **one** `tenantMembers`
row threw `RangeError: Invalid time value` inside the projection `map`, escaped
the route, and turned the whole `GET /api/v1/tenants/{tenantId}/members` listing
into a `5xx` for **every** caller of that workspace. Its pins fixed the target
behaviour: the row stays listed and its `joinedAt` carries the epoch sentinel
`1970-01-01T00:00:00.000Z`; only a `Date`, a string or a number may name an
instant; and the events-module `instantMillis` reader is duplicated in shape,
never imported, with its skip-the-row policy rejected.

This card is RED → GREEN on the same branch. No assertion, fixture, helper or
mock changed: the production diff is one file, and the two spec files are
byte-identical to the RED head.

## Decision

### D1 — one local reader, and the projection uses it

`apps/web/src/server/tenancy/members.ts` gains one module-private function and
one call-site change:

- `joinedAtMillis(value: unknown): number | null` accepts an instant only from a
  `Date` with a finite `getTime()`, a `string` or a `number` that parses to one
  finite instant; every other value yields `null`;
- the projection becomes
  `joinedAt: new Date(joinedAtMillis(membership.joinedAt) ?? 0).toISOString()`,
  so `null` degrades to the epoch — a schema-valid, totally ordered instant that
  cannot be mistaken for a real join time (ADR-0282 §D2).

The reader is total: it has no throw path, so no row can deny the listing. The
`as string | number | Date` cast is gone; the stored value is read as `unknown`,
which is what the row actually holds.

### D2 — the events-module precedent is duplicated in shape, not imported

ADR-0282 §D4 left the helper choice to this card and its own preference was
explicit; this GREEN follows it. `instantMillis` in
`apps/web/src/server/events/members.ts` stays module-private: it sits in another
bounded context, it accepts **only** a `Date` (the workspace column is seeded as
an RFC 3339 string or epoch milliseconds too, and the pins require those to keep
working), and its caller **skips** a row it cannot date — the opposite of what
the workspace listing must do. Widening it into a shared helper would mean one
function with two policies and a new export crossing a module boundary to save
eight lines. Two modules, two policies, two readers; a third consumer is the
point to factor a shared one.

### D3 — no route-stage error mapping was needed

The RED card named a possible route-stage mapping as a contingency only. With the
projection total, the route has no undatable instant left to map: the listing
answers `200` for every row shape the pins seed, so no `defineRoute` change, no
new error code and no `member-schema` edit were made. ADR-0282 §Consequences
stated the GREEN's surface is one production file; that held.

### D4 — out of scope, unchanged, and now pinned

- **Listing order.** Still sorted by `joinedAt` alone; a degraded row sorts
  first deterministically. Tie-breaking and the ordering contract remain
  ADR-0282 §D5's open item.
- **`user` / `userProfiles` absence, `tenantIdFromRequest`, status filtering.**
  Untouched.
- **Storage enforcement.** No validator was added to `tenantMembers`; this
  decision is about reading.

## Evidence — the RED → GREEN delta

Base: `origin/main` `f9257747`, the RED head `64090ee8`, defective file
byte-identical to the card's `88d65749` (ADR-0282 §Base).

| Spec                                                      | RED (at `64090ee8`)          | GREEN (this head) |
| --------------------------------------------------------- | ---------------------------- | ----------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `8 failed \| 4 passed` (12)  | `12 passed` (12)  |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `3 failed \| 21 passed` (24) | `24 passed` (24)  |

The four unit cases already green at the RED head were the three valid-path
controls (a `Date`, an RFC 3339 UTC string, epoch milliseconds) and `null`, which
was the epoch by accident; the eight failing cases were absent, `NaN`, an
unparseable string, an invalid `Date`, an empty string, a boolean, an object and
the "keeps every §2.2 key" case, and they now pass with the same literal
`1970-01-01T00:00:00.000Z` the RED asserted. The boolean case is the one that
proves the kind constraint matters: the base tree served
`1970-01-01T00:00:00.001Z` for `joinedAt: true` without throwing.

Green output:

```
$ pnpm vitest run --project unit apps/web/src/test/unit/tenant-members-joined-at.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)

$ pnpm vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

## Consequences

- **The listing can no longer be denied by one row.** The failure mode moves from
  "every caller of the workspace gets a `5xx`" to "one member renders as joined
  1970", which is visibly wrong and therefore actionable.
- **The sentinel is load-bearing.** `now Date(joinedAtMillis(...) ?? 0)` is the
  only degradation path; a later decision to serve `null`, skip the row or infer
  the instant from `_id` must break the ADR-0282 pins first.
- **Coverage.** Every arm of the new reader is exercised by the pinned inputs
  (four valid forms, four undatable kinds plus the object/boolean rejections), so
  the branch gate does not drop for it.
- **Nothing else moved.** No contract, schema, route, dependency or test change.

## Alternatives considered

- **Inline ternary at the call site** — rejected: the kind check has four arms
  and a reason each; a named reader keeps the TSDoc where the rule lives.
- **Import `instantMillis` from the events module** — rejected in D2 (policy
  mismatch, module-private across a bounded context).
- **`try`/`catch` around `toISOString()`** — rejected: it treats a symptom, and
  it would keep serving `...000.001Z` for a boolean because that call does not
  throw.
- **A shared `@/server/runtime/time` helper** — rejected: a second consumer with
  the same policy is the trigger for that refactor, and this card has one.

## ADR number allocation

`0283` is the OP-101 lane's cell value in `docs/adr/README.md`, taken as the card
directs (the lane range is `0280`–`0299`, [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)).
`0280` and `0281` are consumed by the tenant-members RED/GREEN pair and `0282` by
the RED pins this card turns green. This record advances the cell to `0284`. No
number outside the lane range is touched.
