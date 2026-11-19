# ADR-0369 — OP-104 follow-up IMPL: an `entitlementGrants` index that bounds the grant-window storage scan

- **Status:** Accepted (IMPL; schema/index-only — no wire, status-code, log or persisted-document change)
- **Date:** 2026-11-19
- **Card:** OP-104 IMPL follow-up (`t_a3fcf2e2`) · **Branch:** `OP-104-task-grant-window-index` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a3fcf2e2`
- **Relates to:** [ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md) (the bounded read whose storage scan this index bounds), [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md) (the sibling index addition and the measurement format), [ADR-0341](ADR-0341-op103-entitlements-green.md) (the `(tenantId, entitlementKey, validFrom)` index family), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage) · **Schema:** §14.2, §21
- **Consumers:** `apps/web/src/server/db/indexes.ts`

## Context

ADR-0366 bounded the `entitlementGrants` read to the active window:

```ts
.find({ validFrom: { $lte: now }, $or: [{ validUntil: null }, { validUntil: { $gt: now } }] })
```

That change bounded the **returned** set (`nReturned = 3` over a 60-expired-grant
seed) but not the **storage scan**: `validUntil` was in no index, and
`entitlementKey` is unconstrained by this filter, so the only production index
(`entitlement_grants_tenant_key_valid_from`) could not range-bound `validFrom`
either. The planner therefore fetched the tenant's whole grant history —
exactly the expired-grant mass the bound was meant to stop paying for — and
ADR-0366 §Consequences' "its latency no longer grows with the number of expired
or future purchase grants" and §Out of scope's "no finding or measurement asks
for a `validFrom`-leading index today" were both overstated by that measurement.

## Decision

Register one more index on `COLLECTIONS.entitlementGrants` in `INDEX_SPECS`
(`apps/web/src/server/db/indexes.ts`):

```
name: "entitlement_grants_tenant_valid_until"
keys: tenantId 1, validUntil 1
```

It leads with `tenantId` (schema §21 P3, the U1 tenant-prefix invariant), is not
unique, and carries no partial filter: the filter's `$or` is served as two
`IXSCAN` branches on the same index (one for `validUntil: null`, one for the
`$gt: now` range), and the residual `validFrom` predicate is applied in `FETCH`.

### Measurement

Probe worktree at this head, `ensureIndexes`/`createIndex` on a real
`MongoMemoryReplSet`, seed of **60 expired** grants (`validFrom 2024-01-01`,
`validUntil 2024-12-31`) plus **3 live** grants (`validFrom 2026-01-01`,
`validUntil null`), `now = 2026-09-15T12:00:00.000Z`. The query is built through
`tenantRepo(TENANT, db).collection(COLLECTIONS.entitlementGrants).find(FILTER)`,
not a hand-assembled filter, and explained with
`cursor.explain("executionStats")`:

| index set                                                                    | nReturned | keysExamined | docsExamined | winning plan                                                               |
| ---------------------------------------------------------------------------- | --------- | ------------ | ------------ | -------------------------------------------------------------------------- |
| before: `(tenantId, entitlementKey, validFrom)` only                         | 3         | 63           | **63**       | `FETCH <- IXSCAN(entitlement_grants_tenant_key_valid_from)`                |
| candidate A: `(tenantId, validUntil)`                                        | 3         | 4            | **6**        | `FETCH <- OR <- FETCH <- IXSCAN(a) <- IXSCAN(a)`                           |
| candidate B: `(tenantId, validFrom, validUntil)`                             | 3         | 6            | **6**        | `FETCH <- OR <- FETCH <- IXSCAN(b) <- IXSCAN(b)`                           |
| after bootstrap: production set with `entitlement_grants_tenant_valid_until` | 3         | 4            | **6**        | `FETCH <- OR <- FETCH <- IXSCAN(entitlement_grants_tenant_valid_until)` ×2 |

### Chosen key order, and the rejected alternative

**A — `(tenantId, validUntil)`** is chosen. It ties B on `docsExamined` (6) and
wins on `keysExamined` (4 vs 6): `validFrom` is only ever bounded from **above**
by this read, and an equality-prefixed range on the trailing key cannot use the
leading `validFrom` to shorten the scan, so B pays index entries it cannot
spend. B also duplicates the `validFrom` key the existing
`(tenantId, entitlementKey, validFrom)` index already carries.

**B — `(tenantId, validFrom, validUntil)`** is rejected on that measurement. It
is not wrong, only strictly larger for no gain; the same 6 documents are fetched
and two more keys are walked.

## Evidence

- **Acceptance explain**: `nReturned = 3`, `docsExamined = 6` (gate: `<= 10`)
  through the production index set after `ensureIndexes`, with the plan line
  quoted in the table above.
- **Focused integration** (unchanged files,
  `entitlements-endpoints.test.ts` + `index-bootstrap.test.ts`): **41 passed
  (41)** — the bootstrap creates `entitlement_grants_tenant_valid_until` by name.
- **Unit index lint** (`apps/web/src/server/db/indexes.test.ts`): **15 passed
  (15)** — it derives its expected set from `INDEX_SPECS`, so no test, fixture
  or helper was edited.
- The remaining gates (`pnpm typecheck` on the three projects, `eslint`,
  `prettier --check`, full unit + integration with coverage, the six ADR guard
  files, `apps/web` `next build`) are recorded in the card handoff and the PR.

## Consequences

- The `/entitlements` grant read now walks **4 keys and fetches 6 documents**
  over the measured seed instead of 63 and 63, so its storage scan no longer
  grows with the tenant's expired or not-yet-valid grant mass. ADR-0366
  §Consequences' latency claim now holds for the reason it gave.
- One more index to maintain on each `entitlementGrants` insert. With no
  `validUntil` bound in the query the planner has no reason to pick it over the
  existing key-leading index.
- The schema's own index list (`docs/Notification and Database Design.md`
  §14.2) gains the same key pair on the `entitlementGrants` index line. §21 is a
  "non-obvious indexes only" summary already covered by its
  "all tenant-scoped: `tenantId` leading" row, so no §21 row is added.
- `ensureIndexes` is the manual `pnpm db:ensure-indexes` script, not a boot
  step, so the new plan takes effect on an environment only after it runs. Until
  then the read is correct, only unbounded — the pre-change behaviour.

## Out of scope

- No change to the view's filter, the counter read, the served fields, a route
  signature, status code, log event or persisted document.
- No test, fixture or helper is edited; both index specs derive their
  expectation from `INDEX_SPECS`.
- No partial filter on the new index: `$or` with a `null` branch plus a range
  cannot be expressed as one partial filter without dropping a branch.

## ADR number allocation

The OP-104 lane holds `0360`–`0379`. `origin/main` `0659da33` carries
`0360`–`0367` with the lane cell at `0368` (held by open PR #711) and `0369`
free on the trunk, in this worktree and on every remote ref at the cut, so this
record consumes `0369` and the cell advances to `0370`. The in-flight sibling
`t_8f1dac13` already carries `ADR-0370` on its branch and its own ledger update
sets the cell to `0371`; whichever lands second wins the union resolution (the
higher cell), so the two updates converge and no number is reused.
