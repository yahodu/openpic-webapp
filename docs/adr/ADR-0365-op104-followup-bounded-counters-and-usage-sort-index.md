# ADR-0365 — OP-104 follow-up IMPL: bound the entitlements view's counter read and support the `/usage` keyset sort with an index

- **Status:** Accepted (IMPL; behaviour-preserving — no wire, status-code, log or persisted-document change)
- **Date:** 2026-11-19
- **Card:** OP-104 IMPL follow-up (`t_8ac61afe`) · **Branch:** `OP-104-bug-bound-entitlements-counter-read` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8ac61afe`
- **Relates to:** [ADR-0363](ADR-0363-op104-followup-usage-bound-and-plan-keys-green.md) (the bounded `/usage` page whose sort this index serves), [ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md) (the pins that guard its keyset), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the entitlements view), [ADR-0341](ADR-0341-op103-entitlements-green.md) (the counter index family), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.8 (pagination) · **Schema:** §14.2, §21
- **Consumers:** `apps/web/src/server/services/entitlements/view.ts`, `apps/web/src/server/db/indexes.ts`, `docs/Notification and Database Design.md` (schema §14.2 index line, which is documentation rather than a source file the guard sweeps)

## Context

The OP-104 IMPL follow-up review (`t_010670d6`, PR #703) approved the bounded
`/usage` page and left two **performance** findings open. Both are internal:

1. **P1 — an unbounded counter read.** `readEntitlementsView`
   (`apps/web/src/server/services/entitlements/view.ts`) read
   `usageCounters.find().toArray()` — every row for the tenant, across every
   entitlement key and every period — while `toEntitlementState` only ever
   consults the row at **that key's current period**. With N keys and M periods
   the read grows as N×M for a response that needs at most N rows.
2. **P2 — no index for the new keyset sort.** `readUsageCounters` sorts
   `{ periodKey: -1, _id: -1 }` within one tenant. The only `usageCounters`
   index, `usage_counters_tenant_key_period_unique`
   (`{tenantId, entitlementKey, periodKey}`), cannot serve that order because
   `entitlementKey` sits between `tenantId` and `periodKey`, so MongoDB sorts
   the tenant's rows in memory.

Neither finding changes a served byte, so no RED card is opened: the existing
suite is the safety harness, and the review measured that no pin asserts either
the number of counters read or the index set (both index specs derive their
expectation from `INDEX_SPECS`).

## Decision

### P1 — read only the current period of each `tenant`-scoped key

The plan document is read **before** the counter read (it names the pairs to
fetch), then the grants and counters are read in parallel as before. The filter
is built from the plan's `tenant`-scoped keys:

```ts
const counterPairs = Object.entries(specs)
  .filter(([, spec]) => spec.scope === "tenant")
  .map(([key, spec]) => ({ entitlementKey: key, periodKey: periodKey(spec.resetPeriod, now) }));
```

and passed as `{ $or: counterPairs }`, which `tenantRepo`'s `scopeFilter` merges
into `{ $or: …, tenantId }` exactly as it merged the previous empty filter — the
tenant scope is unchanged. A key with no matching row still serves `used: 0`
(`toEntitlementState` keeps its `?? 0`), and a non-`tenant`-scoped key still
serves no `used`/`remaining`/`periodKey` at all.

Two edge cases the filter must not break:

- **No plan document, or a plan with no `tenant`-scoped key.** `$or: []` is a
  driver error (`$or/$and/$nor must be a nonempty array`), so an empty pair list
  skips the read and yields no counters. The served body is identical: no specs
  means no entitlement rows, and a plan with only `event`/`attendee` keys
  consults no counter.
- **A counter row at another period.** It is now never fetched; the old code
  fetched it and `toEntitlementState` ignored it. Same body.

### P2 — a `{tenantId, periodKey, _id}` index for the `/usage` sort

Registered in `INDEX_SPECS` (`apps/web/src/server/db/indexes.ts`):

```
name: "usage_counters_tenant_period_id"
keys: tenantId 1, periodKey -1, _id -1
```

It leads with `tenantId` (schema §21 P3), is not unique (it constrains nothing),
and mirrors the sort and the keyset `$or` of `readUsageCounters` so the list
runs as an index scan instead of an in-memory sort. The unique
`(tenantId, entitlementKey, periodKey)` index stays: it is what makes the
conditional `$inc` upsert race-safe (ADR-0341).

The schema's own index list (`docs/Notification and Database Design.md` §14.2,
the only place the `usageCounters` index set is written down) gains the same key
list on the same line. §21 is a "non-obvious indexes only" summary and already
covers this class with its "all tenant-scoped: `tenantId` leading" row, so no
§21 row is added.

## Evidence

Measured on this head (`origin/main` `5e1a05de` + this change), real command
output:

- **Focused integration**
  (`CI=true TMPDIR=/root/tmp-mongo pnpm exec vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts
