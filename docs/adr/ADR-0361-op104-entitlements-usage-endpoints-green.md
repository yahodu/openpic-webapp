# ADR-0361 — OP-104 GREEN: the entitlements read view and the raw usage endpoint — module contract, UTC `resetsAt`, and two disputed RED assertions

- **Status:** Accepted (GREEN; suite green at head `3b13b3f` — both disputed RED assertions fixed by the Test Author and the coverage arms pinned, see “Re-run” below)
- **Date:** 2026-10-24
- **Card:** OP-104 GREEN (`t_72aaa13f`) · **Branch:** `OP-104-task-entitlements-usage-endpoints` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e7539f55`
- **Relates to:** [ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) (the RED contract this turns green), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the decision surface this reads), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the reusable tenant stage), [ADR-0280](ADR-0280-op101-tenant-members-red.md) (the owner-only gate shape), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.4 (tenancy), §0.5 (envelopes), §0.14 (entitlement enforcement) · **Schema:** §14.1, §14.2, §14.3

## Context

[ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md) fixed the executable
contract for OP-104: two routes (`GET /tenants/{t}/entitlements` on the `user` +
reusable tenant stages, the bare §3.5 body; `GET /tenants/{t}/usage` behind an
`owner`|`admin` gate, the §0.5 `{ data: […] }` envelope of raw counters filtered
by `?periodKey=`), and two new pure barrel exports on
`@/server/services/entitlements` — `resetsAtFor` and `blockReasonFor`. This
record implements that contract and reports the state of the suite.

## Decision

### Module contract

| Module (specifier)                                         | Exports                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@/app/api/v1/tenants/[tenantId]/entitlements/route` (new) | `GET` — `user` auth + reusable tenant stage, advisory, the bare §3.5 body                   |
| `@/app/api/v1/tenants/[tenantId]/usage/route` (new)        | `GET` — same stages + the `owner`\|`admin` gate, the §0.5 `{ data: rawUsageCountersRow[] }` |
| `@/server/services/entitlements/read-model.ts` (new)       | `resetsAtFor`, `blockReasonFor`, `subscriptionStatusSchema`/`blockReasonSchema`, the types  |
| `@/server/services/entitlements/view.ts` (new)             | the §3.5 schemas + `readEntitlementsView` / `readUsageCounters`                             |
| `@/server/services/entitlements` (existing barrel)         | re-exports the two pure functions, the schemas and the reader                               |
| `@/server/runtime/time.ts` (extended)                      | `startOfNextUtcMonth`, `startOfNextUtcYear`                                                 |

`resetsAtFor` delegates the date construction to `@/server/runtime/time` because
the `services/**` lint bans `new Date(...)`/`Date.now()` outright (the injected
`Clock` port rule, OP-72). The boundary shift therefore lives where it is
lint-legal and testable, exactly as `time.ts`'s own docblock prescribes.

### The §3.5 row projection

Each `plans.entitlements[key]` becomes one row: `limit` (raw plan value),
`effectiveLimit` (`overrideLimit ?? plan.limit + Σ active grants.delta`, via the
OP-103 `effectiveLimit`), `resetPeriod`, `resetsAt` (ISO or `null`), `scope`,
`enforcement`, `unlimited` (`effectiveLimit === null`), `display` (the OP-102
generic `formatEntitlementDisplay`), `thresholdCrossed: null`, and, for a
`tenant`-scoped key only, `periodKey` (`periodKey(spec.resetPeriod, now)`), `used`
(the counter value, `0` when no row) and `remaining`. `grants[]` carries exactly
the **active** grants counted into `effectiveLimit` (`{ delta, source: source.kind,
validUntil }`), in input order. `enabled` is carried only when the stored spec
sets it. An `event`/`attendee`-scoped key is served with its plan limits and
**no** `used`/`remaining`/`periodKey` (contract §3.5; per-event consumption is
§4.1, out of scope).

`blockReason` is `blockReasonFor(subscriptionStatus, quotas)` where the quotas are
the served rows minus the absent `used` (an `event`/`attendee` row cannot be
exhausted). `activePlanKey`/`subscribedPlanKey` default to `"free"` and
`subscriptionStatus` to `"none"` when the tenant has no live subscription — the
free tier is an explicit state, never a `404` (schema §14.3). The read is
advisory: it performs no write.

