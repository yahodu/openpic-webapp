# ADR-0340 — OP-103 RED: the generic entitlement check, consumption and release

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_bcc2f771` (RED), worktree `/root/openpic/openpic-webapp/.worktrees/t_bcc2f771`,
  branch `OP-103-task-entitlements-check`
- **Consumes:** `0340` (the first number of the lane's range, allocated under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7)
- **GREEN successor:** `t_429ad6f8` (gated on this card), which consumes `0341`

## Context

Every mutating endpoint that consumes a metered resource must call
`checkEntitlement()` **inside the same transaction** as the domain write and the
`usageCounters.$inc` (contract §0.14, schema §14.2/§23). The limits themselves
are _policy as data_: `plans.entitlements[key]` is a self-describing spec
(`limit` + `resetPeriod` + `scope` + `enforcement`), so adding a tier or a limit
is a data edit with zero code change (design principle P2).

The card asks for the RED of that service — its decision surface, its atomic
consumption, its reversal, and the exact `402` vs `403` denial — and for the one
invariant that keeps the design honest: **no plan-name branch may exist in the
service code**. The card's body is a test list, not a contract, so this record
fixes the contract the GREEN implements and flags every ambiguity it resolved.

Baseline facts that shaped the design:

- `plans` (OP-83, `@/server/plans/plans`) and the domain-event outbox (OP-88,
  `@/server/domain/domain-events`) already exist; `usageCounters`,
  `entitlementGrants` and `subscriptions` do **not** exist in
  `COLLECTIONS`, `INDEX_SPECS` or any code path.
- `plan_limit_exceeded` and `feature_not_available` are **not** members of the
  `@openpic/contracts` error-code set; `payment_required` already is. The GREEN
  must append the two missing codes the way `cannot_demote_owner` was appended
  (a new closed set + its own transport table — never `ERROR_CATALOG`, which is
  pinned to the 23 base Appendix A rows; ADR-0261/ADR-0281 precedent).
- `openpic/no-direct-collection-access` forbids `db.collection(...)` outside
  `src/server/{db,repos}`, so the service must read through `tenantRepo` /
  `platformRepo`.
- `apps/web/src/server/services/**` must not call `new Date()`/`Date.now()`
  (lint rule, OP-72): every time read goes through the injected `Clock`.

## Decision

### 1. Module and exports

One new module directory `apps/web/src/server/services/entitlements/`, surfaced
through its `index.ts` barrel (the `@/server/rate-limit` idiom):

```ts
effectiveLimit(spec: Entitlement, grants: readonly EntitlementGrant[], now: Date): number | null
periodKey(resetPeriod: ResetPeriod, now: Date): string
checkEntitlement(tenantId, entitlementKey, amount = 1, ctx = {}, options = {}): Promise<EntitlementVerdict>
consumeEntitlement(session, tenantId, entitlementKey, amount = 1, ctx = {}, options = {}): Promise<EntitlementVerdict>
releaseEntitlement(session, tenantId, entitlementKey, amount = 1, ctx = {}, options = {}): Promise<EntitlementVerdict>
```

with the types `EntitlementSpec` (= the existing `Entitlement`), `EntitlementGrant`,
`EntitlementVerdict`, `EntitlementContext`.

### 2. `checkEntitlement` decides, `consumeEntitlement` enforces

- **`checkEntitlement` never throws for a denial.** It returns the verdict —
  `{ allowed: true, … }` or `{ allowed: false, reason, … }` — exactly the shape
  schema §14.2 sketches. `reason ∈ "plan_limit" | "payment_downgrade" |
"feature_not_available"`, which is what makes the acceptance criterion "the
  402 vs 403 reason is correct" assertable without an HTTP round-trip.
- **`consumeEntitlement` is the enforcement point a route uses for a metered
  write.** Inside the caller's `session` it re-checks, advances the counter with
  one conditional update, and on a denial emits `usage.action.blocked` and
  throws the Appendix A `AppError`:
  - `plan_limit` → `403 plan_limit_exceeded`, `details = { entitlementKey, limit,
used, periodKey, scope, reason: "plan_limit", upgradePath }`;
  - `payment_downgrade` → `402 payment_required`, `details = { entitlementKey,
reason: "payment_downgrade", pendingDueMinor, currency, payNowUrl,
gracePeriodEndsAt }` (grace `null`-safe, serialised as an ISO string);
  - `feature_not_available` → `403 feature_not_available`, `details = {
entitlementKey, upgradePath }`.

  `upgradePath` is the §0.6 example value, `/api/v1/tenants/current/billing/upgrade`.

### 3. The verdict

```ts
type EntitlementVerdict =
  | {
      allowed: true;
      entitlementKey;
      limit;
      effectiveLimit;
      used;
      remaining;
      periodKey;
      scope;
      unlimited: boolean;
    }
  | {
      allowed: false;
      reason;
      entitlementKey;
      limit;
      effectiveLimit;
      used;
      periodKey;
      scope;
      pendingDueMinor: number | null;
      currency: string | null;
      gracePeriodEndsAt: Date | null;
    };
```

`limit` is the raw plan value, `effectiveLimit = overrideLimit ?? (plan.limit +
Σ active grants.delta)`, `remaining = effectiveLimit - used` (or `null` when
unlimited), and `unlimited = effectiveLimit === null`.

### 4. Limits, grants and the period key (pure, no DB)

- A grant is **active** when `validFrom <= now < validUntil` (the upper bound is
  **exclusive**; `validUntil: null` means open-ended). Inactive grants are ignored.
- A non-null `overrideLimit` on an active grant replaces the plan limit and the
  deltas entirely (the negotiated-Enterprise escape hatch). Multiple overrides
  are out of scope — the specs pin a single one.
- An unlimited plan limit (`limit: null`, non-`feature`) stays unlimited however
  many grants exist.
- `periodKey`: `monthly` → `YYYY-MM` **in UTC**, `yearly` → `YYYY`, and
  `lifetime` / `none` → the literal `"lifetime"`. UTC is chosen (not the tenant
  time zone) because the counter row's identity must not depend on mutable tenant
  settings; the contract does not name a zone, so this is the recorded decision.

### 5. Atomic consumption requires the schema's unique index

`consumeEntitlement` advances the counter with a single conditional update whose
filter admits the write only while `value <= effectiveLimit - amount`, upserting
the row on first use, and it retries the duplicate-key race the upsert can lose.
That is only sound with the `{ tenantId: 1, entitlementKey: 1, periodKey: 1 }`
**unique** index from schema §14.2, which the GREEN must register in
`COLLECTIONS` + `TENANT_SCOPED_COLLECTIONS` + `INDEX_SPECS` (and the
`{ tenantId: 1, entitlementKey: 1, validFrom: 1 }` grant index). I1 calls
`ensureIndexes()` and then runs ten concurrent transactions, so a missing index
shows up as over-admission, not as a silent pass.

`releaseEntitlement` decrements by `amount` and **clamps at zero**.

### 6. A denial's event is durable, not transactional

Schema §18.3's outbox and domain-events writer already dedupe on an optional
`dedupeKey` (unique partial index). The denial emits `usage.action.blocked` with
`dedupeKey = <tenantId>:<entitlementKey>:<hourBucket>` so repeats inside one hour
collapse to one row, and a new bucket produces a new row (I3). **The emit does
not join the caller's session**: the metered transaction aborts when the denial
is thrown, and a blocked write must leave no counter row but must leave the
durable notification. `checkEntitlement` itself reads with the caller's session;
`consumeEntitlement`'s emit is the one write outside it.

### 7. Scope

`scope: "tenant"` reads the counter row itself. `event`/`attendee`-scoped usage
comes from `ctx.counts` (the caller counts the related rows), as the card's note
requires. Only `tenant`-scoped keys are exercised by these specs.

### 8. `ctx` and the event refs

`ctx = { counts?, actorRef?, subjectRef? }`. When the denial emits and the refs
are omitted they default to `{ kind: "tenant", id: tenantId }` and
`{ kind: "entitlement", id: entitlementKey }`, so a caller can never produce a
payload-less or forbidden-key-carrying event (`emitDomainEvent`'s own gates
apply).

## Consequences

- Adding a limit or a tier is a data edit: nothing in the service names a plan,
  and the U7 guard keeps it that way mechanically.
- The `402`/`403` split is decided in one place from `subscriptions.status`, so
  the dunning state and the copy can never disagree.
- The GREEN must extend three pre-existing registries (`COLLECTIONS`,
  `INDEX_SPECS`, the contracts error codes) rather than invent new mechanisms.
- Two new error codes (`plan_limit_exceeded`, `feature_not_available`) become
  part of the append-only client-facing enum.

## Alternatives considered

- **`checkEntitlement` throws on denial** (the GREEN card's one-line phrasing
  "Denial -> AppError"). Rejected as the _only_ surface: the advisory
  `GET /entitlements` pre-check (§3.5) and the unit specs both want the reason
  without an exception, and schema §14.2 returns a verdict. The throw lives in
  `consumeEntitlement`, one function away.
- **Emitting the blocked event inside the caller's transaction.** Rejected: the
  denial aborts that transaction, so the durable "you were blocked" record would
  roll back with it.
- **Tenant-local `periodKey`.** Rejected: the counter's identity would then
  change when a tenant edits `settings.defaultTimeZone`, silently resetting
  usage.
- **A plan rename/`tierRank`-based branch to decide blocking.** Rejected on the
  card's own acceptance criterion; the spec's `enforcement`/`limit` fields carry
  the decision.

## Evidence at the RED head

Six new files (2 unit specs, 1 guard spec, 1 integration spec, 1 factory, 1
test-tree scanner — production code: none):

| File                                                          | Purpose                                       |
| ------------------------------------------------------------- | --------------------------------------------- |
| `apps/web/src/test/unit/entitlements.test.ts`                 | U1–U6 (decision, limits, period key, denials) |
| `apps/web/src/test/unit/entitlements-plan-name-guard.test.ts` | U7 (no plan-name literals in the service)     |
| `apps/web/src/test/helpers/plan-name-scan.ts`                 | the U7 scanner (test tree, not production)    |
| `apps/web/src/test/integration/entitlements.test.ts`          | I1–I6 against a real replica set              |
| `apps/web/src/test/factories/entitlements.ts`                 | grant / subscription / counter fixtures       |

- Throwaway stubs at the intended path (deleted before handoff) proved
  type-correctness: `tsc -p apps/web/tsconfig.json --noEmit` exit 0.
- With the stubs, the failures are assertion-level, not harness-level: unit
  `14 failed | 6 passed` on `entitlements.test.ts` (the naive stub returns the raw
  plan limit, an empty period key and an always-allowed verdict) and integration
  `9 failed | 0 passed`. The I4 spec originally had a vacuous pass against the
  naive stub (which never writes), so it now also asserts that the whole limit is
  **still spendable** after the rollback — that step turns I4 red against the stub
  and keeps it honest against the GREEN.
- At handoff the suite is red for the right reason: `Cannot find package
'@/server/services/entitlements'` for both spec files, and the U7 guard fails
  `expected false to be true` on the missing service directory. `tsc -p
apps/web/tsconfig.json --noEmit` reports exactly 3 `TS2307` (one per file that
  imports the module); the root and `packages/contracts` projects are clean.
  React/Playwright surface: none (no `e2e` spec — the card lists none).

## Open questions handed to the GREEN

1. `details.payNowUrl`'s exact path is not fixed by the contract (§0.14 names the
   field only). The specs assert only that it is a tenant-scoped string; the
   GREEN picks the concrete route and records it in ADR-0341.
2. Scope `event`/`attendee` counting via `ctx.counts` is pinned by the contract
   text but not exercised by a spec.
3. `soft`/`policy` enforcement (allow + notify / background job) is not pinned
   here; only `hard` and `feature` are.
4. The `entitlement.denied` info log line (the GREEN card's
   `security_and_logging_requirements`) is deliberately **not** unit-pinned here:
   it is a GREEN-card requirement, not part of the card's test list. The GREEN
   implements it and the review verifies it.
