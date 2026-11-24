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

## Reviewer sign-off — round 1 (artifact lens)

Approved by `openpic-webapp-reviewer` (round 1, artifact lens) with two Low findings, both additive and both since closed. No Critical, High or Medium issue was found, no production file is in this delivery's diff, and nothing in the sections above is retracted.

- **Where the delivery landed.** PR #868 squash `e6e48fba` (head `e6e2b482`), 15 of 15 check runs `pass` on that head; `e6e48fba^{tree}` reads `6a703af1…` and is what `origin/main` carried at the merge, while the reviewed head's own tree is `0a83413a…` because the trunk's #867 (`eea4f14a`) is not on it. `git diff --name-only e6e2b482 e6e48fba` lists only that landing's two docs paths (`ADR-0306`, `README.md`), and `git rev-parse e6e2b482:<spec> e6e48fba:<spec>` prints one blob OID (`6cc00a12…`), so every path this delivery owns is byte-identical to what shipped. PR #278 stays `CLOSED`/draft and neither OP-102 test branch has a ref left on the remote.
- **Criteria → evidence**, measured at `e6e48fba`: case 1 (`:266`) `200` + `public, max-age=300` + a strong quoted tag + the catalogue; case 2 (`:279`) `304` + the echoed tag + `arrayBuffer().byteLength === 0`; case 3 (`:294`) a stale tag → full `200`; cases 4–6 (`:307`, `:316`, `:332`) a stable tag / a served change moves the tag and the old tag no longer revalidates / three distinct tags across unfiltered–`INR`–`USD` with no cross-variant `304`. The append is `+131/−0` on the one spec file.
- **Suites the reviewer ran**, in a throwaway worktree at `e6e48fba`: focused spec **10 passed (10)**, the eight `docs/adr/` guards **280 passed (280)**, `prettier --check` clean on the spec, this record and the ledger, and the ADR sweep **466** records with **0** duplicate numbers. At the trunk this section lands on (`ed625e6d`) the spec reads **12 passed (12)** — the follow-up appended two cases — and the same eight guards read **280 passed (280)**; the OP-132 trunk `3a9231bd` carries the same spec blob, so its 10-passed reading still applies.
- **Independent load-bearing probes**, re-measured at `8893777d` against `addons/route.ts` (production sha256 `47285744…`, restored after each run, `git status --short` clean): **A**, the arm removed (`if (false && ifNoneMatchSatisfied(…))`, always `200`) → `2 failed | 10 passed (12)` with `expected 200 to be 304` in case 2 and in the list-form case (`1 failed | 9 passed` at the reviewed head); **D**, the arm forced (`if (true || …)`, always `304`) → `10 failed | 2 passed (12)` (`8 failed | 2 passed` at the reviewed head), so cases 1/3/5/6 and both list-form arms discriminate and an always-`304` route cannot satisfy the suite.
- **F1 (Low, additive, closed).** The route-level `If-None-Match` was pinned for a single exact tag only: replacing `addons/route.ts:62` with `ctx.request.headers.get("if-none-match") === etag` left the spec at `10 passed (10)`, although the RFC 7232 list form answered `304`; the same class sat at `plans/route.ts:68` and `me/notifications/unread-count/route.ts:71`, and §What stays unpinned named `*`, the weak form, `HEAD` and the rate-limit interaction but not the list form. Card `t_f9d8f6a9` closed it in PR #872 (squash `8893777d`), whose own record is ADR-0325; at `8893777d` the same literal compare reddens exactly its case (`1 failed | 11 passed (12)`, `expected 200 to be 304`), measured.
- **F2 (Low, additive, closed).** "Identifies the served representation" was pinned in one direction only: a stored but unserved edit (`grantDelta: 100 → 200`) kept the served body byte-identical and the tag unchanged, so an over-invalidating tag would have forced refetches of unchanged bodies unnoticed. PR #872 pinned the other direction; at `8893777d` hashing the raw stored documents reddens the unserved-edit case (`expected '"a214f55c…"' to be '"5e7fbb95…"'`) and the cross-variant case (`expected 1 to be 3`) — `2 failed | 10 passed (12)`, measured.