### Reads

The subscription is read first (it selects the plan key); the plan, the tenant's
grants and the tenant's counters are then read **in parallel** (card §3). The plan
is platform-scoped, the grants/counters are tenant-scoped through `tenantRepo`
(the **string** `tenantId` OP-103 established). `/usage` projects the rows through
a schema that omits the driver `_id` and serializes `updatedAt` as ISO.

## Disputed RED assertions (historical — both resolved on re-run)

> **Resolved at head `3b13b3f`.** The Test Author fixed both assertions on the
> same lane branch in a test-only commit (no production file touched): D1 now
> finds the row in the already-parsed payload (`entitlementRowFrom`), and D2
> wipes `plans`/`subscriptions`/`entitlementGrants`/`usageCounters` in a
> `beforeEach`. That same commit pinned the five `view.ts` branch arms listed
> below. The two subsections that follow are the `3a98020` evidence, kept
> verbatim.

Two assertions in `apps/web/src/test/integration/entitlements-endpoints.test.ts`
cannot pass for any honest implementation. They are reported here rather than
worked around; the fix belongs to the Test Author.

### D1 — `I2: an active grant raises effectiveLimit and appears in grants[]` reads one `Response` body twice

The spec does `const payload = await body(response)` and then, on the **same**
`response`, `await entitlementRow(response, "storage.bytes")` — which calls
`body(response)` again. A Fetch `Response` body is single-use: the second read
throws `TypeError: Body is unusable: Body has already been read` (reproduced on
this host with a bare `new Response(JSON.stringify({a:1}))`). No route can make a
`Response` readable twice.

A throwaway probe (deleted before handoff) seeded this exact scenario and printed
the served row, which already matches the spec's expectation precisely:
`{"key":"storage.bytes","limit":100,"effectiveLimit":150,"used":0,"remaining":150,"periodKey":"lifetime","resetPeriod":"lifetime","resetsAt":null,"scope":"tenant","enforcement":"hard","unlimited":false,"grants":[{"delta":50,"source":"purchase","validUntil":null}],"thresholdCrossed":null,...}`.
So the implementation is correct; only the double read fails.

**Proposed fix:** parse once (`const payload = await body(response)` and find the
row in `payload.entitlements`), or issue a second `getEntitlements(...)` for the
`entitlementRow` call.

### D2 — `lists an event-scoped entitlement with its plan limits but without used` collides on a shared `plans` document

