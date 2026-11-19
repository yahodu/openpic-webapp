# ADR-0364 — OP-104 follow-up TEST: the non-hex cursor arm and the keyset edge past the oldest `/usage` row are pinned

- **Status:** Accepted (TEST; both pins are **characterization** — green on arrival at `origin/main` `6c4fb8b3`, no GREEN sibling opened)
- **Date:** 2026-11-19
- **Card:** OP-104 TEST follow-up (`t_a31130d4`) · **Branch:** `OP-104-task-usage-cursor-edge-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a31130d4`
- **Relates to:** [ADR-0363](ADR-0363-op104-followup-usage-bound-and-plan-keys-green.md) (the bounded `/usage` page these pins lock), [ADR-0362](ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md) (the RED half of that bound), [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) (the read contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §0.5 (envelopes), §0.7 (status codes), §0.8 (pagination), §3.5 (entitlements & usage) · **Schema:** §14.2

## Context

PR #703 (`t_010670d6`, squash `8c539a3b`) landed the bounded `/usage` page and was
approved with findings. P3 was a **coverage** finding, Low: two behaviours the
implementation introduced are correct but no case asserts them, so a regression
would be invisible.

1. `parsePageQuery`/`decodeCursor` (`apps/web/src/server/http/cursor.ts`) only
   guarantees `{ c: string, i: string }` non-empty (`cursorSchema` is
   `.strict()` with `.min(1)` on both halves). The `_id` half is a Mongo
   `ObjectId` only by convention, so `cursorFilterFor`
   (`apps/web/src/server/services/entitlements/view.ts`) rejects a non-24-hex
   `i` with `appError("invalid_cursor")`. That guard was the **only** line in
   `view.ts` outside coverage at the landed head (`view.ts` 97.22 % branches —
   the RED/GREEN evidence in ADR-0363 §Evidence names that same line).
2. A decodable cursor whose period precedes every row must answer an empty
   **terminal** page. The `$or` keyset
   (`{$or: [{periodKey: {$lt: c}}, {periodKey: c, _id: {$lt: ObjectId(i)}}]}`)
   is what produces that; a regression would surface as a `500` (an
   `ObjectId`-shaped cast error) or a silently repeated first page.

Both arms already behave correctly — the reviewer measured them in a throwaway
probe worktree at head `9e2ba5f2` (`{c: "2026-09", i: "zz"}` → `400
invalid_cursor`; `{c: "2020-01", i: "0123456789abcdef01234567"}` → `200` with an
empty `data` and a terminal `page`). This card is therefore a **pin** card: its
job is to make those two answers regression-visible, not to request behaviour
change.

## Decision

Two cases are appended to the existing `describe("GET
/api/v1/tenants/{tenantId}/usage")` block in
`apps/web/src/test/integration/entitlements-endpoints.test.ts`, reusing that
block's helpers unchanged (`getUsage`, `usageQueryRequest`, `seedWorkspace`,
`seedCounter`, `makeIdentity`, `body`, `errorEnvelope`) and the file's frozen
clock. The cursor is built with the production codec (`encodeCursor` from
`@/server/http/cursor`) rather than a hand-rolled `base64url` literal, so each
case states exactly what it means: _a cursor the platform codec accepts_.

### L5 — a decodable cursor whose `_id` half is not 24-hex is `400 invalid_cursor`

One counter row is seeded **in the cursor's own period** (`2026-09`, the frozen
clock's month) and the request carries `{ c: "2026-09", i: "zz" }`. The seeded
row is what makes the pin discriminating: without the guard the filter reaches
`new ObjectId("zz")`, the driver throws, and the route answers `500` — the
assertion `expected 500 to be 400` is the regression signal. An empty
collection would make a missing guard look like an ordinary empty page.

The case asserts the observable pair only: `status === 400` and
`error.code === "invalid_cursor"`. The message, `requestId` and `retryable`
fields are the platform error envelope's, already pinned elsewhere; asserting
them again would couple this pin to envelope wording it does not own.

### L6 — a cursor whose period precedes every row is an empty terminal page

