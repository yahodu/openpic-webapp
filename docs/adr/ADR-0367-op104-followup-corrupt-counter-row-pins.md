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