The suite boots **one** database for the whole file (`startTestApp` in
`beforeAll`) with no per-test cleanup, and several tests seed a `plans` document
with the **same key** `"free"` but **different** entitlements — the I1 test seeds
`originals.download` with `enabled: true`, and this test seeds it with
`enabled: false`. `readEntitlementsView` resolves the plan with
`findOne({ key })`, so it reads the first-inserted `"free"` document (the I1 one)
and serves `enabled: true`. The run's failure is exactly that: `expected
"enabled": false, received "enabled": true`.

The suite never calls `ensureIndexes`, so the `plans_key_unique` index (which
would forbid the collision in production) is absent, and the OP-103 suite avoids
this only because it wipes collections between tests. A throwaway probe showed the
same scenario in isolation serves `enabled: false`, as the spec expects.

**Proposed fix:** give each test a unique plan key, add a `beforeEach` cleanup
(or upsert the plan seed), or call `ensureIndexes` and seed with an upsert.

## Evidence at the first GREEN head (`3a98020`)

- `tsc` clean on all three projects (RED's 4 errors gone: the two route modules
  and the two barrel exports now exist).
- unit: **100 files / 1748 tests** green, including the OP-104 read-model spec
  **18/18**.
- integration: **71 files / 523 tests**, `2 failed | 521 passed` — the two
  failures are **D1** and **D2** above; a throwaway probe (deleted) confirms the
  served bodies match the pinned expectations in isolation.
- `eslint` 0 errors on every touched file (one pre-existing
  `security/detect-object-injection` warning in `service.ts`, untouched);
  `prettier --check` clean; ADR guard green.
- coverage (`--coverage --coverage.reportOnFailure=true`): global **92.33 %
  statements / 80.53 % branches / 96.37 % functions / 92.83 % lines** (all pass);
  `apps/web/src/server/domain/**` passes; `apps/web/src/server/services/**`
  **branches 89.66 % (145 total, 15 uncovered) — FAILS the 90 % gate**, by one
  branch. 10 of the 15 uncovered branches are the pre-existing OP-103 defensive
  remainder in `service.ts`; the other 5 are the new `view.ts` branch arms listed
  below. Removing them would delete genuine defence (a missing plan row, an
  optional field), so per the lane rule the shortfall is routed as a **TEST**
  handoff, not "fixed" by weakening the code.

### Coverage gap (TEST handoff)

Five branch arms in `view.ts` are unpinned. They are the defensive remainder, not
dead code, and each is a real state the code must handle:

| `view.ts` | branch                                                           | state never exercised                            |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 166       | `grant.validUntil === null ? null : …`                           | an **active** grant with a non-null `validUntil` |
| 188       | `effective === null ? null : effective - current` (tenant scope) | a **tenant-scoped unlimited** row (`remaining`)  |
| 224       | `planRow === null ? {} : …`                                      | a plan key with **no** `plans` document          |
| 264       | `periodKey === undefined ? {} : { periodKey }`                   | `/usage` with **no** `?periodKey=`               |
| 277       | `counter.updatedAt === undefined ? {} : …`                       | a counter row **without** `updatedAt`            |

## Re-run — the suite is green at `3b13b3f`

The two disputed assertions and the five coverage arms were fixed by the Test
Author on the same lane branch (`3b13b3f`, test-only: no production file
touched; the ADR-0360 contract is unchanged). Re-running the whole gate on the
unchanged production code at `3b13b3f`:

- `tsc` clean on all three projects; `eslint` 0 errors; `prettier --check` clean;
  ADR guard 29/29.
- unit + integration with coverage (`--coverage --coverage.reportOnFailure=true`):
  **exit 0** — every test green and every coverage gate passes. Global **92.33 %
  statements / 80.72 % branches / 96.37 % functions / 92.83 % lines**;
  `apps/web/src/server/services/**` **branches 93.10 % (135/145)** vs the 90 %
  gate, with `view.ts` at **32/32 = 100 %**. The 10 remaining uncovered branches
  are the pre-existing OP-103 remainder in `service.ts`.
- `pnpm --filter @openpic/web build` exit 0 with both new routes
  (`/api/v1/tenants/[tenantId]/entitlements`, `/api/v1/tenants/[tenantId]/usage`)
  in the route table; Playwright E2E **21 passed**.
- Focused integration spec: `entitlements-endpoints.test.ts` **20/20**.

No production code changed between `3a98020` and `3b13b3f`, so the projection,
the free-tier default, the `owner`|`admin` split and the parallel reads described
above are exactly what the green run exercises.

The lane was then merged with `origin/main` (`4775e16`, a docs-only conflict in
this repo's shared `docs/adr/README.md` ledger) and re-verified on the merged
head: `tsc`/`eslint`/`prettier` clean, unit + integration **176 files / 2301
tests** passed, coverage **exit 0** (global **92.39 % statements / 80.95 %
branches / 96.38 % functions / 92.89 % lines**; `apps/web/src/server/services/entitlements`
branches **97.38 %**), `pnpm --filter @openpic/web build` exit 0 and Playwright
E2E **21 passed**; CI (typecheck, lint, unit, integration, coverage, build, E2E)
green on the head.

## Consequences

- The advisory view powers the quota bars, and a wrong `resetsAt`, a
  `plan_limit` for a `soft`/`policy` row, a `past_due` mistaken for a payment
  block, an ignored grant or a `member` reaching `/usage` all fail the suite
  loudly (the surviving 13 assertions).
- `thresholdCrossed` is served as a constant `null`: the threshold latch is not
  modelled yet, so the field is correctly empty and the latch story owns it
  (ADR-0360).
- `display` is the OP-102 generic formatter, so metered rows read as the bare
  limit (e.g. `"3"`), not the §3.5 example's usage-aware prose (`"5 of 7 active
events"`); the exact copy is product copy and unpinned.

## ADR number allocation

This lane (`OP-104`) drew `0360`–`0379` with `0360` consumed by the RED record
([ADR-0360](ADR-0360-op104-entitlements-usage-endpoints-red.md)), so this GREEN
record takes `0361` — the lane-local cell's value re-read immediately before
committing — and the cell advances to `0362`. No number outside the block is
touched.
