# ADR-0324 — OP-102 follow-up TEST: pin the conditional `GET /addons` (If-None-Match → 304)

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-102 follow-up TEST (`t_dae0dc6d`) · **Branch:** `OP-102-task-addons-conditional-get` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1156c7ad`
- **Relates to:** [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the binding RED contract — the separate `GET /addons` endpoint, its `public, max-age=300` cache and its content-hash tag), [ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md) (the GREEN whose round-1 review raised the finding), [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) / [ADR-0323](ADR-0323-op102-plans-etag-representation-green.md) (the parallel `/plans` representation pins this record mirrors), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.6 (add-ons), §0.10 (ETags) · **Schema:** §14.1 (`addons`; schema of record is ADR-0320, no §14.x row)

## Context

The OP-102 card requires `GET /api/v1/addons` to carry "the same cache and ETag
rules as `/plans`", and the route does: it answers `public, max-age=300` and a
strong `ETag` (a content hash of the served add-ons via
`addonCatalogueETag`), and it short-circuits a matching `If-None-Match` to a
bodyless `304`. But nothing sent a conditional request to the route:

- `addons-endpoint.test.ts` (I4) pins the `200` body/headers and the retired
  add-on exclusion, and never revalidates;
- `conditional-etag.test.ts` (I2) pins the reusable `etagStage` on a synthetic
  route, not this endpoint; and
- the E1 e2e covers `/plans` only.

The route's `304` branch and the tag's stability were therefore unpinned and
could regress silently (review finding, **Low**; PR #271 line comment on
`apps/web/src/app/api/v1/addons/route.ts:62`).

## Decision

### A dedicated characterisation pin owns the add-on conditional GET

A new spec, `apps/web/src/test/integration/addons-conditional-get.test.ts`,
pins the observable wire behaviour at the route boundary (6 tests). It is a
**characterisation pin**: it documents existing, already-shipped behaviour and
must stay green on the trunk. It does **not** edit the RED-authored specs
(`addons-endpoint.test.ts`, `conditional-etag.test.ts` stay byte-unchanged).

The invariants pinned, and only these (the tag's _shape_ — hash vs join, strong
vs weak — is an implementation detail and is not asserted):

1. an unconditional `GET /addons` answers `200`, `cache-control: public,
max-age=300`, a truthy `etag` and the seeded catalogue;
2. replaying that `etag` as `If-None-Match` answers `304` with the same `etag`,
   the same `cache-control`, and a **zero-byte** body;
3. a non-matching tag answers the full `200` catalogue;
4. the tag is stable across two requests for an unchanged catalogue;
5. a change to a **served** field (the add-on `name`) changes the tag and the
   now-stale tag no longer revalidates to `304` (`200` with the new bytes); and
6. each `currency` variant of one catalogue mints a distinct tag, and a tag
   minted for one variant does not revalidate another to `304`.

### The `/addons` tag identifies the served representation — the same rule the RED pins forced on `/plans`

`addonCatalogueETag` hashes the served items (`JSON.stringify(addons)`), so the
`/addons` tag already satisfied the representation-identity rule that
[ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) had to force onto
`planCatalogueETag` (which had keyed on `(key, version)` only). The add-on
document has no `version`, so a content hash was the only construction
[ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) could use. Items 5 and 6
make that property observable: a `304` reaches the client **iff** the bytes it
holds are the bytes the request would serve, for every `currency` variant and
every catalogue edit.

### Pins must be green on the trunk; a failure is routed, not weakened

The card is explicit: if a pin fails, the pin is not weakened — the card
completes with the failure evidence and a GREEN card is created for the fix.
All 6 pins passed on the trunk at `b614bc9`, so no GREEN sibling was created.
(This is the inverse of the RED-by-design pins the same lane normally ships,
which are red on purpose and folded into a GREEN's PR.)

## Consequences

- The `/addons` `304` branch and the tag's stability are now regression-locked:
  deleting the `If-None-Match` short-circuit, or making the tag key on anything
  narrower than the served bytes, fails a named assertion (`expected 200 to be
304`, or `expected '"…"' not to be '"…"'`).
- The pin is honest about the negative cases: the non-matching tag and the
  cross-variant tag each assert `200`, so a route that always returned `304`
  would fail — the `304` is not merely "some 304".
- The spec reuses the I4 seeding shape (`deleteMany({})` then `insertMany`) and
  the `makeAddon`/`makeAddonPrice` factory, so it seeds the same collection the
  same way; it adds no new fixture.
- The `304` is asserted to carry `etag` **and** `cache-control` — the pipeline's
  `emptyResponse` merges the route headers over the security defaults — so a
  revalidation cannot silently drop the cache policy.
- No production code, factory, helper or other spec is touched; the pins run on
  the current trunk without modification to the implementation.

## Alternatives

- **Extend `addons-endpoint.test.ts` (I4) with the conditional cases.** Not
  done: the card requires the RED-authored spec to stay as its author left it,
  and the I4 spec's remit is the catalogue body/never-return shape, not cache
  revalidation. A separate file keeps the RED artefact frozen and the new pin
  independently reviewable.
- **Assert the exact tag derivation (e.g. `sha256(JSON.stringify(body))`).** Not
  done: it would over-specify the representation and break a legitimate refactor
  (a digest-length or encoding change) that preserves the observable invariants.
- **Add a unit pin on `addonCatalogueETag` alone.** Not done: the defect class
  being guarded (a route that stops revalidating, a tag that stops tracking the
  served bytes) is at the route boundary, so the pin drives the real handler
  against a real seeded collection rather than a pure function in isolation.
- **Send the conditional GET through the running server (e2e).** Out of scope
  for this pin: the invariant is wire-level and deterministic at the handler,
  and no other lane's e2e is extended. A cross-page e2e would duplicate what the
  route-boundary pin already proves.

## Evidence (this card, branch `OP-102-task-addons-conditional-get`, off `origin/main` `b614bc9`)

- New pin: `npx vitest run --project integration apps/web/src/test/integration/addons-conditional-get.test.ts` → **6 passed (6)**.
- `npx tsc -p apps/web/tsconfig.json --noEmit` → exit `0`.
- `npx eslint apps/web/src/test/integration/addons-conditional-get.test.ts` → exit `0` (no output).
- `npx prettier --check apps/web/src/test/integration/addons-conditional-get.test.ts` → clean.
- `adr-numbering` guard (`--project unit`) → **29 passed (29)**.
- `gitleaks detect --log-opts="origin/main..HEAD"` → no leaks.

No number outside the lane range `0320`–`0339` is touched.
