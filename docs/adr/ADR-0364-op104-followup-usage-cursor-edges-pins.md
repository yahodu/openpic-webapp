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

## Review and landing — PR [#704](https://github.com/yahodu/openpic-webapp/pull/704)

Reviewed head `56cfe2e1`; docs sign-off `t_7b3d9947`. **Verdict: APPROVED** —
round 1, artifact lens, no finding that required a card. Squash-merged as
`5e1a05de` onto `origin/main` `6c4fb8b3`, followed by the release commit
`84378fa0`; PR `#704` is `MERGED` at `2026-11-19T04:37:21Z`.

### Landing proof

- **Tree identity.** `git rev-parse 56cfe2e1^{tree} 5e1a05de^{tree}` prints
  `7e20ead9…` twice and `git diff --stat 56cfe2e1 5e1a05de` is empty, so the
  reviewed bytes are the trunk bytes; the squash is an ancestor of `origin/main`
  (`git merge-base --is-ancestor 5e1a05de origin/main` exits `0`).
- **Scope, measured.** `git show --stat 5e1a05de` is **3 files, +228 / −1**: the
  spec (+78), this record (`A`, 146 lines) and the ledger (5 lines — the `0364`
  index row, the cell `0364` → `0365` and the lane note). No production file is
  touched, which is what a characterization-pin delivery must show.
- **The head branch was auto-deleted.** `git ls-remote --heads origin` lists no
  `OP-104-task-usage-cursor-edge-pins`, and local `main` equals `origin/main` at
  `513284e5` — the squash plus the two later trunk commits (`c2f079da` for
  [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md)
  and `513284e5` for the ADR-0363 sign-off).

### Checks run by the review at `56cfe2e1`

- **Focused integration** (`entitlements-endpoints.test.ts`): **31 passed (31)**,
  was 29 — the two new pins green on arrival, as §Decision declares.
- **Both pins are load-bearing.** A throwaway probe worktree at `56cfe2e1`, one
  `view.ts` mutation at a time, each run filtered to the single pin under test,
  every mutation reverted and the worktree removed afterwards. **Guard
  disabled** → L5 red, `AssertionError: expected 500 to be 400`; **keyset `$lt`
  → `$gte`** → L6 red, `expected [ { …(4) }, { …(4) } ] to deeply equal []`. Both
  filtered runs read `1 failed | 30 skipped`; that is the probe's shape, and
  §Evidence records the same two mutations over a wider selection, so the two
  readings do not conflict.
- **The formerly-uncovered line left the uncovered set.** Focused coverage scoped
  to `view.ts`: **100 % statements 54/54, branches 36/36, functions 14/14, lines
  49/49** ("1 file fully covered"). The line §Context named as the last `view.ts`
  line outside coverage is the line L5 now executes.
- **Static gates.** `pnpm typecheck` exit `0` on all three projects; `eslint`
  exit `0`; `prettier --check` clean on the three touched files.
- **The six ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`): **236
  passed (236)**.
- **Remote checks 14/14** at `56cfe2e1`, none of them a rerun. On the merged PR
  the rollup has 15 rows, all `SUCCESS`; the fifteenth is the `notify-discord`
  close side-effect run, not a gate.

### Checks re-run on this sign-off's base

The numbers above are the review's; these were measured again at `513284e5`
before this section was appended, so the trunk is known to still carry them:

- focused integration `entitlements-endpoints.test.ts`: **31 passed (31)**;
- the six ADR guards with this section in place: **236 passed (236)** —
  `adr-numbering` alone **29 passed (29)**.

### Two Info notes, neither routed to a card

1. **`L6`'s full-envelope `toEqual` on `page` is deliberate.** It couples the pin
   to the §0.8 three-key page envelope on purpose: a case that asserted only
   `data: []` would stay green while `nextCursor`, `hasMore` or `limit` drifted,
   and those three keys are exactly the contract this edge exists to pin. That
   is a change detector, not brittleness to repair — the same posture as the
   carried L2 pagination case.
2. **`L5` asserts `status` and `error.code` only** — not `message`, `requestId`
   or `retryable`. The error envelope's wording and its correlation fields are
   owned and pinned elsewhere; asserting them here would couple a cursor pin to
   text it does not own. §L5 already states this choice.

### Number, ledger and routing

- **This section consumes no ADR number and no index row.** `docs/adr/README.md`
  is byte-identical to `origin/main` in the sign-off PR (blob `abfeae0c…` before
  and after; `git diff --name-only origin/main...HEAD` does not list it).
- The record itself consumed `0364` as §ADR number allocation states, and the
  lane cell read `0365` on the trunk it was cut from. Measured at this sign-off's
  base `513284e5`: the cell reads **`0366`**, and exactly one `ADR-0364` path
  exists across all refs (`git rev-list --objects --all -- docs/adr` counts one),
  so the number stayed unique.
- **Routing, as it resolved.** The card that commissioned this note told the open
  follow-up `t_8ac61afe` (P1/P2 performance, backend-coder) to take `0365` and
  advance the cell to `0366`, with the ADR-0363 sign-off `t_621fba28` gated
  behind it. Both have since landed — `t_8ac61afe` as PR `#705` (squash
  `c2f079da`, [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md))
  and `t_621fba28` as PR `#706` (squash `513284e5`) — so nothing remains gated on
  this record's card. The card predicted the cell would read `0365` when this
  note ran; it read `0366` because those two landed first. That is a stale
  prediction in the card, not a second consumption of a number.

**No decision in §L5, §L6 or §What is deliberately unchanged is retracted.**
§Consequences predicted that a regression would fail as `expected 500 to be 400`
on L5 and as a non-empty page on L6; the review reproduced exactly those two
reds by mutation, so the consequences are measured, not assumed. Nothing else in
this record needed amending, and this section only adds what review and landing
measured afterwards.
