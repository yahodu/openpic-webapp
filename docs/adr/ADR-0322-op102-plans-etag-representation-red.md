# ADR-0322 — OP-102 follow-up RED: pin that the `GET /plans` `ETag` identifies the served representation

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-102 follow-up TEST (`t_2192509f`) · **Branch:** `OP-102-task-plans-etag-representation` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_1156c7ad`
- **Relates to:** [ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md) (the GREEN whose round-1 review raised the finding), [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the binding RED contract), [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (version-on-change), [ADR-0006](ADR-0006-cursor-pagination-and-etag.md) (ETag plumbing), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.1 (plans), §0.10 (ETags) · **Schema:** §14.1
- **Successor:** the GREEN `t_0ad1baa2` ("derive the `GET /plans` catalogue tag from the served representation")

## Context

The round-1 review of the OP-102 GREEN (`t_1156c7ad`, recorded in
[ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md) → "Round-1 review")
found that `planCatalogueETag` derives the tag from `(key, version)` **only**,
while the body served by `GET /api/v1/plans` varies with two things that tag
ignores:

1. the `currency` / `billingCycle` query, which filters `prices` (pinned by I1
   of `apps/web/src/test/integration/plans-endpoint.test.ts`); and
2. the served copy (`name`, `description`, `marketingFeatures`) and prices,
   which a data edit changes without bumping `version` — `seedPlans` bumps
   `version` only on an entitlement change ([ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) §6).

Two consequences, both user-visible:

- a `?currency=USD` conditional GET can be answered `304` off an `ETag` minted
  for `?currency=INR`, so the client reuses the wrong variant's price set;
- a price/copy edit never invalidates a revalidating client, and because a `304`
  refreshes `max-age`, the staleness is **unbounded** — not the five minutes
  [ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md)'s Consequences
  section claims — which contradicts the card story ("pricing copy changes need
  no deploy").

The finding is a **Medium** correctness bug in caching, not in the wire shape,
so it is corrected by a new TAG derivation and pinned by new tests (this ADR).
The reviewer explicitly routed a TEST pin plus a GREEN, on the grounds that a
tag derived from the versions **and** the served representation satisfies every
existing pin (`plan-etag.test.ts` U2, `plans-endpoint.test.ts` I1, the E1 e2e).

## Decision

### The pin is a new, route-level integration spec

`apps/web/src/test/integration/plans-etag-representation.test.ts` (this card)
pins, at the route boundary and against a real seeded catalogue:

| #   | Test                                                                       | Behaviour pinned                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | mints a different `ETag` for a different `currency`/`billingCycle` variant | variant identity; asserts the two bodies differ first, so the tag assertion is not vacuous                                                                                                                         |
| 2   | does not answer `304` for a variant whose `ETag` differs                   | no cross-variant `304`: replaying the default tag on the USD variant is `200` with the USD body                                                                                                                    |
| 3   | changes the `ETag` when only a plan's copy changes                         | a `name` edit with **no** `version` bump changes the tag and revalidating with the old tag is `200`; the served body really carries the new copy                                                                   |
| 4   | changes the `ETag` when only a plan's price changes                        | an `amountMinor` edit with **no** `version` bump changes the tag and revalidating with the old tag is `200`; asserts the served price and that `version` stayed `1`                                                |
| 5–6 | the existing revalidation invariant still holds                            | an unchanged catalogue still answers `304`, for the default variant and for the USD variant revalidating with its own tag (the invariant the fix must preserve; also covered end-to-end by `e2e/plans.spec.ts` E1) |

Tests 1–4 are RED on the current trunk (assertion-level: identical tag
`"d21b17…"` on both variants; `304` where `200` is required). Tests 5–6 are
intentionally green — they are the regression anchor that stops the fix from
over-invalidating (a tag that changed on every request) and are the counterpart
of the E1 e2e. The ADR-0321 finding is the reason the whole spec exists; its
RED state is what the GREEN `t_0ad1baa2` turns green.

### The tag must become a function of the served representation

The card fixes the four observable invariants above and deliberately leaves the
tag's **shape** unpinned (hash vs join, strong vs weak), exactly as
[ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) and the U2 unit spec do.
The GREEN is free to compute the tag from the projected body, or from a
fingerprint of the served plans (versions **plus** copy/prices), as long as
tests 1–6 hold and the existing U2 pins (`planCatalogueETag` stable for the same
versions, different on a version bump / add / remove) stay green.

### ADR-0320 §2's "copy-only edits leave the tag unchanged" is superseded

[ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) §2 pinned that a
copy-only edit must **not** invalidate a cached `/plans` response, and
[ADR-0321](ADR-0321-op102-public-plans-endpoint-green.md)'s Alternatives
rejected a content hash for `/plans` on that basis. The round-1 review
established that this choice is the bug (a `304` refreshes `max-age`, so
staleness is unbounded). This ADR records the reversal: **a copy or price edit
must invalidate the tag.** ADR-0320/ADR-0321 are not edited (they are accepted
history); the GREEN `t_0ad1baa2` carries the contract change and may supersede
ADR-0320 §2 explicitly.

## Consequences

- After the GREEN, a `304` on `GET /plans` means "the bytes you hold are the
  bytes this request would serve", for every query variant and every plan edit —
  the cache is correct by construction rather than bounded by `max-age`.
- The tag now changes on any served-`prices`/copy change, so a copy edit is
  cheaper to _correct_ but slightly more expensive to _cache_ (a revalidating
  client re-downloads after a copy edit). That is the intended trade: the card
  story is "pricing copy changes need no deploy", which requires the edit to
  reach clients.
- An unchanged catalogue is unaffected: tests 5–6 and the E1 e2e pin that a
  revalidation of an unchanged representation still answers `304`.
- **Open / unpinned:** the tag's token format; whether the digest includes the
  full body or a canonical fingerprint of the served fields (both satisfy the
  pins). Both are implementation details the GREEN owns.

## Alternatives

- **Pin the tag's exact derivation (e.g. `sha256(JSON.stringify(served))`).**
  Rejected: it would over-specify the representation and break on any legitimate
  refactor (field order, projection change) that preserves the observable
  invariants — exactly what the testing standard forbids.
- **Do nothing / rely on `max-age=300`.** Rejected by the review: a `304`
  refreshes `max-age`, so the staleness is unbounded, and the cross-variant case
  serves the wrong currency's prices outright.
- **Hash the served body unconditionally, dropping `version` from the tag.**
  Considered and left to the GREEN: the U2 unit spec keys on versions, so the
  GREEN must keep the version-derived behaviour stable. Deriving from the served
  representation (which includes `version`) satisfies both.

## RED evidence (this card, trunk `480b5b8`)

`TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration
apps/web/src/test/integration/plans-etag-representation.test.ts` →
**4 failed | 2 passed (6)**, assertion-level:
`expected '"d21b176931999cf17e6ba7d266e67be0"' not to be
'"d21b176931999cf17e6ba7d266e67be0"'` (tests 1, 3, 4) and
`expected 304 to be 200` (test 2). `tsc -p apps/web/tsconfig.json --noEmit`
exit `0`; `prettier --check` clean. No production file is touched by this card.
