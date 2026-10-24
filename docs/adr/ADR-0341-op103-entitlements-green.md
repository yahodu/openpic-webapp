# ADR-0341 — OP-103 GREEN: the generic entitlement check, consumption and release

- **Status:** Accepted
- **Date:** 2026-10-24
- **Lane:** OP-103 (Entitlements), reserved range `0340`–`0359`
- **Card:** `t_429ad6f8` (GREEN), worktree `/root/openpic/openpic-webapp/.worktrees/t_429ad6f8`,
  branch `OP-103-task-entitlements-green`, stacked on the RED head `2ed83d9`
- **Consumes:** `0341` (the lane's next free number)
- **Implements:** [ADR-0340](ADR-0340-op103-entitlements-red.md) (the RED contract)

## Context

ADR-0340 fixed the executable contract for the generic entitlement service and
left four open questions to this card. This record is the GREEN: the
implementation that turns the delivered RED specs green, plus the concrete
resolutions of those open questions and the one gate this card could not close
on its own.

## Decision

### 1. Module and exports

One new module directory `apps/web/src/server/services/entitlements/`, surfaced
through its `index.ts` barrel:

| File         | Contents                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| `types.ts`   | the public types (`EntitlementGrant`, `EntitlementContext`, `EntitlementVerdict`, seams)  |
| `policy.ts`  | `effectiveLimit()` / `periodKey()` — the pure limit arithmetic, no I/O, no plan knowledge |
| `service.ts` | `checkEntitlement()` / `consumeEntitlement()` / `releaseEntitlement()` + the outbox seam  |

The exported surface is exactly what ADR-0340 pinned, no more: the two pure
functions, the three async functions, and the types.

### 2. Resolution, decision, enforcement

`service.ts` splits into a private `resolveEntitlement()` (the reads) and
`decide()` (the verdict), so the same resolution feeds all three public
functions:

- `checkEntitlement` = `resolve` + `decide`, and never throws for a denial.
- `consumeEntitlement` = `resolve` + `decide` **inside the caller's session**;
  on a denial it emits `usage.action.blocked` **outside** that session (the
  throw aborts the transaction and the durable record must survive it) and
  throws the Appendix A `AppError`; on an allow it advances the counter and
  returns the verdict with the **post-increment** `used`.
- `releaseEntitlement` = `resolve` + a clamped decrement, returning the
  post-release verdict. It never denies.

The plan spec is read through `platformRepo` (`plans` is platform-scope) and the
subscription, grants and counter through `tenantRepo(tenantId, db)` — the
`openpic/no-direct-collection-access` boundary is respected, and every read and
write carries the caller's `session`.

### 3. Limits, grants and the period key (as ADR-0340 §4)

The live subscription is read once and its plan key, status and dunning fields
are resolved **before** the not-gated early return, so both verdict shapes carry
the same subscription-derived values from one resolution.

- A grant is active while `validFrom <= now < validUntil`; `validUntil: null`
  is open-ended. An active grant's non-null `overrideLimit` replaces the plan
  limit and the deltas; otherwise `limit + Σ active deltas`.
- An unlimited plan limit (`limit: null`) stays unlimited however many grants
  exist.
- `periodKey`: `monthly` → `YYYY-MM` UTC, `yearly` → `YYYY`, `lifetime`/`none`
  → `"lifetime"`.

### 4. Atomic consumption and the registry extensions

`consumeEntitlement` advances the counter with one conditional
`findOneAndUpdate` whose filter admits the write only while
`value <= effectiveLimit - amount`, upserting on first use; a duplicate-key
insert (the race the upsert can lose) is retried as a plain update. This is only
sound with the unique index, so the GREEN registers:

- `COLLECTIONS.usageCounters` / `COLLECTIONS.entitlementGrants` (camelCase,
  app-owned) plus their membership in `TENANT_SCOPED_COLLECTIONS`;
- `usage_counters_tenant_key_period_unique` — unique
  `{tenantId, entitlementKey, periodKey}` (schema §14.2);
- `entitlement_grants_tenant_key_valid_from` — `{tenantId, entitlementKey, validFrom}`.

`releaseEntitlement` decrements with a single update and **clamps at zero** with
a second (`value > 0 && value < amount` → `value: 0`); a missing row leaves the
counter untouched.

### 5. Error codes and transport

`plan_limit_exceeded` and `feature_not_available` are appended to
`@openpic/contracts` in the `cannot_demote_owner` shape: a new closed
`ENTITLEMENT_ERROR_CODES` set, added to `API_ERROR_CODES` and the `AppErrorCode`
union, transported from its own `ENTITLEMENT_ERROR_TRANSPORT` table (both `403`,
non-retryable) merged into the catalogue dispatch — `ERROR_CATALOG` stays the
exact base Appendix A table. `payment_required` needs no entry (already a base
code, `402`).

### 6. Denial mapping and `details` (contract §0.14)

| verdict reason          | code / status               | `details`                                                                                             |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `plan_limit`            | `403 plan_limit_exceeded`   | `{ entitlementKey, limit, used, periodKey, scope, reason, upgradePath }`                              |
| `payment_downgrade`     | `402 payment_required`      | `{ entitlementKey, reason, pendingDueMinor, currency, payNowUrl, gracePeriodEndsAt }` (ISO or `null`) |
| `feature_not_available` | `403 feature_not_available` | `{ entitlementKey, upgradePath }`                                                                     |

`upgradePath` is the §0.6 example value
`/api/v1/tenants/current/billing/upgrade`.

**Open question 1 resolved — `payNowUrl`.** The contract names the field but not
the route (§0.14), and Appendix §6.4 maps the `subscription / pay_now` CTA to
`POST /tenants/{t}/billing/retry-charge`. The GREEN therefore emits
`/api/v1/tenants/{tenantId}/billing/retry-charge` — a tenant-scoped URL, which
is the only property the RED spec asserts (`String(details.payNowUrl)` contains
the tenant id).

### 7. The denial's event is durable, not transactional

`recordDenial()` logs `entitlement.denied` (info, with `entitlementKey`,
`used`, `limit`, `reason`) and emits `usage.action.blocked` with
`dedupeKey = <tenantId>:<entitlementKey>:<UTC hour bucket>` (`YYYY-MM-DDTHH`),
so repeats inside one hour collapse to one outbox row and a new bucket produces
a new row. The emit uses the shared `emitDomainEvent` writer **without** the
caller's session; a spec injects its own emitter through `options.emit` to
observe the path without booting the outbox. This resolves ADR-0340's open
question 4 (the `entitlement.denied` info log is implemented, not unit-pinned).

### 8. `ctx` and `refs`

`ctx = { counts?, actorRef?, subjectRef? }`; `counts` supplies the usage for an
`event`/`attendee`-scoped key (only `tenant` scope reads the counter), and the
refs default to `{ kind: "tenant", id: tenantId }` /
`{ kind: "entitlement", id: entitlementKey }` so an emit can never be
payload-less or carry a forbidden payload key.

### 9. Choices the tests leave open (recorded, not pinned)

- **A not-gated key has no counter.** A key the active plan does not declare
  resolves to `spec: null` and an allowed verdict whose `periodKey` is
  `"lifetime"`, `scope` is `"tenant"`;
  `consumeEntitlement` still meters it (an unconditional increment) so the
  write path is uniform.
- **`used` in a returned verdict is the post-write value** for consume and
  release (the value the counter holds once the transaction commits).
- **The default seam values** (`options.db ?? getDb()`,
  `options.clock ?? systemClock`) are production defaults; the RED specs always
  inject them, so those branches are uncovered by design.

### 10. No plan-name branches

No plan key may appear in the directory. The default plan when a tenant has no
live subscription is the literal `"free"` — a policy fallback, not a branch on
a tier — and the service decides purely from the stored spec. The U7 guard
(`scanPlanNameLiterals`) scans exactly this directory and passes.

## Consequences

- Adding a limit or a tier is a data edit: nothing in the service names a plan,
  and the U7 guard keeps it that way mechanically.
- The `402`/`403` split is decided in one place from `subscriptions.status`.
- The registry now carries the two collections and their indexes; the contracts
  enum carries the two new codes.
- **Coverage.** `vitest.config.ts` requires **90 % branches** under
  `apps/web/src/server/services/**`. A first cut of this service sat at
  **84.34 %**, because several `??` production defaults and per-return
  subscription ternaries each left one side unexercised. Two
  behaviour-preserving restructurings brought the directory to **90.09 %**:
  - a single `resolveSeams()` applies the `options.db` / `options.clock`
    defaults in one place instead of once per public function; and
  - the subscription-derived verdict fields (`status`, `pendingDueMinor`,
    `currency`, `gracePeriodsEndsAt`, the active plan key) are resolved **once**,
    before the not-gated early return, so their `null` side is exercised by the
    no-live-subscription spec (U6) rather than only by the one return path a
    spec happens to reach.

  What stays uncovered is the genuinely defensive remainder — a missing plan
  row, a `feature` gate that is _enabled_, an unlimited consume, the
  duplicate-key upsert retry, and a `payment_downgrade` whose
  `gracePeriodEndsAt` is `null` — all within the 10 % budget and all deliberate.
  The threshold is met without weakening it and without writing tests.

## Alternatives considered

- **Making `options.db`/`clock` required** to remove the default branches.
  Rejected: ADR-0340 §2 pins them optional, and a route needs the production
  defaults.
- **Dropping the duplicate-key retry**, relying on the driver's transaction
  retry. Rejected: an E11000 is not a `TransientTransactionError`, so a lost
  upsert race would surface as the wrong error code; ADR-0340 §5 requires the
  retry.
- **Emitting the blocked event inside the caller's transaction.** Rejected:
  the denial aborts that transaction, so the record would roll back with it
  (ADR-0340 §6).
- **Reporting coverage as a defect of this card's code.** Rejected: the shortfall
  came from duplicated default/ternary resolution, not from missing behaviour, so
  it was fixed by restructuring the code rather than by weakening the gate or by
  writing tests here.

## Evidence at the GREEN head

- Unit: **99 files / 1730 tests** green (the two delivered unit specs included).
- Integration: **69 files / 502 tests** green against the `MongoMemoryReplSet`
  (`I1` proves 10 concurrent consumes against a remaining 3 admit exactly 3 and
  deny the other 7 with `plan_limit_exceeded`; `I3` proves one blocked event per
  hour bucket; `I4` proves an aborted transaction leaves the counter at `0` and
  the whole limit still spendable; `I5` proves release and the clamp).
- `tsc -p tsconfig.json --noEmit`, `-p packages/contracts/tsconfig.json`,
  `-p apps/web/tsconfig.json`: clean.
- `eslint`: 0 errors (the new files add no warning beyond the codebase's
  pre-existing `security/detect-object-injection` class); `prettier --check .`
  clean; the ADR-numbering guard (29/29) clean.
- `test:coverage`: all thresholds pass — global branches `80.39 %` / lines
  `92.7 %`, and the `services/**` branch threshold at `90.09 %` (168 test files
  / 2232 tests).
