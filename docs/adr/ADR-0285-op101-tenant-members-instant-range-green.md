# ADR-0285 — OP-101 GREEN: the `joinedAt` reader bounds the accept-set to the wire's four-digit-year window

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-101 GREEN (Low, `t_79838160`) · **RED predecessor:** `t_20a04cdb` ([ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md)) · **Origin:** review finding F1 on the land card `t_1d41c1e4` · **Docs sign-off:** `t_bfae10cd`
- **Branch:** `OP-101-task-tenant-members-instant-range-fix` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1d41c1e4`
- **Base:** `origin/main` `6adfbc3f`. The pins were cut from `33b02d8a`; over the two spec files, `ADR-0284` and `apps/web/src/server/{tenancy,http}` the `33b02d8a..6adfbc3f` diff is empty, and this branch carries the three pinned paths unchanged from the pin head `07dd4aca` (proof in §Evidence).
- **Spec sources:** [ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md) (the executable pins); API contract §2.2 (the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`, no validator); `@/server/tenancy/member-schema` (`joinedAt: isoDateTimeSchema` — `offset: false`, `precision: 3`, non-nullable); [ADR-0283](ADR-0283-op101-tenant-members-defensive-restore.md) (the reader this bounds, and the record whose §D1 over-claim this card corrects); [ADR-0282](ADR-0282-op101-tenant-members-pins.md) §D2 (the epoch sentinel)
- **Consumers:** `apps/web/src/server/tenancy/members.ts`

## Context

ADR-0283 made `projectMember()` total for every stored `joinedAt` that cannot
name an instant, but the reader admitted **any** finite number, and
`Date.prototype.toISOString()` leaves the RFC 3339 four-digit-year form outside
`-62167219200000 … 253402300799999`. `isoDateTimeSchema` rejects the expanded
form (`+010000-…`, `+275760-…`, `-271821-…`, `-000001-…`), so
`serializeResponse` threw and one such row denied the whole
`GET /api/v1/tenants/{tenantId}/members` listing to every caller — the ADR-0282
failure class, reached through the numeric branch ADR-0283 left open (review
finding F1 on the land card `t_1d41c1e4`).

ADR-0284 pinned the target contract without pinning a mechanism: whatever the
stored `joinedAt`, the projection returns a §2.2 member whose `joinedAt` is
`isoDateTimeSchema`-valid — the exact instant inside the window, the epoch
sentinel otherwise — with both window edges as green controls.

## Decision

### D1 — the accept-set is the closed wire window

`apps/web/src/server/tenancy/members.ts` gains two module-private, documented
constants and one guard:

```ts
const WIRE_MIN_MILLIS = -62167219200000; // 0000-01-01T00:00:00.000Z
const WIRE_MAX_MILLIS = 253402300799999; // 9999-12-31T23:59:59.999Z
```

`joinedAtMillis` now returns the millis only when they are finite **and** inside
that closed interval, `null` otherwise:

```ts
return Number.isFinite(millis) && millis >= WIRE_MIN_MILLIS && millis <= WIRE_MAX_MILLIS
  ? millis
  : null;
```

The guard sits after the parse, on the shared `millis`, not on the numeric arm:
"whatever the stored `joinedAt`" (ADR-0284 §D1) includes a **string** that
parses to an expanded-year instant — `new Date("+010000-01-01T00:00:00.000Z")`
is `253402300800000` — and a `typeof value === "number"` guard would leave that
arm emitting a schema-invalid `joinedAt`. The string arm is not pinned yet
(card `t_e9bf64f1`); this bound already covers it.

Both edges are **inclusive**: `253402300799999` still serves
`9999-12-31T23:59:59.999Z` and `-62167219200000` still serves
`0000-01-01T00:00:00.000Z`, so the bound is neither tighter nor looser than the
wire format.

### D2 — the sentinel and the degradation path do not change

An out-of-window instant yields `null`, and the existing
`new Date(joinedAtMillis(...) ?? 0).toISOString()` degrades it to
`1970-01-01T00:00:00.000Z`. The sentinel stays ADR-0282 §D2's single
degradation value: `memberSchema` is non-nullable, a `null` would still fail
`serializeResponse`, and the listing's `localeCompare` sort would throw on it.
The reader stays total — it has no throw path and one return — so no value can
deny the listing.

### D3 — ADR-0283's totality claim and typo are corrected in place, dated

ADR-0283 §D1 said "The reader is total: it has no throw path, so no row can deny
the listing". That was true of the reader and false of the wire, which is the
defect this record fixes, so a dated blockquote amendment points at this record
and narrows the claim to instants inside the window. The same amendment fixes
§Consequences' `now Date(joinedAtMillis(...) ?? 0)` typo to `new Date(...)`.
Nothing else in the merged record is rewritten.

### D4 — scope: one production file, no contract change

No route, `member-schema.ts`, contract, dependency, list order or `status`
filtering decision (ADR-0282 §D5) changes, and `tenantMembers` still carries no
validator — this is a read-side bound.

## Evidence

**The pins landed byte-identically.** The three pinned paths were taken from the
pin head `07dd4aca` onto `origin/main` `6adfbc3f`; the proof is an empty diff
against the pin branch, measured on the carried tree and again at this head:

```
$ git diff origin/OP-101-task-tenant-members-instant-range-pins -- \
    apps/web/src/test/unit/tenant-members-joined-at.test.ts \
    apps/web/src/test/integration/tenant-members.test.ts \
    docs/adr/ADR-0284-op101-tenant-members-instant-range-pins.md | wc -l
0
```

**RED → GREEN**, on the exact carried specs, before and after the one production
change:

| Spec                                                      | RED (pins at `07dd4aca`)     | GREEN (this head) |
| --------------------------------------------------------- | ---------------------------- | ----------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `4 failed \| 14 passed` (18) | `18 passed` (18)  |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `3 failed \| 25 passed` (28) | `28 passed` (28)  |

Green output:

```
$ ./node_modules/.bin/vitest run --project unit apps/web/src/test/unit/tenant-members-joined-at.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)

$ TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration apps/web/src/test/integration/tenant-members.test.ts
 Test Files  1 passed (1)
      Tests  28 passed (28)
```

## Consequences

- **The numeric branch is closed in both arms.** No finite number, and no string
  that parses to an out-of-window instant, can produce a schema-invalid
  `joinedAt`, so the "one row denies the listing" class has no reachable input
  left on this endpoint.
- **The window is load-bearing in both directions.** A clamp looser than the wire
  format fails ADR-0284's degradations; a clamp tighter than it fails its two
  boundary controls. Widening or narrowing the accept-set must break those pins
  first.
- **The sentinel is now the sole outlet for undatable instants**, including
  out-of-window ones; a later decision to clamp to the nearest edge or serve
  `null` must break ADR-0282 §D2 and ADR-0284 first.
- **Coverage.** The guard's three outcomes (in-window, non-finite, out-of-window
  on either side) are all exercised by the pinned inputs, so the branch gate does
  not drop for it.

## Alternatives considered

- **Guard only `typeof value === "number"`** — rejected: a corrupt **string**
  still reaches `toISOString()` through the same parse and emits
  `+010000-…`, so the 5xx class survives (measured green on the pin set, which is
  why ADR-0284 §D1 says "whatever the stored `joinedAt`").
- **Clamp to the nearest window edge** — rejected by ADR-0284 already: it
  fabricates a plausible join time and makes the degradation indistinguishable
  from a genuine edge instant.
- **`try`/`catch` around `toISOString()`** — rejected: it treats the symptom and
  would not make the accept-set explicit, which is what the pins measure.
- **Widen `isoDateTimeSchema` to accept expanded years** — rejected: that is a
  wire-contract change, out of scope for a read-side bound.

## ADR number allocation

`0285` is the OP-101 lane's `Next free` cell taken from `docs/adr/README.md` on a
fresh `origin/main` `6adfbc3f` immediately before committing — the cell still
read `0284`, and `0284` is consumed by the pins record this PR also lands
([ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md)). `0280`–`0283`
are consumed by the tenant-members RED/GREEN pair and the defensive restore. With
two records landing in this PR the cell advances from `0284` to `0286`, matching
the PR #694 precedent (`0282` → `0284`). The lane range is `0280`–`0299`
([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)); no number outside
it is touched.

## Review and landing — PR [#698](https://github.com/yahodu/openpic-webapp/pull/698)

Reviewed head `b29c742b`; docs sign-off `t_bfae10cd`. **Verdict: APPROVED WITH
FINDINGS** — no blocking finding. Merged as squash `f4558e3e`, whose tree
`0b6449b7` is the push head's tree and the tree of `origin/main` at the merge, so
the reviewed bytes are the trunk bytes; CI was `15/15 success` on that tree.

- Re-run by the reviewer in a private probe worktree at the head and again on the
  merged tree: unit `18 passed (18)`, integration `28 passed (28)`, six ADR
  guards `236 passed (236)`, `prettier --check` clean on all seven changed files,
  `tsc -p apps/web/tsconfig.json --noEmit` exit `0`.
- The three pinned paths are byte-identical to the pin head `07dd4aca`:
  `git diff 07dd4aca f4558e3e --` the two specs and
  [ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md) is empty. That
  identity holds at the reviewed head; on today's trunk the two specs carry
  [ADR-0286](ADR-0286-op101-tenant-members-string-instant-pins.md)'s string-arm
  cases on top.
- An 11-input window probe, in a throwaway worktree that imported no repository
  file and was removed afterwards: both edges serve themselves
  (`253402300799999` → `9999-12-31T23:59:59.999Z`, `-62167219200000` →
  `0000-01-01T00:00:00.000Z`), and every out-of-window numeric, string and
  `Date` value degrades to `1970-01-01T00:00:00.000Z`, every one of them
  `isoDateTimeSchema`-valid.
- Numbers `0284`/`0285` are unique across every worktree ADR directory and every
  open PR head; the cell read `0286`, inside `0280`–`0299`.
- Findings, both Low and neither blocking: the string arm was unpinned and the
  unit docblock word was inverted — routed to card `t_e9bf64f1`, which landed as
  [ADR-0286](ADR-0286-op101-tenant-members-string-instant-pins.md). The
  superseded draft PR [#697](https://github.com/yahodu/openpic-webapp/pull/697)
  was closed and its branch deleted.
