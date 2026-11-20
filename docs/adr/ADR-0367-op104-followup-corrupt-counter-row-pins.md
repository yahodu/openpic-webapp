# ADR-0367 — OP-104 follow-up TEST: both arms of the counter read's corruption delta are pinned

- **Status:** Accepted (TEST; both pins are **characterization** — green on arrival at `origin/main` `84378fa0`, no GREEN sibling opened)
- **Date:** 2026-11-19
- **Card:** OP-104 TEST follow-up (`t_d614b82a`) · **Branch:** `OP-104-task-corrupt-counter-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_d614b82a`
- **Relates to:** [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md) (the bounded counter read these pins characterize), [ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md) (the sibling characterization-pin record and its posture), [ADR-0362](ADR-0362-op104-followup-usage-bound-and-plan-keys-red.md) (the RED half of the `/usage` bound), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the entitlements view), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.7 (status codes) · **Schema:** §14.2
- **Consumers:** `apps/web/src/test/integration/entitlements-endpoints.test.ts`, `apps/web/src/test/unit/entitlements-counter-parse.test.ts`

## Context

PR #705 (`t_8ac61afe`, squash `c2f079da`) bounded the `usageCounters` read in
`readEntitlementsView` (`apps/web/src/server/services/entitlements/view.ts`) to
`{ $or: [ { entitlementKey, periodKey } … ] }` over the plan's `tenant`-scoped
keys at their **current** period, replacing an unbounded `find().toArray()`
(ADR-0365 P1). The review of that card (`t_8ac61afe`, F2, Low) measured that the
bound also narrows **corruption detection**, which the record's Status line
describes as "behaviour-preserving — no wire, status-code, log or
persisted-document change". That phrasing is inexact in one arm:

| Head                                             | Malformed counter row for a plan key in a **closed** period (`2019-01`), served period `2026-09` | Malformed row in the **served** period |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| parent `5e1a05de` (`find().toArray()`)           | throws → route answers `500 internal_error` (`storedCounterSchema.parse`)                        | throws → `500 internal_error`          |
| trunk `84378fa0` (`$or` over the current period) | `200`, serves `used` from the current-period row                                                 | throws → `500 internal_error`          |

The delta is therefore exactly one behaviour: **a corrupt counter row outside the
served period is no longer refused.** The row is never fetched, so it is never
parsed. Nothing about the row's own failure mode changed; the read simply no
longer sees it.

Both arms pass on the shipped trunk, so this card is a **pin** card in the sense
of [ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md): the job is to
make the shipped answers regression-visible, not to request a behaviour change.
**No GREEN sibling is opened.** A red on either case means the shipped behaviour
moved.

## Decision

Two cases are appended to the existing
`describe("GET /api/v1/tenants/{tenantId}/entitlements")` block in
`apps/web/src/test/integration/entitlements-endpoints.test.ts`, reusing that
file's helpers unchanged (`seedWorkspace`, `seedPlan`, `seedSubscription` is not
needed here, `seedCounter`, `entitlementsRequest`, `entitlementRow`,
`errorEnvelope`, `currentMonthKey`, the frozen `FROZEN_NOW` clock and the
`beforeEach` collection wipe). The file goes from **31** to **33** cases; no
pre-existing case, L5 and L6 included, is touched. A doc block at the head of the
file declares the characterization status in the same words as this record.

### L7 — a malformed counter row in a **closed** period is ignored, and the view still answers `200`

The tenant has a plan whose `events.active` spec is `tenant`-scoped, monthly,
`limit: 5`, `enforcement: hard`. Two counter rows are seeded for that key:

- a **valid** row at `currentMonthKey()` with `value: 4` (through `seedCounter`);
- a **corrupt** row at `"2019-01"` with `value: "corrupt"`, inserted through
  `app.db.collection(COLLECTIONS.usageCounters).insertOne` because `seedCounter`
  types `value` as `number`.

The corrupt row sits at a **different period of the same key**, which is what the
`(tenantId, entitlementKey, periodKey)` unique index (schema §14.2) allows — a
second row for the same pair would fail on insert.

