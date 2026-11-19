# ADR-0371 — OP-104 follow-up TEST: the bounded grant read's `validFrom` and strict `validUntil` clauses are pinned

- **Status:** Accepted (TEST; both pins are **characterization** — green on arrival at `origin/main` `8d8f2c13`, no GREEN sibling opened)
- **Date:** 2026-11-19
- **Card:** OP-104 TEST follow-up (`t_6d79f7d6`) · **Branch:** `OP-104-task-grant-read-clause-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_6d79f7d6`
- **Relates to:** [ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md) (the bounded grant read these pins characterize), [ADR-0370](ADR-0370-op104-followup-corrupt-grant-row-pins.md) (the L9/L10 pair whose two unpinned clauses this record closes), [ADR-0367](ADR-0367-op104-followup-corrupt-counter-row-pins.md) (the counter-row twins), [ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md) (the pin-card posture), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.7 (status codes) · **Schema:** §14.2
- **Consumers:** `apps/web/src/test/integration/entitlements-endpoints.test.ts`

## Context

[ADR-0370](ADR-0370-op104-followup-corrupt-grant-row-pins.md) (PR #712, squash
`432366b0`) pinned the corruption delta of the bounded grant read with two cases,
L9 and L10. Its L9 corrupt row is `validFrom 2025-01-01` → `validUntil
2025-02-01`, and that window is excluded by the **`$or`** clause alone. The review
that landed it (`t_8f1dac13`, finding **F1**) then mutated `view.ts` one clause at
a time and measured that **all 35 delivered cases stayed green** under either
mutation:

| Mutation                                           | Delivered 35 cases | Arm that would catch it                                 |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| drop `validFrom: { $lte: now },`, keep the `$or`   | 35/35 green        | corrupt row `validFrom 2027-01-01`, `validUntil: null`  |
| `{ validUntil: { $gt: now } }` → `{ … $gte: now }` | 35/35 green        | corrupt row `validFrom 2026-01-01`, `validUntil == now` |

So the read's two other clauses had no pin: a future-dated grant (`validFrom`)
and the half-open upper boundary (`$gt`, not `$gte`). Both omissions are silent
under the current suite, which is exactly the class of regression L9 exists to
catch. This record closes them.

## Decision

Two cases are appended to the existing
`describe("GET /api/v1/tenants/{tenantId}/entitlements")` block in
`apps/web/src/test/integration/entitlements-endpoints.test.ts`, in the same style
and with the same helpers as L9/L10 (`seedWorkspace`, `seedPlan`,
`seedSubscription`, `seedGrant`, `seedCounter`, `entitlementsRequest`,
`entitlementRowFrom`, `body`, `errorEnvelope`, the frozen `FROZEN_NOW` clock).
The file goes from **35** to **37** cases; no carried case, L9 and L10 included,
is edited. A doc block at the head of the file declares the characterization
status in the same words as this record.

Both cases use L9's workspace shape exactly: a `starter` plan whose
`storage.bytes` spec is `tenant`-scoped, `lifetime`, `limit: 100`,
`enforcement: hard`; an `active` `starter` subscription; one **well-formed**
grant (`delta: 4`, `validFrom 2026-01-01`, `validUntil: null`); a `lifetime`
counter row with `value: 7`; and one **corrupt** row (`delta: "not-a-number"`)
inserted raw through `app.db.collection(COLLECTIONS.entitlementGrants)`, because
the file's `seedGrant` types `delta` as `number`.

### L11 — a corrupt row whose window has **not started** is ignored

`validFrom 2027-01-01T00:00:00.000Z`, `validUntil: null`. The row has not begun
at `FROZEN_NOW`, so only the `validFrom: { $lte: now }` conjunct excludes it; the
`$or` keeps it (`validUntil: null`). Assertions: `200`, the body still satisfies
the file's `entitlementsBodySchema`, the `storage.bytes` row matches `{ key,
limit: 100, effectiveLimit: 104, used: 7, remaining: 97, periodKey: "lifetime",
unlimited: false }`, and `grants` `toEqual` exactly
`[{ delta: 4, source: "purchase", validUntil: null }]`.

**A red L11 means the read lost its `validFrom` bound** — e.g. back to
`find({ $or: … })` — which restores the pre-ADR-0366 `500 internal_error` for
this seed.

### L12 — a corrupt row whose window ends **exactly at `now`** is ignored

`validFrom 2026-01-01T00:00:00.000Z`, `validUntil: new Date(FROZEN_NOW.getTime())`.
The row started in the past, so `validFrom` keeps it; it ends on the frozen
instant, so only the **strict** `$gt` excludes it. Same assertions as L11.

**A red L12 means the `$or` relaxed to `$gte`**, which would fetch — and so
parse-refuse — a grant on its own expiry instant, i.e. count a grant for one
instant past the half-open window ADR-0366 declared.

### Why one clause per case, not one combined case

The card allows a combined case only if each arm is separately load-bearing. Two
cases make the discrimination legible: under mutation 1 only L11 reddens, under
mutation 2 only L12 reddens (§Evidence). A combined case would fail on either
mutation with one message and leave the reader guessing which clause moved.

### What is deliberately unchanged

No production file, existing assertion, fixture, mock or helper. `view.ts`, the
`entitlements` route and the grant schema are untouched; no new import is added
(`ObjectId`, `COLLECTIONS` and `FROZEN_NOW` were already in the file). No test
title embeds a source line number.

## Evidence

Measured in this worktree on `origin/main` `8d8f2c13`, real command output.

- **Focused integration spec**
  (`npx vitest run --project integration apps/web/src/test/integration/entitlements-endpoints.test.ts`):
  **37 passed (37)** — the 35 carried cases (measured at the same head before the
  edit) plus L11 and L12, both green on arrival as declared.
- **Mutation probe, in a throwaway detached worktree** at
  `/root/.hermes/profiles/openpic-webapp-testcase-writer/cache/scratch/probe-t_6d79f7d6`
  (never the lane worktree; `node_modules`, `apps/web/node_modules` and
  `packages/contracts/node_modules` symlinked in, the lane's spec copied in).
  `view.ts` there hashed `92e83ccd585f6aae0c2096fd2e2ce618f46b7b90ab998965e64eff580ea867cb`,
  the value ADR-0370's probe recorded. Baseline in the probe: `Test Files 1
