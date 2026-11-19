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
