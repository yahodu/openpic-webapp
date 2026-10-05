# ADR-0014 — `plans` catalogue schema and seed: unique tierRank, integer money, version-on-entitlement-change

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-83 RED (`t_2b02c0ed`) · **Relates to:** [ADR-0007](ADR-0007-platform-settings-singleton.md) (the sibling seed pattern)
- **Schema:** §14.1 · **Contract:** §3.1, Appendix A (money), §0.15 (never-return)

## Context

OP-83 (`phase: 0-Foundations`, epic _Seed Data_) seeds the `plans` catalogue so a
product owner changes pricing and limits **without a deploy**. `plans` is
platform-scope policy-as-data (design doc P2): each plan carries self-describing
entitlements (`limit`, `resetPeriod`, `scope`, `enforcement`, optional `enabled`)
and embedded `prices[]`, and it is the only place a payment vendor may appear
(inside `prices[].externalRefs`, design principle P1).

The RED card fixes the module contract before the GREEN implementer writes it.
The card's test list (`U1`–`U4`, `I1`) does not pin module paths, export names,
the seed's update semantics, or whether the stored document carries `display`.
Those are decided here so the implementer and any future refactor cannot drift.

## Decision

### Module contract

| Module (specifier)            | Exports                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@/server/plans/plans`        | `entitlementSchema`, `planSchema`, `planCatalogueSchema` (Zod); types `Entitlement`, `Plan`, `PlanPrice` |
| `@/server/plans/plans.values` | `SEED_PLANS: readonly Plan[]` — the four tiers `free`, `starter`, `professional`, `enterprise`           |
| `@/server/plans/seed-plans`   | `seedPlans({ db?, plans?, clock? }): Promise<unknown>`                                                   |

1. **Money is integer minor units.** `amountMinor` is `z.number().int()`; a float
   is rejected at the `prices.<i>.amountMinor` issue path (U1). This mirrors the
   contract's "money is never a float, anywhere" rule (App. A). No upper bound is
   pinned beyond `>= 0`.
2. **The stored entitlement is self-describing and has no `display`.** The stored
   shape is exactly `{ limit: number | null, resetPeriod, scope, enforcement,
enabled? }`. `display` is **added by the `GET /plans` route** from the stored
   spec (contract §3.1: "returned verbatim from the DB plus an added `display`
   string for UI"), so it is not part of the seeded document and no test requires
   it. `limit: null` is legal in every `enforcement` (unlimited for `hard`,
   boolean gate for `feature`).
3. **`enabled` is required when, and only checked when, `enforcement === "feature"`.**
   A feature entitlement without `enabled` is rejected at the `enabled` issue
   path (U2); with an explicit flag it parses. The reverse direction (rejecting
   `enabled` on a non-feature enforcement) is **not** pinned — the contract marks
   `enabled` "only when `enforcement === feature`" as a comment, and over-tightening
   it now would be a guess. See Consequences.
4. **`planSchema` is a non-strict `z.object`.** Stored documents carry a Mongo
   `_id`; a default (strip) object tolerates it. Making the schema `.strict()`
   would make `planSchema.parse(stored)` fail on the driver-added `_id`.
5. **`planCatalogueSchema` enforces catalogue invariants, not just element shape.**
   It is `planSchema.array()` refined so `tierRank` values are unique (U3). This
   is what makes "upgrade or downgrade?" a comparison; a duplicate rank is a
   catalogue defect the seed must never ship. `key` uniqueness is enforced by the
   `{key: 1}` unique index (schema §14.1); the catalogue schema is the unit-level
   guard the seed parses before writing.
6. **The seed is create-or-reconcile, not create-only.** `seedPlans` upserts each
   plan by `key` and:
   - inserts a missing plan with its catalogue `version`;
   - rewrites the entitlements when the catalogue's entitlements differ from the
     stored ones **and bumps `version` by exactly one**;
   - leaves `version` untouched when nothing changed.
     This differs from the create-only `platformSettings` seed (ADR-0007 §4)
     deliberately: `plans` is code-seeded policy that a deploy updates, and
     `version` is what a subscription records as "the plan I bought" (§14.1) — so
     the bump must happen on a real entitlement change and _never_ on an idempotent
     re-run (I1). Grandfathered customers keep the version they bought.
7. **The catalogue is injectable.** `seedPlans` takes `plans?: readonly Plan[]`
   defaulting to `SEED_PLANS`, exactly as `getPlatformSettings` takes its
   `db`/`clock` seams. This is what lets I1 express the card's "a changed
   entitlement" scenario (a seed edit shipped in a deploy) without reaching into
   the constant. The integration spec injects a mutated catalogue; production
   never passes it.
8. **Persistence goes through `platformRepo(db).collection("plans")`.** `plans`
   is platform-scope (no `tenantId`), and the `no-direct-collection-access` rule
   forbids raw `db.collection(...)` outside `src/server/{db,repos}`.
9. **Vendor confinement.** No payment-vendor name may appear outside
   `prices[].externalRefs` (U5). The seed's Cashfree plan ids live only there.

### Seed values

U4 pins only that the **enterprise** plan has `selfServe: false`,
`salesAssisted: true` and `prices: []` (contract §3.1 example). Exact limit and
price amounts are **not** asserted here: card §3 says to use the documented
examples (Starter `49900` INR monthly, 7 events/month, 100 GB, 5000
images/event) and to put unconfirmed values in `plans.values.ts` with TODO
comments. Those numbers are the implementer's to transcribe, and a test that
hard-coded them would turn a product decision into a spec the implementer cannot
satisfy without editing a test.

## Consequences

- A float `amountMinor`, a feature entitlement without `enabled`, or a duplicate
  `tierRank` now fails the suite instead of reaching the entitlement service.
- The `seedPlans` reconcile-and-bump contract makes `version` a faithful record
  of "the plan as bought"; an implementation that always writes the catalogue
  version fails I1.
- **Coverage gap / assumption:** the reverse `enabled` rule (a flag on a
  non-feature entitlement) and the exact seed amounts are deliberately untested
  here. The later `GET /plans` route story owns the `display` projection, the
  `active: false` inclusion rule and the `externalRefs` never-return strip; that
  story should pin them.
- The `{key: 1}` unique index is declared by schema §14.1 but adding it to
  `INDEX_SPECS` is out of scope for OP-83 (index bootstrap is OP-76 territory).

## Alternatives considered

- **Create-only seed (`$setOnInsert`, as `platformSettings`).** Rejected: a
  deploy that fixes a plan's entitlements would never take effect. `plans` is
  code-owned policy, so the seed must reconcile.
- **Always bump `version` on every seed run.** Rejected: a cron/deploy re-run
  would silently re-version every plan and strand grandfathered subscriptions.
- **A per-plan `version` taken from the catalogue on every write.** Rejected for
  the same reason — the stored version must be monotonically advanced by the
  seeder, not reset to the constant.
- **Asserting exact entitlement/price values in the RED specs.** Rejected: the
  card flags several of them as unconfirmed product inputs; the tests pin the
  invariants (integer money, feature gate, unique rank, no vendor leakage,
  version semantics) and leave the numbers to the seed's TODO-marked values.

## Reviewer addendum (2026-10-05, `t_a0789db4`)

OP-83 GREEN was approved as-is (no behaviour change) and squash-merged at
`8407bb8`. Two follow-ups were **deliberately deferred** to chain `t_9f9bde85`
(`openpic-webapp-testcase-writer` → GREEN child `openpic-webapp-backend-coder`)
rather than widened into OP-83:

1. **The seed is check-then-act, not atomic.** `seedPlans` does `findOne` →
   `insertOne`/`updateOne` with `version: existing.version + 1` computed in app
   code, so two overlapping seed runs can insert duplicate plan documents or
   lose a `version` bump. With the `{key: 1}` unique index still absent (below)
   nothing at the database level backstops that. The follow-up pins concurrent
   seeding in a RED spec and makes each write an atomic conditioned upsert.
2. **The `{key: 1}` unique index is still not in `INDEX_SPECS`.** Decision 8's
   deferral stands for OP-83, but the index is the DB-level half of the
   concurrency fix and is now explicitly owned by `t_9f9bde85` (coordinate with
   OP-76 index bootstrap).
