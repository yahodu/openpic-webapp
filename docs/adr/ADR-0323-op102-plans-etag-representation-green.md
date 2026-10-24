# ADR-0323 — OP-102 follow-up GREEN: derive the `GET /plans` ETag from the served representation

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-102 follow-up GREEN (`t_0ad1baa2`) · **Branch:** `OP-102-task-plans-etag-representation` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1156c7ad`
- **Relates to:** [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) (the RED pins this GREEN turns green), [ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md) (the GREEN whose round-1 review raised the finding), [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the binding RED contract; §2 superseded here), [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (version-on-change), [ADR-0006](ADR-0006-cursor-pagination-and-etag.md) (ETag plumbing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.1 (plans), §0.10 (ETags) · **Schema:** §14.1

## Context

The round-1 review of the OP-102 GREEN (`t_1156c7ad`, recorded in
[ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md) → "Round-1 review" →
finding 1) established that `planCatalogueETag` derived the `/plans` tag from
`(key, version)` **only**, while the body served by the route varies with two
things that tag ignored:

1. the `currency`/`billingCycle` query, which filters `prices` (pinned by I1 of
   `plans-endpoint.test.ts`); and
2. the served copy (`name`, `description`, `marketingFeatures`) and prices,
   which a data edit changes without bumping `version` (`seedPlans` bumps
   `version` only on an entitlement change — [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) §6).

Both defects were user-visible: a `?currency=USD` conditional GET could be
answered `304` off an `ETag` minted for `?currency=INR` (the client then reuses
the wrong variant's price set), and a price/copy edit never invalidated a
revalidating client — because a `304` refreshes `max-age`, the staleness was
**unbounded**.

[ADR-0322](ADR-0322-op102-plans-etag-representation-red.md)
(`apps/web/src/test/integration/plans-etag-representation.test.ts`, 6 tests)
pinned four observable invariants at the route boundary — variant identity, no
cross-variant `304`, a copy-edit invalidates, a price-edit invalidates — plus
two regression anchors that an unchanged catalogue still answers `304` (default
and USD variants). RED at that head: `4 failed | 2 passed (6)`, assertion-level
(`expected '"d21b17…"' not to be '"d21b17…"'`; `expected 304 to be 200`).

## Decision

### The tag is a content digest of the served plans

`apps/web/src/server/plans/plan-etag.ts` now hashes the served representation:

```ts
export function planCatalogueETag(entries: readonly CatalogueTagEntry[]): string {
  return hashCatalogueTag(JSON.stringify(entries));
}
```

`CatalogueTagEntry` is `{ readonly key: string; readonly version: number }` —
the minimal identity an entry must carry — but **every own enumerable property**
of each entry is hashed, so the production caller passes the full served plan
(the route now calls `planCatalogueETag(data)` where `data: ServedPlan[]`).
The digest goes through the shared `@/server/plans/catalogue-tag`
(`hashCatalogueTag`), so `GET /plans` and `GET /addons` cannot drift on the
digest length or the hex encoding. This mirrors the add-on catalogue's tag
(`addonCatalogueETag`, a content hash because that document has no `version`),
and makes `/plans` and `/addons` consistent: a `304` means "the bytes you hold
are the bytes this request would serve".

### Why the digest is order-stable without an explicit sort

The input is canonical because the route already guarantees it: plans are read
`.sort({ tierRank: 1 })` (ascending, as the I1 spec pins) and each document goes
through the strict §3.1 projection schemas
([ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md),
`plan-projection.ts`), so both the plan order and every object's key order are
fixed for a given database state. The tag therefore changes exactly when — and
only when — the served bytes change. The TSDoc records this contract.

### The parameter type may be minimal; the hash is not

The U2 unit contract (`plan-etag.test.ts`) passes bare `{ key, version }`
objects and must stay green **unedited**, so the parameter type is the minimal
structural shape rather than `ServedPlan` (whose required fields a literal
would not satisfy). That is a type-level affordance only: the digest covers the
whole served plan, which is what the route passes. `JSON.stringify` serialises
the runtime objects, so the declared element type never narrows what is hashed.

### `ADR-0320 §2`'s "copy-only edits leave the tag unchanged" is superseded

[ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) §2 pinned that a
copy-only edit must **not** invalidate a cached `/plans` response, and
[ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md)'s Alternatives
rejected a content hash for `/plans` on that basis. The round-1 review
established that this choice is the bug (a `304` refreshes `max-age`, so
staleness is unbounded). This ADR records the reversal: **a copy or price edit
must invalidate the tag.** ADR-0320/0321 are accepted history and are not
rewritten; a pointer line to this record was appended to ADR-0321's finding 1
so the correction is traceable from the finding that demanded it.

## Consequences

- `GET /plans` answers `304` only when the bytes the client holds are the bytes
  this request would serve — for every `currency`/`billingCycle` variant and
  every plan edit. The cache is correct by construction rather than bounded by
  `max-age`.
- A copy edit is now cheaper to _correct_ but slightly more expensive to _cache_
  (a revalidating client re-downloads after a copy edit). That is the intended
  trade: the card story is "pricing copy changes need no deploy", which requires
  the edit to reach clients.
- An unchanged catalogue is unaffected: the two regression anchors and the E1
  e2e (`e2e/plans.spec.ts`) pin that revalidating an unchanged representation
  still answers `304`.
- The U2 unit pins are preserved unchanged: the same `(key, version)` set
  yields the same tag; a bumped version, an added plan or a removed plan yields
  a different tag; and an empty catalogue yields a stable, non-empty tag.
- The route and the tag keep their `public, max-age=300` header and the
  bodyless `304`; no wire shape changes.

## Alternatives

- **Pin the exact derivation (e.g. `sha256(JSON.stringify(body))` in the test).**
  Not done: [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) leaves
  the tag's shape unpinned (hash vs join, weak vs strong) and pins only the
  observable invariants, so the spec does not over-specify the representation.
- **Keep `(key, version)` and add the query variant to the tag.** Rejected: it
  would fix only the cross-variant `304` and still miss a copy/price edit, which
  is the unbounded-staleness half of the finding.
- **Sort the plans by `key` inside the tag.** Rejected as unnecessary: the route
  serves `tierRank` order deterministically, and re-sorting would decouple the
  tag from the served byte order it is supposed to identify.
- **Hash only a hand-picked field list.** Rejected: a curated list is exactly
  the failure mode being fixed (a new served field would silently escape the
  tag); hashing the served plan is total.

## Evidence (this card, head on branch `OP-102-task-plans-etag-representation`)

- New representation pin: `TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration apps/web/src/test/integration/plans-etag-representation.test.ts` → **6 passed (6)**.
- Unit `plan-etag.test.ts` (U2) unedited and green: **5 passed (5)**.
- Integration `plans-endpoint.test.ts`, `conditional-etag.test.ts`,
  `addons-endpoint.test.ts` (I1–I4 + regression): **17 passed (17)**.
- E1 e2e (`playwright test -c apps/web/playwright.config.ts apps/web/e2e/plans.spec.ts --project api`): **1 passed (1)**.
- Full `TMPDIR=/root/tmp-mongo pnpm test:coverage`: **166 files / 2203 tests passed, exit 0**
  (statements `92.07%`, branches `80.1%`).
- `pnpm typecheck` exit `0` on all three projects; `pnpm lint` `0 errors`;
  `pnpm format:check` clean; the `adr-numbering` guard green (29 passed).
- `gitleaks`: no leaks found over `origin/main..HEAD`.

No number outside the lane range `0320`–`0339` is touched.
