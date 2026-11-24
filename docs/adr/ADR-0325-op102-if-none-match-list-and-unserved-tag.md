# ADR-0325 — OP-102 follow-up TEST: pin the `If-None-Match` list form at all three call sites and an unserved stored edit's tag stability

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-102 follow-up TEST (`t_f9d8f6a9`) · **Branch:** `OP-102-task-if-none-match-list-and-unserved-tag` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e3951910`
- **Relates to:** [ADR-0324](ADR-0324-op102-addons-conditional-get-pin.md) (the round-1 review that raised these two **Low** findings; the record this one closes), [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the add-on catalogue contract), [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) (the same representation rule for `/plans`), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's ledger row), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.10 (ETags / conditional requests), §3.1 (`/plans`), §3.6 (`/addons`), §7.2 (unread count) · **Schema:** ADR-0320 (no §14.x row exists for `addons`)
- **Supersedes:** nothing · **Superseded by:** nothing

## Context

Two assertions were missing, both **additive** and both measured on `origin/main`
`e6e48fba` by the round-1 review of [ADR-0324](ADR-0324-op102-addons-conditional-get-pin.md)
(now re-measured at `412d64ba`).

**F1 — the list form is unpinned.** Three routes hand `If-None-Match` to the
shared RFC 7232 helper:

| Call site                                         | Header comparison                      |
| ------------------------------------------------- | -------------------------------------- |
| `apps/web/src/app/api/v1/addons/route.ts`         | `ifNoneMatchSatisfied(ctx.request, …)` |
| `apps/web/src/app/api/v1/plans/route.ts`          | same                                   |
| `…/api/v1/me/notifications/unread-count/route.ts` | same                                   |

Every shipped pin presents **one** exact tag (or one stale tag). Measured: replacing
the call at `addons/route.ts` with `ctx.request.headers.get("if-none-match") === etag`
left `addons-endpoint.test.ts` at **10 passed (10)**, while the RFC 7232 list form
(`If-None-Match: "other-tag", <etag>`) still answered `304`. So all three endpoints
could silently drop list membership — a real client that sends the tag it holds inside
a list would stop revalidating — with no failing test. The helper's own unit spec
(`@/server/http/etag.test.ts`) pins the helper, not its use, and ADR-0324's "what
stays unpinned" list named `*` and the weak wire form but **not** the list form.

**F2 — the tag's direction is pinned one way only.** ADR-0324's case 5 proves a
**served** change moves the tag. The inverse was unpinned: a change to a **stored but
unserved** field must leave the tag alone. Measured at `e6e48fba`:
`makeAddon({ grantDelta: 100 })` → `makeAddon({ grantDelta: 200 })` keeps the served
body byte-identical and the tag unchanged. `grantDelta` is stored
(`@/server/plans/addons.ts`) and absent from the §3.6 served schema (`projectAddon`
never emits it), so it is a legitimate unserved field.

## Decision

### The three list-form cases live in the files that already own each route

| Route         | Home                                                      | Why not the alternative                                                                                                         |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /addons` | `addons-endpoint.test.ts` (appended `describe`)           | ADR-0324 chose this harness for §3.6; one boot, one seed helper                                                                 |
| `GET /plans`  | `plans-etag-representation.test.ts` (appended `describe`) | **not** `conditional-etag.test.ts`: that file drives a synthetic `defineRoute` pair, so it pins the stage, not `plans/route.ts` |
| unread count  | `notification-unread-count.test.ts` (appended `describe`) | the I5 block is this route's only conditional-GET home                                                                          |

No shipped case, helper or import of those files is edited — the diff to each is a
pure append. One case per call site asserts **both** arms: a two-member list that
contains this response's tag revalidates to `304` (with the tag echoed and a `0`-byte
body), and a two-member list of only _other_ tags answers the full `200`. The
negative arm is what stops an always-`304` route from satisfying the case.

The two-member list is built as `` `"older-tag", ${etag}` `` so the case makes no
assumption about the served tag's shape (`/addons` answers a strong tag,
`/plans` and the unread count answer weak `W/"…"` ones) — RFC 7232 §3.2 allows
either inside a list, and the weak comparison matches on the opaque value.

### The unserved-edit case asserts the body before the tag

`keeps the served body and the ETag when only a stored-but-unserved field changes`
re-seeds the same add-on with a different `grantDelta`, reads the stored document
back (`expect(stored?.grantDelta).toBe(200)`, so a silently failed seed cannot
satisfy it), asserts the **served body is `toEqual`** the previous one, asserts
`grantDelta` is absent from the served item, and only then asserts the `etag` is
byte-identical. Body first, so the tag assertion cannot be vacuous.

