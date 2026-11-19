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

## Review and landing — PR #716 (squash 461d83d4)

Reviewed head `bbbcc4905acc9cf87845a17a40d02cce0d6e0691` on card `t_6d79f7d6`;
this sign-off is card `t_34ffc481`, which consumes **no ADR number**, changes no
cell, and leaves `docs/adr/README.md` byte-identical. **Verdict: APPROVED WITH
FINDINGS (three Info; no re-review)** — both pins are load-bearing exactly as
§Decision claims, and one figure pair in §Evidence does not reproduce; it is
re-measured below.

Nothing above is retracted. §Context, §Decision (L11, L12 and the
"one clause per case" ruling), §Evidence's two mutation logs, §Out of scope and
§Consequences stand as written. The Status line already read `Accepted` at
delivery, and the reviewed head's tree **is** the squash's tree (§Landing proof),
so every measurement in §Evidence describes the bytes now on the trunk.

### Shape of the reviewed diff

The review base was `origin/main` `8d8f2c13`, and the trunk did not move while
the review ran. `git diff --stat 8d8f2c13...bbbcc49`:

| Path                                                           | Lines     |
| -------------------------------------------------------------- | --------- |
| `apps/web/src/test/integration/entitlements-endpoints.test.ts` | `+191 −0` |
| `docs/adr/ADR-0371-op104-followup-grant-read-clause-pins.md`   | `+185 −0` |
| `docs/adr/README.md`                                           | `+4 −1`   |

**Three paths, `+380 −1`.** The spec holds **37** `it(` blocks at the head, and
its hunk carries **no deletion at all**, so the 35 carried cases — L9 and L10
included — are byte-identical. No production file appears. The same diff holds no
new import, no test-environment conditional, no `.only`/`.skip`, no
`@ts-ignore`/`eslint-disable`, no `console.*` and no fixture-specific hardcoding:
the honesty audit is clean, and the delivery is tests plus this record plus the
ledger exactly as the card ordered.

### Landing proof