Assertions are the observable pair only: `status === 200`, and the
`events.active` row matches `{ key, periodKey: currentMonthKey(), used: 4,
remaining: 1 }`. `remaining` is asserted because it is the served consequence of
`used`: with `limit: 5` and `used: 4` a reader sees one unit left, so the corrupt
row is provably not folded into the served number.

**Load-bearing:** under the pre-change read (`find().toArray()`) the same seed
throws and the case fails as `expected 500 to be 200`. That is the mutation
recorded in §Evidence, and the exact red text is why the pin exists — a future
head that widens the fetch set again (for a new feature, an index change, a
refactor back to an unbounded read) fails here instead of silently answering
`500` for a tenant whose closed-period rows went bad.

### L8 — a malformed counter row in the **served** period is still refused with `500 internal_error`

Same workspace and plan. The one row for the `(entitlementKey, periodKey)` pair
**is** the corrupt one: `value: "corrupt"` at `currentMonthKey()`, no valid row
beside it (uniqueness forbids both).

Assertions: `status === 500` and `(await errorEnvelope(response)).code ===
"internal_error"` — the same pair the file's L3 cases assert, so the pin speaks
the file's existing 500 dialect rather than a new one.

**This case is green on both heads by design.** The unbounded read fetched the
served-period row too, so no delta exists here: the narrowing is only ever
_outside_ the served period, never inside it. The card forbids mutating the
served-period fallback to "prove" L8, and this record says plainly that it was
not mutated. L8 is a **contract** anchor — a red means a malformed
served-period counter row can now reach a served `used` value, i.e. the parse was
loosened or dropped.

### What is deliberately unchanged

No production file, existing assertion, fixture, mock or helper. `view.ts`, the
`entitlements` route and the counter schemas are untouched; the only imports the
new cases use are ones the file already had. No test title embeds a source line
number.

## Evidence

Measured in this worktree on `origin/main` `84378fa0`, real command output.

