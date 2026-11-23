# ADR-0921 — OP-139 TEST: the isolation audit reports a tenant-scoped row that carries no `tenantId`

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_f12d7d0f` (OP-139 TEST, Medium — finding **F1** of the round-1 review of the
  OP-139 GREEN `t_c414a059` / [ADR-0919](ADR-0919-op139-analytics-rollup-jobs-green.md); the
  review card raised F1, and this card is the pin that closes it)
- **Branch:** `OP-139-task-audit-missing-tenant-pins`. **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_f12d7d0f`
- **Touches:** one integration spec **appended**
  (`apps/web/src/test/integration/tenant-isolation-audit.test.ts`: a new docblock, one local
  seed helper and five cases; the shipped `I3`/`I4` cases, every helper and the factory
  `factories/rollup-jobs.ts` are byte-identical), plus this record, its index row, the lane's
  `Next free` cell and one ledger paragraph. **No production code, no factory, no helper, no
  second spec, no contract document.**
- **ADR number:** `0921` — the OP-139 lane's own `Next free` cell inside its `0918`–`0937`
  block, advanced to `0922`. The sweep is §6.
- **Consumes:** [ADR-0918](ADR-0918-op139-analytics-rollup-jobs-red.md) A10 (the alert's address),
  A11 (the two reasons are exclusive) and A19 (`scanned` counts documents), the OP-139 GREEN
  record §4 (the shipped sweep), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §12
  item 23 (the number sweep), contract §10.2 (the audit's sentence) and §0.15 (no document
  payload leaves the boundary).

## 1. Context — the audit cannot see the strongest form of tenancy escape

`apps/web/src/server/jobs/tenant-isolation-audit.ts` reads every tenant-scoped document's
`tenantId` through `hexOf` and then **drops the row** when that answers `null`:

```ts
const tenantId = hexOf(row.tenantId);
if (tenantId === null) {
  continue; // counted in `scanned`, then forgotten
}
```

`hexOf` answers `null` for anything that is neither a string nor an `ObjectId`, so a
tenant-scoped document with the `tenantId` key **absent** — or present and explicitly `null` —
is counted in `scanned` and then silently dropped. It is never `unresolved_tenant` (that branch
needs a hex id to address the event to), never `tenant_mismatch` (that branch needs a live
tenant and a parent event). Two rows examined, zero findings.

That is the failure mode the audit exists for. The card this lane implements says the audit
flags "documents whose `tenantId` does not resolve to a live tenant" (contract §10.2). A row
with no `tenantId` does not resolve to a live tenant. The audit was blind to exactly the rows a
tenancy bug leaves behind when it forgets to stamp the key at all.

## 2. Measurement — the blind spot, twice

**The reviewer's probe** (round 1 of the GREEN review, at the reviewed head `468ab713`): two
`usageCounters` rows, one with the `tenantId` key absent and one with `tenantId: null`, plus one
live tenant. The shipped job reported:

```
PROBE-RESULT {"scanned":2,"affected":0,"eventCount":0,"payloads":[]}
```

**This card's own measurement**, through the five pins below on the shipped head `ff23c0ab`
(`origin/main` at the delivery cut), which is the same fact measured by the pins that now guard
it:

```
× F1: a row whose tenantId is absent or null is one missing_tenant finding, counts only
× F1: the missing_tenant event is addressed to the platform tenant
× F1: the same day's rerun emits no second missing_tenant event
× F1: the next IST day's run announces the finding again
  Tests  4 failed | 5 passed (9)
```

Every red is `AssertionError: expected [] to have a length of 1 but got +0` — no event exists.
The shipped `I3`/`I4` cases and the healthy-control arm pass, so the harness and the seed are
sound. The first assertion in the first F1 case, `expect(result.scanned).toBeGreaterThanOrEqual(3)`,
**passes** before that failure: the three seeded rows were examined and dropped, which is the
reviewer's `scanned: 2` reproduced inside the pin.

## 3. Decision

### 3.1 A third reason, `missing_tenant`, exclusive of the two shipped reasons

These rows are **not** folded into `unresolved_tenant`. `unresolved_tenant` addresses its event
to the first offending row's own `tenantId`, and these rows have none — the address would have to
become a special case inside a reason that already means something else. Folding would also break
the property ADR-0918 **A11** records: a `tenant_mismatch` row is reported once, under
`tenant_mismatch`, and never again as `unresolved_tenant`, because the two reasons are exclusive.
A third reason keeps that invariant intact and makes the new finding greppable on its own.

The grouping is per collection, as for the shipped reasons: both no-tenant shapes (absent key and
explicit `null`) count into **one** finding per collection per day, so the two rows the card
seeds produce `count: 2`, not two events.

### 3.2 The event is addressed to the platform tenant

A `missing_tenant` finding carries `tenantId: "platform"`. This is not a new address: it is the
codebase's existing platform-scope address —
`apps/web/src/server/billing/jobs/webhook-projection-sweep.ts:46` declares
`const PLATFORM_TENANT_ID = "platform"` and uses it as a domain event's `tenantId` — and
`emitDomainEvent` only requires a string. The row itself has no tenant to address an alert to,
and addressing it to a hex id that resolves to nothing would collide with what `unresolved_tenant`
means.

**This extends ADR-0918 §A10, and says so.** That assumption recorded that "a platform-scope
alerting address is not in the contract" — true for the two reasons it was written about, whose
events are addressed to the offending row's own tenant. A10 continues to bind those two. This
record adds a third reason whose row has no tenant, and therefore carries no address of its own:
the platform address is the only honest one. That is a widening of the contract, not a
contradiction of A10.

### 3.3 Counts only

The payload's key set stays exactly `collection`, `count` and `reason` — the shipped three keys,
with one new value for `reason`. The new reason must not smuggle an id or a field value in
(§0.15: no document payload leaves the boundary), so the pin asserts
`Object.keys(payload).sort() === ["collection", "count", "reason"]` **and** `toEqual` on the whole
payload, which reds an implementation that adds even one key.

### 3.4 One event per `(reason, collection)` per IST day

No new latch: the shipped `dedupeKey` shape
(`tenant.isolation:${reason}:${collection}:${dateKey}`) already carries the reason and the IST
day, so the new finding participates in the same per-day dedupe. The pins hold both directions —
the same day's rerun is silent, and the **next** IST day's run speaks again — because a reason
that dropped the day key would be deduped forever and the collection could stay broken in
silence.

## 4. The contract the pins encode

Five cases in one new `describe`; the seeded fixture is one live tenant, one `usageCounters` row
with the `tenantId` key absent, one with `tenantId: null` and one control row that carries the
live tenant's id (`usage_counters_tenant_key_period_unique` is `{tenantId, entitlementKey,
periodKey}` and a missing key indexes as `null`, so the two no-tenant rows differ in
`entitlementKey`).

| Case                                      | Pins                                                                                                                         | Reds on the shipped head as                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| one missing_tenant finding, counts only   | one event; `payload` `toEqual {reason:"missing_tenant", collection:"usageCounters", count:2}`; key set exact; `scanned >= 3` | `expected [] to have a length of 1 but got +0` |
| addressed to the platform tenant          | `event.tenantId === "platform"`                                                                                              | same                                           |
| the same day's rerun is silent            | second run adds no row                                                                                                       | same                                           |
| the next IST day speaks again             | second row on `2026-11-18`, same payload                                                                                     | same                                           |
| a live `tenantId` is not `missing_tenant` | `scanned >= 1` and no event (control, green on arrival)                                                                      | —                                              |

The control row exists so the `count: 2` assertion is discriminating: a sweep that flagged every
row of the collection would answer `3` and red both the counting arm and the control arm.

## 5. Evidence

Measured in this card's worktree (`vitest` 5.0.3, `MongoMemoryReplSet` via the shipped harness),
all on the branch head with the spec appended:

| State                                                              | Result                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| shipped head `ff23c0ab`, spec appended (the RED)                   | `4 failed \| 5 passed (9)` — the four `missing_tenant` arms |
| throwaway near-fix of `tenant-isolation-audit.ts` (satisfiability) | `9 passed (9)`                                              |
| whole `unit` project, head with the record and its ledger rows     | `193` files, `3233 passed \| 3 skipped (3236)`              |
| `tsc -p apps/web/tsconfig.json --noEmit`                           | exit `0`                                                    |
| `eslint` on the spec                                               | exit `0`, no output                                         |
| `prettier --check` on the spec                                     | `All matched files use Prettier code style!`                |

The near-fix was written into the production path, run, and restored with `git checkout --`; the
file's `sha256` is `0e738e35…` before and after, and `git status` carries the spec and the docs
only. Every variant below was derived from that near-fix by one change and run against the same
spec, which is what makes each arm load-bearing rather than merely unsatisfied:

| Variant of the near-fix                                  | Failing cases                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| none (correct near-fix)                                  | none — `9 passed (9)`                                                               |
| `missing_tenant` rows reported under `unresolved_tenant` | 2: the counts/payload arm and the next-day arm                                      |
| the day key dropped from the new reason's `dedupeKey`    | 1: the next-day arm                                                                 |
| no `dedupeKey` at all                                    | 2: the same-day rerun arm and the shipped `I3` rerun arm                            |
| the event addressed to a hex id instead of `"platform"`  | 1: the platform-address arm                                                         |
| one extra payload key (`sampleTenantId`)                 | 2: the counts-only arm and the shipped `I3` counts-only arm                         |
| the healthy control row counted as `missing_tenant`      | 6: both F1 counting arms, the next-day arm, the control arm and three shipped cases |

The day-key row is the one that earned the fourth case: the rerun arm alone passes when the new
reason's `dedupeKey` omits `dateKey`, because the latched key still collides — measured before
the next-day arm existed (`8 passed (8)` on that variant). The day key is only pinned by a run on
a different IST day.

## 6. Number allocation and sweep

Draws **`0921`**, the `OP-139 jobs & compliance lane` row's `Next free` cell (block
`0918`–`0937`), and advances that cell to **`0922`**. No other cell moves, no cell is lowered and
no range is re-cut; `unallocated (future lanes)` stays `0942` and the `OP-136 jobs lane` cell
stays `0942`.

The sweep (ADR-0300 §12 item 23) read four surfaces immediately before minting:

- `origin/main` `ff23c0ab`: highest records `ADR-0909`, the OP-139 lane's `0918`–`0920` and the
  OP-136 lane's `0938`–`0941`; no `ADR-0921`;
- every `.worktrees/*/docs/adr` tree on this host, tracked and untracked: highest
  `ADR-0942-op140-notification-action-endpoint-red.md` (an OP-140 cut outside this block), no
  `ADR-0921` path;
- the open PR heads — #806 (`OP-140-task-notification-action-endpoint-red`, carries `0900`–`0909`,
  `0938`–`0942`), #755, #743, #272: no `ADR-0921`;
- `git rev-list --objects --all -- docs/adr`: `ADR-0921` resolves in **no** object.

**Trunk move between the sweep and the push.** `origin/main` advanced from `ff23c0ab` to
`34b0e9c4` while this card ran — PR [#807](https://github.com/yahodu/openpic-webapp/pull/807),
the OP-139 DOCS card that corrects [ADR-0920](ADR-0920-op139-u1-ist-day-window-correction.md)'s
guard count and records its landing. That record mints **no** number and does not touch
`docs/adr/README.md`, so the cell stays `0921` and nothing is re-cut; the current `origin/main`
was merged into this branch (never rebased) before the PR head was pushed, so the PR carries the
spec, this record and the ledger rows and does **not** revert #807. The merge is clean
(`git merge-tree --write-tree HEAD origin/main` reports no conflict).

## 7. Alternatives rejected

1. **Fold the rows into `unresolved_tenant`.** Rejected in §3.1: the reason's event is addressed
   to the offending row's own tenant, and these rows have none; folding also breaks A11's
   exclusivity property.
2. **Address the event to the first live tenant.** Rejected: it points an operator at a healthy
   tenant for a row that has nothing to do with it, and no test could tell that address from a
   real leak.
3. **Address the event to the empty string or a zero `ObjectId` hex.** Rejected: a made-up
   address is not a platform address; `"platform"` already exists in this codebase for exactly
   this scope and is what a consumer filters on.
4. **Report one event per no-tenant shape (one for absent, one for `null`).** Rejected: the
   distinction is a storage artefact, not a decision an operator acts on differently, and the
   card's `count: 2` says the shapes group.
5. **Emit the row's `_id` or a sample field in the payload.** Rejected by §0.15, and the counting
   pin reds it.
6. **Skip the next-day arm and keep only the rerun arm.** Rejected on measurement: it does not
   discriminate the day key (§5).

## 8. Consequences and residuals

- The GREEN child (`t_b0c51c6e`, `parents=[t_f12d7d0f]`) implements the third reason, the
  platform address and the grouping; no test file is its to edit.
- The `unit` project is green on this head only because this record exists: the spec cites
  `ADR-0921`, and the `adr-source-references` guard reports a dangling citation until the record
  lands. The spec's citation is therefore part of the same delivery, not a later edit.
- **Residual:** the pins constrain the payload key set but not the number's type beyond equality
  with `2`; a `count` serialized as a string would fail `toEqual`, and a float `2.0` would pass —
  the shipped `Finding.count` is an integer by construction and no other case pins integrality.
- **Residual:** only `usageCounters` is used as the no-tenant carrier. The behaviour is
  collection-agnostic by construction (`TENANT_SCOPED_COLLECTIONS` is imported, never re-listed),
  but a reason that special-cased one collection name would not be caught by these arms.
- **Residual:** the alert's _consumer_ side is not pinned here. `admin.abuse.flagged` has no
  notification type of its own in this suite; the shipped OP-139 GREEN record covers the event's
  shape, and what a downstream consumer does with `tenantId: "platform"` stays the
  notifications lane's business.