- **Squash.** `461d83d4365dd4f06e7a13bd4e1a27528046e71f`; PR
  [#716](https://github.com/yahodu/openpic-webapp/pull/716) is `MERGED` with
  `mergedAt 2026-11-19T08:11:56Z`, `headRefOid bbbcc49` and
  `mergeCommit 461d83d4`. The branch was deleted by the repository on merge.
- **Tree identity.** `git rev-parse bbbcc49^{tree}` and
  `git rev-parse 461d83d4^{tree}` both print
  `64528c03457eef4c02c2513400d0bc01e5bf7afa`, and `git diff --stat bbbcc49
461d83d4` prints nothing over the **whole** tree — the review ran on the
  shipped bytes, not on a near-copy.
- **Trunk at merge.** Local `main` == `origin/main` == `461d83d4` immediately
  after the merge, so the reviewed tree was also the trunk tree. The trunk has
  since advanced through `4cb72527` (PR #714,
  [ADR-0369](ADR-0369-op104-followup-grant-window-index.md), the `validUntil`
  index) and `62b855f5` (the `1.66.6` release chore);
  `git diff --name-only 461d83d4 origin/main` lists neither this record nor the
  spec, and `apps/web/src/server/services/entitlements/view.ts` still hashes
  `92e83ccd…867cb`. That is why the counts below were re-measured on today's
  trunk `62b855f5` and answer unchanged.

### Reviewer-run evidence

Measured by the review of `t_6d79f7d6`, independent of the delivery's own runs:

- **Focused integration**
  (`CI=true TMPDIR=/root/tmp-mongo … --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **37 passed
  (37)** at the reviewed head, and **37 passed (37)** again on the trunk
  `62b855f5` at this sign-off.
- **Standalone selection.** `-t "L11"` and `-t "L12"` each answer **1 passed |
  36 skipped (37)**, so neither pin is carried by its neighbour's seed.
- **Case count.** `grep -c '^\s*it('` on the spec reads **37** at the head and
  **35** at `8d8f2c13`; the hunk is `+191 −0`.
- **Static gates.** `prettier --check` clean on the spec, this record and the
  ledger; `eslint` exit **0** on the spec; `tsc -p` exit **0** on all three
  projects; the six ADR guard files **236 passed (236)**.
- **Full suite with coverage.** `vitest run --project unit --project integration
--coverage`: exit **0** — **333 files / 4690 passed (3 skipped)**, global
  **91.8 % statements / 80.69 % branches / 96.01 % functions / 91.91 % lines**,
  against the 80 % per-dimension thresholds in `vitest.config.ts`.
- **Remote checks.** `gh pr checks 716` — **14/14 pass** at `bbbcc49`.

### Load-bearing, re-measured

Two mutations in a throwaway **detached** probe worktree at `bbbcc49` — never the
lane tree — with `node_modules`, `apps/web/node_modules` and
`packages/contracts/node_modules` symlinked in. `view.ts` there hashed
`92e83ccd585f6aae0c2096fd2e2ce618f46b7b90ab998965e64eff580ea867cb`, the value
§Evidence and ADR-0370's probe record; baseline `Test Files 1 passed (1)` /
`Tests 37 passed (37)`.

| Mutation                                           | Full-file result             | Red case |
| -------------------------------------------------- | ---------------------------- | -------- |
| drop `validFrom: { $lte: now },`                   | `1 failed \| 36 passed (37)` | **L11**  |
| `{ validUntil: { $gt: now } }` → `{ … $gte: now }` | `1 failed \| 36 passed (37)` | **L12**  |

Both reds are `AssertionError: expected 500 to be 200 // Object.is equality` on
the case's `expect(response.status).toBe(200)` line. Under mutation 1 the other
three arrangement cases — L9, L10 and L12 — are among the 36 passed; under
mutation 2 it is L9, L10 and L11. Each clause therefore has exactly one case that
reddens when it alone moves, which is the claim §Decision makes and the reason
the card allowed two cases rather than one.

**Restore.** `git checkout -- apps/web/src/server/services/entitlements/view.ts`
returned the file to the same sha256 `92e83ccd…867cb`, `git status --short` was
empty, and the pre-mutation count was reproduced. The probe worktree was removed.

### Correction to §Evidence's coverage figures (finding I1)

§Evidence states the global figures as **`91.82 / 80.76 / 96.06 / 91.94`** and
concludes "the same global figures as the parent head, so the two new cases add
coverage without moving any gate". The reviewer ran the identical command at the
reviewed head and read **`91.8 / 80.69 / 96.01 / 91.91`** — same `333 files /
4690 passed (3 skipped)`, same exit `0`.

Both pairs are recorded here; the original is **not** rewritten. The quoted
quadruple is [ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md)'s
own head figures, not this delivery's, so the "same as the parent head" clause
rests on a stale pair: the parent head `8d8f2c13` measures
`91.8 / 80.69 / 96.01 / 91.91` — the pair
[ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md)
records, which is the expected shape for a test-only delivery. No gate moves
either way: the command exits `0` with global branches at **80.69** against the
80 % threshold, so §Evidence's _conclusion_ holds — the two cases add pins
without moving a gate — while its _figure pair_ does not reproduce. The
re-measured pair stands beside it.

### Findings recorded, no code change routed

Both are Info, and both leave the delivery as specified:

| Finding | Location         | Subject                                                                                                                                                                                                                                                 | Routed to                  |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **I2**  | spec L11 and L12 | Neither case asserts that the corrupt row was written, so the "ignored" half is vacuous on its own — on an empty collection the same assertions pass. L9 has the same shape. The mutation probe is what proves the row is present and would be fetched. | no action; legibility note |
| **I3**  | spec L9/L11/L12  | The three seed blocks are near-identical (~65 lines each). The commissioning card prescribed "same seed shape as L9", so this is a deliberate delivery choice in a test file, not an accident.                                                          | no action; card-prescribed |

I2 is a **coverage** gap rather than a defect: a case that also asserted the raw
insert would make the pair self-evident, but the pins are load-bearing as
measured above, so no card is opened against a green, merged, behaviour-preserving
delivery.

### ADR-number ruling

**`0371` stands and no re-cut is needed.** The mandated sweep at the cut —
`.worktrees/*/docs/adr/`, `git rev-list --objects --all -- docs/adr`, and every
open PR head (`#690`, `#688`, `#685`, `#272`) — found the number held by exactly
one record file name, `ADR-0371-op104-followup-grant-read-clause-pins.md`, and by
no open PR head; worktrees that carry it carry it from the trunk. The trunk held
`0360`–`0368` plus `0370`, and `0369` was in flight on the sibling index card
`t_a3fcf2e2` / PR #714. That PR landed as `4cb72527` with
[ADR-0369](ADR-0369-op104-followup-grant-window-index.md) while this sign-off was
being cut — the lane's intended order, with no number reused. The lane cell reads
**`0372`** on `origin/main` `62b855f5` and is untouched here: this card appends one
section and changes no row and no cell.

### Checks at this sign-off

- **`prettier --check`** clean on this record.
- The six ADR guards — `adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans` —
  **236 passed (236)**.
- **Scope proof.** `git diff --stat origin/main...HEAD` lists exactly this file
  and reads **`+161 −0`**; `git diff --stat origin/main...HEAD -- docs/adr/README.md`
  prints nothing, so the ledger is byte-identical, no number is minted and no
  existing sentence is deleted.

### Correction to the correction (I1 withdrawn — the coverage decimals are run-sensitive)

**I1 is withdrawn.** The preceding subsection is a false positive, and each of its
three claims is unsupported: the delivery's quoted pair does **not** fail to
reproduce, it is **not** a "stale pair", and it is **not**
[ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md)'s figures.
All three rest on exact two-decimal equality of a coverage summary that is
**run-sensitive in the third decimal**, so no measurement can carry them. Nothing
in the preceding subsection is deleted — it stands as the record of a finding that
did not survive re-measurement.

**Measured, not reasoned.** Reviewed tree
`64528c03457eef4c02c2513400d0bc01e5bf7afa`, the identical command
`CI=true TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project unit
--project integration --coverage`, three consecutive runs:

| Run | Files / Tests                 | Statements           | Branches            | Functions           | Lines               |
| --- | ----------------------------- | -------------------- | ------------------- | ------------------- | ------------------- |
| 1   | 333 / 4690 passed (3 skipped) | `91.79` (9392/10232) | `80.67` (5516/6837) | `96.01` (1830/1906) | `91.90` (9162/9969) |
| 2   | 333 / 4690 passed (3 skipped) | `91.81` (9395/10232) | `80.75` (5521/6837) | `96.06` (1831/1906) | `91.93` (9165/9969) |
| 3   | 333 / 4690 passed (3 skipped) | `91.81` (9395/10232) | `80.75` (5521/6837) | `96.06` (1831/1906) | `91.93` (9165/9969) |

Same tree, same command, same counts — **+3 statements and +5 branches** between
run 1 and run 2 (+1 function, +3 lines). The denominators are stable
(`10232 / 6837 / 1906 / 9969`), so a fixed set of lines is sometimes executed and
sometimes not: integration paths whose hit count depends on timing. The sign-off's
own trunk sample sits at the top of the same band —
`91.82 / 80.76 / 96.06 / 91.94` (`9396 / 5522 / 1831 / 9166`) — and the trees
carrying it and the reviewed head differ only in records, with the same
denominators, so that one-statement gap is noise rather than coverage. A
re-measurement at this correction's cut, on trunk `07c24f96` with the identical
command, read `91.79 / 80.67 / 96.01 / 91.90`
(`9392 / 5516 / 1830 / 9162`) in **both** of two consecutive runs — the band's
bottom edge, from a separate session and checkout, and consistent with the
summary depending on the session and not only on the tree.

**Consequence.** Every figure in the band `91.79`–`91.82 / 80.67`–`80.76 /
96.01`–`96.06 / 91.90`–`91.94` is a **correct observation** of that command at
that tree. The delivery's pair and the reviewer's `91.8 / 80.69 / 96.01 / 91.91`
both sit inside it, and so does the 0366 pair the preceding subsection pointed
at — a coincidence of the band, not provenance.

**The rule this lane carries: a 2-dp coverage comparison is not evidence.** A
coverage change may be claimed only from a **count change at a stable
denominator**, or from a **delta wider than the observed band** — `0.03` pp on
statements, `0.04` on lines, `0.05` on functions, `0.09` on branches. By that
rule, §Evidence's conclusion ("the same global figures as the parent head, so the
two new cases add coverage without moving any gate") rests on a comparison the
tool cannot support. The conclusion still holds, on a structural ground instead:
the two new cases are additive and touch no production file, so they neither add
nor remove an executed line of production code, and the command exits `0` either
way.

**The margin is thin.** Global branches sits `80.67`–`80.76` against the `80`
threshold set in `vitest.config.ts`, so a bottom-of-band run leaves about `0.7` pp
of headroom rather than the `0.76` a top-of-band run suggests. That is an Info
observation for the lane, not a defect of this delivery — and worth knowing before
anyone quotes a coverage figure as proof of safety.

**Nothing else moves.** Findings **I2** and **I3** stand unchanged, as does the
landing proof and every section-level statement above. The verdict for PR #716
remains **APPROVED WITH FINDINGS**, now with I1 withdrawn. This subsection claims
no re-review, mints no pin and routes no code change: the delivery is green and
shipped.