apps/web/src/test/integration/index-bootstrap.test.ts
apps/web/src/test/integration/entitlements.test.ts`): **48 passed (48)** — the
  `/usage` file unchanged at 31 cases (L5/L6 included), the index bootstrap's
  `I1` creating and reconciling the new index by name.
- **Focused unit + integration with coverage scoped to `view.ts`**: 4 files,
  **78 passed (78)**; `view.ts` **100 % statements 58/58, branches 38/38,
  functions 16/16, lines 53/53** — the new empty-pair guard and the
  `scope === "tenant"` filter are both exercised, so the bounded read lowers the
  `server/services/**` branch denominator rather than leaving a hole.
- **`pnpm typecheck`** exit 0 on all three projects; **`eslint`** 0 errors on
  both touched production files (the two `security/detect-object-injection`
  warnings in `indexes.ts` are pre-existing, in the bootstrap loop); prettier
  `--check` clean.
- **Full `unit` + `integration` with coverage**
  (`CI=true TMPDIR=/root/tmp-mongo pnpm exec vitest run --project unit --project
integration --coverage`): **exit 0** — **332 files / 4681 passed (3 skipped)**;
  global **91.80 % statements / 80.69 % branches / 96.01 % functions / 91.91 %
  lines**, `apps/web/src/server/services/entitlements` **99.37 % branches**, and
  `view.ts` fully covered (the coverage report omits it precisely because every
  line and branch is hit).
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`):
  **236 passed (236)** with this record, its index row and the cell `0366` in
  place.
- **`pnpm --filter @openpic/web build`** exit 0, both `/entitlements` and
  `/usage` still in the route table.

No test, fixture or helper was edited: the suite changed only by gaining the
one new index name the two index specs derive from `INDEX_SPECS`.

## Out of scope

- No route signature, response schema, status code, log event or persisted
  document changes. No test, fixture or helper is edited; `31` `/usage` cases,
  L5 and L6 included, stay green untouched.
- The `entitlementGrants` read stays unbounded (a tenant's grants are bounded by
  purchases, not by time) — no finding asked for it.
- The plan read is now serial ahead of the grants/counters read: one extra
  round-trip on a path that previously ran three reads in parallel. That is the
  price of bounding the counter read, and the reason the body of the card asked
  for it. A follow-up could fold the plan lookup into an aggregation, which no
  test or finding requires today.

## Consequences

- The `/entitlements` read costs one document per `tenant`-scoped key instead of
  the tenant's whole counter history, so its latency no longer grows with the
  number of closed periods.
- `/usage` pages are served in sort order by the new index; a tenant with many
  periods no longer sorts its rows for every page.
- Both index specs (`indexes.test.ts` U1/U2, `index-bootstrap.test.ts` I1) derive
  their expectation from `INDEX_SPECS`, so no test edit was needed and none was
  made.

## ADR number allocation

The OP-104 lane holds `0360`–`0379` with `Next free = 0365` on `origin/main`
`5e1a05de` (PR #704's squash advanced the cell from `0364` to `0365`). The cell
was re-read from this checkout's ledger immediately before committing, and
`0365` was free on `main`, in this worktree and on every remote ref at the cut,
so this record consumes `0365` and the cell advances to `0366`. No number
outside the lane range `0360`–`0379` is touched.

## Review and landing — PR [#705](https://github.com/yahodu/openpic-webapp/pull/705)

Reviewed head `63b25f74`; docs sign-off `t_8f2bc499`, which consumes no ADR number.
**Verdict: APPROVED WITH FINDINGS (round 1, artifact lens)** — no Critical, High or
Medium finding, and three follow-ups routed by card id. Squash-merged as `c2f079da`
(`mergedAt 2026-11-19T05:22:11Z`) onto `origin/main` `5e1a05de`; PR `#705` is
`MERGED` and the lane branch was auto-deleted by the repository.

### Landing proof

- **Tree identity.** `git rev-parse 63b25f74^{tree} c2f079da^{tree}` prints the tree
  `fce20e21c407def9ef570fd7368ba202cdc4c173` twice, and
  `git diff --stat 63b25f74 c2f079da` is empty: the bytes the review measured are
  the bytes on the trunk. `git merge-base --is-ancestor c2f079da origin/main` exits
  `0`.
- **Merge cleanliness.** `git merge-tree --write-tree 5e1a05de 63b25f74`, measured
  against the trunk the branch was cut from, exits `0` and prints `fce20e21…`.
  Against the trunk as it stands at this sign-off the same command exits `1` on one
  path, `docs/adr/README.md`, because the OP-104 `Next free` cell moved from `0366`
  to `0368` after the merge. That is expected of a squash-merged branch: the squash
  carries the head's whole tree, so the ledger hunk is never replayed and nothing is
  lost.
- **Blob identity of this record.** `git rev-parse` of this file at `63b25f74`, at
  `c2f079da` and at `origin/main` prints `9374741b…` three times.
- **The production tree did not move after the merge either.** The `view.ts` blob
  (`abe342a5…`) and the `indexes.ts` blob (`f2547ddf…`) are identical between
  `63b25f74` and today's trunk, and `git diff --stat 63b25f74 origin/main` over
  `apps/web/src`, `packages` and the schema document is empty, so the gates below
  still describe the code the trunk carries.

### Checks the review ran at `63b25f74`

- **Focused integration** (`entitlements-endpoints`, `entitlements`,
  `index-bootstrap`): **48 passed (48)** — the `/usage` file at 31 cases with L5 and
  L6 green, and the index bootstrap creating and reconciling the new index by name.
- **Focused unit** (`indexes.test.ts`, `adr-numbering`): **44 passed (44)**.
- **Full `unit` + `integration` with coverage**: **exit 0 — 332 files / 4681 passed
  (3 skipped)**; global **91.82 % statements / 80.76 % branches**, and
  `server/services/entitlements` **99.37 % branches**. That is the review's own
  reading, two hundredths of a point above the handoff's 91.80 / 80.69; both are
  above the gates.
- **`tsc`** exit `0` on all three projects. **`eslint`** 0 errors on both touched
  production files, with the same two pre-existing
  `security/detect-object-injection` warnings in `indexes.ts` — proved pre-existing
  by running the same lint at `5e1a05de`, where they sit thirteen lines earlier.
  **`prettier --check`** clean on all five touched files.
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`): **236 passed
  (236)**.
- **`next build`** exit `0`, with `/api/v1/tenants/[tenantId]/usage` in the route
  table beside `/entitlements`.
- **Remote checks 14/14**, `secret-scan` and the aggregate `ci` included. The merged
  PR's `statusCheckRollup` lists **15** rows, every one `SUCCESS`; the fifteenth is
  the `notify-discord` close side-effect run, which is not a gate.

Re-measured while writing this section, at the trunk `dbf93bf3` that carries the
squash: the tree, blob and production-tree identities above; the six ADR guards at
**236 passed (236)**; focused unit **44 passed (44)**; `eslint` 0 errors with the
same two warnings (`indexes.ts:961`, `indexes.ts:982`); and
`prettier --check "docs/adr/**/*.md"` clean. The focused integration files read **50
passed (50)** there rather than 48 — the two cases `t_d614b82a` added in PR `#707` —
so the reviewed figure is quoted at the head it was measured on. The full suite with
coverage, `tsc` and `next build` were not re-run here; they are the review's
measurements at `63b25f74`, on a production tree that is byte-identical to today's.

