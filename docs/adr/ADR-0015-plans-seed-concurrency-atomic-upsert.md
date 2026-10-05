# ADR-0015 — `plans` seed concurrency: atomic conditioned upsert and the `{key:1}` unique index

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-83 follow-up RED `t_9f9bde85` (review findings on `t_a0789db4`, PR #117 merged `8407bb8`) · **Relates to:** [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (the OP-83 contract and its reviewer addendum) · **Schema:** §14.1, §21 · **ADR-0007** (create-only sibling seed)
- **Supersedes / amends:** nothing in ADR-0014 changes except that ADR-0014's two deferred items are now owned here.

## Context

OP-83 shipped `seedPlans` (`apps/web/src/server/plans/seed-plans.ts`) and was
approved with findings. Two of them are hardening items that do not change the
shipped catalog contract but make it safe under real deployment concurrency:

1. **The seed is check-then-act.** It does `collection.findOne({ key })` and
   then `insertOne` (missing) or `updateOne` (present), computing
   `version: existing.version + 1` in application code. Two overlapping seed
   runs — two deploy instances, or a cron racing a deploy — can both observe
   `null` and insert duplicate plan documents for the same `key`, or interleave
   their reads/writes so a reconcile is applied against a stale document. There
   is no database backstop: `INDEX_SPECS` in `apps/web/src/server/db/indexes.ts`
   carries no `plans` spec, so the `{key:1}` unique index schema §14.1 declares
   does not exist. ADR-0014's reviewer addendum explicitly routed both the
   atomicity fix and the index to this chain.
2. **`plans` is not a registered collection.** `COLLECTIONS` (the
   `CollectionName` registry) has no `plans` member; the seed reaches it through
   `platformRepo(db).collection("plans")` with a local constant. Adding the index
   spec requires first registering the collection name.

The follow-up also carries two test-quality items: the catalogue-uniqueness spec
(U3) asserted only `.success === false`, so an unrelated schema failure could
masquerade as "the duplicate `tierRank` was caught"; and the integration fixture
`withChangedStarterEntitlement` hard-coded `9999` and the first entitlement key,
which would silently become a no-op — making the "bumps version" assertion
vacuous — if the seeded limit were ever changed to `9999`.

## Decision

### 1. Register `plans` and declare its unique index

`plans: "plans"` joins `COLLECTIONS`, and `INDEX_SPECS` gains exactly one spec:

```ts
{
  collection: COLLECTIONS.plans,
  name: "plans_key_unique",
  keys: [["key", 1]],
  unique: true,
}
```

The spec is **not** tenant-scoped (`plans` is platform policy; no `tenantId`),
so the `indexes.test.ts` tenant-prefix lint does not apply. The RED spec pins the
**invariant** (`unique === true` on a single `{key:1}` key for the `plans`
collection) rather than the index's name, so a rename does not break it; the
name above is the convention the registry follows. This is the database-level
half of the concurrency fix: even a buggy caller cannot persist two documents
with the same plan `key`.

### 2. Each plan write is a single atomic conditioned operation

`seedPlans` must stop computing `version` in application code and stop splitting
its read from its write. The observable contract the RED integration specs pin:

- **Fresh-database concurrency.** N overlapping `seedPlans` runs against an
  empty database leave exactly one document per `key` (exactly the four tiers),
  and `seedPlans` never throws a duplicate-key error at the caller.
- **Changed-catalogue concurrency.** N overlapping runs of a catalogue whose
  entitlements differ from the stored ones apply the change exactly once, with
  no duplicate document and no half-applied state.
- **Sequential semantics unchanged** (ADR-0014 §6): a missing plan inserts with
  the catalogue `version`; a real entitlement change bumps `version` by exactly
  one; an idempotent re-run leaves `version` untouched.

The implementer is free to satisfy atomicity with a single
`updateOne({ key }, { $setOnInsert, $set, $inc }, { upsert: true })` or a
compare-and-set filtered on the previously-read entitlements/version; what is
fixed is the observable outcome. A `$setOnInsert`/upsert based on the unique
index can raise `E11000` when two writers race the initial insert, so the seed
must treat a concurrent-insert collision as "another writer won" (re-read and
reconcile) rather than surfacing it.

**Not independently pinned — and why.** The reviewer's phrasing suggested
"exactly one version bump" for two _identical_ concurrent changes. The shipped
implementation already yields exactly one bump for identical catalogues under
both interleavings (a second writer either reads the pre-write version and
writes `N+1`, or reads the post-write entitlements, sees them unchanged and does
not bump), so a spec asserting that would pass against the unfixed code — a
green-on-arrival RED. It is therefore deliberately **not** added; the
duplicate-document specs plus the unique-index specs are the RED signal, and the
sequential bump is already covered by I1 in `plans-seed.test.ts`.

### 3. Test-quality hardening (no production change)

- `plans.test.ts` U3 asserts the offending issue path `"1.tierRank"` (matching
  U1/U2), so a schema that fails for an unrelated reason cannot masquerade as
  the duplicate-rank rejection. This is a guard, not a RED: the shipped
  `planCatalogueSchema` already emits that path, so the tightened spec is green
  on arrival by design.
- `withChangedStarterEntitlement` derives the changed limit from the current
  seeded value (`current + 1`, or `1` when the current limit is `null`) and
  returns it, and I1 asserts it differs from the stored limit. A future edit of
  the seeded limit can no longer turn the "changed catalogue" into a no-op.

## Consequences

- Duplicate plan documents can no longer be persisted: the unique index rejects
  them and the seed's atomic write never tries to create one.
- The seed is safe to run from every deploy instance and from a cron
  concurrently, which is the deployment reality it ships into.
- `plans` is now a first-class registered collection; a raw
  `db.collection("plans")` outside `src/server/{db,repos}` remains forbidden by
  the import-boundary lint.
- The added spec changes nothing about the four tiers' values or the
  entitlement/version semantics customers depend on.

## Alternatives considered

- **Leave the seed as check-then-act and rely on a cron running once.** Rejected:
  rolling deploys routinely run two instances at once, and a missing backstop is
  exactly the failure ADR-0014 §4 flagged as deferred-not-optional.
- **Add the unique index only, keep `findOne` + `insertOne`/`updateOne`.**
  Rejected: the index would turn the race into a thrown `E11000` instead of a
  duplicate row — the seed would crash a deploy rather than converge.
- **Application-level locking (a lease document / advisory lock).** Rejected:
  more moving parts and a new failure mode for a condition a single atomic
  upsert expresses directly; no in-process lock survives two deploy instances.
- **Pin "exactly one bump under concurrent identical changes" as a RED spec.**
  Rejected: it is not red against the shipped code (see §2), so shipping it as a
  RED would be dishonest and it would be a flaky guard rather than a spec.
- **Assert the index by name in the unit lint.** Rejected: the invariant is
  "one unique `{key:1}` index exists", not what it is called; pinning the name
  couples the spec to an internal label with no behavioural meaning.