passed (1)` / `Tests 37 passed (37)`.

  1. **Drop the `validFrom` conjunct** — `find({ validFrom: { $lte: now }, $or: … })`
     → `find({ $or: … })`:

     ```
     × L11 characterization: a malformed grant row whose window has not started is ignored, and the view still answers 200
     AssertionError: expected 500 to be 200 // Object.is equality
     Test Files  1 failed (1)
           Tests  1 failed | 36 passed (37)
     ```

     **L9, L10 and L12 are among the 36 passed** — the mutation is caught by L11
     alone.

  2. **Relax the upper bound** — `{ validUntil: { $gt: now } }` →
     `{ validUntil: { $gte: now } }`:

     ```
     × L12 characterization: a malformed grant row whose window ends exactly at `now` is ignored, and the view still answers 200
     AssertionError: expected 500 to be 200 // Object.is equality
     Test Files  1 failed (1)
           Tests  1 failed | 36 passed (37)
     ```

     **L9, L10 and L11 are among the 36 passed** — the mutation is caught by L12
     alone.

- **Restore.** `git checkout -- apps/web/src/server/services/entitlements/view.ts`
  in the probe returned the file to the same sha256
  `92e83ccd…867cb`, `git status --short` showed only the copied spec (`M`), and
  the pre-mutation run was reproduced with `Tests 37 passed (37)`.
- **Gates** (`CI=true TMPDIR=/root/tmp-mongo`, this worktree): focused
  integration **37 passed (37)**; `pnpm typecheck` exit **0** on all three
  projects; `eslint` **0** issues on the spec; `prettier --check` clean on the
  spec, this record and the ledger; the six ADR guard files **236 passed (236)**;
  and the full unit + integration suite with coverage **exit 0** at **333 files /
  4690 passed (3 skipped)**, global **91.82 % statements / 80.76 % branches /
  96.06 % functions / 91.94 % lines** — the same global figures as the parent
  head, so the two new cases add coverage without moving any gate.

## Out of scope

- **No GREEN sibling.** Both cases pass on arrival; nothing is routed to an
  implementer. The card says to stop and report if either pin failed — neither
  did.
- **The corrupt rows are not deleted, repaired, logged or quarantined.** Whether
  such a row should be reported is a data-repair question for the reconciliation
  path, not for this read's contract.
- **No `effectiveLimit`/`grants` claim about a grant whose window is
  _degenerate_** (`validFrom` after `validUntil`). That shape is not a read-bound
  question — the row would be excluded by both clauses — and no product path
  writes it.
- **No assertion on the number of documents fetched.** That is the sibling index
  card's performance claim (`t_a3fcf2e2`), not a status/body pin.
- **`grants` ordering stays unpinned**, as in ADR-0370: each case has a single
  well-formed grant, so its `toEqual` is order-free by construction.

## Consequences

- A regression that drops the `validFrom` conjunct now fails as `expected 500 to
be 200` on L11, instead of silently fetching and parse-refusing every
  not-yet-started grant into a `500` outage.
- A regression that relaxes `$gt` to `$gte` now fails on L12, instead of counting
  a grant on its own expiry instant.
- Each of the read's three clauses (`validFrom`, `validUntil: null`, `validUntil:
$gt`) now has at least one case that reddens when it alone changes: L11, L9 and
  L12 respectively. Together with L10's served-window contract, the bound is
  pinned from both sides.
- ADR-0366's predicate is now executable per clause rather than as one opaque
  `find({...})` string, so a future edit to either bound is a red test, not a
  review-time reading exercise.

## ADR number allocation

The OP-104 lane holds `0360`–`0379`. The lane's `Next free` cell read `0371` on
`origin/main` `8d8f2c13` immediately before committing. The mandatory sweep —
`.worktrees/*/docs/adr/` and every open PR head (`#714`, `#690`, `#688`, `#685`,
`#272`) — found `0370` as the highest number in flight in this lane (landed by
PR #712); `0369` is reserved by the sibling index card `t_a3fcf2e2`, whose open
PR `#714` carries no record for it yet. This record therefore takes **`0371`**,
the number the card reserved, and the lane cell advances from `0371` to
**`0372`**. No number outside the lane range `0360`–`0379` is touched, and no
higher cell is lowered.