### P1 measured: the read is bounded to the pairs the view serves

A probe worktree at `63b25f74` spied on `db.collection` and recorded the filter
`readEntitlementsView` hands the driver:

```
{"$or":[{"entitlementKey":"events.active","periodKey":"2026-09"},
        {"entitlementKey":"storage.bytes","periodKey":"2026-09"},
        {"entitlementKey":"media.uploads","periodKey":"lifetime"}],
 "tenantId":"…"}
```

The tenant scope survives the `$or` (the repository's `scopeFilter` merges
`tenantId` beside it, not inside the branches). On a seeded history of **36** counter
rows — three plan keys × twelve periods, plus a key no plan names — the two shapes
explain as:

| Filter                    | Winning plan                                            | docsExamined | nReturned |
| ------------------------- | ------------------------------------------------------- | ------------ | --------- |
| new `$or` of served pairs | `FETCH` over `OR` of three `IXSCAN` on the unique index | 2            | 2         |
| old bare `{tenantId}`     | one `IXSCAN` on the same unique index                   | 36           | 36        |

So the gain is served by the existing unique `(tenantId, entitlementKey, periodKey)`
index and is 36 → 2 documents, not a client-side filter. A plan with no
`tenant`-scoped key issues **no** `usageCounters` find at all, so the `$or: []`
driver error is unreachable by construction.

