# ADR-0289 — OP-101 GREEN: the workspace member listing breaks an equal `joinedAt` instant by ascending `userId`

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 GREEN `t_bb55940d` (openpic-webapp-backend-coder) · **Parent:** the residual-pin pack `t_788e4b9a` ([ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md)), whose R1 case is the RED this record closes
- **Branch:** `OP-101-task-tenant-members-tiebreak-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_bb55940d`
- **Base:** the pin branch tip `140c0b5f` (`OP-101-task-tenant-members-residual-pins`) — the three pin files are carried from it byte-identically
- **Consumers:** `apps/web/src/test/integration/tenant-members.test.ts`
- **Relates to:** [ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) (§D2 — R1, the only RED in the pack), [ADR-0281](ADR-0281-op101-tenant-members-green.md) (the shipped listing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0288](ADR-0288-op101-tenant-members-residual-pins.md) §D2 landed ten pin cases in
`apps/web/src/test/integration/tenant-members.test.ts`. Nine are characterization pins and are
green; R1 is a genuine RED:

> `GET /api/v1/tenants/{tenantId}/members — the total order > orders by joinedAt ascending and
breaks an equal instant by ascending userId`

Measured at the pin head `140c0b5f`: focused spec `1 failed | 39 passed (40)`; the whole
integration project `1 failed | 1765 passed (1766)`. The failure message printed the tie pair
swapped (`…ff01, …0001` for the expected `…0001, …ff01`).

The cause is one line. `apps/web/src/server/tenancy/members.ts:167` sorts the listing on one key:

```ts
.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
```

`Array#sort` is stable, so two memberships that share an instant come back in whatever order the
storage read produced — the order is unspecified and can change between calls. PR #272's `d5be9af4`
(the stale branch ADR-0304 closed) carried the two-key shape; it never landed.

## Decision

### D1 — a second key, ascending `userId`

```ts
.sort(
  (left, right) =>
    left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId)
);
```

The first key is unchanged, so every pair with distinct instants keeps its present order. The
second key fires only on an equal instant, and it is total: `userId` is a lower-case hex ObjectId
string, so `localeCompare` is its byte order and no two memberships in one workspace share it. The
listing is therefore a total order, deterministic for a given set of rows.

Nothing else in `members.ts` changes. `apps/web/src/server/events/members.ts:212-214` already
carries the same tie-break on the **event**-member read model; that file is not touched.

### D2 — the pack and its provenance

The three pin files are carried from `140c0b5f` unchanged, byte for byte:
`apps/web/src/test/integration/tenant-members.test.ts`,
`docs/adr/ADR-0288-op101-tenant-members-residual-pins.md` and the `0288` row plus OP-101 cell in
`docs/adr/README.md`. The pack was reviewed on **PR #866** (`OP-101-task-tenant-members-residual-pins`),
which stays a **draft** and is red by design — a RED pin must not redden the trunk under ADR-0304.
That PR is closed as superseded once this record's PR merges; the tie-break lands here.

### D3 — scope

No contract, route, schema, fixture, mock or existing assertion changes. The order is not restated
as a contract claim: §2.2 does not state one, and ADR-0288 F4 records that gap. This record fixes
the behavior the pins already demand, nothing more.

## Consequences

- The listing is a total order: repeated calls on the same rows return the same sequence.
- The focused spec is `40 passed (40)` (was `1 failed | 39 passed`); the integration project is
  green.
- Deleting either key silently restores the intermittent nondeterminism, and R1 reddens again.

## Alternatives considered

- **Sort with `userId` first, `joinedAt` second** — rejected: it changes the order for every pair
  with distinct instances, which no pin asks for and which §2.2 does not authorize.
- **Sort inside the `find` (`{ joinedAt: 1, userId: 1 }`), no in-memory sort** — rejected: the keys
  are the **projected** ISO strings, not the stored values, and Mongo would order on the stored
  representation; it also adds an index dependency this surface does not have.
- **Compute the order in the test** — rejected in ADR-0288 §D2 (it mirrors the implementation).

## ADR number allocation

`0289` is the OP-101 lane's `Next free` cell value in `docs/adr/README.md`, re-read on this branch
head immediately before committing. The lane range is `0280`–`0299`; `0280`–`0288` are the
tenant-members RED/GREEN pair, the defensive-restore pins and its GREEN, the numeric/string/`Date`
instant-range pins and the residual pin pack. This record takes `0289` and advances the cell to
`0290`. No number outside the lane range is touched.
