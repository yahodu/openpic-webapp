# ADR-0366 — OP-104 follow-up IMPL: bound the entitlements view's `entitlementGrants` read to the active window

- **Status:** Accepted (IMPL; serves identical bodies for well-formed rows — with one fail-open delta for a corrupt grant row, recorded below)
- **Date:** 2026-11-19
- **Card:** OP-104 IMPL follow-up (`t_6fdc277b`) · **Branch:** `OP-104-bug-bound-entitlement-grants-read` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_6fdc277b`
- **Relates to:** [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md) (the sibling bounded counter read, whose review left this finding open), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the entitlements view and its `grants[]` projection), [ADR-0340](ADR-0340-op103-entitlements-red.md) (the `isGrantActive` window and the `overrideLimit ?? limit + Σ delta` rule), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage) · **Schema:** §14.2
- **Consumers:** `apps/web/src/server/services/entitlements/view.ts`

## Context

The review of PR #705 (`t_8ac61afe`, ADR-0365) approved the bounded **counter**
read in `readEntitlementsView` and left one finding of the same class open
(F1, Low, performance). `apps/web/src/server/services/entitlements/view.ts`
still read

```ts
tenantRepo(tenantId, db).collection(COLLECTIONS.entitlementGrants).find().toArray();
```

so every `/entitlements` call read **every** grant row the tenant ever
received, across every collection history. Both consumers of that array use
only the active window:

- `effectiveLimit(spec, keyGrants, now)` (`./policy.ts`) filters
  `isGrantActive` internally, and
- the `grants[]` array served per row is `keyGrants.filter((grant) => isGrantActive(grant, now))`.

The number of grants grows with the number of purchases, and `/entitlements` is
the path a quota bar hits often, so the read must be bounded by time, not only
by purchases.

## Decision

Bound the grant read to exactly the predicate `isGrantActive` applies
(`validFrom <= now && (validUntil === null || now < validUntil)`):

```ts
tenantRepo(tenantId, db)
  .collection(COLLECTIONS.entitlementGrants)
  .find({ validFrom: { $lte: now }, $or: [{ validUntil: null }, { validUntil: { $gt: now } }] })
  .toArray();
