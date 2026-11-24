# ADR-0324 — OP-102 follow-up TEST: pin the conditional `GET /addons` (`If-None-Match` → `304`)

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-102 follow-up TEST (`t_e3951910`) · **Branch:** `OP-102-task-addons-conditional-get-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_e3951910`
- **Relates to:** [ADR-0320](ADR-0320-op102-public-plans-endpoint-red.md) (the add-on catalogue contract; the route's `304` comes from its §3.6 cache/ETag rule), [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) (the same pin for `/plans`), [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) (§Consequences: an absent assertion gets a fresh pin, never a resurrected PR), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's ledger row), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.6 (add-ons), §0.10 (ETags / conditional requests) · **Schema:** ADR-0320 (no §14.x row exists for `addons`)
- **Supersedes:** nothing · **Superseded by:** nothing

## Context

`GET /api/v1/addons` has answered a conditional request since the OP-102 GREEN:
`route.ts` builds `addonCatalogueETag(data)` and short-circuits
`ifNoneMatchSatisfied(ctx.request, etag)` to `{ status: 304, body: { data: [] } }`
with the same `cache-control: public, max-age=300` and `etag` headers. The
pipeline strips the body of a no-content status, so a matching revalidation is
bodyless on the wire.

No shipped spec observed that arm:

| Surface                                 | What it pins                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `addons-endpoint.test.ts` (I4, 4 cases) | the `200` body/headers and the retired-add-on exclusion — **0** occurrences of `304` or `if-none-match` |
| `conditional-etag.test.ts` (I2)         | `304` for `GET /plans`, not `/addons`                                                                   |
| `etag.test.ts` (unit)                   | the `ifNoneMatchSatisfied` helper in isolation                                                          |

So the route's cache policy, its ETag echo and its bodyless reply could regress
silently — the endpoint would keep serving `200`, and every consumer cache
would stop revalidating, with no failing test.

