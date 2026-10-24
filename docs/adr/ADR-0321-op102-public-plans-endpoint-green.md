# ADR-0321 — OP-102 GREEN: project the catalogue onto the §3.1/§3.6 served shapes and wire both public reads onto the pipeline

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-102 GREEN (`t_1156c7ad`) · **Branch:** `OP-102-task-public-plans-endpoint-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1156c7ad`
- **Relates to:** [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the binding RED contract), [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (the `plans` schema/seed), [ADR-0006](ADR-0006-cursor-pagination-and-etag.md) (ETag plumbing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.1 (plans), §3.6 (add-ons), §0.10 (ETags), §0.11 (rate-limit classes), §0.15 (never-return) · **Schema:** §14.1, §14.2

## Context

[ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) recorded the executable
contract the OP-102 RED card left open. This record fixes the _implementation_
choices the GREEN made while turning those RED specs green, so a later card can
trace each module and each wire decision.

The RED spec pins four modules:
`@/server/plans/plan-display`, `@/server/plans/plan-etag`,
`@/app/api/v1/plans/route` and `@/app/api/v1/addons/route`. It does **not** pin
how the stored documents are projected, where the served schemas live, how the
`304` is produced, or how the reads are rate-limited.

## Decision

### Module layout

| Module (specifier)               | Exports (implementation)                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/server/plans/plan-display`    | `formatBytes`, `formatEntitlementDisplay` (pinned by U1)                                                                                                                                   |
| `@/server/plans/plan-etag`       | `planCatalogueETag` (pinned by U2)                                                                                                                                                         |
| `@/server/plans/catalogue-tag`   | `hashCatalogueTag` — the shared `sha256` → strong-ETag digest both tags use (round-1 review)                                                                                               |
| `@/server/plans/plan-projection` | `servedPriceSchema`, `servedEntitlementSchema`, `servedPlanSchema`, `servedPlanListSchema`, `projectPrice`, `projectEntitlement`, `projectPlan` + their types (the §3.1 served shapes)     |
| `@/server/plans/addons`          | `addonQuantitySchema`, `storedAddonSchema`, `servedAddonSchema`, `servedAddonListSchema`, `projectAddon`, `addonDisplay`, `addonCatalogueETag` + their types (ADR-0320's schema of record) |
| `@/app/api/v1/plans/route`       | `GET` (public, `{ data: Plan[] }`)                                                                                                                                                         |
| `@/app/api/v1/addons/route`      | `GET` (public, `{ data: Addon[] }`)                                                                                                                                                        |

The served schemas are exported from the projection modules and used as the
route `response` schema, so `defineRoute`'s serializer is the strict
never-return gate: an unprojected field (notably `_id`, `externalRefs`,
`validFrom`/`validUntil`) is a serialization failure rather than a wire detail.

### `plan-projection.ts` owns the §3.1 served shape

Each stored `plans` document is parsed through the existing
`planSchema` (which strips the driver's `_id`/`updatedAt`) and projected:
`prices` filtered to `active: true` and to the requested
`currency`/`billingCycle`, then stripped of `validFrom`/`validUntil` and
`externalRefs`; `entitlements` served verbatim plus the `display` from
`plan-display`; `contactSalesUrl: "/contact-sales"` added only on a
`salesAssisted` tier. The projection is reused by the add-on route for its
embedded prices, so the price never-return rule has one implementation.

### The `304` is produced by the handler, not the `etag` stage

The shared `etagStage` resolves its tag **synchronously**, but the catalogue tag
needs a database read, so the route computes the tag in the handler and — when
`ifNoneMatchSatisfied` matches — returns `status: 304`. The pipeline serves a
null-body status through `emptyResponse`, so the `304` is bodyless and the
`ETag`/`Cache-Control` headers travel on `result.headers`. This keeps ADR-0006's
conditional-request semantics (`If-None-Match` weak comparison) without
abusing the stage meant for resources whose tag is already in hand.

### Both reads are declared on the pipeline as `read.normal`

Both routes set `rateLimit: rateLimitStage({ classKey: "read.normal", … })`
(§0.11), so the shared security headers, serialization control and rate limiting
apply. The card says "rate `read.normal` **by IP**"; the class table scopes
`read.normal` to `user`, and `deriveRateLimitIdentities` maps `user` to the
principal id or — for an anonymous caller — a **salted hash of the client IP**,
so a public read is in fact bucketed per IP. A request whose IP cannot be
resolved yields no identity, which the evaluation surfaces as `unavailable` and
the `read.normal` class fails **open** (§0.11), never a silent unlimited allow
on a resolved client.

### Add-on ordering and the `addons` collection name

`GET /addons` follows the RED spec's `["storage-50gb", "events-pack-10"]`
expectation, which is the insertion order the spec seeds. The route therefore
reads `find({ active: true }).sort({ _id: 1 })`: the driver's `ObjectId`
counter is monotonic within the inserting process, so ascending `_id` is a
deterministic expression of insertion order (a natural-order scan is not a
guarantee). The `addons` collection name is registered in `COLLECTIONS`
alongside `plans` rather than written as a bare literal.

## Consequences

- `GET /plans` and `GET /addons` are live, cacheable, rate-limited public reads
  backed by the U1/I1–I4/E1 specs; the seeded catalogue and the retired-tier
  exclusion are exercised by integration and by a real `next start` server
  (`e2e/plans.spec.ts`).
- The `read.normal` rate-limit stage is exercised only as a fail-open no-op in
  the integration suite (no resolvable IP on the in-process `Request`); the
  `RateLimit-*` header contract itself is already pinned by the rate-limit
  suite (ADR-0005). No new rate-limit behaviour is introduced here.
- **Open / unpinned (unchanged from ADR-0320):** admin inclusion of retired
  plans on the public route; the ETag token format; the exact `display` copy for
  add-ons; price/plan ordering beyond `tierRank`. The add-on document remains
  ADR-0320's schema of record — OP-110 must not diverge from it.

## Alternatives

- **Content-hash the `/plans` ETag as well.** Rejected: ADR-0320 §2 requires
  copy-only edits to leave the tag unchanged, which only a version-derived tag
  gives; the add-on catalogue uses a content hash precisely because it has no
  `version`.
- **Project the stored documents without a schema parse.** Rejected: parsing
  through `planSchema`/`storedAddonSchema` is the boundary that strips `_id` and
  rejects a malformed document at the route rather than emitting a broken body.
- **Reuse `addons[]` inside `GET /plans`.** Already rejected in ADR-0320; the
  separate endpoint is what keeps the `I1` `.strict()` Plan-list parse valid.
- **A per-key `display` copy table.** Rejected in ADR-0320; the generic formatter
  stays total so an unknown key still renders.

## Round-1 review (`t_1156c7ad`, reviewer `openpic-webapp-reviewer`)

Verdict: **approved with findings**, no test, mock or fixture edited by the
reviewer. Independently re-run on this head: unit **97 files / 1704 tests**,
integration **68 files / 493 tests**, e2e **21 passed**, `pnpm test:coverage`
exit `0` (branches 80.07%), `tsc` clean on all three projects, ESLint `0`
errors, Prettier clean, and `apps/web/e2e/plans.spec.ts` re-run against a real
`next start` (the `ETag` and the bodyless `304` travel on the same response).

### Reviewer refactor (behaviour-preserving)

- `@/server/plans/catalogue-tag` extracts the `sha256` → `slice(0, 32)` →
  `strongETag` digest that `plan-etag.ts` and `addons.ts` each carried verbatim,
  plus the single `DIGEST_LENGTH` constant. Both tags are byte-identical before
  and after (proved by the U2 pins, the I4 spec and the E1 conditional GET) and
  the new module is branch-free, so the repo's `branches: 80` threshold is
  unaffected (`test:coverage` exit `0`).

### Finding routed to the board (not fixed here)

1. **The `/plans` tag is not a function of the representation it tags.**
   `planCatalogueETag` derives the tag from `(key, version)` only, while the body
   varies with `currency`/`billingCycle` (pinned by I1) and with copy/prices —
   and `seedPlans` bumps `version` only on an entitlement change
   ([ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) §6). Two
   consequences: a `currency=USD` revalidation can be answered `304` off an
   `ETag` minted for `currency=INR` (the client then reuses the other variant's
   body), and a price/copy edit never invalidates a revalidating client — a `304`
   refreshes `max-age`, so the staleness is **not** bounded by five minutes as
   the Consequences section above claims. Routed as a TEST pin plus a GREEN: a
   tag derived from the versions **and** the served representation satisfies
   every existing pin, so the correction belongs to that GREEN.
   → **Corrected by [ADR-0323](ADR-0323-op102-plans-etag-representation-green.md)**
   (GREEN `t_0ad1baa2`): `planCatalogueETag` now digests the served plans, so the
   tag changes for every `currency`/`billingCycle` variant and every copy/price
   edit. ADR-0320 §2's "copy-only edits leave the tag unchanged" is superseded by
   that record.

### Info

- The branch field above read `wt/t_1156c7ad` (the template default), while the
  card's branch is `OP-102-task-public-plans-endpoint-green`. The reviewer
  corrected both this field and the same string in the README lane paragraph
  while resolving the merge of `origin/main` into this branch — the same class of
  correction main took for the OP-101 paragraph in #274.
- `GET /addons`' conditional path (`If-None-Match` → `304`) is pinned by no test:
  the E1 e2e covers `/plans` only and the I4 integration specs never send
  `If-None-Match`. Routed as a TEST card.