Two counters are seeded in `2026-09` and `2026-10`, and the request carries
`{ c: "2020-01", i: "0123456789abcdef01234567" }` — a well-formed hex `_id`, so
the guard passes and the keyset alone must exclude both rows. The assertions are
`status === 200`, `payload.data` deep-equal `[]`, and `payload.page` deep-equal
`{ nextCursor: null, hasMore: false, limit: 40 }`: a terminal page, never an
unfollowable cursor, never a repeated first page.

### What is deliberately unchanged

No production file, existing assertion, fixture, mock or helper. `view.ts`,
`cursor.ts` and the `usage` route are untouched; the only new production import
in the spec is `encodeCursor`, which the route already uses. No test title embeds
a source line number (line numbers drift; the ADR cites `view.ts:285` as a
measurement of _this_ checkout, not as a contract).

## Evidence

Measured on this head (`origin/main` `6c4fb8b3` + the spec change), real command
output:

- **Focused integration spec**
  (`CI=true TMPDIR=/root/tmp-mongo pnpm exec vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **31 passed
  (31)** — the 29 carried cases plus L5 and L6, the two new ones green on
  arrival as declared.
- **Mutation probe (the pins are load-bearing).** `view.ts` sha256
  `02048b1911b97083a1547250acd50f3da59bbc9caec42731434db6c92cc15445` recorded,
  one mutation at a time, restored with `git checkout --` and re-hashed `OK`
  after each (the probe never enters the commit):
  - **M1 — guard disabled** (`if (!OBJECT_ID_HEX.test(cursor.i))` →
    `if (false && !OBJECT_ID_HEX.test(cursor.i))`). Filtered run:
    `Tests 1 failed | 1 passed | 29 skipped (31)`;
    `AssertionError: expected 500 to be 400 // Object.is equality` on L5. The
    seeded same-period row is what turns a missing guard into a `500`, and L6
    stays green because its `_id` is hex.
  - **M2 — keyset direction flipped** (`{ periodKey: { $lt: cursor.c } }` →
    `{ periodKey: { $gte: cursor.c } }`, i.e. the "silently repeated page"
    shape). Full file: `Tests 2 failed | 29 passed (31)` —
    `AssertionError: expected [ { …(4) }, { …(4) } ] to deeply equal []` on L6,
    plus the carried L2 pagination case going
    `expected [ { …(4) }, … ] to have a length of 1 but got 40`. Two cases red
    for one mutation is correct: both read the same keyset, and the carried case
    is the second half of the same contract.
- **`pnpm typecheck`** exit 0 on all three projects; **`eslint`** 0 errors on
  the touched spec; **`prettier --check`** clean.
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`) green with
  this record and ledger row in place.

## Out of scope

- **No GREEN sibling.** Both cases pass on arrival; the card opens no
  implementation work and the two performance findings from the same review stay
  on their own card (`t_8ac61afe`).
- `?limit=` bounds (`422` / clamp) are already pinned in
  `apps/web/src/server/http/cursor.test.ts` and by the carried L2 cases.
- A cursor whose `c` half is malformed in a way the codec accepts (for example a
  non-periodKey string) is **not** rejected, on purpose: `c` is an opaque string
  the read compares lexically, so such a cursor is an ordinary keyset position
  and L6 is precisely that shape. Only the `_id` half is a typed position.
- The `/entitlements` read (`readEntitlementsView`) has no cursor and is
  untouched.

## Consequences

- A regression that removes the `invalid_cursor` guard now fails as
  `expected 500 to be 400` on L5 instead of shipping as a `500` class nobody
  asserted; the guard's line leaves the uncovered set.
- A regression that drops or inverts the `$or` keyset now fails on L6 as a
  non-empty page and on the carried L2 pagination case as a repeated page.
- The two pins are green on arrival by design. A red L5/L6 on a future head
  means the read regressed, never that the spec is ahead of the code — the same
  posture as the OP-104 L4 characterisation pins.

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0364` on `origin/main`
`6c4fb8b3` (PR #703's squash advanced the cell from `0363` to `0364`). `0364` was
re-read from the ledger immediately before committing and was free on `main`, in
this worktree and on every remote ref at the cut, so this record consumes `0364`
and the cell advances to `0365`. No number outside the lane range `0360`–`0379`
is touched, and the still-in-flight sibling card `t_8ac61afe` is told to take
`0365`.