The pins for exactly this behaviour were written once and never landed: PR
[#278](https://github.com/yahodu/openpic-webapp/pull/278)
(`OP-102-task-addons-conditional-get`, tip `f3769b76` = `refs/pull/278/head`)
was closed on 2026-11-17 as **superseded after the behaviour test, not the
file test** — the behaviour is on `main`, its two artifacts
(`apps/web/src/test/integration/addons-conditional-get.test.ts` and
`docs/adr/ADR-0324-op102-addons-conditional-get-pin.md`) are not, and its
branch was deleted on 2026-11-24. [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md)
§Consequences forbids resurrecting the PR, its branch or its ADR: a genuinely
absent assertion gets a **fresh pin**. This is that pin.

## Decision

### The pin is appended to the harness that owns §3.6

The cases live in `apps/web/src/test/integration/addons-endpoint.test.ts`, in
two new `describe` blocks appended after the shipped ones. **No shipped case,
helper or fixture is edited** — the diff is a pure append (and one `import type`
line for `PlanPrice`) plus this ADR and its ledger row.

Both homes were measured before choosing:

| Home                                                    | Size                                                                                                                                   | Test run                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| new file (PR #278's spec, verbatim)                     | 145 lines; re-declares `app`, `seedAddons`, `addonsRequest`, `usdPrice`; boots a **second** `startTestApp` (`op102-addons-revalidate`) | `6 passed (6)`, **5.20 s**                                  |
| append to `addons-endpoint.test.ts` (chosen)            | +131 lines; reuses the existing `app`, `seedAddons`, `addonsRequest`, `APP_ORIGIN`                                                     | `10 passed (10)`, **4.32 s** (the 4 shipped cases included) |
| both files in one run (rejected layout, for comparison) | —                                                                                                                                      | `16 passed (16)`, 4.14 s (two Mongo boots, files parallel)  |

The append wins on consistency, not wall clock: §3.6 already has an owner, the
seeding and request helpers exist and are the ones the shipped cases use, and a
second file would duplicate four helpers and a Mongo application boot to pin
the same route. PR #278's own `describe` titles are reused verbatim (they are
the lane's naming), but its file layout and its weaker `not.toBeNull()` /
`tag.length > 0` assertions are not.

### The six pinned behaviours

| #   | Case                                                                                          | Behaviour pinned                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `an unconditional GET returns 200 with the public cache policy, an ETag and the catalogue`    | `200`; `cache-control: public, max-age=300`; a **strong** tag in RFC 7232 quoted form (`/^"[^"]+"$/`); the served `addonKey` list                                                                                                                                                                           |
| 2   | `replaying the ETag as If-None-Match returns 304 with the same ETag and no body`              | `304`; `etag` echoed byte-for-byte; `cache-control` unchanged; the body is **0 bytes** (asserted as `arrayBuffer().byteLength`, which is what "bodyless" means — `text() === ""` also passes on a stripped body)                                                                                            |
| 3   | `a non-matching If-None-Match returns the full 200 catalogue`                                 | the negative arm: a stale tag yields the full `200` catalogue and the cache policy again — without it, a route that always answered `304` would satisfy cases 1–2                                                                                                                                           |
| 4   | `serves the same ETag for an unchanged catalogue`                                             | tag stability across two reads of the same seeded catalogue                                                                                                                                                                                                                                                 |
| 5   | `changes the ETag when a served add-on changes, and no longer revalidates the old tag to 304` | a `name` edit changes the tag (the served body is asserted to have really changed first, so the assertion is not vacuous) and replaying the **old** tag is `200`, not `304`                                                                                                                                 |
| 6   | `mints a distinct ETag per currency variant of the same catalogue`                            | with an INR and a USD price on one add-on: the three bodies/tags (unfiltered, `?currency=INR`, `?currency=USD`) are all distinct, and an INR tag replayed on the USD variant is `200` — the [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) cross-variant defect, pinned for this catalogue too |

Case 6 first asserts that the INR and USD bodies differ, so "three distinct
tags" cannot be satisfied by a route that ignores `?currency`.

### What stays unpinned (deliberately)

The tag's **shape** is not asserted beyond "strong, quoted, non-empty": the
digest algorithm, its length, whether it hashes the served body or a canonical
fingerprint, and the exact `304` header set beyond `etag`/`cache-control`. All
of these satisfy §0.10 and none is user-observable. `If-None-Match: *`, the
weak-tag wire form, `HEAD`, and the rate-limit interaction are also out of
scope — the helper's own unit spec (`etag.test.ts`) already pins the RFC 7232
comparison rules, and §0.11 rate limiting is pinned elsewhere.

## Evidence

### This is a characterisation pin: it is green by design, and that is proved

The behaviour is already on `main` (branch base `origin/main` `8ada9d7d`;
re-verified at `5be02588` by the card that routed this gap). All six cases were
run **before** the append (as PR #278's standalone file) and **after** (in the
shipped harness): `6 passed (6)` and `10 passed (10)` respectively. **No case
came out RED.** Per the card, a RED would have been a production bug to report
rather than a pin to land; there was none.

A green characterisation pin is only worth its runtime if it fails when the
behaviour regresses, so each arm was proved load-bearing by mutating production
code in the worktree, running the appended file, and restoring the tree
(`git status --short` afterwards shows only the test file; the production tree
is identical to `origin/main`):

| Probe | Mutation                                                                                                                                       | Result                                                                                                                                                        | Reading                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A     | drop the `ifNoneMatchSatisfied` short-circuit from `route.ts` (always `200`)                                                                   | `1 failed \| 9 passed` — case 2: `expected 200 to be 304`                                                                                                     | the `304` arm is what case 2 pins                               |
| B     | `addonCatalogueETag` hashes `addon.addonKey` only (the [ADR-0322](ADR-0322-op102-plans-etag-representation-red.md) `/plans` bug, transplanted) | `2 failed \| 8 passed` — case 5: `expected '"d8d3289225bd1f15709076b7ba7bdb1e"' not to be '"d8d3289225bd1f15709076b7ba7bdb1e"'`; case 6: `expected 1 to be 3` | cases 5–6 pin tag identity against the served representation    |
| C     | append a random salt to the hashed fingerprint (an unstable tag)                                                                               | `2 failed \| 8 passed` — case 2: `expected 200 to be 304`; case 4: `expected '"a75ef028…"' to be '"984f3577…"'`                                               | case 4 pins stability; an unstable tag also breaks revalidation |

Every case has at least one mutation that reddens it; no mutation reddened a
shipped case.

### Suite state at the branch head

`npx vitest run --project integration apps/web/src/test/integration/addons-endpoint.test.ts`
→ **10 passed (10)** (4 shipped + 6 new). `tsc -p apps/web/tsconfig.json --noEmit`
exit `0`; `eslint` 0 errors and no new warnings; `prettier --check` clean; the
`docs/adr/` guards (`adr-numbering`, `adr-lane-ranges`, `adr-ledger-shape`,
`adr-ledger-links`, `adr-record-links`, `adr-source-references`) green with this
record and its ledger row.

## Consequences

- The `/addons` conditional GET is now pinned at the route boundary for the
  same invariants `/plans` already had (cases 1–4) plus the cross-variant
  revalidation rule (case 6), so a future refactor of the projection, the tag
  derivation or the `304` arm breaks a test with a self-explaining message
  (`expected 200 to be 304`, `expected 1 to be 3`) instead of silently
  disabling client revalidation.
- A legitimate tag-shape change (different digest, different length) stays
  green — the pin is behavioural, not structural.
- The appended block adds no new database boot and no new fixture, so the
  §3.6 suite's runtime is unchanged (4.32 s, the shipped cases included).
- The unlanded PR #278 stays closed; nothing of it was copied, rebased or
  reopened, and its branch remains deleted.

## Alternatives

- **Land PR #278 as written (reopen / rebase / cherry-pick its ADR).** Rejected
  by [ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md) §Consequences: the
  PR is stale, its base is 100+ commits behind, and resurrecting it would
  re-introduce a second spec file owning §3.6. Its titles and expectations were
  reused; its files were not.
- **Keep the pin in a standalone `addons-conditional-get.test.ts`.** Measured
  and rejected above: four duplicated helpers and a second Mongo boot for the
  same route, and a second place to update when the §3.6 seed changes.
- **Assert the exact tag value (`sha256` of the served JSON).** Rejected: it
  over-specifies an implementation detail and would break on any legitimate
  tag change (a different digest, a versioned prefix) that preserves every
  observable invariant — precisely what the testing standard forbids.
- **Trust `max-age=300` and pin nothing.** Rejected: a `304` refreshes
  `max-age`, so an unpinned `304` arm is unbounded staleness, and the arm is
  the only thing standing between a cache and a full body on every revalidation.

## Number allocation

The **OP-102** lane `Next free` cell read `0324` at the branch head
(`origin/main` `8ada9d7d`); this record takes `0324` and advances the cell to
`0325`. No number outside the lane range `0320`–`0339` is touched.
