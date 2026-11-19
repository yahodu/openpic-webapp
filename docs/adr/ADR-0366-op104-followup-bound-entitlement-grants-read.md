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
