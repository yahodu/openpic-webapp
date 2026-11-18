# ADR-0287 — OP-101 TEST: a **`Date`** `joinedAt` outside the four-digit-year window must not deny the members listing either

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** OP-101 TEST (Low, `t_07bc5990`) · **Origin:** review finding F1 on the string-arm pin card `t_e9bf64f1` (PR [#699](https://github.com/yahodu/openpic-webapp/pull/699), squash `0441efde`) · **Docs sign-off:** pending
- **Branch:** `OP-101-task-tenant-members-date-arm-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1d41c1e4`
- **Base:** `origin/main` `bde5e469` (PR [#700](https://github.com/yahodu/openpic-webapp/pull/700), the PR #694/#698/#699 review sign-offs).
- **Spec sources:** API contract §2.2 (tenant members — the `Member` DTO and its `joinedAt`); schema §13.4 (`tenantMembers`, no validator on the collection); the executable wire shape in `@/server/tenancy/member-schema` (`joinedAt: isoDateTimeSchema`, i.e. `offset: false`, `precision: 3`, **non-nullable**).
- **Relates to:** [ADR-0282](ADR-0282-op101-tenant-members-pins.md) (the undatable-instant sentinel), [ADR-0283](ADR-0283-op101-tenant-members-defensive-restore.md) (the reader), [ADR-0284](ADR-0284-op101-tenant-members-instant-range-pins.md) (§D1's "**whatever** the stored `joinedAt`"), [ADR-0285](ADR-0285-op101-tenant-members-instant-range-green.md) (the bound on the shared `millis`), [ADR-0286](ADR-0286-op101-tenant-members-string-instant-pins.md) (the string arm), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Consumers:** `apps/web/src/test/unit/tenant-members-joined-at.test.ts`, `apps/web/src/test/integration/tenant-members.test.ts`

## Context

ADR-0284 §D1 states the contract for **whatever** the stored `joinedAt` is:
`projectMember()` returns a §2.2 member whose `joinedAt` is
`isoDateTimeSchema`-valid — the exact instant inside
`-62167219200000 … 253402300799999`, the epoch sentinel otherwise. ADR-0285
implemented that bound on the reader's shared `millis`, after the read, so all
three kinds the reader accepts are covered by one guard: a `Date` (its
`getTime()`), a string and a number (both `new Date(value).getTime()`).

The pin set is nonetheless **under-determined for the third arm**. ADR-0284
pinned the numeric arm and ADR-0286 the string arm; both blocks label their
extreme rows "the Date maximum" and "the Date minimum", but the values are the
**numbers** `8.64e15` and `-8.64e15`, never a `Date` instance. A stored `Date`
is storable — BSON keeps it as int64 milliseconds, so `new Date(8.64e15)` is a
legal document on a collection that carries no validator — and it reaches the
identical defect class through `value.getTime()`.

Measured at the predecessor's head `1156a8ab` in a throwaway probe worktree,
with a reader that bounds **numbers and strings** to the window and leaves the
`Date` arm on `Number.isFinite` only — that is, exactly the shape the delivered
pins enforce today:

```
pinned unit file: 24 passed (24)          <-- nothing reds
Date(8.64e15)         -> "+275760-09-13T00:00:00.000Z"    schemaOk=false
Date(-8.64e15)        -> "-271821-04-20T00:00:00.000Z"    schemaOk=false
Date(253402300800000) -> "+010000-01-01T00:00:00.000Z"    schemaOk=false
Date(-62167219200001) -> "-000001-12-31T23:59:59.999Z"    schemaOk=false
Date(253402300799999) -> "9999-12-31T23:59:59.999Z"       schemaOk=true
```

The first four are the `500` class: `serializeResponse` fails the strict parse
(`data.0.joinedAt: Invalid ISO datetime`) and the whole
`GET /api/v1/tenants/{tenantId}/members` listing is a `5xx` for every caller of
the workspace — ADR-0282's "one corrupt row denies the listing", reached through
a stored `Date`. Behaviour today is already correct, so the gap is in the pins,
not in the reader.

## Decision

### D1 — the `Date` arm is inside ADR-0284 §D1, and is pinned as its own arm

No new contract is created. ADR-0284 §D1 quantifies over **whatever** the stored
`joinedAt` is; this record only makes the pin set exercise the kind the reader
tests first. A stored `Date` whose instant lies outside the window is
**undatable for this purpose** and takes the epoch sentinel
`1970-01-01T00:00:00.000Z` exactly like the other two arms, and a `Date` naming
either window edge is served as itself.

The unit block pins four degradations (the first instant past the ceiling, the
`Date` maximum, the `Date` minimum and one millisecond below the year-0000 floor)
and both edges as green controls (`9999-12-31T23:59:59.999Z` → itself,
`0000-01-01T00:00:00.000Z` → itself), each case also asserting
`isoDateTimeSchema.safeParse(projected.joinedAt).success`. The route block gains
one `Date` case seeded raw in `tenantMembers`: `200`, the `x-tenant-id` header,
every member still listed, and the row's `joinedAt` at the sentinel.

### D2 — no mechanism is pinned

The assertions are on the projected string and the response status only. A bound
on the shared `millis` (ADR-0285's shape), a separate `Date` guard, or a bound
inside a shared reader all satisfy the pins. The unit docblock repeats ADR-0284's
"Contract expected of the implementation" without asserting where the bound
lives.

### D3 — these are characterization pins, and they discriminate

The `Date` arm is already closed by ADR-0285's bound on the shared `millis`, so
every new case passes on arrival. That is the expected outcome for a
characterization pin and no GREEN sibling is opened. The pins are nonetheless
**discriminating**, measured at this head by mutating the reader in place (the
mutation was reverted before the commit; `sha256sum` of
`apps/web/src/server/tenancy/members.ts` is `07debc66…` before and after):

| Reader shape                                                  | Unit file                    | Route case                   |
| ------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| merged bound on the shared `millis` (on `main`)               | `30 passed (30)`             | `30 passed (30)`             |
| numbers and strings bounded, `Date` on `Number.isFinite` only | `4 failed \| 26 passed (30)` | `1 failed \| 29 passed (30)` |
| tighter "sanity bound" (`0 … 4102444800000`)                  | `6 failed \| 24 passed (30)` | not measured                 |

Under the tight bound the six reds are the window-edge controls of **all three**
arms — both numeric, both string and both `Date` — each printing the epoch where
its own edge instant is expected, which is how the two `Date` controls catch a
clamp tighter than the wire format.

The four reds of the numbers-and-strings mutation print `+010000-01-01T00:00:00.000Z`, `+275760-09-13T00:00:00.000Z`,
`-271821-04-20T00:00:00.000Z` and `-000001-12-31T23:59:59.999Z` against the
expected epoch, and the route case reds with `expected 500 to be 200` behind the
logged `Response for /api/v1/tenants/:tenantId/members did not match its schema:
data.0.joinedAt: Invalid ISO datetime` thrown at `serialize-response.ts:58`.

### D4 — the raw insert really stores the `Date`

The route case would be vacuous if the driver coerced the seeded value, so the
case reads the row back before it lists and asserts
`stored.joinedAt` equals `new Date(8.64e15)` — the same `app.db`
`tenantMembers` read the file's other helpers use. It passed, so the case
exercises the `Date` arm and not a coerced string, and the seed stays honest if
a future driver or harness change starts rewriting values.

### D5 — scope: test-only, additive

No production file, existing assertion, fixture, mock or helper changed. The unit
spec gains one appended `describe` block; the integration spec gains one case
(and its one local constant) in the block that already carries the numeric and
string route cases, reusing that block's local `insertRawMembership()` unchanged.
Two documentation words on that carried block are widened from "numeric or
string" / "any finite numeric `joinedAt`" to cover the kind the block now also
pins — the under-describing-block defect this board already routed once
(`t_a609b659`) — and no assertion moves. ADR-0282, ADR-0283, ADR-0284, ADR-0285
and ADR-0286 are untouched.

## Evidence

Base `bde5e469`. `0287` is the OP-101 lane's `Next free` cell re-read on a fresh
`origin/main` immediately before committing (`| OP-101 CI lane-shape | 0280–0299 | 0287 |`),
and the number is free across every ref: no `.worktrees/*/docs/adr` tree carries
an `ADR-0287` path (their highest is `ADR-0286`), and no open PR head does either
(`gh pr list --state open` = #272, #685, #688, #690, #693; the highest `ADR-028*`
they carry is `0283`).

| Spec                                                      | Base (this head) | After these pins |
| --------------------------------------------------------- | ---------------- | ---------------- |
| `apps/web/src/test/unit/tenant-members-joined-at.test.ts` | `24 passed` (24) | `30 passed` (30) |
| `apps/web/src/test/integration/tenant-members.test.ts`    | `29 passed` (29) | `30 passed` (30) |

The numeric block's six unit cases, the string block's six unit cases and the
five route cases they share are unchanged and still green. Six new unit cases
(4 degradations + 2 controls) and one new route case are green on arrival, by
construction (D3). `tsc -p apps/web/tsconfig.json --noEmit` exits `0` and
`prettier --check` is clean on both specs.

## Consequences

- **The window is now load-bearing on all three kinds the reader accepts.** A
  future "optimisation" that bounds the parsed value but exempts a `Date` — the
  plausible shape this card closes — breaks four unit pins and one route pin
  immediately, with the printed expanded-year strings naming the value.
- **Cost.** Six unit cases and one route case; no measurable suite-time change
  (unit file `1.31s`, integration file `7.50s` at this head).
- **No production, route, schema or storage change is implied.** `tenantMembers`
  still carries no validator (ADR-0282 §D4); the listing order item stays open.

## Alternatives considered

- **Note the `Date` arm in prose only, pin nothing** — rejected: the measured
  probe shows a numbers-and-strings bound passes all 24 delivered pins, so the
  500 class stays reachable and untested through a storable value.
- **Fold the `Date` case into the numeric block and call `8.64e15` "the Date
  maximum"** — rejected: that is the under-determination this record closes; a
  number and a `Date` take different branches of the reader.
- **Duplicate `insertRawMembership()` into a third sibling block** — rejected:
  the file already declares it twice, and the card directs reuse of the one in
  the numeric/string block.
- **Assert on the reader's internals** (that `instanceof Date` is bounded, or its
  constants) — rejected: the observable contract is the projected string and the
  status code.

## ADR number allocation

`0287` is the OP-101 lane's `Next free` cell value in `docs/adr/README.md`, read
on a fresh `origin/main` `bde5e469` immediately before committing. The lane range
is `0280`–`0299` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md));
`0280`/`0281` are the tenant-members RED/GREEN pair, `0282` the defensive-restore
pins, `0283` its GREEN, `0284` the numeric instant-range pins, `0285` their
GREEN and `0286` the string instant-range pins. This record advances the cell to
`0288`. No number outside the lane range is touched.
