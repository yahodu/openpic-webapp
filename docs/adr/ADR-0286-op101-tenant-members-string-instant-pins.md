# ADR-0286 — OP-101 TEST: a **string** `joinedAt` outside the four-digit-year window must not deny the members listing either

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-101 TEST (Low, `t_e9bf64f1`) · **Origin:** review finding F-b on the pin card `t_20a04cdb` (draft PR [#697](https://github.com/yahodu/openpic-webapp/pull/697), head `07dd4aca`), carried through the GREEN review of `t_79838160` (PR [#698](https://github.com/yahodu/openpic-webapp/pull/698), squash `f4558e3e`) · **Docs sign-off:** `t_bfae10cd`
- **Branch:** `OP-101-task-tenant-members-string-instant-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1d41c1e4`
- **Base:** `origin/main` `18df24b4` (release `1.66.2`, containing `f4558e3e`).
- **Spec sources:** API contract §2.2 (tenant members — the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`, no validator on the collection); the executable wire shape in `@/server/tenancy/member-schema` (`joinedAt: isoDateTimeSchema`, i.e. `offset: false`, `precision: 3`, **non-nullable**).
- **Relates to:** [ADR-0282](ADR-0282-op101-tenant-members-pins.md) (the undatable-instant sentinel), [ADR-0283](ADR-0283-op101-tenant-members-defensive-restore.md) (the reader), [ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md) (§D1's "**whatever** the stored `joinedAt`"), [ADR-0285](ADR-0285-op101-tenant-members-instant-range-green.md) (the bound this record pins on the other arm), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Consumers:** `apps/web/src/test/unit/tenant-members-joined-at.test.ts`, `apps/web/src/test/integration/tenant-members.test.ts`

## Context

ADR-0284 §D1 states the contract for **whatever** the stored `joinedAt` is:
`projectMember()` returns a §2.2 member whose `joinedAt` is
`isoDateTimeSchema`-valid — the exact instant inside
`-62167219200000 … 253402300799999`, the epoch sentinel otherwise. ADR-0285 then
implemented that bound on the reader's shared `millis`, after the parse, so both
the numeric and the string arm are covered by one guard.

The pin set that ADR-0284 landed, however, exercises the **numeric** arm only
(four out-of-window numbers plus two numeric edge controls; three numbers plus
one numeric ceiling control at the route). That is an under-determined pin set,
not a wrong one: the string arm reaches the identical defect class through the
same `new Date(value).getTime()`, so a GREEN shaped as a _numbers-only_ bound

```ts
if (typeof value === "number") {
  /* …bound… */
}
```

satisfies every numeric pin while a corrupt **string** still emits a
schema-invalid `joinedAt`. The pin card measured exactly that at its head
`07dd4aca`: with a numbers-only bound in place the file reported
`18 passed (18)` while `projectMember({ joinedAt: "+010000-01-01T00:00:00.000Z" })`
returned `"+010000-01-01T00:00:00.000Z"` and
`isoDateTimeSchema.safeParse(...).success === false` (same for the `+275760-…`
and `-000001-…` strings).

Measured at this base, in a throwaway probe (no repository file imported or
edited):

```
new Date("+010000-01-01T00:00:00.000Z").getTime()     -> 253402300800000
new Date("+275760-09-13T00:00:00.000Z").getTime()     -> 8640000000000000
new Date("-271821-04-20T00:00:00.000Z").getTime()     -> -8640000000000000
new Date("-000001-12-31T23:59:59.999Z").getTime()     -> -62167219200001
```

All four lie outside the closed window, so under the merged bound they degrade;
under a numbers-only bound they are served as `+010000-…`, `+275760-…`,
`-271821-…` and `-000001-…`, `serializeResponse` fails the strict parse, and the
whole `GET /api/v1/tenants/{tenantId}/members` listing is a `500` for every
caller of the workspace — ADR-0282's "one corrupt row denies the listing"
reached through a corrupt string on a collection that carries no validator.

## Decision

### D1 — the string arm is inside ADR-0284 §D1, and is pinned as its own arm

No new contract is created. ADR-0284 §D1 already quantifies over **whatever** the
stored `joinedAt` is; this record only makes the pin set exercise the half it
left to the reader's numerical branch. A stored string that names an instant
outside the window is **undatable for this purpose** and takes the epoch
sentinel `1970-01-01T00:00:00.000Z` exactly like the numeric arm, and a string
naming either window edge is served as itself.

The unit block pins four degradations (the first instant past the ceiling, the
`Date` maximum, the `Date` minimum and one millisecond below the year-0000 floor)
and both edges as green controls
(`9999-12-31T23:59:59.999Z` → itself, `0000-01-01T00:00:00.000Z` → itself), each
case also asserting `isoDateTimeSchema.safeParse(projected.joinedAt).success`.
The route block pins one string value (`+010000-01-01T00:00:00.000Z` seeded raw
in `tenantMembers`): `200`, the `x-tenant-id` header, every member still listed,
and the row's `joinedAt` at the sentinel.

### D2 — no mechanism is pinned

The assertions are on the projected string and the response status only. The
merged `millis` bound (ADR-0285's shape), a separate string guard, or a bound
inside a shared reader all satisfy the pins. The unit docblock repeats ADR-0284's
"Contract expected of the implementation" without asserting where the bound
lives.

### D3 — these are characterization pins

The string arm is already closed by ADR-0285's bound on the shared `millis`, so
every new case passes on arrival. That is the expected outcome for a
characterization pin and no GREEN sibling is opened. The pins are nonetheless
**discriminating**, measured in isolation against the two wrong shapes the card
names:

| Shape                                           | Degradations (4 pins)                                                                     | Controls (2 pins)                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| merged bound on the shared `millis` (on `main`) | pass                                                                                      | pass                              |
| numbers-only bound                              | **fail**: `+010000-…`, `+275760-…`, `-271821-…`, `-000001-…` printed instead of the epoch | pass                              |
| tighter "sanity bound" (`0 … 4102444800000`)    | pass                                                                                      | **fail**: both clamp to the epoch |

### D4 — the inverted docblock word

`apps/web/src/test/unit/tenant-members-joined-at.test.ts:168` read "one
millisecond inside either end round-trips to its ISO string, **so a clamp may
not be looser than the wire format**". The two controls catch a clamp _tighter_
than the wire format — measured on the pin card's probe, a year-2100 "sanity
bound" reports `2 failed | 16 passed (18)` on exactly those two cases, and the
integration docblock and ADR-0284 §Consequences both say "tighter". The word is
corrected to `tighter`; no assertion changes.

### D5 — scope: test-only, additive

No production file, existing assertion, fixture, mock or helper changed. The unit
spec gains one appended `describe` block and the one-word correction; the
integration spec gains one case and its constant, and the carried block's
`describe` title plus the matching docblock word are widened from "numeric" to
cover the block the string case now sits in (its six carried pin cases are
untouched). ADR-0282, ADR-0283, ADR-0284 and ADR-0285 are untouched.

## Evidence

Base `18df24b4`. `0286` is the OP-101 lane's `Next free` cell re-read on a fresh
`origin/main` immediately before committing (`| OP-101 CI lane-shape | 0280–0299 | 0286 |`),
and the number is free across every ref: no `.worktrees/*/docs/adr` tree and no
open PR head carries an `ADR-0286` path (`gh pr list --state open` = #272, #685,
#688, #690, #693; the highest `ADR-028*` they carry is `0283`).

| Spec                                                      | Base (this head) | After these pins |
| --------------------------------------------------------- | ---------------- | ---------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `18 passed` (18) | `24 passed` (24) |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `28 passed` (28) | `29 passed` (29) |

The numeric block's six unit cases and four route cases are unchanged and still
green. Six new unit cases (4 degradations + 2 controls) and one new route case
are green on arrival, by construction (D3). `tsc -p apps/web/tsconfig.json
--noEmit` exits `0`; `eslint` reports no issues and `prettier --check` is clean
on both specs.

## Consequences

- **The window is now load-bearing on both arms.** A future "optimisation" that
  bounds only numbers — the plausible GREEN shape this card closes — breaks four
  unit pins and one route pin immediately. A bound tighter than the wire format
  breaks the two string controls, mirroring the numeric controls.
- **Cost.** Six unit cases and one route case; no measurable suite-time change
  (unit file `0.8s`, integration file `7.2s` at this head).
- **No production, route, schema or storage change is implied.** `tenantMembers`
  still carries no validator (ADR-0282 §D4); the listing order item stays open.

## Alternatives considered

- **Note the string arm in prose only, pin nothing** — rejected: the card's own
  measurement shows a numbers-only bound passes all 18 pins, so the 500 class
  would stay reachable and untested.
- **Fold the string case into the numeric block without touching its title** —
  rejected: a block titled "a numeric `joinedAt` …" that carries a string case is
  the under-describing-title defect this board already routed once
  (`t_a609b659`); the title and one docblock word are widened instead.
- **Duplicate `insertRawMembership()` into a third sibling block** — rejected:
  the file already declares it twice, and the card directs reuse of the one in
  the numeric block.
- **Assert on the reader's internals** (that the bound covers strings, or its
  constants) — rejected: the observable contract is the projected string and the
  status code.

## ADR number allocation

`0286` is the OP-101 lane's `Next free` cell value in `docs/adr/README.md`, read
on a fresh `origin/main` `18df24b4` immediately before committing. The lane range
is `0280`–`0299` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md));
`0280`/`0281` are the tenant-members RED/GREEN pair, `0282` the defensive-restore
pins, `0283` its GREEN, `0284` the numeric instant-range pins and `0285` their
GREEN. This record advances the cell to `0287`. No number outside the lane range
is touched.