- **Focused integration spec**
  (`CI=true TMPDIR=/root/tmp-mongo pnpm vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **33 passed
  (33)** — the 31 carried cases plus L7 and L8, both green on arrival as
  declared. The spec at `HEAD` holds **31** `it(` blocks and the worked tree
  **33**, so no carried case was removed or rewritten.
- **Mutation probe (L7 is load-bearing), in a throwaway worktree** at
  `/root/.hermes/profiles/openpic-webapp-testcase-writer/cache/scratch/probe-t_d614b82a`,
  never in the lane worktree: `git checkout 5e1a05de --
apps/web/src/server/services/entitlements/view.ts` restored the pre-change view
  (`usageCounters.find().toArray()`, unbounded), the spec file byte-identical to
  the lane copy (`sha256 164f2e9c…`). Full-file run:
  `Tests 1 failed | 32 passed (33)` —

  ```
  FAIL  |integration| … > GET /api/v1/tenants/{tenantId}/entitlements > L7 characterization: a malformed counter row in a closed period is ignored, and the view still answers 200
  AssertionError: expected 500 to be 200 // Object.is equality
  ```

  at the `expect(response.status).toBe(200)` line of L7. **L8 is among the 32
  passed under that same mutation**, which is the measured form of the claim that
  L8 is green on both heads — no fallback mutation was needed or made.

- **Restore.** `git checkout HEAD --
apps/web/src/server/services/entitlements/view.ts` in the probe returned
  `view.ts` to sha256 `bbb9d32a08c965d8dc80ce63e65f6bf8dd392b7ef1b24a27a9f4e78b23359071`
  (the lane's value), `git status --short` showed only the spec, and the same
  command answered **33 passed (33)**.
- **`pnpm typecheck`** exit 0 on all three projects; **`eslint`** 0 errors on the
  touched spec; **`prettier --check`** clean on it.
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`) green with
  this record and its ledger row in place.

## Out of scope

- **No GREEN sibling.** Both cases pass on arrival; nothing is routed to an
  implementer. The sibling finding F1 of the same review — the still-unbounded
  `entitlementGrants` read — stays on its own card (`t_6fdc277b`).
- **The corrupt closed-period row is not deleted, repaired or logged.** Whether
  such a row should be quarantined or reported is a data-repair question for the
  reconciliation path, not for this read's contract. L7 records only what the
  endpoint answers today.
- **No assertion on the number of documents read.** The bound is a performance
  property; its measurement is the ADR-0365 `explain`/probe evidence, and pinning
  a read count here would break on a legitimate index change.
- **No mutation of the served-period fallback for L8**, as the card requires: L8
  encodes a contract that already held before ADR-0365, so there is no delta to
  demonstrate.
- The `entitlementGrants` parse arm of the same view is untouched by these pins
  even though it has the same fail-open shape — that is exactly the delta the
  sibling card's record must declare.

## Consequences

- A regression that widens the counter fetch back to `find().toArray()` — or to
  any set that includes closed periods — now fails as
  `expected 500 to be 200` on L7, instead of turning a corrupt historical row
  into an outage nobody asserted.
- A regression that loosens or drops `storedCounterSchema.parse` on the fetched
  rows now fails on L8 instead of serving a non-numeric `value` as `used`.
- The record states the ADR-0365 Status phrasing is inexact for this arm: the
  delivery preserved every **well-formed** body and the status code for **every
  row it still reads**, but it stopped refusing a corrupt row outside the served
  period. That correction belongs to the ADR-0365 sign-off card (`t_8f2bc499`);
  this record only pins the behaviour.

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0366` on `origin/main`
`84378fa0`. `0366` is **not** free to take: the in-flight sibling card
`t_6fdc277b` (bound the `entitlementGrants` read) already carries
`docs/adr/ADR-0366-op104-followup-bound-entitlement-grants-read.md` in its own
worktree with the lane cell advanced to `0367`; that branch had no open PR at the
cut, so the sweep the card mandates — `.worktrees/*/docs/adr/`,
`git rev-list --objects --all -- docs/adr`, and every open PR head
(`#690`, `#688`, `#685`, `#272`) — is what caught it, since each branch's own
guard stays green either way. This record therefore takes **`0367`**, the next
number after the sibling's reservation, and the lane cell advances from `0366`
to **`0368`** so the sibling's `0366` stays claimable. `0364` and `0365` are
consumed and are never renumbered. No number outside the lane range `0360`–`0379`
is touched.

## Review and landing — PR #707 (squash dbf93bf3)

Reviewed head `cedb8440` on card `t_d614b82a`; this sign-off is card
`t_0f3d134a`, which consumes **no ADR number** and changes no cell. **Verdict:
APPROVED WITH FINDINGS (one Low)** — §Consequences claimed a loosened or dropped
`storedCounterSchema.parse` fails on L8; the review measured that claim false and
corrects it below.

Nothing above is retracted. §Context, §Decision, §Evidence, §Out of scope and the
`L7`/`L8` decisions stand as written; the header's Status line was already
`Accepted` at delivery, so no `pending` marker needed clearing; and what followed
the delivery is carried by the follow-ups' own records —
[ADR-0368](ADR-0368-op104-followup-counter-parse-pin.md) for the parse pin, and
§Correction below for the one sentence that proves inexact.

### Landing proof

- **Squash.** `git log --oneline -6 dbf93bf3` puts `dbf93bf3` directly on
  `513284e5` (the trunk's own `docs(adr): …` sign-off commit for `ADR-0362` and
  `ADR-0363`), and `git log -1 --format='%H %P' dbf93bf3` prints exactly one
  parent, `513284e5`. PR [#707](https://github.com/yahodu/openpic-webapp/pull/707)
  is `MERGED` with `mergedAt 2026-11-19T05:50:21Z`, `headRefOid cedb8440` and
  `mergeCommit dbf93bf3`.
- **Scoped diff is empty.** `git diff --stat cedb8440 dbf93bf3` over the PR's
  three paths (`entitlements-endpoints.test.ts`, this record, `docs/adr/README.md`)
  prints nothing, so the review's runs apply to the shipped bytes verbatim. The
  spec blob is `8b613ac0…` at `cedb8440` and at `dbf93bf3`; this record's blob is
  `b2e8fc1a…` at both.
- **Whole-diff files.** `git diff --name-only cedb8440 dbf93bf3` lists only
  `ADR-0362` and `ADR-0363` — the trunk commit `513284e5` folded in by the
  squash, not part of this delivery.
- **`origin/main` at handoff** was `dbf93bf3`. It has since advanced through
  `200eaf97` (PR #708), `9b604e44` (PR #711), `0659da33` (the `1.66.5` release
  chore), `b120866c` (PR #713) and `432366b0` (PR #712), so the checks below were
  re-measured on the current trunk, not only at the handoff SHA.

### Reviewer-run evidence

Measured by the review of `t_d614b82a` and re-measured at this sign-off, real
command output:

- **Focused integration**
  (`CI=true TMPDIR=/root/tmp-mongo … --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **33 passed
  (33)** in the lane worktree and **33 passed (33)** on a probe worktree at
  `dbf93bf3`; the same probe re-ran **33 passed (33)** at this sign-off. On
  today's trunk the same file answers **35 passed (35)**, the two extra cases
  being card `t_8f1dac13`'s `entitlementGrants` arms (PR #712).
- **Standalone selection.** `-t "L7"` and `-t "L8"` each answer **1 passed | 32
  skipped (33)** at `dbf93bf3`, so each pin carries its own seed.
- **Case count.** The spec holds **31** `it(` blocks at `84378fa0` and **33** at
  `cedb8440`/`dbf93bf3`; `git diff --stat 84378fa0 cedb8440` over it reads
  **+133 −0**, so no carried case, L5 and L6 included, was removed or rewritten.
- **Gates at the head.** `prettier --check` clean on the spec, this record and the
  ledger; `tsc` exit 0 on all three projects; ADR guards **236 passed (236)**.
- **Remote checks on PR #707.** `statusCheckRollup` holds 15 rows, all `SUCCESS`:
  14 gates (`ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `audit-dev`,
  `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`,
  `CodeQL`, two `Analyze` jobs and `Assert CI evidence for the pushed head`) plus
  `notify-discord`, the close side-effect.

### Load-bearing, re-measured

Two mutations in throwaway probe worktrees — never in the lane tree — both at
`dbf93bf3`, with the spec byte-identical to the shipped copy:

- `git checkout 5e1a05de -- apps/web/src/server/services/entitlements/view.ts`
  (the pre-ADR-0365 unbounded `find().toArray()`) → full file
  **`1 failed | 32 passed (33)`**, the one red being
  `L7 characterization: a malformed counter row in a closed period is ignored,
and the view still answers 200` with
  `AssertionError: expected 500 to be 200 // Object.is equality` at its
  `expect(response.status).toBe(200)` line. **L8 is among the 32 passed** under
  that same mutation.
- `storedCounterSchema.parse(row)` replaced by a pass-through cast at
  `view.ts:261` → full file **`33 passed (33)`**: the delivered pair cannot tell a
  dropped parse from a working one. This is the measurement the correction below
  rests on.

`git checkout HEAD -- <same path>` returned `view.ts` to
`sha256 bbb9d32a…359071`, `git status --porcelain` empty, and the same command
answered **33 passed (33)**.

### Correction to §Consequences

§Consequences' second bullet reads:

> A regression that loosens or drops `storedCounterSchema.parse` on the fetched
> rows now fails on L8 instead of serving a non-numeric `value` as `used`.

That is **measured false**, and it is corrected here without retracting the
intent: the served `value` must never come from a row the schema rejects, but L8
is not the seam that enforces it. Under the pass-through cast above, `L8` stays
**green** (`1 passed | 32 skipped`) and the route still answers
`500 internal_error` — the corrupt `value` fails later, in the response-model
serialisation, so the wire is fail-closed under both mechanisms and a
`500 internal_error` pair cannot tell them apart. Re-measured on today's trunk
`432366b0`, L8 answers **`1 passed | 34 skipped (35)`** under that same cast.

The bullet's true form:

> A regression that widens the counter fetch back to `find().toArray()` — or to
> any set that includes closed periods — now fails as `expected 500 to be 200` on
> L7. A regression that loosens or drops `storedCounterSchema.parse` is caught by
> the unit pin at the service seam (card `t_3dd46e5f`,
> [ADR-0368](ADR-0368-op104-followup-counter-parse-pin.md)), not by L8: L8 is a
> **wire-contract** anchor — a corrupt served-period counter row never yields
> `200` — and holds whichever mechanism refuses it.

The first bullet (`L7` catches a widened fetch set) is unchanged: it is measured
above. And the corrected half is measured too — on `432366b0` with the same cast
in place, the unit pin answers **`2 failed | 1 passed (3)`**
(`AssertionError: promise resolved "…" instead of rejecting`), so the mechanism is
pinned where it can be seen.

The bullet is corrected beside itself rather than rewritten in place for two
reasons: this sign-off is additive by card (`git diff --stat` must read `+N −0`),
and [ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md)'s
sign-off set the precedent — the historical text stays, the supersession is
stated next to it.

### ADR-number ruling

The implementer asked the review to arbitrate the `0367` reservation. **`0367`
stands and no re-cut is needed.** `origin/main` `84378fa0` did read the lane cell
`0366`, but `git show 5b46aa31:docs/adr/README.md` already carried the cell at
`0367` with `docs/adr/ADR-0366-op104-followup-bound-entitlement-grants-read.md`
in place, and that head is public as PR
[#708](https://github.com/yahodu/openpic-webapp/pull/708) — `MERGED`,
`headRefOid 9e1b822e`, `mergeCommit 200eaf97`, `mergedAt 2026-11-19T06:29:25Z`.
The mandated sweep therefore prevented a real duplicate: taking `0366` would have
put two records under one number in this lane.

§“ADR number allocation” states exactly this, and its cell advance is consistent
with what followed: it sets `0368`, and `0368` is the number the doc-card sibling
`t_3dd46e5f` consumed for
[ADR-0368](ADR-0368-op104-followup-counter-parse-pin.md) (PR #711, squash
`9b604e44`), which advanced the cell to `0369` — the value the lane reads on the
trunk today. No cell is changed here.

### Two trunk moves this sign-off records

- **This record's `Consumers:` line** gained
  `apps/web/src/test/unit/entitlements-counter-parse.test.ts` in `9b604e44`
  (PR #711), measured necessary by the `adr-consumers` guard; the blob moved
  `b2e8fc1a…` → `b3d1056c…` and nothing else in this record changed. This
  sign-off builds on `432366b0`, so its own diff is the appended section only.
- **`view.ts`** moved `bbb9d32a…` → `92e83ccd…` in `200eaf97` (PR #708, the
  `entitlementGrants` window bound). The pins were re-run on the current trunk
  with that change in place — **35 passed (35)**, L7 and L8 included — so they
  still describe the shipped code.

### Findings routing

| Finding | Severity | Subject                                                              | Routed to                      |
| ------- | -------- | -------------------------------------------------------------------- | ------------------------------ |
| F1      | Low      | §Consequences' L8 claim is false; the parse is pinned at the seam    | corrected above                |
| F2      | Low      | the parse mechanism had no pin until ADR-0368                        | `t_3dd46e5f` (landed)          |
| F3      | Info     | the three new arms reuse the `U10` id within the entitlements family | no action; ids are per-subject |

No finding was Critical, High or Medium, so the delivery ships; F1 is answered by
this section and F2 by the follow-up record.

### Checks at this sign-off

- **`prettier --check`** clean on this record; the six ADR guards
  (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-consumers`,
  `adr-source-references`, `adr-inline-code-spans`) **236 passed (236)**.
- **Scope proof.** `git diff --stat origin/main...HEAD` lists exactly this file and
  reads **`+N −0`**, so `docs/adr/README.md` is byte-identical, no number is
  minted and no existing sentence is deleted.