```

The bounds match the in-process predicate arm for arm: `validFrom: { $lte: now }`
is its `validFrom > now → false`, and `validUntil: { $gt: now }` is its strict
`now < validUntil` (a grant whose `validUntil` equals `now` is inactive
in both). The tenant scope is untouched: `tenantRepo`'s `scopeFilter` merges
`tenantId` into `{ ...base, tenantId }`, so the `$or` survives it, and no
top-level `tenantId` key is built by hand — the same merge the bounded counter
read relies on.

The predicate is deliberately **not** narrowed further. No projection and no
`limit`: `effectiveLimit` sums `delta` over the active set and honours the first
active `overrideLimit`, so a partial active set would change a served number.

### The fail-open delta (the one behaviour change)

Bounding the read removes rows from the parse. A well-formed grant produces an
identical body. A **corrupt** grant row (`storedGrantSchema.parse` would throw
on it) that the window predicate excludes — an expired or not-yet-valid window,
or a `validFrom` that is missing or not a date — is now never fetched, so it no
longer answers `500 internal_error`; before this change every row was fetched
and every row was parsed. That is a fail-open narrowing of corruption detection of the same
class ADR-0365 recorded for counter rows, and it is why this record does not
claim the change is "behaviour-preserving" without qualification. It is
**not pinned**: no test asserts either arm of it, and this card writes no test —
the Test Author owns that pin (the sibling card `t_d614b82a` covers the
`usageCounters` arms only).

## Evidence

Gates on this head (branch `OP-104-bug-bound-entitlement-grants-read`, off
`origin/main` `84378fa0`):

- `pnpm typecheck` — exit 0 on all three projects (root, `packages/contracts`,
  `apps/web`).
- `eslint` — 0 problems on the one touched production file.
- `prettier --check` — clean on all three touched paths.
- Focused integration `entitlements-endpoints.test.ts` — **31 passed (31)**, L5
  and L6 included and untouched; together with `entitlements.test.ts`,
  **40 passed (2 files)**.
- Full unit + integration with coverage — **exit 0**, **332 files / 4681 passed
  (3 skipped)**, global **91.82 % statements / 80.76 % branches / 96.06 %
  functions / 91.94 % lines**; `view.ts` **100 % statements, 97.95 % branches,
  100 % functions, 100 % lines** (its one uncovered line, 428, is the
  `cursorFilterFor` arm ADR-0363 already recorded, not this change).
- ADR guards — **236 passed (236)** on the six guard files.
- `pnpm --filter @openpic/web build` — exit 0, `/entitlements` and `/usage` in
  the route table.
- No test, fixture or helper is edited: the diff is one production file, this
  record, and the ledger's index row, cell and note.

## Out of scope

- No route signature, response schema, status code, log event or persisted
  document change. No test, fixture or helper is edited; the 31
  `entitlements-endpoints.test.ts` cases, L5 and L6 included, stay green
  untouched.
- The counter read and its bounded filter are unchanged (ADR-0365), including
  its closed-period corrupt-row behaviour.
- No index is added for the grant filter: `entitlement_grants_tenant_key_valid_from`
  already leads with `tenantId` and `entitlementKey`, and no finding or
  measurement asks for a `validFrom`-leading index today.

## Consequences

- The `/entitlements` read costs only the tenant's **currently active** grants
  instead of every grant it has ever received, so its latency no longer grows
  with the number of expired or future purchase grants.
- The served body is identical for every well-formed grant set, so no contract,
  client or test changes.
- Corruption detection narrows as described above: a malformed grant row the
  window excludes is silently ignored instead of answered `500`.

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0366` on `origin/main`
`84378fa0` (PR #705's squash `c2f079da` plus the `1.66.4` release chore). The
cell was re-read from this checkout's ledger immediately before committing, and
`0366` was free on `main`, in this worktree and on every remote ref and sibling
worktree at the cut, so this record consumes `0366` and the cell advances to
`0367`. `0364` and `0365` are consumed and are not renumbered. No number
outside the lane range `0360`–`0379` is touched.

## Review and landing (PR #708)

Reviewed head `5b46aa31`; docs sign-off `t_75d558ef`, which consumes no ADR
number. **Verdict: APPROVED WITH FINDINGS (Low only)** — no Critical, High or
Medium finding; three Low findings and one Info note, each routed to a card.
PR [#708](https://github.com/yahodu/openpic-webapp/pull/708) squash-merged as
`200eaf97` (`mergedAt 2026-11-19T06:29:25Z`) onto `origin/main` `e6b081a7`; the
PR is `MERGED` and the repository deleted the lane branch.

This section records what the review measured after the record above was
written. It mints no number, retracts nothing and changes no cell.

### Landing proof

- **Tree identity.** `git rev-parse 9e1b822e^{tree} 200eaf97^{tree}` prints
  `0d5036f10cf4eae46e1a186e7ddce3a4b8fd6ef6` twice: the bytes reviewed at the
  PR head are the bytes on the trunk.
- **The landing merge.** `9e1b822e` carries exactly two parents — `5b46aa31`
  (the reviewed head) and `e6b081a7` (`origin/main`, the PR #710 sign-off) — so
  it folds the trunk in rather than changing the delivery.
- **Scoped diff.** `git diff --stat 5b46aa31 9e1b822e` over
  `apps/web/src/server/services/entitlements/view.ts` and this record is empty.
- **Production identity.** The `view.ts` blob is `6b2e8f9d…` at `5b46aa31`, at
  `9e1b822e`, at `200eaf97` and on `origin/main`, so the gates below still
  describe the code the trunk carries.
- **This record's own blob** is `8ede3f5c…` at all four of those revisions; this
  section is the only delta the sign-off adds.

### Equivalence proof — probe worktrees at `84378fa0` and `5b46aa31`

The review built two probe worktrees, one at the branch's base `84378fa0` (the
unbounded read) and one at the reviewed head `5b46aa31`, seeded both through the
same script, and called `readEntitlementsView(db, tenantId, now)` directly. The
two served bodies are **byte-identical** — 591 bytes each, `diff` empty — on a
seed that exercises every arm of the window predicate:

| Grant window                 | Served into `grants[]` and `effectiveLimit` |
| ---------------------------- | ------------------------------------------- |
| `validFrom == now`           | yes                                         |
| `validFrom == now + 1 ms`    | no                                          |
| `validUntil == now`          | no (exclusive bound, in both layers)        |
| `validUntil == now + 1 ms`   | yes                                         |
| `effectiveLimit` of the plan | **160** = `100` plan + `50` + `7` + `3`     |

A live grant belonging to a **second tenant** (`delta 424242`) is never served
by either head. That is the load-bearing half of §Decision's tenant-scope claim:
`tenantRepo`'s `scopeFilter` merges `tenantId` beside the window filter, so the
`$or` reaches the driver intact and the tenant boundary does not depend on the
`$or`'s branch shape.

### The disclosed fail-open delta, measured in both directions

§Decision's fail-open delta is real and was reproduced, not assumed. With a grant
row whose `delta` is not a number in a **closed** window (`validFrom` in the
past, `validUntil` before `now`), the base `84378fa0` threw a `ZodError` out of
`storedGrantSchema.parse` and its route answered `500 internal_error`, while the
head `5b46aa31` answers `200` and serves the healthy numbers, because the
narrowed read never fetched the corrupt row. The same corruption in an **open**
window throws a `ZodError` on both heads: the bounded read still parses every row
it serves. The delta is therefore confined to rows the predicate excludes,
exactly as §Decision states it, and it is **not pinned** by this record — the
pins are card `t_8f1dac13`.

### F1 measured — the storage scan still grows with expired grants

One probe seeded **60 expired grants and 3 live ones** and ran the delivered
filter under the production index set `INDEX_SPECS` ships, then repeated it with
a window-bearing index added:

| Filter plan                              | keysExamined | docsExamined | nReturned |
| ---------------------------------------- | ------------ | ------------ | --------- |
| delivered, production indexes            | 63           | 63           | 3         |
| with `(tenantId, validUntil)`            | 4            | 6            | 3         |
| with `(tenantId, validFrom, validUntil)` | 6            | 6            | 3         |

`nReturned` is `3` in every row: that is the filter's answer, not the index's.
The delivered plan examines `63` documents for a three-document answer because
the shipped family (`entitlement_grants_tenant_key_valid_from`, leading
`tenantId` and `entitlementKey`) can order the tenant's grants but cannot bound
the window, so the driver walks every expired row and filters it out.

Two forward-looking sentences of this record are therefore **superseded**:

- §Consequences' "its latency no longer grows with the number of expired or
  future purchase grants" holds for the **returned and parsed** set — the view
  no longer parses expired grants, and `effectiveLimit` pays only for the active
  ones — but not for the storage scan, which still walks them.
- §Out of scope's "no finding or measurement asks for a `validFrom`-leading
  index today" is superseded: the measurement above asks for a window-bearing
  index, and that index is card `t_a3fcf2e2`.

**Nothing historical is retracted.** This record's §Context and §Decision stand
as written — the read is still bounded by the same window, with no projection
and no `limit`, and the served bodies are still identical — and no `D1`/`D2`
dispute entry of the earlier OP-104 records is reopened. Only the two
latency-and-index sentences quoted above are corrected, and they are corrected
here, in the follow-up's own record, which is where what followed belongs.

### Ledger integration

This record's §ADR number allocation sentence read `0366 → 0367`, while the
trunk carried `0368`: the sibling card `t_d614b82a` reserved `0367` while this
branch was open, so `origin/main` had moved during the review. `docs/adr/README.md`
was the only conflicted path on the landing merge, and it resolved as a union —
the `Next free` cell takes `main`'s `0368` (a higher cell is never rewound), both
index rows are kept in ascending order (`0366` from this branch, `0367` from the
trunk), both prose blocks are kept, and the branch's cell sentence is corrected
to `0368`. At this sign-off the cell reads `0369`, because PR [#711](https://github.com/yahodu/openpic-webapp/pull/711)
consumed `0368` for [ADR-0368](ADR-0368-op104-followup-counter-parse-pin.md) and
advanced it; this section touches neither the cell nor any row, so
`git diff --name-only origin/main...HEAD` lists exactly this file.

The recurrence — a lane card writing a cell lower than the trunk's because it
read the cell at its cut and the trunk moved under it — is routed to card
`t_b3edd8a0`.

### Checks at this sign-off

- **`prettier --check`** clean on this record; the six ADR guards
  (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`, `adr-consumers`,
  `adr-source-references`, `adr-inline-code-spans`) **236 passed (236)**.
- **Scope proof.** `git diff --name-only origin/main...HEAD` lists exactly
  `docs/adr/ADR-0366-op104-followup-bound-entitlement-grants-read.md`, so the
  ledger is byte-identical and no number is minted.
- **Remote checks on PR #708** — 15 `statusCheckRollup` rows, all `SUCCESS`; 14
  are gates (`ci`, `unit_test`, `test_coverage`, `lint`, `audit`, `audit-dev`,
  `secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`,
  `CodeQL`, two `Analyze` jobs and `Assert CI evidence for the pushed head`) and
  the fifteenth, `notify-discord`, is the close side-effect.
- **Measured by the review on the merged tree `9e1b822e`**: `tsc` exit `0` on
  all three projects; `eslint` 0 problems on the one touched production file;
  focused integration `entitlements-endpoints` + `entitlements` **42 passed
  (42)**; the six ADR guards **236 passed (236)**. And at the reviewed head,
  full `unit` **187 files / 3157 passed (3 skipped)** and full `integration`
  **145 files / 1526 passed**.

### Findings routing

| Finding | Severity | Subject                                                   | Routed to     |
| ------- | -------- | --------------------------------------------------------- | ------------- |
| F1      | Low      | the storage scan still grows with expired grants          | `t_a3fcf2e2`  |
| F2      | Low      | the two latency-and-index sentences corrected above       | this sign-off |
| F3      | Low      | a lane card can write a cell lower than the trunk's       | `t_b3edd8a0`  |
| —       | —        | the fail-open delta's two arms, left unpinned by design   | `t_8f1dac13`  |
| Info    | Info     | `grants[]` order is plan-dependent, unpinned, outside the | no action     |
|         |          | contract                                                  |               |

No finding was Critical, High or Medium, so the delivery ships; the four
follow-ups above carry the rest.