### P2 measured: the new index is load-bearing

`explain("executionStats")` of the `/usage` query after `ensureIndexes`:

- **with** `usage_counters_tenant_period_id`: `LIMIT`, then `FETCH`, then
  `IXSCAN(usage_counters_tenant_period_id)` — **no `SORT` stage** — docsExamined
  **41**;
- **with the index dropped** in the probe: `SORT`, then `FETCH`, then
  `IXSCAN(usage_counters_tenant_key_period_unique)` — docsExamined **96**.

The keyset page takes the same index: the probe recorded the identical stage chain
and the same 41 documents with a cursor bound. The index is therefore
**load-bearing** for the §0.8 pagination of this route, not a cosmetic addition —
drop it and every page sorts the tenant's counter rows in memory.

### One measured qualification to §Status and §Out of scope

Both of those lines state that the delivery changes no status code. That holds for
the arms the pins cover, but it is not exact in one arm. Measured A/B with the same
seed and the same spec:

- a `usageCounters` row for a plan key whose `value` is not a number, sitting in a
  **closed** period (`2019-01`) while the served period is `2026-09`, made
  `5e1a05de` throw and the route answer `500 internal_error`, and makes `63b25f74`
  serve normally — `ok: true` with `used: 4` taken from the current-period row;
- the same malformed row in the **served** period is refused with the
  `500 internal_error` answer on both heads.

The delta is exactly one behaviour: a corrupt row outside the served period is no
longer fetched, so it is no longer parsed. The direction is defensible — one bad
historical row should not take out the whole view — and it is what §P1 bought; what
is inexact is the blanket wording, not the decision. This section records the
measurement and does not rewrite §Status or §Out of scope; the routing is in
§"Findings routing" below.

**No decision in §Decision is retracted** — §P1 and §P2 stand exactly as written,
neither narrowed, withdrawn nor re-scoped. (The record carries no §D-numbered
clause, so its two decisions are named by their section headings.)

### Ledger and no-collision proof

- **`ADR-0365` is unique.** `0` on `origin/main` `5e1a05de` at the cut, and
  `git rev-list --objects --all -- docs/adr` counts **1** `ADR-0365` object across
  every ref, so only this lane minted it. `checkAdrDirectory` is green.
- **The cell moved as intended.** The OP-104 `Next free` cell read `0365` on the
  trunk the branch was cut from and `0366` at the reviewed head (`0364` was already
  consumed by the sibling pin record). At this sign-off it reads `0368`: PR `#707`
  took `0367` and left `0366` to the reservation held by `t_6fdc277b`.
- **This section consumes no number and moves no cell.** `docs/adr/README.md` is
  byte-identical to `origin/main` in the sign-off PR — no row, no cell, no lane
  paragraph — and `git diff --name-only origin/main...HEAD` lists only this file.

### Findings routing

- **F1 (Low) — `t_6fdc277b`**: bound the `entitlementGrants` read to the active
  window. Same class as §P1. The probe recorded that read's filter as a bare
  `{"tenantId":"…"}` with no window, while `isGrantActive` and `effectiveLimit` bound
  the selection before use, so an active-window filter would be provably identical
  in output. Not a blocker for this delivery.
- **F2 (Low) — `t_d614b82a`**: characterization pins for both arms of the corruption
  delta recorded above. Landed as PR `#707` (squash `dbf93bf3`); its own record is
  `0367` on the trunk.
- **F3 — this sign-off `t_8f2bc499`**: records F1 and F2 without touching the
  delivery.
- **Recording-only notes, no card:** the plan read is now serial ahead of the grants
  and counters, one extra round-trip on a hot path (already in §Out of scope); the
  new index adds one index to maintain on every `consumeEntitlement` `$inc`; the two
  `periodKey(spec.resetPeriod, now)` derivations in `view.ts` must stay equal or
  `used` silently becomes `0`, and the current contract is covered by the specs;
  `ensureIndexes` is the manual `pnpm db:ensure-indexes` script rather than a boot
  step, so §P2 takes effect on an environment only after it runs; and the review's
  coverage reading differs from the handoff's by 0.02 points of statements, both
  above the gates.