## Evidence

### This is a characterisation pin: green by design, and that is proved

Both behaviours are already on `main`. Measured **before** the append (three files,
`24 passed (24)`) and **after** (`28 passed (28)`); the four new cases are the delta.
**No case came out RED.** Per the card, a RED would have been a production bug to
report instead of a pin to land; there was none.

Each pinned arm was proved load-bearing by mutating production code, running the spec,
and restoring the tree (`git status --short` afterwards shows only the three spec
files; each mutated file's `sha256` was re-checked against its pre-probe hash):

| Probe | Mutation                                                                                 | Result                                                                                                                           | Reading                                                 |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A1    | `addons/route.ts`: `ifNoneMatchSatisfied(...)` → `headers.get("if-none-match") === etag` | `1 failed \| 11 passed` — the addons list-form case: `expected 200 to be 304`                                                    | the addons call site's list membership is pinned        |
| A2    | same literal compare at `plans/route.ts`                                                 | `1 failed \| 6 passed` — the plans list-form case: `expected 200 to be 304`                                                      | the plans call site's list membership is pinned         |
| A3    | same literal compare at `me/notifications/unread-count/route.ts`                         | `1 failed \| 8 passed` — the unread list-form case: `expected 200 to be 304`                                                     | the unread call site's list membership is pinned        |
| B     | `addons/route.ts`: tag hashed over the **raw stored documents** (over-invalidating)      | `2 failed \| 10 passed` — the unserved-edit case: `expected '"49194eb3…"' to be '"1adf2238…"'` (the body equality above it held) | the unserved-edit case pins the tag's inverse direction |

Probes A1–A3 are the reviewer's F1 mutation, applied once per call site so that no
single route can regress unpinned. Probe B is the F2 mutation: hashing the raw
document moves the tag on an edit that changed no served byte.

### Why the inverse — hashing the raw stored document — would be wrong

A tag exists to let a client reuse the bytes it already holds. A body-level hash of
the **stored** document also covers fields the projection strips (`grantDelta`,
`prices[].externalRefs`, `validFrom`/`validUntil`, `_id`), so any back-office edit to
one of them mints a new tag for an unchanged representation and forces every client to
refetch the whole catalogue. Because a `304` refreshes `max-age`, the cost is a
permanent traffic multiplier on the public pricing read for no freshness gain. The
correct identity is the **served** representation (`hashCatalogueTag(JSON.stringify(
data))`), which is what `addonCatalogueETag` already hashes — so the pin is the
inverse direction of ADR-0324's case 5, not a different design.

### Suite state at the branch head

`npx vitest run --project integration <the three files>` → **28 passed (28)**
(24 shipped + 4 new). `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0
errors and no new warnings; `prettier --check` clean on all three files; the
`docs/adr/` guards (`adr-numbering`, `adr-lane-ranges`, `adr-ledger-shape`,
`adr-ledger-links`, `adr-record-links`, `adr-source-references`) green with this
record and its ledger row.

## Consequences

- All three routes that consume `ifNoneMatchSatisfied` now fail loudly if one
  re-implements the comparison as a string equality: `expected 200 to be 304`, from a
  case whose name names the route.
- The tag's stability under an unserved edit is pinned, so a future
  "simplification" to a raw-document hash breaks a test that explains why it is wrong
  instead of quietly multiplying refetches.
- Nothing about the tag's shape, the digest, or the exact `304` header set beyond
  `etag` (and `cache-control` where the shipped cases already assert it) is pinned.
- Both cases are shape-agnostic on the tag's weakness, so a legitimate change to the
  wire form (`W/"…"` ↔ `"…"`) stays green.

## Alternatives

- **Pin the list form once, in `conditional-etag.test.ts`, "since it is the same
  helper".** Rejected: that spec builds a synthetic `defineRoute`, so it would pass
  with all three real routes re-implementing the comparison — exactly the regression
  F1 describes.
- **One case asserting only the matching arm.** Rejected: an always-`304` route would
  satisfy it; every new case also asserts a list of only other tags → `200`.
- **Add a new spec file for the three-line arm.** Rejected by the card and by
  ADR-0324's own measurement: a new file re-declares helpers and boots another Mongo
  application for the same routes.
- **Use `prices[].externalRefs` as the unserved field instead of `grantDelta`.**
  Equivalent; `grantDelta` was chosen because the reviewer measured it and it is a
  scalar, so the edited document is unambiguous.

## Number allocation

The **OP-102** lane `Next free` cell read `0325` at the branch head
(`origin/main` `412d64ba`); this record takes `0325` and advances the cell to
`0326`. No number outside the lane range `0320`–`0339` is touched.
